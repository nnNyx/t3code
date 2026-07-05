import * as NodeCrypto from "node:crypto";

import {
  type ClientOrchestrationCommand,
  CommandId,
  type OrchestrationThreadShell,
  type PreviewAutomationUnavailableError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { normalizeDispatchCommand } from "../../../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ChatToolError, type ChatThreadSummary, ChatToolkit } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const toChatToolError = (error: { readonly message: string }) =>
  new ChatToolError({ detail: error.message });

/** Gate on the "chat" capability and surface orchestration failures as tool errors. */
const runChatTool = Effect.fn("ChatToolkit.run")(function* <
  A,
  E extends { readonly message: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<
  A,
  ChatToolError | PreviewAutomationUnavailableError,
  R | McpInvocationContext.McpInvocationContext
> {
  yield* McpInvocationContext.requireMcpCapability("chat");
  return yield* effect.pipe(Effect.mapError(toChatToolError));
});

// Same normalize-then-dispatch funnel as the ws command path, so workspace
// root normalization/creation and command invariants behave identically.
const dispatch = Effect.fn("ChatToolkit.dispatch")(function* (command: ClientOrchestrationCommand) {
  const engine = yield* OrchestrationEngineService;
  const normalized = yield* normalizeDispatchCommand(command);
  return yield* engine.dispatch(normalized);
});

const toThreadSummary = (thread: OrchestrationThreadShell): ChatThreadSummary => ({
  id: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  archived: thread.archivedAt !== null,
});

export const ChatToolkitHandlersLive = ChatToolkit.toLayer({
  chat_list_projects: () =>
    runChatTool(
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const snapshot = yield* query.getShellSnapshot();
        return {
          projects: snapshot.projects.map((project) => ({
            id: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
        };
      }),
    ),

  chat_list_threads: (input) =>
    runChatTool(
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const active = yield* query.getShellSnapshot();
        const archived = yield* query.getArchivedShellSnapshot();
        return {
          threads: [...active.threads, ...archived.threads]
            .filter(
              (thread) => input.projectId === undefined || thread.projectId === input.projectId,
            )
            .map(toThreadSummary),
        };
      }),
    ),

  chat_create_project: (input) =>
    runChatTool(
      Effect.gen(function* () {
        const projectId = ProjectId.make(NodeCrypto.randomUUID());
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          ...(input.createWorkspaceRootIfMissing !== undefined
            ? { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing }
            : {}),
          createdAt: yield* nowIso,
        });
        return { projectId };
      }),
    ),

  chat_move_thread: (input) =>
    runChatTool(
      dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: ThreadId.make(input.threadId),
        projectId: ProjectId.make(input.projectId),
      }).pipe(Effect.as({ ok: true as const })),
    ),

  chat_rename_thread: (input) =>
    runChatTool(
      dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: ThreadId.make(input.threadId),
        title: input.title,
      }).pipe(Effect.as({ ok: true as const })),
    ),
});
