import {
  type ProjectId,
  type ThreadId,
  type ThreadTopic,
  type ThreadTopicId,
  type ThreadTopicsSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

// Atelier fork: topics group a project's threads. They are kept beside the thread shells,
// and clients join the two by thread id.

export function createThreadTopicEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread-topics",
      tag: WS_METHODS.subscribeThreadTopics,
    }),
    // Serial per environment, so a create and the moves after it land in order.
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-topics:mutate",
      tag: WS_METHODS.threadTopicsMutate,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
  };
}

export interface ThreadTopicIndex {
  readonly topicById: ReadonlyMap<ThreadTopicId, ThreadTopic>;
  readonly topicIdByThreadId: ReadonlyMap<ThreadId, ThreadTopicId>;
  /** In display order. */
  readonly topicsByProjectId: ReadonlyMap<ProjectId, readonly ThreadTopic[]>;
}

export const EMPTY_THREAD_TOPIC_INDEX: ThreadTopicIndex = {
  topicById: new Map(),
  topicIdByThreadId: new Map(),
  topicsByProjectId: new Map(),
};

export function compareThreadTopics(left: ThreadTopic, right: ThreadTopic): number {
  if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function indexThreadTopics(snapshot: ThreadTopicsSnapshot): ThreadTopicIndex {
  const topicById = new Map(snapshot.topics.map((topic) => [topic.id, topic] as const));
  const topicIdByThreadId = new Map<ThreadId, ThreadTopicId>();
  for (const membership of snapshot.memberships) {
    if (topicById.has(membership.topicId)) {
      topicIdByThreadId.set(membership.threadId, membership.topicId);
    }
  }
  const topicsByProjectId = new Map<ProjectId, ThreadTopic[]>();
  for (const topic of [...snapshot.topics].sort(compareThreadTopics)) {
    const topics = topicsByProjectId.get(topic.projectId);
    if (topics) topics.push(topic);
    else topicsByProjectId.set(topic.projectId, [topic]);
  }
  return { topicById, topicIdByThreadId, topicsByProjectId };
}

/** The thread's topic, when it still belongs to the thread's project. */
export function threadTopicOf(
  index: ThreadTopicIndex,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): ThreadTopic | null {
  const topicId = index.topicIdByThreadId.get(thread.id);
  const topic = topicId === undefined ? undefined : index.topicById.get(topicId);
  return topic !== undefined && topic.projectId === thread.projectId ? topic : null;
}
