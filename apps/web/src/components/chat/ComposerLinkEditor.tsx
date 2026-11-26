import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useGT } from "gt-react";
import { useState } from "react";

import { normalizeComposerLinkHref } from "~/composer-link";

import { Popover, PopoverPopup } from "../ui/popover";
import { Textarea } from "../ui/textarea";

/** The URL field Insert Link opens under the selected text. */
export function ComposerLinkEditor({
  anchor,
  onApply,
  onClose,
}: {
  anchor: PopoverPrimitive.Positioner.Props["anchor"];
  /** False when the link could not be applied; the field stays open. */
  onApply: (href: string) => boolean;
  /** Escape restores the selection; a press elsewhere leaves focus where it went. */
  onClose: (restoreSelection: boolean) => void;
}) {
  const gt = useGT();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        align="start"
        padding="compact"
        width="md"
        finalFocus={false}
        data-composer-link-editor="true"
      >
        <Textarea
          rows={1}
          size="sm"
          value={value}
          placeholder={gt("Paste or type a link")}
          aria-label={gt("Link URL")}
          aria-invalid={invalid || undefined}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            // A URL is one line; a pasted line break would only split it.
            setValue(event.target.value.replace(/\r?\n/g, ""));
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            // The composer and chat shortcuts must not see keys typed into the field.
            event.stopPropagation();
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") {
              event.preventDefault();
              onClose(true);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const href = normalizeComposerLinkHref(value);
              if (href === null || !onApply(href)) setInvalid(true);
            }
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}
