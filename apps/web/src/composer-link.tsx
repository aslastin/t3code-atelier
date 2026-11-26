import { type Editor, InputRule, Mark as TiptapMark } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  type Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactRenderer } from "@tiptap/react";
import { isPrivateNetworkHost, normalizeHostname } from "@t3tools/shared/hostClassification";

import { MarkdownLinkFavicon } from "~/components/chat/MarkdownExternalLink";
import {
  collapseMarkdownSource,
  hiddenSourceLinkStarts,
  parseInlineMarkdownRange,
} from "~/composer-markdown-source";
import { inlineMarkdownRoundTrips, literalBackticksBefore } from "~/composer-rich-text-doc";
import { isComposerLinkHref, TYPED_LINK } from "~/composer-rich-text";

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;
// `localhost:3000` is a host and port, not a `localhost:` scheme; `mailto:1@a.b` is a scheme.
const HOST_AND_PORT = /^[^\s/:@]+:\d+(?:[/?#]|$)/;

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
  // Keep what the user wrote unless a character would end the Markdown destination.
  const escaped = withScheme.replace(
    /[()<>\\]/g,
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
      const tail = `](${href}`;
      // Positions follow the match: the typed `)` may replace a selection or already be
      // in the document when an IME commits it. Labels hold no chips, so text lengths fit.
      const tailStart = range.from + 1 + match[1]!.length;
      const $from = state.doc.resolve(range.from);
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
      const backslashes = /\\*$/.exec(before.endsWith("!") ? before.slice(0, -1) : before)![0];
      // `![label](url)` is an image and `\[` a literal bracket, unless that backslash is escaped.
      if (
        (before.endsWith("!") ? backslashes.length % 2 === 0 : backslashes.length % 2 === 1) ||
        literalBackticksBefore($from) % 2 === 1 ||
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
      // Retyping a shown link's `)` over itself: parsing its source already made the link.
      if (from < end && linksWholeRange(tr.doc, from, end, href)) {
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
    return [faviconPlugin(this.editor), pendingLinkPlugin()];
  },
});

/** The range a link would cover, or null where one cannot go, such as across lines or in code. */
export function linkableRange(
  doc: ProseMirrorNode,
  selection: Selection,
): { from: number; to: number } | null {
  if (selection instanceof NodeSelection && !selection.node.isInline) return null;
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
 * Links the selection on `tr`, or inserts `href` as its own label at a caret.
 * Returns false, leaving the text unlinked, where the link would not survive
 * being sent and reloaded as Markdown.
 */
function linkSelection(tr: Transaction, href: string): boolean {
  const type = tr.doc.type.schema.marks.link;
  if (!type) return false;
  const selected = !tr.selection.empty;
  collapseMarkdownSource(tr);
  const range = linkableRange(tr.doc, tr.selection);
  if (!range) return false;
  // Source selected around a link's label, like its address, collapses to nothing.
  if (selected && range.from === range.to) return false;
  const text = tr.doc.textBetween(range.from, range.to, undefined, "￼");
  const from = range.from + text.length - text.trimStart().length;
  const to = Math.max(from, range.to - (text.length - text.trimEnd().length));
  if (selected && from === to) return false;
  // A chip's source runs to the next space, so one ending a label would swallow `](`.
  const last = tr.doc.resolve(to).nodeBefore;
  if (from < to && last && !last.isText) return false;
  const mark = type.create({ href });
  const probe = new Transform(tr.doc);
  if (from === to) probe.insert(from, tr.doc.type.schema.text(href, [mark]));
  else probe.removeMark(from, to, type).addMark(from, to, mark);
  // Text such as `!`, `[` or a partly linked code span would read back as something else.
  const block = tr.doc.resolve(from).parent;
  if (
    inlineMarkdownRoundTrips(block) &&
    !inlineMarkdownRoundTrips(probe.doc.resolve(from).parent)
  ) {
    return false;
  }
  for (const step of probe.steps) tr.step(step);
  tr.setSelection(TextSelection.create(tr.doc, from === to ? from + href.length : to));
  return true;
}

/** Whether Insert Link can link the current selection. */
export function canLinkSelection(state: EditorState): boolean {
  return linkSelection(state.tr, "https://example.com");
}

/** Links the selected text, or inserts the URL as its own label at a caret. */
export function applyComposerLink(editor: Editor, href: string): boolean {
  if (!canLinkSelection(editor.state)) return false;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => linkSelection(tr, href))
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
