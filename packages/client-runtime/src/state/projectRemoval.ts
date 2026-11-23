import { isListedThreadLineage } from "@t3tools/contracts";
import { normalizeProjectPathForComparison, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { msg } from "gt-i18n";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import {
  derivePhysicalProjectKeyFromPath,
  deriveRepositoryRelativeProjectPath,
} from "./projectGrouping.ts";

type RemovalMember = Pick<
  EnvironmentProject,
  "id" | "environmentId" | "workspaceRoot" | "repositoryIdentity"
>;
type RemovalThread = Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "lineage">;

export const projectRemovalNotice = msg(
  "Removing these entries permanently deletes their threads, including archived threads. Files on disk and provider sessions are kept.",
);
export const differentRepositoryFoldersNotice = msg(
  "This group contains different folders of the same repository.",
);

export function removeEntriesLabel(count: number) {
  return msg("{count, plural, one {Remove # entry} other {Remove # entries}}", { count });
}

export function removalEntryDetail(environment: string, count: number) {
  return msg("{environment} · {count, plural, one {# thread} other {# threads}}", {
    environment,
    count,
  });
}

export function planProjectRemoval<
  Member extends RemovalMember,
  Thread extends RemovalThread,
>(options: {
  readonly members: ReadonlyArray<Member>;
  readonly groupMembers: ReadonlyArray<Member>;
  readonly projects: ReadonlyArray<Member>;
  readonly threads: ReadonlyArray<Thread>;
  readonly unloadedThreadCount?: (member: Member, threads: ReadonlyArray<Thread>) => number;
}) {
  const { members, projects, groupMembers } = options;
  const isNested = (candidate: Member) =>
    members.some((parent) => {
      if (parent.environmentId !== candidate.environmentId) return false;
      const relative = workspaceRelativeFilePath(candidate.workspaceRoot, parent.workspaceRoot);
      return relative !== null && relative !== ".";
    });

  const roots = members.filter((member) => !isNested(member));
  const nested = projects.filter(isNested);
  const byProject = new Map<string, Thread[]>(
    [...roots, ...nested].map((member) => [
      scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
      [],
    ]),
  );
  for (const thread of options.threads) {
    byProject
      .get(scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)))
      ?.push(thread);
  }
  const entry = (member: Member) => {
    const threads = byProject.get(
      scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
    )!;
    const threadCount =
      threads.filter((thread) => isListedThreadLineage(thread.lineage)).length +
      (options.unloadedThreadCount?.(member, threads) ?? 0);
    return { member, threads, threadCount };
  };
  const relativeFolders = new Set<string>();
  const checkoutPaths = new Map<string, string>();
  const differentRepositoryFolders = groupMembers.some((member) => {
    const relative = deriveRepositoryRelativeProjectPath(member);
    if (relative !== null) relativeFolders.add(relative);
    const root = member.repositoryIdentity?.rootPath;
    if (!root) return false;
    // Git can report a real path while the project was added through a symlink.
    const checkout = derivePhysicalProjectKeyFromPath(member.environmentId, root);
    const path = normalizeProjectPathForComparison(member.workspaceRoot);
    const previous = checkoutPaths.get(checkout);
    checkoutPaths.set(checkout, path);
    return relativeFolders.size > 1 || (previous !== undefined && previous !== path);
  });
  const entries = roots.map(entry);
  const nestedEntries = nested.map(entry);
  return {
    entries,
    nestedEntries,
    differentRepositoryFolders,
    entriesToRemove: (includeNested = false) =>
      includeNested ? entries.concat(nestedEntries) : entries,
  };
}
