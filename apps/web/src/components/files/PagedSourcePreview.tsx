import type { SelectedLineRange } from "@pierre/diffs";
import { useGT } from "gt-react";
import { type ComponentProps, type PointerEvent, useState } from "react";
import type { FileReviewExcerpt } from "~/reviewCommentContext";
import { readPagedSourceExcerpt } from "./fileCommentAnnotations";
import { useFileComments, type FileCommentTarget } from "./useFileComments";
import VirtualTablePreview from "./VirtualTablePreview";

export function PagedSourcePreview({
  commentTarget,
  ...table
}: ComponentProps<typeof VirtualTablePreview> & { commentTarget: FileCommentTarget }) {
  const gt = useGT();
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

  const rangeAtPointer = (event: PointerEvent<HTMLButtonElement>, start: number) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return null;
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-preview-row]");
    if (!row || !event.currentTarget.closest('[role="region"]')?.contains(row)) return null;
    return { start, end: Number(row.dataset.previewRow) + 1 };
  };

  const annotations = new Map(
    fileProps.lineAnnotations.map((annotation) => [annotation.lineNumber, annotation]),
  );
  return (
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
            if (!event.isPrimary || event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setSelectedRange({ start: line, end: line });
          }}
          onPointerMove={(event) => {
            const range = rangeAtPointer(event, line);
            if (range && range.end !== fileProps.selectedLines?.end) setSelectedRange(range);
          }}
          onPointerUp={(event) => {
            const range = rangeAtPointer(event, line);
            if (range) select(range);
            else setSelectedRange(null);
          }}
          onPointerCancel={() => setSelectedRange(null)}
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
  );
}
