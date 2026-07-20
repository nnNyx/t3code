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

// Opening a thread replays the tail of events missed while disconnected. The
// server streams them one-by-one and each publish rebuilds the whole thread
// feed downstream (mobile LegendList reconcile, web timeline), so a long tail
// used to trigger dozens/hundreds of rebuilds before the UI settled. While
// catching up we instead reduce events into a working copy and publish at most
// once per CATCHUP_BATCH_MAX_EVENTS or per CATCHUP_BATCH_INTERVAL, then publish
// once more when the server's `caught-up` sentinel arrives and switch to
// per-event live publishing.
const CATCHUP_BATCH_MAX_EVENTS = 25;
const CATCHUP_BATCH_INTERVAL = "100 millis";
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

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
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
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: "live",
      error: Option.none(),
    });
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, { snapshotSequence, thread });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
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
  // Serializes the reduce path against the batch-interval maintenance fiber so
  // they never race on `working`/`state`.
  const drainLock = yield* Semaphore.make(1);

  // Publish the working copy as the live state. Callers must hold `drainLock`.
  const publishWorking = Effect.fn("EnvironmentThreadState.publishWorking")(function* () {
    yield* Ref.set(pendingEvents, 0);
    const data = yield* Ref.get(working);
    if (Option.isSome(data)) {
      yield* setThread(data.value);
    }
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
          // End of the replay window: flush the batch and switch to live.
          yield* publishWorking();
          yield* Ref.set(catchingUp, false);
          return;
        }

        if (item.kind === "snapshot") {
          // A snapshot is the initial full state (or a resubscribe reset);
          // publish immediately so first paint is not delayed by batching.
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
          yield* publishWorking();
          return;
        }
        const count = yield* Ref.updateAndGet(pendingEvents, (value) => value + 1);
        if (count >= CATCHUP_BATCH_MAX_EVENTS) {
          yield* publishWorking();
        }
      }),
    );
  });

  // While catching up, flush the batch on the interval and detect an idle tail
  // as a fallback for servers that never send the sentinel. Stops once live.
  const catchUpMaintenance: Effect.Effect<void> = Effect.suspend(() =>
    Effect.gen(function* () {
      yield* Effect.sleep(CATCHUP_BATCH_INTERVAL);
      const done = yield* drainLock.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* Ref.get(catchingUp))) {
            return true;
          }
          if ((yield* Ref.get(pendingEvents)) > 0) {
            yield* publishWorking();
          }
          const now = yield* Clock.currentTimeMillis;
          const reference = Option.getOrElse(yield* Ref.get(lastItemAt), () => now);
          if (now - reference >= CATCHUP_IDLE_FALLBACK_MS) {
            yield* Ref.set(catchingUp, false);
            return true;
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

      // Seed the idle clock from drain start so the fallback can fire even if no
      // item ever arrives (old server, empty replay), then run the batch flusher
      // alongside the subscription.
      yield* Ref.set(lastItemAt, Option.some(yield* Clock.currentTimeMillis));
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
          onSome: (thread) =>
            shouldPersistThread(thread) ? persist({ snapshotSequence, thread }) : Effect.void,
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
