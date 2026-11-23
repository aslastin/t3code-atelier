import type { SelectedLineRange } from "@pierre/diffs";
import { useGT } from "gt-react";
import { type ComponentProps, type PointerEvent, useRef, useState } from "react";
import type { FileReviewExcerpt } from "~/reviewCommentContext";
import { readPagedSourceExcerpt } from "./fileCommentAnnotations";
import { useFileComments, type FileCommentTarget } from "./useFileComments";
import VirtualTablePreview from "./VirtualTablePreview";

export function PagedSourcePreview({
  commentTarget,
  ...table
}: ComponentProps<typeof VirtualTablePreview> & { commentTarget: FileCommentTarget }) {
  const gt = useGT();
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; start: number } | null>(null);
  // Keep the selected rows while the worker's page cache scrolls past them.
  const [excerpt, setExcerpt] = useState<FileReviewExcerpt>({
    firstLine: 1,
    lines: [],
  });
  const { fileProps, hasOpenCommentForm, setSelectedRange } = useFileComments({
    ...commentTarget,
    contents: excerpt,
    revealRequestId: table.revealRequestId ?? 0,
  });
  const select = (range: SelectedLineRange) => {
    const selected = readPagedSourceExcerpt(range, table.getRows);
    if (!selected) {
      setSelectedRange(null);
      return;
    }
    setExcerpt(selected);
    fileProps.options.onLineSelectionEnd(range);
  };

  const rangeAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return null;
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-preview-row]");
    if (!row || !event.currentTarget.contains(row)) return null;
    return { start: drag.current.start, end: Number(row.dataset.previewRow) + 1 };
  };

  const annotations = new Map(
    fileProps.lineAnnotations.map((annotation) => [annotation.lineNumber, annotation]),
  );
  // The worker may find a shorter file than the initial HTTP range contained.
  const displacedDraft =
    hasOpenCommentForm &&
    fileProps.lineAnnotations.find(
      (annotation) =>
        annotation.lineNumber > table.count &&
        annotation.metadata.entries.some((entry) => entry.kind === "draft"),
    );
  if (!table.count) return displacedDraft ? fileProps.renderAnnotation(displacedDraft) : null;
  return (
    <div
      ref={surface}
      className="flex min-h-0 flex-1 flex-col"
      onPointerMove={(event) => {
        const range = rangeAtPointer(event);
        if (range && range.end !== fileProps.selectedLines?.end) setSelectedRange(range);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const range = rangeAtPointer(event);
        drag.current = null;
        if (range) select(range);
        else setSelectedRange(null);
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        setSelectedRange(null);
      }}
    >
      <VirtualTablePreview
        {...table}
        selectedLines={fileProps.selectedLines}
        renderLineNumber={(line, loaded) => (
          <button
            type="button"
            className="w-full cursor-pointer touch-none text-right hover:text-primary focus-visible:text-primary disabled:cursor-default"
            disabled={!loaded || hasOpenCommentForm}
            aria-label={gt("Comment on lines {rangeLabel}", { rangeLabel: `L${line}` })}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0 || !surface.current) return;
              surface.current.setPointerCapture(event.pointerId);
              drag.current = { pointerId: event.pointerId, start: line };
              setSelectedRange({ start: line, end: line });
            }}
            onClick={(event) => {
              if (event.detail === 0) select({ start: line, end: line });
            }}
          >
            {line}
          </button>
        )}
        renderAnnotation={(line) => {
          const annotation = annotations.get(line);
          return annotation ? fileProps.renderAnnotation(annotation) : null;
        }}
      />
      {displacedDraft ? fileProps.renderAnnotation(displacedDraft) : null}
    </div>
  );
}
