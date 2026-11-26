import {
  type EnvironmentId,
  type ProjectRemovalPreviewEntry,
  type ProjectRemovalFolder,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-i18n";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import { derivePhysicalProjectKey, derivePhysicalProjectKeyFromPath } from "./projectGrouping.ts";
import type { AtomCommandResult } from "./runtime.ts";

type RemovalMember = Pick<
  EnvironmentProject,
  "id" | "environmentId" | "workspaceRoot" | "repositoryIdentity"
>;
type RemovalThread = Pick<EnvironmentThreadShell, "environmentId" | "projectId">;
type PreviewEntry = ProjectRemovalPreviewEntry & { environmentId: EnvironmentId };

export const projectRemovalNotice = msg(
  "Removing these entries permanently deletes their threads, including archived threads. Files on disk and provider sessions are kept.",
);
export const differentRepositoryFoldersNotice = msg(
  "This group contains different folders of the same repository.",
);

export const changedProjectFolderNotice = msg(
  "The project folder changed. Review the removal again.",
);
export const removalServerUpdateNotice = msg(
  "Update this environment to review and remove project entries.",
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

export async function readProjectRemovalPreview<E>(
  members: readonly Pick<RemovalMember, "environmentId">[],
  read: (request: {
    environmentId: EnvironmentId;
    input: Record<string, never>;
  }) => Promise<AtomCommandResult<readonly ProjectRemovalPreviewEntry[], E>>,
): Promise<AtomCommandResult<readonly PreviewEntry[], E>> {
  const rows: PreviewEntry[] = [];
  for (const environmentId of new Set(members.map((member) => member.environmentId))) {
    const result = await read({ environmentId, input: {} });
    if (result._tag === "Failure") return AsyncResult.failure(result.cause);
    for (const row of result.value) rows.push({ ...row, environmentId });
  }
  return AsyncResult.success(rows);
}

export function reviewedFoldersMatch(
  entries: readonly { member: RemovalMember; expectedFolder: ProjectRemovalFolder }[],
  preview: readonly PreviewEntry[],
) {
  return entries.every(({ member, expectedFolder }) =>
    preview.some(
      (row) =>
        row.environmentId === member.environmentId &&
        row.projectId === member.id &&
        row.workspaceRoot === expectedFolder.workspaceRoot &&
        row.resolvedWorkspaceRoot === expectedFolder.resolvedWorkspaceRoot,
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
  readonly preview: readonly PreviewEntry[];
}) {
  const { members, projects, groupMembers } = options;
  const keyOf = (member: RemovalMember) =>
    scopedProjectKey(scopeProjectRef(member.environmentId, member.id));
  const folders = new Map(
    options.preview.map((row) => [
      scopedProjectKey(scopeProjectRef(row.environmentId, row.projectId)),
      row,
    ]),
  );
  const pathOf = (member: Member) => folders.get(keyOf(member))?.resolvedWorkspaceRoot;
  const relativeTo = (candidate: Member, parent: Member) => {
    const path = pathOf(candidate);
    return path == null ? null : workspaceRelativeFilePath(path, pathOf(parent));
  };
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
  const relativeFolder = (member: Member) =>
    workspaceRelativeFilePath(
      pathOf(member) ?? member.workspaceRoot,
      member.repositoryIdentity?.rootPath,
    );
  const ambiguousFolders = roots.some(
    (member) =>
      pathOf(member) == null &&
      roots.some(
        (other) =>
          member.environmentId === other.environmentId &&
          derivePhysicalProjectKey(member) !== derivePhysicalProjectKey(other),
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
  const entry = (member: Member) => {
    const key = keyOf(member);
    const row = folders.get(key)!;
    return {
      member,
      threads: byProject.get(key)!,
      threadCount: row.threadCount,
      expectedFolder: {
        workspaceRoot: row.workspaceRoot,
        resolvedWorkspaceRoot: row.resolvedWorkspaceRoot,
      },
    };
  };
  const foldedFolders = new Set<string>();
  const posixFolders = new Set<string>();
  const checkoutPaths = new Map<string, string>();
  const differentRepositoryFolders = groupMembers.some((member) => {
    const relative = relativeFolder(member)?.replace(/\/+$/, "");
    if (relative != null) {
      foldedFolders.add(relative.toLowerCase());
      if (!isWindowsAbsolutePath(pathOf(member) ?? member.workspaceRoot))
        posixFolders.add(relative);
    }
    const root = member.repositoryIdentity?.rootPath;
    if (!root) return false;
    // Git can report a real path while the project was added through a symlink.
    const checkout = derivePhysicalProjectKeyFromPath(member.environmentId, root);
    const path = derivePhysicalProjectKeyFromPath(
      member.environmentId,
      pathOf(member) ?? member.workspaceRoot,
    );
    const previous = checkoutPaths.get(checkout);
    checkoutPaths.set(checkout, path);
    return (
      foldedFolders.size > 1 ||
      posixFolders.size > 1 ||
      (previous !== undefined && previous !== path)
    );
  });
  const environmentIds = new Set(members.map((member) => member.environmentId));
  const relevant = projects.filter((member) => environmentIds.has(member.environmentId));
  const foldersChanged =
    relevant.length !== folders.size ||
    relevant.some((member) => folders.get(keyOf(member))?.workspaceRoot !== member.workspaceRoot);
  const canReview = !foldersChanged && !ambiguousFolders;
  const entries = canReview ? roots.map(entry) : [];
  const nestedEntries = canReview ? nested.map(entry) : [];
  return {
    entries,
    nestedEntries,
    differentRepositoryFolders,
    ambiguousFolders,
    foldersChanged,
    entriesToRemove: (includeNested = false) =>
      includeNested ? entries.concat(nestedEntries) : entries,
  };
}
