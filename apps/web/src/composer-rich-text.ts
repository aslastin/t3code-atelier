export type RichTextMark = "bold" | "italic" | "strike" | "code" | "link";

interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
  /** The destination of a `link` mark. */
  href?: string;
}

export const RICH_TEXT_DELIMITERS: Record<Exclude<RichTextMark, "link">, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

/** A run of `text` from `start` to `end` that parses with `marks`. */
interface SourcePiece {
  start: number;
  end: number;
  marks: RichTextMark[];
  href?: string;
}

// The composer styles only web links: one level of balanced parentheses, as in Wikipedia URLs.
// A blank label would serialize as bare spaces and lose its destination.
const LINK_LABEL = String.raw`(?!\s*\])(?:\\.|[^\\\[\]\n])+`;
// Backslash escapes are left out rather than unescaped. U+FFFC and the private use area
// stand in for chips while parsing, so a chip cannot hide inside a destination.
const URL_CHAR = String.raw`[^\s()<>\\\uFFFC\uE000-\uF8FF]`;
const LINK_DESTINATION = String.raw`https?:\/\/(?:${URL_CHAR}|\(${URL_CHAR}*\))+`;
// Sticky, so matching at each `[` does not copy the rest of the text.
const LINK_AT = new RegExp(String.raw`\[(${LINK_LABEL})\]\((${LINK_DESTINATION})\)`, "iy");
/** A Markdown link ending the text, for the rule that styles one as its `)` is typed. */
export const TYPED_LINK = new RegExp(
  String.raw`\[(${LINK_LABEL})\]\((${LINK_DESTINATION})\)$`,
  "i",
);
const LINK_DESTINATION_ONLY = new RegExp(String.raw`^${LINK_DESTINATION}$`, "i");

/** Whether `href` can be written as a composer link destination and parsed back. */
export function isComposerLinkHref(href: string): boolean {
  return LINK_DESTINATION_ONLY.test(href);
}

function sameMarks(left: readonly RichTextMark[], right: readonly RichTextMark[]): boolean {
  return left.length === right.length && left.every((mark, index) => mark === right[index]);
}

// Brackets, quotes, commas, and Markdown delimiters end a URL or path token; a lone `~` does not.
const PATH_TOKEN = /(?:[\p{L}\p{N}_/.:@%+=&?#-]|(?<!~)~(?!~))+/gu;
const FILE_EXTENSION = /^\.[a-z][a-z0-9]*(?::\d+){0,2}$/i;
// `_yes_/_no_`: each side of a slash is its own emphasis span, so the word is not a path.
const EMPHASIS_ALTERNATIVES = /^_[^/]+_(?:\/_[^/]+_)+$/;
// Word characters in any script; callers pass two code units so a letter outside the BMP matches whole.
const WORD_CHARACTER_BEFORE = /[\p{L}\p{M}\p{N}_]$/u;
const WORD_CHARACTER_AFTER = /^[\p{L}\p{M}\p{N}_]/u;

/**
 * Starts of underscore runs that belong to a URL, path, or filename, not to emphasis.
 * A run ending the token stays a delimiter so emphasis wrapped around the token still closes.
 */
function literalUnderscoreRuns(text: string): Set<number> {
  const literal = new Set<number>();
  if (!text.includes("_")) return literal;
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[0];
    let bodyEnd = token.length;
    while (bodyEnd > 0 && ".:?".includes(token[bodyEnd - 1]!)) bodyEnd -= 1;
    if (EMPHASIS_ALTERNATIVES.test(token.slice(0, bodyEnd))) continue;
    while (bodyEnd > 0 && token[bodyEnd - 1] === "_") bodyEnd -= 1;
    const body = token.slice(0, bodyEnd);
    // A slash alone is prose (`and/_or_`); a path also has a dot, a scheme or port, or a root.
    const isPath = body.includes("/")
      ? /^~?\/|[.:]/.test(body)
      : FILE_EXTENSION.test(body.slice(body.lastIndexOf(".")));
    if (!isPath) continue;
    let closesInside = false;
    let start = body.indexOf("_");
    while (start !== -1) {
      let end = start;
      while (body[end] === "_") end += 1;
      if (start > 0) {
        literal.add(match.index + start);
        closesInside ||= !WORD_CHARACTER_AFTER.test(body.slice(end, end + 2));
      }
      start = body.indexOf("_", end);
    }
    // A leading run could only pair with a run inside the name, as in `__init__.py`.
    if (closesInside && body[0] === "_") literal.add(match.index);
  }
  return literal;
}

type ParseFrame = { delimiter: string; mark: RichTextMark; start: number; pieces: SourcePiece[] };

// Pieces keep source offsets, so callers can map parsed text back onto the
// characters it came from; parsing only drops delimiters.

type LinkRange = { start: number; end: number; href: string };

function parseInlineMarkdownPieces(text: string, links?: LinkRange[]): SourcePiece[] {
  const literalRuns = literalUnderscoreRuns(text);
  const root: SourcePiece[] = [];
  const stack: ParseFrame[] = [];
  // Labels cannot hold `[`, so links never nest.
  let link: { frame: ParseFrame; labelEnd: number; end: number; href: string } | null = null;
  const push = (start: number, end: number, marks: RichTextMark[] = [], href?: string) => {
    if (end <= start) return;
    const pieces = stack.at(-1)?.pieces ?? root;
    const last = pieces.at(-1);
    if (last?.end === start && sameMarks(last.marks, marks) && last.href === href) last.end = end;
    else pieces.push({ start, end, marks, ...(href === undefined ? {} : { href }) });
  };
  // Delimiters left open are text, as at the end of the text or a link label.
  const unwind = (until: ParseFrame | undefined) => {
    while (stack.length > 0 && stack.at(-1) !== until) {
      const frame = stack.pop()!;
      push(frame.start, frame.start + frame.delimiter.length);
      for (const piece of frame.pieces) push(piece.start, piece.end, piece.marks, piece.href);
    }
  };
  let index = 0;
  let escapeEnd = -1;
  while (index < text.length) {
    const char = text[index]!;
    if (link && index >= link.labelEnd) {
      unwind(link.frame);
      stack.pop();
      // A label that parses to nothing, like `[****](url)`, would drop the whole link.
      if (link.frame.pieces.length === 0) push(link.frame.start, link.end);
      else links?.push({ start: link.frame.start, end: link.end, href: link.href });
      for (const piece of link.frame.pieces) {
        push(piece.start, piece.end, ["link", ...piece.marks], link.href);
      }
      index = link.end;
      link = null;
      continue;
    }
    if (char === "\\") {
      push(index, Math.min(index + 2, text.length));
      index += 2;
      escapeEnd = index;
      continue;
    }
    // `![label](url)` is an image, unless the `!` is escaped.
    if (char === "[" && !link && (text[index - 1] !== "!" || escapeEnd === index)) {
      LINK_AT.lastIndex = index;
      const match = LINK_AT.exec(text);
      if (match) {
        const frame = { delimiter: "[", mark: "link" as const, start: index, pieces: [] };
        stack.push(frame);
        link = {
          frame,
          labelEnd: index + 1 + match[1]!.length,
          end: index + match[0].length,
          href: match[2]!,
        };
        index += 1;
        continue;
      }
    }
    if (char === "`") {
      const run = text.slice(index).match(/^`+/)![0];
      const close = text.indexOf(run, index + run.length);
      if (
        run.length === 1 &&
        close > index + 1 &&
        close < (link?.labelEnd ?? text.length) &&
        !text.slice(index, close).includes("\n") &&
        text[close + 1] !== "`"
      ) {
        push(index + 1, close, ["code"]);
        index = close + 1;
      } else {
        push(index, index + run.length);
        index += run.length;
      }
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      push(index, index + 1);
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    if (literalRuns.has(index)) {
      push(index, end);
      index = end;
      continue;
    }
    const before = text[index - 1] ?? "";
    const after = text[end] ?? "";
    const wordAfter = WORD_CHARACTER_AFTER.test(text.slice(end, end + 2));
    const wordBefore = WORD_CHARACTER_BEFORE.test(text.slice(Math.max(0, index - 2), index));
    const canClose = before !== "" && !/\s/.test(before) && (char !== "_" || !wordAfter);
    const canOpen = after !== "" && !/\s/.test(after) && (char !== "_" || !wordBefore);
    while (index < end) {
      const top = stack.at(-1);
      const opensNestedBold =
        top?.mark === "italic" &&
        end - index === 2 &&
        canOpen &&
        (char === "*" || char === "_") &&
        !stack.some((frame) => frame.mark === "bold");
      if (
        !opensNestedBold &&
        canClose &&
        top &&
        text.startsWith(top.delimiter, index) &&
        index + top.delimiter.length <= end
      ) {
        stack.pop();
        for (const piece of top.pieces) {
          push(piece.start, piece.end, [top.mark, ...piece.marks], piece.href);
        }
        index += top.delimiter.length;
      } else if (canOpen && (char !== "~" || end - index >= 2)) {
        const length = char === "~" || end - index >= 2 ? 2 : 1;
        const mark = char === "~" ? "strike" : length === 2 ? "bold" : "italic";
        // Prevent self-nesting, including alternate delimiters, to bound the stack by supported styles.
        if (stack.some((frame) => frame.mark === mark)) {
          push(index, end);
          index = end;
          continue;
        }
        stack.push({ delimiter: char.repeat(length), mark, start: index, pieces: [] });
        index += length;
      } else {
        push(index, end);
        index = end;
      }
    }
  }
  unwind(undefined);
  return root;
}

export function parseInlineMarkdown(text: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  for (const { start, end, marks, href } of parseInlineMarkdownPieces(text)) {
    const last = spans.at(-1);
    if (last && sameMarks(last.marks, marks) && last.href === href) {
      last.text += text.slice(start, end);
    } else {
      spans.push({ text: text.slice(start, end), marks, ...(href === undefined ? {} : { href }) });
    }
  }
  return spans;
}

/** Marks text the composer shows as editable Markdown source while the caret is in it. */
export const MARKDOWN_SOURCE_MARK = "markdownSource";

/**
 * Marks for each UTF-16 unit of `text`, or null for a delimiter that parsing drops,
 * and the destination of each unit inside a link.
 */
export function inlineMarkdownUnits(text: string): {
  marks: Array<RichTextMark[] | null>;
  hrefs: Array<string | undefined>;
} {
  const marks: Array<RichTextMark[] | null> = Array.from({ length: text.length }, () => null);
  const hrefs: Array<string | undefined> = Array.from({ length: text.length }, () => undefined);
  for (const piece of parseInlineMarkdownPieces(text)) {
    marks.fill(piece.marks, piece.start, piece.end);
    if (piece.href !== undefined) hrefs.fill(piece.href, piece.start, piece.end);
  }
  return { marks, hrefs };
}

/** Where `text` holds Markdown links, from each `[` to just after its `)`. */
export function inlineMarkdownLinks(text: string): LinkRange[] {
  const links: LinkRange[] = [];
  if (text.includes("](")) parseInlineMarkdownPieces(text, links);
  return links;
}
