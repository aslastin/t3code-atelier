import {
  type ComposerModelMentionEffort,
  modelMentionEffortChoices,
  modelMentionEffortDescriptor,
  rankComposerModelMentions,
} from "@t3tools/client-runtime/composer-model-mentions";
import type { ProviderInstanceId } from "@t3tools/contracts";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

export type ComposerModelItem = Extract<ComposerCommandItem, { type: "model" }>;
type ComposerModelEffortItem = Extract<ComposerCommandItem, { type: "model-effort" }>;

export function composerModelItem(
  entry: ProviderInstanceEntry,
  option: ModelEsque,
): ComposerModelItem {
  const descriptor = modelMentionEffortDescriptor(
    entry.models.find((model) => model.slug === option.slug)?.capabilities?.optionDescriptors,
  );
  const choices = descriptor ? modelMentionEffortChoices(descriptor, entry.driverKind) : [];
  return {
    id: `model:${entry.instanceId}:${option.slug}`,
    type: "model",
    instanceId: entry.instanceId,
    model: option.slug,
    driverKind: entry.driverKind,
    providerDisplayName: entry.displayName,
    acpRegistryAgentId: entry.acpRegistryAgentId,
    acpRegistryIconUrl: entry.acpRegistryIconUrl,
    label: getDisplayModelName(option),
    description: option.subProvider ?? entry.displayName,
    effort:
      descriptor && choices.length > 0
        ? {
            optionId: descriptor.id,
            choices: choices.map((choice) => ({ id: choice.id, label: choice.label })),
          }
        : null,
  };
}

export function matchComposerModelItems(input: {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly query: string;
}): ComposerModelItem[] {
  const candidates: Array<{ entry: ProviderInstanceEntry; option: ModelEsque }> = [];
  for (const entry of input.instanceEntries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    for (const option of input.modelOptionsByInstance.get(entry.instanceId) ?? []) {
      // The picker hides legacy models by default; skip them so they don't fill the result cap.
      if (option.isLegacy || option.isUnavailable) continue;
      candidates.push({ entry, option });
    }
  }

  return rankComposerModelMentions(candidates, input.query, ({ entry, option }) => ({
    name: option.name,
    ...(option.shortName ? { shortName: option.shortName } : {}),
    ...(option.subProvider ? { subProvider: option.subProvider } : {}),
    driverKind: entry.driverKind,
    providerDisplayName: entry.displayName,
  })).map(({ entry, option }) => composerModelItem(entry, option));
}

/** The `@` menu's effort list for a model just picked, or for a chip whose effort is being changed. */
export interface ComposerModelEffortStep {
  readonly model: ComposerModelItem;
  /** The draft the step opened in; the composer outlives a thread switch. */
  readonly draftKey: string;
  readonly target:
    | {
        /** A just-picked model, whose plain mention is already in the prompt at `start`. */
        readonly kind: "insert";
        readonly start: number;
        readonly source: string;
        /** The text after the mention; an edit there, like a forward delete, ends the step. */
        readonly tail: string;
        /** Whether the insertion added the space after the mention, which Back then removes. */
        readonly addedSpace: boolean;
        /** The caret after the insertion; moving it, or any edit, ends the step. */
        readonly cursor: number;
        /** The `@` search the mention replaced, which Back restores, and its menu key. */
        readonly query: string;
        readonly modelSearchKey: string;
      }
    | {
        readonly kind: "edit";
        /** The caret the chip click placed; a render reads `isCurrent` only when this changes. */
        readonly cursor: number;
        readonly isCurrent: () => boolean;
        readonly apply: (source: string, effort: ComposerModelMentionEffort | null) => boolean;
      };
}

export function composerModelEffortItemId(value: string | null): string {
  return value === null ? "model-effort-default" : `model-effort:${value}`;
}

/** Default, which sets no effort, then the model's levels. */
export function composerModelEffortItems(
  model: ComposerModelItem,
  defaultLabel: string,
): ComposerModelEffortItem[] {
  const effort = model.effort;
  return [
    { value: null, label: defaultLabel, description: "" },
    ...(effort?.choices ?? []).map((choice) => ({
      value: choice.id,
      label: choice.label,
      // A level labelled like Default, as OpenCode's literal `default` variant, shows what it writes.
      description: choice.label === defaultLabel ? `${effort?.optionId}=${choice.id}` : "",
    })),
  ].map(({ value, label, description }) => ({
    id: composerModelEffortItemId(value),
    type: "model-effort",
    value,
    label,
    description,
  }));
}
