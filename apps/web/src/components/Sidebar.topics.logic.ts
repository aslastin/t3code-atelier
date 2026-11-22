import {
  compareThreadTopics,
  threadTopicOf,
  type ThreadTopicIndex,
} from "@t3tools/client-runtime/state/thread-topics";
import type { EnvironmentId, ProjectId, ThreadId, ThreadTopic } from "@t3tools/contracts";

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
