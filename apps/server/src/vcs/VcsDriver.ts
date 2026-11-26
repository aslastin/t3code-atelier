import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  GitCommandError,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsDriverCapabilities,
  VcsError,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsPullInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  VcsInitInput,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  VcsRepositoryIdentity,
} from "@t3tools/contracts";
import { CheckpointRef } from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";

export interface VcsCaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The checkpoint this one follows, so a turn that switched branches starts where it landed. */
  readonly previousCheckpointRef?: CheckpointRef;
  /** Folders below `cwd` (relative, `/`-separated) that other checkpoints own, such as nested clones. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface VcsCaptureHeadCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** A commit `resolveCleanHead` returned for this folder. */
  readonly head: string;
  /**
   * When the folder was seen clean, in epoch seconds, if that was earlier than now. Commits made
   * after a checkpoint count as the turn's own work, so a late snapshot must not postdate them.
   */
  readonly seenAt?: number;
}

export interface VcsRestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
  /** Folders below `cwd` the restore leaves as they are, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

export interface VcsDiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /** Folders below `cwd` left out of the diff, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface VcsListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface VcsDeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface VcsCheckpointOps {
  readonly captureCheckpoint: (input: VcsCaptureCheckpointInput) => Effect.Effect<void, VcsError>;
  /**
   * HEAD's commit when the folder matches it exactly: nothing staged, modified or untracked.
   * Null otherwise. One status, where a capture stages the whole worktree.
   */
  readonly resolveCleanHead: (cwd: string) => Effect.Effect<string | null, VcsError>;
  /** Snapshots a folder that was clean at `head` from that commit, without reading its files. */
  readonly captureHeadCheckpoint: (
    input: VcsCaptureHeadCheckpointInput,
  ) => Effect.Effect<void, VcsError>;
  readonly hasCheckpointRef: (
    input: Omit<VcsRestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, VcsError>;
  readonly restoreCheckpoint: (
    input: VcsRestoreCheckpointInput,
  ) => Effect.Effect<boolean, VcsError>;
  /** Atelier fork: whether a restore would succeed now; `hasCheckpointRef` when absent. */
  readonly verifyRestorable?: (
    input: Omit<VcsRestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, VcsError>;
  readonly diffCheckpoints: (input: VcsDiffCheckpointsInput) => Effect.Effect<string, VcsError>;
  readonly listAuthoredPaths: (
    input: VcsListAuthoredPathsInput,
  ) => Effect.Effect<ReadonlySet<string> | null, VcsError>;
  readonly deleteCheckpointRefs: (
    input: VcsDeleteCheckpointRefsInput,
  ) => Effect.Effect<void, VcsError>;
}

type WorkflowOperation<Input, Output> = (input: Input) => Effect.Effect<Output, GitCommandError>;

export interface VcsWorkflowOps {
  readonly status?: WorkflowOperation<VcsStatusInput, VcsStatusResult>;
  readonly listRefs?: WorkflowOperation<VcsListRefsInput, VcsListRefsResult>;
  readonly createWorktree?: WorkflowOperation<VcsCreateWorktreeInput, VcsCreateWorktreeResult>;
  readonly removeWorktree?: WorkflowOperation<VcsRemoveWorktreeInput, void>;
  readonly listWorktrees?: WorkflowOperation<VcsStatusInput, ReadonlyArray<string>>;
  /** Uncommitted changes as a Git-format patch, to write a commit message from. */
  readonly workingDiff?: WorkflowOperation<
    { readonly cwd: string; readonly filePaths?: ReadonlyArray<string> | undefined },
    string
  >;
  /** Recent commit subjects, newest first, for the style of written commit messages. */
  readonly recentCommitSubjects?: WorkflowOperation<
    { readonly cwd: string },
    ReadonlyArray<string>
  >;
  /** Starts a branch from the checkout and switches to it, keeping uncommitted changes. */
  readonly createBranch?: WorkflowOperation<
    { readonly cwd: string; readonly refName: string },
    void
  >;
  /** Forgets worktrees whose folder is gone, before one is created at the same path again. */
  readonly pruneWorktrees?: WorkflowOperation<{ readonly cwd: string }, void>;
  readonly commit?: WorkflowOperation<
    Pick<GitRunStackedActionInput, "cwd" | "filePaths" | "commitMessage">,
    GitRunStackedActionResult["commit"]
  >;
  readonly push?: WorkflowOperation<VcsStatusInput, GitRunStackedActionResult["push"]>;
  readonly pull?: WorkflowOperation<VcsPullInput, VcsPullResult>;
  readonly createRef?: WorkflowOperation<VcsCreateRefInput, VcsCreateRefResult>;
  readonly switchRef?: WorkflowOperation<VcsSwitchRefInput, VcsSwitchRefResult>;
}

export class VcsDriver extends Context.Service<
  VcsDriver,
  {
    readonly workflow?: VcsWorkflowOps;
    readonly capabilities?: VcsDriverCapabilities;
    readonly execute: (
      input: Omit<VcsProcess.VcsProcessInput, "command">,
    ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    readonly checkpoints: VcsCheckpointOps;
    readonly detectRepository: (
      cwd: string,
    ) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
    readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
    readonly listWorkspaceFiles: (
      cwd: string,
    ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
    readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
    readonly filterIgnoredPaths: (
      cwd: string,
      relativePaths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/VcsDriver") {}
