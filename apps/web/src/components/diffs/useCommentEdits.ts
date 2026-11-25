import { useState } from "react";

/**
 * Unsaved edits of added comments, keyed by comment id. Owners of virtualized views keep them
 * here, above the rows, so an edit survives its row unmounting until Save or Cancel.
 */
export function useCommentEdits() {
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  return {
    ids: Object.keys(edits),
    for: (id: string) => ({
      editText: edits[id] ?? null,
      onEditTextChange: (text: string | null) =>
        setEdits((current) => {
          if (text !== null) return { ...current, [id]: text };
          return Object.fromEntries(Object.entries(current).filter(([key]) => key !== id));
        }),
    }),
  };
}
