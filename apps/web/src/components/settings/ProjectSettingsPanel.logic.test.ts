import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, SourceControlProviderKind, ThreadId } from "@t3tools/contracts";
import {
  planProjectRemoval,
  reviewedFoldersMatch,
  removalEnvironmentLabel,
} from "@t3tools/client-runtime/state/projects";

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
    {
      id: ThreadId.make("listed"),
      environmentId: local.environmentId,
      projectId: local.id,
      lineage: listed,
    },
    {
      id: parentId,
      environmentId: local.environmentId,
      projectId: local.id,
      lineage: { ...child, relationshipToParent: "subagent" as const },
    },
    {
      id: parentId,
      environmentId: local.environmentId,
      projectId: local.id,
      lineage: { ...child, relationshipToParent: "fork" as const, sideChat: true },
    },
    {
      id: ThreadId.make("remote"),
      environmentId: remote.environmentId,
      projectId: remote.id,
      lineage: listed,
    },
  ];

  function previewRows(
    projects: readonly (typeof local)[],
    environments = projects.map((project) => project.environmentId),
  ) {
    return projects
      .filter((project) => environments.includes(project.environmentId))
      .map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
        workspaceRoot: project.workspaceRoot,
        resolvedWorkspaceRoot: project.workspaceRoot,
        threadCount: 1,
      }));
  }

  it("uses each checkout's own thread total and retains its loaded threads for cleanup", () => {
    const preview = previewRows(groupMembers, [local.environmentId]);
    preview[0]!.threadCount = 5;
    const plan = planProjectRemoval({
      members: [local],
      groupMembers,
      projects: groupMembers,
      threads,
      preview,
    });
    expect(plan.entries.map((entry) => entry.member)).toEqual([local]);
    expect(plan.entries[0]?.threads).toHaveLength(3);
    expect(plan.entries[0]?.threadCount).toBe(5);
    expect(plan.entriesToRemove().map((entry) => entry.member)).toEqual([local]);
    expect(plan.entriesToRemove(true).map((entry) => entry.member)).toEqual([local, nested]);
    expect(plan.nestedEntries.map((entry) => entry.member)).toEqual([nested]);
    expect(plan.nestedEntries[0]?.threadCount).toBe(1);
  });

  it("keeps a checkout removal scoped to the selected folder and environment", () => {
    for (const member of [remote, nested]) {
      const plan = planProjectRemoval({
        members: [member],
        preview: previewRows(groupMembers, [member.environmentId]),
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
      preview: previewRows([...members, other, sibling]),
      threads,
    });
    expect(plan.differentRepositoryFolders).toBe(true);
    const aliased = members.map((member) => ({
      ...member,
      workspaceRoot: "/alias" + member.workspaceRoot,
    }));
    expect(
      planProjectRemoval({
        members: aliased,
        groupMembers: aliased,
        projects: aliased,
        preview: previewRows(aliased),
        threads,
      }).differentRepositoryFolders,
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
        preview: previewRows(members),
        projects: members,
        threads,
      }).differentRepositoryFolders,
    ).toBe(false);
  });
  it("protects nested registrations reached through an alias and includes every ID at a selected checkout", () => {
    const identity = makeProject(localEnvironmentId).repositoryIdentity!;
    const root = {
      ...local,
      workspaceRoot: "/alias/repo",
      repositoryIdentity: {
        ...identity,
        rootPath: "/real/repo",
      },
    };
    const duplicate = { ...root, id: ProjectId.make("legacy"), workspaceRoot: "/alias/repo/" };
    const child = {
      ...nested,
      workspaceRoot: "/real/repo/apps/ui",
      repositoryIdentity: { ...identity, rootPath: "/real/repo" },
    };
    const plan = planProjectRemoval({
      members: [root, child],
      groupMembers: [root, child],
      projects: [duplicate, root, child],
      preview: previewRows([duplicate, root, child]).map((row) => ({
        ...row,
        resolvedWorkspaceRoot: row.workspaceRoot.replace("/alias/", "/real/"),
      })),
      threads: [],
    });
    expect(plan.entriesToRemove().map(({ member }) => member.id)).toEqual([duplicate.id, root.id]);
    expect(plan.nestedEntries.map(({ member }) => member.id)).toEqual([child.id]);
  });

  it("resolves nesting for plain folders and aliases, and detects a retargeted link", () => {
    const root = { ...local, workspaceRoot: "/repo/X" };
    const link = { ...nested, workspaceRoot: "/repo/link" };
    const outside = { ...nested, id: ProjectId.make("outside"), workspaceRoot: "/repo/X/link-out" };
    const projects = [root, link, outside];
    const preview = previewRows(projects).map((row, index) => ({
      ...row,
      resolvedWorkspaceRoot: ["/real/X", "/real/X/my-project", "/elsewhere"][index]!,
    }));
    const plan = planProjectRemoval({
      members: [root, link],
      groupMembers: projects,
      projects,
      threads,
      preview,
    });
    expect(plan.entriesToRemove().map((entry) => entry.member.id)).toEqual([root.id]);
    expect(plan.nestedEntries.map((entry) => entry.member.id)).toEqual([link.id]);
    expect(reviewedFoldersMatch(plan.entriesToRemove(true), preview)).toBe(true);
    expect(
      reviewedFoldersMatch(
        plan.entriesToRemove(true),
        preview.map((row) =>
          row.projectId === link.id ? { ...row, resolvedWorkspaceRoot: "/different" } : row,
        ),
      ),
    ).toBe(false);
  });

  it("identifies both machines when their names match", () => {
    const environments = [localEnvironmentId, remoteEnvironmentId].map((environmentId) => ({
      environmentId,
      label: "Dev",
    }));
    expect(removalEnvironmentLabel(localEnvironmentId, environments)).toBe("Dev (local)");
    expect(removalEnvironmentLabel(remoteEnvironmentId, environments)).toBe("Dev (remote)");
  });

  it("requires individual review for missing folders whose registered casing differs", () => {
    const root = { ...local, workspaceRoot: "/work/Repo" };
    const projects = [root, nested];
    const options = {
      groupMembers: projects,
      projects,
      preview: previewRows(projects).map((row) => ({ ...row, resolvedWorkspaceRoot: null })),
      threads,
    };
    const group = planProjectRemoval({ ...options, members: projects });
    expect(group.ambiguousFolders).toBe(true);
    expect(group.entriesToRemove()).toEqual([]);
    const individual = planProjectRemoval({ ...options, members: [root] });
    expect(individual.ambiguousFolders).toBe(false);
    expect(individual.entriesToRemove().map(({ member }) => member.id)).toEqual([root.id]);
  });

  it("recognizes the same repository folder on Windows and POSIX", () => {
    const identity = makeProject(localEnvironmentId).repositoryIdentity!;
    const members = [
      {
        ...local,
        workspaceRoot: "C:/repo/Sources",
        repositoryIdentity: { ...identity, rootPath: "C:/repo" },
      },
      {
        ...remote,
        workspaceRoot: "/work/repo/Sources",
        repositoryIdentity: { ...identity, rootPath: "/work/repo" },
      },
    ];
    expect(
      planProjectRemoval({
        members,
        groupMembers: members,
        projects: members,
        preview: previewRows(members),
        threads: [],
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
