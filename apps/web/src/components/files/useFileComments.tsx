import type { SelectedLineRange } from "@pierre/diffs";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { useState } from "react";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  buildFileReviewComment,
  type FileReviewExcerpt,
  type ReviewCommentContext,
} from "~/reviewCommentContext";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import {
  type FileCommentAnnotationEntry,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
  promptFileCommentEntries,
} from "./fileCommentAnnotations";

const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

export interface FileCommentTarget {
  environmentId: EnvironmentId;
  projectId?: ProjectId | undefined;
  composerDraftTarget: ScopedThreadRef | DraftId;
  filePath: string;
  onDraftChange?: ((open: boolean) => void) | undefined;
}

export function useFileComments({
  environmentId,
  projectId,
  composerDraftTarget,
  filePath,
  contents,
  revealRequestId,
  onBeginComment,
  onDraftChange,
  anchorAtPointer,
}: FileCommentTarget & {
  contents: string | FileReviewExcerpt;
  revealRequestId: number;
  onBeginComment?: () => void;
  anchorAtPointer?: boolean;
}) {
  const messages = useMessages();
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const promptComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const promptCommentIds = new Set(promptComments.map((comment) => comment.id));
  const [draftText, setDraftText] = useState("");
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<{
    revealRequestId: number;
    range: SelectedLineRange | null;
  } | null>(null);
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const setSelectedRange = (range: SelectedLineRange | null) => {
    setSelectionOverride({ revealRequestId, range });
  };

  const remapAfterEdit = (nextLineAnnotations: FileCommentLineAnnotation[], contents: string) => {
    const remapped = remapFileCommentAnnotations(nextLineAnnotations);
    // The editor hands back the array it was given until an edit moves an annotation.
    setLineAnnotations((current) => (current === nextLineAnnotations ? current : remapped));
    for (const annotation of remapped) {
      for (const entry of annotation.metadata.entries) {
        if (entry.kind !== "comment" || !promptCommentIds.has(entry.id)) continue;
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text: entry.text,
            contents,
          }),
        );
      }
    }
  };

  const removeAnnotationEntry = (entry: FileCommentAnnotationEntry) => {
    const entryId = entry.id;
    if (entry.kind === "draft") onDraftChange?.(false);
    setSelectedRange(null);
    removeReviewComment(composerDraftTarget, entryId);
    setLineAnnotations((current) => {
      return current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
    });
  };

  const submitAnnotationEntry = (entry: FileCommentAnnotationEntry, text: string) => {
    onDraftChange?.(false);
    setSelectedRange(null);
    addReviewComment(
      composerDraftTarget,
      buildFileReviewComment({
        id: entry.id,
        filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        text,
        contents,
      }),
    );
    setLineAnnotations((current) =>
      current.map((annotation) => ({
        ...annotation,
        metadata: {
          entries: annotation.metadata.entries.map((annotationEntry) =>
            annotationEntry.id === entry.id
              ? { ...annotationEntry, kind: "comment", text }
              : annotationEntry,
          ),
        },
      })),
    );
  };

  const beginComment = (range: SelectedLineRange) => {
    setDraftText("");
    onBeginComment?.();
    onDraftChange?.(true);
    const { startLine, endLine } = normalizeFileCommentRange(range);
    const anchorLine = anchorAtPointer ? range.end : endLine;
    const draftEntry: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: "draft",
      startLine,
      endLine,
      text: "",
    };
    setLineAnnotations((current) => {
      const withoutDraft = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const existingIndex = withoutDraft.findIndex(
        (annotation) => annotation.lineNumber === anchorLine,
      );
      if (existingIndex < 0) {
        return [
          ...withoutDraft,
          {
            lineNumber: anchorLine,
            metadata: { entries: [draftEntry] },
          },
        ];
      }
      return withoutDraft.map((annotation, index) =>
        index === existingIndex
          ? {
              ...annotation,
              metadata: { entries: [...annotation.metadata.entries, draftEntry] },
            }
          : annotation,
      );
    });
  };
  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );
  const handleLineSelectionEnd = (range: SelectedLineRange | null) => {
    setSelectedRange(range);
    if (range) {
      beginComment(range);
    }
  };

  const renderAnnotation = (annotation: FileCommentLineAnnotation) => {
    // Sent comments stay annotated so a failed send can restore them at remapped lines.
    const entries = promptFileCommentEntries(annotation.metadata.entries, promptCommentIds);
    if (entries.length === 0) return null;
    return (
      <div className="py-1">
        {entries.map((entry) => (
          <DiffCommentAnnotation
            key={entry.id}
            environmentId={environmentId}
            projectId={projectId}
            ownerKey={JSON.stringify([environmentId, composerDraftTarget, filePath, entry.id])}
            kind={entry.kind}
            rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine, messages)}
            text={entry.kind === "draft" ? draftText : entry.text}
            onTextChange={setDraftText}
            onCancel={() => removeAnnotationEntry(entry)}
            onComment={(text) => submitAnnotationEntry(entry, text)}
            onDelete={() => removeAnnotationEntry(entry)}
          />
        ))}
      </div>
    );
  };
  return {
    fileProps: {
      selectedLines: selectedRange,
      lineAnnotations,
      renderAnnotation,
      options: {
        enableGutterUtility: !hasOpenCommentForm,
        enableLineSelection: !hasOpenCommentForm,
        onGutterUtilityClick: setSelectedRange,
        onLineSelectionChange: setSelectedRange,
        onLineSelectionEnd: handleLineSelectionEnd,
      },
    },
    hasOpenCommentForm,
    promptComments,
    setSelectedRange,
    retainUnchangedAnnotations: (before: string, after: string) => {
      if (!lineAnnotations.length) return;
      const oldLines = before.split(/\r\n|\r|\n/);
      const newLines = after.split(/\r\n|\r|\n/);
      setLineAnnotations(
        lineAnnotations.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter(
            ({ startLine, endLine }) =>
              endLine <= newLines.length &&
              oldLines
                .slice(startLine - 1, endLine)
                .every((line, index) => newLines[startLine - 1 + index] === line),
          );
          return entries.length ? [{ ...annotation, metadata: { entries } }] : [];
        }),
      );
    },
    remapAfterEdit,
  };
}
