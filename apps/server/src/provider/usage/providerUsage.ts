/**
 * Pure per-driver usage/rate-limit mapping.
 *
 * Turns the raw `account.rate-limits.updated` runtime event payload each
 * driver emits into normalized {@link ServerProviderUsageWindow} rows that
 * the ws snapshot path decorates onto `ServerProvider`. Kept pure so the
 * mapping can be unit-tested against the real event shapes.
 *
 * What each driver actually exposes (verified against the shipped schemas):
 *
 *  - **codex** — the app-server `account/rateLimits/updated` notification
 *    (`V2AccountRateLimitsUpdatedNotification`). Its `rateLimits` snapshot
 *    carries `primary` and `secondary` {@link RateLimitWindow}s, each with an
 *    integer `usedPercent`, an optional `windowDurationMins`, and an optional
 *    `resetsAt` (unix seconds). A single event carries every window, so codex
 *    is a full replace. The adapter wraps the notification under a further
 *    `rateLimits` key, so the snapshot is double-nested — {@link unwrapCodexSnapshot}
 *    descends to find it.
 *  - **claudeAgent** — the Claude Agent SDK `rate_limit_event` message. Its
 *    `rate_limit_info` (`SDKRateLimitInfo`) carries ONE window per event:
 *    `rateLimitType` ("five_hour" | "seven_day" | "seven_day_opus" |
 *    "seven_day_sonnet" | "overage"), a `utilization` percent (0-100), and an
 *    optional `resetsAt` (unix seconds). Because it is sparse, the tracker
 *    merges windows by `id` across events.
 *
 * @module provider/usage/providerUsage
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

/** A usage window plus an internal sort weight (shorter windows first). */
export interface RankedUsageWindow {
  readonly window: ServerProviderUsageWindow;
  /** Window duration in minutes; used only for stable ordering. */
  readonly sortWeight: number;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  // Round to one decimal so the bar/label stay tidy without losing signal.
  return Math.round(value * 10) / 10;
}

/**
 * Coerce a reset instant to ISO-8601. Accepts unix seconds, unix millis, or
 * an already-ISO string; returns undefined for missing/invalid/non-positive.
 */
function toResetIso(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  const numeric = finiteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  const millis = numeric < 1e12 ? numeric * 1000 : numeric;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Human label from a window duration in minutes, else the fallback. */
function windowLabelFromMinutes(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined || minutes <= 0) return fallback;
  const MINUTES_PER_DAY = 60 * 24;
  if (minutes % MINUTES_PER_DAY === 0) {
    const days = minutes / MINUTES_PER_DAY;
    return days === 7 ? "Weekly" : `${days}d`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function makeWindow(input: {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
}): ServerProviderUsageWindow {
  return {
    id: input.id,
    label: input.label,
    usedPercent: clampPercent(input.usedPercent),
    ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
  };
}

/**
 * Descend through nested `rateLimits` wrappers to the object that actually
 * holds the `primary`/`secondary` windows. The codex adapter wraps the
 * notification (`{ rateLimits: <notification> }`) and the notification itself
 * nests the snapshot under `rateLimits`, so the real snapshot can be two
 * levels deep.
 */
function unwrapCodexSnapshot(raw: unknown): Record<string, unknown> | undefined {
  let current = readRecord(raw);
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if ("primary" in current || "secondary" in current) {
      return current;
    }
    current = readRecord(current.rateLimits);
  }
  return undefined;
}

function mapCodexWindow(
  id: string,
  raw: unknown,
  fallbackLabel: string,
  fallbackSortWeight: number,
): RankedUsageWindow | undefined {
  const record = readRecord(raw);
  if (record === undefined) return undefined;
  const usedPercent = finiteNumber(record.usedPercent);
  if (usedPercent === undefined) return undefined;
  const minutes = finiteNumber(record.windowDurationMins);
  return {
    window: makeWindow({
      id,
      label: windowLabelFromMinutes(minutes ?? undefined, fallbackLabel),
      usedPercent,
      resetsAt: toResetIso(record.resetsAt),
    }),
    sortWeight: minutes ?? fallbackSortWeight,
  };
}

/** Map a codex `account.rate-limits.updated` payload to usage windows. */
export function mapCodexRateLimits(rawRateLimits: unknown): ReadonlyArray<RankedUsageWindow> {
  const snapshot = unwrapCodexSnapshot(rawRateLimits);
  if (snapshot === undefined) return [];
  const windows: RankedUsageWindow[] = [];
  const primary = mapCodexWindow("primary", snapshot.primary, "Primary", 5 * 60);
  if (primary !== undefined) windows.push(primary);
  const secondary = mapCodexWindow("secondary", snapshot.secondary, "Weekly", 7 * 24 * 60);
  if (secondary !== undefined) windows.push(secondary);
  return windows;
}

const CLAUDE_WINDOW_META: Record<string, { readonly label: string; readonly sortWeight: number }> =
  {
    five_hour: { label: "5h", sortWeight: 5 * 60 },
    seven_day: { label: "Weekly", sortWeight: 7 * 24 * 60 },
    seven_day_opus: { label: "Opus weekly", sortWeight: 7 * 24 * 60 + 1 },
    seven_day_sonnet: { label: "Sonnet weekly", sortWeight: 7 * 24 * 60 + 2 },
    overage: { label: "Overage", sortWeight: Number.MAX_SAFE_INTEGER },
  };

/** Map a Claude `account.rate-limits.updated` payload to a usage window. */
export function mapClaudeRateLimits(rawRateLimits: unknown): ReadonlyArray<RankedUsageWindow> {
  const message = readRecord(rawRateLimits);
  if (message === undefined) return [];
  // The adapter forwards the whole `rate_limit_event` message; the usable
  // window lives under `rate_limit_info`. Fall back to the message itself in
  // case a caller passes the info object directly.
  const info = readRecord(message.rate_limit_info) ?? message;
  const rateLimitType = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
  const utilization = finiteNumber(info.utilization);
  if (rateLimitType === undefined || utilization === undefined) return [];
  const meta = CLAUDE_WINDOW_META[rateLimitType] ?? {
    label: rateLimitType,
    sortWeight: Number.MAX_SAFE_INTEGER,
  };
  return [
    {
      window: makeWindow({
        id: rateLimitType,
        label: meta.label,
        usedPercent: utilization,
        resetsAt: toResetIso(info.resetsAt),
      }),
      sortWeight: meta.sortWeight,
    },
  ];
}

/**
 * Map a driver's `account.rate-limits.updated` runtime payload
 * (`event.payload.rateLimits`) to ranked usage windows. Returns an empty
 * array for drivers/payloads that expose nothing machine-readable.
 */
export function mapRateLimitsToUsage(
  driver: string,
  rawRateLimits: unknown,
): ReadonlyArray<RankedUsageWindow> {
  switch (driver) {
    case "codex":
      return mapCodexRateLimits(rawRateLimits);
    case "claudeAgent":
      return mapClaudeRateLimits(rawRateLimits);
    default:
      return [];
  }
}
