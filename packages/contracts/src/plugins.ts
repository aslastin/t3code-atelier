import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

// Atelier fork: plugins are folders under `<T3 home>/plugins/<id>/` with a declarative
// `plugin.json`. The server runs their commands; clients only see the summary below.

export const PLUGIN_PROTOCOL = "t3-plugin/1";
export const PLUGIN_MANIFEST_FILE_NAME = "plugin.json";

export const PluginKind = Schema.Literals(["vcs"]);
export type PluginKind = typeof PluginKind.Type;

export const VcsPluginCheckpointStrategy = Schema.Literals(["native", "changed-files", "full"]);
export type VcsPluginCheckpointStrategy = typeof VcsPluginCheckpointStrategy.Type;

/** An argv array: no shell runs it, and a placeholder never splits into several arguments. */
const PluginArgv = Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);

export const VcsPluginCommands = Schema.Struct({
  status: PluginArgv,
  listRemotes: Schema.optionalKey(PluginArgv),
  listRefs: Schema.optionalKey(PluginArgv),
  commit: Schema.optionalKey(PluginArgv),
  push: Schema.optionalKey(PluginArgv),
  pull: Schema.optionalKey(PluginArgv),
  worktreeCreate: Schema.optionalKey(PluginArgv),
  worktreeRemove: Schema.optionalKey(PluginArgv),
  /** Uncommitted changes as a patch, for writing a commit message. */
  diff: Schema.optionalKey(PluginArgv),
  /** Recent commit subjects, so written messages follow the repository's style. */
  log: Schema.optionalKey(PluginArgv),
  /** Starts a branch from the checkout and switches to it, keeping uncommitted changes. */
  branchCreate: Schema.optionalKey(PluginArgv),
  /** Renames a branch, such as a new worktree's temporary one once its thread has a name. */
  branchRename: Schema.optionalKey(PluginArgv),
  /** Fetches a branch from the remote without touching the checkout, for "Start from remote". */
  fetchBase: Schema.optionalKey(PluginArgv),
  /** Checks an existing ref out into a new worktree, to bring back one that was removed. */
  worktreeAttach: Schema.optionalKey(PluginArgv),
  worktreeList: Schema.optionalKey(PluginArgv),
  checkpointCapture: Schema.optionalKey(PluginArgv),
  checkpointDiff: Schema.optionalKey(PluginArgv),
  checkpointRestore: Schema.optionalKey(PluginArgv),
  checkpointDelete: Schema.optionalKey(PluginArgv),
  changedFiles: Schema.optionalKey(PluginArgv),
  readFile: Schema.optionalKey(PluginArgv),
});
export type VcsPluginCommands = typeof VcsPluginCommands.Type;
export type VcsPluginCommandName = keyof VcsPluginCommands;

export const VcsPluginManifest = Schema.Struct({
  protocol: Schema.Literal(PLUGIN_PROTOCOL),
  kind: Schema.Literal("vcs"),
  id: VcsDriverKind,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  icon: Schema.optionalKey(TrimmedNonEmptyString),
  check: PluginArgv,
  detect: Schema.Struct({
    // Not trimmed: a marker is matched as written, so the manifest's own check sees what it says.
    markers: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
  }),
  capabilities: Schema.optionalKey(
    Schema.Struct({ worktrees: Schema.optionalKey(Schema.Boolean) }),
  ),
  /** Strategies T3 may use, in order. Defaults to `["changed-files"]`; `full` must be listed. */
  checkpoints: Schema.optionalKey(Schema.Array(VcsPluginCheckpointStrategy)),
  commands: VcsPluginCommands,
});
export type VcsPluginManifest = typeof VcsPluginManifest.Type;

// What each operation prints on stdout. Fields T3 can infer are optional.

export const PluginCheckOutput = Schema.Struct({
  version: Schema.String,
  problems: Schema.Array(Schema.String),
});
export type PluginCheckOutput = typeof PluginCheckOutput.Type;

// Kept as printed: a name can start or end with a space.
const PluginPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

export const VcsPluginStatusOutput = Schema.Struct({
  refName: Schema.NullOr(TrimmedNonEmptyString),
  isDefaultRef: Schema.optionalKey(Schema.Boolean),
  hasPrimaryRemote: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: PluginPath,
        insertions: Schema.optionalKey(NonNegativeInt),
        deletions: Schema.optionalKey(NonNegativeInt),
        /** A file the VCS does not track yet, so cleanup's tracked-changes rule ignores it. */
        untracked: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  hasUpstream: Schema.optionalKey(Schema.Boolean),
  aheadCount: Schema.optionalKey(NonNegativeInt),
  behindCount: Schema.optionalKey(NonNegativeInt),
});
export type VcsPluginStatusOutput = typeof VcsPluginStatusOutput.Type;

export const VcsPluginLogOutput = Schema.Struct({
  /** Newest first. */
  subjects: Schema.Array(Schema.String),
});
export type VcsPluginLogOutput = typeof VcsPluginLogOutput.Type;

export const VcsPluginRemotesOutput = Schema.Struct({
  remotes: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      /** A URL, or `<vcs>://<repository>` for a VCS without URLs. */
      url: TrimmedNonEmptyString,
      pushUrl: Schema.optionalKey(TrimmedNonEmptyString),
      isPrimary: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type VcsPluginRemotesOutput = typeof VcsPluginRemotesOutput.Type;

export const VcsPluginRefsOutput = Schema.Struct({
  refs: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      current: Schema.optionalKey(Schema.Boolean),
      isDefault: Schema.optionalKey(Schema.Boolean),
      isRemote: Schema.optionalKey(Schema.Boolean),
      remoteName: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
});
export type VcsPluginRefsOutput = typeof VcsPluginRefsOutput.Type;

export const VcsPluginCommitOutput = Schema.Struct({
  commitSha: Schema.optionalKey(TrimmedNonEmptyString),
  subject: Schema.optionalKey(TrimmedNonEmptyString),
});

export const VcsPluginPushOutput = Schema.Struct({
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  upstreamBranch: Schema.optionalKey(TrimmedNonEmptyString),
});

export const VcsPluginPullOutput = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: TrimmedNonEmptyString,
  upstreamRef: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});

/** The ref or revision a worktree starts from, once `fetchBase` brought it up to date. */
export const VcsPluginFetchBaseOutput = Schema.Struct({
  baseRef: TrimmedNonEmptyString,
});

export const VcsPluginWorktreeCreateOutput = Schema.Struct({
  refName: TrimmedNonEmptyString,
});

export const VcsPluginWorktreeListOutput = Schema.Struct({
  worktrees: Schema.Array(
    Schema.Struct({
      path: PluginPath,
      /** The ref checked out there, so its branch can name the worktree. */
      refName: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
});

export const VcsPluginCheckpointCaptureOutput = Schema.Struct({
  revision: TrimmedNonEmptyString,
});

/** A Git-formatted patch between two native snapshots. */
export const VcsPluginCheckpointDiffOutput = Schema.Struct({
  patch: Schema.String,
});

export const VcsPluginChangedFileStatus = Schema.Literals(["modified", "added", "deleted"]);
export type VcsPluginChangedFileStatus = typeof VcsPluginChangedFileStatus.Type;

export const VcsPluginChangedFilesOutput = Schema.Struct({
  /** The revision the paths changed from; `readFile` reads unchanged files there. */
  revision: TrimmedNonEmptyString,
  files: Schema.Array(
    Schema.Struct({
      path: PluginPath,
      status: VcsPluginChangedFileStatus,
      /** The file at `revision` is executable, so a restored copy is too. */
      executable: Schema.optionalKey(Schema.Boolean),
      /** The path at `revision` is a symbolic link, and `readFile` prints its target. */
      symlink: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type VcsPluginChangedFilesOutput = typeof VcsPluginChangedFilesOutput.Type;

// What clients see.

export const PluginStatus = Schema.Literals([
  "checking",
  "available",
  "unavailable",
  "invalid",
  "disabled",
]);
export type PluginStatus = typeof PluginStatus.Type;

export const PluginSummary = Schema.Struct({
  /** The manifest id, or the folder name when the manifest cannot be read. */
  id: TrimmedNonEmptyString,
  kind: PluginKind,
  label: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  status: PluginStatus,
  version: Schema.NullOr(Schema.String),
  /** Manifest errors and the problems `check` printed, for Settings. */
  problems: Schema.Array(Schema.String),
  /** The last operation that failed, such as output that broke the contract. */
  lastError: Schema.NullOr(
    Schema.Struct({ operation: Schema.String, message: Schema.String, at: IsoDateTime }),
  ),
  /** SVG markup from the plugin folder, shown as an image. */
  iconSvg: Schema.NullOr(Schema.String),
  checkpoints: Schema.Array(VcsPluginCheckpointStrategy),
  supportsWorktrees: Schema.Boolean,
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type PluginSummary = typeof PluginSummary.Type;

export const PluginListResult = Schema.Struct({
  plugins: Schema.Array(PluginSummary),
  /** Where the server keeps plugins, so Settings can say where they went. */
  directory: Schema.String,
});
export type PluginListResult = typeof PluginListResult.Type;

export const PluginListInput = Schema.Struct({});
export const PluginImportInput = Schema.Struct({
  /** A folder on the environment's machine. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
});
export type PluginImportInput = typeof PluginImportInput.Type;
export const PluginIdInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type PluginIdInput = typeof PluginIdInput.Type;
export const PluginSetEnabledInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  operation: Schema.String,
  pluginId: Schema.optional(Schema.String),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
