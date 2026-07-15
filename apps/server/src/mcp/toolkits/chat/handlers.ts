import * as NodeCrypto from "node:crypto";

import {
  type ClientOrchestrationCommand,
  CommandId,
  defaultInstanceIdForDriver,
  MessageId,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  ModelSelection,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  type PreviewAutomationUnavailableError,
  ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { normalizeDispatchCommand } from "../../../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ChatToolError, type ChatThreadSummary, ChatToolkit } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const uuid = () => globalThis.crypto.randomUUID();

/** Max chars of the last assistant message returned by chat_get_thread_status. */
const ASSISTANT_TAIL_CHARS = 4000;
/** Max chars for a title auto-derived from the first prompt. */
const DERIVED_TITLE_CHARS = 80;

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

/** Derive a sidebar title from the first prompt when the caller omits one. */
const deriveTitle = (prompt: string): string => {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  const base = firstLine.length > 0 ? firstLine : prompt.trim();
  if (base.length === 0) return "New thread";
  return base.length > DERIVED_TITLE_CHARS ? `${base.slice(0, DERIVED_TITLE_CHARS - 1)}…` : base;
};

const tailText = (text: string): string =>
  text.length > ASSISTANT_TAIL_CHARS ? `…${text.slice(-ASSISTANT_TAIL_CHARS)}` : text;

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

// Resolve + validate the requested model against the live provider instance
// registry (the same registry ws turn starts route through). Failures are
// self-correcting: they enumerate the valid instances / models so an LLM caller
// can retry without guessing.
const resolveModelSelection = Effect.fn("ChatToolkit.resolveModelSelection")(function* (input: {
  readonly instanceId?: string | undefined;
  readonly provider?: string | undefined;
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
}) {
  const registry = yield* ProviderInstanceRegistry;
  const instances = yield* registry.listInstances;
  const listInstances = () =>
    instances.length === 0
      ? "(no provider instances are configured)"
      : instances.map((instance) => `"${instance.instanceId}" (${instance.driverKind})`).join(", ");

  let instanceId: ProviderInstanceId;
  if (input.instanceId !== undefined) {
    instanceId = input.instanceId as ProviderInstanceId;
  } else if (input.provider !== undefined) {
    instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(input.provider));
  } else {
    return yield* new ChatToolError({
      detail: `Provide model.instanceId or model.provider. Configured instances: ${listInstances()}.`,
    });
  }

  const instance = yield* registry.getInstance(instanceId);
  if (!instance) {
    return yield* new ChatToolError({
      detail: `Unknown provider instance "${instanceId}". Configured instances: ${listInstances()}.`,
    });
  }

  const snapshot = yield* instance.snapshot.getSnapshot;
  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[instance.driverKind] ?? {};
  const requestedSlug = aliases[input.model] ?? input.model;
  const match = snapshot.models.find((model) => model.slug === requestedSlug);
  if (!match) {
    const available =
      snapshot.models.length === 0
        ? "(this instance reports no models)"
        : snapshot.models.map((model) => `"${model.slug}"`).join(", ");
    return yield* new ChatToolError({
      detail: `Unknown model "${input.model}" for instance "${instanceId}". Available models: ${available}.`,
    });
  }

  return yield* decodeModelSelection({
    instanceId,
    model: match.slug,
    ...(input.reasoningEffort !== undefined
      ? { options: [{ id: "reasoningEffort", value: input.reasoningEffort }] }
      : {}),
  }).pipe(
    Effect.mapError(
      (error) => new ChatToolError({ detail: `Failed to build model selection: ${error.message}` }),
    ),
  );
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

  chat_create_thread: (input) =>
    runChatTool(
      Effect.gen(function* () {
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const query = yield* ProjectionSnapshotQuery;

        // Default to the calling thread's project so a spawned thread lands
        // beside its parent unless the caller targets another project.
        let projectId: ProjectId;
        if (input.projectId !== undefined) {
          projectId = ProjectId.make(input.projectId);
        } else {
          const parent = yield* query.getThreadShellById(invocation.threadId);
          const resolved = Option.map(parent, (thread) => thread.projectId);
          if (Option.isNone(resolved)) {
            return yield* new ChatToolError({
              detail:
                "No projectId provided and the calling thread's project could not be resolved. Pass projectId (see chat_list_projects).",
            });
          }
          projectId = resolved.value;
        }

        const modelSelection = yield* resolveModelSelection(input.model);
        const runtimeMode = input.runtimeMode ?? "full-access";
        const title = input.title ?? deriveTitle(input.prompt);
        const threadId = ThreadId.make(uuid());

        // Same two-step orchestration path the ws bootstrap turn-start expands
        // to (thread.create then thread.turn.start), minus git worktree/setup —
        // the thread runs in the project workspace root.
        yield* dispatch({
          type: "thread.create",
          commandId: CommandId.make(uuid()),
          threadId,
          projectId,
          title,
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: yield* nowIso,
        });

        yield* dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(uuid()),
          threadId,
          message: {
            messageId: MessageId.make(uuid()),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          createdAt: yield* nowIso,
        });

        return { threadId, title };
      }),
    ),

  chat_send_message: (input) =>
    runChatTool(
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const threadId = ThreadId.make(input.threadId);
        const existing = yield* query.getThreadShellById(threadId);
        if (Option.isNone(existing)) {
          return yield* new ChatToolError({
            detail: `Thread "${input.threadId}" was not found. Use chat_list_threads to discover thread ids.`,
          });
        }
        const thread = existing.value;

        // A turn start on a running thread steers the active turn; on an idle
        // thread it begins a new one — the same behaviour as the composer's
        // send. Reuse the thread's own model/runtime so a follow-up matches it.
        yield* dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(uuid()),
          threadId,
          message: {
            messageId: MessageId.make(uuid()),
            role: "user",
            text: input.message,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: yield* nowIso,
        });

        const refreshed = yield* query.getThreadShellById(threadId);
        const threadState: OrchestrationSessionStatus = Option.match(refreshed, {
          onNone: () => "idle" as const,
          onSome: (next) => next.session?.status ?? ("idle" as const),
        });
        return { accepted: true as const, threadState };
      }),
    ),

  chat_get_thread_status: (input) =>
    runChatTool(
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const threadId = ThreadId.make(input.threadId);
        const detail = yield* query.getThreadDetailById(threadId);
        if (Option.isNone(detail)) {
          return yield* new ChatToolError({
            detail: `Thread "${input.threadId}" was not found. Use chat_list_threads to discover thread ids.`,
          });
        }
        const thread = detail.value;
        const sessionStatus: OrchestrationSessionStatus = thread.session?.status ?? "idle";
        const lastAssistant = thread.messages.findLast((message) => message.role === "assistant");
        return {
          threadId: thread.id,
          title: thread.title,
          sessionStatus,
          running: sessionStatus === "running" || sessionStatus === "starting",
          latestTurnState: thread.latestTurn?.state ?? null,
          lastError: thread.session?.lastError ?? null,
          lastAssistantMessage:
            lastAssistant && lastAssistant.text.length > 0 ? tailText(lastAssistant.text) : null,
        };
      }),
    ),
});
