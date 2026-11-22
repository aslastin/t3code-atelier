import {
  compareThreadTopics,
  threadTopicOf,
  type ThreadTopicIndex,
} from "@t3tools/client-runtime/state/thread-topics";
import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ThreadTopic,
  ThreadTopicId,
} from "@t3tools/contracts";

import { draftSlotOf } from "../lib/draftSlots";

// Atelier fork: topics inside the boring sidebar's project folders.

interface TopicThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
}

export function sidebarTopicKey(environmentId: EnvironmentId, topicId: string): string {
  return `${environmentId}:${topicId}`;
}

/** The topic's sidebar tree row; its thread rows name it as their parent. */
export function sidebarTopicRowId(topicKey: string): string {
  return `topic:${topicKey}`;
}

export function isSidebarTopicRowId(rowId: string | undefined): boolean {
  return rowId?.startsWith("topic:") === true;
}

/** Shares the folders' device-local open state under its own key space. */
export function sidebarTopicExpansionKey(topicKey: string): string {
  return `atelier-topic:${topicKey}`;
}

export interface SidebarTopicBlock<TThread> {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly topic: ThreadTopic;
  readonly collapsed: boolean;
  /** Rows to draw: all threads while open, only the open thread while closed. */
  readonly threads: readonly TThread[];
  /** What a closed topic hides, for its count and status dot. */
  readonly hiddenThreads: readonly TThread[];
}

export interface ArrangedFolderTopics<TThread> {
  readonly topics: readonly SidebarTopicBlock<TThread>[];
  readonly looseThreads: readonly TThread[];
  /** Every drawn row in drawing order, for keyboard and range selection. */
  readonly threads: readonly TThread[];
}

/**
 * Splits a folder's active threads into topic blocks, in the topics' manual order, followed by
 * threads without a topic. Threads keep their input order inside each block, and a topic with no
 * active thread here has no block.
 */
export function arrangeFolderTopics<TThread extends TopicThread>(input: {
  readonly threads: readonly TThread[];
  readonly indexes: ReadonlyMap<EnvironmentId, ThreadTopicIndex>;
  readonly isCollapsed: (topicKey: string) => boolean;
  readonly routeThreadKey: string | null;
  readonly threadKey: (thread: TThread) => string;
}): ArrangedFolderTopics<TThread> {
  const { threads, indexes, isCollapsed, routeThreadKey, threadKey } = input;
  if (indexes.size === 0) return { topics: [], looseThreads: threads, threads };
  const blocks = new Map<
    string,
    { environmentId: EnvironmentId; topic: ThreadTopic; threads: TThread[] }
  >();
  const looseThreads: TThread[] = [];
  for (const thread of threads) {
    const index = indexes.get(thread.environmentId);
    const topic = index ? threadTopicOf(index, thread) : null;
    if (topic === null) {
      looseThreads.push(thread);
      continue;
    }
    const key = sidebarTopicKey(thread.environmentId, topic.id);
    const block = blocks.get(key);
    if (block) block.threads.push(thread);
    else blocks.set(key, { environmentId: thread.environmentId, topic, threads: [thread] });
  }
  if (blocks.size === 0) return { topics: [], looseThreads: threads, threads };
  const topics = [...blocks.entries()]
    .toSorted(([, left], [, right]) => compareThreadTopics(left.topic, right.topic))
    .map(([key, block]): SidebarTopicBlock<TThread> => {
      const collapsed = isCollapsed(key);
      return {
        key,
        environmentId: block.environmentId,
        topic: block.topic,
        collapsed,
        threads: collapsed
          ? block.threads.filter((thread) => threadKey(thread) === routeThreadKey)
          : block.threads,
        hiddenThreads: collapsed
          ? block.threads.filter((thread) => threadKey(thread) !== routeThreadKey)
          : [],
      };
    });
  return {
    topics,
    looseThreads,
    threads: [...topics.flatMap((block) => block.threads), ...looseThreads],
  };
}

/**
 * What a folder draws, for list motion and the shift guard: topic order and membership move rows
 * even when the folder's thread count and its active-thread order stay the same.
 */
export function sidebarFolderTopicsLayoutKey(folder: {
  readonly threads: readonly TopicThread[];
  readonly topics: ArrangedFolderTopics<TopicThread> | null;
}): string {
  const rows = folder.threads.map((thread) => `${thread.environmentId}:${thread.id}`).join(",");
  const headers =
    folder.topics?.topics.map((block) => `${block.key}/${block.threads.length}`).join(",") ?? "";
  return `${headers}|${rows}`;
}

/** The one project and environment every thread shares, which topic actions need. */
export function sharedTopicProject(
  threads: readonly TopicThread[],
): { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null {
  const first = threads[0];
  if (first === undefined) return null;
  return threads.every(
    (thread) =>
      thread.environmentId === first.environmentId && thread.projectId === first.projectId,
  )
    ? { environmentId: first.environmentId, projectId: first.projectId }
    : null;
}

export interface SidebarDropRow {
  readonly rowId: string;
  readonly parentId: string | undefined;
}

export interface TopicThreadDrop {
  readonly environmentId: EnvironmentId;
  readonly threadIds: readonly ThreadId[];
  readonly topicId: ThreadTopicId | null;
  /** The header row that takes the drop, for highlighting. */
  readonly targetRowId: string;
}

/**
 * Where dragged folder threads land: on a topic's header or rows they join the topic, and on
 * the folder's header or its rows without a topic they leave theirs. Topics never take threads
 * of another project or environment.
 */
export function planTopicThreadDrop(input: {
  readonly threads: readonly TopicThread[];
  readonly row: SidebarDropRow | null;
  readonly indexes: ReadonlyMap<EnvironmentId, ThreadTopicIndex>;
  readonly folderProjects: (
    folderRowId: string,
  ) => ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: string }> | null;
}): TopicThreadDrop | null {
  const { threads, row, indexes } = input;
  const project = sharedTopicProject(threads);
  const index = project === null ? undefined : indexes.get(project.environmentId);
  if (project === null || index === undefined || row === null) return null;
  // A row keeps its place while dragged, and its parent can be the folder even in a topic.
  if (threads.some((thread) => `${thread.environmentId}:${thread.id}` === row.rowId)) return null;
  const threadIds = threads.map((thread) => thread.id);
  const topicRowId = [row.rowId, row.parentId].find(isSidebarTopicRowId);
  if (topicRowId !== undefined) {
    const prefix = `topic:${project.environmentId}:`;
    if (!topicRowId.startsWith(prefix)) return null;
    const topic = index.topicById.get(ThreadTopicId.make(topicRowId.slice(prefix.length)));
    if (topic === undefined || topic.projectId !== project.projectId) return null;
    if (threads.every((thread) => index.topicIdByThreadId.get(thread.id) === topic.id)) {
      return null;
    }
    return {
      environmentId: project.environmentId,
      threadIds,
      topicId: topic.id,
      targetRowId: topicRowId,
    };
  }
  const folderRowId = [row.rowId, row.parentId].find((id) => id?.startsWith("folder:") === true);
  if (folderRowId === undefined) return null;
  const inFolder = input
    .folderProjects(folderRowId)
    ?.some(
      (ref) => ref.environmentId === project.environmentId && ref.projectId === project.projectId,
    );
  if (inFolder !== true || !threads.some((thread) => index.topicIdByThreadId.has(thread.id))) {
    return null;
  }
  return {
    environmentId: project.environmentId,
    threadIds,
    topicId: null,
    targetRowId: folderRowId,
  };
}

/**
 * The topic a moved topic should follow when dropped before or after `targetId`, in the
 * project's full topic order; null when the move changes nothing.
 */
export function planTopicReorder(input: {
  readonly order: readonly ThreadTopicId[];
  readonly movedId: ThreadTopicId;
  readonly targetId: ThreadTopicId;
  readonly placeAfter: boolean;
}): { readonly afterTopicId: ThreadTopicId | null } | null {
  const { order, movedId, targetId, placeAfter } = input;
  if (movedId === targetId || !order.includes(movedId)) return null;
  const rest = order.filter((id) => id !== movedId);
  const targetIndex = rest.indexOf(targetId);
  if (targetIndex === -1) return null;
  const insertAt = placeAfter ? targetIndex + 1 : targetIndex;
  const afterTopicId = rest[insertAt - 1] ?? null;
  const currentIndex = order.indexOf(movedId);
  return (order[currentIndex - 1] ?? null) === afterTopicId ? null : { afterTopicId };
}

// A topic's drafts live in their own slot of the project's drafts; the slot names the topic,
// which the thread joins once its first message creates it.
const TOPIC_DRAFT_SLOT_PREFIX = "atelier-topic:";

export function topicDraftSlot(topicId: ThreadTopicId): string {
  return `${TOPIC_DRAFT_SLOT_PREFIX}${topicId}`;
}

/** The topic a draft was started in, read from its draft key's slot. */
export function draftTopicId(draftKey: string): ThreadTopicId | null {
  const slot = draftSlotOf(draftKey);
  if (slot === null || !slot.startsWith(TOPIC_DRAFT_SLOT_PREFIX)) return null;
  const topicId = slot.slice(TOPIC_DRAFT_SLOT_PREFIX.length);
  return topicId.length === 0 ? null : ThreadTopicId.make(topicId);
}
