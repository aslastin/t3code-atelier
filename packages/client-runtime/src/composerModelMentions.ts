import type { ProviderOptionDescriptor, SelectProviderOptionDescriptor } from "@t3tools/contracts";
import { DEFAULT_VARIANT_CHOICE_ID } from "@t3tools/shared/model";

import { rankModelPickerSearch, type ModelPickerSearchableModel } from "./modelSearch.ts";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

const COMPOSER_MODEL_MENTION_LIMIT = 8;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Mentions can't contain spaces, so `:`, `/` and `-` split words, as in `@gpt:traex`. */
function mentionSearchQueries(query: string): ReadonlyArray<string> {
  const spaced = query.replace(/[:/]+/gu, " ").trim();
  const unhyphenated = spaced.replace(/-+/gu, " ").trim();
  // One letter would fill the menu with models and push files out of it.
  if (unhyphenated.replace(/\s+/gu, "").length < 2) return [];
  return unhyphenated === spaced ? [spaced] : [spaced, unhyphenated];
}

/** Returns the models matching an `@` mention, best first. A bare `@` matches none. */
export function rankComposerModelMentions<T>(
  candidates: ReadonlyArray<T>,
  query: string,
  toSearchable: (candidate: T) => ModelPickerSearchableModel,
): T[] {
  for (const words of mentionSearchQueries(query)) {
    // Every word must start a word of the model's names. Fuzzy hits would push files out of the `@` menu.
    const tokens = words
      .toLowerCase()
      .split(/\s+/u)
      .map((token) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(token)}`, "u"));
    const literal = candidates.filter((candidate) => {
      const model = toSearchable(candidate);
      const haystack = [
        model.name,
        model.shortName,
        model.subProvider,
        model.driverKind,
        model.providerDisplayName,
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => token.test(haystack));
    });
    const ranked = rankModelPickerSearch(literal, words, toSearchable);
    if (ranked.length > 0) return ranked.slice(0, COMPOSER_MODEL_MENTION_LIMIT);
  }
  return [];
}

/** A reasoning effort chosen for one mention: a select option id and one of its choice ids. */
export interface ComposerModelMentionEffort {
  readonly optionId: string;
  readonly value: string;
}

/**
 * Prompt text naming a provider instance and model for the agent, plus an explicit effort as
 * `?<option id>=<choice id>`. No `@`, which the editor would turn into a file chip.
 */
export function formatComposerModelMention(
  instanceId: string,
  model: string,
  effort?: ComposerModelMentionEffort | null,
): string {
  const mention = `model:${instanceId}/${model}`;
  return effort
    ? `${mention}?${encodeMentionPart(effort.optionId, ".:/")}=${encodeMentionPart(effort.value)}`
    : mention;
}

// Also escapes what the parser reads as a reference's end or prose punctuation. An option id keeps
// `.`, `:` and `/`, which agents use in ids like `agent:effort`, since `=` always follows it.
function encodeMentionPart(part: string, keep = ""): string {
  let encoded = encodeURIComponent(part).replace(
    /[!'().*~]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  for (const char of keep) {
    encoded = encoded.replaceAll(`%${char.charCodeAt(0).toString(16).toUpperCase()}`, char);
  }
  return encoded;
}

// Pi names its reasoning select `thinking`; Claude's `thinking` is a boolean and never matches.
const EFFORT_SELECT_IDS = [...REASONING_EFFORT_OPTION_IDS, "thinking"];

/** The model's reasoning effort select, which a mention may set, or null when it has none. */
export function modelMentionEffortDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): SelectProviderOptionDescriptor | null {
  const selects = (descriptors ?? []).filter(
    (descriptor): descriptor is SelectProviderOptionDescriptor => descriptor.type === "select",
  );
  const descriptor =
    selects.find((candidate) => candidate.role === "reasoning") ??
    EFFORT_SELECT_IDS.map((id) => selects.find((candidate) => candidate.id === id)).find(
      (candidate) => candidate !== undefined,
    );
  return descriptor ?? null;
}

/** Levels a mention offers besides Default. Prompt-injected levels like Ultrathink stay typed-only. */
export function modelMentionEffortChoices(descriptor: SelectProviderOptionDescriptor) {
  return descriptor.options.filter(
    (choice) =>
      choice.id !== DEFAULT_VARIANT_CHOICE_ID &&
      !descriptor.promptInjectedValues?.includes(choice.id),
  );
}

export interface ComposerModelMentionOccurrence {
  readonly instanceId: string;
  readonly model: string;
  readonly effort?: ComposerModelMentionEffort;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

// ACP agents may namespace their option ids, as in `agent:effort`.
const EFFORT_SUFFIX = /\?([^\s?&=]+)=([^\s?&=]+)$/u;

function splitEffort(slug: string): {
  readonly model: string;
  readonly effort?: ComposerModelMentionEffort;
} {
  const match = EFFORT_SUFFIX.exec(slug);
  if (!match || match.index === 0) return { model: slug };
  try {
    return {
      model: slug.slice(0, match.index),
      effort: {
        optionId: decodeURIComponent(match[1]!),
        value: decodeURIComponent(match[2]!),
      },
    };
  } catch {
    return { model: slug };
  }
}

// Instance ids match ProviderInstanceId; model slugs may contain `/`, as in `opencode/anthropic/opus`.
const MODEL_MENTION_PATTERN = /(?<![^\s,(["'])model:([a-zA-Z][a-zA-Z0-9_-]*)\/([^\s,"']+)/gu;
const SENTENCE_PUNCTUATION = ".;:!?";
const CLOSING_BRACKETS: Readonly<Record<string, string>> = { ")": "(", "]": "[" };

function countOf(text: string, char: string): number {
  return text.split(char).length - 1;
}

// Slugs like `foo(bar)` or `GPT-6.1-Sol[1m]` keep balanced brackets; prose wrapping them does not.
function trimModelSlug(slug: string): string {
  let end = slug.length;
  const unmatched = new Map<string, number>();
  while (end > 0) {
    const last = slug[end - 1]!;
    if (SENTENCE_PUNCTUATION.includes(last)) {
      end -= 1;
      continue;
    }
    const opening = CLOSING_BRACKETS[last];
    if (opening === undefined) break;
    const excess = unmatched.get(last) ?? countOf(slug, last) - countOf(slug, opening);
    if (excess <= 0) break;
    unmatched.set(last, excess - 1);
    end -= 1;
  }
  return slug.slice(0, end);
}

/** Finds the `model:<instance>/<model>[?<option>=<value>]` references `formatComposerModelMention` writes. */
export function collectComposerModelMentions(
  text: string,
): ReadonlyArray<ComposerModelMentionOccurrence> {
  if (!text.includes("model:")) return [];
  const occurrences: ComposerModelMentionOccurrence[] = [];
  for (const match of text.matchAll(MODEL_MENTION_PATTERN)) {
    const instanceId = match[1]!;
    const slug = trimModelSlug(match[2]!);
    if (slug.length === 0) continue;
    const start = match.index;
    const end = start + "model:".length + instanceId.length + 1 + slug.length;
    occurrences.push({
      instanceId,
      ...splitEffort(slug),
      source: text.slice(start, end),
      start,
      end,
    });
  }
  return occurrences;
}
