import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { type EnvironmentId, type ProjectId, ThreadTopicId } from "@t3tools/contracts";
import { CircleDashedIcon, HashIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useConnectedEnvironmentIds } from "../../state/environments";
import {
  useDraftTopicAssignments,
  useThreadTopicIndexes,
  useThreadTopicReadiness,
} from "../../state/threadTopics";
import { useUiStateStore } from "../../uiStateStore";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { draftTopicId } from "../Sidebar.topics.logic";
import {
  collectSidebarTopicKeys,
  createSidebarTopicScopeMatcher,
  resolveSidebarTopicScope,
  sidebarTopicScopePending,
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
  const allIndexes = useThreadTopicIndexes();
  const readiness = useThreadTopicReadiness();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const assignments = useDraftTopicAssignments();
  // An environment's empty index before its first snapshot would file every thread under No topic.
  const indexes = new Map(
    [...allIndexes].filter(([environmentId]) => readiness.loaded.has(environmentId)),
  );
  const topicKeys = useUiStateStore((store) => store.sidebarTopicScopeKeys);
  const setTopicKeys = useUiStateStore((store) => store.setSidebarTopicScopeKeys);
  // A string, so the selector stays stable while drafts change elsewhere.
  const draftTopics = useComposerDraftStore((store) =>
    Object.values(store.draftThreadsByThreadKey)
      .flatMap((session) => {
        const topicId = draftTopicId(session.logicalProjectKey);
        return topicId === null ? [] : [`${session.environmentId}:${session.threadId}\n${topicId}`];
      })
      .join("\n\n"),
  );
  const scope = resolveSidebarTopicScope({
    groups: input.groups,
    projectKeys: input.projectKeys,
    topicKeys,
    indexes,
  });
  const matcher = createSidebarTopicScopeMatcher({
    scope,
    groups: input.groups,
    indexes,
    // A sent draft's session can finalize before its assignment lands, which the tracker covers.
    draftTopicIdByThread: new Map([
      ...(draftTopics === ""
        ? []
        : draftTopics.split("\n\n").map((entry) => {
            const [threadKey = "", topicId = ""] = entry.split("\n");
            return [threadKey, ThreadTopicId.make(topicId)] as const;
          })),
      ...assignments,
    ]),
  });
  const pending = sidebarTopicScopePending({
    unresolvedTopicKeys: scope.unresolvedTopicKeys,
    groups: input.groups,
    connected: new Set(connectedEnvironmentIds),
    configured: readiness.configured,
    served: new Set(allIndexes.keys()),
    // A failed subscription counts as answered, so its stale keys never hold the list empty.
    answered: readiness.answered,
  });
  return { indexes, scope, matcher, pending, setTopicKeys };
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
