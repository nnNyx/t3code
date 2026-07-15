import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { ProviderUsageTracker, ProviderUsageTrackerLive } from "./ProviderUsageTracker.ts";

const run = <A>(effect: Effect.Effect<A, never, ProviderUsageTracker>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(ProviderUsageTrackerLive)));

function provider(instanceId: string): ServerProvider {
  // Minimal shape sufficient for decorateProviders (it only reads instanceId
  // and spreads the rest through).
  return {
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(0).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

const FUTURE_ISO = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe("ProviderUsageTracker", () => {
  it("records codex windows and decorates the matching provider", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        yield* tracker.recordRateLimits({
          instanceId: "codex",
          driver: "codex",
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
              secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null },
            },
          },
        });
        return yield* tracker.decorateProviders([provider("codex"), provider("other")]);
      }),
    );
    expect(result[0]?.usage).toHaveLength(2);
    expect(result[0]?.usage?.[0]?.id).toBe("primary");
    // Unrelated instance is untouched.
    expect(result[1]?.usage).toBeUndefined();
  });

  it("merges sparse Claude windows across events by id", async () => {
    const usage = await run(
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        yield* tracker.recordRateLimits({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          rateLimits: { rate_limit_info: { rateLimitType: "five_hour", utilization: 30 } },
        });
        yield* tracker.recordRateLimits({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          rateLimits: { rate_limit_info: { rateLimitType: "seven_day", utilization: 55 } },
        });
        // Re-report the five_hour window with a fresh value; it replaces in place.
        yield* tracker.recordRateLimits({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          rateLimits: { rate_limit_info: { rateLimitType: "five_hour", utilization: 44 } },
        });
        const [decorated] = yield* tracker.decorateProviders([provider("claudeAgent")]);
        return decorated?.usage ?? [];
      }),
    );
    expect(usage.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(usage[0]?.usedPercent).toBe(44);
  });

  it("prunes windows whose reset instant has already passed", async () => {
    const usage = await run(
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        yield* tracker.recordRateLimits({
          instanceId: "codex",
          driver: "codex",
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: PAST_ISO },
              secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: FUTURE_ISO },
            },
          },
        });
        const [decorated] = yield* tracker.decorateProviders([provider("codex")]);
        return decorated?.usage ?? [];
      }),
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]?.id).toBe("secondary");
  });

  it("leaves usage absent when no telemetry was recorded", async () => {
    const [decorated] = await run(
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        return yield* tracker.decorateProviders([provider("codex")]);
      }),
    );
    expect(decorated?.usage).toBeUndefined();
  });
});
