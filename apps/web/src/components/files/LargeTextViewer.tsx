import { msg, T, useGT, useMessages } from "gt-react";
import { COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS } from "@t3tools/contracts";
import type { FileReviewExcerpt } from "~/reviewCommentContext";
import { clampContextText } from "~/lib/composerContextRecords";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";
import { m } from "~/i18n/messages";
import { useStableCallback } from "~/hooks/useStableCallback";
import { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { useClientSettings } from "~/hooks/useSettings";
import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { PREVIEW_PAGE_ROWS, type TextPreviewResult } from "./largeTextProtocol";
import { previewFailureText } from "./previewFailureMessages";
import { PagedSourcePreview } from "./PagedSourcePreview";
import type { FileCommentTarget } from "./useFileComments";
import VirtualTablePreview from "./VirtualTablePreview";

const FIRST_SCREEN_BYTES = 16 * 1024;

function firstScreen(text: string, delimiter: "," | "\t" | null, complete: boolean) {
  if (!text || text.includes("\0")) return [];
  const rows = delimiter
    ? parseDelimitedPreview(text, delimiter, {
        maxRows: PREVIEW_PAGE_ROWS * 2 + 1,
        maxColumns: 1024,
        maxCellLength: FIRST_SCREEN_BYTES,
      }).rows
    : text
        .replace(/\r?\n$|\r$/, "")
        .split(/\r\n|\n|\r/)
        .slice(0, PREVIEW_PAGE_ROWS * 2 + 1)
        .map((line) => [line]);
  // A byte range can end inside a quoted record or a UTF-8 character.
  if (!complete) rows.pop();
  return rows.slice(0, PREVIEW_PAGE_ROWS * 2);
}

export default function LargeTextViewer(props: {
  readonly name: string;
  readonly commentTarget?: FileCommentTarget | undefined;
  readonly src?: string;
  readonly text?: string;
  readonly sizeBytes?: number;
  readonly onRetry?: () => void;
  readonly copyContents?: RefObject<(() => Promise<string>) | null>;
  readonly delimiter: "," | "\t" | null;
  readonly revealLine?: number | null;
  readonly revealRequestId?: number;
  /** A preview's own wrap toggle; omitted follows the word wrap setting. */
  readonly wordWrap?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [meta, setMeta] = useState<Extract<TextPreviewResult, { type: "meta" }> | null>(null);
  const [pages, setPages] = useState(new Map<number, string[][]>());
  const [error, setError] = useState<string | null>(null);
  const { src, text, sizeBytes, delimiter } = props;
  const [source, setSource] = useState({ src, text, sizeBytes, delimiter, revision: 0 });
  if (
    source.src !== src ||
    source.text !== text ||
    source.sizeBytes !== sizeBytes ||
    source.delimiter !== delimiter
  ) {
    setSource({ src, text, sizeBytes, delimiter, revision: source.revision + 1 });
    setError(null);
    setMeta(null);
    setPages(new Map());
  }
  const worker = useRef<Worker | null>(null);
  const excerptId = useRef(0);
  const excerpts = useRef(new Map<number, (result: FileReviewExcerpt | Error) => void>());
  const readExcerpt = useStableCallback(
    (firstLine: number, lastLine: number, ready: (result: FileReviewExcerpt | Error) => void) => {
      const id = ++excerptId.current;
      if (worker.current) {
        excerpts.current.set(id, ready);
        worker.current.postMessage(
          {
            type: "excerpt",
            requestId: id,
            firstLine,
            lastLine,
            maxChars: COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS + 1,
          },
          [],
        );
      } else ready(new Error(m(msg("The file is unavailable."))));
      return () => {
        excerpts.current.delete(id);
      };
    },
  );
  const copyPending = useRef<{
    resolve: (text: string) => void;
    reject: (cause: Error) => void;
  } | null>(null);
  const pending = useRef(new Set<number>());
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const wordWrap = props.wordWrap ?? defaultWordWrap;
  const isCurrentSource = useEffectEvent((opened: typeof source) => opened === source);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the prefix fetch and indexing worker, cancelling requests and pending copies when the source changes or unmounts.
  useEffect(() => {
    const controller = new AbortController();
    // The next source can commit before React runs this worker's cleanup.
    const isStale = () => controller.signal.aborted || !isCurrentSource(source);
    let indexed = false;
    let prefetched = false;
    let replacementMeta: typeof meta = null;
    const failReads = (cause: Error) => {
      copyPending.current?.reject(cause);
      copyPending.current = null;
      for (const ready of excerpts.current.values()) ready(cause);
      excerpts.current.clear();
    };
    const paintFirstScreen = (text: string, complete: boolean) => {
      if (indexed || isStale()) return;
      const rows = firstScreen(text, source.delimiter, complete);
      if (!rows.length) return;
      prefetched = true;
      setPages(
        new Map(
          [0, PREVIEW_PAGE_ROWS]
            .filter((start) => start < rows.length)
            .map((start) => [
              start / PREVIEW_PAGE_ROWS,
              rows.slice(start, start + PREVIEW_PAGE_ROWS),
            ]),
        ),
      );
      setMeta({
        type: "meta",
        count: rows.length,
        columns: rows.reduce((max, row) => Math.max(max, row.length), 1),
        complete: false,
      });
    };
    const startWorker = () => {
      if (isStale()) return;
      const engine = new Worker(new URL("./largeText.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current = engine;
      const failWorker = (cause: Error, message?: string) => {
        engine.terminate();
        worker.current = null;
        failReads(cause);
        setError(message ?? cause.message);
      };
      engine.addEventListener("message", (event: MessageEvent<TextPreviewResult>) => {
        if (isStale() || worker.current !== engine) return;
        const result = event.data;
        if (result.type === "excerpt") {
          excerpts.current.get(result.requestId)?.({
            firstLine: result.firstLine,
            lastLine: result.lastLine,
            text: clampContextText(result.text, COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS),
          });
          excerpts.current.delete(result.requestId);
        } else if (result.type === "copy") {
          copyPending.current?.resolve(result.text);
          copyPending.current = null;
        } else if (result.type === "error") {
          const cause = new Error(previewFailureText(result));
          if (result.operation === "excerpt") {
            excerpts.current.get(result.requestId)?.(cause);
            excerpts.current.delete(result.requestId);
          } else if (result.operation === "copy") {
            copyPending.current?.reject(cause);
            copyPending.current = null;
          } else {
            failWorker(cause);
          }
        } else if (result.type === "meta") {
          indexed = true;
          if (prefetched) {
            // Replace the prefix and its metadata together so open annotations stay mounted.
            if (result.count > 0) {
              replacementMeta = result;
              return;
            }
            setPages(new Map());
            pending.current.clear();
            prefetched = false;
          }
          setMeta(result);
        } else if (result.type === "page") {
          if (replacementMeta && result.index === 0) {
            setMeta(replacementMeta);
            setPages(new Map([[0, result.rows]]));
            replacementMeta = null;
            pending.current.clear();
            prefetched = false;
            return;
          }
          pending.current.delete(result.index);
          setPages((old) => {
            const previous = old.get(result.index);
            if (
              previous?.length === result.rows.length &&
              previous.every(
                (row, index) =>
                  row.length === result.rows[index]!.length &&
                  row.every((cell, column) => cell === result.rows[index]![column]),
              )
            )
              return old;
            const next = new Map(old);
            next.delete(result.index);
            next.set(result.index, result.rows);
            if (next.size > 12) next.delete([...next.keys()].find((key) => key !== 0)!);
            return next;
          });
        }
      });
      engine.addEventListener("error", () => {
        if (isStale() || worker.current !== engine) return;
        failWorker(
          new Error(m(msg("The text viewer stopped."))),
          m(msg("Could not load the text viewer. Close the file and try again.")),
        );
      });
      engine.postMessage(
        {
          type: "open",
          src: source.src,
          text: source.text,
          sizeBytes: source.sizeBytes,
          delimiter: source.delimiter,
        },
        [],
      );
    };
    const scheduleWorker = () => {
      if (prefetched) requestAnimationFrame(() => requestAnimationFrame(startWorker));
      else startWorker();
    };
    // Only this bounded prefix is parsed on the main thread. Indexing the full
    // file and fetching later pages remain in the worker.
    if (source.sizeBytes === 0) {
      startWorker();
    } else if (source.text !== undefined) {
      paintFirstScreen(
        source.text.slice(0, FIRST_SCREEN_BYTES),
        source.text.length <= FIRST_SCREEN_BYTES,
      );
      scheduleWorker();
    } else if (source.src) {
      void fetch(source.src, {
        headers: { Range: `bytes=0-${FIRST_SCREEN_BYTES - 1}` },
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (
            !response.ok ||
            Number(response.headers.get("content-length")) > FIRST_SCREEN_BYTES ||
            response.status !== 206
          ) {
            await response.body?.cancel();
            return;
          }
          const total = Number(response.headers.get("content-range")?.split("/")[1]);
          paintFirstScreen(await response.text(), total <= FIRST_SCREEN_BYTES);
        })
        .catch(() => {
          // The worker reports authorization, network and format failures.
        })
        .finally(scheduleWorker);
    } else startWorker();
    return () => {
      controller.abort();
      failReads(new DOMException(m(msg("Preview closed.")), "AbortError"));
      worker.current?.terminate();
      worker.current = null;
      pending.current.clear();
    };
  }, [source]);
  useImperativeHandle(
    props.copyContents,
    () => () =>
      new Promise<string>((resolve, reject) => {
        if (!worker.current) {
          reject(new Error(m(msg("The file is unavailable."))));
          return;
        }
        if (copyPending.current) {
          reject(new Error(m(msg("Another copy is in progress."))));
          return;
        }
        copyPending.current = { resolve, reject };
        worker.current.postMessage({ type: "copy" }, []);
      }),
    [],
  );
  const fallback = error ? (
    <FileSurfaceFailure message={error} {...(props.onRetry ? { onRetry: props.onRetry } : {})} />
  ) : !meta || (meta.count > 0 && !pages.has(0)) ? (
    <FileSurfaceLoading />
  ) : null;
  const header = props.delimiter ? pages.get(0)?.[0] : undefined;
  const rowCount = Math.max(0, (meta?.count ?? 0) - 1);
  const columnCount = meta?.count ? meta.columns : 0;
  const count = fallback ? 0 : (meta?.count ?? 0);
  const tableProps = {
    name: props.name,
    count,
    columns: meta?.columns ?? 1,
    header,
    source: !props.delimiter,
    wrap: wordWrap,
    revealLine: meta?.complete ? (props.revealLine ?? null) : null,
    revealRequestId: props.revealRequestId ?? 0,
    getRows: (page: number) => pages.get(page),
    loadPage: (page: number) => {
      if (pending.current.has(page)) return;
      pending.current.add(page);
      worker.current?.postMessage({ type: "page", index: page });
    },
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {fallback ??
        (meta && (
          <div
            className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-1 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground tabular-nums"
            role="status"
          >
            {props.delimiter
              ? `${gt("{count, plural, one {{formatted} row} other {{formatted} rows}}", {
                  count: rowCount,
                  formatted: rowCount.toLocaleString(),
                })} · ${gt(
                  "{count, plural, one {{formatted} column} other {{formatted} columns}}",
                  {
                    count: columnCount,
                    formatted: columnCount.toLocaleString(),
                  },
                )}`
              : gt("{count, plural, one {{formatted} line} other {{formatted} lines}}", {
                  count: meta.count,
                  formatted: meta.count.toLocaleString(),
                })}
            {meta.complete && meta.sizeBytes !== undefined
              ? ` · ${meta.sizeBytes === 0 ? gt("0 bytes") : formatAttachmentSize(meta.sizeBytes, messages)}`
              : ` · ${gt("Indexing…")}`}
          </div>
        ))}
      {!fallback && meta && !meta.complete ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
          <FileSurfaceNotice>
            <T>Loading the rest of the file…</T>
          </FileSurfaceNotice>
        </div>
      ) : null}
      {!fallback && meta?.columns === 1024 ? (
        <FileSurfaceNotice>
          <T>Showing the first 1,024 columns. Source and Save retain every column.</T>
        </FileSurfaceNotice>
      ) : null}
      {props.commentTarget && !props.delimiter ? (
        <PagedSourcePreview
          {...tableProps}
          commentTarget={props.commentTarget}
          indexed={meta?.complete === true && !fallback}
          sourceRevision={source.revision}
          readExcerpt={readExcerpt}
        />
      ) : count > 0 ? (
        <VirtualTablePreview {...tableProps} />
      ) : null}
      {!fallback && meta?.count === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
          <T>This file is empty.</T>
        </div>
      ) : null}
    </div>
  );
}
