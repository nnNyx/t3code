import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
  type ProjectGroupingSettings,
} from "./logicalProject";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  // True iff every non-primary member of this group lives in a
  // desktopLocal env (today: the WSL backend). The sidebar uses this
  // to differentiate "lives on this machine but in a sandbox" from
  // "lives on a real remote" so the project header can pick a
  // container icon instead of the generic cloud icon.
  allRemoteMembersAreDesktopLocal: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const project of input.projects) {
    mapping.set(
      derivePhysicalProjectKey(project),
      deriveLogicalProjectKeyFromSettings(project, input.settings),
    );
  }
  return mapping;
}

// The environment a group of sidebar projects lives in, used to render a
// quiet per-environment section header instead of a per-row cloud glyph.
//   - "local":         the primary environment (this machine / the connected host)
//   - "desktop-local":  a secondary backend that still runs on the user's own
//                       machine (today: the WSL backend) — a sandbox, not a real remote
//   - "remote":        a genuinely remote environment (server, SSH, relay, bearer)
export type SidebarEnvironmentGroupKind = "local" | "desktop-local" | "remote";

export interface SidebarProjectEnvironmentGroup {
  readonly environmentId: EnvironmentId;
  readonly kind: SidebarEnvironmentGroupKind;
  readonly label: string;
  readonly projects: readonly SidebarProjectSnapshot[];
}

// Pure grouping helper: partition already-sorted sidebar project snapshots into
// per-environment groups so the sidebar can render one quiet section header per
// environment (local machine vs each server) instead of a per-row cloud glyph.
//
// A project's group is its representative environment (the same environmentId
// buildSidebarProjectSnapshots picked — primary-preferred for cross-env grouped
// projects, so a repo that exists both locally and remotely lands in the local
// group). Group order: the primary/local group first, then the remaining groups
// in first-appearance order. Relative project order within each group is
// preserved exactly as given.
export function groupProjectsByEnvironment(input: {
  projects: readonly SidebarProjectSnapshot[];
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  // Returns true when an env id maps to a desktopLocal saved-env record
  // (today: the WSL backend). Defaults to "false for every env".
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectEnvironmentGroup[] {
  const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
  const membersByEnvironment = new Map<EnvironmentId, SidebarProjectSnapshot[]>();
  const environmentOrder: EnvironmentId[] = [];
  for (const project of input.projects) {
    const existing = membersByEnvironment.get(project.environmentId);
    if (existing) {
      existing.push(project);
    } else {
      membersByEnvironment.set(project.environmentId, [project]);
      environmentOrder.push(project.environmentId);
    }
  }

  // Local (primary) group first, then remaining environments in first-appearance
  // order — a deliberate ordering the owner can rely on (personal machine on top).
  const orderedEnvironmentIds = environmentOrder
    .filter((environmentId) => environmentId === input.primaryEnvironmentId)
    .concat(
      environmentOrder.filter((environmentId) => environmentId !== input.primaryEnvironmentId),
    );

  return orderedEnvironmentIds.map((environmentId) => {
    const kind: SidebarEnvironmentGroupKind =
      input.primaryEnvironmentId !== null && environmentId === input.primaryEnvironmentId
        ? "local"
        : isDesktopLocal(environmentId)
          ? "desktop-local"
          : "remote";
    const resolvedLabel = input.resolveEnvironmentLabel(environmentId);
    const fallbackLabel =
      kind === "local" ? "This machine" : kind === "desktop-local" ? "Local sandbox" : "Remote";
    return {
      environmentId,
      kind,
      label: resolvedLabel ?? fallbackLabel,
      projects: membersByEnvironment.get(environmentId) ?? [],
    };
  });
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  // Returns true when an env id maps to a desktopLocal saved-env
  // record (today: the WSL backend). Defaults to "false for every
  // env" so callers that don't care about the distinction get the
  // legacy behavior.
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectSnapshot[] {
  const groupedMembers = new Map<string, SidebarProjectGroupMember[]>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    const member: SidebarProjectGroupMember = {
      ...project,
      physicalProjectKey: derivePhysicalProjectKey(project),
      environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
    };
    const existing = groupedMembers.get(logicalKey);
    if (existing) {
      existing.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  const result: SidebarProjectSnapshot[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    if (seen.has(logicalKey)) {
      continue;
    }
    seen.add(logicalKey);

    const members = groupedMembers.get(logicalKey) ?? [];
    const representative =
      (input.primaryEnvironmentId
        ? members.find((member) => member.environmentId === input.primaryEnvironmentId)
        : null) ?? members[0];
    if (!representative) {
      continue;
    }

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));

    result.push({
      ...representative,
      projectKey: logicalKey,
      displayName:
        members.length > 1
          ? deriveProjectGroupLabel({
              representative,
              members,
            })
          : representative.title,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal,
      memberProjects: members,
      memberProjectRefs: members.map((member) => scopeProjectRef(member.environmentId, member.id)),
      remoteEnvironmentLabels,
    });
  }

  return result;
}
