import { VcsDriverKind, type VcsDriverCapabilities } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { limitGitMenuItems, limitGitQuickAction, vcsAllows } from "./vcsCapabilities.ts";

const plugin = (overrides: Partial<VcsDriverCapabilities> = {}) => ({
  capabilities: {
    kind: VcsDriverKind.make("kite"),
    supportsWorktrees: false,
    supportsCommit: true,
    supportsPush: false,
    supportsReviewDiff: false,
    supportsSparseCheckout: false,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: false,
    ignoreClassifier: "git-compatible-fallback" as const,
    ...overrides,
  },
});
const copy = {
  labels: { commit: "Commit", push: "Push", commit_push: "Commit & push" },
  unsupportedHint: "Kite cannot do this here.",
};
const run = (action: "commit" | "push" | "commit_push" | "commit_push_pr" | "create_pr") => ({
  label: action,
  disabled: false,
  kind: "run_action",
  action,
});

describe("vcsCapabilities", () => {
  it("keeps the Git UI when the server omits capabilities", () => {
    expect(vcsAllows({}, "worktree")).toBe(true);
    expect(vcsAllows(null, "pullRequest")).toBe(true);
    expect(limitGitQuickAction(run("commit_push_pr"), {}, copy)).toEqual(run("commit_push_pr"));
  });

  it("hides actions the plugin cannot run", () => {
    const items = [{ id: "commit" as const }, { id: "push" as const }, { id: "pr" as const }];
    expect(limitGitMenuItems(items, plugin())).toEqual([{ id: "commit" }]);
    // A plugin that pushes still has no change request host.
    expect(limitGitMenuItems(items, plugin({ supportsPush: true }))).toEqual([
      { id: "commit" },
      { id: "push" },
    ]);
    expect(vcsAllows(plugin(), "worktree")).toBe(false);
    // A new branch needs Git, or a plugin that can start one.
    expect(vcsAllows(plugin({ supportsPush: true }), "featureBranch")).toBe(false);
    expect(vcsAllows(plugin({ supportsBranchCreate: true }), "featureBranch")).toBe(true);
    expect(vcsAllows(plugin({ kind: VcsDriverKind.make("git") }), "featureBranch")).toBe(true);
  });

  it("offers publishing and pulling only where the VCS can", () => {
    const git = plugin({ kind: VcsDriverKind.make("git") });
    const publish = { label: "Publish", disabled: false, kind: "open_publish" };
    const pull = { label: "Pull", disabled: false, kind: "run_pull" };
    // A Git repository with capabilities keeps Publish and Pull.
    expect(limitGitQuickAction(publish, git, copy)).toEqual(publish);
    expect(limitGitQuickAction(pull, git, copy)).toEqual(pull);
    expect(limitGitQuickAction(publish, plugin(), copy)).toMatchObject({ kind: "show_hint" });
    expect(limitGitQuickAction(pull, plugin(), copy)).toMatchObject({ kind: "show_hint" });
    expect(limitGitQuickAction(pull, plugin({ supportsPull: true }), copy)).toEqual(pull);
    expect(vcsAllows(plugin(), "switchRef")).toBe(false);
    expect(vcsAllows(plugin({ supportsPartialCommit: false }), "partialCommit")).toBe(false);
    expect(vcsAllows(plugin(), "partialCommit")).toBe(true);
    expect(vcsAllows(git, "switchRef")).toBe(true);
    // Pulling is not fetching a worktree's base; only `fetchBase` offers Start from remote.
    expect(vcsAllows(plugin({ supportsPull: true }), "startFromRemote")).toBe(false);
    expect(vcsAllows(plugin({ supportsFetchBase: true }), "startFromRemote")).toBe(true);
    expect(vcsAllows(git, "startFromRemote")).toBe(true);
  });

  it("narrows a quick action to the steps the plugin supports", () => {
    expect(limitGitQuickAction(run("commit_push_pr"), plugin(), copy)).toMatchObject({
      action: "commit",
      label: "Commit",
    });
    expect(
      limitGitQuickAction(run("commit_push_pr"), plugin({ supportsPush: true }), copy),
    ).toMatchObject({ action: "commit_push", label: "Commit & push" });
    expect(limitGitQuickAction(run("create_pr"), plugin(), copy)).toMatchObject({
      kind: "show_hint",
      disabled: true,
      hint: copy.unsupportedHint,
    });
    expect(
      limitGitQuickAction(
        { label: "Publish", disabled: false, kind: "open_publish" },
        plugin(),
        copy,
      ),
    ).toMatchObject({ kind: "show_hint", disabled: true });
  });
});
