import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type ServerConfig,
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
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe } from "../rpc/client.ts";
import { ShellSnapshotLoader } from "./shellSnapshotHttp.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationShellSnapshot>;
  readonly status: EnvironmentShellStatus;
  readonly error: Option.Option<string>;
}

const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
};

function shellStatusForSnapshot(
  snapshot: Option.Option<OrchestrationShellSnapshot>,
): EnvironmentShellStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

// Reconnecting after an absence replays every shell event missed while
// disconnected (each thread's metadata/turn/session churn). The shell drives the
// sidebar thread list AND the active thread's session/latestTurn, so publishing
// each replayed event paints the sidebar rows trickling in and the working/turn
// state flapping as if it were all happening live. The shell stream has no
// `caught-up` sentinel (unlike threads), so we fold the replay tail into a
// working snapshot and settle on an idle gap: publish the base snapshot once
// (first paint), fold silently, then publish once when the replay goes quiet,
// after which live events paint per event. A coarse keep-alive bounds staleness
// if a sentinel-less server streams a long replay without pausing.
const SHELL_CATCHUP_MAINTENANCE_INTERVAL = "100 millis";
const SHELL_CATCHUP_IDLE_SETTLE_MS = 250;
const SHELL_CATCHUP_KEEPALIVE_INTERVAL_MS = 3_000;

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ShellSnapshotLoader;
  const environmentId = supervisor.target.environmentId;
  const cachedSnapshot = yield* cache.loadShell(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.").pipe(
        Effect.annotateLogs({
          environmentId,
          ...safeErrorLogAttributes(error),
        }),
        Effect.as(Option.none<OrchestrationShellSnapshot>()),
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
    error: Option.none(),
  });
  const persistence = yield* Queue.sliding<OrchestrationShellSnapshot>(1);

  const persist = Effect.fn("EnvironmentShellState.persist")(function* (
    snapshot: OrchestrationShellSnapshot,
  ) {
    yield* cache.saveShell(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist environment shell cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setDisconnected = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: shellStatusForSnapshot(current.snapshot),
  }));
  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setStreamError = (error: unknown) =>
    Effect.logWarning("Could not synchronize the environment shell.").pipe(
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  // Working (unpublished) copy of the shell snapshot, folded during catch-up.
  const working = yield* Ref.make<Option.Option<OrchestrationShellSnapshot>>(cachedSnapshot);
  // true while replaying the catch-up tail; false once the replay goes idle (or
  // the keep-alive path publishes and we later settle) and we publish per event.
  const catchingUp = yield* Ref.make(true);
  // Events folded into `working` but not yet published.
  const pendingEvents = yield* Ref.make(0);
  const lastItemAt = yield* Ref.make<Option.Option<number>>(Option.none());
  const lastPublishAt = yield* Ref.make<Option.Option<number>>(Option.none());
  // Serializes the fold path against the maintenance fiber.
  const drainLock = yield* Semaphore.make(1);

  // Publish the working snapshot as the live shell state. Holds no lock itself.
  const publishWorking = Effect.fn("EnvironmentShellState.publishWorking")(function* () {
    yield* Ref.set(pendingEvents, 0);
    yield* Ref.set(lastPublishAt, Option.some(yield* Clock.currentTimeMillis));
    const snapshot = yield* Ref.get(working);
    if (Option.isNone(snapshot)) {
      return;
    }
    yield* SubscriptionRef.set(state, {
      snapshot: Option.some(snapshot.value),
      status: "live",
      error: Option.none(),
    });
    yield* Queue.offer(persistence, snapshot.value);
  });

  const finishCatchUp = Effect.fn("EnvironmentShellState.finishCatchUp")(function* () {
    yield* Ref.set(catchingUp, false);
    yield* publishWorking();
  });

  // Fold one stream item into `working`. Returns whether it produced a change.
  const reduceItem = Effect.fn("EnvironmentShellState.reduceItem")(function* (
    item: OrchestrationShellStreamItem,
  ) {
    if (item.kind === "snapshot") {
      yield* Ref.set(working, Option.some(item.snapshot));
      return true;
    }
    const current = yield* Ref.get(working);
    if (Option.isNone(current)) {
      return false;
    }
    if (item.sequence <= current.value.snapshotSequence) {
      return false;
    }
    yield* Ref.set(working, Option.some(applyShellStreamEvent(current.value, item)));
    return true;
  });

  const applyItem = Effect.fn("EnvironmentShellState.applyItem")(function* (
    item: OrchestrationShellStreamItem,
  ) {
    yield* drainLock.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.set(lastItemAt, Option.some(yield* Clock.currentTimeMillis));
        const changed = yield* reduceItem(item);
        if (!changed) {
          return;
        }
        // The base snapshot is the first paint; live events paint per event. The
        // catch-up replay tail folds silently and lands as one settled publish.
        if (item.kind === "snapshot" || !(yield* Ref.get(catchingUp))) {
          yield* publishWorking();
          return;
        }
        yield* Ref.update(pendingEvents, (value) => value + 1);
      }),
    );
  });

  // Settle catch-up on an idle gap (no sentinel exists for the shell stream) and
  // keep-alive-publish only during a long sentinel-less replay. Stops once live.
  const catchUpMaintenance: Effect.Effect<void> = Effect.suspend(() =>
    Effect.gen(function* () {
      yield* Effect.sleep(SHELL_CATCHUP_MAINTENANCE_INTERVAL);
      const done = yield* drainLock.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* Ref.get(catchingUp))) {
            return true;
          }
          const now = yield* Clock.currentTimeMillis;
          const reference = Option.getOrElse(yield* Ref.get(lastItemAt), () => now);
          if (now - reference >= SHELL_CATCHUP_IDLE_SETTLE_MS) {
            yield* finishCatchUp();
            return true;
          }
          if ((yield* Ref.get(pendingEvents)) > 0) {
            const lastPublish = Option.getOrElse(yield* Ref.get(lastPublishAt), () => 0);
            if (now - lastPublish >= SHELL_CATCHUP_KEEPALIVE_INTERVAL_MS) {
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

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      // Establish the base shell snapshot to resume from, minimizing bytes over
      // the wire:
      // - Warm cache: reuse the cached snapshot (zero network) and resume via
      //   `afterSequence` so we only receive shell events since the cached
      //   sequence.
      // - Cold cache: load the full shell snapshot over HTTP (gzip-compressible,
      //   and off the socket), then resume via `afterSequence`.
      // If no base can be established we fall back to the socket-embedded
      // snapshot so the shell still synchronizes. Overlapping/replayed events are
      // deduped by sequence in applyItem.
      const base = Option.isSome(cachedSnapshot)
        ? cachedSnapshot
        : yield* Effect.gen(function* () {
            const prepared = yield* SubscriptionRef.changes(supervisor.prepared).pipe(
              Stream.filter(Option.isSome),
              Stream.map((current) => current.value),
              Stream.runHead,
            );
            return Option.isSome(prepared)
              ? yield* snapshotLoader.load(prepared.value)
              : Option.none<OrchestrationShellSnapshot>();
          });

      if (Option.isSome(base)) {
        yield* applyItem({ kind: "snapshot", snapshot: base.value });
      }

      const subscribeInput = Option.match(base, {
        onNone: () => ({}),
        onSome: (snapshot) => ({ afterSequence: snapshot.snapshotSequence }),
      });

      // Seed the idle + keep-alive clocks from drain start so an empty replay
      // still settles, then run the maintenance flusher alongside the stream.
      const drainStart = yield* Clock.currentTimeMillis;
      yield* Ref.set(lastItemAt, Option.some(drainStart));
      yield* Ref.set(lastPublishAt, Option.some(drainStart));
      yield* Effect.forkScoped(catchUpMaintenance);

      yield* subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, subscribeInput, {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
      }).pipe(Stream.runForEach(applyItem));
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

  return state;
});

export function shellStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export interface EnvironmentShellSummary {
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly hasCachedShell: boolean;
  readonly hasLiveShell: boolean;
  readonly firstError: string | null;
  readonly latestSnapshotUpdatedAt: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
  latestSnapshotUpdatedAt: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.hasCachedShell === right.hasCachedShell &&
    left.hasLiveShell === right.hasLiveShell &&
    left.firstError === right.firstError &&
    left.latestSnapshotUpdatedAt === right.latestSnapshotUpdatedAt
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let hasCachedShell = false;
    let hasLiveShell = false;
    let firstError: string | null = null;
    let latestSnapshotUpdatedAt: string | null = null;

    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      hasCachedShell ||= state.status === "cached";
      hasLiveShell ||= state.status === "live";
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
      const updatedAt = state.snapshot.value.updatedAt;
      if (latestSnapshotUpdatedAt === null || updatedAt > latestSnapshotUpdatedAt) {
        latestSnapshotUpdatedAt = updatedAt;
      }
    }

    const next: EnvironmentShellSummary = {
      hasSnapshot,
      hasSynchronizingShell,
      hasCachedShell,
      hasLiveShell,
      firstError,
      latestSnapshotUpdatedAt,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ShellSnapshotLoader | R,
    E
  >,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(shellStateChanges(environmentId), {
      initialValue: EMPTY_SHELL_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(environmentId))), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  return {
    stateAtom,
    stateValueAtom,
  };
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./shellSnapshotHttp.ts";
export * from "./snapshots.ts";
