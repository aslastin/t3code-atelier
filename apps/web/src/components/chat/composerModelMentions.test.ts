import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isComposerModelEffortStepCurrent,
  type ComposerModelEffortStep,
} from "./composerModelMentions";

const model = {
  id: "model:codex:gpt-5.5",
  type: "model",
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
  driverKind: ProviderDriverKind.make("codex"),
  providerDisplayName: "Codex",
  acpRegistryAgentId: undefined,
  acpRegistryIconUrl: undefined,
  label: "GPT-5.5",
  description: "Codex",
  effort: { optionId: "reasoningEffort", choices: [{ id: "high", label: "High" }] },
} satisfies ComposerModelEffortStep["model"];

// `Ask model:codex/gpt-5.5 today`, picked from `@gpt-5.5`, caret after the mention's space.
const insertTarget = {
  kind: "insert",
  start: 4,
  source: "model:codex/gpt-5.5",
  tail: " today",
  addedSpace: false,
  cursor: 24,
  query: "@gpt-5.5",
  modelSearchKey: "list:path:gpt-5.5",
} as const;
const inserted: ComposerModelEffortStep = { model, draftKey: "draft", target: insertTarget };
const composer = {
  draftKey: "draft",
  editorValue: "Ask model:codex/gpt-5.5 today",
  cursor: 24,
  editable: true,
};

describe("isComposerModelEffortStepCurrent", () => {
  it("keeps a picked model's levels while its mention and the text after it are untouched", () => {
    expect(isComposerModelEffortStepCurrent(inserted, composer)).toBe(true);
    // A re-serialization before the mention that keeps offsets, like `_word_` as `*word*`.
    expect(
      isComposerModelEffortStepCurrent(
        { ...inserted, target: { ...insertTarget, start: 11 } },
        { ...composer, editorValue: "*word* ask model:codex/gpt-5.5 today" },
      ),
    ).toBe(true);
  });

  it.each([
    ["another draft", { draftKey: "other" }],
    ["a moved caret", { cursor: 3 }],
    ["an edit after the mention", { editorValue: "Ask model:codex/gpt-5.5 oday" }],
    ["text shifted before it", { editorValue: "So, ask model:codex/gpt-5.5 today" }],
    ["a locked or literal answer", { editable: false }],
  ])("drops a picked model's levels after %s", (_, change) => {
    expect(isComposerModelEffortStepCurrent(inserted, { ...composer, ...change })).toBe(false);
  });

  it("asks a chip's own editor whether its menu still applies", () => {
    const chip = (current: boolean): ComposerModelEffortStep => ({
      model,
      draftKey: "draft",
      target: { kind: "edit", cursor: 24, isCurrent: () => current, apply: () => true },
    });
    expect(isComposerModelEffortStepCurrent(chip(true), composer)).toBe(true);
    expect(isComposerModelEffortStepCurrent(chip(false), composer)).toBe(false);
    expect(isComposerModelEffortStepCurrent(chip(true), { ...composer, cursor: 3 })).toBe(false);
  });
});
