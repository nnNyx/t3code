import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
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
import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
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
  lastActivitySummary: null,
  lastActivityAt: null,
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
  getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
  ...overrides,
});

const workspacePathsStub = WorkspacePaths.WorkspacePaths.of({
  // Prefix marks that dispatches flowed through the shared normalizer.
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(`/normalized${workspaceRoot}`),
  resolveRelativePathWithinRoot: () => Effect.die("unused"),
});

const codexInstanceId = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");

const serverProviderStub = (models: ReadonlyArray<string>): ServerProvider =>
  ({
    instanceId: codexInstanceId,
    driver: codexDriver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: now,
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  }) as ServerProvider;

const providerInstanceStub = (models: ReadonlyArray<string>): ProviderInstance =>
  ({
    instanceId: codexInstanceId,
    driverKind: codexDriver,
    continuationIdentity: { driverKind: codexDriver, continuationKey: "codex:instance:codex" },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed(serverProviderStub(models)),
      refresh: Effect.die("unused"),
      streamChanges: Stream.empty,
    },
    adapter: {},
    textGeneration: {},
  }) as unknown as ProviderInstance;

const providerInstanceRegistryStub = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry["Service"] =>
  ({
    getInstance: (instanceId: ProviderInstanceId) =>
      Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.die("unused"),
  }) as unknown as ProviderInstanceRegistry["Service"];

const defaultInstances = [providerInstanceStub(["gpt-5.4", "gpt-5.3-codex"])];

const threadDetail = (input: {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly session?: OrchestrationThread["session"];
  readonly latestTurn?: OrchestrationThread["latestTurn"];
  readonly messages?: OrchestrationThread["messages"];
}): OrchestrationThread =>
  ({
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: input.latestTurn ?? null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: input.messages ?? [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: input.session ?? null,
  }) as OrchestrationThread;

const runTool = <Name extends keyof typeof ChatToolkit.tools & string>(input: {
  readonly name: Name;
  readonly params: unknown;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
  readonly query?: Partial<ProjectionSnapshotQuery["Service"]>;
  readonly dispatched?: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly instances?: ReadonlyArray<ProviderInstance>;
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
      Effect.provideService(
        ProviderInstanceRegistry,
        providerInstanceRegistryStub(input.instances ?? defaultInstances),
      ),
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

it.effect("chat_create_thread creates the thread and starts the first turn", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const { result } = yield* runTool({
      name: "chat_create_thread",
      params: {
        prompt: "Investigate the failing test and report back.",
        model: { instanceId: "codex", model: "gpt-5.4" },
        projectId: projectA,
      },
      dispatched,
    });

    const commands = yield* Ref.get(dispatched);
    expect(commands.map((command) => command.type)).toEqual(["thread.create", "thread.turn.start"]);
    const create = commands[0] as Extract<OrchestrationCommand, { type: "thread.create" }>;
    const turnStart = commands[1] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
    expect(create).toMatchObject({
      projectId: projectA,
      title: "Investigate the failing test and report back.",
      modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
    });
    // Both commands target the same freshly-minted thread id.
    expect(turnStart.threadId).toBe(create.threadId);
    expect(turnStart.message).toMatchObject({
      role: "user",
      text: "Investigate the failing test and report back.",
    });
    expect(result).toEqual({
      threadId: create.threadId,
      title: "Investigate the failing test and report back.",
    });
  }),
);

it.effect("chat_create_thread defaults the project to the calling thread's project", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    yield* runTool({
      name: "chat_create_thread",
      params: {
        prompt: "hello",
        model: { provider: "codex", model: "gpt-5.4" },
      },
      dispatched,
      query: {
        getThreadShellById: (id) =>
          Effect.succeed(
            id === threadId
              ? Option.some(threadShell({ id: threadId, projectId: projectB, title: "parent" }))
              : Option.none(),
          ),
      },
    });
    const commands = yield* Ref.get(dispatched);
    expect(commands[0]).toMatchObject({ type: "thread.create", projectId: projectB });
  }),
);

it.effect("chat_create_thread rejects an unknown model with the available slugs", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      runTool({
        name: "chat_create_thread",
        params: {
          prompt: "hello",
          model: { instanceId: "codex", model: "gpt-9-imaginary" },
          projectId: projectA,
        },
      }),
    );
    expect(error).toMatchObject({ _tag: "ChatToolError" });
    expect((error as unknown as { readonly detail: string }).detail).toContain("gpt-5.4");
  }),
);

it.effect("chat_create_thread rejects an unknown provider instance", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      runTool({
        name: "chat_create_thread",
        params: {
          prompt: "hello",
          model: { instanceId: "nope", model: "gpt-5.4" },
          projectId: projectA,
        },
      }),
    );
    expect(error).toMatchObject({ _tag: "ChatToolError" });
    expect((error as unknown as { readonly detail: string }).detail).toContain("codex");
  }),
);

it.effect("chat_send_message starts a turn on an idle thread and reports state", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const { result } = yield* runTool({
      name: "chat_send_message",
      params: { threadId, message: "next step" },
      dispatched,
      query: {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some(threadShell({ id: threadId, projectId: projectA, title: "child" })),
          ),
      },
    });
    expect(result).toEqual({ accepted: true, threadState: "idle" });
    const commands = yield* Ref.get(dispatched);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.turn.start",
      threadId,
      message: { role: "user", text: "next step" },
    });
  }),
);

it.effect("chat_send_message steers a running thread and reports running state", () =>
  Effect.gen(function* () {
    const runningShell = {
      ...threadShell({ id: threadId, projectId: projectA, title: "child" }),
      session: {
        threadId,
        status: "running" as const,
        providerName: null,
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    };
    const { result } = yield* runTool({
      name: "chat_send_message",
      params: { threadId, message: "actually, do X instead" },
      query: { getThreadShellById: () => Effect.succeed(Option.some(runningShell)) },
    });
    expect(result).toEqual({ accepted: true, threadState: "running" });
  }),
);

it.effect("chat_send_message rejects an unknown thread", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      runTool({ name: "chat_send_message", params: { threadId, message: "hi" } }),
    );
    expect(error).toMatchObject({ _tag: "ChatToolError" });
  }),
);

it.effect("chat_get_thread_status returns session, turn, and the last assistant reply", () =>
  Effect.gen(function* () {
    const { result } = yield* runTool({
      name: "chat_get_thread_status",
      params: { threadId },
      query: {
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some(
              threadDetail({
                id: threadId,
                projectId: projectA,
                title: "child",
                session: {
                  threadId,
                  status: "running",
                  providerName: null,
                  runtimeMode: "full-access",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: now,
                },
                latestTurn: {
                  turnId: "turn-1" as never,
                  state: "running",
                  requestedAt: now,
                  startedAt: now,
                  completedAt: null,
                  assistantMessageId: null,
                },
                messages: [
                  {
                    id: "m1" as never,
                    role: "user",
                    text: "go",
                    turnId: null,
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                  {
                    id: "m2" as never,
                    role: "assistant",
                    text: "working on it",
                    turnId: null,
                    streaming: true,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              }),
            ),
          ),
      },
    });
    expect(result).toEqual({
      threadId,
      title: "child",
      sessionStatus: "running",
      running: true,
      latestTurnState: "running",
      lastError: null,
      lastAssistantMessage: "working on it",
    });
  }),
);

it.effect("chat_get_thread_status reports idle when no session exists", () =>
  Effect.gen(function* () {
    const { result } = yield* runTool({
      name: "chat_get_thread_status",
      params: { threadId },
      query: {
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some(threadDetail({ id: threadId, projectId: projectA, title: "child" })),
          ),
      },
    });
    expect(result).toMatchObject({
      sessionStatus: "idle",
      running: false,
      latestTurnState: null,
      lastAssistantMessage: null,
    });
  }),
);
