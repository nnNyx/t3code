// Streaming-haptics hydration gate.
//
// Opening a thread hands the full history to the feed as one snapshot, then
// replays every event buffered since the cached sequence through the SAME
// live path (`setThread`, status "live"). A streaming assistant turn therefore
// re-appends its text one buffered event at a time on open — indistinguishable
// at this layer from a genuinely live token (both are just a growing message on
// a new detail object). Firing a selection haptic per growth turns that
// catch-up burst into a vibration storm and buzzes as if the reply were
// streaming live.
//
// There is no clean per-event "this is catch-up" flag to key off (see
// threads.ts: catch-up and live events both land as live setThread updates), so
// we gate on settling instead: the catch-up burst arrives back-to-back with
// sub-frame gaps, while genuine live tokens arrive spaced out by real network +
// generation latency. Haptics stay suppressed until the feed goes quiet for
// `settleMs` (catch-up finished) — with a `maxHydrationMs` safety cap so a
// continuously-fast live stream is not muted for its whole turn. Everything
// after hydration is treated as live and buzzes as designed.

export interface StreamingBaseline {
  readonly id: string;
  readonly textLength: number;
}

export interface HapticsGateState {
  readonly threadId: string | null;
  readonly hydrated: boolean;
  /** When the current thread's first feed update landed (catch-up start). */
  readonly firstUpdateAt: number | null;
  readonly baseline: StreamingBaseline | null;
  readonly lastHapticAt: number;
}

export interface HapticsGateConfig {
  /** Quiet gap that marks the end of the catch-up burst. */
  readonly settleMs: number;
  /** Upper bound on hydration so a never-quiet live stream still buzzes. */
  readonly maxHydrationMs: number;
  /** Throttle between live growth haptics (matches upstream cadence). */
  readonly minHapticGapMs: number;
}

export const DEFAULT_HAPTICS_GATE_CONFIG: HapticsGateConfig = {
  settleMs: 300,
  maxHydrationMs: 4_000,
  minHapticGapMs: 320,
};

export type HapticsGateEvent =
  | {
      readonly type: "update";
      readonly threadId: string;
      readonly latest: StreamingBaseline | null;
      readonly now: number;
    }
  // Fired by a timer once the feed has been quiet for `settleMs`.
  | { readonly type: "settle"; readonly now: number };

export interface HapticsGateStep {
  readonly state: HapticsGateState;
  readonly fireHaptic: boolean;
  /** True while still hydrating — the hook (re)arms the settle timer. */
  readonly hydrating: boolean;
}

export const INITIAL_HAPTICS_GATE_STATE: HapticsGateState = {
  threadId: null,
  hydrated: false,
  firstUpdateAt: null,
  baseline: null,
  lastHapticAt: 0,
};

function evaluateLiveGrowth(
  state: HapticsGateState,
  latest: StreamingBaseline | null,
  now: number,
  config: HapticsGateConfig,
): HapticsGateStep {
  // No streaming message: nothing to buzz for; drop the baseline.
  if (latest === null) {
    return {
      state: { ...state, baseline: null },
      fireHaptic: false,
      hydrating: false,
    };
  }

  const previous = state.baseline;
  const nextState: HapticsGateState = { ...state, baseline: latest };
  const isNewStream = previous?.id !== latest.id;
  const textGrew = previous?.id === latest.id && latest.textLength > previous.textLength;

  if (!isNewStream && !textGrew) {
    return { state: nextState, fireHaptic: false, hydrating: false };
  }
  // Throttle only sustained growth of the same stream; a brand-new stream
  // always earns its first tick.
  if (!isNewStream && now - state.lastHapticAt < config.minHapticGapMs) {
    return { state: nextState, fireHaptic: false, hydrating: false };
  }

  return {
    state: { ...nextState, lastHapticAt: now },
    fireHaptic: true,
    hydrating: false,
  };
}

/**
 * Advance the gate for a feed update or a settle timer tick. Pure so the
 * hydration transitions are unit-testable with an injected clock.
 */
export function stepHapticsGate(
  state: HapticsGateState,
  event: HapticsGateEvent,
  config: HapticsGateConfig = DEFAULT_HAPTICS_GATE_CONFIG,
): HapticsGateStep {
  if (event.type === "settle") {
    if (state.hydrated) {
      return { state, fireHaptic: false, hydrating: false };
    }
    // Feed went quiet: catch-up is done. Enable live haptics from here; keep
    // the captured baseline so the next real growth fires (and this settle
    // itself never does).
    return {
      state: { ...state, hydrated: true },
      fireHaptic: false,
      hydrating: false,
    };
  }

  // Thread changed: restart hydration for the new thread.
  if (state.threadId !== event.threadId) {
    return {
      state: {
        threadId: event.threadId,
        hydrated: false,
        firstUpdateAt: event.now,
        baseline: event.latest,
        lastHapticAt: 0,
      },
      fireHaptic: false,
      hydrating: true,
    };
  }

  if (state.hydrated) {
    return evaluateLiveGrowth(state, event.latest, event.now, config);
  }

  // Still hydrating. If catch-up has run past the safety cap, hydrate now and
  // treat this update as the first live one; otherwise absorb it silently.
  const firstUpdateAt = state.firstUpdateAt ?? event.now;
  if (event.now - firstUpdateAt >= config.maxHydrationMs) {
    return evaluateLiveGrowth(
      { ...state, hydrated: true, firstUpdateAt },
      event.latest,
      event.now,
      config,
    );
  }

  return {
    state: { ...state, firstUpdateAt, baseline: event.latest },
    fireHaptic: false,
    hydrating: true,
  };
}
