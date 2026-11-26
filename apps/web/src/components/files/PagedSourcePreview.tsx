import type { SelectedLineRange } from "@pierre/diffs";
import { useGT } from "gt-react";
import { PlusIcon } from "lucide-react";
import {
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { FileReviewExcerpt, ReviewCommentContext } from "~/reviewCommentContext";
import { cn } from "~/lib/utils";
import { useStableCallback } from "~/hooks/useStableCallback";
import { readPagedSourceExcerpt } from "./fileCommentAnnotations";
import { useFileComments, type FileCommentTarget } from "./useFileComments";
import VirtualTablePreview from "./VirtualTablePreview";
import { toastManager } from "~/components/ui/toast";

type ReadExcerpt = (
  firstLine: number,
  lastLine: number,
  ready: (result: FileReviewExcerpt | Error) => void,
) => () => void;

// Keep the same textarea, selection and dictation session when its virtual row leaves the DOM.
function moveDraftHost(host: HTMLDivElement, parent: HTMLDivElement | null) {
  if (!parent || parent === host.parentElement) return;
  if (parent.moveBefore && parent.isConnected && host.isConnected) {
    parent.moveBefore(host, null);
    return;
  }
  const focused = host.ownerDocument.activeElement;
  const selection =
    focused instanceof HTMLTextAreaElement && host.contains(focused)
      ? ([focused.selectionStart, focused.selectionEnd, focused.selectionDirection] as const)
      : null;
  parent.appendChild(host);
  if (focused instanceof HTMLElement && host.contains(focused)) {
    focused.focus({ preventScroll: true });
    if (focused instanceof HTMLTextAreaElement && selection)
      focused.setSelectionRange(...selection);
  }
}

function MatchingFileComment({
  comment,
  readExcerpt,
  getRows,
  indexed,
  children,
}: {
  comment: ReviewCommentContext;
  readExcerpt: ReadExcerpt;
  getRows: ComponentProps<typeof VirtualTablePreview>["getRows"];
  indexed: boolean;
  children: ReactNode;
}) {
  const start = comment.startIndex + 1;
  const end = comment.endIndex + 1;
  const cached = readPagedSourceExcerpt({ start, end }, getRows);
  const [verified, setVerified] = useState<ReviewCommentContext | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The worker checks an annotation's range when it spans evicted pages.
  useEffect(() => {
    if (cached || !indexed) return;
    return readExcerpt(start, end, (result) => {
      setVerified(!(result instanceof Error) && result.text === comment.diff ? comment : null);
    });
  }, [start, end, comment, cached, indexed, readExcerpt]);
  return (cached ? cached.text === comment.diff : indexed && verified === comment)
    ? children
    : null;
}

export function PagedSourcePreview({
  commentTarget,
  readExcerpt,
  indexed,
  sourceRevision,
  ...table
}: ComponentProps<typeof VirtualTablePreview> & {
  commentTarget: FileCommentTarget;
  readExcerpt: ReadExcerpt;
  indexed: boolean;
  sourceRevision: number;
}) {
  const gt = useGT();
  const surface = useRef<HTMLDivElement>(null);
  const [draftHost] = useState(() => document.createElement("div"));
  const footer = useRef<HTMLDivElement | null>(null);
  const attachFooter = useStableCallback((node: HTMLDivElement | null) => {
    footer.current = node;
    if (node && !draftHost.isConnected) node.appendChild(draftHost);
  });
  const attachInline = useStableCallback((node: HTMLDivElement | null) => {
    moveDraftHost(draftHost, node ?? footer.current);
  });
  const drag = useRef<{ pointerId: number; start: number; end: number } | null>(null);
  // Keep the selected rows while the worker's page cache scrolls past them.
  const [selection, setSelection] = useState<{
    excerpt: FileReviewExcerpt;
    revision: number;
  } | null>(null);
  const [reading, setReading] = useState(false);
  const { fileProps, hasOpenCommentForm, setSelectedRange, promptComments } = useFileComments({
    ...commentTarget,
    anchorAtPointer: true,
    contents: selection?.excerpt ?? "",
    revealRequestId: table.revealRequestId ?? 0,
  });
  const select = (range: SelectedLineRange) => {
    if (hasOpenCommentForm || reading) return;
    const selected = readPagedSourceExcerpt(range, table.getRows);
    const open = (excerpt: FileReviewExcerpt | Error) => {
      setReading(false);
      if (excerpt instanceof Error) {
        setSelectedRange(null);
        if (excerpt.name !== "AbortError")
          toastManager.add({
            type: "error",
            title: gt("Could not read file"),
            description: excerpt.message,
          });
        return;
      }
      setSelection({ excerpt, revision: sourceRevision });
      fileProps.options.onLineSelectionEnd(range);
    };
    if (selected) open(selected);
    else {
      setReading(true);
      readExcerpt(Math.min(range.start, range.end), Math.max(range.start, range.end), open);
    }
  };

  const rangeAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return null;
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-preview-row]");
    if (row && event.currentTarget.contains(row)) active.end = Number(row.dataset.previewRow) + 1;
    return { start: active.start, end: active.end };
  };

  const anchors = new Map(
    fileProps.lineAnnotations.flatMap((annotation) =>
      annotation.metadata.entries.map((entry) => [entry.id, annotation.lineNumber] as const),
    ),
  );
  const byLine = new Map<number, ReviewCommentContext[]>();
  for (const comment of promptComments) {
    if (
      comment.filePath !== commentTarget.filePath ||
      (comment.sectionId !== `file:${comment.filePath}` &&
        !comment.sectionId.startsWith("file-sha256:")) ||
      comment.endIndex >= table.count
    )
      continue;
    const line = anchors.get(comment.id) ?? comment.endIndex + 1;
    const group = byLine.get(line);
    if (group) group.push(comment);
    else byLine.set(line, [comment]);
  }
  const openDraft =
    hasOpenCommentForm &&
    fileProps.lineAnnotations.find((annotation) =>
      annotation.metadata.entries.some((entry) => entry.kind === "draft"),
    );
  const form = openDraft
    ? fileProps.renderAnnotation({
        ...openDraft,
        metadata: { entries: openDraft.metadata.entries.filter((entry) => entry.kind === "draft") },
      })
    : null;
  // Keep the original draft accessible if Retry opens another revision or indexing removes its row.
  const displaced =
    openDraft && (selection?.revision !== sourceRevision || openDraft.lineNumber > table.count);
  return (
    <div
      ref={surface}
      className={cn("flex min-h-0 flex-col", table.count > 0 && "flex-1")}
      onPointerMove={(event) => {
        const range = rangeAtPointer(event);
        if (range && range.end !== fileProps.selectedLines?.end) setSelectedRange(range);
      }}
      onPointerUp={(event) => {
        const range = rangeAtPointer(event);
        if (!range) return;
        drag.current = null;
        select(range);
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        setSelectedRange(null);
      }}
    >
      <div ref={attachFooter} className="order-last max-h-full overflow-y-auto" />
      {form && createPortal(form, draftHost)}
      {table.count > 0 && (
        <VirtualTablePreview
          key={sourceRevision}
          {...table}
          selectedLines={fileProps.selectedLines}
          renderLineNumber={(line, loaded) => (
            <button
              type="button"
              className="group/comment relative w-full cursor-pointer touch-none text-right hover:text-primary focus-visible:text-primary disabled:cursor-default disabled:[&>svg]:hidden"
              disabled={!loaded || hasOpenCommentForm || reading}
              aria-label={gt("Comment on lines {rangeLabel}", { rangeLabel: `L${line}` })}
              onPointerDown={(event) => {
                if (
                  event.currentTarget.disabled ||
                  !event.isPrimary ||
                  event.button !== 0 ||
                  !surface.current
                )
                  return;
                surface.current.setPointerCapture(event.pointerId);
                drag.current = { pointerId: event.pointerId, start: line, end: line };
                setSelectedRange({ start: line, end: line });
              }}
              onClick={(event) => {
                if (event.detail === 0) select({ start: line, end: line });
              }}
            >
              {line}
              <PlusIcon
                aria-hidden="true"
                className={cn(
                  "invisible absolute top-1/2 left-full ml-px size-5 -translate-y-1/2 rounded-sm bg-file-comment-gutter p-0.5 text-background",
                  fileProps.selectedLines
                    ? line === fileProps.selectedLines.end && "visible"
                    : "group-hover/line:visible group-focus-visible/comment:visible",
                )}
              />
            </button>
          )}
          renderAnnotation={(line) => {
            const comments = byLine.get(line);
            const draft =
              openDraft && !displaced && openDraft.lineNumber === line ? (
                <div ref={attachInline} />
              ) : null;
            if (!comments) return draft;
            return (
              <>
                {comments.map((comment) => {
                  const start = comment.startIndex + 1;
                  const end = comment.endIndex + 1;
                  const node = fileProps.renderAnnotation({
                    lineNumber: line,
                    metadata: {
                      entries: [
                        {
                          id: comment.id,
                          kind: "comment",
                          startLine: start,
                          endLine: end,
                          text: comment.text,
                        },
                      ],
                    },
                  });
                  return (
                    <MatchingFileComment
                      key={comment.id}
                      comment={comment}
                      readExcerpt={readExcerpt}
                      getRows={table.getRows}
                      indexed={indexed}
                    >
                      {node}
                    </MatchingFileComment>
                  );
                })}
                {draft}
              </>
            );
          }}
        />
      )}
    </div>
  );
}
