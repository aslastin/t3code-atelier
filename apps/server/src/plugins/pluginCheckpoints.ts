// @effect-diagnostics nodeBuiltinImport:off -- Synchronous digests and random temp file names.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  VcsCheckpointStorageError,
  VcsPluginChangedFilesOutput,
  VcsPluginOutputError,
  VcsUnsupportedOperationError,
  type CheckpointRef,
  type VcsError,
  type VcsPluginChangedFileStatus,
  type VcsPluginCheckpointStrategy,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES, type VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { PluginCommandRunner } from "./pluginCommandRunner.ts";

const CHECKPOINT_TIMEOUT_MS = 120_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const READ_FILE_MAX_BYTES = 50_000_000;
const CHANGED_FILES_MAX_BYTES = 5_000_000;

/**
 * One line per failed strategy for the turn's note; the full error, with paths, goes to the log.
 * Names in backticks are shown as code.
 */
const describeFailure = (error: { readonly _tag: string; readonly message: string }) => {
  const operation = "operation" in error ? String(error.operation) : "";
  const command = operation.slice(operation.lastIndexOf(".") + 1);
  switch (error._tag) {
    case "VcsProcessExitError":
      return `\`${command}\` exited with code ${"exitCode" in error ? String(error.exitCode) : "?"}.`;
    case "VcsProcessTimeoutError":
      return `\`${command}\` timed out.`;
    case "VcsProcessSpawnError":
      return `\`${command}\` could not start.`;
    default:
      return error.message;
  }
};

/** Atelier fork table, created outside the numbered migrations like the topic tables. */
export const ensurePluginCheckpointTable = Effect.fn(
  "pluginCheckpoints.ensurePluginCheckpointTable",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS atelier_vcs_plugin_checkpoint_records (
      repository_root TEXT NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      revision TEXT NOT NULL,
      base_revision TEXT,
      files_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (repository_root, plugin_id, checkpoint_ref)
    )
  `;
});

interface ChangedFile {
  readonly path: string;
  readonly status: VcsPluginChangedFileStatus;
  readonly executable?: boolean;
  readonly symlink?: boolean;
}

interface CheckpointRecord {
  readonly strategy: VcsPluginCheckpointStrategy;
  /** The plugin's snapshot for `native`, a shadow commit otherwise. */
  readonly revision: string;
  readonly baseRevision: string | null;
  readonly files: ReadonlyArray<ChangedFile> | null;
}

const RecordRow = Schema.Struct({
  strategy: Schema.Literals(["native", "changed-files", "full"]),
  revision: Schema.String,
  baseRevision: Schema.NullOr(Schema.String),
  filesJson: Schema.NullOr(Schema.String),
});
const FilesJson = Schema.fromJsonString(VcsPluginChangedFilesOutput.fields.files);
const decodeRecordRow = Schema.decodeUnknownEffect(RecordRow);
const decodeFiles = Schema.decodeEffect(FilesJson);
const encodeFiles = Schema.encodeEffect(FilesJson);

/** Repository-relative, `/`-separated, and inside the repository. */
const isRepositoryPath = (value: string) =>
  !/^[A-Za-z]:|^[/\\]/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  !value.includes("\\");

const inScope = (file: string, scope: string, excludes: ReadonlyArray<string>) =>
  (scope === "" || file === scope || file.startsWith(`${scope}/`)) &&
  !excludes.some((exclude) => file === exclude || file.startsWith(`${exclude}/`));

export interface PluginCheckpointContext {
  readonly runner: PluginCommandRunner;
  readonly strategies: ReadonlyArray<VcsPluginCheckpointStrategy>;
  /** Top-level folders the VCS keeps its own data in, never staged by `full`. */
  readonly metadataFolders: ReadonlyArray<string>;
  /** Marker paths of this and every other installed plugin, beside `.git`. */
  readonly repositoryMarkers: () => ReadonlyArray<string>;
  /** Serializes native capture and deletion; shared by every driver built for the plugin. */
  readonly nativeSnapshots?: Semaphore.Semaphore;
  readonly repositoryRoot: (cwd: string) => Effect.Effect<string, VcsError>;
}

/**
 * Recorded plugin checkpoints named `<prefix><ordinal>`, for cleanup of deleted threads. Empty
 * when no plugin ever recorded one.
 */
export const pluginCheckpointsWithPrefixes = Effect.fn("pluginCheckpoints.withPrefixes")(function* (
  prefixes: ReadonlySet<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    repositoryRoot: string;
    pluginId: string;
    checkpointRef: string;
  }>`
      SELECT repository_root AS "repositoryRoot", plugin_id AS "pluginId",
        checkpoint_ref AS "checkpointRef"
      FROM atelier_vcs_plugin_checkpoint_records
    `.pipe(Effect.orElseSucceed(() => []));
  return rows.filter((row) => {
    const ordinalStart = row.checkpointRef.lastIndexOf("/") + 1;
    return (
      prefixes.has(row.checkpointRef.slice(0, ordinalStart)) &&
      /^(0|[1-9]\d*)$/.test(row.checkpointRef.slice(ordinalStart))
    );
  });
});

/**
 * Whether a checkout holds native snapshots T3 Code still records. A plugin may keep them inside
 * the checkout, so removing it for a live thread would lose the thread's checkpoints.
 */
export const hasNativeCheckpointsIn = Effect.fn("pluginCheckpoints.hasNativeCheckpointsIn")(
  function* (roots: ReadonlyArray<string>) {
    const sql = yield* SqlClient.SqlClient;
    for (const root of new Set(roots)) {
      const rows = yield* sql`
        SELECT 1 FROM atelier_vcs_plugin_checkpoint_records
        WHERE repository_root = ${root} AND strategy = 'native' LIMIT 1
      `.pipe(Effect.orElseSucceed(() => []));
      if (rows.length > 0) return true;
    }
    return false;
  },
);

/** Checkpoints through the strategies a plugin lists, in its order. */
export const makePluginCheckpoints = Effect.fn("pluginCheckpoints.make")(function* (
  context: PluginCheckpointContext,
) {
  const sql = yield* SqlClient.SqlClient;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const { runner } = context;
  const kind = runner.kind;
  const shadowRoot = path.join(config.stateDir, "vcs-plugin-checkpoints");
  const nativeSnapshots = context.nativeSnapshots ?? (yield* Semaphore.make(1));

  const storageError = (operation: string, cwd: string) => (cause: unknown) =>
    new VcsCheckpointStorageError({ operation, cwd, stage: "publish", cause });
  const unsupported = (operation: string, detail: string) =>
    new VcsUnsupportedOperationError({ operation, kind, detail });

  interface Location {
    readonly root: string;
    /** `cwd` below the root, `/`-separated; empty at the root. */
    readonly scope: string;
    readonly shadow: string;
  }
  // Exclusions arrive relative to the scope's folder; every path here is repository-relative.
  const repositoryExcludes = (location: Location, excludes: ReadonlyArray<string> | undefined) =>
    (excludes ?? []).map((exclude) =>
      location.scope === "" ? exclude : `${location.scope}/${exclude}`,
    );

  // Per plugin too: another plugin for the same folder keeps its own shadow refs.
  const shadowOf = (realRoot: string) =>
    path.join(
      shadowRoot,
      `${NodeCrypto.createHash("sha256").update(`${kind}\0${realRoot}`).digest("hex").slice(0, 24)}.git`,
    );

  const locate = Effect.fn("pluginCheckpoints.locate")(function* (cwd: string) {
    const root = yield* context.repositoryRoot(cwd);
    const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
    const realCwd = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const scope = path.relative(realRoot, realCwd).split(path.sep).join("/");
    return { root: realRoot, scope, shadow: shadowOf(realRoot) } as Location;
  });

  // Plain Git against a bare repository under T3 home, with the plugin's repository as work tree.
  const git = Effect.fn("pluginCheckpoints.git")(function* (
    location: Location,
    args: ReadonlyArray<string>,
    options?: {
      readonly index?: string;
      readonly stdin?: string;
      readonly maxOutputBytes?: number;
      readonly truncate?: boolean;
      /** For a ref change after the checkout is gone. */
      readonly cwd?: string;
    },
  ) {
    const result = yield* vcsProcess.run({
      operation: "pluginCheckpoints.git",
      command: "git",
      cwd: options?.cwd ?? location.root,
      args: [
        `--git-dir=${location.shadow}`,
        `--work-tree=${location.root}`,
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=",
        "-c",
        `core.attributesFile=${NodeOS.devNull}`,
        ...args,
      ],
      env: {
        GIT_AUTHOR_NAME: "T3 Code",
        GIT_AUTHOR_EMAIL: "checkpoints@t3.invalid",
        GIT_COMMITTER_NAME: "T3 Code",
        GIT_COMMITTER_EMAIL: "checkpoints@t3.invalid",
        // The plugin's repository asked for no conversion: ignore its .gitattributes (eol,
        // filters) by reading attributes from the empty tree.
        GIT_ATTR_SOURCE: EMPTY_TREE,
        GIT_ATTR_NOSYSTEM: "1",
        ...(options?.index ? { GIT_INDEX_FILE: options.index } : {}),
      },
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
      maxOutputBytes: options?.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      // A cut listing would restore part of a checkout; only a displayed patch may be cut.
      outputMode: options?.truncate ? "truncate" : "error",
    });
    return result.stdout;
  });

  const ensureShadow = Effect.fn("pluginCheckpoints.ensureShadow")(function* (location: Location) {
    if (yield* fs.exists(path.join(location.shadow, "HEAD"))) return;
    yield* fs
      .makeDirectory(shadowRoot, { recursive: true })
      .pipe(Effect.mapError(storageError("pluginCheckpoints.ensureShadow", location.root)));
    yield* vcsProcess.run({
      operation: "pluginCheckpoints.init",
      command: "git",
      cwd: shadowRoot,
      args: ["init", "--bare", "--quiet", location.shadow],
    });
  });

  // Each staging uses its own index, so a capture never sees another's leftovers.
  const withIndex = <A, E, R>(location: Location, use: (index: string) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => path.join(location.shadow, `t3-index-${NodeCrypto.randomUUID()}`)),
      use,
      (index) => fs.remove(index, { force: true }).pipe(Effect.ignore),
    );

  // A listed folder can hold a nested scope: Git never reads its files, they are left out.
  const stagePaths = (
    location: Location,
    index: string,
    paths: ReadonlyArray<string>,
    excludes: ReadonlyArray<string>,
  ) =>
    paths.length === 0
      ? Effect.void
      : git(
          location,
          ["add", "--force", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
          {
            index,
            stdin: `${[
              ...paths.map((file) => `:(top,literal)${file}`),
              ...excludes.map((exclude) => `:(top,literal,exclude)${exclude}`),
            ].join("\0")}\0`,
          },
        ).pipe(Effect.asVoid);

  const commitIndex = Effect.fn("pluginCheckpoints.commitIndex")(function* (
    location: Location,
    index: string,
  ) {
    const tree = (yield* git(location, ["write-tree"], { index })).trim();
    return (yield* git(location, ["commit-tree", tree, "-m", "T3 checkpoint"])).trim();
  });

  const listTreeFiles = (location: Location, commit: string) =>
    git(location, ["ls-tree", "-r", "--name-only", "-z", commit]).pipe(
      Effect.map((out) => out.split("\0").filter((entry) => entry.length > 0)),
    );

  const changedFiles = Effect.fn("pluginCheckpoints.changedFiles")(function* (
    location: Location,
    cwd: string,
    excludes: ReadonlyArray<string>,
  ) {
    const output = yield* runner.runJson("changedFiles", VcsPluginChangedFilesOutput, {
      cwd,
      values: { repositoryRoot: location.root },
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
      maxOutputBytes: CHANGED_FILES_MAX_BYTES,
    });
    const outside = output.files.find((file) => !isRepositoryPath(file.path));
    if (outside)
      return yield* new VcsPluginOutputError({
        operation: "changedFiles",
        kind,
        detail: `"${outside.path}" is not a repository-relative path.`,
      });
    // A new folder around the project's folder makes the whole project folder new.
    const files = output.files.map((file) =>
      file.status === "added" && location.scope.startsWith(`${file.path}/`)
        ? { ...file, path: location.scope }
        : file,
    );
    return {
      revision: output.revision,
      files: files.filter((file) => inScope(file.path, location.scope, excludes)),
    };
  });

  // A file inside a repository, a mount or a linked folder is not this checkout's to save,
  // whatever the plugin lists. A restore still sees it, and refuses to change it.
  const ownFiles = Effect.fnUntraced(function* (
    location: Location,
    files: ReadonlyArray<ChangedFile>,
  ) {
    const rootDevice = (yield* fs.stat(location.root).pipe(Effect.option)).pipe(
      Option.map((info) => info.dev),
      Option.getOrUndefined,
    );
    const nestedFolder = new Map<string, boolean>();
    const isNestedFolder = Effect.fnUntraced(function* (folder: string) {
      const known = nestedFolder.get(folder);
      if (known !== undefined) return known;
      const absolute = path.join(location.root, folder);
      const nested =
        Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option)) ||
        (yield* fs.stat(absolute).pipe(
          Effect.map((info) => rootDevice !== undefined && info.dev !== rootDevice),
          Effect.orElseSucceed(() => false),
        )) ||
        (yield* isRepositoryRoot(absolute));
      nestedFolder.set(folder, nested);
      return nested;
    });
    const own: ChangedFile[] = [];
    for (const file of files) {
      const parts = file.path.split("/");
      let enclosed = false;
      for (let index = 1; index < parts.length && !enclosed; index++)
        enclosed = yield* isNestedFolder(parts.slice(0, index).join("/"));
      if (!enclosed) own.push(file);
    }
    return own;
  });

  /** Bytes of `file` at `revision`, or null when the plugin says it does not exist there. */
  const readBaseFile = Effect.fn("pluginCheckpoints.readBaseFile")(function* (
    location: Location,
    cwd: string,
    revision: string,
    file: string,
  ) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const result = yield* runner
      .run("readFile", {
        cwd,
        values: { repositoryRoot: location.root, revision, path: file },
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
        maxOutputBytes: 1,
        // A missing file is an answer here, not a plugin failure.
        reportFailures: false,
        onStdoutChunk: (chunk) => {
          size += chunk.byteLength;
          if (size <= READ_FILE_MAX_BYTES) chunks.push(chunk);
        },
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      if (result.failure._tag === "VcsProcessExitError") return null;
      return yield* result.failure;
    }
    if (size > READ_FILE_MAX_BYTES)
      return yield* unsupported("readFile", `${file} is larger than the checkpoint limit.`);
    return Buffer.concat(chunks);
  });

  const writeBlob = Effect.fn("pluginCheckpoints.writeBlob")(function* (
    location: Location,
    bytes: Uint8Array,
  ) {
    const temporary = path.join(location.shadow, `t3-blob-${NodeCrypto.randomUUID()}`);
    return yield* fs.writeFile(temporary, bytes).pipe(
      Effect.mapError(storageError("pluginCheckpoints.writeBlob", location.root)),
      Effect.andThen(git(location, ["hash-object", "-w", "--no-filters", "--", temporary])),
      Effect.map((sha) => sha.trim()),
      Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    );
  });

  const readRecord = Effect.fn("pluginCheckpoints.readRecord")(function* (
    location: Location,
    checkpointRef: CheckpointRef,
  ) {
    const rows = yield* sql`
      SELECT strategy, revision, base_revision AS "baseRevision", files_json AS "filesJson"
      FROM atelier_vcs_plugin_checkpoint_records
      WHERE repository_root = ${location.root} AND checkpoint_ref = ${checkpointRef}
        AND plugin_id = ${kind}
    `.pipe(Effect.mapError(storageError("pluginCheckpoints.readRecord", location.root)));
    if (rows.length === 0) return null;
    const corrupt = storageError("pluginCheckpoints.readRecord", location.root);
    const row = yield* decodeRecordRow(rows[0]).pipe(Effect.mapError(corrupt));
    return {
      strategy: row.strategy,
      revision: row.revision,
      baseRevision: row.baseRevision,
      files:
        row.filesJson === null
          ? null
          : yield* decodeFiles(row.filesJson).pipe(Effect.mapError(corrupt)),
    } satisfies CheckpointRecord;
  });

  const writeRecord = Effect.fn("pluginCheckpoints.writeRecord")(function* (
    location: Location,
    checkpointRef: CheckpointRef,
    record: CheckpointRecord,
  ) {
    const failed = storageError("pluginCheckpoints.writeRecord", location.root);
    const filesJson =
      record.files === null ? null : yield* encodeFiles(record.files).pipe(Effect.mapError(failed));
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT OR REPLACE INTO atelier_vcs_plugin_checkpoint_records
        (repository_root, checkpoint_ref, plugin_id, strategy, revision, base_revision,
         files_json, created_at)
      VALUES (${location.root}, ${checkpointRef}, ${kind}, ${record.strategy}, ${record.revision},
        ${record.baseRevision}, ${filesJson}, ${createdAt})
    `.pipe(Effect.mapError(failed));
  });

  // The patch is the command's whole stdout.
  const nativeDiff = (location: Location, cwd: string, from: string, to: string) =>
    runner
      .run("checkpointDiff", {
        cwd,
        values: { repositoryRoot: location.root, fromRevision: from, toRevision: to },
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.map((output) => output.stdout));

  const capture = {
    native: Effect.fn("pluginCheckpoints.captureNative")(function* (
      location: Location,
      cwd: string,
      checkpointRef: CheckpointRef,
      excludes: ReadonlyArray<string>,
    ) {
      // The plugin snapshots and restores the whole folder; a nested scope needs a strategy that
      // can leave it out.
      if (excludes.length > 0)
        return yield* unsupported(
          "captureCheckpoint",
          "A native snapshot cannot leave out a nested folder with its own checkpoints.",
        );
      // Restoring it would put back the files beside the project's folder too.
      if (location.scope !== "")
        return yield* unsupported(
          "captureCheckpoint",
          "A native snapshot covers the whole repository, not only the project's folder.",
        );
      // The revision is the command's stdout, trimmed.
      const revision = (yield* runner.run("checkpointCapture", {
        cwd,
        values: { repositoryRoot: location.root },
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      })).stdout.trim();
      if (revision === "")
        return yield* new VcsPluginOutputError({
          operation: "checkpointCapture",
          kind,
          detail: "checkpointCapture printed no revision.",
        });
      // Some stores hand out snapshots that cannot be read back; only a readable one counts.
      yield* nativeDiff(location, cwd, revision, revision);
      return { strategy: "native", revision, baseRevision: null, files: null } as CheckpointRecord;
    }),
    "changed-files": Effect.fn("pluginCheckpoints.captureChangedFiles")(function* (
      location: Location,
      cwd: string,
      checkpointRef: CheckpointRef,
      excludes: ReadonlyArray<string>,
    ) {
      const changes = yield* changedFiles(location, cwd, excludes);
      // Deletions are recorded, never read; a listed file that is gone counts as one.
      const files: ChangedFile[] = [];
      for (const file of yield* ownFiles(location, changes.files)) {
        const absolute = path.join(location.root, file.path);
        // A symbolic link counts even when its target is gone. Only a path known to be absent is
        // a deletion: one that cannot be looked at fails the capture.
        const absent = () => Effect.succeed(false);
        const present =
          file.status !== "deleted" &&
          (yield* fs.readLink(absolute).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "NotFound", absent),
            Effect.catch(() =>
              fs
                .stat(absolute)
                .pipe(Effect.as(true), Effect.catchReason("PlatformError", "NotFound", absent)),
            ),
            Effect.mapError(() =>
              unsupported("captureCheckpoint", `${file.path} could not be looked at.`),
            ),
          ));
        files.push(present || file.status === "deleted" ? file : { ...file, status: "deleted" });
      }
      // A folder listed as one entry is read in full, but never a repository or mount inside it.
      const inside: string[] = [];
      for (const file of files) {
        if (file.status === "deleted") continue;
        const nested = yield* nestedRepositories(location, file.path);
        if (nested === null)
          return yield* unsupported("captureCheckpoint", `${file.path} could not be looked at.`);
        inside.push(...nested);
      }
      yield* ensureShadow(location);
      const commit = yield* withIndex(location, (index) =>
        stagePaths(
          location,
          index,
          files.filter((file) => file.status !== "deleted").map((file) => file.path),
          [...excludes, ...inside],
        ).pipe(Effect.andThen(commitIndex(location, index))),
      );
      yield* git(location, ["update-ref", checkpointRef, commit]);
      return {
        strategy: "changed-files",
        revision: commit,
        baseRevision: changes.revision,
        files,
      } as CheckpointRecord;
    }),
    full: Effect.fn("pluginCheckpoints.captureFull")(function* (
      location: Location,
      _cwd: string,
      checkpointRef: CheckpointRef,
      excludes: ReadonlyArray<string>,
    ) {
      yield* ensureShadow(location);
      const commit = yield* withIndex(location, (index) =>
        stageFull(location, index, excludes).pipe(Effect.andThen(commitIndex(location, index))),
      );
      yield* git(location, ["update-ref", checkpointRef, commit]);
      return {
        strategy: "full",
        revision: commit,
        baseRevision: null,
        files: null,
      } as CheckpointRecord;
    }),
  };

  const stageFull = (location: Location, index: string, excludes: ReadonlyArray<string>) =>
    git(
      location,
      [
        "add",
        "--force",
        "--all",
        "--",
        location.scope === "" ? ":(top)" : `:(top,literal)${location.scope}`,
        ...[...context.metadataFolders, ...excludes].map(
          (exclude) => `:(top,literal,exclude)${exclude}`,
        ),
      ],
      { index },
    ).pipe(Effect.asVoid);

  const captureCheckpoint: VcsCheckpointOps["captureCheckpoint"] = Effect.fn(
    "pluginCheckpoints.captureCheckpoint",
  )(function* (input) {
    if (context.strategies.length === 0)
      return yield* unsupported(
        "captureCheckpoint",
        `${runner.label} lists no checkpoint strategy, so turns here have no checkpoint.`,
      );
    const location = yield* locate(input.cwd);
    // A thread keeps the strategy its last checkpoint used, so neighboring checkpoints stay
    // comparable after a fallback. A new thread starts from the manifest's order again.
    const previous =
      input.previousCheckpointRef === undefined
        ? null
        : yield* readRecord(location, input.previousCheckpointRef);
    const order =
      previous === null
        ? context.strategies
        : [
            previous.strategy,
            ...context.strategies.filter((strategy) => strategy !== previous.strategy),
          ].filter((strategy) => context.strategies.includes(strategy));
    const failures: string[] = [];
    for (const strategy of order) {
      const attempt = Effect.gen(function* () {
        const result = yield* capture[strategy](
          location,
          input.cwd,
          input.checkpointRef,
          repositoryExcludes(location, input.excludePaths),
        ).pipe(Effect.result);
        return result._tag === "Success"
          ? { written: yield* writeRecord(location, input.checkpointRef, result.success) }
          : { failure: result.failure };
      });
      // A native snapshot is recorded before a deletion can see its revision unused.
      const result = yield* strategy === "native"
        ? nativeSnapshots.withPermits(1)(attempt)
        : attempt;
      if ("written" in result) return result.written;
      yield* Effect.logWarning("VCS plugin checkpoint strategy failed", {
        plugin: runner.label,
        strategy,
        error: result.failure,
      });
      failures.push(`\`${strategy}\`: ${describeFailure(result.failure)}`);
    }
    return yield* unsupported(
      "captureCheckpoint",
      `No ${runner.label} checkpoint strategy worked. ${failures.join(" ")}`,
    );
  });

  /** A shadow commit's index with the base content of `others` added where it lacks them. */
  const materialize = Effect.fn("pluginCheckpoints.materialize")(function* (
    location: Location,
    cwd: string,
    record: CheckpointRecord,
    others: ReadonlyArray<ChangedFile>,
  ) {
    const own = new Set((record.files ?? []).map((file) => file.path));
    return yield* withIndex(location, (index) =>
      Effect.gen(function* () {
        yield* git(location, ["read-tree", record.revision], { index });
        const entries: string[] = [];
        for (const file of others) {
          // A path the other side added did not exist at the shared base.
          if (own.has(file.path) || file.status === "added") continue;
          const bytes = yield* readBaseFile(location, cwd, record.baseRevision!, file.path);
          // A modified or deleted path existed at the base; an empty side would hide the change.
          if (bytes === null)
            return yield* unsupported(
              "diffCheckpoints",
              `${runner.label} could not read ${file.path} at its base revision.`,
            );
          const mode =
            file.symlink === true ? "120000" : file.executable === true ? "100755" : "100644";
          entries.push(`${mode} ${yield* writeBlob(location, bytes)}\t${file.path}`);
        }
        if (entries.length > 0)
          yield* git(location, ["update-index", "-z", "--index-info"], {
            index,
            stdin: `${entries.join("\0")}\0`,
          });
        return (yield* git(location, ["write-tree"], { index })).trim();
      }),
    );
  });

  const requireRecord = Effect.fn("pluginCheckpoints.requireRecord")(function* (
    location: Location,
    checkpointRef: CheckpointRef,
    operation: string,
  ) {
    const record = yield* readRecord(location, checkpointRef);
    if (record === null)
      return yield* unsupported(operation, "This turn has no checkpoint to compare.");
    return record;
  });

  const diffCheckpoints: VcsCheckpointOps["diffCheckpoints"] = Effect.fn(
    "pluginCheckpoints.diffCheckpoints",
  )(function* (input) {
    if (input.filePaths?.length === 0) return "";
    const location = yield* locate(input.cwd);
    const from = yield* requireRecord(location, input.fromCheckpointRef, "diffCheckpoints");
    const to = yield* requireRecord(location, input.toCheckpointRef, "diffCheckpoints");
    if (from.strategy !== to.strategy)
      return yield* unsupported(
        "diffCheckpoints",
        `The snapshots were taken with different strategies (\`${from.strategy}\`, then \`${to.strategy}\`), so they cannot be compared.`,
      );
    if (from.strategy === "native") {
      // Said in the turn's note: a snapshot the plugin no longer reads is not an empty change.
      const patch = yield* nativeDiff(location, input.cwd, from.revision, to.revision).pipe(
        Effect.catch(() =>
          unsupported("diffCheckpoints", `${runner.label} could not read one of these snapshots.`),
        ),
      );
      const excludes = repositoryExcludes(location, input.excludePaths);
      const kept = excludePatch(
        input.filePaths ? filterPatch(patch, new Set(input.filePaths)) : patch,
        excludes,
      );
      return input.format === "numstat" ? patchToNumstat(kept) : kept;
    }
    let fromTree = from.revision;
    let toTree = to.revision;
    if (from.strategy === "changed-files") {
      if (from.baseRevision !== to.baseRevision)
        return yield* unsupported(
          "diffCheckpoints",
          `The ${runner.label} revision changed between these checkpoints, so they cannot be compared.`,
        );
      fromTree = yield* materialize(location, input.cwd, from, to.files ?? []);
      toTree = yield* materialize(location, input.cwd, to, from.files ?? []);
    }
    return yield* git(
      location,
      [
        "diff-tree",
        "-r",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
        ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
        fromTree,
        toTree,
        ...diffPathspecs(input.filePaths ?? [], repositoryExcludes(location, input.excludePaths)),
      ],
      { maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES, truncate: true },
    ).pipe(
      // Said in the turn's note rather than shown as a turn that changed nothing.
      Effect.catch(() => unsupported("diffCheckpoints", "These snapshots could not be compared.")),
    );
  });

  const checkoutFrom = (location: Location, commit: string, paths: ReadonlyArray<string>) =>
    paths.length === 0
      ? Effect.void
      : withIndex(location, (index) =>
          git(location, ["read-tree", commit], { index }).pipe(
            Effect.andThen(
              git(location, ["checkout-index", "--force", "-z", "--stdin"], {
                index,
                stdin: `${paths.join("\0")}\0`,
              }),
            ),
          ),
        ).pipe(Effect.asVoid);

  // A folder on the way that became a link would take the change outside the checkout.
  const linkedParentProblem = Effect.fnUntraced(function* (location: Location, file: string) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (Option.isSome(yield* fs.readLink(path.join(location.root, parent)).pipe(Effect.option)))
        return `${parent} is now a symbolic link, so ${file} cannot be restored safely.`;
    }
    return undefined;
  });
  const refuseLinkedParent = (location: Location, file: string) =>
    linkedParentProblem(location, file).pipe(
      Effect.flatMap((problem) =>
        problem === undefined
          ? Effect.void
          : Effect.fail(unsupported("restoreCheckpoint", problem)),
      ),
    );

  const removePath = (location: Location, file: string) =>
    refuseLinkedParent(location, file).pipe(
      Effect.andThen(
        fs
          .remove(path.join(location.root, file), { recursive: true, force: true })
          .pipe(Effect.mapError(storageError("pluginCheckpoints.restore", location.root))),
      ),
    );

  /**
   * Repositories inside `folder`, repository-relative, `folder` itself included; null when the
   * folder cannot be read. Their files and history were never saved, so a restore keeps them.
   */
  /**
   * Every entry below `absolute`, `/`-separated, links listed but never followed: a recursive
   * directory read can descend into a linked folder. Null when a folder cannot be read.
   */
  const walk = Effect.fnUntraced(function* (absolute: string, stopAtRepositories = false) {
    const found: Array<{
      readonly path: string;
      readonly kind: "link" | "folder" | "file" | "mount" | "repository";
    }> = [];
    const device = Option.getOrUndefined(
      (yield* fs.stat(absolute).pipe(Effect.option)).pipe(Option.map((info) => info.dev)),
    );
    const pending = [""];
    while (pending.length > 0) {
      const relative = pending.pop()!;
      // A repository's files are its own: never read, however large.
      if (
        stopAtRepositories &&
        (yield* isRepositoryRoot(relative === "" ? absolute : path.join(absolute, relative)))
      ) {
        found.push({ path: relative, kind: "repository" });
        continue;
      }
      const names = yield* fs
        .readDirectory(relative === "" ? absolute : path.join(absolute, relative))
        .pipe(Effect.orElseSucceed(() => null));
      if (names === null) return null;
      for (const name of names) {
        const entry = relative === "" ? name : `${relative}/${name}`;
        const entryPath = path.join(absolute, entry);
        if (Option.isSome(yield* fs.readLink(entryPath).pipe(Effect.option))) {
          found.push({ path: entry, kind: "link" });
          continue;
        }
        const info = yield* fs.stat(entryPath).pipe(Effect.option);
        const folder = Option.isSome(info) && info.value.type === "Directory";
        // Another file system mounted inside is never walked, so never emptied.
        if (folder && device !== undefined && info.value.dev !== device) {
          found.push({ path: entry, kind: "mount" });
          continue;
        }
        found.push({ path: entry, kind: folder ? "folder" : "file" });
        if (folder) pending.push(entry);
      }
    }
    return found;
  });

  const nestedRepositories = Effect.fnUntraced(function* (location: Location, folder: string) {
    const absolute = path.join(location.root, folder);
    if (Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) return [];
    // Reached through a linked parent, the folder is elsewhere: kept whole, never walked.
    if (yield* throughLinkedParent(location, folder)) return [folder];
    const info = yield* fs.stat(absolute).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") return [];
    // A mount, like a repository, holds files no snapshot saved: it is kept as one.
    const rootDevice = yield* fs.stat(location.root).pipe(Effect.option);
    if (Option.isSome(rootDevice) && rootDevice.value.dev !== info.value.dev) return [folder];
    const walked = yield* walk(absolute, true);
    if (walked === null) return null;
    const entries = walked.map((entry) => entry.path);
    // Compared without case: on a case-insensitive disk `.KITE/HEAD` is the plugin's marker too.
    const present = new Set(entries.map((entry) => entry.toLowerCase()));
    const markers = context.repositoryMarkers().map((marker) => marker.toLowerCase());
    const roots = new Set<string>();
    const add = (relative: string) => roots.add(relative === "" ? folder : `${folder}/${relative}`);
    for (const entry of walked)
      if (entry.kind === "mount" || entry.kind === "repository") add(entry.path);
    for (const entry of entries) {
      const parts = entry.split("/");
      const lower = entry.toLowerCase();
      const git = parts.findIndex((part) => part.toLowerCase() === ".git");
      if (git !== -1) add(parts.slice(0, git).join("/"));
      for (const marker of markers) {
        if (lower === marker) add("");
        else if (lower.endsWith(`/${marker}`)) add(entry.slice(0, -marker.length - 1));
      }
      // A bare Git repository: HEAD beside its objects and refs.
      if (parts.at(-1)!.toLowerCase() === "head") {
        const dir = parts.slice(0, -1).join("/");
        const prefix = dir === "" ? "" : `${dir.toLowerCase()}/`;
        if (present.has(`${prefix}objects`) && present.has(`${prefix}refs`)) add(dir);
      }
    }
    // A marker reached through a link, such as a metadata folder that is one, is not walked:
    // the folder holding such a link is probed as the driver would.
    // Any folder of a marker's path can be the link, so each of its leading parts is matched.
    const leads = [".git", ...markers].flatMap((marker) => {
      const parts = marker.split("/");
      return parts
        .slice(0, Math.max(1, parts.length - 1))
        .map((_, index) => parts.slice(0, index + 1).join("/"));
    });
    const probed = new Set([""]);
    for (const entry of walked) {
      if (entry.kind !== "link") continue;
      const lower = entry.path.toLowerCase();
      for (const lead of leads) {
        if (lower === lead) probed.add("");
        else if (lower.endsWith(`/${lead}`)) probed.add(entry.path.slice(0, -lead.length - 1));
      }
    }
    for (const relative of probed) {
      if (yield* isRepositoryRoot(relative === "" ? absolute : path.join(absolute, relative)))
        add(relative);
    }
    return [...roots];
  });

  const isRepositoryRoot = Effect.fnUntraced(function* (absolute: string) {
    for (const marker of [".git", ...context.repositoryMarkers()]) {
      if (yield* fs.exists(path.join(absolute, marker)).pipe(Effect.orElseSucceed(() => false)))
        return true;
    }
    const kind = (name: string) =>
      fs.stat(path.join(absolute, name)).pipe(
        Effect.map((info) => info.type),
        Effect.orElseSucceed(() => null),
      );
    return (
      (yield* kind("HEAD")) === "File" &&
      (yield* kind("objects")) === "Directory" &&
      (yield* kind("refs")) === "Directory"
    );
  });

  /** The repository inside the checkout that holds `file`, if a folder on its way is one. */
  const enclosingRepository = Effect.fnUntraced(function* (
    location: Location,
    file: string,
    known: Map<string, boolean>,
  ) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++) {
      const folder = parts.slice(0, index).join("/");
      let found = known.get(folder);
      if (found === undefined) {
        found = yield* isRepositoryRoot(path.join(location.root, folder));
        known.set(folder, found);
      }
      if (found) return folder;
    }
    return undefined;
  });

  /** The folder on the way to `file` that another file system is mounted on, if any. */
  const enclosingMount = Effect.fnUntraced(function* (
    location: Location,
    file: string,
    devices: Map<string, bigint | null>,
  ) {
    const device = (folder: string) =>
      fs.stat(path.join(location.root, folder)).pipe(
        Effect.map((info): bigint | null => info.dev),
        Effect.orElseSucceed(() => null),
      );
    if (!devices.has("")) devices.set("", yield* device(""));
    const root = devices.get("")!;
    if (root === null) return undefined;
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++) {
      const folder = parts.slice(0, index).join("/");
      if (!devices.has(folder)) devices.set(folder, yield* device(folder));
      const found = devices.get(folder);
      if (found !== null && found !== root) return folder;
    }
    return undefined;
  });

  // Checked before anything changes. Writing a file where a folder now is removes the folder,
  // with all it holds.
  const restoreProblem = Effect.fnUntraced(function* (
    location: Location,
    change: {
      readonly write: ReadonlyArray<string>;
      readonly remove: ReadonlyArray<string>;
      /** Repositories of their own now where the checkpoint has a file. */
      readonly replaced?: ReadonlyArray<string>;
    },
    excludes: ReadonlyArray<string>,
  ) {
    const replaced = change.replaced?.[0];
    if (replaced !== undefined)
      return `${replaced} is now a repository of its own, so the checkpoint's file there cannot be restored.`;
    const known = new Map<string, boolean>();
    const devices = new Map<string, bigint | null>();
    for (const file of [...change.write, ...change.remove]) {
      const problem = yield* linkedParentProblem(location, file);
      if (problem !== undefined) return problem;
      const mount = yield* enclosingMount(location, file, devices);
      if (mount !== undefined)
        return `${mount} is another file system mounted in the checkout, so ${file} cannot be restored inside it.`;
      const repository = yield* enclosingRepository(location, file, known);
      if (repository !== undefined)
        return `${repository} is now a repository of its own, so ${file} cannot be restored inside it.`;
    }
    for (const file of change.write) {
      if (excludes.some((exclude) => exclude.startsWith(`${file}/`)))
        return `${file} is now a folder holding a nested folder with its own checkpoints, so its file cannot be restored.`;
      const nested = yield* nestedRepositories(location, file);
      if (nested === null)
        return `${file} is now a folder that cannot be read, so its file cannot be restored.`;
      if (nested.length > 0)
        return `${file} is now a folder holding a repository or a mount of its own, so its file cannot be restored.`;
    }
    return undefined;
  });

  // Removes `file`, but never a nested scope's files or a repository below it.
  const removeKeeping = Effect.fnUntraced(function* (
    location: Location,
    file: string,
    excludes: ReadonlyArray<string>,
  ) {
    const nested = yield* nestedRepositories(location, file);
    if (nested === null || nested.includes(file)) return;
    const kept = [...excludes, ...nested];
    if (!kept.some((exclude) => exclude.startsWith(`${file}/`)))
      return yield* removePath(location, file);
    for (const entry of yield* listFiles(location, file)) {
      if (inScope(entry, "", kept)) yield* removePath(location, entry);
    }
  });

  /** What a `full` restore changes: paths to remove, and paths to check out from the target. */
  const fullPlan = Effect.fn("pluginCheckpoints.fullPlan")(function* (
    location: Location,
    target: CheckpointRecord,
    excludes: ReadonlyArray<string>,
  ) {
    const current = yield* withIndex(location, (index) =>
      stageFull(location, index, excludes).pipe(Effect.andThen(commitIndex(location, index))),
    );
    const changes = yield* git(location, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      current,
      target.revision,
    ]);
    const parts = changes.split("\0").filter((part) => part.length > 0);
    const remove: string[] = [];
    const write: string[] = [];
    const replaced: string[] = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      // ":<old mode> <new mode> <old id> <new id> <status>", then the path.
      const [oldMode, newMode, , , status] = parts[index]!.slice(1).split(" ");
      const file = parts[index + 1]!;
      // A nested scope's files stay its own, even where the older snapshot still has them.
      if (!inScope(file, location.scope, excludes)) continue;
      // A repository inside is staged as its commit alone; its files and history were never
      // saved, so it is never removed or replaced.
      if (oldMode === GITLINK_MODE && newMode !== GITLINK_MODE && status !== "D")
        replaced.push(file);
      if (oldMode === GITLINK_MODE || newMode === GITLINK_MODE) continue;
      if (status === "D") remove.push(file);
      else write.push(file);
    }
    return { remove, write, replaced };
  });

  /** What a `changed-files` restore changes, or why it cannot. */
  const changedFilesPlan = Effect.fn("pluginCheckpoints.changedFilesPlan")(function* (
    location: Location,
    cwd: string,
    target: CheckpointRecord,
    excludes: ReadonlyArray<string>,
  ) {
    const current = yield* changedFiles(location, cwd, excludes);
    if (current.revision !== target.baseRevision)
      return {
        problem: `The ${runner.label} revision changed since this checkpoint, so its files cannot be restored.`,
      } as const;
    const kept = (file: string) => inScope(file, location.scope, excludes);
    const overlay = (yield* listTreeFiles(location, target.revision)).filter(kept);
    const targetFiles = (target.files ?? []).filter((file) => kept(file.path));
    const targetPaths = new Set(targetFiles.map((file) => file.path));
    // Paths the checkpoint left at their base state that changed since.
    const reverted = current.files.filter((file) => !targetPaths.has(file.path));
    const baseFiles = reverted.filter((file) => file.status !== "added");
    // A deleted file whose path is now a folder: only files the VCS reports may go with it.
    const reported = (file: string) =>
      current.files.some(
        (changed) =>
          changed.status !== "deleted" &&
          (file === changed.path || file.startsWith(`${changed.path}/`)),
      );
    // Removing a deleted file's path, or writing a file there, takes the folder now there with
    // it: only files the VCS reports may go, since no snapshot saved the others.
    const overwritten = [
      ...targetFiles.filter((file) => file.status === "deleted").map((file) => file.path),
      ...baseFiles.map((file) => file.path),
      ...overlay,
    ];
    for (const file of overwritten) {
      for (const inside of yield* listFiles(location, file)) {
        if (inside !== file && !reported(inside) && kept(inside))
          return {
            problem: `${file} is now a folder holding files ${runner.label} does not report, so it cannot be restored.`,
          } as const;
      }
    }
    const problem = yield* restoreProblem(
      location,
      {
        write: [...baseFiles.map((file) => file.path), ...overlay],
        remove: [
          ...targetFiles.filter((file) => file.status === "deleted"),
          ...reverted.filter((file) => file.status === "added"),
        ].map((file) => file.path),
      },
      excludes,
    );
    return { problem, current, overlay, targetFiles, targetPaths, reverted, baseFiles } as const;
  });

  const restoreCheckpoint: VcsCheckpointOps["restoreCheckpoint"] = Effect.fn(
    "pluginCheckpoints.restoreCheckpoint",
  )(function* (input) {
    const location = yield* locate(input.cwd);
    const target = yield* readRecord(location, input.checkpointRef);
    if (target === null) return false;
    const excludes = repositoryExcludes(location, input.excludePaths);
    if (target.strategy === "native") {
      // The plugin restores the whole folder, nested scopes included.
      if (excludes.length > 0)
        return yield* unsupported(
          "restoreCheckpoint",
          "A native snapshot cannot be restored around a nested folder with its own checkpoints.",
        );
      if (location.scope !== "")
        return yield* unsupported(
          "restoreCheckpoint",
          "A native snapshot covers the whole repository, not only the project's folder.",
        );
      yield* runner.run("checkpointRestore", {
        cwd: input.cwd,
        values: { repositoryRoot: location.root, revision: target.revision },
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      });
      return true;
    }
    if (target.strategy === "full") {
      const plan = yield* fullPlan(location, target, excludes);
      const problem = yield* restoreProblem(location, plan, excludes);
      if (problem !== undefined) return yield* unsupported("restoreCheckpoint", problem);
      for (const file of plan.remove) yield* removePath(location, file);
      yield* checkoutFrom(location, target.revision, plan.write);
      return true;
    }
    const plan = yield* changedFilesPlan(location, input.cwd, target, excludes);
    if (plan.problem !== undefined) return yield* unsupported("restoreCheckpoint", plan.problem);
    // Every base file reads back before anything is changed.
    const baseBytes = new Map<string, Uint8Array>();
    for (const file of plan.baseFiles) {
      const bytes = yield* readBaseFile(location, input.cwd, target.baseRevision!, file.path);
      // A modified or deleted path existed at its base, so no answer is a failed read.
      if (bytes === null)
        return yield* unsupported(
          "restoreCheckpoint",
          `${runner.label} could not read ${file.path} at its base revision.`,
        );
      baseBytes.set(file.path, bytes);
    }
    const overlaySet = new Set(plan.overlay);
    for (const file of plan.targetFiles) {
      if (file.status === "deleted") yield* removeKeeping(location, file.path, excludes);
    }
    for (const file of plan.current.files) {
      // A folder the checkpoint added may have gained files since.
      if (plan.targetPaths.has(file.path) && file.status === "added") {
        const nested = (yield* nestedRepositories(location, file.path)) ?? [file.path];
        for (const extra of yield* listFiles(location, file.path)) {
          if (!overlaySet.has(extra) && inScope(extra, location.scope, [...excludes, ...nested]))
            yield* removePath(location, extra);
        }
      }
    }
    for (const file of plan.reverted) {
      if (file.status === "added") yield* removeKeeping(location, file.path, excludes);
    }
    for (const file of plan.baseFiles) {
      const destination = path.join(location.root, file.path);
      const bytes = baseBytes.get(file.path)!;
      // Replaced, not written through: the path may now be a link to another file. A regular
      // file keeps its mode, such as the executable bit.
      const previous = yield* fs.stat(destination).pipe(Effect.option);
      const isLink = Option.isSome(yield* fs.readLink(destination).pipe(Effect.option));
      yield* removePath(location, file.path);
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
        Effect.andThen(
          file.symlink === true
            ? fs.symlink(new TextDecoder().decode(bytes), destination)
            : fs.writeFile(destination, bytes).pipe(
                Effect.andThen(fs.stat(destination)),
                Effect.flatMap((info) => {
                  // The mode the VCS recorded wins; without one, the file keeps the mode it had.
                  const kept =
                    Option.isSome(previous) && !isLink && previous.value.type === "File"
                      ? previous.value.mode
                      : info.mode;
                  const mode =
                    file.executable === true
                      ? kept | 0o111
                      : file.executable === false
                        ? kept & ~0o111
                        : kept;
                  return mode === info.mode ? Effect.void : fs.chmod(destination, mode);
                }),
              ),
        ),
        Effect.mapError(storageError("pluginCheckpoints.restore", location.root)),
      );
    }
    yield* checkoutFrom(location, target.revision, plan.overlay);
    return true;
  });

  /** Whether a folder of `entry`'s path below the root, not `entry` itself, is a link. */
  const throughLinkedParent = Effect.fnUntraced(function* (location: Location, entry: string) {
    const parts = entry.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = path.join(location.root, ...parts.slice(0, index));
      if (Option.isSome(yield* fs.readLink(parent).pipe(Effect.option))) return true;
    }
    return false;
  });

  /** Files below `folder` (repository-relative), or the folder itself when it is a file. */
  const listFiles = Effect.fn("pluginCheckpoints.listFiles")(function* (
    location: Location,
    folder: string,
  ) {
    const absolute = path.join(location.root, folder);
    // A link to a folder is the entry itself, never the folder it leads to.
    if (Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) return [folder];
    const info = yield* fs.stat(absolute).pipe(Effect.orElseSucceed(() => null));
    if (info === null) return [];
    if (info.type !== "Directory") return [folder];
    // A mount is never listed through; restores refuse or keep it, as a nested repository.
    const root = yield* fs.stat(location.root).pipe(Effect.orElseSucceed(() => null));
    if (root !== null && root.dev !== info.dev) return [];
    // Nor a folder reached through a linked parent, which a restore refuses: it is elsewhere.
    if (yield* throughLinkedParent(location, folder)) return [];
    // A link is removed itself; its target, maybe outside the checkout, is never visited. A
    // repository inside is never read: its files are its own.
    return ((yield* walk(absolute, true)) ?? [])
      .filter((entry) => entry.kind === "file" || entry.kind === "link")
      .map((entry) => `${folder}/${entry.path}`);
  });

  const hasCheckpointRef: VcsCheckpointOps["hasCheckpointRef"] = Effect.fn(
    "pluginCheckpoints.hasCheckpointRef",
  )(function* (input) {
    const location = yield* locate(input.cwd);
    return (yield* readRecord(location, input.checkpointRef)) !== null;
  });

  // What a restore would need, checked before a rollback rewinds the provider's conversation.
  const verifyRestorable: NonNullable<VcsCheckpointOps["verifyRestorable"]> = Effect.fn(
    "pluginCheckpoints.verifyRestorable",
  )(function* (input) {
    const location = yield* locate(input.cwd);
    const record = yield* readRecord(location, input.checkpointRef);
    if (record === null) return false;
    const excludes = repositoryExcludes(location, input.excludePaths);
    // A plugin's snapshot can be gone with its worktree; only one it still reads counts. The
    // restore refuses nested scopes and a project below the root, so this does too.
    if (record.strategy === "native")
      return excludes.length > 0 || location.scope !== ""
        ? false
        : yield* nativeDiff(location, input.cwd, record.revision, record.revision).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
    // Every object the snapshot needs, not only its commit. Quiet: a large tree lists far more
    // than any output limit.
    const stored = yield* git(location, [
      "rev-list",
      "--objects",
      "--missing=error",
      "--quiet",
      record.revision,
    ]).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!stored) return false;
    // The same refusals as the restore, before the conversation is rewound.
    if (record.strategy === "full") {
      const plan = yield* fullPlan(location, record, excludes).pipe(Effect.option);
      if (Option.isNone(plan)) return false;
      return (yield* restoreProblem(location, plan.value, excludes)) === undefined;
    }
    // Changed-files files restore only onto the base revision they were taken from, and the
    // paths left at their base must still read back from the plugin.
    const plan = yield* changedFilesPlan(location, input.cwd, record, excludes).pipe(Effect.option);
    if (Option.isNone(plan) || plan.value.problem !== undefined) return false;
    for (const file of plan.value.baseFiles) {
      const bytes = yield* readBaseFile(location, input.cwd, record.baseRevision!, file.path).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (bytes === null) return false;
    }
    return true;
  });

  const deleteCheckpointRefs: VcsCheckpointOps["deleteCheckpointRefs"] = Effect.fn(
    "pluginCheckpoints.deleteCheckpointRefs",
  )(function* (input) {
    // A checkout removed since keeps its records under the root it had, which cleanup passes.
    const gone = !(yield* fs.exists(input.cwd).pipe(Effect.orElseSucceed(() => true)));
    const location: Location = gone
      ? { root: input.cwd, scope: "", shadow: shadowOf(input.cwd) }
      : yield* locate(input.cwd);
    for (const checkpointRef of input.checkpointRefs) {
      const record = yield* readRecord(location, checkpointRef);
      if (record === null) continue;
      const forget = sql`
        DELETE FROM atelier_vcs_plugin_checkpoint_records
        WHERE repository_root = ${location.root} AND checkpoint_ref = ${checkpointRef}
          AND plugin_id = ${kind}
      `.pipe(
        Effect.mapError(storageError("pluginCheckpoints.deleteCheckpointRefs", location.root)),
      );
      if (record.strategy !== "native") {
        yield* git(
          location,
          ["update-ref", "-d", checkpointRef],
          gone ? { cwd: shadowRoot } : {},
        ).pipe(Effect.ignore);
        yield* forget;
        continue;
      }
      yield* nativeSnapshots.withPermits(1)(
        Effect.gen(function* () {
          // Identical content can come back as the same snapshot for another checkpoint, in this
          // checkout or another one sharing its store; the plugin cannot run in a folder that is
          // gone.
          const shared = yield* sql`
            SELECT 1 FROM atelier_vcs_plugin_checkpoint_records
            WHERE plugin_id = ${kind} AND strategy = 'native' AND revision = ${record.revision}
              AND NOT (repository_root = ${location.root} AND checkpoint_ref = ${checkpointRef})
            LIMIT 1
          `.pipe(
            Effect.mapError(storageError("pluginCheckpoints.deleteCheckpointRefs", location.root)),
          );
          // A failed deletion leaves the snapshot to the plugin: a record kept for a retry would
          // read as a checkpoint still there, such as an earlier rewind's.
          if (shared.length === 0 && !gone && runner.has("checkpointDelete"))
            yield* runner
              .run("checkpointDelete", {
                cwd: input.cwd,
                values: { repositoryRoot: location.root, revision: record.revision },
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("VCS plugin snapshot deletion failed", { error }),
                ),
              );
          yield* forget;
        }),
      );
    }
  });
  return {
    captureCheckpoint,
    // A plugin folder is never read as clean, so each turn captures with its strategies.
    resolveCleanHead: () => Effect.succeed(null),
    captureHeadCheckpoint: () =>
      Effect.fail(unsupported("captureHeadCheckpoint", "Plugins capture every checkpoint.")),
    hasCheckpointRef,
    restoreCheckpoint,
    verifyRestorable,
    diffCheckpoints,
    // Every changed path belongs to the turn.
    listAuthoredPaths: () => Effect.succeed(null),
    deleteCheckpointRefs,
  } satisfies VcsCheckpointOps;
});

/** Git's C-style quoting of a path with unusual bytes: `"a/caf\303\251.txt"`. */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const chars = [...quoted];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(chars.slice(index + 1, index + 4).join(""));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else {
      const next = chars[index + 1] ?? "";
      if (escapes[next] !== undefined) bytes.push(escapes[next]);
      else bytes.push(...Buffer.from(next, "utf8"));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const GITLINK_MODE = "160000";

// Lines are split on "\n" alone, and matched whole: a name can hold U+2028 or U+2029, which `.`
// and multiline anchors treat as line breaks.
const DIFF_HEADER =
  /^diff --git (?:"a\/((?:[^"\\]|\\[\s\S])*)"|a\/([\s\S]+?)) (?:"b\/((?:[^"\\]|\\[\s\S])*)"|b\/([\s\S]+?))$/;

/** The lines of a section before its first hunk. */
function headerLines(section: string): ReadonlyArray<string> {
  const hunk = section.indexOf("\n@@");
  return (hunk === -1 ? section : section.slice(0, hunk)).split("\n");
}

/** A `--- a/x` or `+++ b/x` line's path, quoted or not; null for `/dev/null` or none. */
function patchLinePath(
  lines: ReadonlyArray<string>,
  marker: "---" | "+++",
): string | null | undefined {
  const side = marker === "---" ? "a" : "b";
  const line = lines.find((entry) => entry.startsWith(`${marker} `))?.slice(4);
  if (line === undefined || line === "") return undefined;
  if (line === "/dev/null") return null;
  if (line.startsWith(`"${side}/`) && line.endsWith('"')) return unquoteGitPath(line.slice(3, -1));
  return line.startsWith(`${side}/`) ? line.slice(2).replace(/\t$/, "") : undefined;
}

/** The old and new paths of a patch section, quoted or not. */
function diffHeaderPaths(section: string): readonly [string, string] | null {
  const lines = headerLines(section);
  // The `---` and `+++` lines name each path whole; the header splits ambiguously on " b/".
  const from = patchLinePath(lines, "---");
  const to = patchLinePath(lines, "+++");
  if (from !== undefined && to !== undefined && (from !== null || to !== null))
    return [from ?? to!, to ?? from!];
  // A pure rename or copy has no `---`/`+++` lines; its extended header names both paths whole.
  const moved = lines.findIndex((line) => /^(?:rename|copy) from [\s\S]/.test(line));
  const movedTo =
    moved === -1 ? undefined : /^(?:rename|copy) to ([\s\S]+)$/.exec(lines[moved + 1] ?? "");
  if (moved !== -1 && movedTo) {
    const unquote = (name: string) =>
      name.startsWith('"') && name.endsWith('"') ? unquoteGitPath(name.slice(1, -1)) : name;
    return [unquote(lines[moved]!.replace(/^(?:rename|copy) from /, "")), unquote(movedTo[1]!)];
  }
  const first = lines.find((line) => line.startsWith("diff --git ")) ?? "";
  // Without them, as Git reads it: one path named twice.
  const same = /^diff --git a\/([\s\S]+) b\/([\s\S]+)$/.exec(first);
  if (same !== null) {
    const rest = `${same[1]} b/${same[2]}`;
    const half = (rest.length - 3) / 2;
    if (Number.isInteger(half) && rest.slice(half, half + 3) === " b/") {
      const path = rest.slice(0, half);
      if (rest.slice(half + 3) === path) return [path, path];
    }
  }
  const header = DIFF_HEADER.exec(first);
  if (header === null) {
    // Without prefixes (`diff.noprefix`), as Git reads it: one path named twice.
    const rest = /^diff --git ([\s\S]+)$/.exec(first)?.[1];
    if (rest === undefined || rest.length % 2 === 0) return null;
    const half = (rest.length - 1) / 2;
    const from = rest.slice(0, half);
    return rest[half] === " " && rest.slice(half + 1) === from ? [from, from] : null;
  }
  const headerFrom = header[1] !== undefined ? unquoteGitPath(header[1]) : header[2]!;
  const headerTo = header[3] !== undefined ? unquoteGitPath(header[3]) : header[4]!;
  return [headerFrom, headerTo];
}

/** Git pathspecs for a diff limited to `files` and leaving out `excludes`, all literal. */
function diffPathspecs(files: ReadonlyArray<string>, excludes: ReadonlyArray<string>) {
  if (files.length === 0 && excludes.length === 0) return [];
  return [
    "--",
    ...(files.length === 0 ? [":(top)"] : files.map((file) => `:(top,literal)${file}`)),
    ...excludes.map((exclude) => `:(top,literal,exclude)${exclude}`),
  ];
}

/** Drops the sections of a Git patch inside an excluded folder. */
function excludePatch(patch: string, excludes: ReadonlyArray<string>): string {
  if (excludes.length === 0) return patch;
  return patch
    .split(/(?<![^\n])(?=diff --git )/)
    .filter((section) => {
      const header = diffHeaderPaths(section);
      return header === null || header.some((file) => inScope(file, "", excludes));
    })
    .join("");
}

/** Keeps the sections of a Git patch whose old or new path is in `paths`. */
export function filterPatch(patch: string, paths: ReadonlySet<string>): string {
  const sections = patch.split(/(?<![^\n])(?=diff --git )/);
  return sections
    .filter((section) => {
      const header = diffHeaderPaths(section);
      return header !== null && (paths.has(header[0]) || paths.has(header[1]));
    })
    .join("");
}

/** `git diff --numstat -z` records for a Git patch, for plugins that only print patches. */
export function patchToNumstat(patch: string): string {
  const records: string[] = [];
  for (const section of patch.split(/(?<![^\n])(?=diff --git )/)) {
    const header = diffHeaderPaths(section);
    if (header === null) continue;
    const binary = section
      .split("\n")
      .some((line) => line === "GIT binary patch" || /^Binary files [\s\S]* differ$/.test(line));
    let added = 0;
    let deleted = 0;
    // Header lines come before the first hunk; inside one, "+++i;" is an added "++i;".
    let inHunk = false;
    for (const line of section.split("\n")) {
      if (line.startsWith("@@")) inHunk = true;
      else if (!inHunk) continue;
      else if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) deleted++;
    }
    const counts = binary ? "-\t-" : `${added}\t${deleted}`;
    const [from, to] = header;
    records.push(from === to ? `${counts}\t${to}` : `${counts}\t\0${from}\0${to}`);
  }
  return records.length === 0 ? "" : `${records.join("\0")}\0`;
}
