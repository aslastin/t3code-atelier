import {
  parseScopedThreadKey,
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
  type ScopedThreadRef,
  type ThreadId,
  ThreadTopicId,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { m } from "../../i18n/messages";
import {
  assignThreadsToTopic,
  disbandTopic,
  mutateTopics,
  reorderTopic,
} from "../../lib/threadTopicActions";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { readThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { readThreadTopicIndexes, useThreadTopicIndexes } from "../../state/threadTopics";
import { useUiStateStore } from "../../uiStateStore";
import {
  arrangeFolderTopics,
  planTopicReorder,
  sharedTopicProject,
  sidebarTopicExpansionKey,
  sidebarTopicKey,
  topicDraftSlot,
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

/** Inserts topic items after the item with `afterId`, or at the end. */
export function withTopicMenuItemsAfter<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  topicItems: ReadonlyArray<ContextMenuItem<TopicMenuId>>,
  afterId: T,
): ReadonlyArray<ContextMenuItem<T | TopicMenuId>> {
  const index = items.findIndex((item) => item.id === afterId);
  if (index === -1) return [...items, ...topicItems];
  return [...items.slice(0, index + 1), ...topicItems, ...items.slice(index + 1)];
}

export const TOPIC_FILTER_MENU_ID = "topic:filter";

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
export function useSidebarTopicLayout(enabled: boolean, routeThreadKey: string | null) {
  const indexes = useThreadTopicIndexes();
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const active = enabled && indexes.size > 0;
  const routeRef = active && routeThreadKey !== null ? parseScopedThreadKey(routeThreadKey) : null;
  const routeTopicId =
    routeRef === null
      ? undefined
      : indexes.get(routeRef.environmentId)?.topicIdByThreadId.get(routeRef.threadId);
  const routeTopicKey =
    routeRef === null || routeTopicId === undefined
      ? null
      : sidebarTopicKey(routeRef.environmentId, routeTopicId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening a thread, or filing the open one, opens its topic in the persisted expansion state
  useEffect(() => {
    if (routeTopicKey === null) return;
    const key = sidebarTopicExpansionKey(routeTopicKey);
    if (useUiStateStore.getState().projectExpandedById[key] === false) {
      setProjectExpanded(key, true);
    }
  }, [routeTopicKey, setProjectExpanded]);
  // Topics open by default, whatever the legacy folder default says.
  const isCollapsed = (topicKey: string) =>
    projectExpandedById[sidebarTopicExpansionKey(topicKey)] === false;
  const toggleTopic = useStableCallback((topicKey: string) => {
    setProjectExpanded(sidebarTopicExpansionKey(topicKey), isCollapsed(topicKey));
  });
  const arrange = active
    ? (threads: readonly EnvironmentThreadShell[]) =>
        arrangeFolderTopics({ threads, indexes, isCollapsed })
    : null;
  return { arrange, toggleTopic };
}

export function useSidebarTopicActions(input: {
  readonly enabled: boolean;
  /** Settles threads together, including ones a closed topic does not draw. */
  readonly settleThreads: (threads: readonly ScopedThreadRef[]) => void;
  /** Whether the thread is in the active list now, read when a menu choice runs. */
  readonly isActiveThread: (threadKey: string) => boolean;
  /** Opens the project's draft for `draftSlot`, kept apart from its other drafts. */
  readonly startThread: (projectRef: ScopedProjectRef, draftSlot: string) => Promise<unknown>;
}) {
  const indexes = useThreadTopicIndexes();
  const enabled = input.enabled && indexes.size > 0;

  const startThreadInTopic = useStableCallback((block: SidebarTopicHeaderBlock) => {
    void settlePromise(() =>
      input.startThread(
        scopeProjectRef(block.environmentId, block.topic.projectId),
        topicDraftSlot(block.topic.id),
      ),
    );
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
          case "settle": {
            // Membership can change while the menu is open, here or on another client.
            const index = readThreadTopicIndexes().get(block.environmentId);
            const members = [...(index?.topicIdByThreadId ?? [])].flatMap(([threadId, topicId]) =>
              topicId === block.topic.id ? [scopeThreadRef(block.environmentId, threadId)] : [],
            );
            // A thread that left the project keeps a stale membership until the next snapshot.
            input.settleThreads(
              members.filter(
                (ref) =>
                  input.isActiveThread(scopedThreadKey(ref)) &&
                  readThreadShell(ref)?.projectId === block.topic.projectId,
              ),
            );
            return;
          }
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

  const reorderTopics = useStableCallback(
    (moved: SidebarTopicHeaderBlock, target: SidebarTopicHeaderBlock, placeAfter: boolean) => {
      const topics = indexes.get(moved.environmentId)?.topicsByProjectId.get(moved.topic.projectId);
      if (topics === undefined) return;
      const planned = planTopicReorder({
        order: topics.map((topic) => topic.id),
        movedId: moved.topic.id,
        targetId: target.topic.id,
        placeAfter,
      });
      if (planned !== null) reorderTopic(moved.environmentId, moved.topic.id, planned.afterTopicId);
    },
  );

  return {
    reorderTopics,
    startThreadInTopic,
    renameTopic,
    showTopicContextMenu,
    buildThreadMenuItems,
    handleThreadMenuClick,
  };
}
