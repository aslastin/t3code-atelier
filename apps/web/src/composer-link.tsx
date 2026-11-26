import {
  combineTransactionSteps,
  type Editor,
  getChangedRanges,
  InputRule,
  Mark as TiptapMark,
} from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import {
  AllSelection,
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  type Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ReactRenderer } from "@tiptap/react";
import { isPrivateNetworkHost, normalizeHostname } from "@t3tools/shared/hostClassification";

import { MarkdownLinkFavicon } from "~/components/chat/MarkdownExternalLink";
import {
  collapseMarkdownSource,
  hiddenSourceLinkStarts,
  parseInlineMarkdownRange,
} from "~/composer-markdown-source";
import { buildTiptapContent, serializeEditorDoc } from "~/composer-rich-text-doc";
import { caretLineDirection } from "~/composer-text-direction";
import {
  inlineMarkdownLinks,
  isComposerLinkHref,
  MARKDOWN_SOURCE_MARK,
  TYPED_LINK,
} from "~/composer-rich-text";

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;
// `localhost:3000` and `t3.codes:8080` are a host and port; `tel:911` and `mailto:1@a.b` are schemes.
const HOST_AND_PORT = /^(?:localhost|[^\s/:@]*\.[^\s/:@]*):\d+(?:[/?#]|$)/i;

/** The destination a typed or pasted URL links to, or null when the composer cannot link it. */
export function normalizeComposerLinkHref(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let withScheme = trimmed;
  if (!URL_SCHEME.test(trimmed) || HOST_AND_PORT.test(trimmed)) {
    let host: string;
    try {
      host = normalizeHostname(new URL(`http://${trimmed}`).hostname);
    } catch {
      return null;
    }
    // Local dev servers rarely serve TLS; Tailscale names usually do.
    const local = isPrivateNetworkHost(host) && !host.endsWith(".ts.net");
    withScheme = `${local ? "http" : "https"}://${trimmed}`;
  }
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  if (isComposerLinkHref(withScheme)) return withScheme;
  // Otherwise take the browser's own spelling, where `\` is `/` and `<>` are escaped,
  // and escape what would still end the Markdown destination.
  const escaped = url.href.replace(
    /[()\\]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return isComposerLinkHref(escaped) ? escaped : null;
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
  const widgets = (starts: { pos: number; host: string }[]) =>
    starts.map(({ pos, host }) =>
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
    );
  const decorations = (doc: ProseMirrorNode) => DecorationSet.create(doc, widgets(linkStarts(doc)));
  return new Plugin<DecorationSet>({
    key: faviconKey,
    state: {
      init: (_, state) => decorations(state.doc),
      apply: (tr, old) => (tr.docChanged ? decorations(tr.doc) : old),
    },
    props: {
      decorations: (state) => {
        const links = faviconKey.getState(state);
        const hidden = hiddenSourceLinkStarts(state).flatMap(({ pos, href }) => {
          const host = linkHost(href);
          return host ? [{ pos, host }] : [];
        });
        return hidden.length > 0 ? links?.add(state.doc, widgets(hidden)) : links;
      },
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

/** Backticks typed as plain text before `$pos` in its line, leaving out escaped ones. */
function unescapedBackticksBefore($pos: ResolvedPos): number {
  let count = 0;
  $pos.parent.forEach((node, offset) => {
    if (offset >= $pos.parentOffset) return;
    if (!node.isText) {
      count = 0;
      return;
    }
    // Backticks in code or in another link's label pair only there.
    if (node.marks.some((mark) => mark.type.spec.code || mark.type.name === "link")) return;
    const text = node.text!.slice(0, $pos.parentOffset - offset);
    count += [...text.matchAll(/(?<!\\)(?:\\\\)*(?<!`)`(?!`)/g)].length;
  });
  return count;
}

function linksWholeRange(doc: ProseMirrorNode, from: number, to: number, href: string) {
  let linked = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.marks.some((mark) => mark.attrs.href === href)) linked = false;
    return linked;
  });
  return linked;
}

/** Styles `[label](https://…)` as a link when its closing `)` is typed. */
function typedLinkRule(): InputRule {
  return new InputRule({
    find: TYPED_LINK,
    handler: ({ state, range, match }) => {
      const href = match[2]!;
      // Only the closing `)` may be new: text inserted in one go, like a paste, is not in
      // the document yet and stays as typed. The match starts before any selection it replaces.
      if (match[0].length - (state.selection.from - range.from) > 1) return null;
      const tail = `](${href}`;
      // Positions follow the match: the typed `)` may replace a selection or already be
      // in the document when an IME commits it. Labels hold no chips, so text lengths fit.
      const tailStart = range.from + 1 + match[1]!.length;
      const $from = state.doc.resolve(range.from);
      // A link before the `[` ends in `)` once written, whatever its label ends with.
      const linkBefore = $from.nodeBefore?.marks.some((mark) => mark.type.name === "link");
      const before = linkBefore
        ? ")"
        : $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
      const backslashes = /\\*$/.exec(before.endsWith("!") ? before.slice(0, -1) : before)![0];
      // `![label](url)` is an image and `\[` a literal bracket, unless that backslash is escaped.
      if (
        (before.endsWith("!") ? backslashes.length % 2 === 0 : backslashes.length % 2 === 1) ||
        unescapedBackticksBefore($from) % 2 === 1 ||
        inCode(state, range.from, range.from + 1) ||
        inCode(state, tailStart, tailStart + tail.length)
      ) {
        return null;
      }
      const { tr } = state;
      // Shown source inside the label, like a `**` just typed, is parsed into styles first.
      collapseMarkdownSource(tr);
      const from = tr.mapping.map(range.from, -1);
      const labelEnd = tr.mapping.map(tailStart, -1);
      const end = tr.mapping.map(range.to, 1);
      // Retyping a shown link's selected `)` over itself: parsing its source made the link.
      if (
        state.selection.to - state.selection.from === 1 &&
        from < end &&
        linksWholeRange(tr.doc, from, end, href)
      ) {
        tr.setSelection(TextSelection.create(tr.doc, end));
        return undefined;
      }
      const to = Math.max(end, labelEnd + tail.length);
      if (
        labelEnd <= from + 1 ||
        tr.doc.textBetween(from, from + 1) !== "[" ||
        tr.doc.textBetween(labelEnd, labelEnd + tail.length) !== tail
      ) {
        return null;
      }
      const type = tr.doc.type.schema.marks.link!;
      // Links cannot nest; linking `[[docs](a)](b)` would drop the inner destination.
      if (tr.doc.rangeHasMark(from + 1, labelEnd, type)) return null;
      // The `[` and `](address` are deleted, so they must be plain text, not part of a link.
      let styledTail = false;
      tr.doc.nodesBetween(labelEnd, labelEnd + tail.length, (node) => {
        if (node.isInline && node.marks.length > 0) styledTail = true;
        return !styledTail;
      });
      if (styledTail || tr.doc.rangeHasMark(from, from + 1, type)) return null;
      tr.delete(labelEnd, to).delete(from, from + 1);
      tr.addMark(from, labelEnd - 1, type.create({ href }));
      // Input rules for `**` need a space before them, so `[**bold**` is still plain text.
      const steps = tr.steps.length;
      parseInlineMarkdownRange(tr, { from, to: labelEnd - 1 });
      tr.setSelection(TextSelection.create(tr.doc, tr.mapping.slice(steps).map(labelEnd - 1)));
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
      href: { default: null },
    };
  },
  parseHTML() {
    // A destination the serializer cannot write would drop the link from the sent text.
    return [
      {
        tag: "a.composer-link[href]",
        getAttrs: (element) => {
          const href = element.getAttribute("href");
          return href !== null && isComposerLinkHref(href) ? { href } : false;
        },
      },
    ];
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
    return [
      faviconPlugin(this.editor),
      pendingLinkPlugin(),
      linkStartKeysPlugin(),
      editedLinkPlugin(),
    ];
  },
});

/** The range a link would cover, or null where one cannot go, such as across lines or in code. */
export function linkableRange(
  doc: ProseMirrorNode,
  selection: Selection,
): { from: number; to: number } | null {
  if (selection instanceof NodeSelection && !selection.node.isInline) return null;
  // Select All starts outside the text, so read the text it covers when it is one line.
  if (selection instanceof AllSelection && doc.childCount !== 1) return null;
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
 * Links the selection on `tr`, or inserts `href` as its own label at a caret.
 * Returns false, leaving the text unlinked, where the link would not survive
 * being sent and reloaded as Markdown.
 */
function linkSelection(tr: Transaction, href: string): boolean {
  const type = tr.doc.type.schema.marks.link;
  if (!type) return false;
  const selected = !tr.selection.empty;
  const source = tr.doc.type.schema.marks[MARKDOWN_SOURCE_MARK];
  const { $from: $caret } = tr.selection;
  // Parsing shown source moves a caret inside it, such as one in a link's address.
  if (
    !selected &&
    source &&
    [$caret.nodeBefore, $caret.nodeAfter].every((node) => node && source.isInSet(node.marks))
  ) {
    return false;
  }
  const { from: selectedFrom, to: selectedTo } = tr.selection;
  const steps = tr.steps.length;
  collapseMarkdownSource(tr);
  // Parsing shown source must not cut into the selection, as it does into a link's address.
  const mapping = tr.mapping.slice(steps);
  if (
    mapping.mapResult(selectedFrom).deletedAcross ||
    mapping.mapResult(selectedTo).deletedAcross
  ) {
    return false;
  }
  const range = linkableRange(tr.doc, tr.selection);
  if (!range) return false;
  // Source selected around a link's label collapses to nothing.
  if (selected && range.from === range.to) return false;
  const text = tr.doc.textBetween(range.from, range.to, undefined, "￼");
  const from = range.from + text.length - text.trimStart().length;
  const to = Math.max(from, range.to - (text.length - text.trimEnd().length));
  if (selected && from === to) return false;
  // A chip's source would join the label's brackets: a mention needs a space before it,
  // and a context reference is itself a link, which cannot nest.
  let holdsChip = false;
  tr.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.isText) holdsChip = true;
    return !holdsChip;
  });
  if (holdsChip) return false;
  // Check with an address no other text in the line links to, so the read-back below
  // tells this link apart from an existing one with the same address.
  const probeMark = type.create({ href: PROBE_HREF });
  const probe = new Transform(tr.doc);
  if (from === to) probe.insert(from, tr.doc.type.schema.text(href, [probeMark]));
  else probe.removeMark(from, to, type).addMark(from, to, probeMark);
  // Text such as `!`, `[` or a backtick elsewhere in the line can turn the written link
  // into an image, plain text or code, so read the line back as a reload would.
  if (!linkReadsBack(probe.doc.resolve(from).parent, PROBE_HREF)) return false;
  const mark = type.create({ href });
  if (from === to) tr.insert(from, tr.doc.type.schema.text(href, [mark]));
  else tr.removeMark(from, to, type).addMark(from, to, mark);
  tr.setSelection(TextSelection.create(tr.doc, from === to ? from + href.length : to));
  return true;
}

const PROBE_HREF = "https://t3-link-probe.invalid/";

/** Whether exactly the text linked to `href` in `block` is still linked to it once written as Markdown. */
function linkReadsBack(block: ProseMirrorNode, href: string): boolean {
  let linked = "";
  block.forEach((node) => {
    if (node.marks.some((mark) => mark.type.name === "link" && mark.attrs.href === href)) {
      linked += node.textContent;
    }
  });
  const { schema } = block.type;
  const line = schema.nodes.paragraph!.create(null, block.content);
  const markdown = serializeEditorDoc(schema.topNodeType.create(null, line)).value;
  let parsed = "";
  const visit = (json: Record<string, unknown>) => {
    const marks = (json.marks ?? []) as { type: string; attrs?: { href?: unknown } }[];
    if (json.type === "text" && marks.some((mark) => mark.attrs?.href === href)) {
      parsed += json.text as string;
    }
    for (const child of (json.content ?? []) as Record<string, unknown>[]) visit(child);
  };
  for (const block of buildTiptapContent(markdown, () => null, { blocks: false })) visit(block);
  return parsed === linked;
}

/** Whether Insert Link can link the current selection. */
export function canLinkSelection(state: EditorState): boolean {
  return linkSelection(state.tr, "https://example.com");
}

/** Links the selected text, or inserts the URL as its own label at a caret. */
export function applyComposerLink(editor: Editor, href: string): boolean {
  // Check before focusing, so a refused link leaves focus in the URL field.
  if (!linkSelection(editor.state.tr, href)) return false;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => linkSelection(tr, href))
    .scrollIntoView()
    .run();
}

/**
 * At the start of a line, Chromium gives the favicon before a link its own caret stop,
 * so the first forward key would only step over the icon. Move and delete by the
 * label's first character instead.
 */
function linkStartKeysPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        const forward = caretLineDirection(view.state) === "rtl" ? "ArrowLeft" : "ArrowRight";
        if (event.key !== forward && event.key !== "Delete") return false;
        if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return false;
        if (event.key === "Delete" && event.shiftKey) return false;
        const { selection } = view.state;
        if (!(selection instanceof TextSelection)) return false;
        if (event.key === "Delete" && !selection.empty) return false;
        if (!event.shiftKey && !selection.empty) return false;
        const { $head } = selection;
        const link = (node: ProseMirrorNode | null) =>
          node?.marks.find((mark) => mark.type.name === "link")?.attrs.href ?? null;
        const href = link($head.nodeAfter);
        if (!$head.nodeAfter?.isText || href === null || link($head.nodeBefore) === href) {
          return false;
        }
        const next = $head.pos + 1;
        const tr =
          event.key === "Delete"
            ? view.state.tr.delete($head.pos, next)
            : view.state.tr.setSelection(
                TextSelection.create(
                  view.state.doc,
                  event.shiftKey ? selection.anchor : next,
                  next,
                ),
              );
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

/**
 * An edit that completes a link in plain text, like adding brackets around existing
 * words or fixing its address, shows the link as source. Like any shown source, it
 * becomes a link once the caret is outside it. Undo and redo are left alone.
 */
function editedLinkPlugin(): Plugin {
  let view: EditorView | null = null;
  return new Plugin({
    view(editorView) {
      view = editorView;
      return {
        destroy() {
          view = null;
        },
      };
    },
    appendTransaction(transactions, oldState, state) {
      const source = state.schema.marks[MARKDOWN_SOURCE_MARK];
      if (!source || view?.composing || !transactions.some((tr) => tr.docChanged)) return null;
      if (
        transactions.some((tr) => isHistoryTransaction(tr) || tr.getMeta("addToHistory") === false)
      ) {
        return null;
      }
      // Backspace right after an input rule restores its Markdown as text on purpose.
      const inputRules = oldState.plugins.find((plugin) => plugin.spec.isInputRules);
      if (inputRules?.getState(oldState)) return null;
      const tr = state.tr;
      const checked = new Set<number>();
      const changes = getChangedRanges(combineTransactionSteps(oldState.doc, [...transactions]));
      for (const { newRange } of changes) {
        state.doc.nodesBetween(newRange.from, newRange.to, (block, pos) => {
          if (!block.isTextblock) return true;
          if (block.type.spec.code || checked.has(pos)) return false;
          checked.add(pos);
          const text = block.textBetween(0, block.content.size, undefined, "￼");
          for (const link of inlineMarkdownLinks(text)) {
            const from = pos + 1 + link.start;
            const to = pos + 1 + link.end;
            // Only an edit inside the link completes it; typing beside one leaves it alone.
            if (newRange.to <= from || newRange.from >= to) continue;
            // An open backtick before it is a code span still being typed.
            if (unescapedBackticksBefore(state.doc.resolve(from)) % 2 === 1) continue;
            let plain = true;
            state.doc.nodesBetween(from, to, (node) => {
              if (node.isInline && (!node.isText || node.marks.length > 0)) plain = false;
              return plain;
            });
            if (plain) tr.addMark(from, to, source.create());
          }
          return false;
        });
      }
      return tr.docChanged ? tr : null;
    },
  });
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
