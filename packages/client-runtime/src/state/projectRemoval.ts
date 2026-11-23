import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { msg } from "gt-i18n";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import { derivePhysicalProjectKey, derivePhysicalProjectKeyFromPath } from "./projectGrouping.ts";
import { awaitAtomResult, settleAsyncResult } from "./runtime.ts";

type RemovalMember = Pick<
  EnvironmentProject,
  "id" | "environmentId" | "workspaceRoot" | "repositoryIdentity"
>;
type RemovalThread = Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "lineage" | "id">;

export const projectRemovalNotice = msg(
  "Removing these entries permanently deletes their threads, including archived threads. Unfinished clone folders may be cleared. Other files and provider sessions are kept.",
);
export const differentRepositoryFoldersNotice = msg(
  "This group contains different folders of the same repository.",
);

export const changedProjectFolderNotice = msg(
  "The project folder changed. Review the removal again.",
);
export const ambiguousProjectFoldersNotice = msg(
  "Review these checkouts individually because their folder relationship is unknown.",
);

export function removalEnvironmentLabel(
  environmentId: EnvironmentId,
  environments: readonly { environmentId: EnvironmentId; label: string }[],
) {
  const label = environments.find((env) => env.environmentId === environmentId)?.label;
  if (!label) return environmentId;
  return environments.some((env) => env.environmentId !== environmentId && env.label === label)
    ? `${label} (${environmentId})`
    : label;
}

export function removalFoldersMatch(
  selected: readonly RemovalMember[],
  current: readonly RemovalMember[],
) {
  return selected.every((member) =>
    current.some(
      (project) =>
        project.environmentId === member.environmentId &&
        project.id === member.id &&
        project.workspaceRoot === member.workspaceRoot,
    ),
  );
}

export function readRemovalArchives<E>(
  registry: AtomRegistry.AtomRegistry,
  members: readonly RemovalMember[],
  snapshotAtom: (request: {
    environmentId: EnvironmentId;
    input: Record<string, never>;
  }) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, E>>,
) {
  return settleAsyncResult(() =>
    Effect.runPromiseExit(
      Effect.forEach(
        [...new Set(members.map((member) => member.environmentId))],
        (environmentId) =>
          awaitAtomResult(registry, snapshotAtom({ environmentId, input: {} }), {
            refresh: true,
          }).pipe(Effect.map(({ threads }) => ({ environmentId, threads }))),
        { concurrency: 4 },
      ),
    ),
  );
}

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
  readonly archives?: ReadonlyArray<{
    environmentId: EnvironmentId;
    threads: ReadonlyArray<Pick<RemovalThread, "projectId" | "lineage"> & { id: string }>;
  }>;
  readonly unloadedThreadCount?: (member: Member, threads: ReadonlyArray<Thread>) => number;
}) {
  const { members, projects, groupMembers } = options;
  const pathOf = (member: Member) =>
    member.repositoryIdentity?.resolvedWorkspaceRoot ?? member.workspaceRoot;
  const relativeTo = (candidate: Member, parent: Member) =>
    workspaceRelativeFilePath(pathOf(candidate), pathOf(parent));
  const isNested = (candidate: Member) =>
    members.some((parent) => {
      if (parent.environmentId !== candidate.environmentId) return false;
      const relative = relativeTo(candidate, parent);
      return relative !== null && relative !== ".";
    });
  const selectedCheckouts = new Set(members.map(derivePhysicalProjectKey));
  const roots = projects.filter(
    (member) => selectedCheckouts.has(derivePhysicalProjectKey(member)) && !isNested(member),
  );
  const nested = projects.filter(isNested);
  // Older servers may only report Git's real root for a checkout registered through a symlink.
  const relativeFolder = (member: Member) =>
    workspaceRelativeFilePath(pathOf(member), member.repositoryIdentity?.rootPath);
  const ambiguousFolders = roots.some((member, index) =>
    roots
      .slice(index + 1)
      .some(
        (other) =>
          member.environmentId === other.environmentId &&
          relativeTo(member, other) !== "." &&
          (!member.repositoryIdentity?.rootPath ||
            !other.repositoryIdentity?.rootPath ||
            (derivePhysicalProjectKeyFromPath(
              member.environmentId,
              member.repositoryIdentity.rootPath,
            ) ===
              derivePhysicalProjectKeyFromPath(
                other.environmentId,
                other.repositoryIdentity.rootPath,
              ) &&
              (relativeFolder(member) === null || relativeFolder(other) === null))),
      ),
  );
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
  const archivedByProject = new Map<string, Set<string>>();
  for (const { environmentId, threads } of options.archives ?? []) {
    for (const thread of threads) {
      const key = scopedProjectKey(scopeProjectRef(environmentId, thread.projectId));
      if (!byProject.has(key) || !isListedThreadLineage(thread.lineage)) continue;
      const ids = archivedByProject.get(key) ?? new Set<string>();
      ids.add(thread.id);
      archivedByProject.set(key, ids);
    }
  }
  const entry = (member: Member) => {
    const key = scopedProjectKey(scopeProjectRef(member.environmentId, member.id));
    const threads = byProject.get(key)!;
    const archived = archivedByProject.get(key);
    const threadCount =
      (archived?.size ?? 0) +
      threads.filter((thread) => isListedThreadLineage(thread.lineage) && !archived?.has(thread.id))
        .length +
      (options.unloadedThreadCount?.(member, threads) ?? 0);
    return { member, threads, threadCount };
  };
  const foldedFolders = new Set<string>();
  const posixFolders = new Set<string>();
  const checkoutPaths = new Map<string, string>();
  const differentRepositoryFolders = groupMembers.some((member) => {
    const relative = relativeFolder(member)?.replace(/\/+$/, "");
    if (relative != null) {
      foldedFolders.add(relative.toLowerCase());
      if (!isWindowsAbsolutePath(pathOf(member))) posixFolders.add(relative);
    }
    const root = member.repositoryIdentity?.rootPath;
    if (!root) return false;
    // Git can report a real path while the project was added through a symlink.
    const checkout = derivePhysicalProjectKeyFromPath(member.environmentId, root);
    const path = derivePhysicalProjectKeyFromPath(member.environmentId, pathOf(member));
    const previous = checkoutPaths.get(checkout);
    checkoutPaths.set(checkout, path);
    return (
      foldedFolders.size > 1 ||
      posixFolders.size > 1 ||
      (previous !== undefined && previous !== path)
    );
  });
  const entries = roots.map(entry);
  const nestedEntries = nested.map(entry);
  return {
    entries,
    nestedEntries,
    differentRepositoryFolders,
    ambiguousFolders,
    entriesToRemove: (includeNested = false) =>
      includeNested ? entries.concat(nestedEntries) : entries,
  };
}
