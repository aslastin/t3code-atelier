import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { HashIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useThreadTopicIndexes } from "../../state/threadTopics";
import { draftTopicId, topicDraftSlot } from "../Sidebar.topics.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

// Atelier fork: the open thread's topic between its project and title in the chat header.

export function ChatHeaderTopicCrumb(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly isServerThread: boolean;
}) {
  const gt = useGT();
  const { handleNewThread } = useHandleNewThread();
  const index = useThreadTopicIndexes().get(props.environmentId);
  // A draft names its topic by draft slot; a thread joins it on its first message.
  const draftTopic = useComposerDraftStore((store) => {
    if (props.isServerThread) return null;
    const session = store.getDraftSessionByRef(scopeThreadRef(props.environmentId, props.threadId));
    return session ? draftTopicId(session.logicalProjectKey) : null;
  });
  const topicId = props.isServerThread
    ? index?.topicIdByThreadId.get(props.threadId)
    : (draftTopic ?? undefined);
  const topic = topicId === undefined ? undefined : index?.topicById.get(topicId);
  if (topic === undefined || topic.projectId !== props.projectId) return null;
  const label = gt("New thread in {topic}", { topic: topic.title });
  return (
    <>
      {/* The title takes what is left, so a long topic name gives way to it. */}
      <WorkspaceBreadcrumbItem className="max-w-[35%] shrink">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={label}
                onClick={() =>
                  void settlePromise(() =>
                    handleNewThread(scopeProjectRef(props.environmentId, topic.projectId), {
                      draftSlot: topicDraftSlot(topic.id),
                    }),
                  )
                }
                className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <HashIcon aria-hidden className="size-3.5 shrink-0" />
            <WorkspaceBreadcrumbText>{topic.title}</WorkspaceBreadcrumbText>
          </TooltipTrigger>
          <TooltipPopup side="top">{topic.title}</TooltipPopup>
        </Tooltip>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
