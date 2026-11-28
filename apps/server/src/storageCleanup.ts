// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import {
  CheckpointRef,
  CheckpointScopeId,
  GitCommandError,
  type VcsDriverKind,
  type VcsWorkflowCommandError,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
  VcsRemoveWorktreeInput,
  StorageCleanupReport,
  StorageCleanupReportEntry,
  ThreadId,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { parse as parseYaml } from "yaml";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import { nativeRealPath, nativeRealPathWithMissingTail } from "./nativeRealPath.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import { scratchFolderRoot } from "./project/ManagedProjectFolders.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { checkpointRefForScopeOrdinal } from "./orchestration-v2/CheckpointService.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { MAX_OVERDUE_ARM_MS } from "./orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as WorktreeBranchSync from "./orchestration-v2/WorktreeBranchSync.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "./worktreesDirectory.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import {
  hasNativeCheckpointsIn,
  pluginCheckpointsWithPrefixes,
} from "./plugins/pluginCheckpoints.ts";
import { VcsPluginDrivers } from "./plugins/VcsPluginDrivers.ts";
import { isNonRepositoryGitStderr } from "./vcs/GitVcsDriverCore.ts";
import { worktreeRemovalChecks } from "./vcs/worktreeRemovalChecks.ts";
import { isLinkedWorktree, removeLinkedWorktree } from "./vcs/worktreeRemoval.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import {
  resolveWorkspaceLocation,
  withWorkspaceLease,
  withExclusiveWorkspaceReservation,
} from "./workspace/workspaceLease.ts";
import { makeWorktreeUseGuard, pendingWorktrees } from "./workspace/worktreeUsage.ts";
import { worktreeRootForProject } from "./workspace/worktreeProjectPath.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { isNetworkPath } from "@t3tools/shared/path";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
// pnpm 11 writes this file as JSON, older versions as YAML.
const decodePnpmModulesManifest = Schema.decodeUnknownEffect(
  Schema.Struct({
    storeDir: Schema.String,
    virtualStoreDir: Schema.optional(Schema.String),
  }),
);

class PnpmModulesManifestParseError extends Schema.TaggedError<PnpmModulesManifestParseError>()(
  "PnpmModulesManifestParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not parse the pnpm modules manifest.";
  }
}

class WorktreeDirectoryReadError extends Schema.TaggedError<WorktreeDirectoryReadError>()(
  "WorktreeDirectoryReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read a worktree directory.";
  }
}

const DAY_MS = 86_400_000;
// Give settle scripts time to open terminals that protect the worktree.
const SETTLE_SCRIPT_GRACE_MS = 60_000;
// Worktree creation can precede its thread row, including review-guide checkouts.
const ORPHAN_WORKTREE_GRACE_MS = 60 * 60 * 1_000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const REPORT_ENTRY_LIMIT = 200;
const isGitCommandError = Schema.is(GitCommandError);
function cleanupFailureReason(error: { readonly message: string }) {
  return isGitCommandError(error)
    ? `${error.command}: ${error.detail.split(/\r?\n/)[0]}${error.reason ? ` (${error.reason})` : ""}`
    : (error.message.split(/\r?\n/)[0] ?? error.message);
}

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeSettledAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

type LimitRecoverySettings = Pick<
  ServerSettings,
  "autoResumeLimitedThreads" | "snoozeLimitedThreads"
>;

// A folder a plugin marks while the project's VCS did not answer or its plugin is off.
// Not a valid plugin id, so no plugin is ever mistaken for it.
const UNVERIFIED_PLUGIN = "!unverified" as VcsDriverKind;
// A plugin may keep native snapshots inside the checkout; a live thread would lose them.
const NATIVE_CHECKPOINTS_REASON =
  "its VCS plugin's snapshots of the thread's checkpoints are in it";

export function storageCleanupThreadIdle(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  return thread.worktreePath !== null && threadIdle(thread, now, settings);
}

function threadIdle(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  return (
    thread.activeRunId === null &&
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "interrupted" ||
      thread.status === "failed" ||
      thread.status === "cancelled" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now) &&
    !heldForLimitRecovery(thread, now, settings)
  );
}

// A run held for its usage-limit reset has its work still ahead of it, and a
// fresh worktree would otherwise look unchanged and be removed before it runs.
function heldForLimitRecovery(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled"
  )
    return false;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  const recovery = thread.limitRecovery;
  if (recovery?.runId === thread.latestRunId && recovery.resetAt === thread.usageLimitResetAt)
    // An auto-resume holds until its continuation replaces the failed run.
    return recovery.autoResume || (recovery.snooze === true && resetMs > now);
  // The recovery worker arms this failure on a later tick; hold it until then.
  // Like the worker, skip a reset that had already passed when the run ended
  // or that is too overdue to arm.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt) ||
    now - resetMs > MAX_OVERDUE_ARM_MS
  )
    return false;
  return settings.autoResumeLimitedThreads || (settings.snoozeLimitedThreads && resetMs > now);
}

/** PR metadata refreshes must not reset the inactivity clock. */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

/** Only a complete subagent or side chat chain within this worktree shares ownership. */
function worktreeOwner<T extends Pick<OrchestrationV2ThreadShell, "id" | "lineage">>(
  threads: ReadonlyArray<T>,
) {
  if (threads.length === 1) return threads[0];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const tops = threads.filter((thread) => !byId.has(thread.lineage.parentThreadId!));
  if (tops.length !== 1) return undefined;
  const owner = tops[0]!;
  for (const thread of threads) {
    let current = thread;
    const seen = new Set<string>();
    while (current.id !== owner.id) {
      if (
        seen.has(current.id) ||
        (current.lineage.relationshipToParent !== "subagent" &&
          current.lineage.sideChat !== true) ||
        current.lineage.rootThreadId !== owner.lineage.rootThreadId
      )
        return undefined;
      seen.add(current.id);
      const parent = byId.get(current.lineage.parentThreadId!);
      if (parent === undefined) return undefined;
      current = parent;
    }
  }
  return owner;
}

function worktreeSettlementChain(
  thread: OrchestrationV2ThreadShell,
  byId: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
  now: number,
  settings: LimitRecoverySettings,
) {
  const chain = [thread];
  let current = thread;
  while (current.settledAt === null) {
    if (
      current.lineage.relationshipToParent !== "subagent" ||
      current.settledOverride === "active" ||
      current.pinnedAt != null
    )
      return [];
    const parent = byId.get(current.lineage.parentThreadId!);
    if (
      parent === undefined ||
      chain.some((member) => member.id === parent.id) ||
      parent.projectId !== thread.projectId ||
      parent.lineage.rootThreadId !== thread.lineage.rootThreadId ||
      !threadIdle(parent, now, settings)
    )
      return [];
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** Squash/rebase merges require the merged PR to name this exact head commit. */
export function storageCleanupPullRequestMerged(
  pullRequest: Pick<
    GitManager.GitBranchPullRequest,
    "state" | "headRef" | "baseRef" | "headSha"
  > | null,
  worktree: {
    readonly branch: string;
    readonly defaultBranch: string;
    readonly headSha: string;
    readonly integrated: boolean;
  },
): boolean {
  return (
    pullRequest?.state === "merged" &&
    (worktree.integrated ||
      (pullRequest.headRef === worktree.branch &&
        pullRequest.baseRef === worktree.defaultBranch &&
        pullRequest.headSha === worktree.headSha))
  );
}

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly worktreeThreadIds: (
      folder: string,
      projectCwd?: string,
    ) => Effect.Effect<{ threadIds: ThreadId[]; worktreeRoot: string }, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, VcsWorkflowCommandError>;
    readonly runNow: Effect.Effect<StorageCleanupReport, ServerSettingsError>;
    readonly latestReport: Effect.Effect<StorageCleanupReport | null>;
    readonly reports: Stream.Stream<StorageCleanupReport | null>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/storageCleanup") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const ensureUnused = yield* makeWorktreeUseGuard;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const plugins = Option.getOrUndefined(yield* Effect.serviceOption(VcsPluginDrivers));
  const gitWorkflowHasPlugins = () => plugins?.hasAny() === true;
  const reconcileBranch = yield* WorktreeBranchSync.makeReconcile;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const orphanSizes = new Map<string, number | null>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const isWindows = yield* HostProcess.isWindows;
  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  // A VCS plugin's worktree: the plugin that owns the project lists it, and the folder carries
  // that plugin's marker. Its kind, or null for anything else.
  const projectPlugin = Effect.fnUntraced(function* (projectRoot: string) {
    const project = yield* gitWorkflow
      .localStatus({ cwd: projectRoot })
      .pipe(Effect.orElseSucceed(() => null));
    if (project === null) return "unanswered" as const;
    const kind = project.capabilities?.kind;
    const plugin = kind === undefined ? undefined : plugins?.describe(kind);
    return kind === undefined || plugin === undefined ? null : { kind, plugin };
  });
  const pluginWorktreeKind = Effect.fnUntraced(function* (
    worktreePath: string,
    projectRoot: string,
  ) {
    // Every plugin off: still never handed to Git when an installed plugin marks it.
    if (!gitWorkflowHasPlugins() && (plugins?.installedMarkers() ?? []).length === 0) return null;
    // Even beside a `.git`: the plugin's marker decides which VCS owns the folder.
    const project = gitWorkflowHasPlugins() ? yield* projectPlugin(projectRoot) : null;
    if (project === "unanswered" || project === null) {
      // The project's VCS did not answer, or its plugin is off: a folder any installed plugin
      // marks is never handed to Git, which cannot see the plugin's commits or snapshots.
      for (const marker of plugins?.installedMarkers() ?? []) {
        if (
          yield* fs.exists(path.join(worktreePath, marker)).pipe(Effect.orElseSucceed(() => true))
        )
          return UNVERIFIED_PLUGIN;
      }
      return null;
    }
    const { kind, plugin } = project;
    let marked = false;
    for (const marker of plugin.markers) {
      if (yield* fs.exists(path.join(worktreePath, marker)).pipe(Effect.orElseSucceed(() => false)))
        marked = true;
    }
    if (!marked) {
      // Another installed plugin's checkout is never handed to Git either.
      for (const marker of plugins?.installedMarkers() ?? []) {
        if (
          yield* fs.exists(path.join(worktreePath, marker)).pipe(Effect.orElseSucceed(() => true))
        )
          return UNVERIFIED_PLUGIN;
      }
      return null;
    }
    // A listing that fails cannot hand the folder to Git: the plugin's own removal checks again.
    const listed = yield* gitWorkflow
      .listWorktrees(projectRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> | null => null));
    if (listed === null) return kind;
    const real = (folder: string) =>
      fs.realPath(folder).pipe(Effect.orElseSucceed(() => path.resolve(folder)));
    const target = pathKey(yield* real(worktreePath));
    for (const entry of listed) if (pathKey(yield* real(entry)) === target) return kind;
    // Marked, yet not the plugin's: Git cannot see the plugin's commits or snapshots there.
    return UNVERIFIED_PLUGIN;
  });
  // The checkout around `target` for a plugin's worktree, found by the project plugin's marker as
  // that plugin's removal resolves it; null inside the project's repository itself.
  const pluginCheckoutAround = Effect.fnUntraced(function* (target: string, projectCwd: string) {
    if (!gitWorkflowHasPlugins()) return null;
    const project = yield* projectPlugin(projectCwd);
    // Unanswered, any installed plugin's marker counts: the removal may still resolve upward.
    const markers =
      project === "unanswered"
        ? (plugins?.installedMarkers() ?? [])
        : (project?.plugin.markers ?? []);
    if (markers.length === 0) return null;
    // Physical ancestors, as the plugin's removal resolves them: a link's own name would
    // check a smaller folder than the one removed.
    let folder = yield* fs
      .realPath(path.resolve(target))
      .pipe(Effect.orElseSucceed(() => path.resolve(target)));
    const projectRoot = yield* fs
      .realPath(projectCwd)
      .pipe(Effect.orElseSucceed(() => path.resolve(projectCwd)));
    // The nearest repository decides: a `.git` or another plugin's marker below this one's
    // makes the target that repository's, not a folder of the checkout around it.
    const others = [
      ".git",
      ...(plugins?.installedMarkers() ?? []).filter((marker) => !markers.includes(marker)),
    ];
    while (true) {
      for (const marker of markers) {
        if (yield* fs.exists(path.join(folder, marker)).pipe(Effect.orElseSucceed(() => false)))
          return inside(folder, projectRoot) || pathKey(folder) === pathKey(projectRoot)
            ? null
            : folder;
      }
      for (const other of others) {
        if (yield* fs.exists(path.join(folder, other)).pipe(Effect.orElseSucceed(() => true)))
          return null;
      }
      const parent = path.dirname(folder);
      if (parent === folder) return null;
      folder = parent;
    }
  });
  // What the plugin's status says about one of its worktrees, read fresh for each check.
  // Recorded under the checkout's real root, as checkpoint capture resolves it.
  const holdsNativeCheckpoints = Effect.fnUntraced(function* (checkoutPath: string) {
    const real = yield* fs.realPath(checkoutPath).pipe(Effect.orElseSucceed(() => checkoutPath));
    return yield* hasNativeCheckpointsIn([real, path.resolve(checkoutPath)]).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });
  const pluginWorktreeState = Effect.fnUntraced(function* (
    worktreePath: string,
    branch: string | null,
    rules: WorktreeCleanupRules,
  ) {
    const status = yield* gitWorkflow.status({ cwd: worktreePath });
    const plugin = plugins?.describe(status.capabilities?.kind ?? "");
    // Untracked files count unless the rule keeps only tracked changes. A plugin lists no
    // ignored files, so "any local files" sees only what its status shows.
    const files = status.workingTree.files.filter(
      (file) => rules.worktreeKeepWhen !== "tracked-changes" || file.untracked !== true,
    ).length;
    return {
      kind: status.capabilities?.kind,
      label: plugin?.label ?? "Its VCS plugin",
      recreates: plugin?.recreatesWorktrees === true,
      branchChanged: status.refName !== branch,
      changes:
        files > 0
          ? `has uncommitted changes (${files} ${files === 1 ? "file" : "files"})`
          : // Some VCSs keep a worktree's branch only in the worktree, so its commits go with it.
            status.aheadCount > 0
            ? "has commits that are not pushed"
            : null,
    };
  });
  const worktreePathsForCheck = () => {
    // Threads may store one checkout through different symlinked spellings; compare real paths.
    // Keys are only compared, never opened, so they take pathKey's Windows case folding.
    const canonicalPaths = new Map<string, string>();
    const canonical = Effect.fnUntraced(function* (target: string) {
      const resolved = path.resolve(target);
      const cached = canonicalPaths.get(resolved);
      if (cached !== undefined) return cached;
      const realPath = yield* resolveWorkspaceLocation(fs, path, resolved).pipe(
        Effect.orElseSucceed(() => resolved),
      );
      const key = pathKey(realPath);
      canonicalPaths.set(resolved, key);
      return key;
    });
    // A cwd in a deleted folder cannot be resolved, so stored spellings are compared too.
    const occupies = Effect.fnUntraced(function* (
      worktreePaths: ReadonlyArray<string>,
      target: string,
    ) {
      const targets = [path.resolve(target), yield* canonical(target)];
      return worktreePaths.some((worktree) =>
        targets.some((cwd) => pathKey(cwd) === pathKey(worktree) || inside(worktree, cwd)),
      );
    });
    return { canonical, occupies };
  };
  const removalRoot = Effect.fn("StorageCleanup.removalRoot")(function* (
    folder: string,
    projectCwd?: string,
  ) {
    const target = path.resolve(projectCwd ?? "", folder);
    const taskFolder = yield* taskFolders.find(target);
    // A plugin removes the whole checkout around any path in it, so its checks cover all of it.
    const pluginCheckout =
      projectCwd === undefined ? null : yield* pluginCheckoutAround(target, projectCwd);
    return (
      taskFolder?.root ??
      pluginCheckout ??
      (projectCwd === undefined
        ? ((yield* gitWorkflow.repositoryRoot(target)) ?? target)
        : yield* worktreeRootForProject(
            fs,
            path,
            target,
            projectCwd,
            undefined,
            // Installed ones too: an off plugin's checkout is still the nearest repository.
            [...new Set([...(plugins?.markers() ?? []), ...(plugins?.installedMarkers() ?? [])])],
          ))
    );
  });
  const boundThreads = Effect.fn("StorageCleanup.boundThreads")(function* (root: string) {
    const { canonical, occupies } = worktreePathsForCheck();
    const paths = [root, yield* canonical(root)];
    const bindings = yield* projections.getThreadWorktreePaths({ includeArchived: true });
    const occupants = yield* Effect.filter(bindings, (binding) =>
      occupies(paths, binding.worktreePath),
    );
    return occupants.map((binding) => binding.threadId);
  });
  const checkFailed = (cwd: string) => (cause: unknown) =>
    new GitCommandError({
      operation: "StorageCleanup.worktreeThreadIds",
      cwd,
      command: "git worktree remove",
      detail: "Could not check which threads use this worktree.",
      cause,
    });
  const worktreeThreadIds = Effect.fn("StorageCleanup.worktreeThreadIds")(function* (
    folder: string,
    projectCwd?: string,
  ) {
    return yield* Effect.gen(function* () {
      const root = yield* removalRoot(folder, projectCwd);
      const threadIds = yield* boundThreads(root);
      const contains = yield* projectInWorktree(root);
      for (const project of yield* projectStore.listShells()) {
        if (!(yield* contains(project))) continue;
        const snapshot = yield* projections.getShellSnapshot({ projectId: project.id });
        for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
          if (thread.worktreePath === null) threadIds.push(thread.id);
        }
      }
      return { threadIds, worktreeRoot: root };
    }).pipe(Effect.mapError(checkFailed(folder)));
  });

  const withCleanupLease = <A, E, R>(
    root: string,
    effect: Effect.Effect<A, E, R>,
    protectedRoot = root,
  ) => withExclusiveWorkspaceReservation(fs, path, protectedRoot, withWorkspaceLease(root, effect));

  const removeWorktree = Effect.fn("StorageCleanup.removeWorktree")(function* (
    input: VcsRemoveWorktreeInput,
  ) {
    const remove = Effect.gen(function* () {
      const removed = yield* taskFolders
        .removeIfTaskFolder({ path: input.path, force: input.force === true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "TaskFolders.remove",
                command: "git worktree remove",
                cwd: input.cwd,
                detail: cause.detail,
              }),
          ),
        );
      if (!removed) yield* gitWorkflow.removeWorktree(input);
    });
    if (!input.onlyIfUnused) return yield* remove;
    const root = yield* removalRoot(input.path, input.cwd).pipe(
      Effect.mapError(checkFailed(input.cwd)),
    );
    return yield* withCleanupLease(root, ensureUnused(root).pipe(Effect.andThen(remove)));
  });
  // pnpm imports packages by clone or reflink when its store shares a device
  // with the worktree. Those files have one link but share blocks with the
  // store, so removing them frees almost nothing. A store on another device
  // forces real copies, which still count.
  const sharedPnpmVirtualStore = Effect.fnUntraced(
    function* (root: string) {
      const nodeModules = path.join(root, "node_modules");
      const text = yield* fs.readFileString(path.join(nodeModules, ".modules.yaml"));
      const manifest = yield* decodePnpmModulesManifest(
        yield* Effect.try({
          try: () => parseYaml(text),
          catch: (cause) => new PnpmModulesManifestParseError({ cause }),
        }),
      );
      // An agent can write this manifest, and statting a network path makes
      // Windows sign in to its host with the user's NTLM credentials.
      if (isNetworkPath(manifest.storeDir) || isNetworkPath(manifest.virtualStoreDir ?? "")) {
        return null;
      }
      const virtualStore = path.resolve(nodeModules, manifest.virtualStoreDir ?? ".pnpm");
      const [store, virtual] = yield* Effect.all([
        fs.stat(manifest.storeDir),
        fs.stat(virtualStore),
      ]);
      return store.dev === virtual.dev ? virtualStore : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const measureWorktree = Effect.fn("storageCleanup.measureWorktree")(
    function* (
      worktreePath: string,
      // "plugin": a plugin removes the checkout with no submodule checks of its own, so a
      // registered submodule counts as a nested repository too.
      inspectRepositories: boolean | "plain-folder" | "plugin" = false,
    ) {
      const root = yield* fs.realPath(worktreePath);
      // A plugin checkout mounted of its own is a virtual checkout of the whole repository:
      // walking it reads all of it through the mount. Its plugin's status decides alone, and
      // an orphan's size stays unknown.
      const [own, parent, grandparent] = yield* Effect.all([
        fs.stat(root),
        fs.stat(path.dirname(root)),
        fs.stat(path.dirname(path.dirname(root))),
      ]);
      if (own.dev !== parent.dev) {
        if (inspectRepositories === "plugin" || inspectRepositories === false)
          return { bytes: null, reason: null };
        // Anything else mounted at its root is kept: what it holds is not this folder's.
        return { bytes: null, reason: "worktree could not be fully inspected" };
      }
      // An orphan inside a mount, such as a folder of a checkout listed as a worktree.
      if (inspectRepositories === false && own.dev !== grandparent.dev)
        return { bytes: null, reason: null };
      const skipped = yield* sharedPnpmVirtualStore(root);
      const incomplete = { bytes: null, reason: "worktree could not be fully inspected" };
      // A file system mounted below is not walked: it can be a whole monorepo.
      const rootDevice = (yield* fs.stat(root)).dev;
      // A plain folder is not a checkout, so a repository at its root counts like one below it.
      const repositories = new Set(inspectRepositories === "plain-folder" ? [] : [pathKey(root)]);
      // A VCS plugin's checkout below the root is a repository of its own, as a `.git` is.
      const pluginMarkers = inspectRepositories ? (plugins?.installedMarkers() ?? []) : [];
      const moduleStores: string[] = [];
      if (inspectRepositories === true && (yield* fs.exists(path.join(root, ".gitmodules")))) {
        const submodules = yield* git.execute({
          operation: "StorageCleanup.nestedRepositories",
          cwd: root,
          args: [
            "submodule",
            "foreach",
            "--recursive",
            "--quiet",
            'printf "%s\\0" "$toplevel/$sm_path"',
          ],
          maxOutputBytes: 64 * 1024,
        });
        if (submodules.stdoutTruncated || submodules.stderrTruncated) return incomplete;
        for (const submodule of submodules.stdout.split("\0").filter(Boolean)) {
          repositories.add(pathKey(path.resolve(submodule)));
          repositories.add(pathKey(path.resolve(submodule, ".git")));
          moduleStores.push(pathKey(path.resolve(submodule, ".git", "modules")));
        }
      }
      // Git status omits ignored repositories, and worktree remove deletes them.
      // Registered submodules have their own recursive safety checks.
      const isNestedRepository = (target: string, names: ReadonlyArray<string>) => {
        const key = pathKey(target);
        if (
          repositories.has(key) ||
          moduleStores.some((store) => key === store || inside(store, key))
        )
          return false;
        const markers = new Set(names.map((name) => name.toLowerCase()));
        return (
          markers.has(".git") ||
          (markers.has("head") && markers.has("objects") && markers.has("refs"))
        );
      };
      // A gitfile whose target is missing holds no repository data. An unreadable one counts.
      // Parsed and joined as Git does: only trailing CR/LF is stripped, and `..` is left to the
      // kernel so a symlinked parent resolves the same way.
      const isDanglingGitfile = Effect.fn("storageCleanup.isDanglingGitfile")(
        function* (directory: string, name: string) {
          const gitPath = path.join(directory, name);
          if ((yield* fs.lstat(gitPath)).type !== "File") return false;
          const contents = (yield* fs.readFileString(gitPath)).replace(/[\r\n]+$/u, "");
          if (!contents.startsWith("gitdir: ") || contents.length === 8) return false;
          const gitDir = contents.slice(8);
          // Statting a network path makes Windows sign in to its host with the user's credentials.
          if (isNetworkPath(gitDir)) return false;
          return !(yield* fs.exists(path.isAbsolute(gitDir) ? gitDir : `${directory}/${gitDir}`));
        },
        Effect.orElseSucceed(() => false),
      );
      const pending = [root];
      let entries = 1;
      let bytes = 0;
      while (pending.length > 0) {
        const inspected = yield* Effect.forEach(
          pending.splice(-8),
          // Untraced: this runs once per entry, and a worktree can hold millions.
          Effect.fnUntraced(function* (target) {
            const empty = { target, bytes: 0, names: [], children: [] };
            const inStore = skipped !== null && (target === skipped || inside(skipped, target));
            if (inStore && !inspectRepositories) return empty;
            const stat = yield* fs.lstat(target);
            if (stat.type === "SymbolicLink") return empty;
            if (stat.type === "Directory" && stat.dev !== rootDevice) return null;
            if ((yield* fs.realPath(target)) !== target) return null;
            if (stat.type === "Directory") {
              if (!inStore) {
                const names = yield* fs.readDirectory(target);
                return { target, bytes: 0, names, children: names };
              }
              // The store is excluded from reclaimed bytes; only walk its directories.
              const dirents = yield* Effect.tryPromise({
                try: () => NodeFSP.readdir(target, { withFileTypes: true }),
                catch: (cause) => new WorktreeDirectoryReadError({ cause }),
              });
              return {
                target,
                bytes: 0,
                names: dirents.map((entry) => entry.name),
                children: dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
              };
            }
            // Removing a shared hardlink leaves its blocks allocated.
            if (stat.type !== "File" || Option.getOrElse(stat.nlink, () => 1n) !== 1n) return empty;
            const bytes = Option.match(stat.blocks, {
              onNone: () => Number(stat.size),
              onSome: (blocks) => Number(blocks * 512n),
            });
            return { ...empty, bytes };
          }),
          { concurrency: "unbounded" },
        );
        for (const result of inspected) {
          if (result === null) return incomplete;
          if (inspectRepositories && isNestedRepository(result.target, result.names)) {
            const names = yield* Effect.filter(result.names, (name) =>
              name.toLowerCase() === ".git"
                ? Effect.map(isDanglingGitfile(result.target, name), (dangling) => !dangling)
                : Effect.succeed(true),
            );
            if (isNestedRepository(result.target, names))
              return { bytes: null, reason: "contains a nested Git repository" };
          }
          if (!repositories.has(pathKey(result.target)))
            for (const marker of pluginMarkers) {
              // Without case: a case-insensitive disk finds `.OTHER/HEAD` for `.other/HEAD`.
              const head = marker.split("/")[0]!.toLowerCase();
              if (
                result.names.some((name) => name.toLowerCase() === head) &&
                (yield* fs.exists(path.join(result.target, marker)))
              )
                return { bytes: null, reason: "contains a nested repository" };
            }
          bytes += result.bytes;
          entries += result.names.length;
          if (entries > 2_000_000) return incomplete;
          for (const name of result.children) {
            const child = path.join(result.target, name);
            if (!inside(root, child)) return incomplete;
            pending.push(child);
          }
        }
      }
      return { bytes, reason: null };
    },
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => ({ bytes: null, reason: "worktree could not be fully inspected" })),
  );

  // Large snapshots take seconds; use the reader worker instead of blocking the event loop.
  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const snapshot = yield* projections.getShellSnapshot().pipe(NodeSqliteClient.readOnly);
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...snapshot.threads, ...snapshot.archivedThreads] };
  });

  const projectInWorktree = Effect.fn("StorageCleanup.projectInWorktree")(function* (root: string) {
    const worktreePaths = [
      root,
      yield* nativeRealPath(root).pipe(Effect.orElseSucceed(() => root)),
    ];
    const contains = (projectPath: string) =>
      worktreePaths.some(
        (worktreePath) =>
          pathKey(projectPath) === pathKey(worktreePath) || inside(worktreePath, projectPath),
      );
    return Effect.fnUntraced(function* ({ workspaceRoot }: { readonly workspaceRoot: string }) {
      const projectPath = path.resolve(workspaceRoot);
      if (contains(projectPath)) return true;
      const realPath = yield* nativeRealPathWithMissingTail(workspaceRoot).pipe(
        Effect.orElseSucceed(() => projectPath),
      );
      return contains(realPath);
    });
  });
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    root: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    return Option.isSome(yield* Effect.findFirst(projects, yield* projectInWorktree(root)));
  });

  const reportOrphanWorktrees = Effect.fn("StorageCleanup.reportOrphanWorktrees")(function* (
    managedRoots: ReadonlyArray<string>,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
    entries: StorageCleanupReportEntry[],
    scratchRoot: string | null,
    trigger: StorageCleanupReport["trigger"],
  ) {
    const roots = yield* Effect.forEach(managedRoots, (root) =>
      nativeRealPath(root).pipe(Effect.orElseSucceed(() => root)),
    );
    const rows = yield* sql<{ worktreePath: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(NodeSqliteClient.readOnly);
    const referenced = new Set<string>();
    for (const folder of [
      ...rows.map((row) => row.worktreePath),
      ...Array.from(pendingWorktrees(), ({ root }) => root),
    ]) {
      const resolved = path.resolve(folder);
      referenced.add(pathKey(resolved));
      referenced.add(
        pathKey(
          yield* nativeRealPathWithMissingTail(folder).pipe(Effect.orElseSucceed(() => resolved)),
        ),
      );
    }
    const referencedAncestors = new Set<string>();
    for (let ancestor of referenced) {
      while (roots.some((root) => inside(root, ancestor))) {
        ancestor = pathKey(path.dirname(ancestor));
        referencedAncestors.add(ancestor);
      }
    }
    const projectRoots = (yield* Effect.forEach(
      yield* Effect.filter(projects, (project) =>
        fs.exists(project.workspaceRoot).pipe(Effect.orElseSucceed(() => true)),
      ),
      (project) => {
        const resolved = path.resolve(project.workspaceRoot);
        return nativeRealPath(project.workspaceRoot).pipe(
          Effect.orElseSucceed(() => resolved),
          Effect.map((realPath) => [resolved, realPath]),
        );
      },
    )).flat();
    const inProject = (target: string, managedRoot: string) =>
      projectRoots.some(
        (root) =>
          !inside(root, managedRoot) && (pathKey(root) === pathKey(target) || inside(root, target)),
      );
    // The scratch root is itself a project, so its folders skip the project check.
    const directories = Effect.fnUntraced(function* (parent: string, managedRoot: string | null) {
      const skipped = (target: string) => managedRoot !== null && inProject(target, managedRoot);
      if (skipped(parent)) return [];
      const result: string[] = [];
      for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
        const target = path.join(parent, name);
        if (!inside(parent, target) || skipped(target)) continue;
        const directory = yield* Effect.gen(function* () {
          if (pathKey(yield* fs.realPath(target)) !== pathKey(target)) return false;
          return (yield* fs.stat(target)).type === "Directory";
        }).pipe(Effect.orElseSucceed(() => false));
        if (directory) result.push(target);
      }
      return result;
    });
    const now = yield* Clock.currentTimeMillis;
    const reported = new Map<string, { path: string; reason: string }>();
    const report = Effect.fnUntraced(
      function* (worktreePath: string, scratch = false) {
        const key = pathKey(worktreePath);
        if (
          reported.has(key) ||
          referenced.has(key) ||
          referencedAncestors.has(key) ||
          projectRoots.some((root) => pathKey(root) === key || inside(worktreePath, root))
        )
          return;
        const modified = Option.getOrNull((yield* fs.stat(worktreePath)).mtime);
        if (modified !== null && modified.getTime() > now - ORPHAN_WORKTREE_GRACE_MS) return;
        const gitPath = path.join(worktreePath, ".git");
        const linked =
          ((yield* fs.exists(gitPath)) && (yield* isLinkedWorktree(worktreePath))) ||
          (yield* isPluginWorktree(worktreePath));
        reported.set(key, {
          path: worktreePath,
          reason: linked
            ? "No thread uses this worktree"
            : scratch
              ? "No thread uses this folder"
              : "No thread uses this folder, and it isn't a git worktree",
        });
      },
      Effect.orElseSucceed(() => undefined),
    );
    // Linked worktrees can sit deeper inside a plain folder, like <repository>/replay/<n>. Ask
    // the projects' VCS for them rather than walking folders that may hold large non-git trees.
    let registered: ReadonlyArray<string> | undefined;
    const listRegistered = Effect.fnUntraced(function* () {
      registered ??= (yield* Effect.forEach(new Set(projectRoots), (root) =>
        (gitWorkflowHasPlugins()
          ? gitWorkflow.listWorktrees(root)
          : git.listWorktreePaths(root)
        ).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
      )).flat();
      return registered;
    });
    // A VCS plugin's worktree has no gitfile; its plugin listing it is what makes it one.
    const isPluginWorktree = Effect.fnUntraced(function* (worktree: string) {
      if (!gitWorkflowHasPlugins()) return false;
      return (yield* listRegistered()).some((entry) => pathKey(entry) === pathKey(worktree));
    });
    const nestedWorktrees = Effect.fnUntraced(function* (folder: string, managedRoot: string) {
      if (yield* fs.exists(path.join(folder, ".git"))) return [];
      registered = yield* listRegistered();
      // Locked registrations outlive their directory, whose path may since hold something else.
      return yield* Effect.filter(
        registered.filter(
          (worktree) => inside(folder, worktree) && !inProject(worktree, managedRoot),
        ),
        (worktree) =>
          Effect.gen(function* () {
            if (pathKey(yield* fs.realPath(worktree)) !== pathKey(worktree)) return false;
            return (yield* isLinkedWorktree(worktree)) || (yield* isPluginWorktree(worktree));
          }).pipe(Effect.orElseSucceed(() => false)),
      );
    });
    const pluginCheckout = Effect.fnUntraced(
      function* (folder: string) {
        for (const marker of plugins?.installedMarkers() ?? [])
          if (yield* fs.exists(path.join(folder, marker))) return true;
        return false;
      },
      Effect.orElseSucceed(() => true),
    );
    const mounted = (folder: string, parent: string) =>
      Effect.all([fs.stat(folder), fs.stat(parent)]).pipe(
        Effect.map(([own, above]) => own.dev !== above.dev),
        Effect.orElseSucceed(() => true),
      );
    for (const root of roots) {
      // Worktrees can be <root>/<repository>/<branch> or explicitly <root>/<name>.
      for (const projectDirectory of yield* directories(root, root)) {
        yield* Effect.gen(function* () {
          if (referenced.has(pathKey(projectDirectory))) return;
          // Atelier fork: a plugin's checkout or a mount named <root>/<name> is one folder, never
          // a folder of worktrees to list. In the same folder, a plugin's marker wins over `.git`.
          if (yield* pluginCheckout(projectDirectory)) {
            yield* report(projectDirectory);
            return;
          }
          const gitPath = path.join(projectDirectory, ".git");
          if (yield* fs.exists(gitPath)) {
            if (yield* isLinkedWorktree(projectDirectory)) yield* report(projectDirectory);
            return;
          }
          if (yield* mounted(projectDirectory, root)) {
            yield* report(projectDirectory);
            return;
          }
          for (const worktreePath of yield* directories(projectDirectory, root)) {
            const nested = yield* nestedWorktrees(worktreePath, root);
            for (const target of nested.length > 0 ? nested : [worktreePath]) yield* report(target);
          }
        }).pipe(Effect.orElseSucceed(() => undefined));
      }
    }
    if (scratchRoot !== null) {
      const root = yield* nativeRealPath(scratchRoot).pipe(Effect.orElseSucceed(() => scratchRoot));
      for (const folder of yield* directories(root, null)) yield* report(folder, true);
    }

    // Discovery runs git probes, so the measurement budget starts after it.
    const measurementDeadline = (yield* Clock.currentTimeMillis) + 30_000;
    // Give the first new folder a full walk so every sweep can make progress.
    let firstMeasurement = true;
    const refresh = trigger === "manual" ? [...orphanSizes] : [];
    for (const [key, { path }] of reported) {
      if (orphanSizes.has(key)) continue;
      const remaining = measurementDeadline - (yield* Clock.currentTimeMillis);
      if (!firstMeasurement && remaining <= 0) break;
      const measured = yield* measureWorktree(path).pipe(
        firstMeasurement ? Effect.asSome : Effect.timeoutOption(remaining),
      );
      firstMeasurement = false;
      if (Option.isSome(measured)) orphanSizes.set(key, measured.value.bytes);
    }
    for (const [key, bytes] of refresh) {
      const orphan = reported.get(key);
      if (orphan === undefined || bytes === null) continue;
      const remaining = measurementDeadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) break;
      const measured = yield* measureWorktree(orphan.path).pipe(Effect.timeoutOption(remaining));
      // A slow or failed refresh moves to the end too, so it cannot starve the next orphan.
      orphanSizes.delete(key);
      orphanSizes.set(key, Option.getOrUndefined(measured)?.bytes ?? bytes);
    }
    for (const [key, orphan] of reported) {
      entries.push({
        ...orphan,
        kind: "worktree",
        outcome: "kept",
        projectPath: null,
        threadId: null,
        threadTitle: null,
        bytes: orphanSizes.get(key) ?? null,
        files: null,
      });
    }
    for (const key of orphanSizes.keys()) {
      if (!reported.has(key)) orphanSizes.delete(key);
    }
  });

  // Use two small Git reads: statusDetailsLocal also diffs and counts for every worktree.
  const branchChanged = Effect.fn("StorageCleanup.branchChanged")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    // Return null for missing/non-repository cwd; force untranslated git diagnostics for matching.
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (isNonRepositoryGitStderr(result.stderr)) return null;
      return yield* failure(
        result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      );
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    // Detached HEAD exits 1; full refs avoid shortening when a tag shares the branch name.
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    // Removal keeps branches but drops a detached HEAD, so only commits held elsewhere are safe.
    if (head.exitCode !== 0) {
      // A paused rebase, merge or bisect would lose its progress (and any autostash) on removal.
      const operations = yield* read([
        "rev-parse",
        "--git-path",
        "rebase-merge",
        "--git-path",
        "rebase-apply",
        "--git-path",
        "MERGE_HEAD",
        "--git-path",
        "MERGE_AUTOSTASH",
        "--git-path",
        "BISECT_LOG",
      ]);
      if (operations === null) return true;
      for (const state of operations.stdout.trim().split(/\r?\n/)) {
        if (yield* fs.exists(path.resolve(cwd, state))) return true;
      }
      const unreachable = yield* read([
        "rev-list",
        "--max-count=1",
        "HEAD",
        "--not",
        "--branches",
        "--remotes",
      ]);
      return unreachable === null || unreachable.stdout.trim() !== "";
    }
    const ref = head.stdout.trim();
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    return name !== branch;
  });

  // Nothing watches an idle worktree, so its threads still record the branch it left.
  // Record the checked-out one so the next sweep can apply the rules to it.
  const followBranch = Effect.fn("StorageCleanup.followBranch")(
    function* (worktreePath: string) {
      const cwd = yield* fs.realPath(worktreePath);
      yield* reconcileBranch({ cwd, refName: yield* gitWorkflow.currentBranch(cwd) });
    },
    (effect, worktreePath) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to reconcile worktree branch", { cwd: worktreePath, cause }),
        ),
      ),
  );

  // A worktree can outlive its project moving to another clone. Git removes a
  // worktree through the repository that registered it, not through the
  // project's current checkout, so resolve the owning repository first.
  const worktreeRepository = Effect.fn("StorageCleanup.worktreeRepository")(function* (
    worktreePath: string,
  ) {
    const commonDir = yield* git.execute({
      operation: "StorageCleanup.worktreeRepository",
      cwd: worktreePath,
      args: ["rev-parse", "--git-common-dir"],
    });
    const resolved = path.resolve(worktreePath, commonDir.stdout.trim());
    return path.basename(resolved) === ".git" ? path.dirname(resolved) : resolved;
  });

  const { localChangesReason, submoduleRemoval } = worktreeRemovalChecks(git.execute, fs, path);

  const cleanupGit = Effect.fn("StorageCleanup.cleanupGit")(function* (
    cwd: string,
    args: string[],
    command: string,
  ) {
    const result = yield* git.execute({
      operation: "StorageCleanup.cleanupGit",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0)
      return yield* new GitCommandError({
        operation: "StorageCleanup.cleanupGit",
        command,
        cwd,
        detail: result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      });
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: StorageCleanupReportEntry[],
    trigger: StorageCleanupReport["trigger"],
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled))
      return { waiting: false, kept: [] };
    let waiting = false;
    const kept: string[] = [];
    const roots: Array<string> = [];
    // A git worktree's dev home is seeded from real data, so its threads and any
    // copied settings can point at the developer's real worktrees.
    const isWorktreeDevHome =
      (yield* resolveWorktreeT3Home(config.baseDir)) === path.resolve(config.baseDir);
    const homeWorktreesDir = path.join(config.baseDir, "worktrees");
    for (const directory of isWorktreeDevHome
      ? [...new Set([config.worktreesDir, homeWorktreesDir])]
      : managedWorktreesDirectories(
          serverSettings,
          config.worktreesDir,
          path,
          yield* HostProcess.HomeDirectory,
          homeWorktreesDir,
        )) {
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    const scratchRoot = yield* fs
      .realPath(scratchFolderRoot(config.baseDir, path))
      .pipe(Effect.orElseSucceed(() => null));
    // Nothing can bring a scratch folder's files back, so these hold whatever the retention says.
    const scratchKeepReason = Effect.fn("StorageCleanup.scratchKeepReason")(function* (
      folder: string,
      threadIds: ReadonlyArray<string>,
      rules: WorktreeCleanupRules,
    ) {
      const realParent = yield* fs.realPath(path.dirname(folder));
      if ((yield* fs.realPath(folder)) !== path.join(realParent, path.basename(folder)))
        return "folder is a symbolic link";
      // Every file here is untracked, and only "tracked-changes" lets cleanup delete those.
      if (rules.worktreeKeepWhen !== "tracked-changes") {
        const file = (yield* fs.readDirectory(folder)).find((name) => name !== "node_modules");
        if (file !== undefined) return `has local files (${file})`;
      }
      // Each run of a scheduled task works on what its earlier runs left in the folder.
      const scheduled = yield* sql<{ threadId: string }>`
        SELECT thread_id AS "threadId" FROM scheduled_tasks
        WHERE enabled = 1 AND thread_id IS NOT NULL
      `.pipe(NodeSqliteClient.readOnly);
      if (scheduled.some((task) => threadIds.includes(task.threadId)))
        return "thread has a scheduled task";
      return null;
    });
    const worktreePathReason = Effect.fn("StorageCleanup.worktreePathReason")(function* (
      worktreePath: string,
      // A VCS plugin's checkout has no gitfile; its plugin listing it stands in for one.
      requireGitLink = true,
    ) {
      // Allow symlinked parents, never a symlinked worktree directory.
      const realPath = yield* fs.realPath(worktreePath);
      const realParent = yield* fs.realPath(path.dirname(worktreePath));
      if (realPath !== path.join(realParent, path.basename(worktreePath)))
        return "worktree is a symbolic link";
      if (!roots.some((root) => inside(root, realPath)))
        return "outside the managed worktree folder";
      if (!requireGitLink) return null;
      const linked = yield* isLinkedWorktree(worktreePath).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      );
      if (!linked) return "not a linked worktree";
      return null;
    });
    // The checks a single worktree passes before removal, for one checkout of a task folder.
    const inspectCheckout = Effect.fn("StorageCleanup.inspectCheckout")(
      function* (
        checkout: { readonly worktreePath: string; readonly repositoryPath: string },
        branch: string | null,
        rules: WorktreeCleanupRules,
        settingsChanged: Effect.Effect<boolean, ServerSettingsError>,
        deleted: boolean,
      ) {
        const checkoutPath = checkout.worktreePath;
        // A VCS plugin's checkout passes the checks its own sweep does, and the plugin removes it.
        const pluginKind = yield* pluginWorktreeKind(checkoutPath, checkout.repositoryPath);
        if (pluginKind === UNVERIFIED_PLUGIN)
          return {
            keep: "its VCS plugin is off, did not answer, or does not list it",
            force: false,
            bytes: null,
          };
        if (pluginKind !== null) {
          const state = yield* pluginWorktreeState(checkoutPath, branch, rules);
          const recoverable =
            deleted ||
            (state.recreates &&
              branch !== null &&
              (yield* gitWorkflow.listLocalBranchNames(checkout.repositoryPath)).includes(branch));
          const pluginReason =
            (yield* worktreePathReason(checkoutPath, false)) ??
            (state.kind !== pluginKind || state.branchChanged
              ? "repository or branch changed"
              : null) ??
            (recoverable
              ? null
              : `${state.label} could not recreate it for the thread's next turn`) ??
            (!deleted && (yield* holdsNativeCheckpoints(checkoutPath))
              ? NATIVE_CHECKPOINTS_REASON
              : null) ??
            state.changes;
          if (pluginReason !== null) return { keep: pluginReason, force: false, bytes: null };
          const inspection = yield* measureWorktree(checkoutPath, "plugin");
          if (inspection.reason !== null)
            return { keep: inspection.reason, force: false, bytes: inspection.bytes };
          if (yield* settingsChanged)
            return { keep: "settings changed since check", force: false, bytes: inspection.bytes };
          // Measuring takes time: work saved meanwhile keeps the checkout, as in the sweep.
          const last = yield* pluginWorktreeState(checkoutPath, branch, rules);
          const lastReason =
            last.kind !== pluginKind || last.branchChanged
              ? "repository or branch changed since check"
              : last.changes;
          if (lastReason !== null)
            return { keep: lastReason, force: false, bytes: inspection.bytes };
          // Checked as the sweep checks it, so the plugin is not asked to keep untracked files.
          return { keep: null, force: true, bytes: inspection.bytes };
        }
        const reason =
          (yield* worktreePathReason(checkoutPath)) ??
          ((yield* branchChanged(checkoutPath, branch)) ? "repository or branch changed" : null) ??
          (yield* localChangesReason(checkoutPath, rules));
        if (reason !== null) return { keep: reason, force: false, bytes: null };
        const { bytes, reason: measureReason } = yield* measureWorktree(checkoutPath, true);
        if (measureReason !== null) return { keep: measureReason, force: false, bytes };
        // Measuring takes time, and what follows deletes ignored files under these rules.
        if (yield* settingsChanged)
          return { keep: "settings changed since check", force: false, bytes };
        // Before anything is deleted: a submodule may be the reason this checkout stays whole.
        const submodules = yield* submoduleRemoval(checkoutPath, rules);
        if (submodules.reason !== null)
          return { keep: submodules.reason, force: submodules.force, bytes };
        if (rules.worktreeKeepWhen === "tracked-changes" && !submodules.force)
          yield* cleanupGit(checkoutPath, ["clean", "-ffdx"], "git clean");
        return {
          keep:
            submodules.reason ??
            (submodules.force ? yield* localChangesReason(checkoutPath, rules) : null),
          force: submodules.force,
          bytes,
        };
      },
      Effect.catch((error) =>
        Effect.succeed({ keep: cleanupFailureReason(error), force: false, bytes: null }),
      ),
    );
    const deletedRows = yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `.pipe(NodeSqliteClient.readOnly);
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter((thread) => thread.worktreePath !== null && thread.branch !== null);
    const snapshot = yield* readThreads();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    // Failures are cached too, so one broken repository costs one fetch per sweep.
    const refreshedDefaultRefs = new Map<string, Map<string, Exit.Exit<void, GitCommandError>>>();
    const defaultBranches = new Map<string, string | null>();
    const { canonical, occupies } = worktreePathsForCheck();
    const hasTerminal = Effect.fnUntraced(function* (worktreePaths: ReadonlyArray<string>) {
      for (const terminal of [...liveTerminals.values()].flatMap((entries) => [
        ...entries.values(),
      ])) {
        if (terminal.status !== "starting" && terminal.status !== "running") continue;
        if (
          (terminal.worktreePath !== null &&
            (yield* occupies(worktreePaths, terminal.worktreePath))) ||
          (yield* occupies(worktreePaths, terminal.cwd))
        )
          return true;
      }
      return false;
    });
    const liveThreads = snapshot.threads.filter((thread) => thread.worktreePath !== null);
    const projectRoots = new Map(
      snapshot.projects.map((project) => [project.id, project.workspaceRoot]),
    );
    const rootsByThread = new Map<ThreadId, string>();
    for (const thread of [...liveThreads, ...deletedThreads]) {
      const folder = path.resolve(thread.worktreePath!);
      const projectRoot =
        "workspaceRoot" in thread ? thread.workspaceRoot : projectRoots.get(thread.projectId);
      const root =
        projectRoot && thread.branch !== null
          ? yield* worktreeRootForProject(
              fs,
              path,
              folder,
              projectRoot,
              undefined,
              plugins?.markers(),
            )
          : folder;
      rootsByThread.set(thread.id, root);
    }
    const liveKeys = yield* Effect.forEach(liveThreads, (thread) =>
      canonical(rootsByThread.get(thread.id)!),
    );
    const groups = Map.groupBy(liveThreads, (_thread, index) => liveKeys[index]!);
    const deletedKeys = yield* Effect.forEach(deletedThreads, (thread) =>
      canonical(rootsByThread.get(thread.id)!),
    );
    const deletedByPath = Map.groupBy(deletedThreads, (_thread, index) => deletedKeys[index]!);
    const candidates = [
      ...[...groups].map(
        ([worktreeKey, group]) =>
          // A deleted thread still owns the worktree its remaining subagents share,
          // but only deletion cleanup acts on it; otherwise the live rules apply.
          deletedByPath
            .get(worktreeKey)
            ?.find(
              (deleted) =>
                resolveWorktreeCleanup(serverSettings, deleted.projectId).worktreeOnDelete &&
                worktreeOwner([deleted, ...group]) === deleted,
            ) ??
          worktreeOwner(group) ??
          group[0]!,
      ),
      ...deletedThreads.filter((_thread, index) => !groups.has(deletedKeys[index]!)),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = rootsByThread.get(thread.id)!;
      const worktreeKey = yield* canonical(worktreePath);
      const worktreePaths = [worktreePath, worktreeKey];
      const group = groups.get(worktreeKey) ?? [];
      // No project threads have no branch; their folders sit directly in the scratch root.
      const scratch =
        thread.branch === null &&
        scratchRoot !== null &&
        pathKey(path.dirname(worktreeKey)) === pathKey(scratchRoot);
      const activityAt = Math.max(...group.map(storageCleanupActivityAt));
      const deleted = "workspaceRoot" in thread;
      const settlementChain = deleted
        ? []
        : worktreeSettlementChain(thread, threadsById, now, serverSettings);
      const settledThread = settlementChain.at(-1);
      const members = deleted ? [thread, ...group] : group;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        outcome: "kept",
        reason: "",
        path: worktreePath,
        projectPath: project?.workspaceRoot ?? null,
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      const keep = (reason: string) => {
        if (deleted && settings.worktreeOnDelete) kept.push(worktreePath);
        entries.push({ ...entry, reason: sentence(reason) });
      };
      // Reasons a provider session stop or finished deletion work can clear.
      const waitForStop = (reason: string) => {
        if (deleted && settings.worktreeOnDelete) waiting = true;
        return reason;
      };
      yield* Effect.gen(function* () {
        const taskFolder = yield* taskFolders.find(thread.worktreePath!);
        // Terminals, sessions and project folders anywhere in a task folder protect all of it.
        const guardedPath = taskFolder?.root ?? worktreePath;
        const guardedPaths =
          taskFolder === null ? worktreePaths : [guardedPath, yield* canonical(guardedPath)];
        const exists = yield* fs.exists(guardedPath).pipe(
          // A stored path under a regular file cannot exist, but access() fails with ENOTDIR.
          Effect.catchIf(
            (error) =>
              error.cause instanceof Error &&
              "code" in error.cause &&
              error.cause.code === "ENOTDIR",
            () => Effect.succeed(false),
          ),
        );
        if (!exists) return;
        if (deleted && !settings.worktreeOnDelete) return keep("no rules apply");
        if (members.length > 1 && worktreeOwner(members) === undefined)
          return keep(`shared by ${members.length} threads`);
        if (project === undefined) return keep("project is unavailable");
        if (!group.every((member) => storageCleanupThreadIdle(member, now, serverSettings)))
          return keep(waitForStop("thread is running or has pending work"));
        if (thread.branch === null && !scratch) return keep("thread has no branch");
        if (group.some((member) => member.branch !== thread.branch))
          return keep("a subagent thread's branch differs from this worktree's branch");
        if (yield* hasTerminal(guardedPaths)) return keep(waitForStop("open terminal"));
        if (
          [...group, ...settlementChain.slice(1)].some(
            (member) =>
              member.settledAt !== null &&
              now - Math.max(DateTime.toEpochMillis(member.updatedAt), activityAt) <
                SETTLE_SCRIPT_GRACE_MS,
          )
        )
          return keep(waitForStop("settled moments ago"));
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          activityAt < now - settings.worktreeAfterDays * DAY_MS;
        const settledFor =
          settledThread?.settledAt == null
            ? null
            : now - Math.max(DateTime.toEpochMillis(settledThread.settledAt), activityAt);
        const settledDays = settledFor === null ? null : Math.floor(settledFor / DAY_MS);
        const settled =
          settledFor !== null &&
          settings.worktreeSettledAfterDays !== null &&
          settledFor >= settings.worktreeSettledAfterDays * DAY_MS;
        // A worktree is unchanged before its first commit, so only finished threads qualify.
        const unchangedApplies =
          settings.worktreeUnchanged && (settledThread !== undefined || thread.archivedAt !== null);
        let eligible = deleted || old || settled;
        let removalReason = deleted
          ? "thread was deleted"
          : old
            ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} days`
            : `settled for ${settledDays} days`;
        const notDueReason =
          !deleted && settings.worktreeAfterDays !== null
            ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} of ${settings.worktreeAfterDays} days`
            : settings.worktreeSettledAfterDays !== null
              ? settledFor === null
                ? "not settled"
                : `settled for ${settledDays} of ${settings.worktreeSettledAfterDays} days`
              : settings.worktreeOnMerge
                ? "not merged"
                : unchangedApplies
                  ? "has commits beyond the default branch"
                  : settings.worktreeUnchanged
                    ? "not settled"
                    : "no rules apply";
        // The merge and unchanged rules read Git, which a scratch folder does not have.
        if (scratch && !eligible)
          return keep(
            settings.worktreeAfterDays !== null || settings.worktreeSettledAfterDays !== null
              ? notDueReason
              : "no rules apply",
          );
        // Only Git-based rules can make a not-yet-due worktree eligible, so skip Git otherwise.
        if (!eligible && !unchangedApplies && !settings.worktreeOnMerge) return keep(notDueReason);
        // Re-read this path's threads and sessions so new activity cancels removal; full per-worktree snapshots take seconds.
        const blockedSinceCheck = Effect.fnUntraced(function* () {
          for (const pending of pendingWorktrees())
            if (yield* occupies(guardedPaths, pending.root))
              return "a thread is preparing this worktree";
          const latestProjects = yield* projectStore.listShells();
          if (yield* containsProjectRoot(guardedPath, [project, ...latestProjects]))
            return "contains a project checkout";
          const bindings = yield* projections.getThreadWorktreePaths({ includeArchived: true });
          const latest = yield* Effect.filter(bindings, (binding) =>
            occupies(guardedPaths, binding.worktreePath),
          );
          if (yield* hasTerminal(guardedPaths)) return waitForStop("open terminal");
          if (deleted) {
            if (
              !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                .worktreeOnDelete
            )
              return "thread or cleanup settings changed since check";
            // Durable deletion cleanup must succeed or be explicitly cancelled before removing its checkout.
            const pendingCleanup = yield* sql<{ status: string }>`
              SELECT status FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled')
            `.pipe(NodeSqliteClient.readOnly);
            // Failed effects never retry, so only running work can finish and free the path.
            if (pendingCleanup.some((row) => row.status !== "failed"))
              return waitForStop("thread deletion is still pending");
            if (pendingCleanup.length > 0) return "thread deletion is still pending";
          }
          const latestShells = yield* Effect.forEach(latest, (entry) =>
            projections.getThreadShell(entry.threadId),
          );
          const latestGroup = latestShells.filter((shell) => shell !== null);
          const latestOwner = worktreeOwner(deleted ? [thread, ...latestGroup] : latestGroup);
          if (
            latestGroup.length !== group.length ||
            latestOwner?.id !== thread.id ||
            latestOwner?.branch !== thread.branch ||
            latestGroup.some((shell) => {
              const previous = group.find((member) => member.id === shell.id);
              return (
                previous === undefined ||
                shell.branch !== thread.branch ||
                !Equal.equals(shell.settledAt, previous.settledAt) ||
                (shell.settledAt !== null && !Equal.equals(shell.updatedAt, previous.updatedAt)) ||
                !storageCleanupThreadIdle(shell, now, serverSettings) ||
                shell.worktreePath !== previous.worktreePath ||
                storageCleanupActivityAt(shell) !== storageCleanupActivityAt(previous)
              );
            })
          )
            return waitForStop("thread activity or shared worktree changed since check");
          if (settlementChain.length > 1) {
            const ancestors = yield* Effect.forEach(settlementChain.slice(1), (ancestor) =>
              projections.getThreadShell(ancestor.id),
            );
            const latestSettlement = worktreeSettlementChain(
              latestGroup.find((shell) => shell.id === thread.id)!,
              new Map(
                [...latestGroup, ...ancestors.filter((ancestor) => ancestor !== null)].map(
                  (ancestor) => [ancestor.id, ancestor],
                ),
              ),
              now,
              serverSettings,
            ).at(-1);
            if (
              latestSettlement?.id !== settledThread?.id ||
              !Equal.equals(latestSettlement?.settledAt, settledThread?.settledAt) ||
              !Equal.equals(latestSettlement?.updatedAt, settledThread?.updatedAt)
            )
              return "parent settlement changed since check";
          }
          // Sessions can outlive their run and can be shared across app threads.
          const sessionRows = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_provider_sessions
            WHERE status != 'stopped'
          `.pipe(NodeSqliteClient.readOnly);
          const sessions = yield* Effect.forEach(sessionRows, (row) =>
            decodeCleanupSession(row.payload_json),
          );
          // Ready persisted sessions may have released their runtime; only live sessions protect the path.
          for (const session of sessions) {
            if (
              (yield* occupies(guardedPaths, session.cwd)) &&
              (yield* providerSessions.isLive(session.id))
            )
              return waitForStop("provider session is still open");
          }
          return null;
        });
        const settingsChangedSinceCheck = Effect.gen(function* () {
          const currentSettings = yield* settingsService.getSettings;
          const current = resolveWorktreeCleanup(currentSettings, thread.projectId);
          return (
            currentSettings.autoResumeLimitedThreads !== serverSettings.autoResumeLimitedThreads ||
            currentSettings.snoozeLimitedThreads !== serverSettings.snoozeLimitedThreads ||
            Object.keys(settings).some(
              (key) =>
                current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
            )
          );
        });
        if (scratch) {
          const threadIds = group.map((member) => member.id);
          const blocked =
            (yield* scratchKeepReason(worktreePath, threadIds, settings)) ??
            (yield* blockedSinceCheck());
          if (blocked !== null) return keep(blocked);
          const inspection = yield* measureWorktree(worktreePath, "plain-folder");
          if (inspection.reason !== null) return keep(inspection.reason);
          return yield* withCleanupLease(
            worktreePath,
            Effect.gen(function* () {
              // Walked again under the lease: a repository deleted with the folder is gone for good.
              const finalInspection = yield* measureWorktree(worktreePath, "plain-folder");
              if (finalInspection.reason !== null) return keep(finalInspection.reason);
              // The walk takes time, so the cheap checks run last, right before removal.
              const blockedWhileMeasuring =
                (yield* scratchKeepReason(worktreePath, threadIds, settings)) ??
                (yield* blockedSinceCheck());
              if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring);
              if (yield* settingsChangedSinceCheck) return keep("settings changed since check");
              yield* fs.remove(worktreePath, { recursive: true });
              entries.push({
                ...entry,
                outcome: "removed",
                reason: sentence(removalReason),
                bytes: inspection.bytes,
              });
              // The stored path stays so the next turn recreates the folder, empty.
              yield* Effect.logInfo("storage cleanup removed scratch folder", {
                threadId: thread.id,
              });
            }),
          );
        }
        if (taskFolder !== null) {
          // Merged and unchanged compare one branch with one default branch; a task folder has
          // a repository per folder, so only age, settling and deletion remove it.
          if (!eligible) return keep(notDueReason);
          const blockedTaskFolder = yield* blockedSinceCheck();
          if (blockedTaskFolder !== null) return keep(blockedTaskFolder);
          return yield* withCleanupLease(
            worktreePath,
            Effect.gen(function* () {
              const blockedSinceLease = yield* blockedSinceCheck();
              if (blockedSinceLease !== null) return keep(blockedSinceLease);
              if (yield* settingsChangedSinceCheck) return keep("settings changed since check");
              const checkoutBytes = new Map<string, number | null>();
              // Each checkout passes the checks a single worktree does, or it stays.
              const result = yield* taskFolders.remove({
                root: taskFolder.root,
                force: false,
                // A live thread sharing the folder, such as a subagent, still needs its layout.
                forget: deleted && group.length === 0,
                inspect: (checkout) =>
                  inspectCheckout(
                    checkout,
                    thread.branch,
                    settings,
                    settingsChangedSinceCheck,
                    // Only when no live thread shares the folder, such as a deleted one's subagent.
                    deleted && group.length === 0,
                  ).pipe(
                    Effect.tap(({ bytes }) =>
                      Effect.sync(() => checkoutBytes.set(checkout.worktreePath, bytes)),
                    ),
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.provideService(Path.Path, path),
                  ),
              });
              for (const removedPath of result.removed)
                entries.push({
                  ...entry,
                  path: removedPath,
                  outcome: "removed",
                  reason: sentence(removalReason),
                  bytes: checkoutBytes.get(removedPath) ?? null,
                });
              for (const keptCheckout of result.kept)
                entries.push({
                  ...entry,
                  path: keptCheckout.path,
                  reason: sentence(keptCheckout.reason),
                });
              if (result.kept.length > 0 && deleted && settings.worktreeOnDelete)
                kept.push(worktreePath);
              yield* gitManager.invalidateStatus(project.workspaceRoot);
              yield* Effect.logInfo("storage cleanup removed task folder", {
                threadId: thread.id,
                removed: result.removed.length,
                kept: result.kept.length,
              });
            }),
            guardedPath,
          );
        }
        // Atelier fork: a VCS plugin's worktree goes through the plugin. Only age, settling and
        // deletion apply; the merge and unchanged rules read Git history a plugin does not expose.
        const pluginKind = yield* pluginWorktreeKind(worktreePath, project.workspaceRoot);
        if (pluginKind === UNVERIFIED_PLUGIN)
          return keep("its VCS plugin is off, did not answer, or does not list it");
        if (pluginKind !== null) {
          if (!eligible) return keep(notDueReason);
          const pluginPathReason = yield* worktreePathReason(worktreePath, false);
          if (pluginPathReason !== null) return keep(pluginPathReason);
          const first = yield* pluginWorktreeState(worktreePath, thread.branch, settings);
          // The folder answers for another VCS than the project's plugin.
          if (first.kind !== pluginKind) return keep("repository or branch changed");
          if (first.branchChanged) {
            if (!deleted) yield* followBranch(thread.worktreePath!);
            return keep("repository or branch changed");
          }
          // A live thread's next turn brings its checkout back: the plugin checks the branch out
          // again, so the repository must still list it once the worktree is gone.
          // A live thread sharing a deleted one's checkout, such as its subagent, still needs it.
          const forgotten = deleted && group.length === 0;
          const unrecoverable = Effect.fnUntraced(function* (recreates: boolean) {
            if (forgotten) return false;
            const branch = thread.branch;
            if (!recreates || branch === null) return true;
            const names = yield* gitWorkflow.listLocalBranchNames(project.workspaceRoot);
            return !names.includes(branch);
          });
          const cannotRecreate = `${first.label} could not recreate it for the thread's next turn`;
          if (yield* unrecoverable(first.recreates)) return keep(cannotRecreate);
          if (!forgotten && (yield* holdsNativeCheckpoints(worktreePath)))
            return keep(NATIVE_CHECKPOINTS_REASON);
          if (first.changes !== null) return keep(first.changes);
          const blocked = yield* blockedSinceCheck();
          if (blocked !== null) return keep(blocked);
          // As for Git: a repository nested inside, with work of its own, keeps the folder.
          const inspection = yield* measureWorktree(worktreePath, "plugin");
          if (inspection.reason !== null) return keep(inspection.reason);
          return yield* withCleanupLease(
            worktreePath,
            Effect.gen(function* () {
              const blockedWhileMeasuring = yield* blockedSinceCheck();
              if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring);
              const lastPathReason = yield* worktreePathReason(worktreePath, false);
              if (lastPathReason !== null) return keep(lastPathReason);
              const last = yield* pluginWorktreeState(worktreePath, thread.branch, settings);
              if (
                last.kind !== pluginKind ||
                (yield* pluginWorktreeKind(worktreePath, project.workspaceRoot)) !== pluginKind ||
                last.branchChanged
              )
                return keep("repository or branch changed since check");
              if (yield* unrecoverable(last.recreates)) return keep(cannotRecreate);
              if (last.changes !== null) return keep(last.changes);
              if (yield* settingsChangedSinceCheck) return keep("settings changed since check");
              yield* gitWorkflow.removeWorktree({
                cwd: project.workspaceRoot,
                path: worktreePath,
                force: true,
              });
              entries.push({
                ...entry,
                outcome: "removed",
                reason: sentence(removalReason),
                bytes: inspection.bytes,
              });
              yield* gitManager.invalidateStatus(project.workspaceRoot);
              // The stored branch and path let the next turn bring the checkout back.
              yield* Effect.logInfo("storage cleanup removed VCS plugin worktree", {
                threadId: thread.id,
              });
            }),
          );
        }
        const pathReason = yield* worktreePathReason(worktreePath);
        if (pathReason !== null) return keep(pathReason);
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects]))
          return keep("contains a project checkout");
        if (yield* branchChanged(worktreePath, thread.branch)) {
          // A deleted owner cannot follow, so its remaining subagents stay on its branch.
          if (!deleted) yield* followBranch(thread.worktreePath!);
          return keep("repository or branch changed");
        }
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        if (!eligible) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remotes = yield* git.execute({
            operation: "StorageCleanup.listRemotes",
            cwd: repositoryCwd,
            args: ["remote"],
          });
          const remote =
            remotes.stdout.trim() === ""
              ? null
              : yield* git.resolvePrimaryRemoteName(repositoryCwd);
          let branch: string | null | undefined;
          let defaultRef: string;
          if (remote === null) {
            if (!unchangedApplies)
              return keep(
                settings.worktreeUnchanged
                  ? notDueReason
                  : "no remote is configured for merged-worktree cleanup",
              );
            const projectHead = yield* git.execute({
              operation: "StorageCleanup.resolveProjectBranch",
              cwd: repositoryCwd,
              args: ["symbolic-ref", "--quiet", "HEAD"],
              allowNonZeroExit: true,
            });
            if (projectHead.exitCode !== 0) return keep("project branch is unavailable");
            defaultRef = projectHead.stdout.trim();
            branch = defaultRef.slice("refs/heads/".length);
          } else {
            const defaultBranchKey = `${repositoryCwd}\0${remote}`;
            branch = defaultBranches.get(defaultBranchKey);
            if (branch === undefined) {
              branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
              // Without a local HEAD ref, only the remote can identify its default;
              // a conventional name may be a feature branch.
              if (branch === null) {
                branch = yield* git
                  .execute({
                    operation: "StorageCleanup.resolveDefaultBranch",
                    cwd: repositoryCwd,
                    args: ["ls-remote", "--symref", "--", remote, "HEAD"],
                    timeoutMs: 20_000,
                  })
                  .pipe(
                    Effect.map(
                      (result) =>
                        /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(result.stdout)?.[1] ?? null,
                    ),
                    Effect.orElseSucceed(() => null),
                  );
              }
              defaultBranches.set(defaultBranchKey, branch);
            }
            if (branch === null) return keep("default branch is unavailable");
            defaultRef = `refs/remotes/${remote}/${branch}`;
            const refreshed =
              refreshedDefaultRefs.get(repositoryCwd) ??
              new Map<string, Exit.Exit<void, GitCommandError>>();
            let refresh = refreshed.get(defaultRef);
            if (refresh === undefined) {
              refresh = yield* Effect.exit(
                git.fetchRemoteTrackingBranch({
                  cwd: repositoryCwd,
                  remoteName: remote,
                  remoteBranch: branch,
                }),
              );
              refreshed.set(defaultRef, refresh);
              refreshedDefaultRefs.set(repositoryCwd, refreshed);
            }
            yield* refresh;
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          const integrated = ancestor.exitCode === 0;
          eligible = integrated && unchangedApplies;
          if (eligible)
            removalReason =
              remote === null
                ? "no commits beyond the project branch"
                : "no commits beyond the default branch";
          if (!eligible && remote !== null && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: true, includeHeadRepository: true },
            );
            eligible = storageCleanupPullRequestMerged(pullRequest, {
              branch: thread.branch,
              defaultBranch: branch,
              headSha: head.commitSha,
              integrated,
            });
            if (eligible) removalReason = "pull request was merged";
          }
          if (!eligible && remote === null)
            return keep(integrated ? notDueReason : "has commits beyond the project branch");
        }
        if (!eligible) return keep(notDueReason);
        // A full status walks the whole checkout, so only a removable worktree pays for it.
        const changes = yield* localChangesReason(worktreePath, settings);
        if (changes !== null) return keep(changes);
        const blocked = yield* blockedSinceCheck();
        if (blocked !== null) return keep(blocked);
        // Inspect before the lease; provider startup must not wait for directory traversal.
        const inspection = yield* measureWorktree(worktreePath, true);
        if (inspection.reason !== null) return keep(inspection.reason);
        const bytes = inspection.bytes;
        yield* withCleanupLease(
          worktreePath,
          Effect.gen(function* () {
            const pathReason = yield* worktreePathReason(worktreePath);
            if (pathReason !== null) return keep(pathReason);
            const blockedWhileMeasuring = yield* blockedSinceCheck();
            if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring);
            if (yield* branchChanged(worktreePath, thread.branch))
              return keep("repository or branch changed since check");
            if (
              (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
              head.commitSha
            )
              return keep("commit changed since check");
            const finalChanges = yield* localChangesReason(worktreePath, settings);
            if (finalChanges !== null) return keep(finalChanges);
            if (yield* settingsChangedSinceCheck) return keep("settings changed since check");
            const submodules = yield* submoduleRemoval(worktreePath, settings);
            if (submodules.reason !== null) return keep(submodules.reason);
            if (submodules.force) {
              const changes = yield* localChangesReason(worktreePath, settings);
              if (changes !== null) return keep(changes);
            }
            const repository = yield* worktreeRepository(worktreePath);
            // Forced removal already discards local files; do not widen its final-check window.
            if (settings.worktreeKeepWhen === "tracked-changes" && !submodules.force)
              yield* cleanupGit(worktreePath, ["clean", "-ffdx"], "git clean");
            yield* removeLinkedWorktree({
              operation: "StorageCleanup.cleanupGit",
              cwd: repository,
              worktreePath,
              // Git requires force for submodules; recursive checks above cannot make removal atomic.
              force: submodules.force,
              execute: git.execute,
              run: (args) => cleanupGit(repository, [...args], "git worktree remove"),
            });
            entries.push({ ...entry, outcome: "removed", reason: sentence(removalReason), bytes });
            yield* gitManager.invalidateStatus(project.workspaceRoot);
            // Preserve branch/path so ProviderTurnStartService can recreate the checkout on resume.
            yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
          }),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              ...entry,
              outcome: "failed",
              reason: cleanupFailureReason(error),
            });
            if (deleted && settings.worktreeOnDelete) kept.push(worktreePath);
            yield* Effect.logWarning("storage cleanup failed for worktree", {
              threadId: thread.id,
              error,
            });
          }),
        ),
      );
    }
    yield* reportOrphanWorktrees(
      roots,
      yield* projectStore.list({ includeDeleted: true }),
      entries,
      scratchRoot,
      trigger,
    );
    return { waiting, kept };
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
    removed: { files: number; bytes: number },
  ) {
    if (days === null || !(yield* fs.exists(root))) return removed;
    // A symlinked parent (a linked T3 home) is fine; a symlinked folder is not.
    const realRoot = yield* fs.realPath(root);
    const realParent = yield* fs.realPath(path.dirname(root));
    if (realRoot !== path.join(realParent, path.basename(root))) return removed;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
            removed.files++;
            removed.bytes += Number(stat.size);
          }
        }
      }
    });
    yield* visit(realRoot);
    return removed;
  });

  const reportRef = yield* SubscriptionRef.make<StorageCleanupReport | null>(null);
  const cleanCheckpointRefs = Effect.fn("StorageCleanup.cleanCheckpointRefs")(function* () {
    // Forks display their source history even after its thread is deleted. Keep
    // that ancestry, including deleted intermediate forks and archived children.
    const rows = yield* sql<{
      threadId: string;
      worktreePath: string | null;
      workspaceRoot: string | null;
      scopeId: string | null;
      cwd: string | null;
    }>`
      WITH RECURSIVE retained_checkpoint_threads(thread_id) AS (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
        UNION
        SELECT json_extract(t.payload_json, '$.forkedFrom.threadId')
        FROM orchestration_v2_projection_threads t
        JOIN retained_checkpoint_threads retained ON retained.thread_id = t.thread_id
        WHERE json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
      )
      SELECT t.thread_id AS "threadId",
        json_extract(t.payload_json, '$.worktreePath') AS "worktreePath",
        p.workspace_root AS "workspaceRoot", s.scope_id AS "scopeId",
        json_extract(s.payload_json, '$.cwd') AS cwd
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      LEFT JOIN orchestration_v2_projection_checkpoint_scopes s ON s.thread_id = t.thread_id
      WHERE t.deleted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM retained_checkpoint_threads WHERE thread_id = t.thread_id)
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox e
          WHERE e.thread_id = t.thread_id AND e.status IN ('pending', 'running')
        )
    `.pipe(NodeSqliteClient.readOnly);
    const targets = new Map<string, Set<string>>();
    for (const row of rows) {
      // Derive ownership from tombstones, never from absence in this database:
      // another T3 home can own refs in the same Git repository.
      const prefixes = [`refs/t3/checkpoints/${Base64Url.encode(row.threadId)}/turn/`];
      if (row.scopeId !== null) {
        prefixes.push(
          (yield* checkpointRefForScopeOrdinal({
            scopeId: CheckpointScopeId.make(row.scopeId),
            ordinalWithinScope: 0,
          })).slice(0, -1),
        );
      }
      // A worktree may already be gone; its refs live in the shared repository.
      for (const cwd of [row.cwd, row.worktreePath, row.workspaceRoot]) {
        if (cwd === null) continue;
        const key = path.resolve(cwd);
        const owned = targets.get(key) ?? new Set<string>();
        for (const prefix of prefixes) owned.add(prefix);
        targets.set(key, owned);
      }
    }
    const repositories = new Map<string, { cwd: string; prefixes: Set<string> }>();
    for (const [cwd, prefixes] of targets) {
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(cwd))) return;
        const result = yield* git.execute({
          operation: "StorageCleanup.checkpointRepository",
          cwd,
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          allowNonZeroExit: true,
        });
        if (result.exitCode !== 0) return;
        const commonDir = yield* fs.realPath(result.stdout.trim());
        const repository = repositories.get(commonDir) ?? { cwd, prefixes: new Set<string>() };
        for (const prefix of prefixes) repository.prefixes.add(prefix);
        repositories.set(commonDir, repository);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("checkpoint repository inspection failed", { cause }),
        ),
      );
    }
    for (const { cwd, prefixes } of repositories.values()) {
      yield* Effect.gen(function* () {
        const result = yield* git.execute({
          operation: "StorageCleanup.listCheckpointRefs",
          cwd,
          args: [
            "for-each-ref",
            "--format=%(refname)",
            "refs/t3/checkpoints/",
            "refs/t3/orchestration-v2/checkpoints/",
          ],
          maxOutputBytes: 16 * 1024 * 1024,
        });
        const refs = result.stdout.split("\n").filter((ref) => {
          const ordinalStart = ref.lastIndexOf("/") + 1;
          return (
            prefixes.has(ref.slice(0, ordinalStart)) &&
            /^(0|[1-9]\d*)$/.test(ref.slice(ordinalStart))
          );
        });
        if (refs.length === 0) return;
        yield* git.execute({
          operation: "StorageCleanup.deleteCheckpointRefs",
          cwd,
          // Remove a symbolic checkpoint itself, never its branch/tag target.
          args: ["update-ref", "--no-deref", "-z", "--stdin"],
          stdin: refs.map((ref) => `delete ${ref}\0\0`).join(""),
        });
        yield* Effect.logInfo("storage cleanup removed checkpoint refs", { refCount: refs.length });
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("checkpoint ref cleanup failed", { cause })),
      );
    }
    // Atelier fork: a VCS plugin's checkpoints live in its own store, found by their records. A
    // plugin turned off keeps them until it is back.
    if (plugins === undefined) return;
    const allPrefixes = new Set([...targets.values()].flatMap((prefixes) => [...prefixes]));
    const records = yield* pluginCheckpointsWithPrefixes(allPrefixes);
    if (records.length === 0) return;
    const drivers = yield* plugins.current;
    const groups = Map.groupBy(records, (record) => `${record.pluginId}\0${record.repositoryRoot}`);
    for (const group of groups.values()) {
      const { pluginId, repositoryRoot } = group[0]!;
      const driver = drivers.get(pluginId as VcsDriverKind);
      if (driver === undefined) continue;
      yield* driver.checkpoints
        .deleteCheckpointRefs({
          cwd: repositoryRoot,
          checkpointRefs: group.map((record) => CheckpointRef.make(record.checkpointRef)),
        })
        .pipe(
          Effect.tap(() =>
            Effect.logInfo("storage cleanup removed VCS plugin checkpoints", {
              refCount: group.length,
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("VCS plugin checkpoint cleanup failed", { cause }),
          ),
        );
    }
  });
  // Only deleted threads' worktrees wait on session stops: any stop while one waits, or a stop inside one kept for another reason.
  // A deletion stays pending until a sweep that started after it finishes.
  let deletedWorktreeWaits = true;
  let keptDeletedWorktrees: ReadonlyArray<string> = [];
  let deletions = 0;
  let sweptDeletions = 0;
  const sweep = Effect.fn("StorageCleanup.sweep")(function* (
    trigger: StorageCleanupReport["trigger"],
  ) {
    const deletionsAtStart = deletions;
    const now = yield* Clock.currentTimeMillis;
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const entries: StorageCleanupReportEntry[] = [];
    yield* cleanCheckpointRefs().pipe(
      Effect.catch((cause) => Effect.logWarning("checkpoint ref cleanup failed", { cause })),
    );
    const deletedWorktrees = yield* cleanWorktrees(serverSettings, now, entries, trigger).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          entries.push({
            kind: "worktree",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          });
          yield* Effect.logWarning("worktree cleanup failed", { error });
          return { waiting: true, kept: [] };
        }),
      ),
    );
    deletedWorktreeWaits = deletedWorktrees.waiting;
    keptDeletedWorktrees = deletedWorktrees.kept;
    sweptDeletions = deletionsAtStart;
    for (const category of [
      {
        kind: "browser-artifacts" as const,
        root: config.browserArtifactsDir,
        days: settings.browserArtifactsAfterDays,
        label: "browser artifacts",
      },
      {
        kind: "logs" as const,
        root: config.logsDir,
        days: settings.logsAfterDays,
        label: "rotated logs",
      },
    ]) {
      if (category.days === null) continue;
      const removed = { files: 0, bytes: 0 };
      yield* cleanFiles(category.root, category.days, now, category.kind === "logs", removed).pipe(
        Effect.map(({ files, bytes }) =>
          entries.push({
            kind: category.kind,
            outcome: files > 0 ? "removed" : "kept",
            reason: files === 0 ? "No expired files" : `Removed ${files} ${category.label}`,
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: files > 0 ? bytes : null,
            files: files > 0 ? files : null,
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              kind: category.kind,
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: removed.files > 0 ? removed.bytes : null,
              files: removed.files > 0 ? removed.files : null,
            });
            yield* Effect.logWarning("storage file cleanup failed", { kind: category.kind, error });
          }),
        ),
      );
    }
    const counts = { removed: 0, kept: 0, failed: 0 };
    let bytesFreed = 0;
    for (const entry of entries) {
      counts[entry.outcome]++;
      if (entry.outcome !== "kept") bytesFreed += entry.bytes ?? 0;
    }
    const priority = (entry: StorageCleanupReportEntry) =>
      entry.outcome === "failed"
        ? 0
        : entry.outcome === "removed"
          ? 1
          : entry.kind === "worktree" && entry.threadId === null
            ? 2
            : 3;
    const latestReport: StorageCleanupReport = {
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      finishedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries.sort((a, b) => priority(a) - priority(b)).slice(0, REPORT_ENTRY_LIMIT),
      counts,
      bytesFreed,
      omittedCount: Math.max(0, entries.length - REPORT_ENTRY_LIMIT),
    };
    yield* SubscriptionRef.set(reportRef, latestReport);
    return latestReport;
  });
  const automaticSweepQueued = yield* Ref.make(false);
  const worker = yield* makeDrainableWorker(
    (completion: Deferred.Deferred<StorageCleanupReport, ServerSettingsError> | undefined) =>
      (completion === undefined ? Ref.set(automaticSweepQueued, false) : Effect.void).pipe(
        Effect.andThen(sweep(completion === undefined ? "automatic" : "manual")),
        Effect.exit,
        Effect.flatMap((exit) =>
          completion === undefined
            ? exit.pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning("storage cleanup failed", { cause }),
                ),
              )
            : Deferred.done(completion, exit).pipe(Effect.asVoid),
        ),
      ),
  );
  const requestSweep = Ref.getAndSet(automaticSweepQueued, true).pipe(
    Effect.flatMap((queued) => (queued ? Effect.void : worker.enqueue(undefined))),
  );
  const runNow = Effect.gen(function* () {
    const completion = yield* Deferred.make<StorageCleanupReport, ServerSettingsError>();
    yield* worker.enqueue(completion);
    return yield* Deferred.await(completion);
  });

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      requestSweep.pipe(
        Effect.andThen(worker.drain),
        Effect.repeat(Schedule.spaced("1 hour")),
        Effect.asVoid,
      ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return requestSweep;
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        if (event.type === "thread.deleted") deletions++;
        else if (
          event.type !== "provider-session.updated" ||
          (event.payload.status !== "stopped" && event.payload.status !== "error")
        )
          return Effect.void;
        else if (!deletedWorktreeWaits && deletions === sweptDeletions) {
          const cwd = pathKey(event.payload.cwd);
          if (
            !keptDeletedWorktrees.some(
              (worktreePath) => pathKey(worktreePath) === cwd || inside(worktreePath, cwd),
            )
          )
            return Effect.void;
        }
        if (event.type === "thread.deleted") return requestSweep;
        if (!anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)) return Effect.void;
        return event.type === "provider-session.updated" && event.payload.status === "error"
          ? providerSessions
              .isLive(event.payload.id)
              .pipe(Effect.flatMap((live) => (live ? Effect.void : requestSweep)))
          : requestSweep;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
  });
  yield* start();
  return StorageCleanup.of({
    worktreeThreadIds,
    removeWorktree,
    runNow,
    latestReport: SubscriptionRef.get(reportRef),
    reports: SubscriptionRef.changes(reportRef),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(StorageCleanup, make);
