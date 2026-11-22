import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CircleDashedIcon, HashIcon } from "lucide-react";

import { useThreadTopicIndexes } from "../../state/threadTopics";
import { useUiStateStore } from "../../uiStateStore";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import {
  collectSidebarTopicKeys,
  createSidebarTopicScopeMatcher,
  resolveSidebarTopicScope,
} from "../Sidebar.topicScope.logic";

// Atelier fork: topics in the sidebar's project filter.

interface ScopeGroup {
  readonly projectKey: string;
  readonly memberProjectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
}

export function useSidebarTopicScope(input: {
  /** Projects the filter can pick. */
  readonly groups: readonly ScopeGroup[];
  /** Picked projects, resolved against `groups`. */
  readonly projectKeys: readonly string[];
}) {
  const indexes = useThreadTopicIndexes();
  const topicKeys = useUiStateStore((store) => store.sidebarTopicScopeKeys);
  const setTopicKeys = useUiStateStore((store) => store.setSidebarTopicScopeKeys);
  const scope = resolveSidebarTopicScope({
    groups: input.groups,
    projectKeys: input.projectKeys,
    topicKeys,
    indexes,
  });
  const matcher = createSidebarTopicScopeMatcher({ scope, groups: input.groups, indexes });
  return { indexes, scope, matcher, setTopicKeys };
}

/** Topics a folder would show: those with an active thread, as in the boring sidebar. */
export function listedSidebarTopicKeys(
  threads: readonly EnvironmentThreadShell[],
  delegatedUnderParent: ReadonlySet<string>,
  indexes: Parameters<typeof collectSidebarTopicKeys>[1],
): ReadonlySet<string> {
  if (indexes.size === 0) return new Set();
  const now = new Date().toISOString();
  return collectSidebarTopicKeys(
    filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent).filter(
      (thread) =>
        thread.pinnedAt == null &&
        thread.settledOverride !== "settled" &&
        !effectiveSnoozed(thread, { now }),
    ),
    indexes,
  );
}

export function SidebarTopicScopeIcon(props: { noTopic: boolean }) {
  return props.noTopic ? (
    <CircleDashedIcon className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <HashIcon className="size-4 shrink-0 text-muted-foreground" />
  );
}

/** Marks the filter button while topics narrow it. */
export function SidebarTopicScopeBadge() {
  return (
    <span className="pointer-events-none absolute right-0 bottom-0 grid size-3.5 place-items-center rounded-full bg-sidebar">
      <HashIcon className="size-2.5" strokeWidth={3} aria-hidden />
    </span>
  );
}
