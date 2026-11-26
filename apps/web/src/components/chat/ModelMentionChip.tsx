import { useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  modelMentionEffortDescriptor,
  type ComposerModelMentionEffort,
} from "@t3tools/client-runtime/composer-model-mentions";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { brandProviderInstanceEntries, deriveProviderInstanceEntries } from "~/providerInstances";
import { serverEnvironment } from "~/state/server";
import { contextChipAccentWithHueOf } from "~/themePalette";
import { ContextChipPopover } from "../contextChipParts";
import { ProviderInstanceIcon, providerLogoColor } from "./ProviderInstanceIcon";
import { getDisplayModelName } from "./providerIconUtils";

interface ModelMentionPresentation {
  readonly label: string;
  readonly providerLabel: string;
  readonly driverKind: ProviderDriverKind;
  readonly providerDisplayName: string;
  readonly acpRegistryAgentId: string | undefined;
  readonly acpRegistryIconUrl: string | undefined;
  readonly effortLabel: string | null;
}

function presentationsEqual(left: ModelMentionPresentation, right: ModelMentionPresentation) {
  return (
    left.label === right.label &&
    left.providerLabel === right.providerLabel &&
    left.driverKind === right.driverKind &&
    left.providerDisplayName === right.providerDisplayName &&
    left.acpRegistryAgentId === right.acpRegistryAgentId &&
    left.acpRegistryIconUrl === right.acpRegistryIconUrl &&
    left.effortLabel === right.effortLabel
  );
}

// Keyed per mention so provider status pushes don't rerender every message that names a model.
const modelMentionPresentationAtom = Atom.family((key: string) =>
  Atom.make((get): ModelMentionPresentation | null => {
    // JSON, since an effort decoded from the prompt can hold any character.
    const [environmentId, instanceId, model, effortOptionId, effortValue] = JSON.parse(key) as [
      string,
      string,
      string,
      string | null,
      string | null,
    ];
    if (!environmentId) return null;
    const config = get(serverEnvironment.configValueAtom(environmentId as EnvironmentId));
    const provider = config?.providers.find((candidate) => candidate.instanceId === instanceId);
    const option = provider?.models.find((candidate) => candidate.slug === model);
    if (!config || !provider || !option) return null;
    const [entry] = brandProviderInstanceEntries(
      deriveProviderInstanceEntries([provider]),
      config.settings,
    );
    if (!entry) return null;
    const effortDescriptor = effortValue
      ? modelMentionEffortDescriptor(option.capabilities?.optionDescriptors)
      : null;
    const next: ModelMentionPresentation = {
      label: getDisplayModelName(option),
      providerLabel: option.subProvider ?? entry.displayName,
      driverKind: entry.driverKind,
      providerDisplayName: entry.displayName,
      acpRegistryAgentId: entry.acpRegistryAgentId,
      acpRegistryIconUrl: entry.acpRegistryIconUrl,
      // An effort the catalog no longer lists still shows what the agent will read.
      effortLabel: effortValue
        ? ((effortDescriptor && effortDescriptor.id === effortOptionId
            ? effortDescriptor.options.find((choice) => choice.id === effortValue)?.label
            : undefined) ?? effortValue)
        : null,
    };
    const previous = Option.getOrNull(get.self<ModelMentionPresentation | null>());
    return previous && presentationsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("model-mention-presentation")),
);

export function modelMentionKey(instanceId: string, model: string): string {
  return `${instanceId}\u0000${model}`;
}

// Keeps its identity until the environment's models change, so status pushes don't reconcile the composer.
export const modelMentionKeysAtom = Atom.family((environmentId: string) =>
  Atom.make((get): ReadonlySet<string> => {
    const config = environmentId
      ? get(serverEnvironment.configValueAtom(environmentId as EnvironmentId))
      : null;
    const next = new Set(
      config?.providers.flatMap((provider) =>
        provider.models.map((option) => modelMentionKey(provider.instanceId, option.slug)),
      ),
    );
    const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
    return previous && previous.size === next.size && [...next].every((key) => previous.has(key))
      ? previous
      : next;
  }).pipe(Atom.withLabel("model-mention-keys")),
);

/** The provider's logo hue in the model chip color role. */
export function modelMentionAccent(driverKind: ProviderDriverKind): string | undefined {
  const color = providerLogoColor(driverKind);
  return (color && contextChipAccentWithHueOf("model", color)) || undefined;
}

export function ModelMentionChip(props: {
  environmentId: EnvironmentId | null;
  instanceId: string;
  model: string;
  effort?: ComposerModelMentionEffort | undefined;
  source: string;
  /** Makes the effort label a button, as in the composer. */
  onEditEffort?: (() => void) | undefined;
}) {
  const gt = useGT();
  const presentation = useAtomValue(
    modelMentionPresentationAtom(
      JSON.stringify([
        props.environmentId ?? "",
        props.instanceId,
        props.model,
        props.effort?.optionId ?? null,
        props.effort?.value ?? null,
      ]),
    ),
  );
  if (!presentation) return props.source;
  const accent = modelMentionAccent(presentation.driverKind);
  const chip = (
    <ContextChipPopover
      kind="neutral"
      accent={accent}
      icon={
        <ProviderInstanceIcon
          driverKind={presentation.driverKind}
          displayName={presentation.providerDisplayName}
          acpRegistryAgentId={presentation.acpRegistryAgentId}
          acpRegistryIconUrl={presentation.acpRegistryIconUrl}
          className="z-auto"
          iconClassName="size-[1em]"
        />
      }
      label={presentation.label}
      accessibleLabel={gt("Model {label}", { label: presentation.label })}
      copyMarkdown={props.source}
    >
      <div className="space-y-1 p-2 text-sm">
        <p className="font-medium">{presentation.label}</p>
        <p className="text-muted-foreground">{presentation.providerLabel}</p>
        <p className="font-mono text-xs text-muted-foreground">{props.source}</p>
      </div>
    </ContextChipPopover>
  );
  const { effortLabel } = presentation;
  if (!effortLabel) return chip;
  return (
    <span className="inline-flex max-w-full items-baseline gap-1" data-markdown-copy={props.source}>
      {chip}
      <span aria-hidden="true" className="text-muted-foreground/70">
        ·
      </span>
      {props.onEditEffort ? (
        <button
          type="button"
          className="cursor-pointer whitespace-nowrap rounded-sm text-secondary-label hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
          aria-label={gt("Reasoning effort {effort}. Change", { effort: effortLabel })}
          // Keeps focus in the editor, whose keys drive the effort menu.
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onEditEffort}
        >
          {effortLabel}
        </button>
      ) : (
        <span className="whitespace-nowrap text-secondary-label">{effortLabel}</span>
      )}
    </span>
  );
}
