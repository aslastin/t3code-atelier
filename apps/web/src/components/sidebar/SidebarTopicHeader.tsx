import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type ContextMenuSource, THREAD_TOPIC_TITLE_MAX_LENGTH } from "@t3tools/contracts";
import { ChevronDownIcon, HashIcon, SquarePenIcon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  useRef,
  useState,
} from "react";
import { create } from "zustand";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { type SidebarTopicBlock, sidebarTopicRowId } from "../Sidebar.topics.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Atelier fork: a topic inside a boring sidebar project folder.

const TOPIC_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const TOPIC_DOT_LABEL = {
  attention: msg(", needs you", { $context: "topic status, read after its name" }),
  failed: msg(", failed", { $context: "topic status, read after its name" }),
  unread: msg(", done", { $context: "topic status, read after its name" }),
  working: msg(", working", { $context: "topic status, read after its name" }),
} as const;

/** The topic whose name is being edited in place, opened from its context menu. */
export const useSidebarTopicRename = create<{ renamingKey: string | null }>(() => ({
  renamingKey: null,
}));

export type SidebarTopicHeaderBlock = SidebarTopicBlock<EnvironmentThreadShell>;

// The topic header being dragged; drag events cannot read their data until the drop.
let draggedTopic: SidebarTopicHeaderBlock | null = null;
const TOPIC_DRAG_TYPE = "application/x-t3-atelier-topic";

const sameProject = (left: SidebarTopicHeaderBlock, right: SidebarTopicHeaderBlock) =>
  left.environmentId === right.environmentId && left.topic.projectId === right.topic.projectId;

export const SidebarTopicHeader = memo(function SidebarTopicHeader(props: {
  block: SidebarTopicHeaderBlock;
  folderRowId: string;
  onToggle: (topicKey: string) => void;
  onNewThread: (block: SidebarTopicHeaderBlock) => void;
  onRename: (block: SidebarTopicHeaderBlock, title: string) => void;
  onReorder: (
    moved: SidebarTopicHeaderBlock,
    target: SidebarTopicHeaderBlock,
    placeAfter: boolean,
  ) => void;
  onContextMenu: (
    block: SidebarTopicHeaderBlock,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { block } = props;
  const rowId = sidebarTopicRowId(block.key);
  const renaming = useSidebarTopicRename((state) => state.renamingKey === block.key);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = block.collapsed
    ? resolveSidebarFolderDot(
        block.hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  const title = block.topic.title;
  const [dropEdge, setDropEdge] = useState<"before" | "after" | null>(null);
  const edgeOf = (event: ReactDragEvent<HTMLLIElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
  };
  const acceptsDrag = (event: ReactDragEvent<HTMLLIElement>) =>
    event.dataTransfer.types.includes(TOPIC_DRAG_TYPE) &&
    draggedTopic !== null &&
    draggedTopic.key !== block.key &&
    sameProject(draggedTopic, block);
  return (
    <li
      data-testid="sidebar-topic"
      className={cn(
        "group/topic relative list-none",
        dropEdge === "before" &&
          "before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:rounded-full before:bg-ring",
        dropEdge === "after" &&
          "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ring",
      )}
      onDragOver={(event) => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropEdge(edgeOf(event));
      }}
      onDragLeave={() => setDropEdge(null)}
      onDrop={(event) => {
        setDropEdge(null);
        if (!acceptsDrag(event) || draggedTopic === null) return;
        event.preventDefault();
        props.onReorder(draggedTopic, block, edgeOf(event) === "after");
      }}
    >
      {renaming ? (
        <div className="flex h-7 w-full items-center gap-2 ps-9 pe-(--sidebar-row-content-inset)">
          <HashIcon aria-hidden className="size-3 shrink-0 text-sidebar-muted-foreground" />
          <TopicRenameInput
            title={title}
            onCommit={(next) => {
              useSidebarTopicRename.setState({ renamingKey: null });
              const trimmed = next.trim();
              if (trimmed.length > 0 && trimmed !== title) props.onRename(block, trimmed);
            }}
            onCancel={() => useSidebarTopicRename.setState({ renamingKey: null })}
          />
        </div>
      ) : (
        <button
          type="button"
          data-sidebar-row={rowId}
          data-sidebar-parent={props.folderRowId}
          aria-expanded={!block.collapsed}
          draggable
          onDragStart={(event) => {
            draggedTopic = block;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(TOPIC_DRAG_TYPE, block.key);
          }}
          onDragEnd={() => {
            draggedTopic = null;
          }}
          onClick={() => props.onToggle(block.key)}
          onKeyDown={(event) => {
            if (event.key !== "F2") return;
            event.preventDefault();
            useSidebarTopicRename.setState({ renamingKey: block.key });
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            props.onContextMenu(
              block,
              { x: event.clientX, y: event.clientY },
              contextMenuSourceOf(event),
            );
          }}
          className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) ps-9 pe-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <HashIcon aria-hidden className="size-3 shrink-0 text-sidebar-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground/80">
            {title}
          </span>
          {dot ? (
            <span className={cn("size-1.5 shrink-0 rounded-full", TOPIC_DOT_CLASS_NAME[dot])}>
              <span className="sr-only">{m(TOPIC_DOT_LABEL[dot])}</span>
            </span>
          ) : null}
          {block.collapsed && block.hiddenThreads.length > 0 ? (
            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/topic:invisible group-has-[[data-sidebar-action-for]:focus]/topic:invisible pointer-coarse:invisible">
              {block.hiddenThreads.length}
            </span>
          ) : null}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
              block.collapsed && "-rotate-90",
            )}
          />
        </button>
      )}
      {renaming ? null : (
        <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/topic:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-sidebar-action-for={rowId}
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={gt("New thread in {topic}", { topic: title })}
                  onClick={() => props.onNewThread(block)}
                />
              }
            >
              <SquarePenIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>
              <T>
                New thread in <Var>{title}</Var>
              </T>
            </TooltipPopup>
          </Tooltip>
        </span>
      )}
    </li>
  );
});

// Mounted only while renaming, so each rename starts uncommitted.
function TopicRenameInput(props: {
  title: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const gt = useGT();
  const [value, setValue] = useState(props.title);
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={value}
      dir="auto"
      maxLength={THREAD_TOPIC_TITLE_MAX_LENGTH}
      aria-label={gt("Topic name")}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit(value);
      }}
      className="-mx-1 min-w-0 flex-1 rounded-sm bg-card px-1 text-xs font-medium text-card-foreground outline-none ring-1 ring-inset ring-input focus:ring-foreground"
    />
  );
}
