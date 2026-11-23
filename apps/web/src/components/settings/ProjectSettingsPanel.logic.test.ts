import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, SourceControlProviderKind, ThreadId } from "@t3tools/contracts";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import {
  projectGroupTitleNeedsUpdate,
  scopeProjectSettingsGroup,
} from "./ProjectSettingsPanel.logic";

const localEnvironmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");
const customIcon = { kind: "lucide", name: "cloud", color: "red" } as const;

function makeProject(environmentId: EnvironmentId, overrides: Partial<Project> = {}): Project {
  return {
    environmentId,
    id: ProjectId.make(`${environmentId}-project`),
    title: "repo",
    workspaceRoot: `/${environmentId}/repo`,
    repositoryIdentity: {
      canonicalKey: "github.com/owner/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/owner/repo.git",
      },
      provider: SourceControlProviderKind.make("github"),
      owner: "owner",
      name: "repo",
      displayName: "owner/repo",
    },
    defaultModelSelection: null,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function projectGroup(projects: Project[]) {
  return buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: localEnvironmentId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!;
}

describe("scopeProjectSettingsGroup", () => {
  it("keeps the sidebar preview identity and edit targets when the remote checkout was registered first", () => {
    const local = makeProject(localEnvironmentId, {
      title: "Local repo",
      faviconPath: "local.svg",
      projectIcon: customIcon,
    });
    const remote = makeProject(remoteEnvironmentId, {
      title: "Remote repo",
      faviconPath: "remote.svg",
    });
    const group = projectGroup([remote, local]);
    const scoped = scopeProjectSettingsGroup(group, group.memberProjects);

    expect(group).toMatchObject(local);
    expect(scoped).toMatchObject(local);
    expect(scoped.memberProjects).toBe(group.memberProjects);
    expect(scoped.memberProjects).toMatchObject([remote, local]);
  });

  it.each([
    [remoteEnvironmentId, "local-project"],
    [localEnvironmentId, "other-checkout"],
  ])("uses the complete selected checkout identity for %s/%s", (environmentId, id) => {
    const local = makeProject(localEnvironmentId, { projectIcon: customIcon });
    const selected = makeProject(environmentId, {
      id: ProjectId.make(id),
      title: "Selected checkout",
      workspaceRoot: "/selected/repo",
      faviconPath: "selected.svg",
      projectIcon: null,
    });
    const group = projectGroup([local, selected]);
    const members = group.memberProjects.filter(
      (member) => member.environmentId === selected.environmentId && member.id === selected.id,
    );
    const scoped = scopeProjectSettingsGroup(group, members);

    expect(scoped).toMatchObject(selected);
    expect(scoped.memberProjects).toBe(members);
    expect(scoped.memberProjects).toMatchObject([selected]);
    expect(group).toMatchObject(local);
  });
});

describe("project removal confirmation", () => {
  const local = {
    id: ProjectId.make("shared-id"),
    environmentId: EnvironmentId.make("local"),
    title: "Repo",
    workspaceRoot: "/work/repo",
    environmentLabel: "Local",
  };
  const remote = {
    ...local,
    environmentId: EnvironmentId.make("remote"),
    environmentLabel: "Remote",
  };

  const parentId = ThreadId.make("parent");
  const listed = { rootThreadId: parentId, parentThreadId: null, relationshipToParent: null };
  const child = { rootThreadId: parentId, parentThreadId: parentId };

  const nested = {
    ...local,
    id: ProjectId.make("nested"),
    workspaceRoot: "/work/repo/my-project",
  };
  const groupMembers = [local, remote, nested];
  const threads = [
    { environmentId: local.environmentId, projectId: local.id, lineage: listed },
    {
      environmentId: local.environmentId,
      projectId: local.id,
      lineage: { ...child, relationshipToParent: "subagent" as const },
    },
    {
      environmentId: local.environmentId,
      projectId: local.id,
      lineage: { ...child, relationshipToParent: "fork" as const, sideChat: true },
    },
    { environmentId: remote.environmentId, projectId: remote.id, lineage: listed },
  ];

  it("limits a checkout's thread count to its listed threads in that environment and project", () => {
    const plan = planProjectRemoval({
      members: [local],
      groupMembers,
      projects: groupMembers,
      threads,
      unloadedThreadCount: (member) => (member.id === local.id ? 4 : 0),
    });
    expect(plan.entries.map((entry) => entry.member)).toEqual([local]);
    expect(plan.entries[0]?.threads).toHaveLength(3);
    expect(plan.entries[0]?.threadCount).toBe(5);
    expect(plan.entriesToRemove().map((entry) => entry.member)).toEqual([local]);
    expect(plan.entriesToRemove(true).map((entry) => entry.member)).toEqual([local, nested]);
    expect(plan.nestedEntries.map((entry) => entry.member)).toEqual([nested]);
  });

  it("keeps a checkout removal scoped to the selected folder and environment", () => {
    for (const member of [remote, nested]) {
      const plan = planProjectRemoval({
        members: [member],
        groupMembers,
        projects: groupMembers,
        threads,
      });
      expect(plan.entries.map((entry) => entry.member)).toEqual([member]);
      expect(plan.nestedEntries).toEqual([]);
    }
  });

  it("lists each checkout and offers nested projects separately, including those grouped elsewhere", () => {
    const identity = makeProject(localEnvironmentId).repositoryIdentity!;
    const members = groupMembers.map((member) => ({
      ...member,
      repositoryIdentity: { ...identity, rootPath: "/work/repo" },
    }));
    const other = { ...nested, id: ProjectId.make("other"), workspaceRoot: "/work/repo/other" };
    const sibling = { ...other, id: ProjectId.make("sibling"), workspaceRoot: "/work/repo-copy" };
    const plan = planProjectRemoval({
      members,
      groupMembers: members,
      projects: [...members, other, sibling],
      threads,
    });
    expect(plan.differentRepositoryFolders).toBe(true);
    const aliased = members.map((member) => ({
      ...member,
      workspaceRoot: "/alias" + member.workspaceRoot,
    }));
    expect(
      planProjectRemoval({ members: aliased, groupMembers: aliased, projects: aliased, threads })
        .differentRepositoryFolders,
    ).toBe(true);
    expect(plan.entries.map((entry) => [entry.member, entry.threadCount])).toEqual([
      [members[0], 1],
      [members[1], 1],
    ]);
    expect(plan.nestedEntries.map((entry) => entry.member)).toEqual([members[2], other]);
    expect(
      planProjectRemoval({
        members: members.slice(0, 2),
        groupMembers: members.slice(0, 2),
        projects: members,
        threads,
      }).differentRepositoryFolders,
    ).toBe(false);
  });
});

describe("projectGroupTitleNeedsUpdate", () => {
  const folderTitle = { title: "repo" };
  const renamed = { title: "repo", hasCustomTitle: true };

  // regression: #15049 renaming to the default folder title was never saved
  it("saves a title that matches the folder default so the rename is recorded", () => {
    expect(projectGroupTitleNeedsUpdate([folderTitle, folderTitle], "repo", true)).toBe(true);
  });

  it("skips untouched fields and renames every member already carries", () => {
    expect(projectGroupTitleNeedsUpdate([folderTitle, { title: "other" }], "repo", false)).toBe(
      false,
    );
    expect(projectGroupTitleNeedsUpdate([renamed, renamed], "repo", true)).toBe(false);
  });
});
