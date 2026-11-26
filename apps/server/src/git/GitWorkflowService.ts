import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import {
  GIT_VCS_KIND,
  GitManagerError,
  VcsUnsupportedOperationError,
  type VcsWorkflowCommandError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";

import { toLocalStatusPart, toRemoteStatusPart } from "@t3tools/shared/git";
import type { VcsWorkflowOps } from "../vcs/VcsDriver.ts";
import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly repositoryRoot: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, VcsWorkflowCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, VcsWorkflowCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitLocalStatusOptions,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly currentBranch: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly upstreamDivergence: (cwd: string) => Effect.Effect<
      {
        readonly refName: string;
        readonly aheadCount: number;
        readonly behindCount: number;
      } | null,
      GitManagerServiceError
    >;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly readRefSnapshot: (cwd: string) => Effect.Effect<string | null>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    /** The checkout's own HEAD file, inside a linked worktree's admin directory when there is one. */
    readonly headPath: (cwd: string) => Effect.Effect<string | null, never>;
    readonly pullCurrentBranch: (
      cwd: string,
    ) => Effect.Effect<VcsPullResult, VcsWorkflowCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, VcsWorkflowCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, VcsWorkflowCommandError>;
    readonly listWorktrees: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<string>, VcsWorkflowCommandError>;
    readonly listLocalBranchNames: (
      cwd: string,
    ) => Effect.Effect<string[], VcsWorkflowCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, VcsWorkflowCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, VcsWorkflowCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, VcsWorkflowCommandError>;
    readonly resolvePrimaryRemoteName: (
      cwd: string,
    ) => Effect.Effect<string, VcsWorkflowCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      VcsWorkflowCommandError
    >;
    readonly resolveWorktreeBaseRemote: (
      input: GitVcsDriver.GitFetchWorktreeBaseCommitInput,
    ) => Effect.Effect<GitVcsDriver.GitWorktreeBaseRemote | null, VcsWorkflowCommandError>;
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly remote?: GitVcsDriver.GitWorktreeBaseRemote;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      VcsWorkflowCommandError
    >;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, VcsWorkflowCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, VcsWorkflowCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, VcsWorkflowCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, VcsWorkflowCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, VcsWorkflowCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, VcsWorkflowCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

type DriverHandle = VcsDriverRegistry.VcsDriverHandle;

function unsupported(handle: DriverHandle, operation: string) {
  return new VcsUnsupportedOperationError({
    kind: handle.kind,
    operation,
    detail: "The selected VCS driver does not support this operation.",
  });
}

function route<A, E>(
  handle: DriverHandle,
  operation: string,
  runGit: () => Effect.Effect<A, E>,
  runDriver?: (ops: VcsWorkflowOps) => Effect.Effect<A, VcsWorkflowCommandError> | undefined,
): Effect.Effect<A, E | VcsWorkflowCommandError> {
  if (handle.kind === GIT_VCS_KIND) return runGit();
  return runDriver?.(handle.driver.workflow ?? {}) ?? Effect.fail(unsupported(handle, operation));
}

/** Ref names a driver lists, for the checks a worktree launch runs before it creates one. */
function driverRefNames(ops: VcsWorkflowOps, cwd: string, local: boolean) {
  return ops
    .listRefs?.({ cwd, ...(local ? { refKind: "local" as const } : {}) })
    .pipe(Effect.map((result) => result.refs.map((ref) => ref.name)));
}

function driverStatus(
  handle: DriverHandle,
  input: VcsStatusInput,
): Effect.Effect<VcsStatusResult, VcsWorkflowCommandError> {
  return (
    handle.driver.workflow?.status?.(input) ??
    Effect.fail(unsupported(handle, "GitWorkflowService.status"))
  );
}

function withCapabilities<A extends VcsStatusLocalResult>(handle: DriverHandle, status: A): A {
  const capabilities = handle.driver.capabilities;
  return capabilities ? { ...status, capabilities } : status;
}

const runDriverAction = Effect.fn("GitWorkflowService.runDriverAction")(function* (
  handle: DriverHandle,
  input: GitRunStackedActionInput,
  options: GitManager.GitRunStackedActionOptions | undefined,
  writeCommitMessage: GitManager.GitManager["Service"]["writeCommitMessage"],
) {
  const { action, cwd } = input;
  if (input.featureBranch || action === "create_pr" || action === "commit_push_pr") {
    return yield* unsupported(handle, input.featureBranch ? "featureBranch" : "create_pr");
  }
  const ops = handle.driver.workflow;
  const commit = action === "push" ? undefined : ops?.commit;
  const push = action === "commit" ? undefined : ops?.push;
  // Check the whole request before committing anything on a driver that cannot push.
  if (action !== "push" && !commit) return yield* unsupported(handle, "commit");
  if (action !== "commit" && !push) return yield* unsupported(handle, "push");

  const context = { action, cwd, actionId: options?.actionId ?? input.actionId };
  const reporter = options?.progressReporter;
  const phases: Array<"commit" | "push"> = [];
  if (commit) phases.push("commit");
  if (push) phases.push("push");
  if (reporter) yield* reporter.publish({ ...context, kind: "action_started", phases });
  const skipped = { status: "skipped_not_requested" } as const;
  const runPhase = <A, E extends { readonly message: string }>(
    phase: "commit" | "push",
    effect: Effect.Effect<A, E>,
  ) =>
    reporter
      ? reporter.publish({ ...context, kind: "phase_started", phase, label: phase }).pipe(
          Effect.andThen(effect),
          Effect.tapError((error) =>
            reporter.publish({ ...context, kind: "action_failed", phase, message: error.message }),
          ),
        )
      : effect;
  const result: GitRunStackedActionResult = {
    action,
    branch: skipped,
    commit: commit
      ? yield* runPhase(
          "commit",
          Effect.gen(function* () {
            const typed = input.commitMessage?.trim();
            if (typed)
              return yield* commit({ cwd, commitMessage: typed, filePaths: input.filePaths });
            // Written as for Git, from what the driver says changed.
            const status = yield* driverStatus(handle, { cwd });
            const selected = input.filePaths ? new Set(input.filePaths) : null;
            const files = status.workingTree.files.filter(
              (file) => selected === null || selected.has(file.path),
            );
            if (files.length === 0) return { status: "skipped_no_changes" as const };
            if (reporter)
              yield* reporter.publish({
                ...context,
                kind: "phase_started",
                phase: "commit",
                label: "Generating commit message...",
              });
            const patch = yield* (
              handle.driver.workflow?.workingDiff?.({ cwd, filePaths: input.filePaths }) ??
              Effect.succeed("")
            ).pipe(Effect.orElseSucceed(() => ""));
            const commitMessage = yield* writeCommitMessage({
              cwd,
              threadId: input.threadId,
              branch: status.refName,
              summary: files
                .map((file) => `${file.path} (+${file.insertions} -${file.deletions})`)
                .join("\n"),
              patch,
            });
            return yield* commit({ cwd, commitMessage, filePaths: input.filePaths });
          }),
        )
      : skipped,
    push: push ? yield* runPhase("push", push({ cwd })) : skipped,
    pr: skipped,
    toast: { title: "Done", cta: { kind: "none" } },
  };
  if (reporter) yield* reporter.publish({ ...context, kind: "action_finished", result });
  return result;
});

/**
 * Worktrees of the checkout at `cwd`, as the VCS that owns it lists them. Needs only the driver
 * registry, so services below the Git workflow (known workspaces) can ask too.
 */
export const makeListWorktrees =
  (
    registry: VcsDriverRegistry.VcsDriverRegistry["Service"],
    git: GitVcsDriver.GitVcsDriver["Service"],
  ) =>
  (cwd: string): Effect.Effect<ReadonlyArray<string>, VcsWorkflowCommandError> => {
    const operation = "GitWorkflowService.listWorktrees";
    if (!registry.hasAdditionalDrivers) return git.listWorktreePaths(cwd);
    return registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
      Effect.flatMap((handle) =>
        route<ReadonlyArray<string>, GitCommandError>(
          handle,
          operation,
          () => git.listWorktreePaths(cwd),
          (ops) => ops.listWorktrees?.({ cwd }),
        ),
      ),
    );
  };

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fileSystem = yield* FileSystem.FileSystem;

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  const resolveWorkflow = Effect.fn("GitWorkflowService.resolveWorkflow")(function* (
    operation: string,
    cwd: string,
  ) {
    return yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
  });

  const resolveCommand = Effect.fn("GitWorkflowService.resolveCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    return yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
  });

  const detectWorkflow = Effect.fn("GitWorkflowService.detectWorkflow")(function* (
    operation: string,
    cwd: string,
  ) {
    return yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to detect a VCS repository for this Git workflow.",
            cause,
          }),
      ),
    );
  });

  const detectCommand = Effect.fn("GitWorkflowService.detectCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    return yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
  });

  const listWorktrees = makeListWorktrees(registry, git);

  const isGitCheckout = (cwd: string) =>
    registry.detect({ cwd }).pipe(
      Effect.map((handle) => handle?.kind === GIT_VCS_KIND),
      Effect.orElseSucceed(() => false),
    );

  const routeCommand = <A>(
    operation: string,
    cwd: string,
    runGit: () => Effect.Effect<A, GitCommandError>,
    runDriver?: (ops: VcsWorkflowOps) => Effect.Effect<A, GitCommandError> | undefined,
  ) =>
    resolveCommand(operation, cwd).pipe(
      Effect.flatMap((handle) => route(handle, operation, runGit, runDriver)),
    );

  return GitWorkflowService.of({
    repositoryRoot: Effect.fn("GitWorkflowService.repositoryRoot")(function (cwd) {
      return detectWorkflow("GitWorkflowService.repositoryRoot", cwd).pipe(
        Effect.map((handle) => handle?.repository.rootPath ?? null),
      );
    }),
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function (input) {
      return routeCommand(
        "GitWorkflowService.hasCommit",
        input.cwd,
        () =>
          git
            .execute({
              operation: "GitWorkflowService.hasCommit",
              cwd: input.cwd,
              args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
              allowNonZeroExit: true,
            })
            .pipe(Effect.map((result) => result.exitCode === 0)),
        // A driver cannot resolve arbitrary revisions; its worktreeCreate reports a bad base.
        (ops) => {
          const branch = /^refs\/heads\/(.+)$/.exec(input.refName)?.[1];
          if (branch === undefined) return Effect.succeed(true);
          return driverRefNames(ops, input.cwd, true)?.pipe(
            Effect.map((names) => names.includes(branch)),
          );
        },
      );
    }),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")(function (input) {
      // Pattern characters would widen the ref match.
      if (/[*?[\\]/.test(input.refName)) return Effect.succeed(false);
      return routeCommand(
        "GitWorkflowService.hasRefNamed",
        input.cwd,
        () =>
          git
            .execute({
              operation: "GitWorkflowService.hasRefNamed",
              cwd: input.cwd,
              args: [
                "for-each-ref",
                "--count=1",
                "--format=%(refname)",
                `refs/**/${input.refName}`,
              ],
            })
            .pipe(Effect.map((result) => result.stdout.trim().length > 0)),
        (ops) =>
          driverRefNames(ops, input.cwd, false)?.pipe(
            Effect.map((names) => names.includes(input.refName)),
          ),
      );
    }),
    status: Effect.fn("GitWorkflowService.status")(function* (input) {
      const handle = yield* detectWorkflow("GitWorkflowService.status", input.cwd);
      if (!handle) return nonRepositoryStatus();
      const status = yield* handle.kind === GIT_VCS_KIND
        ? gitManager.status(input)
        : driverStatus(handle, input);
      return withCapabilities(handle, status);
    }),
    localStatus: Effect.fn("GitWorkflowService.localStatus")(function* (input, options) {
      const handle = yield* detectWorkflow("GitWorkflowService.localStatus", input.cwd);
      if (!handle) return nonRepositoryLocalStatus();
      const local = yield* handle.kind === GIT_VCS_KIND
        ? gitManager.localStatus(input, options)
        : Effect.map(driverStatus(handle, input), toLocalStatusPart);
      return withCapabilities(handle, local);
    }),
    currentBranch: Effect.fn("GitWorkflowService.currentBranch")(function* (cwd) {
      const handle = yield* detectWorkflow("GitWorkflowService.currentBranch", cwd);
      if (!handle) return null;
      if (handle.kind !== GIT_VCS_KIND) return (yield* driverStatus(handle, { cwd })).refName;
      const result = yield* git.execute({
        operation: "GitWorkflowService.currentBranch",
        cwd,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0) {
        return result.stdout.trim().replace(/^refs\/heads\//, "") || null;
      }
      if (result.exitCode === 1) return null;
      return yield* new GitCommandError({
        operation: "GitWorkflowService.currentBranch",
        command: "git symbolic-ref",
        cwd,
        argumentCount: 3,
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        detail: "Failed to read the checked-out branch.",
      });
    }),
    upstreamDivergence: Effect.fn("GitWorkflowService.upstreamDivergence")(function* (cwd) {
      // Git's status watcher already knows the checkout; keep its frequent probes on the fast path.
      if (registry.hasAdditionalDrivers) {
        const handle = yield* detectWorkflow("GitWorkflowService.upstreamDivergence", cwd);
        if (!handle) return null;
        if (handle.kind !== GIT_VCS_KIND) {
          const { hasUpstream, refName, aheadCount, behindCount } = yield* driverStatus(handle, {
            cwd,
          });
          return hasUpstream && refName !== null ? { refName, aheadCount, behindCount } : null;
        }
      }
      const details = yield* git.statusDetailsRemote(cwd, { refreshUpstream: false });
      return details.hasUpstream && details.branch !== null
        ? {
            refName: details.branch,
            aheadCount: details.aheadCount,
            behindCount: details.behindCount,
          }
        : null;
    }),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")(function* (input, options) {
      const handle = yield* detectWorkflow("GitWorkflowService.remoteStatus", input.cwd);
      if (!handle) return null;
      return yield* handle.kind === GIT_VCS_KIND
        ? gitManager.remoteStatus(input, options)
        : Effect.map(driverStatus(handle, input), toRemoteStatusPart);
    }),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    readRefSnapshot: Effect.fn("GitWorkflowService.readRefSnapshot")(function* (cwd) {
      if (registry.hasAdditionalDrivers && !(yield* isGitCheckout(cwd))) return null;
      return yield* git.readRefSnapshot(cwd);
    }),
    invalidateStatus: gitManager.invalidateStatus,
    headPath: Effect.fn("GitWorkflowService.headPath")(function* (cwd) {
      // Clients keep watching threads whose worktree was removed; spawning there fails noisily.
      if (!(yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true)))) return null;
      if (registry.hasAdditionalDrivers && !(yield* isGitCheckout(cwd))) return null;
      return yield* git
        .execute({
          operation: "GitWorkflowService.headPath",
          cwd,
          args: ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
          Effect.orElseSucceed(() => null),
        );
    }),
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")(function (cwd) {
      return routeCommand(
        "GitWorkflowService.pullCurrentBranch",
        cwd,
        () => git.pullCurrentBranch(cwd),
        (ops) => ops.pull?.({ cwd }),
      );
    }),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")(function* (input, options) {
      const handle = yield* resolveWorkflow("GitWorkflowService.runStackedAction", input.cwd);
      return yield* withCheckoutLease(
        handle.repository.rootPath,
        handle.kind === GIT_VCS_KIND
          ? gitManager.runStackedAction(input, options)
          : runDriverAction(handle, input, options, gitManager.writeCommitMessage),
      );
    }),
    resolvePullRequest: Effect.fn("GitWorkflowService.resolvePullRequest")(function* (input) {
      const operation = "GitWorkflowService.resolvePullRequest";
      return yield* route(yield* resolveWorkflow(operation, input.cwd), operation, () =>
        gitManager.resolvePullRequest(input),
      );
    }),
    preparePullRequestThread: Effect.fn("GitWorkflowService.preparePullRequestThread")(
      function* (input) {
        const operation = "GitWorkflowService.preparePullRequestThread";
        const handle = yield* resolveWorkflow(operation, input.cwd);
        if (handle.kind !== GIT_VCS_KIND) return yield* unsupported(handle, operation);
        const prepare = gitManager.preparePullRequestThread(input);
        return yield* input.mode === "local"
          ? withCheckoutLease(handle.repository.rootPath, prepare)
          : prepare;
      },
    ),
    listRefs: Effect.fn("GitWorkflowService.listRefs")(function* (input) {
      const operation = "GitWorkflowService.listRefs";
      const handle = yield* detectCommand(operation, input.cwd);
      if (!handle) return nonRepositoryListRefs();
      return yield* route(
        handle,
        operation,
        () => git.listRefs(input),
        (ops) => ops.listRefs?.(input),
      );
    }),
    createWorktree: Effect.fn("GitWorkflowService.createWorktree")(function (input, options) {
      return routeCommand(
        "GitWorkflowService.createWorktree",
        input.cwd,
        () => gitManager.createWorktree(input, options),
        (ops) => ops.createWorktree?.(input),
      );
    }),
    listWorktrees: Effect.fn("GitWorkflowService.listWorktrees")(function (cwd) {
      return listWorktrees(cwd);
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")(function (cwd) {
      return routeCommand(
        "GitWorkflowService.listLocalBranchNames",
        cwd,
        () => git.listLocalBranchNames(cwd),
        (ops) => driverRefNames(ops, cwd, true)?.pipe(Effect.map((names) => [...names])),
      );
    }),
    fetchRemote: Effect.fn("GitWorkflowService.fetchRemote")(function (input) {
      return routeCommand("GitWorkflowService.fetchRemote", input.cwd, () =>
        git.fetchRemote(input),
      );
    }),
    remoteExists: Effect.fn("GitWorkflowService.remoteExists")(function (input) {
      return routeCommand("GitWorkflowService.remoteExists", input.cwd, () =>
        git.remoteExists(input),
      );
    }),
    remoteBranchExists: Effect.fn("GitWorkflowService.remoteBranchExists")(function (input) {
      return routeCommand("GitWorkflowService.remoteBranchExists", input.cwd, () =>
        git.remoteBranchExists(input),
      );
    }),
    resolvePrimaryRemoteName: Effect.fn("GitWorkflowService.resolvePrimaryRemoteName")(
      function (cwd) {
        return routeCommand("GitWorkflowService.resolvePrimaryRemoteName", cwd, () =>
          git.resolvePrimaryRemoteName(cwd),
        );
      },
    ),
    resolveRemoteTrackingCommit: Effect.fn("GitWorkflowService.resolveRemoteTrackingCommit")(
      function (input) {
        return routeCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd, () =>
          git.resolveRemoteTrackingCommit(input),
        );
      },
    ),
    resolveWorktreeBaseRemote: Effect.fn("GitWorkflowService.resolveWorktreeBaseRemote")(
      function (input) {
        return routeCommand(
          "GitWorkflowService.resolveWorktreeBaseRemote",
          input.cwd,
          () => git.resolveWorktreeBaseRemote(input),
          // A driver's worktreeCreate starts from the base it is given; there is nothing to fetch.
          () => Effect.succeed(null),
        );
      },
    ),
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function (input) {
        return routeCommand(
          "GitWorkflowService.fetchWorktreeBaseCommit",
          input.cwd,
          () => git.fetchWorktreeBaseCommit(input),
          () => Effect.succeed(null),
        );
      },
    ),
    resolveDefaultBranchName: Effect.fn("GitWorkflowService.resolveDefaultBranchName")(
      function (cwd, remoteName) {
        return routeCommand(
          "GitWorkflowService.resolveDefaultBranchName",
          cwd,
          () => git.resolveDefaultBranchName(cwd, remoteName),
          () => Effect.succeed(null),
        );
      },
    ),
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(function (input) {
      return routeCommand(
        "GitWorkflowService.removeWorktree",
        input.cwd,
        () => git.removeWorktree(input),
        (ops) => ops.removeWorktree?.(input),
      );
    }),
    pruneWorktrees: Effect.fn("GitWorkflowService.pruneWorktrees")(function (input) {
      return routeCommand(
        "GitWorkflowService.pruneWorktrees",
        input.cwd,
        () => git.pruneWorktrees(input),
        (ops) => ops.pruneWorktrees?.(input),
      );
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")(function (input) {
      return routeCommand("GitWorkflowService.deleteLocalBranch", input.cwd, () =>
        git.deleteLocalBranch(input),
      );
    }),
    createRef: Effect.fn("GitWorkflowService.createRef")(function* (input) {
      const operation = "GitWorkflowService.createRef";
      const handle = yield* resolveCommand(operation, input.cwd);
      const create = route(
        handle,
        operation,
        () => git.createRef(input),
        (ops) => ops.createRef?.(input),
      );
      return yield* input.switchRef
        ? withCheckoutLease(handle.repository.rootPath, create)
        : create;
    }),
    switchRef: Effect.fn("GitWorkflowService.switchRef")(function* (input) {
      const operation = "GitWorkflowService.switchRef";
      const handle = yield* resolveCommand(operation, input.cwd);
      return yield* withCheckoutLease(
        handle.repository.rootPath,
        route(
          handle,
          operation,
          () => Effect.scoped(git.switchRef(input)),
          (ops) => ops.switchRef?.(input),
        ),
      );
    }),
    renameBranch: Effect.fn("GitWorkflowService.renameBranch")(function* (input) {
      const operation = "GitWorkflowService.renameBranch";
      return yield* route(yield* resolveWorkflow(operation, input.cwd), operation, () =>
        git.renameBranch(input),
      );
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
