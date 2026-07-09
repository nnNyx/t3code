import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_HAPTICS_GATE_CONFIG,
  INITIAL_HAPTICS_GATE_STATE,
  stepHapticsGate,
  type HapticsGateState,
  type StreamingBaseline,
} from "./streamingHapticsGate";

const config = DEFAULT_HAPTICS_GATE_CONFIG;

function update(
  state: HapticsGateState,
  latest: StreamingBaseline | null,
  now: number,
  threadId = "thread-a",
) {
  return stepHapticsGate(state, { type: "update", threadId, latest, now }, config);
}

function settle(state: HapticsGateState, now: number) {
  return stepHapticsGate(state, { type: "settle", now }, config);
}

describe("streaming haptics gate", () => {
  it("never fires during the initial catch-up burst", () => {
    let state = INITIAL_HAPTICS_GATE_STATE;
    // Snapshot lands with an in-progress streaming assistant message.
    let step = update(state, { id: "m1", textLength: 100 }, 0);
    expect(step.fireHaptic).toBe(false);
    expect(step.hydrating).toBe(true);
    state = step.state;

    // Buffered events replay back-to-back, growing the same message. None buzz.
    for (const [i, now] of [10, 20, 30, 40].entries()) {
      step = update(state, { id: "m1", textLength: 100 + (i + 1) * 50 }, now);
      expect(step.fireHaptic).toBe(false);
      expect(step.hydrating).toBe(true);
      state = step.state;
    }
  });

  it("fires for genuine live growth after the feed settles", () => {
    let step = update(INITIAL_HAPTICS_GATE_STATE, { id: "m1", textLength: 100 }, 0);
    step = update(step.state, { id: "m1", textLength: 200 }, 30);
    // Feed quiet for settleMs → hydration completes (no buzz for the settle).
    const settled = settle(step.state, 30 + config.settleMs);
    expect(settled.fireHaptic).toBe(false);
    expect(settled.state.hydrated).toBe(true);

    // Next real token grows the same message → buzz.
    const live = update(settled.state, { id: "m1", textLength: 210 }, 30 + config.settleMs + 500);
    expect(live.fireHaptic).toBe(true);
  });

  it("throttles sustained same-stream growth but always ticks a new stream", () => {
    let step = update(INITIAL_HAPTICS_GATE_STATE, { id: "m1", textLength: 10 }, 0);
    step = settle(step.state, config.settleMs);
    let s = step.state;

    // First live growth fires at t.
    const t = 1_000;
    let live = update(s, { id: "m1", textLength: 20 }, t);
    expect(live.fireHaptic).toBe(true);
    s = live.state;

    // Growth within the throttle window is suppressed.
    live = update(s, { id: "m1", textLength: 30 }, t + config.minHapticGapMs - 50);
    expect(live.fireHaptic).toBe(false);
    s = live.state;

    // Growth past the throttle window fires again.
    live = update(s, { id: "m1", textLength: 40 }, t + config.minHapticGapMs + 10);
    expect(live.fireHaptic).toBe(true);
    s = live.state;

    // A brand-new stream fires immediately, ignoring the throttle.
    live = update(s, { id: "m2", textLength: 5 }, t + config.minHapticGapMs + 20);
    expect(live.fireHaptic).toBe(true);
  });

  it("hydrates via the safety cap when the feed never settles", () => {
    let step = update(INITIAL_HAPTICS_GATE_STATE, { id: "m1", textLength: 0 }, 0);
    let s = step.state;
    let now = 0;
    // A continuously-fast stream: updates keep arriving inside the settle window,
    // so no settle tick ever runs. Before the cap, nothing buzzes.
    for (let i = 0; i < 20; i += 1) {
      now += 100;
      step = update(s, { id: "m1", textLength: (i + 1) * 20 }, now);
      s = step.state;
      if (now < config.maxHydrationMs) {
        expect(step.fireHaptic).toBe(false);
      }
    }
    // Past the cap the same stream is treated as live and buzzes.
    const afterCap = update(s, { id: "m1", textLength: 9_999 }, config.maxHydrationMs + 500);
    expect(afterCap.state.hydrated).toBe(true);
    expect(afterCap.fireHaptic).toBe(true);
  });

  it("restarts hydration when the thread changes", () => {
    let step = update(INITIAL_HAPTICS_GATE_STATE, { id: "m1", textLength: 50 }, 0);
    step = settle(step.state, config.settleMs);
    expect(step.state.hydrated).toBe(true);

    // Switching threads must re-enter hydration and swallow the new snapshot.
    const switched = update(step.state, { id: "n1", textLength: 400 }, 5_000, "thread-b");
    expect(switched.fireHaptic).toBe(false);
    expect(switched.hydrating).toBe(true);
    expect(switched.state.hydrated).toBe(false);
    expect(switched.state.threadId).toBe("thread-b");
  });

  it("does not buzz when there is no streaming message after hydration", () => {
    let step = update(INITIAL_HAPTICS_GATE_STATE, null, 0);
    step = settle(step.state, config.settleMs);
    const idle = update(step.state, null, 2_000);
    expect(idle.fireHaptic).toBe(false);
    expect(idle.state.baseline).toBeNull();
  });
});
