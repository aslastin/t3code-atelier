import { type Editor, InputRule, Mark as TiptapMark } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  type Selection,
  TextSelection,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactRenderer } from "@tiptap/react";

import { MarkdownLinkFavicon } from "~/components/chat/MarkdownExternalLink";
import { collapseMarkdownSource, parseInlineMarkdownRange } from "~/composer-markdown-source";
import { literalBackticksBefore } from "~/composer-rich-text-doc";
import { isComposerLinkHref, TYPED_LINK } from "~/composer-rich-text";

/** The destination a typed or pasted URL links to, or null when the composer cannot link it. */
export function normalizeComposerLinkHref(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  // Keep what the user wrote, escaping only what would end the Markdown destination.
  const href = withScheme.replace(/[()<>]/g, (char) => encodeURIComponent(char));
  return isComposerLinkHref(href) ? href : null;
}

function linkHost(href: string): string | null {
  try {
    return new URL(href).hostname || null;
  } catch {
    return null;
  }
}

/** Where each link starts, for the favicon drawn before its label. */
function linkStarts(doc: ProseMirrorNode): { pos: number; host: string }[] {
  const starts: { pos: number; host: string }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let previous: unknown = null;
    node.forEach((child, offset) => {
      const href = child.marks.find((mark) => mark.type.name === "link")?.attrs.href ?? null;
      const host = typeof href === "string" && href !== previous ? linkHost(href) : null;
      if (host) starts.push({ pos: pos + 1 + offset, host });
      previous = href;
    });
    return false;
  });
  return starts;
}

const faviconKey = new PluginKey<DecorationSet>("composer-link-favicons");

function faviconPlugin(editor: Editor): Plugin<DecorationSet> {
  const renderers = new WeakMap<Node, ReactRenderer>();
  const decorations = (doc: ProseMirrorNode) =>
    DecorationSet.create(
      doc,
      linkStarts(doc).map(({ pos, host }) =>
        Decoration.widget(
          pos,
          () => {
            // The same icon a sent message shows, rendered through the editor's portals.
            const renderer = new ReactRenderer(MarkdownLinkFavicon, {
              editor,
              props: { host },
              as: "span",
              className: "composer-link-favicon",
            });
            renderer.element.contentEditable = "false";
            renderers.set(renderer.element, renderer);
            return renderer.element;
          },
          {
            // After the caret at the link's start, which sits outside the link.
            side: 1,
            // Same host, same icon: an unchanged widget keeps its element.
            key: `composer-link-favicon:${host}`,
            ignoreSelection: true,
            destroy: (node) => renderers.get(node)?.destroy(),
          },
        ),
      ),
    );
  return new Plugin<DecorationSet>({
    key: faviconKey,
    state: {
      init: (_, state) => decorations(state.doc),
      apply: (tr, old) => (tr.docChanged ? decorations(tr.doc) : old),
    },
    props: {
      decorations: (state) => faviconKey.getState(state),
    },
  });
}

function inCode(state: EditorState, from: number, to: number): boolean {
  const code = state.schema.marks.code;
  return (
    state.doc.resolve(from).parent.type.spec.code === true ||
    (code !== undefined && state.doc.rangeHasMark(from, to, code))
  );
}

/** Styles `[label](https://…)` as a link when its closing `)` is typed. */
function typedLinkRule(): InputRule {
  return new InputRule({
    find: TYPED_LINK,
    handler: ({ state, range, match }) => {
      const href = match[2]!;
      const $from = state.doc.resolve(range.from);
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
      // `![label](url)` is an image, `\[` a literal bracket, and an open backtick a code span.
      if (
        before.endsWith("!") ||
        (/\\+$/.exec(before)?.[0].length ?? 0) % 2 === 1 ||
        literalBackticksBefore($from) % 2 === 1 ||
        inCode(state, range.from, range.to)
      ) {
        return null;
      }
      const { tr } = state;
      // Shown source inside the label, like a `**` just typed, is parsed into styles first.
      collapseMarkdownSource(tr);
      const from = tr.mapping.map(range.from, -1);
      const to = tr.mapping.map(range.to, 1);
      const tail = `](${href}`;
      const labelEnd = to - tail.length;
      if (
        labelEnd <= from + 1 ||
        tr.doc.textBetween(from, from + 1) !== "[" ||
        tr.doc.textBetween(labelEnd, to) !== tail
      ) {
        return null;
      }
      const type = tr.doc.type.schema.marks.link!;
      tr.delete(labelEnd, to).delete(from, from + 1);
      tr.addMark(from, labelEnd - 1, type.create({ href }));
      // Input rules for `**` need a space before them, so `[**bold**` is still plain text.
      const steps = tr.steps.length;
      parseInlineMarkdownRange(tr, { from, to: labelEnd - 1 });
      const end = tr.mapping.slice(steps).map(labelEnd - 1);
      tr.setSelection(TextSelection.create(tr.doc, end));
      return undefined;
    },
  });
}

/**
 * An inline Markdown link. It serializes as `[label](href)` and shows that
 * source while the caret is inside it, as other styles show their markers.
 */
export const ComposerLinkExtension = TiptapMark.create({
  name: "link",
  // Outermost, so a link wraps the styles inside its label.
  priority: 1100,
  inclusive: false,
  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element) => element.getAttribute("href"),
      },
    };
  },
  parseHTML() {
    return [{ tag: "a.composer-link[href]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "a",
      { href: HTMLAttributes.href, title: HTMLAttributes.href, class: "composer-link" },
      0,
    ];
  },
  addInputRules() {
    return [typedLinkRule()];
  },
  addProseMirrorPlugins() {
    return [faviconPlugin(this.editor), pendingLinkPlugin()];
  },
});

/** The range a link would cover, or null where one cannot go, such as across lines or in code. */
export function linkableRange(
  doc: ProseMirrorNode,
  selection: Selection,
): { from: number; to: number } | null {
  // Select All starts outside the text, so read the text it covers.
  const { from, to, $from, $to } = TextSelection.between(selection.$from, selection.$to);
  if (!$from.sameParent($to) || !$from.parent.inlineContent || $from.parent.type.spec.code) {
    return null;
  }
  let crossesLine = false;
  doc.nodesBetween(from, to, (node) => {
    if (node.type.name === "hardBreak") crossesLine = true;
    return !crossesLine;
  });
  return crossesLine ? null : { from, to };
}

/**
 * Links the selected text, or inserts the URL as its own label at a caret.
 * Returns false when the selection cannot hold a link.
 */
export function applyComposerLink(editor: Editor, href: string): boolean {
  const type = editor.schema.marks.link;
  if (!type) return false;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      collapseMarkdownSource(tr);
      const range = linkableRange(tr.doc, tr.selection);
      if (!range) return false;
      const { from, to } = range;
      const mark = type.create({ href });
      if (from === to) {
        tr.insert(from, tr.doc.type.schema.text(href, [mark]));
        tr.setSelection(TextSelection.create(tr.doc, from + href.length));
        return true;
      }
      tr.removeMark(from, to, type).addMark(from, to, mark);
      tr.setSelection(TextSelection.create(tr.doc, to));
      return true;
    })
    .scrollIntoView()
    .run();
}

const pendingLinkKey = new PluginKey<DecorationSet>("composer-link-pending");

/** Keeps the text being linked highlighted while focus is in the URL field. */
export function setPendingLink(editor: Editor, range: { from: number; to: number } | null) {
  editor.view.dispatch(editor.state.tr.setMeta(pendingLinkKey, range));
}

function pendingLinkPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: pendingLinkKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, old) => {
        const range = tr.getMeta(pendingLinkKey) as { from: number; to: number } | null | undefined;
        if (range === undefined) return old.map(tr.mapping, tr.doc);
        if (range === null || range.from === range.to) return DecorationSet.empty;
        return DecorationSet.create(tr.doc, [
          Decoration.inline(range.from, range.to, { class: "composer-link-pending" }),
        ]);
      },
    },
    props: {
      decorations: (state) => pendingLinkKey.getState(state),
    },
  });
}
