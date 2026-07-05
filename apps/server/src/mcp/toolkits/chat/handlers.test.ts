import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ChatToolkitHandlersLive } from "./handlers.ts";
import { ChatToolkit } from "./tools.ts";

const now = "2026-01-01T00:00:00.000Z";
const environmentId = EnvironmentId.make("environment-chat-test");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const threadId = ThreadId.make("thread-1");

const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  threadId,
  providerSessionId: "provider-session-chat-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const projectShell = (id: ProjectId, title: string) => ({
  id,
  title,
  workspaceRoot: `/tmp/${title}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});

const threadShell = (input: {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archivedAt?: string;
}): OrchestrationThreadShell => ({
  id: input.id,
  projectId: input.projectId,
  title: input.title,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: input.archivedAt ?? null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const emptyShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: now,
};

const projectionQueryStub = (
  overrides: Partial<ProjectionSnapshotQuery["Service"]>,
): ProjectionSnapshotQuery["Service"] => ({
  getCommandReadModel: () => Effect.die("unused"),
  getSnapshot: () => Effect.die("unused"),
  getShellSnapshot: () => Effect.succeed(emptyShellSnapshot),
  getArchivedShellSnapshot: () => Effect.succeed(emptyShellSnapshot),
  getSnapshotSequence: () => Effect.die("unused"),
  getCounts: () => Effect.die("unused"),
  getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
  getProjectShellById: () => Effect.succeed(Option.none()),
  getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
  getThreadCheckpointContext: () => Effect.succeed(Option.none()),
  getFullThreadDiffContext: () => Effect.succeed(Option.none()),
  getThreadShellById: () => Effect.succeed(Option.none()),
  getThreadDetailById: () => Effect.succeed(Option.none()),
  ...overrides,
});

const workspacePathsStub = WorkspacePaths.WorkspacePaths.of({
  // Prefix marks that dispatches flowed through the shared normalizer.
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(`/normalized${workspaceRoot}`),
  resolveRelativePathWithinRoot: () => Effect.die("unused"),
});

const runTool = <Name extends keyof typeof ChatToolkit.tools & string>(input: {
  readonly name: Name;
  readonly params: unknown;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
  readonly query?: Partial<ProjectionSnapshotQuery["Service"]>;
  readonly dispatched?: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
}) =>
  Effect.gen(function* () {
    const dispatched =
      input.dispatched ?? (yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]));
    const built = yield* ChatToolkit.pipe(Effect.provide(ChatToolkitHandlersLive));
    return yield* built.handle(input.name, input.params as never).pipe(
      Stream.unwrap,
      Stream.run(Sink.last()),
      Effect.flatMap(Effect.fromOption),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(input.capabilities ?? ["chat"]),
      ),
      Effect.provideService(OrchestrationEngineService, {
        readEvents: () => Stream.die("unused"),
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.die("unused"),
      }),
      Effect.provideService(ProjectionSnapshotQuery, projectionQueryStub(input.query ?? {})),
      Effect.provideService(ServerConfig, { cwd: "/tmp" } as never),
      Effect.provideService(WorkspacePaths.WorkspacePaths, workspacePathsStub),
      Effect.provide(NodeServices.layer),
    );
  });

it.effect("chat_list_projects returns project summaries", () =>
  Effect.gen(function* () {
    const { result } = yield* runTool({
      name: "chat_list_projects",
      params: {},
      query: {
        getShellSnapshot: () =>
          Effect.succeed({
            ...emptyShellSnapshot,
            projects: [projectShell(projectA, "alpha"), projectShell(projectB, "beta")],
          }),
      },
    });
    expect(result).toEqual({
      projects: [
        { id: projectA, title: "alpha", workspaceRoot: "/tmp/alpha" },
        { id: projectB, title: "beta", workspaceRoot: "/tmp/beta" },
      ],
    });
  }),
);

it.effect("chat_list_threads merges archived threads and filters by project", () =>
  Effect.gen(function* () {
    const query = {
      getShellSnapshot: () =>
        Effect.succeed({
          ...emptyShellSnapshot,
          threads: [
            threadShell({ id: threadId, projectId: projectA, title: "active" }),
            threadShell({ id: ThreadId.make("thread-2"), projectId: projectB, title: "other" }),
          ],
        }),
      getArchivedShellSnapshot: () =>
        Effect.succeed({
          ...emptyShellSnapshot,
          threads: [
            threadShell({
              id: ThreadId.make("thread-3"),
              projectId: projectA,
              title: "archived",
              archivedAt: now,
            }),
          ],
        }),
    };

    const all = yield* runTool({ name: "chat_list_threads", params: {}, query });
    expect(all.result).toEqual({
      threads: [
        { id: threadId, title: "active", projectId: projectA, archived: false },
        { id: ThreadId.make("thread-2"), title: "other", projectId: projectB, archived: false },
        { id: ThreadId.make("thread-3"), title: "archived", projectId: projectA, archived: true },
      ],
    });

    const filtered = yield* runTool({
      name: "chat_list_threads",
      params: { projectId: projectB },
      query,
    });
    expect(filtered.result).toEqual({
      threads: [
        { id: ThreadId.make("thread-2"), title: "other", projectId: projectB, archived: false },
      ],
    });
  }),
);

it.effect("chat_create_project dispatches project.create with a normalized workspace root", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const { result } = yield* runTool({
      name: "chat_create_project",
      params: {
        title: "New Project",
        workspaceRoot: "/tmp/new",
        createWorkspaceRootIfMissing: true,
      },
      dispatched,
    });
    const commands = yield* Ref.get(dispatched);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "project.create",
      title: "New Project",
      workspaceRoot: "/normalized/tmp/new",
      createWorkspaceRootIfMissing: true,
    });
    expect(result).toEqual({
      projectId: (commands[0] as { readonly projectId: ProjectId }).projectId,
    });
  }),
);

it.effect("chat_move_thread dispatches thread.meta.update with the target project", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const { result } = yield* runTool({
      name: "chat_move_thread",
      params: { threadId, projectId: projectB },
      dispatched,
    });
    expect(result).toEqual({ ok: true });
    const commands = yield* Ref.get(dispatched);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.meta.update",
      threadId,
      projectId: projectB,
    });
  }),
);

it.effect("chat_rename_thread dispatches thread.meta.update with the new title", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    yield* runTool({
      name: "chat_rename_thread",
      params: { threadId, title: "Renamed" },
      dispatched,
    });
    const commands = yield* Ref.get(dispatched);
    expect(commands[0]).toMatchObject({
      type: "thread.meta.update",
      threadId,
      title: "Renamed",
    });
  }),
);

it.effect("rejects invocations without the chat capability", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      runTool({ name: "chat_list_projects", params: {}, capabilities: ["preview"] }),
    );
    expect(error).toMatchObject({ _tag: "PreviewAutomationUnavailableError", capability: "chat" });
  }),
);
