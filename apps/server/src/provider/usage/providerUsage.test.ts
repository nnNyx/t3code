// @effect-diagnostics globalDate:off - Fixtures intentionally assert epoch-to-ISO provider usage mapping.
import { describe, expect, it } from "vite-plus/test";

import {
  mapClaudeRateLimits,
  mapCodexRateLimits,
  mapRateLimitsToUsage,
  parseClaudeUsageLimitsJson,
} from "./providerUsage.ts";

// A fixed reset instant well in the future so ISO conversion is deterministic.
const RESET_EPOCH_SECONDS = 1_900_000_000; // 2030-03-17T17:46:40.000Z
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
      id: "five_hour",
      label: "5h",
      usedPercent: 62,
      resetsAt: RESET_ISO,
    });
    expect(windows[1]?.window).toEqual({
      id: "seven_day",
      label: "Weekly",
      usedPercent: 18,
      resetsAt: RESET_ISO,
    });
    // Shorter window sorts first.
    expect(windows[0]?.sortWeight).toBeLessThan(windows[1]!.sortWeight);
  });

  it("classifies a weekly-only primary window by duration", () => {
    const windows = mapCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 30,
          windowDurationMins: 10_080,
          resetsAt: RESET_EPOCH_SECONDS,
        },
        secondary: null,
      },
    });

    expect(windows).toEqual([
      {
        window: {
          id: "seven_day",
          label: "Weekly",
          usedPercent: 30,
          resetsAt: RESET_ISO,
        },
        sortWeight: 10_080,
      },
    ]);
  });

  it("keeps a duration-less positional window out of the 5h/7d slots", () => {
    const windows = mapCodexRateLimits({
      rateLimits: { primary: { usedPercent: 140 } },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.window.usedPercent).toBe(100);
    expect(windows[0]?.window.label).toBe("Primary");
    expect(windows[0]?.window.id).toBe("codex_primary");
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

describe("parseClaudeUsageLimitsJson", () => {
  it("maps session, weekly, and model-specific windows onto live telemetry ids", () => {
    const output = JSON.stringify({
      result: [
        "Current session: 30% used · resets Jul 23, 1:30am (America/Chicago)",
        "Current week (all models): 16% used · resets Jul 28, 1am (America/Chicago)",
        "Current week (Fable): 26% used · resets Jul 28, 1am (America/Chicago)",
      ].join("\n"),
    });

    expect(parseClaudeUsageLimitsJson(output, "2026-07-22T12:00:00.000Z")).toEqual([
      {
        window: {
          id: "five_hour",
          label: "5h",
          usedPercent: 30,
          resetsAt: "2026-07-23T06:30:00.000Z",
        },
        sortWeight: 300,
      },
      {
        window: {
          id: "seven_day",
          label: "Weekly",
          usedPercent: 16,
          resetsAt: "2026-07-28T06:00:00.000Z",
        },
        sortWeight: 10_080,
      },
      {
        window: {
          id: "seven_day_fable",
          label: "Fable weekly",
          usedPercent: 26,
          resetsAt: "2026-07-28T06:00:00.000Z",
        },
        sortWeight: 10_081,
      },
    ]);
  });

  it("fails closed for malformed or changed output", () => {
    expect(parseClaudeUsageLimitsJson("not json", "2026-07-22T12:00:00.000Z")).toEqual([]);
    expect(
      parseClaudeUsageLimitsJson(
        JSON.stringify({ result: "Your limits look healthy." }),
        "2026-07-22T12:00:00.000Z",
      ),
    ).toEqual([]);
  });

  it("uses the reset zone's local year around the UTC new-year boundary", () => {
    const output = JSON.stringify({
      result: "Current session: 30% used · resets Dec 31, 11pm (America/Los_Angeles)",
    });

    expect(parseClaudeUsageLimitsJson(output, "2027-01-01T00:30:00.000Z")[0]?.window.resetsAt).toBe(
      "2027-01-01T07:00:00.000Z",
    );
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
