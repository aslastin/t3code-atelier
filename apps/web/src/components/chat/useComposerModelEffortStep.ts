import {
  formatComposerModelMention,
  type ComposerModelMentionEffort,
} from "@t3tools/client-runtime/composer-model-mentions";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import {
  collapseExpandedComposerCursor,
  extendReplacementRangeForTrailingSpace,
  type ComposerTrigger,
} from "../../composer-logic";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerModelEffortEditRequest } from "../composerContextActions";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import {
  composerModelEffortItemId,
  composerModelEffortItems,
  composerModelItem,
  isComposerModelEffortStepCurrent,
  type ComposerModelEffortStep,
  type ComposerModelItem,
} from "./composerModelMentions";
import type { ModelEsque } from "./providerIconUtils";

type ApplyPromptReplacement = (
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
  options?: { expectedText?: string; expandedCursorAfterReplace?: number },
) => boolean;

/**
 * The `@` menu's reasoning levels: for a model just picked, whose plain mention is already in the
 * prompt, or for a chip whose level was clicked. Owns the step and when it stops owning the menu.
 */
export function useComposerModelEffortStep(input: {
  readonly draftKey: string;
  readonly editorValue: string;
  readonly cursor: number;
  readonly literal: boolean;
  /** A submitted answer locks the editor; a level picked then would change what no longer sends. */
  readonly locked: boolean;
  readonly listId: string;
  readonly promptRef: RefObject<string>;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly setHighlightedItemId: Dispatch<SetStateAction<string | null>>;
  readonly setHighlightedSearchKey: Dispatch<SetStateAction<string | null>>;
}) {
  const gt = useGT();
  const { promptRef, setHighlightedItemId, setHighlightedSearchKey } = input;
  const [step, setStep] = useState<ComposerModelEffortStep | null>(null);
  const active =
    step !== null &&
    isComposerModelEffortStepCurrent(step, {
      draftKey: input.draftKey,
      editorValue: input.editorValue,
      cursor: input.cursor,
      editable: !input.literal && !input.locked,
    })
      ? step
      : null;
  // A step left behind stays dropped, so typing back to its text does not reopen it.
  if (step !== null && active === null) setStep(null);

  const searchKeyFor = (model: ComposerModelItem) => `${input.listId}:model-effort:${model.id}`;
  const open = (next: ComposerModelEffortStep, highlighted: string | null) => {
    setStep(next);
    setHighlightedItemId(composerModelEffortItemId(highlighted));
    setHighlightedSearchKey(searchKeyFor(next.model));
  };

  /** Actions that rewrite the prompt through the composer's own replacement. */
  const withPrompt = (applyPromptReplacement: ApplyPromptReplacement) => {
    // Rewrites the step's mention; `replacement` null puts its `@` search back instead.
    const replaceStepMention = (
      target: Extract<ComposerModelEffortStep["target"], { kind: "insert" }>,
      replacement: string | null,
    ): boolean => {
      const end = target.start + target.source.length;
      const spaced = promptRef.current[end] === " ";
      if (replacement === null) {
        const removeSpace = spaced && target.addedSpace;
        return applyPromptReplacement(target.start, removeSpace ? end + 1 : end, target.query, {
          expectedText: `${target.source}${removeSpace ? " " : ""}`,
        });
      }
      return applyPromptReplacement(target.start, end, replacement, {
        expectedText: target.source,
        expandedCursorAfterReplace: target.start + replacement.length + (spaced ? 1 : 0),
      });
    };

    const apply = (current: ComposerModelEffortStep, effort: ComposerModelMentionEffort | null) => {
      const { model, target } = current;
      const source = formatComposerModelMention(model.instanceId, model.model, effort);
      if (target.kind === "insert") replaceStepMention(target, source);
      else target.apply(source, effort);
      // A choice the mention can no longer take, as after an editor remount, still closes the menu.
      setStep(null);
    };

    return {
      /** Puts the model's plain mention in, so any send names it, then lists its levels if any. */
      pick: (
        item: ComposerModelItem,
        trigger: ComposerTrigger,
        value: string,
        triggerSearchKey: string | null,
      ) => {
        const source = formatComposerModelMention(item.instanceId, item.model);
        const replacement = `${source} `;
        const rangeEnd = extendReplacementRangeForTrailingSpace(
          value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(trigger.rangeStart, rangeEnd, replacement, {
          expectedText: value.slice(trigger.rangeStart, rangeEnd),
        });
        if (!applied) return;
        setHighlightedItemId(null);
        if (!item.effort || triggerSearchKey === null) return;
        open(
          {
            model: item,
            draftKey: input.draftKey,
            target: {
              kind: "insert",
              start: trigger.rangeStart,
              source,
              tail: promptRef.current.slice(trigger.rangeStart + source.length),
              addedSpace: rangeEnd === trigger.rangeEnd,
              cursor: collapseExpandedComposerCursor(
                promptRef.current,
                trigger.rangeStart + replacement.length,
                input.literal,
              ),
              query: value.slice(trigger.rangeStart, trigger.rangeEnd),
              modelSearchKey: triggerSearchKey,
            },
          },
          null,
        );
      },
      /** Applies a level; null is Default, which sets none. */
      choose: (value: string | null) => {
        if (!active) return;
        const optionId = active.model.effort?.optionId;
        if (value === null) apply(active, null);
        else if (optionId) apply(active, { optionId, value });
      },
      /** Back from a just-picked model's levels to the model list, its search and highlight kept. */
      back: () => {
        if (active?.target.kind !== "insert") return;
        const { target } = active;
        const restored =
          input.editorRef.current?.replaceModelMention(target.start, target.source, target.query, {
            removeFollowingSpace: target.addedSpace,
          }) || replaceStepMention(target, null);
        if (!restored) return;
        setStep(null);
        setHighlightedItemId(active.model.id);
        setHighlightedSearchKey(target.modelSearchKey);
      },
    };
  };

  return {
    active,
    /** The menu's rows while a step owns it. */
    items: active
      ? composerModelEffortItems(
          active.model,
          gt("Default", { $context: "reasoning effort level that sets none" }),
        )
      : null,
    searchKey: active ? searchKeyFor(active.model) : null,
    withPrompt,
    /** Escape keeps the mention as it is: a new one without an effort, a chip with its old one. */
    dismiss: () => setStep(null),
    // Extending a selection moves no caret and renders nothing, so it would leave the levels up.
    dropOnSelection: () => {
      if (step) setStep(null);
    },
    /** Opens a chip's levels on its current one. */
    edit: (request: ComposerModelEffortEditRequest) => {
      const entry = input.providerInstanceEntries.find(
        (candidate) => candidate.instanceId === request.instanceId,
      );
      const option =
        entry &&
        ((input.modelOptionsByInstance.get(entry.instanceId) ?? []).find(
          (candidate) => candidate.slug === request.model,
        ) ??
          entry.models.find((candidate) => candidate.slug === request.model));
      if (!entry || !option) return;
      // A model that no longer lists levels still offers Default, to clear a restored effort.
      const model = composerModelItem(entry, option);
      const current =
        model.effort &&
        request.effort?.optionId === model.effort.optionId &&
        model.effort.choices.some((choice) => choice.id === request.effort?.value)
          ? request.effort.value
          : null;
      open(
        {
          model,
          draftKey: input.draftKey,
          target: {
            kind: "edit",
            cursor: input.editorRef.current?.readSnapshot().cursor ?? input.cursor,
            isCurrent: request.isCurrent,
            apply: request.apply,
          },
        },
        current,
      );
    },
  };
}
