import { useState } from "react";

interface CommentEdit {
  readonly text: string;
  /** The text the editor opened with, so an untouched Save writes nothing. */
  readonly start: string;
}

/**
 * Unsaved edits of added comments, keyed by comment id. Owners of virtualized views keep them
 * here, above the rows, so an edit survives its row unmounting until Save or Cancel.
 */
export function useCommentEdits() {
  // A Map, since imported comment ids are arbitrary strings such as "constructor".
  const [edits, setEdits] = useState<ReadonlyMap<string, CommentEdit>>(() => new Map());
  return {
    for: (id: string) => ({
      editText: edits.get(id)?.text ?? null,
      editStartText: edits.get(id)?.start ?? null,
      onEditTextChange: (text: string | null) =>
        setEdits((current) => {
          const next = new Map(current);
          if (text === null) next.delete(id);
          else next.set(id, { text, start: current.get(id)?.start ?? text });
          return next;
        }),
    }),
  };
}
