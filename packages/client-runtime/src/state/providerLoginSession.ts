import type { ProviderLoginStreamEvent } from "@t3tools/contracts";
import { parseProviderLoginCode, parseProviderLoginUrl } from "@t3tools/shared/providerLogin";

export type ProviderLoginStatus = "starting" | "running" | "exited" | "error";

export interface ProviderLoginBufferState {
  readonly status: ProviderLoginStatus;
  readonly driver: string | null;
  readonly commandLabel: string | null;
  /** Accumulated raw PTY output (bounded). */
  readonly output: string;
  /** First verification URL detected in the output. */
  readonly url: string | null;
  /** First device/user code (XXXX-XXXX) detected in the output. */
  readonly code: string | null;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly error: string | null;
  /** Monotonic version so consumers can diff cheaply. */
  readonly version: number;
}

export const EMPTY_PROVIDER_LOGIN_STATE: ProviderLoginBufferState = Object.freeze({
  status: "starting",
  driver: null,
  commandLabel: null,
  output: "",
  url: null,
  code: null,
  exitCode: null,
  exitSignal: null,
  error: null,
  version: 0,
});

const MAX_OUTPUT_BYTES = 256 * 1024;

function boundOutput(output: string): string {
  return output.length > MAX_OUTPUT_BYTES ? output.slice(output.length - MAX_OUTPUT_BYTES) : output;
}

export function applyProviderLoginStreamEvent(
  current: ProviderLoginBufferState,
  event: ProviderLoginStreamEvent,
): ProviderLoginBufferState {
  switch (event.type) {
    case "started":
      return {
        ...current,
        status:
          current.status === "exited" || current.status === "error" ? current.status : "running",
        driver: event.driver,
        commandLabel: event.commandLabel,
        version: current.version + 1,
      };
    case "challenge":
      return {
        ...current,
        status: current.status === "starting" ? "running" : current.status,
        url: event.url,
        code: event.code,
        version: current.version + 1,
      };
    case "output": {
      const output = boundOutput(`${current.output}${event.data}`);
      // Re-parse the accumulated buffer rather than locking onto the first
      // match: PTY output is chunked arbitrarily, so a verification URL or code
      // can arrive split across frames. The first occurrence's start position is
      // fixed as the buffer only grows, so re-parsing keeps the same (first) URL
      // while letting a partially-received one complete instead of freezing a
      // truncated fragment.
      return {
        ...current,
        output,
        status: current.status === "starting" ? "running" : current.status,
        url: parseProviderLoginUrl(output) ?? current.url ?? null,
        code: parseProviderLoginCode(output) ?? current.code ?? null,
        version: current.version + 1,
      };
    }
    case "exited":
      return {
        ...current,
        status: "exited",
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
  }
}
