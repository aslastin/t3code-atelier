import {
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
  const choices = descriptor ? modelMentionEffortChoices(descriptor) : [];
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
  /** The editor text the step opened on; any edit ends it. */
  readonly prompt: string;
  readonly target:
    | { readonly kind: "insert"; readonly modelSearchKey: string }
    | { readonly kind: "edit"; readonly start: number; readonly end: number };
}

export function composerModelEffortItemId(value: string | null): string {
  return value === null ? "model-effort-default" : `model-effort:${value}`;
}

/** Default, which sets no effort, then the model's levels. */
export function composerModelEffortItems(
  model: ComposerModelItem,
  defaultLabel: string,
): ComposerModelEffortItem[] {
  return [
    { value: null, label: defaultLabel },
    ...(model.effort?.choices ?? []).map((choice) => ({ value: choice.id, label: choice.label })),
  ].map(({ value, label }) => ({
    id: composerModelEffortItemId(value),
    type: "model-effort",
    value,
    label,
    description: "",
  }));
}
