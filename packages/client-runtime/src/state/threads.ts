import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe } from "../rpc/client.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

// Opening a thread after an absence replays the tail of events missed while
// disconnected. The server streams them one-by-one and each publish rebuilds the
// whole thread feed downstream (mobile LegendList reconcile, web timeline). Even
// a handful of intermediate publishes visually REPLAYS finished turns as if live
// on web — assistant text grows chunk-by-chunk, work-log rows trickle in, the
// "working" indicator flaps — for content that settled days ago. So during
// catch-up we fold every replayed event into a working copy and DO NOT paint the
// intermediate turn states at all: the only publishes are the initial snapshot
// (first paint) and a single settled publish when the server's `caught-up`
// sentinel arrives (or the idle fallback fires), after which we switch to
// per-event live publishing. The published state carries `hydrating: true` for
// the whole window so the UI can additionally gate any live-only affordance that
// a stale base snapshot would otherwise animate. A coarse keep-alive bound still
// publishes an intermediate copy if a sentinel-less server streams a genuinely
// long replay without pausing, so the view is never frozen on a very old copy.
const CATCHUP_BATCH_INTERVAL = "100 millis";
// Sentinel-less marathon catch-up: publish at most one keep-alive copy per this
// interval so a continuously-streaming old server still makes progress. Set well
// above the common catch-up (which ends via sentinel/idle in well under a
// second) so ordinary reconnects never paint an intermediate state.
const CATCHUP_KEEPALIVE_INTERVAL_MS = 3_000;
// Fallback when the sentinel never arrives (an older server that does not
// understand `signalCaughtUp`): once the replay has been idle this long we
// assume catch-up is done, flush, and switch to per-event live publishing so we
// never wedge in batching mode. Measured from the last received item, or from
// subscription start when nothing has arrived yet.
const CATCHUP_IDLE_FALLBACK_MS = 250;

// Above this many combined messages+activities, persisting the full snapshot is
// expensive enough (hundreds of ms to Schema-encode + stringify) that we space
// out writes during live streaming. Chosen well above ordinary threads so only
// pathological histories back off. See `persist` below.
const LARGE_THREAD_PERSIST_ENTRY_THRESHOLD = 4_000;
const LARGE_THREAD_PERSIST_COOLDOWN = "3 seconds";

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    // Begin gated: we start every subscription in the catch-up window and clear
    // this once the replay tail settles (`caught-up` sentinel or idle fallback).
    hydrating: true,
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
    // Persisting encodes + JSON-stringifies the entire snapshot. On a huge
    // history (the Vale thread: ~18k activities, ~14MB) that Schema encode runs
    // into the hundreds of ms on the JS thread, and a live turn publishes many
    // times per second. The sliding(1) queue already coalesces to the newest
    // snapshot; a post-persist cooldown proportional to snapshot size bounds how
    // often such a thread re-serializes its whole body (so streaming stays
    // smooth) while small threads keep persisting promptly. The resume cursor is
    // stored with the snapshot, so a slightly older cache just replays the gap
    // as live events on the next open — no data loss.
    const size = snapshot.thread.activities.length + snapshot.thread.messages.length;
    if (size > LARGE_THREAD_PERSIST_ENTRY_THRESHOLD) {
      yield* Effect.sleep(LARGE_THREAD_PERSIST_COOLDOWN);
    }
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          // A connected environment that already holds a full snapshot is
          // current: the resume cursor guarantees any events missed while
          // disconnected replay as live updates. Present that as "live" so the
          // sync indicator clears instead of sticking on "synchronizing" when
          // the server has nothing new to send after the cursor (the common
          // case for a warm reconnect). Without data we are still doing the
          // first fetch, so stay "synchronizing".
          status: Option.isSome(current.data) ? ("live" as const) : ("synchronizing" as const),
          error: Option.none(),
        },
  );
  const setDisconnected = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
  }));
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
      error: Option.some(formatThreadError(cause)),
    }));

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
  ) {
    // Publishes made while the replay tail is still folding stay flagged as
    // hydrating (base snapshot, keep-alive); once catch-up ends we publish live.
    const stillHydrating = yield* Ref.get(catchingUp);
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: "live",
      error: Option.none(),
      hydrating: stillHydrating,
    });
    // Persist the thread together with the sequence it reflects so the next warm
    // cache can resume from exactly here.
    const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
    yield* Queue.offer(persistence, { snapshotSequence, thread });
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      hydrating: false,
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  // Working (unpublished) copy of the thread, reduced during catch-up. Mirrors
  // `state.data` but lets us fold many replayed events before a single publish.
  const working = yield* Ref.make<Option.Option<OrchestrationThread>>(cachedThread);
  // true while replaying the catch-up tail; false once the `caught-up` sentinel
  // arrives (or the idle fallback fires) and we publish per live event.
  const catchingUp = yield* Ref.make(true);
  // Events reduced into `working` but not yet published.
  const pendingEvents = yield* Ref.make(0);
  // Timestamp (ms) of the most recent received item (or drain start); drives the
  // idle fallback that ends catch-up when no sentinel ever arrives.
  const lastItemAt = yield* Ref.make<Option.Option<number>>(Option.none());
  // Timestamp (ms) of the most recent publish; bounds how long a sentinel-less
  // marathon catch-up can go without any paint (the keep-alive).
  const lastPublishAt = yield* Ref.make<Option.Option<number>>(Option.none());
  // Serializes the reduce path against the batch-interval maintenance fiber so
  // they never race on `working`/`state`.
  const drainLock = yield* Semaphore.make(1);

  // Publish the working copy as the live state. Callers must hold `drainLock`.
  const publishWorking = Effect.fn("EnvironmentThreadState.publishWorking")(function* () {
    yield* Ref.set(pendingEvents, 0);
    yield* Ref.set(lastPublishAt, Option.some(yield* Clock.currentTimeMillis));
    const data = yield* Ref.get(working);
    if (Option.isSome(data)) {
      yield* setThread(data.value);
    }
  });

  // End the catch-up window: publish the fully-folded working copy once as the
  // settled live state and clear the hydration gate. Callers must hold
  // `drainLock`. Idempotent — a later live event just publishes per-event.
  const finishCatchUp = Effect.fn("EnvironmentThreadState.finishCatchUp")(function* () {
    yield* Ref.set(catchingUp, false);
    yield* publishWorking();
    // publishWorking is a no-op without data (empty thread); clear the gate
    // regardless so consumers are never stuck waiting on a thread with no body.
    yield* SubscriptionRef.update(state, (current) =>
      current.hydrating ? { ...current, hydrating: false } : current,
    );
  });

  // Reduce one stream item into `working`/`lastSequence` without publishing.
  // Returns whether the reduction produced a publishable change; deletion is
  // terminal. Dedupes replayed events by sequence, exactly as before.
  const reduceItem = Effect.fn("EnvironmentThreadState.reduceItem")(function* (
    item: Exclude<OrchestrationThreadStreamItem, { readonly kind: "caught-up" }>,
  ) {
    if (item.kind === "snapshot") {
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* Ref.set(working, Option.some(item.snapshot.thread));
      return "updated" as const;
    }
    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return "none" as const;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);
    const data = yield* Ref.get(working);
    if (Option.isNone(data)) {
      return item.event.type === "thread.deleted" ? ("deleted" as const) : ("none" as const);
    }
    const result = applyThreadDetailEvent(data.value, item.event);
    if (result.kind === "updated") {
      yield* Ref.set(working, Option.some(result.thread));
      return "updated" as const;
    }
    if (result.kind === "deleted") {
      yield* Ref.set(working, Option.none());
      return "deleted" as const;
    }
    return "none" as const;
  });

  // Consume one stream item: batch during catch-up, publish per event once live.
  // Serialized via `drainLock`.
  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    yield* drainLock.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.set(lastItemAt, Option.some(yield* Clock.currentTimeMillis));

        if (item.kind === "caught-up") {
          // End of the replay window: publish the settled copy once and go live.
          yield* finishCatchUp();
          return;
        }

        if (item.kind === "snapshot") {
          // A snapshot is the initial full state (or a resubscribe reset);
          // publish immediately so first paint is not delayed. This is the only
          // paint during catch-up until the settled publish, so the base/cached
          // state shows instantly while the replay tail folds silently on top.
          yield* reduceItem(item);
          yield* publishWorking();
          return;
        }

        const outcome = yield* reduceItem(item);
        if (outcome === "deleted") {
          yield* setDeleted();
          yield* Ref.set(catchingUp, false);
          return;
        }
        if (outcome === "none") {
          return;
        }
        if (!(yield* Ref.get(catchingUp))) {
          // Live: paint per event so genuine streaming animates as designed.
          yield* publishWorking();
          return;
        }
        // Catching up: fold silently. Do NOT paint intermediate turn states —
        // they would replay finished turns as if live. The count only feeds the
        // keep-alive bound for a sentinel-less marathon replay.
        yield* Ref.update(pendingEvents, (value) => value + 1);
      }),
    );
  });

  // While catching up, detect an idle tail as a fallback for servers that never
  // send the sentinel, and keep-alive-publish only if a sentinel-less replay
  // streams for a very long time without pausing. Stops once live.
  const catchUpMaintenance: Effect.Effect<void> = Effect.suspend(() =>
    Effect.gen(function* () {
      yield* Effect.sleep(CATCHUP_BATCH_INTERVAL);
      const done = yield* drainLock.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* Ref.get(catchingUp))) {
            return true;
          }
          const now = yield* Clock.currentTimeMillis;
          const reference = Option.getOrElse(yield* Ref.get(lastItemAt), () => now);
          if (now - reference >= CATCHUP_IDLE_FALLBACK_MS) {
            // Replay tail went quiet: settle and switch to live.
            yield* finishCatchUp();
            return true;
          }
          // Still actively replaying (sentinel-less server): bound staleness with
          // an occasional keep-alive paint, but stay in the hydration window so
          // the coalesced turns still land as one settled publish at the end.
          if ((yield* Ref.get(pendingEvents)) > 0) {
            const lastPublish = Option.getOrElse(yield* Ref.get(lastPublishAt), () => 0);
            if (now - lastPublish >= CATCHUP_KEEPALIVE_INTERVAL_MS) {
              yield* publishWorking();
            }
          }
          return false;
        }),
      );
      if (!done) {
        yield* catchUpMaintenance;
      }
    }),
  );

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      // Establish the base snapshot to resume from, minimizing bytes over the
      // wire:
      // - Warm cache: reuse the cached snapshot (zero network) and resume via
      //   `afterSequence` so we only receive events since the cached sequence.
      // - Cold cache: load the full snapshot over HTTP (gzip-compressible, and
      //   off the socket), then resume via `afterSequence`.
      // If no base can be established we fall back to the socket-embedded
      // snapshot so the thread still synchronizes. Overlapping/replayed events
      // are deduped by sequence in applyItem.
      const base = Option.isSome(cached)
        ? cached
        : yield* Effect.gen(function* () {
            // Cold cache only: wait for a prepared connection so we can
            // authenticate the HTTP request; this mirrors the socket path, which
            // likewise waits for a live session.
            const prepared = yield* SubscriptionRef.changes(supervisor.prepared).pipe(
              Stream.filter(Option.isSome),
              Stream.map((current) => current.value),
              Stream.runHead,
            );
            return Option.isSome(prepared)
              ? yield* snapshotLoader.load(prepared.value, threadId)
              : Option.none<OrchestrationThreadDetailSnapshot>();
          });

      if (Option.isSome(base)) {
        yield* applyItem({ kind: "snapshot", snapshot: base.value });
      }

      // Opt into the `caught-up` sentinel so the server tells us when the replay
      // tail ends; older servers ignore the flag and we fall back to the idle
      // heuristic in `catchUpMaintenance`.
      const subscribeInput = Option.match(base, {
        onNone: () => ({ threadId, signalCaughtUp: true }),
        onSome: (snapshot) => ({
          threadId,
          afterSequence: snapshot.snapshotSequence,
          signalCaughtUp: true,
        }),
      });

      // Seed the idle + keep-alive clocks from drain start so the fallback can
      // fire even if no item ever arrives (old server, empty replay), then run
      // the maintenance flusher alongside the subscription.
      const drainStart = yield* Clock.currentTimeMillis;
      yield* Ref.set(lastItemAt, Option.some(drainStart));
      yield* Ref.set(lastPublishAt, Option.some(drainStart));
      yield* Effect.forkScoped(catchUpMaintenance);

      yield* subscribe(ORCHESTRATION_WS_METHODS.subscribeThread, subscribeInput, {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
      }).pipe(Stream.runForEach(applyItem));
    }),
  );

  // Persist from `working`, not the published `state`: during catch-up we
  // advance `lastSequence` as events are reduced but only publish `state` on a
  // batch boundary, so `working` (plus `lastSequence`) is the consistent latest.
  // Reading `state` here could pair a stale thread with a newer sequence and
  // make the next warm resume skip the batched-but-unpublished events.
  yield* Effect.addFinalizer(() =>
    Effect.all([Ref.get(working), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([data, snapshotSequence]) =>
        Option.match(data, {
          onNone: () => Effect.void,
          onSome: (thread) => persist({ snapshotSequence, thread }),
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
