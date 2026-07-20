import type { OrchestrationThread } from "@t3tools/contracts";
import * as Option from "effect/Option";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationThread>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * True while the catch-up replay tail is still being folded into the thread
   * (see `threads.ts`): from first paint until the server's `caught-up` sentinel
   * (or the idle fallback) ends the replay window. Consumers gate live-only
   * affordances — streaming-text presentation, the "working" indicator — on this
   * so a reconnect after absence renders already-settled turns in their final
   * state instantly, instead of visually replaying historical output as if live.
   * Flips to false the moment catch-up settles, after which live events animate.
   */
  readonly hydrating: boolean;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  hydrating: false,
};
