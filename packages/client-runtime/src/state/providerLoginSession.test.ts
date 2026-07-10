import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, type ProviderLoginStreamEvent } from "@t3tools/contracts";

import {
  applyProviderLoginStreamEvent,
  EMPTY_PROVIDER_LOGIN_STATE,
  type ProviderLoginBufferState,
} from "./providerLoginSession.ts";

const reduce = (
  events: ReadonlyArray<ProviderLoginStreamEvent>,
  initial: ProviderLoginBufferState = EMPTY_PROVIDER_LOGIN_STATE,
): ProviderLoginBufferState => events.reduce(applyProviderLoginStreamEvent, initial);

const started: ProviderLoginStreamEvent = {
  type: "started",
  instanceId: "codex-1",
  driver: ProviderDriverKind.make("codex"),
  commandLabel: "codex login --device-auth",
};

describe("applyProviderLoginStreamEvent", () => {
  it("accumulates raw output frames in arrival order", () => {
    const state = reduce([
      started,
      { type: "output", data: "Starting login\r\n" },
      { type: "output", data: "Open https://example.com/device\r\n" },
      { type: "output", data: "Waiting...\r\n" },
    ]);

    expect(state.output).toBe(
      "Starting login\r\nOpen https://example.com/device\r\nWaiting...\r\n",
    );
    // Each frame bumps the monotonic version (started + 3 output).
    expect(state.version).toBe(4);
  });

  it("marks the session running as soon as output streams (even without a started frame)", () => {
    const state = reduce([{ type: "output", data: "hello" }]);
    expect(state.status).toBe("running");
    expect(state.output).toBe("hello");
  });

  it("transitions starting -> running on the started frame", () => {
    const state = reduce([started]);
    expect(state.status).toBe("running");
    expect(state.driver).toBe("codex");
    expect(state.commandLabel).toBe("codex login --device-auth");
  });

  it("parses the first verification URL from the accumulated buffer", () => {
    // URL split across two frames so it is only complete once accumulated.
    const state = reduce([
      { type: "output", data: "Visit https://exam" },
      { type: "output", data: "ple.com/verify?code=abc to continue.\r\n" },
    ]);
    expect(state.url).toBe("https://example.com/verify?code=abc");
  });

  it("keeps the first URL once detected even if later output contains another", () => {
    const state = reduce([
      { type: "output", data: "first https://a.example.com\r\n" },
      { type: "output", data: "second https://b.example.com\r\n" },
    ]);
    expect(state.url).toBe("https://a.example.com");
  });

  it("parses a codex-style XXXX-XXXX device code", () => {
    const state = reduce([{ type: "output", data: "Your code: ABCD-1234\r\n" }]);
    expect(state.code).toBe("ABCD-1234");
  });

  it("uses a structured device-code challenge without parsing terminal output", () => {
    const state = reduce([
      started,
      {
        type: "challenge",
        url: "https://auth.openai.com/device",
        code: "WXYZ-9876",
      },
    ]);
    expect(state.url).toBe("https://auth.openai.com/device");
    expect(state.code).toBe("WXYZ-9876");
    expect(state.status).toBe("running");
  });

  it("leaves code null for a claude setup-token flow that emits no grouped code", () => {
    const state = reduce([
      { type: "output", data: "Paste the token from https://claude.ai/setup here:\r\n" },
    ]);
    expect(state.code).toBeNull();
    expect(state.url).toBe("https://claude.ai/setup");
  });

  it("records exit code/signal and flips status to exited", () => {
    const state = reduce([
      started,
      { type: "output", data: "done\r\n" },
      { type: "exited", exitCode: 0, exitSignal: null },
    ]);
    expect(state.status).toBe("exited");
    expect(state.exitCode).toBe(0);
    expect(state.exitSignal).toBeNull();
    // Output is preserved through exit.
    expect(state.output).toBe("done\r\n");
  });

  it("does not resurrect a terminated session back to running on a late output frame", () => {
    const state = reduce([
      { type: "exited", exitCode: 1, exitSignal: null },
      { type: "output", data: "stray\r\n" },
    ]);
    expect(state.status).toBe("exited");
    expect(state.output).toBe("stray\r\n");
  });

  it("captures error events", () => {
    const state = reduce([{ type: "error", message: "spawn failed" }]);
    expect(state.status).toBe("error");
    expect(state.error).toBe("spawn failed");
  });

  it("bounds the accumulated buffer to the tail when output grows large", () => {
    const chunk = "x".repeat(64 * 1024);
    const state = reduce([
      { type: "output", data: chunk },
      { type: "output", data: chunk },
      { type: "output", data: chunk },
      { type: "output", data: chunk },
      { type: "output", data: "TAIL" },
    ]);
    // 256 KiB cap keeps only the most recent bytes; the newest marker survives.
    expect(state.output.length).toBeLessThanOrEqual(256 * 1024);
    expect(state.output.endsWith("TAIL")).toBe(true);
  });

  it("never mutates the frozen empty state", () => {
    applyProviderLoginStreamEvent(EMPTY_PROVIDER_LOGIN_STATE, {
      type: "output",
      data: "hi",
    });
    expect(EMPTY_PROVIDER_LOGIN_STATE.output).toBe("");
    expect(EMPTY_PROVIDER_LOGIN_STATE.version).toBe(0);
  });
});
