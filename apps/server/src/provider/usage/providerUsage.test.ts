import { describe, expect, it } from "vite-plus/test";

import { mapClaudeRateLimits, mapCodexRateLimits, mapRateLimitsToUsage } from "./providerUsage.ts";

// A fixed reset instant well in the future so ISO conversion is deterministic.
const RESET_EPOCH_SECONDS = 1_900_000_000; // 2030-03-17T15:06:40.000Z
const RESET_ISO = new Date(RESET_EPOCH_SECONDS * 1000).toISOString();

describe("mapCodexRateLimits", () => {
  it("maps the double-nested account/rateLimits/updated snapshot to primary+secondary", () => {
    // Shape per effect-codex-app-server V2AccountRateLimitsUpdatedNotification:
    // the adapter wraps the notification (`{ rateLimits: <notification> }`)
    // and the notification nests the snapshot under `rateLimits` again.
    const rateLimits = {
      rateLimits: {
        planType: "pro",
        limitName: "gpt-5-codex",
        primary: {
          usedPercent: 62,
          windowDurationMins: 300,
          resetsAt: RESET_EPOCH_SECONDS,
        },
        secondary: {
          usedPercent: 18,
          windowDurationMins: 10080,
          resetsAt: RESET_EPOCH_SECONDS,
        },
      },
    };

    const windows = mapCodexRateLimits(rateLimits);
    expect(windows).toHaveLength(2);
    expect(windows[0]?.window).toEqual({
      id: "primary",
      label: "5h",
      usedPercent: 62,
      resetsAt: RESET_ISO,
    });
    expect(windows[1]?.window).toEqual({
      id: "secondary",
      label: "Weekly",
      usedPercent: 18,
      resetsAt: RESET_ISO,
    });
    // Shorter window sorts first.
    expect(windows[0]?.sortWeight).toBeLessThan(windows[1]!.sortWeight);
  });

  it("handles a single-window snapshot and clamps percent", () => {
    const windows = mapCodexRateLimits({
      rateLimits: { primary: { usedPercent: 140 } },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.window.usedPercent).toBe(100);
    expect(windows[0]?.window.label).toBe("Primary");
    expect(windows[0]?.window.resetsAt).toBeUndefined();
  });

  it("returns nothing when the payload carries no windows", () => {
    expect(mapCodexRateLimits({ rateLimits: { planType: "pro" } })).toEqual([]);
    expect(mapCodexRateLimits(undefined)).toEqual([]);
    expect(mapCodexRateLimits(null)).toEqual([]);
  });
});

describe("mapClaudeRateLimits", () => {
  it("maps a single rate_limit_event window", () => {
    // Shape per @anthropic-ai/claude-agent-sdk SDKRateLimitEvent.
    const rateLimits = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 73.4,
        resetsAt: RESET_EPOCH_SECONDS,
      },
      uuid: "u1",
      session_id: "s1",
    };
    const windows = mapClaudeRateLimits(rateLimits);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.window).toEqual({
      id: "five_hour",
      label: "5h",
      usedPercent: 73.4,
      resetsAt: RESET_ISO,
    });
  });

  it("labels the weekly and per-model windows", () => {
    expect(
      mapClaudeRateLimits({
        rate_limit_info: { rateLimitType: "seven_day", utilization: 12 },
      })[0]?.window.label,
    ).toBe("Weekly");
    expect(
      mapClaudeRateLimits({
        rate_limit_info: { rateLimitType: "seven_day_opus", utilization: 5 },
      })[0]?.window.label,
    ).toBe("Opus weekly");
  });

  it("ignores events without a usable window", () => {
    expect(mapClaudeRateLimits({ rate_limit_info: { status: "allowed" } })).toEqual([]);
    expect(mapClaudeRateLimits(undefined)).toEqual([]);
  });
});

describe("mapRateLimitsToUsage", () => {
  it("dispatches by driver and ignores unknown drivers", () => {
    expect(
      mapRateLimitsToUsage("codex", { rateLimits: { primary: { usedPercent: 10 } } }),
    ).toHaveLength(1);
    expect(
      mapRateLimitsToUsage("claudeAgent", {
        rate_limit_info: { rateLimitType: "five_hour", utilization: 10 },
      }),
    ).toHaveLength(1);
    expect(mapRateLimitsToUsage("cursor", { anything: true })).toEqual([]);
  });
});
