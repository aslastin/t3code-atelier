import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import type { ThreadTopicIndex } from "@t3tools/client-runtime/state/thread-topics";
import {
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
  type ThreadTopic,
  ThreadTopicId,
  type ThreadTopicMutation,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { draftTopicId, sharedTopicProject } from "../components/Sidebar.topics.logic";
import { showThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadTopicIndexes, threadTopicEnvironment } from "../state/threadTopics";

// Atelier fork: topic changes from the sidebar and the composer.

interface TopicThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
}

export async function mutateTopics(
  environmentId: EnvironmentId,
  mutation: ThreadTopicMutation,
  failureTitle: string,
) {
  const result = await runAtomCommand(
    appAtomRegistry,
    threadTopicEnvironment.mutate,
    { environmentId, input: mutation },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred.")),
      }),
    );
  }
  return result;
}

function topicMembers(index: ThreadTopicIndex | undefined, topicId: ThreadTopicId): ThreadId[] {
  if (index === undefined) return [];
  const members: ThreadId[] = [];
  for (const [threadId, memberTopicId] of index.topicIdByThreadId) {
    if (memberTopicId === topicId) members.push(threadId);
  }
  return members;
}

export function assignThreadsToTopic(
  threads: readonly TopicThread[],
  topicId: ThreadTopicId | null,
) {
  const project = sharedTopicProject(threads);
  if (project === null) return;
  void mutateTopics(
    project.environmentId,
    { type: "topic.assign", threadIds: threads.map((thread) => thread.id), topicId },
    m(msg("Could not move threads")),
  );
}

export function reorderTopic(
  environmentId: EnvironmentId,
  topicId: ThreadTopicId,
  afterTopicId: ThreadTopicId | null,
) {
  void mutateTopics(
    environmentId,
    { type: "topic.reorder", topicId, afterTopicId },
    m(msg("Could not move topic")),
  );
}

export async function disbandTopic(block: {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly topic: ThreadTopic;
}) {
  const { environmentId, topic } = block;
  const members = topicMembers(readThreadTopicIndexes().get(environmentId), topic.id);
  const claim = ThreadUndo.begin("topic-disband", block.key);
  const result = await mutateTopics(
    environmentId,
    { type: "topic.disband", topicId: topic.id },
    m(msg("Could not disband topic")),
  );
  if (result._tag !== "Success") {
    claim.finish();
    return;
  }
  showThreadUndoNotice({
    action: "Disbanded",
    claim,
    failureTitle: m(msg("Failed to undo disband")),
    // Threads filed under another topic since stay there.
    undo: () => {
      const index = readThreadTopicIndexes().get(environmentId);
      return runAtomCommand(
        appAtomRegistry,
        threadTopicEnvironment.mutate,
        {
          environmentId,
          input: {
            type: "topic.create",
            topicId: topic.id,
            projectId: topic.projectId,
            title: topic.title,
            threadIds: members.filter((threadId) => !index?.topicIdByThreadId.has(threadId)),
            orderKey: topic.orderKey,
          },
        },
        { reportFailure: false },
      );
    },
  });
}

/**
 * Files a just-created thread under the topic its draft was started in. A draft that moved to
 * another environment or project, or a project key that only looks like a topic slot, names no
 * topic of the thread's project there, and the thread stays out of topics.
 */
export function assignDraftTopic(
  threadRef: ScopedThreadRef,
  draft: { readonly logicalProjectKey: string; readonly projectId: ProjectId },
) {
  const topicId = draftTopicId(draft.logicalProjectKey);
  if (topicId === null) return;
  const topic = readThreadTopicIndexes().get(threadRef.environmentId)?.topicById.get(topicId);
  if (topic === undefined || topic.projectId !== draft.projectId) return;
  void mutateTopics(
    threadRef.environmentId,
    { type: "topic.assign", threadIds: [threadRef.threadId], topicId },
    m(msg("Could not add the thread to its topic")),
  );
}
