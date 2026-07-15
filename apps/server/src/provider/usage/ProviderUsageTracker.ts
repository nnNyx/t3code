/**
 * ProviderUsageTracker — shared in-memory per-instance usage snapshots.
 *
 * Written by the provider runtime ingestion worker whenever a driver emits an
 * `account.rate-limits.updated` event; read by the ws snapshot path to
 * decorate `ServerProvider` with per-plan `usage` windows (the progress-bar
 * data). Mirrors {@link AutoFallbackCooldownTracker}: never persisted — a
 * server restart clears everything, which is correct for volatile
 * provider-side telemetry.
 *
 * Windows are merged by their stable `id` so sparse drivers (Claude emits one
 * window per event) accumulate a full picture over a session, while
 * full-replace drivers (codex sends every window each event) overwrite in
 * place. Windows whose reset instant has already passed are pruned on read so
 * the UI never shows a stale "still 90%" bar after a window rolled over.
 *
 * @module provider/usage/ProviderUsageTracker
 */
import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { mapRateLimitsToUsage, type RankedUsageWindow } from "./providerUsage.ts";

/** Per-instance window map, keyed by window id, retaining sort weight. */
type InstanceUsageState = ReadonlyMap<string, RankedUsageWindow>;
type UsageState = ReadonlyMap<string, InstanceUsageState>;

export interface ProviderUsageTrackerShape {
  /**
   * Record a driver's `account.rate-limits.updated` payload
   * (`event.payload.rateLimits`) for one instance. No-op when the driver
   * exposes nothing machine-readable or the payload has no usable windows.
   */
  readonly recordRateLimits: (input: {
    readonly instanceId: string;
    readonly driver: string;
    readonly rateLimits: unknown;
  }) => Effect.Effect<void>;
  /** Decorate provider snapshots with their accumulated `usage` windows. */
  readonly decorateProviders: (
    providers: ReadonlyArray<ServerProvider>,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
}

export class ProviderUsageTracker extends Context.Service<
  ProviderUsageTracker,
  ProviderUsageTrackerShape
>()("t3/provider/usage/ProviderUsageTracker") {}

function mergeWindows(
  existing: InstanceUsageState | undefined,
  incoming: ReadonlyArray<RankedUsageWindow>,
): InstanceUsageState {
  const next = new Map(existing ?? []);
  for (const ranked of incoming) {
    next.set(ranked.window.id, ranked);
  }
  return next;
}

/** Present windows for one instance: prune reset-elapsed, sort, strip weights. */
function presentWindows(
  state: InstanceUsageState | undefined,
  now: number,
): ReadonlyArray<ServerProviderUsageWindow> {
  if (state === undefined || state.size === 0) return [];
  const ranked = [...state.values()].filter((entry) => {
    const resetsAt = entry.window.resetsAt;
    if (resetsAt === undefined) return true;
    const parsed = Date.parse(resetsAt);
    return Number.isNaN(parsed) ? true : parsed > now;
  });
  ranked.sort((a, b) => a.sortWeight - b.sortWeight || a.window.id.localeCompare(b.window.id));
  return ranked.map((entry) => entry.window);
}

const make = Effect.gen(function* () {
  const stateRef = yield* Ref.make<UsageState>(new Map());

  const service: ProviderUsageTrackerShape = {
    recordRateLimits: ({ instanceId, driver, rateLimits }) =>
      Effect.sync(() => mapRateLimitsToUsage(driver, rateLimits)).pipe(
        Effect.flatMap((windows) =>
          windows.length === 0
            ? Effect.void
            : Ref.update(stateRef, (state) => {
                const next = new Map(state);
                next.set(instanceId, mergeWindows(state.get(instanceId), windows));
                return next;
              }),
        ),
      ),
    decorateProviders: (providers) =>
      Effect.all([Ref.get(stateRef), Clock.currentTimeMillis]).pipe(
        Effect.map(([state, now]) =>
          providers.map((provider) => {
            const usage = presentWindows(state.get(String(provider.instanceId)), now);
            return usage.length === 0 ? provider : { ...provider, usage };
          }),
        ),
      ),
  };

  return service;
});

export const ProviderUsageTrackerLive = Layer.effect(ProviderUsageTracker, make);
