import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuItem,
  type ContextMenuSource,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  type ThreadId,
  ThreadTopicId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { m } from "../../i18n/messages";
import {
  assignThreadsToTopic,
  disbandTopic,
  mutateTopics,
  setDraftTopic,
} from "../../lib/threadTopicActions";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { readEnvironmentScope } from "../../state/session";
import { useThreadTopicIndexes } from "../../state/threadTopics";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import {
  type ArrangedFolderTopics,
  arrangeFolderTopics,
  sharedTopicProject,
  sidebarTopicExpansionKey,
} from "../Sidebar.topics.logic";
import { requestTopicName } from "../TopicNameDialog";
import { type SidebarTopicHeaderBlock, useSidebarTopicRename } from "./SidebarTopicHeader";

// Atelier fork: topic actions for the boring sidebar.

interface TopicThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
}

export type TopicMenuId = `topic:${string}`;

const MOVE_TO_TOPIC_ID = "topic:move";
const NEW_TOPIC_ID = "topic:new";
const REMOVE_FROM_TOPIC_ID = "topic:remove";
const ASSIGN_PREFIX = "topic:assign:";

export function isTopicMenuId(id: string): id is TopicMenuId {
  return id.startsWith("topic:");
}

/** Inserts topic items before the item with `beforeId`, or at the end. */
export function withTopicMenuItems<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  topicItems: ReadonlyArray<ContextMenuItem<TopicMenuId>>,
  beforeId: T,
): ReadonlyArray<ContextMenuItem<T | TopicMenuId>> {
  if (topicItems.length === 0) return items;
  const index = items.findIndex((item) => item.id === beforeId);
  if (index === -1) return [...items, ...topicItems];
  return [...items.slice(0, index), ...topicItems, ...items.slice(index)];
}

async function createTopicFromThreads(threads: readonly TopicThread[]) {
  const project = sharedTopicProject(threads);
  if (project === null) return;
  const title = await requestTopicName();
  if (title === null) return;
  await mutateTopics(
    project.environmentId,
    {
      type: "topic.create",
      topicId: ThreadTopicId.make(randomUUID()),
      projectId: project.projectId,
      title,
      threadIds: threads.map((thread) => thread.id),
    },
    m(msg("Could not create topic")),
  );
}

/** Topic blocks for boring sidebar folders; null while topics do not apply. */
export function useSidebarTopicLayout(enabled: boolean) {
  const indexes = useThreadTopicIndexes();
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const active = enabled && indexes.size > 0;
  const toggleTopic = useStableCallback((topicKey: string) => {
    const key = sidebarTopicExpansionKey(topicKey);
    setProjectExpanded(key, !resolveProjectExpanded(projectExpandedById, [key]));
  });
  const arrange = active
    ? <TThread extends EnvironmentThreadShell>(
        threads: readonly TThread[],
        routeThreadKey: string | null,
      ): ArrangedFolderTopics<TThread> =>
        arrangeFolderTopics({
          threads,
          indexes,
          isCollapsed: (topicKey) =>
            projectExpandedById[sidebarTopicExpansionKey(topicKey)] === false,
          routeThreadKey,
          threadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        })
    : null;
  return { arrange, toggleTopic };
}

export function useSidebarTopicActions(input: {
  readonly enabled: boolean;
  readonly settleThreads: (threadKeys: readonly string[]) => void;
  readonly startThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
}) {
  const indexes = useThreadTopicIndexes();
  const enabled = input.enabled && indexes.size > 0;

  const startThreadInTopic = useStableCallback((block: SidebarTopicHeaderBlock) => {
    void (async () => {
      const result = await settlePromise(() =>
        input.startThread(scopeProjectRef(block.environmentId, block.topic.projectId)),
      );
      if (result._tag === "Success" && result.value !== null) {
        setDraftTopic(scopeThreadRef(block.environmentId, result.value.threadId), block.topic.id);
      }
    })();
  });

  const renameTopic = useStableCallback((block: SidebarTopicHeaderBlock, title: string) => {
    void mutateTopics(
      block.environmentId,
      { type: "topic.rename", topicId: block.topic.id, title },
      m(msg("Could not rename topic")),
    );
  });

  const showTopicContextMenu = useStableCallback(
    (
      block: SidebarTopicHeaderBlock,
      position: { x: number; y: number },
      source: ContextMenuSource,
    ) => {
      const api = readLocalApi();
      if (!api) return;
      const canOperate = readEnvironmentScope(block.environmentId, AuthOrchestrationOperateScope);
      void (async () => {
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              { id: "new-thread", label: m(msg("New thread in topic")) },
              {
                id: "rename",
                label: m(msg("Rename topic")),
                icon: "pencil",
                disabled: !canOperate,
              },
              {
                id: "settle",
                label: m(msg("Settle topic")),
                icon: "circle-check",
                separatorBefore: true,
                disabled: !canOperate,
              },
              { id: "disband", label: m(msg("Disband topic")), disabled: !canOperate },
            ],
            position,
            source,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "new-thread":
            startThreadInTopic(block);
            return;
          case "rename":
            useSidebarTopicRename.setState({ renamingKey: block.key });
            return;
          case "settle":
            input.settleThreads(
              [...block.threads, ...block.hiddenThreads].map((thread) =>
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
              ),
            );
            return;
          case "disband":
            await disbandTopic(block);
            return;
        }
      })();
    },
  );

  /** "Move to topic" for one thread or a selection; empty when topics do not apply. */
  const buildThreadMenuItems = (
    threads: readonly TopicThread[],
  ): ReadonlyArray<ContextMenuItem<TopicMenuId>> => {
    if (!enabled) return [];
    const project = sharedTopicProject(threads);
    if (project === null) return [];
    const index = indexes.get(project.environmentId);
    if (index === undefined) return [];
    const canOperate = readEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
    const topics = index.topicsByProjectId.get(project.projectId) ?? [];
    const currentTopicIds = new Set(
      threads.map((thread) => index.topicIdByThreadId.get(thread.id)),
    );
    const sharedTopicId = currentTopicIds.size === 1 ? [...currentTopicIds][0] : undefined;
    const anyInTopic = [...currentTopicIds].some((topicId) => topicId !== undefined);
    return [
      {
        id: MOVE_TO_TOPIC_ID,
        label:
          threads.length > 1
            ? m(msg("Move to topic ({count})"), { count: threads.length })
            : m(msg("Move to topic")),
        icon: "hash",
        separatorBefore: true,
        disabled: !canOperate,
        children: [
          ...topics.map((topic) => ({
            id: `${ASSIGN_PREFIX}${topic.id}` as const,
            label: topic.title,
            checked: topic.id === sharedTopicId,
            disabled: !canOperate || topic.id === sharedTopicId,
          })),
          {
            id: NEW_TOPIC_ID,
            label: m(msg("New topic…")),
            separatorBefore: topics.length > 0,
            disabled: !canOperate,
          },
          ...(anyInTopic
            ? [
                {
                  id: REMOVE_FROM_TOPIC_ID,
                  label: m(msg("Remove from topic")),
                  disabled: !canOperate,
                } as const,
              ]
            : []),
        ],
      },
    ];
  };

  const handleThreadMenuClick = async (id: TopicMenuId, threads: readonly TopicThread[]) => {
    if (id === NEW_TOPIC_ID) {
      await createTopicFromThreads(threads);
    } else if (id === REMOVE_FROM_TOPIC_ID) {
      assignThreadsToTopic(threads, null);
    } else if (id.startsWith(ASSIGN_PREFIX)) {
      assignThreadsToTopic(threads, ThreadTopicId.make(id.slice(ASSIGN_PREFIX.length)));
    }
  };

  return {
    startThreadInTopic,
    renameTopic,
    showTopicContextMenu,
    buildThreadMenuItems,
    handleThreadMenuClick,
  };
}
