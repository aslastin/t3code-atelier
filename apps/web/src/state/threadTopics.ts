import { useAtomValue } from "@effect/atom-react";
import {
  createThreadTopicEnvironmentAtoms,
  EMPTY_THREAD_TOPIC_INDEX,
  indexThreadTopics,
  type ThreadTopicIndex,
} from "@t3tools/client-runtime/state/thread-topics";
import type { EnvironmentId } from "@t3tools/contracts";
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

/** Whether every environment that serves topics has sent its first snapshot. */
const threadTopicSnapshotsReadyAtom = Atom.make((get): boolean => {
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.threadTopics !== true) continue;
    const result = get(threadTopicEnvironment.snapshot({ environmentId, input: {} }));
    if (AsyncResult.getOrElse(result, () => null) === null) return false;
  }
  return true;
}).pipe(Atom.withLabel("web-thread-topics:ready"));

export function useThreadTopicSnapshotsReady(): boolean {
  return useAtomValue(threadTopicSnapshotsReadyAtom);
}

export function useThreadTopicIndexes(): ReadonlyMap<EnvironmentId, ThreadTopicIndex> {
  return useAtomValue(threadTopicIndexesAtom);
}

/** Read at call time, as menus and drop handlers do. */
export function readThreadTopicIndexes(): ReadonlyMap<EnvironmentId, ThreadTopicIndex> {
  return appAtomRegistry.get(threadTopicIndexesAtom);
}
