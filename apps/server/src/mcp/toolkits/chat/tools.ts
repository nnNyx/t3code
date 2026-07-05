import { PreviewAutomationUnavailableError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
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

export const ChatToolkit = Toolkit.make(
  ChatListProjectsTool,
  ChatListThreadsTool,
  ChatCreateProjectTool,
  ChatMoveThreadTool,
  ChatRenameThreadTool,
);
