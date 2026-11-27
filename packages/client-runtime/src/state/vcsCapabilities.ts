import { GIT_VCS_KIND, type GitStackedAction, type VcsStatusLocalResult } from "@t3tools/contracts";

// Atelier fork: a VCS plugin's driver reports what it can do in `status.capabilities`. Clients
// hide what it cannot. Servers that omit capabilities keep the Git UI unchanged.

export type VcsCapability =
  | "commit"
  | "push"
  | "pullRequest"
  | "worktree"
  | "reviewDiff"
  | "featureBranch"
  | "publish"
  | "pull"
  | "switchRef"
  | "partialCommit"
  | "startFromRemote";

type CapabilityStatus = Pick<VcsStatusLocalResult, "capabilities"> | null | undefined;

export function vcsAllows(status: CapabilityStatus, capability: VcsCapability): boolean {
  const capabilities = status?.capabilities;
  if (capabilities === undefined) return true;
  switch (capability) {
    case "commit":
      return capabilities.supportsCommit;
    case "push":
      return capabilities.supportsPush;
    // Change requests come from a host. Until host plugins exist, only Git has one.
    case "pullRequest":
      return capabilities.kind === GIT_VCS_KIND && capabilities.supportsPush;
    case "worktree":
      return capabilities.supportsWorktrees;
    case "reviewDiff":
      return capabilities.supportsReviewDiff;
    // "Commit on a new branch": Git, or a plugin that can start a branch from the checkout.
    case "featureBranch":
      return capabilities.kind === GIT_VCS_KIND || capabilities.supportsBranchCreate === true;
    // Publishing creates a Git remote; switching and creating refs go through Git.
    case "publish":
    case "switchRef":
      return capabilities.kind === GIT_VCS_KIND;
    case "pull":
      return capabilities.kind === GIT_VCS_KIND || capabilities.supportsPull === true;
    // Starting a worktree from the remote fetches its base first.
    case "startFromRemote":
      return capabilities.kind === GIT_VCS_KIND || capabilities.supportsFetchBase === true;
    // A plugin whose commit takes no file list commits every change.
    case "partialCommit":
      return capabilities.supportsPartialCommit !== false;
  }
}

/** Drops menu items the repository's VCS cannot run. */
export function limitGitMenuItems<Item extends { readonly id: "commit" | "push" | "pr" }>(
  items: ReadonlyArray<Item>,
  status: CapabilityStatus,
): Item[] {
  return items.filter((item) => vcsAllows(status, item.id === "pr" ? "pullRequest" : item.id));
}

/** What each action falls back to when the VCS lacks a step of it, strongest first. */
const FALLBACKS: Readonly<Record<GitStackedAction, ReadonlyArray<GitStackedAction>>> = {
  commit: ["commit"],
  push: ["push"],
  commit_push: ["commit_push", "commit"],
  commit_push_pr: ["commit_push_pr", "commit_push", "commit"],
  create_pr: ["create_pr", "push"],
};

const runs = (status: CapabilityStatus, action: GitStackedAction) => {
  switch (action) {
    case "commit":
      return vcsAllows(status, "commit");
    case "push":
      return vcsAllows(status, "push");
    case "commit_push":
      return vcsAllows(status, "commit") && vcsAllows(status, "push");
    case "commit_push_pr":
      return vcsAllows(status, "commit") && vcsAllows(status, "pullRequest");
    case "create_pr":
      return vcsAllows(status, "pullRequest");
  }
};

/**
 * Narrows a quick action to what the VCS supports: a commit, push and PR becomes a commit and
 * push, or a commit; an action the VCS cannot run at all becomes a disabled hint.
 */
export function limitGitQuickAction<
  Action extends {
    readonly label: string;
    readonly disabled: boolean;
    readonly kind: string;
    readonly action?: GitStackedAction;
    readonly hint?: string;
  },
>(
  quick: Action,
  status: CapabilityStatus,
  copy: {
    readonly labels: Readonly<Record<"commit" | "push" | "commit_push", string>>;
    readonly unsupportedHint: string;
  },
): Action {
  if (status?.capabilities === undefined) return quick;
  const unsupported = { ...quick, disabled: true, kind: "show_hint", hint: copy.unsupportedHint };
  if (quick.kind === "open_publish") return vcsAllows(status, "publish") ? quick : unsupported;
  if (quick.kind === "run_pull") return vcsAllows(status, "pull") ? quick : unsupported;
  if (quick.kind !== "run_action" || quick.action === undefined) return quick;
  const fallback = FALLBACKS[quick.action].find((action) => runs(status, action));
  if (fallback === undefined) return unsupported;
  if (fallback === quick.action) return quick;
  // Only a commit, a push, or both are left once a step drops out.
  const label = copy.labels[fallback as "commit" | "push" | "commit_push"];
  return { ...quick, action: fallback, label };
}
