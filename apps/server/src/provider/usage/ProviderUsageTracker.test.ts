import { describe, expect, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderUsageTracker, ProviderUsageTrackerLive } from "./ProviderUsageTracker.ts";

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
    checkedAt: "1970-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

const FUTURE_ISO = "2999-01-01T00:00:00.000Z";
const PAST_ISO = "1969-01-01T00:00:00.000Z";

describe("ProviderUsageTracker", () => {
  it.layer(ProviderUsageTrackerLive)("live tracker", (it) => {
    it.effect("records codex windows and decorates the matching provider", () =>
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        yield* tracker.recordRateLimits({
          instanceId: "codex-record",
          driver: "codex",
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
              secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null },
            },
          },
        });
        const result = yield* tracker.decorateProviders([
          provider("codex-record"),
          provider("other"),
        ]);

        expect(result[0]?.usage).toHaveLength(2);
        expect(result[0]?.usage?.[0]?.id).toBe("five_hour");
        expect(result[1]?.usage).toBeUndefined();
      }),
    );

    it.effect("merges sparse Claude windows across events by id", () =>
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        yield* tracker.recordRateLimits({
          instanceId: "claude-merge",
          driver: "claudeAgent",
          rateLimits: { rate_limit_info: { rateLimitType: "five_hour", utilization: 30 } },
        });
        yield* tracker.recordRateLimits({
          instanceId: "claude-merge",
          driver: "claudeAgent",
          rateLimits: { rate_limit_info: { rateLimitType: "seven_day", utilization: 55 } },
        });
        yield* tracker.recordRateLimits({
          instanceId: "claude-merge",
          driver: "claudeAgent",
          rateLimits: { rate_limit_info: { rateLimitType: "five_hour", utilization: 44 } },
        });
        const [decorated] = yield* tracker.decorateProviders([provider("claude-merge")]);
        const usage = decorated?.usage ?? [];

        expect(usage.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
        expect(usage[0]?.usedPercent).toBe(44);
      }),
    );

    it.effect("lets live telemetry override a proactive probe baseline", () =>
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        yield* tracker.recordRateLimits({
          instanceId: "codex-probed",
          driver: "codex",
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 45, windowDurationMins: 300 },
            },
          },
        });
        const baseline = {
          ...provider("codex-probed"),
          usage: [
            { id: "five_hour", label: "5h", usedPercent: 20 },
            { id: "seven_day", label: "Weekly", usedPercent: 10 },
          ],
        } satisfies ServerProvider;
        const [decorated] = yield* tracker.decorateProviders([baseline]);

        expect(decorated?.usage).toEqual([
          { id: "five_hour", label: "5h", usedPercent: 45 },
          { id: "seven_day", label: "Weekly", usedPercent: 10 },
        ]);
      }),
    );

    it.effect("treats each Codex update as a complete replacement", () =>
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        yield* tracker.recordRateLimits({
          instanceId: "codex-replace",
          driver: "codex",
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 10 },
              secondary: { usedPercent: 20 },
            },
          },
        });
        yield* tracker.recordRateLimits({
          instanceId: "codex-replace",
          driver: "codex",
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 30 },
            },
          },
        });
        const [decorated] = yield* tracker.decorateProviders([provider("codex-replace")]);

        expect(decorated?.usage).toEqual([
          { id: "codex_primary", label: "Primary", usedPercent: 30 },
        ]);
      }),
    );

    it.effect("prunes windows whose reset instant has already passed", () =>
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        yield* tracker.recordRateLimits({
          instanceId: "codex-prune",
          driver: "codex",
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: PAST_ISO },
              secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: FUTURE_ISO },
            },
          },
        });
        const [decorated] = yield* tracker.decorateProviders([provider("codex-prune")]);
        const usage = decorated?.usage ?? [];

        expect(usage).toHaveLength(1);
        expect(usage[0]?.id).toBe("seven_day");
      }),
    );

    it.effect("prunes an expired proactive probe baseline", () =>
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        const baseline = {
          ...provider("codex-expired-probe"),
          usage: [{ id: "primary", label: "5h", usedPercent: 90, resetsAt: PAST_ISO }],
        } satisfies ServerProvider;
        const [decorated] = yield* tracker.decorateProviders([baseline]);

        expect(decorated?.usage).toBeUndefined();
      }),
    );

    it.effect("leaves usage absent when no telemetry was recorded", () =>
      Effect.gen(function* () {
        const tracker = yield* ProviderUsageTracker;
        const [decorated] = yield* tracker.decorateProviders([provider("codex-empty")]);

        expect(decorated?.usage).toBeUndefined();
      }),
    );
  });
});
