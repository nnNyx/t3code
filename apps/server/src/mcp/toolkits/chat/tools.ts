import {
  OrchestrationSessionStatus,
  PreviewAutomationUnavailableError,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";

// FileSystem/Path/ServerConfig/WorkspacePaths back the shared command normalizer.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  FileSystem.FileSystem,
  Path.Path,
  ServerConfig,
  WorkspacePaths.WorkspacePaths,
];

// The spawn tools additionally resolve/validate the requested model against the
// live provider instance registry before dispatching a turn.
const spawnDependencies = [...dependencies, ProviderInstanceRegistry];

/** Serializable wrapper so orchestration read/dispatch failures surface as MCP tool errors. */
export class ChatToolError extends Schema.TaggedErrorClass<ChatToolError>()("ChatToolError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const ChatToolFailure = Schema.Union([PreviewAutomationUnavailableError, ChatToolError]);
export type ChatToolFailure = typeof ChatToolFailure.Type;

export const ChatProjectSummary = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
});
export type ChatProjectSummary = typeof ChatProjectSummary.Type;

export const ChatThreadSummary = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  projectId: ProjectId,
  archived: Schema.Boolean,
});
export type ChatThreadSummary = typeof ChatThreadSummary.Type;

// Entity-id/trimmed-string schemas are transforms whose annotations do not
// surface in tool JSON schemas, so required params use described plain strings
// and handlers brand them.
const describedNonEmptyString = (description: string) =>
  Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty({ description }));

const managementTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

const readonlyManagementTool = <T extends Tool.Any>(tool: T): T =>
  managementTool(tool).annotate(Tool.Readonly, true) as T;

export const ChatListProjectsTool = readonlyManagementTool(
  Tool.make("chat_list_projects", {
    description:
      "List every project in this T3 Code environment with its id, title, and workspace root path. Use the returned project ids as targets for chat_move_thread or as filters for chat_list_threads.",
    success: Schema.Struct({ projects: Schema.Array(ChatProjectSummary) }),
    failure: ChatToolFailure,
    dependencies,
  }).annotate(Tool.Title, "List chat projects"),
);

export const ChatListThreadsTool = readonlyManagementTool(
  Tool.make("chat_list_threads", {
    description:
      "List chat threads in this T3 Code environment with id, title, owning projectId, and archived state. Includes archived threads. Pass projectId to only list threads belonging to that project.",
    parameters: Schema.Struct({
      projectId: Schema.optional(ProjectId).annotate({
        description: "Only return threads that belong to this project id. Omit to list all.",
      }),
    }),
    success: Schema.Struct({ threads: Schema.Array(ChatThreadSummary) }),
    failure: ChatToolFailure,
    dependencies,
  }).annotate(Tool.Title, "List chat threads"),
);

export const ChatCreateProjectTool = managementTool(
  Tool.make("chat_create_project", {
    description:
      "Create a new project in this T3 Code environment and return its generated project id. Requires a title and an absolute workspace root path; optionally create the workspace root directory when it does not exist yet.",
    parameters: Schema.Struct({
      title: describedNonEmptyString("Human-readable project title shown in the sidebar."),
      workspaceRoot: describedNonEmptyString(
        "Absolute filesystem path to the project workspace root directory.",
      ),
      createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean).annotate({
        description:
          "Create the workspace root directory when it does not exist. Defaults to false.",
      }),
    }),
    success: Schema.Struct({ projectId: ProjectId }),
    failure: ChatToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Create chat project")
    .annotate(Tool.Idempotent, false),
);

export const ChatMoveThreadTool = managementTool(
  Tool.make("chat_move_thread", {
    description:
      "Move a chat thread to another project in this T3 Code environment. The target project must already exist; use chat_list_projects to discover project ids and chat_list_threads for thread ids.",
    parameters: Schema.Struct({
      threadId: describedNonEmptyString("Id of the thread to move."),
      projectId: describedNonEmptyString("Id of the destination project."),
    }),
    // A bare null structuredContent fails strict MCP client schema validation.
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    failure: ChatToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Move chat thread"),
);

export const ChatRenameThreadTool = managementTool(
  Tool.make("chat_rename_thread", {
    description:
      "Rename a chat thread in this T3 Code environment. Provide the thread id and the new non-empty title; use chat_list_threads to discover thread ids.",
    parameters: Schema.Struct({
      threadId: describedNonEmptyString("Id of the thread to rename."),
      title: describedNonEmptyString("New non-empty thread title."),
    }),
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    failure: ChatToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Rename chat thread"),
);

// Turn/session lifecycle state surfaced back to a session driving a child
// thread. Mirrors the projection's session status literals plus the implicit
// "idle" reported before any provider session has been spun up.
const ChatThreadRunState = OrchestrationSessionStatus;
// Latest-turn lifecycle, kept as a local literal set so the tool JSON schema
// documents the states without depending on an unexported contracts symbol.
const ChatLatestTurnState = Schema.Literals(["running", "interrupted", "completed", "error"]);

const ChatThreadModelInput = Schema.Struct({
  instanceId: Schema.optional(
    describedNonEmptyString(
      'Provider instance id to route the turn to (from a configured provider instance, e.g. "codex"). Provide this OR provider; instanceId wins when both are set.',
    ),
  ),
  provider: Schema.optional(
    describedNonEmptyString(
      'Provider driver kind (e.g. "codex", "claudeAgent", "cursor", "grok") when you do not know the instance id; resolves to that driver\'s default instance.',
    ),
  ),
  model: describedNonEmptyString(
    'Model slug to run (e.g. "gpt-5.4", "claude-opus-4-8"). Common aliases are accepted. Invalid slugs return an error listing the instance\'s available models.',
  ),
  reasoningEffort: Schema.optional(
    describedNonEmptyString(
      'Optional reasoning effort for models that support it (e.g. "low", "medium", "high", "max").',
    ),
  ),
});

export const ChatCreateThreadTool = managementTool(
  Tool.make("chat_create_thread", {
    description:
      "Create a new T3 Code chat thread on a real provider driver and immediately start the first turn with your prompt. Use this INSTEAD of shelling out (e.g. `codex exec` in a terminal) whenever you want to delegate work to another model/driver: the new thread appears in the sidebar/viewer as a normal thread, and any session (including this one) can monitor it with chat_get_thread_status or steer it with chat_send_message. Returns the new threadId and title. If projectId is omitted the thread is created in the same project as the calling thread.",
    parameters: Schema.Struct({
      prompt: describedNonEmptyString(
        "The first user message that starts the turn. Required — the thread begins running this immediately.",
      ),
      model: ChatThreadModelInput.annotate({
        description:
          "Which model/driver runs the thread: an instanceId (or provider driver kind) plus a model slug, optionally a reasoning effort. Validated against the configured provider instances.",
      }),
      projectId: Schema.optional(
        describedNonEmptyString(
          "Project to create the thread in. Omit to reuse the calling thread's project. Discover ids with chat_list_projects.",
        ),
      ),
      title: Schema.optional(
        describedNonEmptyString(
          "Optional thread title shown in the sidebar. Omit to derive one from the prompt.",
        ),
      ),
      runtimeMode: Schema.optional(RuntimeMode).annotate({
        description:
          'Permission mode for the thread: "approval-required", "auto-accept-edits", or "full-access". Defaults to the server default (full-access).',
      }),
    }),
    success: Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
    }),
    failure: ChatToolFailure,
    dependencies: spawnDependencies,
  })
    .annotate(Tool.Title, "Create chat thread")
    .annotate(Tool.Idempotent, false),
);

export const ChatSendMessageTool = managementTool(
  Tool.make("chat_send_message", {
    description:
      "Send a user message to an existing T3 Code thread. If the thread is idle this starts a new turn; if a turn is already running it steers that turn (mirrors the composer's send). Use this to follow up on or redirect a child thread you spawned with chat_create_thread. Returns the resulting session state; poll chat_get_thread_status to watch progress.",
    parameters: Schema.Struct({
      threadId: describedNonEmptyString("Id of the thread to send the message to."),
      message: describedNonEmptyString("The user message text to deliver to the thread."),
    }),
    success: Schema.Struct({
      accepted: Schema.Literal(true),
      threadState: ChatThreadRunState,
    }),
    failure: ChatToolFailure,
    dependencies: spawnDependencies,
  })
    .annotate(Tool.Title, "Send chat message")
    .annotate(Tool.Idempotent, false),
);

export const ChatGetThreadStatusTool = readonlyManagementTool(
  Tool.make("chat_get_thread_status", {
    description:
      "Read the current status of a T3 Code thread: its session state (idle/running/…), latest turn state, last error, and a bounded tail of the last assistant message. This is the monitor primitive — poll it to watch a child thread you spawned with chat_create_thread until it finishes or needs input.",
    parameters: Schema.Struct({
      threadId: describedNonEmptyString("Id of the thread to inspect."),
    }),
    success: Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      sessionStatus: ChatThreadRunState,
      running: Schema.Boolean,
      latestTurnState: Schema.NullOr(ChatLatestTurnState),
      lastError: Schema.NullOr(Schema.String),
      lastAssistantMessage: Schema.NullOr(Schema.String),
    }),
    failure: ChatToolFailure,
    dependencies: spawnDependencies,
  }).annotate(Tool.Title, "Get chat thread status"),
);

export const ChatToolkit = Toolkit.make(
  ChatListProjectsTool,
  ChatListThreadsTool,
  ChatCreateProjectTool,
  ChatMoveThreadTool,
  ChatRenameThreadTool,
  ChatCreateThreadTool,
  ChatSendMessageTool,
  ChatGetThreadStatusTool,
);
