import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { FileReviewExcerpt } from "~/reviewCommentContext";
import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";

export interface FileCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileCommentAnnotationGroup {
  entries: FileCommentAnnotationEntry[];
}

export type FileCommentLineAnnotation = LineAnnotation<FileCommentAnnotationGroup>;

let fileCommentSequence = 0;

export function nextFileCommentId(): string {
  fileCommentSequence += 1;
  return `file-comment-${Date.now()}-${fileCommentSequence}`;
}

export function normalizeFileCommentRange(range: SelectedLineRange): {
  startLine: number;
  endLine: number;
} {
  return {
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

export function readPagedSourceExcerpt(
  range: SelectedLineRange,
  getRows: (page: number) => readonly (readonly string[])[] | undefined,
): FileReviewExcerpt | undefined {
  const { startLine, endLine } = normalizeFileCommentRange(range);
  const lines: string[] = [];
  for (let index = startLine - 1; index < endLine; index++) {
    const row = getRows(Math.floor(index / PREVIEW_PAGE_ROWS))?.[index % PREVIEW_PAGE_ROWS];
    if (row?.[0] === undefined) return undefined;
    lines.push(row[0]);
  }
  return { firstLine: startLine, lines };
}

export function formatFileCommentRange(
  startLine: number,
  endLine: number,
  resolve: MessageResolver = m,
): string {
  return startLine === endLine
    ? `L${startLine}`
    : resolve(msg("L{start} to L{end}", { start: String(startLine), end: String(endLine) }));
}

export function remapFileCommentAnnotations(
  annotations: ReadonlyArray<FileCommentLineAnnotation>,
): FileCommentLineAnnotation[] {
  return annotations.map((annotation) => ({
    ...annotation,
    metadata: {
      entries: annotation.metadata.entries.map((entry) => {
        const lineCount = entry.endLine - entry.startLine;
        return {
          ...entry,
          endLine: annotation.lineNumber,
          startLine: Math.max(1, annotation.lineNumber - lineCount),
        };
      }),
    },
  }));
}

/** Drafts and the comments still in the prompt; sent or removed ones are not shown or re-added. */
export function promptFileCommentEntries(
  entries: ReadonlyArray<FileCommentAnnotationEntry>,
  promptCommentIds: ReadonlySet<string>,
): FileCommentAnnotationEntry[] {
  return entries.filter((entry) => entry.kind === "draft" || promptCommentIds.has(entry.id));
}
