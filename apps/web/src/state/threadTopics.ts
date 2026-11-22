import { useAtomValue } from "@effect/atom-react";
import {
  createThreadTopicEnvironmentAtoms,
  EMPTY_THREAD_TOPIC_INDEX,
  indexThreadTopics,
  type ThreadTopicIndex,
} from "@t3tools/client-runtime/state/thread-topics";
import type { EnvironmentId, ThreadId, ThreadTopicId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";

// Atelier fork: thread topics, for servers that advertise them.

export const threadTopicEnvironment = createThreadTopicEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_INDEXES: ReadonlyMap<EnvironmentId, ThreadTopicIndex> = new Map();

const environmentThreadTopicsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ThreadTopicIndex => {
    const config = get(environmentServerConfigsAtom).get(environmentId);
    if (config?.environment.capabilities.threadTopics !== true) return EMPTY_THREAD_TOPIC_INDEX;
    const result = get(threadTopicEnvironment.snapshot({ environmentId, input: {} }));
    const snapshot = AsyncResult.getOrElse(result, () => null);
    return snapshot === null ? EMPTY_THREAD_TOPIC_INDEX : indexThreadTopics(snapshot);
  }).pipe(Atom.withLabel(`web-thread-topics:${environmentId}`)),
);

/** Topic indexes of every environment that serves topics; others are absent. */
const threadTopicIndexesAtom = Atom.make((get): ReadonlyMap<EnvironmentId, ThreadTopicIndex> => {
  const indexes = new Map<EnvironmentId, ThreadTopicIndex>();
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.threadTopics !== true) continue;
    indexes.set(environmentId, get(environmentThreadTopicsAtom(environmentId)));
  }
  return indexes.size === 0 ? EMPTY_INDEXES : indexes;
}).pipe(Atom.withLabel("web-thread-topics"));

export interface ThreadTopicReadiness {
  /** Environments whose server config has arrived. */
  readonly configured: ReadonlySet<EnvironmentId>;
  /** Environments that serve topics and have sent their first snapshot. */
  readonly loaded: ReadonlySet<EnvironmentId>;
  /** Environments that serve topics and have answered, with a snapshot or an error. */
  readonly answered: ReadonlySet<EnvironmentId>;
}

const threadTopicReadinessAtom = Atom.make((get): ThreadTopicReadiness => {
  const configured = new Set<EnvironmentId>();
  const loaded = new Set<EnvironmentId>();
  const answered = new Set<EnvironmentId>();
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    configured.add(environmentId);
    if (config.environment.capabilities.threadTopics !== true) continue;
    const result = get(threadTopicEnvironment.snapshot({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(result)) loaded.add(environmentId);
    if (!AsyncResult.isInitial(result)) answered.add(environmentId);
  }
  return { configured, loaded, answered };
}).pipe(Atom.withLabel("web-thread-topics:readiness"));

export function useThreadTopicReadiness(): ThreadTopicReadiness {
  return useAtomValue(threadTopicReadinessAtom);
}

const EMPTY_ASSIGNMENTS: ReadonlyMap<string, ThreadTopicId> = new Map();

/**
 * Topics just-sent drafts are joining, by `environmentId:threadId`, until the topic snapshot
 * that follows the assignment. The thread can reach the list before it joins.
 */
const draftTopicAssignmentsAtom = Atom.make(EMPTY_ASSIGNMENTS).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-thread-topics:draft-assignments"),
);

export function useDraftTopicAssignments(): ReadonlyMap<string, ThreadTopicId> {
  return useAtomValue(draftTopicAssignmentsAtom);
}

function setDraftTopicAssignment(threadKey: string, topicId: ThreadTopicId | null) {
  const current = appAtomRegistry.get(draftTopicAssignmentsAtom);
  if (topicId === null && !current.has(threadKey)) return;
  const next = new Map(current);
  if (topicId === null) next.delete(threadKey);
  else next.set(threadKey, topicId);
  appAtomRegistry.set(draftTopicAssignmentsAtom, next);
}

/** Holds a draft's topic for its thread while `assignment` runs and its snapshot follows. */
export async function trackDraftTopicAssignment(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  topicId: ThreadTopicId,
  assignment: Promise<{ readonly _tag: "Success" | "Failure" }>,
) {
  const threadKey = `${environmentId}:${threadId}`;
  setDraftTopicAssignment(threadKey, topicId);
  const result = await assignment;
  const snapshotAtom = threadTopicEnvironment.snapshot({ environmentId, input: {} });
  const joined = () =>
    appAtomRegistry
      .get(threadTopicIndexesAtom)
      .get(environmentId)
      ?.topicIdByThreadId.get(threadId) === topicId;
  if (result._tag === "Failure" || joined()) {
    setDraftTopicAssignment(threadKey, null);
    return;
  }
  // The snapshot can trail the reply; the next one carries the membership.
  const release = appAtomRegistry.subscribe(snapshotAtom, () => {
    release();
    setDraftTopicAssignment(threadKey, null);
  });
}

export function useThreadTopicIndexes(): ReadonlyMap<EnvironmentId, ThreadTopicIndex> {
  return useAtomValue(threadTopicIndexesAtom);
}

/** Read at call time, as menus and drop handlers do. */
export function readThreadTopicIndexes(): ReadonlyMap<EnvironmentId, ThreadTopicIndex> {
  return appAtomRegistry.get(threadTopicIndexesAtom);
}
