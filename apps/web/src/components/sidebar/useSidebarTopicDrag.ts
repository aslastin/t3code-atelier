import type { ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef } from "react";

import { assignThreadsToTopic } from "../../lib/threadTopicActions";
import { readThreadShell } from "../../state/entities";
import { readThreadTopicIndexes } from "../../state/threadTopics";
import { planTopicThreadDrop, type SidebarDropRow } from "../Sidebar.topics.logic";

// Atelier fork: dropping dragged folder threads on topics. Rows hold still while a folder thread
// drags inside the list, so the header that takes the drop is marked instead.

const DROP_TARGET_ATTRIBUTE = "data-topic-drop-target";

function sidebarRowAt(point: { x: number; y: number }): SidebarDropRow | null {
  const element = document.elementFromPoint(point.x, point.y);
  const row =
    element?.closest<HTMLElement>("[data-sidebar-row]") ??
    element?.closest("li")?.querySelector<HTMLElement>("[data-sidebar-row]");
  const rowId = row?.dataset.sidebarRow;
  return rowId === undefined ? null : { rowId, parentId: row?.dataset.sidebarParent };
}

export function useSidebarTopicDrag(input: {
  readonly folders: ReadonlyArray<{
    readonly rowId: string;
    readonly projectRefs: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectId: string;
    }>;
  }> | null;
}) {
  const markedRef = useRef<Element | null>(null);
  const { folders } = input;

  const plan = (point: { x: number; y: number }, refs: ReadonlyArray<ScopedThreadRef>) => {
    if (folders === null) return null;
    const threads = refs.flatMap((ref) => readThreadShell(ref) ?? []);
    if (threads.length !== refs.length) return null;
    return planTopicThreadDrop({
      threads,
      row: sidebarRowAt(point),
      indexes: readThreadTopicIndexes(),
      folderProjects: (rowId) =>
        folders.find((folder) => folder.rowId === rowId)?.projectRefs ?? null,
    });
  };

  const clear = () => {
    markedRef.current?.removeAttribute(DROP_TARGET_ATTRIBUTE);
    markedRef.current = null;
  };

  const move = (point: { x: number; y: number }, refs: ReadonlyArray<ScopedThreadRef>) => {
    const drop = plan(point, refs);
    const target =
      drop === null
        ? null
        : document.querySelector(`[data-sidebar-row="${CSS.escape(drop.targetRowId)}"]`);
    if (target === markedRef.current) return;
    clear();
    target?.setAttribute(DROP_TARGET_ATTRIBUTE, "");
    markedRef.current = target;
  };

  /** True when the drop moved threads into or out of a topic. */
  const drop = (point: { x: number; y: number }, refs: ReadonlyArray<ScopedThreadRef>) => {
    clear();
    const planned = plan(point, refs);
    if (planned === null) return false;
    const threads = refs.flatMap((ref) => readThreadShell(ref) ?? []);
    assignThreadsToTopic(threads, planned.topicId);
    return true;
  };

  return { move, drop, clear };
}
