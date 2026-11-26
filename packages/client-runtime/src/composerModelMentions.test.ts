import { describe, expect, it, vi } from "vite-plus/test";

import {
  collectComposerModelMentions,
  formatComposerModelMention,
  modelMentionEffortChoices,
  modelMentionEffortDescriptor,
  rankComposerModelMentions,
} from "./composerModelMentions.ts";

const models = [
  { id: "traex:gpt", name: "GPT-6.1", driverKind: "codex", providerDisplayName: "Traex" },
  {
    id: "opencode:traex-gpt",
    name: "GPT-6.1",
    subProvider: "Traex",
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
  },
  {
    id: "opencode:opus",
    name: "Claude Opus 5.5",
    subProvider: "Anthropic",
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
  },
  {
    id: "claude:opus",
    name: "Claude Opus 5.5",
    driverKind: "claudeAgent",
    providerDisplayName: "Claude",
  },
];

function rank(query: string): string[] {
  return rankComposerModelMentions(models, query, (model) => model).map((model) => model.id);
}

describe("rankComposerModelMentions", () => {
  it.each(["", "-", "---", ":/-/:"])(
    "offers no models for a bare or separator-only @%s",
    (query) => {
      expect(rank(query)).toEqual([]);
    },
  );

  it("finds a model under every provider that serves it", () => {
    expect(rank("gpt").toSorted()).toEqual(["opencode:traex-gpt", "traex:gpt"]);
  });

  it("splits words a mention joins with :, / or -", () => {
    expect(rank("opencode:traex")).toEqual(["opencode:traex-gpt"]);
    expect(rank("opencode/gpt")).toEqual(["opencode:traex-gpt"]);
    expect(rank("opencode-gpt")).toEqual(["opencode:traex-gpt"]);
  });

  it("keeps a hyphenated model name whole when it matches", () => {
    expect(rank("gpt-6.1").toSorted()).toEqual(["opencode:traex-gpt", "traex:gpt"]);
  });

  it.each(["src", "g", "agent", "pus"])(
    "does not offer models whose words only contain @%s",
    (query) => {
      expect(rank(query)).toEqual([]);
    },
  );
});

describe("collectComposerModelMentions", () => {
  it("reads back what formatComposerModelMention writes, inside prose", () => {
    const text = `use ${formatComposerModelMention("opencode", "anthropic/opus")}, then model:codex/gpt-5.4.`;
    expect(collectComposerModelMentions(text)).toEqual([
      {
        instanceId: "opencode",
        model: "anthropic/opus",
        source: "model:opencode/anthropic/opus",
        start: 4,
        end: 33,
      },
      { instanceId: "codex", model: "gpt-5.4", source: "model:codex/gpt-5.4", start: 40, end: 59 },
    ]);
  });

  it("reads back an explicit effort, kept apart from the model slug", () => {
    const text = `${formatComposerModelMention("claudeAgent", "claude-opus-5-5", {
      optionId: "effort",
      value: "high",
    })} and ${formatComposerModelMention("opencode", "anthropic/opus", {
      optionId: "variant",
      value: "deep think",
    })}?`;
    expect(collectComposerModelMentions(text)).toEqual([
      {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        effort: { optionId: "effort", value: "high" },
        source: "model:claudeAgent/claude-opus-5-5?effort=high",
        start: 0,
        end: 45,
      },
      {
        instanceId: "opencode",
        model: "anthropic/opus",
        effort: { optionId: "variant", value: "deep think" },
        source: "model:opencode/anthropic/opus?variant=deep%20think",
        start: 50,
        end: 100,
      },
    ]);
  });

  it.each([
    ["agent:effort", "vendor's"],
    ["agent:effort", "extra!"],
    ["agent:effort", "v1."],
    ["agent/effort", "agent:deep (max)"],
    ["agent effort?", "high"],
    ["_deep_", "_max_"],
    ["thought_level", "high-_fast_-v2"],
    ["agent/_effort", "high"],
  ])("round-trips option %s with value %s as one reference", (optionId, value) => {
    const source = formatComposerModelMention("acp", "agent", { optionId, value });
    // A `_` outside a word would read as emphasis in a sent message's Markdown.
    expect(source).not.toMatch(/(?:^|[^\p{L}\p{N}])_|_(?:[^\p{L}\p{N}]|$)/u);
    expect(collectComposerModelMentions(`${source}. next`)).toEqual([
      expect.objectContaining({ source, model: "agent", effort: { optionId, value } }),
    ]);
  });

  it.each([
    ["model:codex/gpt-6.1?", "gpt-6.1"],
    ["model:codex/gpt-6.1?effort", "gpt-6.1?effort"],
    ["model:codex/gpt-6.1?effort=%E0", "gpt-6.1?effort=%E0"],
  ])("reads no effort from %s", (text, model) => {
    expect(
      collectComposerModelMentions(text).map((mention) => [mention.model, mention.effort]),
    ).toEqual([[model, undefined]]);
  });

  it.each([
    ["(model:codex/gpt-6.1).", ["codex/gpt-6.1"]],
    ["(model:codex/gpt-6.1?reasoningEffort=xhigh).", ["codex/gpt-6.1"]],
    ['"model:codex/gpt-6.1"', ["codex/gpt-6.1"]],
    ["model:codex/gpt-6.1,model:claudeAgent/sonnet", ["codex/gpt-6.1", "claudeAgent/sonnet"]],
    ["model:codex/gpt-6.1's output", ["codex/gpt-6.1"]],
    ["model:opencode/foo(bar)", ["opencode/foo(bar)"]],
    ["(model:codex/GPT-6.1-Sol[1m]).", ["codex/GPT-6.1-Sol[1m]"]],
    ["model:codex/gpt-6.1" + ")".repeat(128), ["codex/gpt-6.1"]],
  ])("bounds the reference in %s", (text, expected) => {
    const { mentions, rescans } = (() => {
      using split = vi.spyOn(String.prototype, "split");
      const mentions = collectComposerModelMentions(text);
      return { mentions, rescans: split.mock.calls.length };
    })();
    expect(mentions.map(({ instanceId, model }) => `${instanceId}/${model}`)).toEqual(expected);
    expect(rescans).toBeLessThanOrEqual(expected.length * 4);
  });

  it.each(["remodel:codex/gpt", "model:codex", "model:/gpt", "model:codex/.", "model:1x/gpt"])(
    "ignores %s",
    (text) => {
      expect(collectComposerModelMentions(text)).toEqual([]);
    },
  );
});

describe("modelMentionEffortDescriptor", () => {
  const select = (id: string, role?: "reasoning") => ({
    id,
    label: id,
    type: "select" as const,
    options: [
      { id: "t3:default", label: "Default" },
      { id: "default", label: "Default" },
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
      { id: "ultrathink", label: "Ultrathink" },
    ],
    promptInjectedValues: ["ultrathink"],
    ...(role ? { role } : {}),
  });

  it("prefers the select an agent marks as reasoning over a known effort id", () => {
    expect(
      modelMentionEffortDescriptor([select("effort"), select("thought_level", "reasoning")])?.id,
    ).toBe("thought_level");
    expect(modelMentionEffortDescriptor([select("speed"), select("reasoningEffort")])?.id).toBe(
      "reasoningEffort",
    );
    expect(modelMentionEffortDescriptor([select("thinking")])?.id).toBe("thinking");
    expect(modelMentionEffortDescriptor([select("agent:effort", "reasoning")])?.id).toBe(
      "agent:effort",
    );
    expect(modelMentionEffortDescriptor([select("agent/effort", "reasoning")])?.id).toBe(
      "agent/effort",
    );
  });

  it("finds none for a model without a reasoning select", () => {
    expect(
      modelMentionEffortDescriptor([{ id: "thinking", label: "Thinking", type: "boolean" }]),
    ).toBeNull();
    expect(modelMentionEffortDescriptor(undefined)).toBeNull();
  });

  it("offers levels without the choices that send no effort or prompt-injected levels", () => {
    const ids = (descriptor: ReturnType<typeof select>, driverKind: string) =>
      modelMentionEffortChoices(descriptor, driverKind).map((choice) => choice.id);
    expect(ids(select("effort"), "claudeAgent")).toEqual(["low", "high"]);
    // Only Claude's `default` sends none; OpenCode's variant and an ACP level named so are real.
    expect(ids(select("variant"), "opencode")).toEqual(["default", "low", "high"]);
    expect(ids(select("effort"), "acp")).toEqual(["default", "low", "high"]);
    expect(
      ids({ ...select("effort"), options: [{ id: "\ud800", label: "Broken" }] }, "acp"),
    ).toEqual([]);
  });
});
