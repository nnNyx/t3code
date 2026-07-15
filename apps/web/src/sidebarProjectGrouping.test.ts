import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots, groupProjectsByEnvironment } from "./sidebarProjectGrouping";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");
const secondRemoteEnvironmentId = EnvironmentId.make("env-remote-2");
const desktopLocalEnvironmentId = EnvironmentId.make("env-wsl");

const grouping = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

const environmentLabels: Record<string, string> = {
  [primaryEnvironmentId]: "ntrivunovic",
  [remoteEnvironmentId]: "nixbox",
  [secondRemoteEnvironmentId]: "rapture",
  [desktopLocalEnvironmentId]: "WSL",
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function snapshotsFor(projects: readonly Project[]) {
  return buildSidebarProjectSnapshots({
    projects,
    settings: grouping,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabels[environmentId] ?? null,
    isDesktopLocalEnvironment: (environmentId) => environmentId === desktopLocalEnvironmentId,
  });
}

function group(projects: readonly Project[]) {
  return groupProjectsByEnvironment({
    projects: snapshotsFor(projects),
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabels[environmentId] ?? null,
    isDesktopLocalEnvironment: (environmentId) => environmentId === desktopLocalEnvironmentId,
  });
}

describe("groupProjectsByEnvironment", () => {
  it("splits local and remote projects into separate labeled groups", () => {
    const groups = group([
      makeProject({ id: ProjectId.make("local-1"), title: "personal" }),
      makeProject({
        id: ProjectId.make("remote-1"),
        environmentId: remoteEnvironmentId,
        title: "vale",
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      environmentId: primaryEnvironmentId,
      kind: "local",
      label: "ntrivunovic",
    });
    expect(groups[0]?.projects.map((p) => p.projectKey)).toHaveLength(1);
    expect(groups[1]).toMatchObject({
      environmentId: remoteEnvironmentId,
      kind: "remote",
      label: "nixbox",
    });
  });

  it("places the primary/local group first even when a remote project sorts ahead", () => {
    const groups = group([
      makeProject({
        id: ProjectId.make("remote-1"),
        environmentId: remoteEnvironmentId,
        title: "vale",
      }),
      makeProject({ id: ProjectId.make("local-1"), title: "personal" }),
    ]);

    expect(groups.map((g) => g.kind)).toEqual(["local", "remote"]);
  });

  it("keeps remaining remote groups in first-appearance order", () => {
    const groups = group([
      makeProject({ id: ProjectId.make("local-1"), title: "personal" }),
      makeProject({
        id: ProjectId.make("remote-2"),
        environmentId: secondRemoteEnvironmentId,
        title: "rapture-proj",
      }),
      makeProject({
        id: ProjectId.make("remote-1"),
        environmentId: remoteEnvironmentId,
        title: "vale",
      }),
    ]);

    expect(groups.map((g) => g.environmentId)).toEqual([
      primaryEnvironmentId,
      secondRemoteEnvironmentId,
      remoteEnvironmentId,
    ]);
  });

  it("preserves relative project order within a group", () => {
    const groups = group([
      makeProject({
        id: ProjectId.make("remote-a"),
        environmentId: remoteEnvironmentId,
        title: "a",
        workspaceRoot: "/tmp/a",
      }),
      makeProject({
        id: ProjectId.make("remote-b"),
        environmentId: remoteEnvironmentId,
        title: "b",
        workspaceRoot: "/tmp/b",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.projects.map((p) => p.title)).toEqual(["a", "b"]);
  });

  it("classifies a desktop-local backend as its own sandbox group", () => {
    const groups = group([
      makeProject({ id: ProjectId.make("local-1"), title: "personal" }),
      makeProject({
        id: ProjectId.make("wsl-1"),
        environmentId: desktopLocalEnvironmentId,
        title: "sandbox",
        workspaceRoot: "/tmp/wsl",
      }),
    ]);

    expect(groups.map((g) => g.kind)).toEqual(["local", "desktop-local"]);
  });

  it("falls back to sensible labels when the environment name is unknown", () => {
    const groups = groupProjectsByEnvironment({
      projects: buildSidebarProjectSnapshots({
        projects: [
          makeProject({ id: ProjectId.make("local-1") }),
          makeProject({
            id: ProjectId.make("remote-1"),
            environmentId: remoteEnvironmentId,
          }),
        ],
        settings: grouping,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }),
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    expect(groups.map((g) => g.label)).toEqual(["This machine", "Remote"]);
  });
});
