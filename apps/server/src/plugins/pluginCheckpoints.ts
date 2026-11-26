// @effect-diagnostics nodeBuiltinImport:off -- Synchronous digests and random temp file names.
import * as NodeCrypto from "node:crypto";

import {
  VcsCheckpointStorageError,
  VcsPluginCheckpointCaptureOutput,
  VcsPluginChangedFilesOutput,
  VcsPluginCheckpointDiffOutput,
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
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES, type VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { PluginCommandRunner } from "./pluginCommandRunner.ts";

const CHECKPOINT_TIMEOUT_MS = 120_000;
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
    CREATE TABLE IF NOT EXISTS atelier_vcs_plugin_checkpoints (
      repository_root TEXT NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      revision TEXT NOT NULL,
      base_revision TEXT,
      files_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (repository_root, checkpoint_ref)
    )
  `;
});

interface ChangedFile {
  readonly path: string;
  readonly status: VcsPluginChangedFileStatus;
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
  readonly repositoryRoot: (cwd: string) => Effect.Effect<string, VcsError>;
}

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
  const locate = Effect.fn("pluginCheckpoints.locate")(function* (cwd: string) {
    const root = yield* context.repositoryRoot(cwd);
    const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
    const realCwd = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const scope = path.relative(realRoot, realCwd).split(path.sep).join("/");
    const key = NodeCrypto.createHash("sha256").update(realRoot).digest("hex").slice(0, 24);
    return { root: realRoot, scope, shadow: path.join(shadowRoot, `${key}.git`) } as Location;
  });

  // Plain Git against a bare repository under T3 home, with the plugin's repository as work tree.
  const git = Effect.fn("pluginCheckpoints.git")(function* (
    location: Location,
    args: ReadonlyArray<string>,
    options?: {
      readonly index?: string;
      readonly stdin?: string;
      readonly literal?: boolean;
      readonly maxOutputBytes?: number;
      readonly truncate?: boolean;
    },
  ) {
    const result = yield* vcsProcess.run({
      operation: "pluginCheckpoints.git",
      command: "git",
      cwd: location.root,
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
        ...args,
      ],
      env: {
        GIT_AUTHOR_NAME: "T3 Code",
        GIT_AUTHOR_EMAIL: "checkpoints@t3.invalid",
        GIT_COMMITTER_NAME: "T3 Code",
        GIT_COMMITTER_EMAIL: "checkpoints@t3.invalid",
        ...(options?.index ? { GIT_INDEX_FILE: options.index } : {}),
        ...(options?.literal ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
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

  const stagePaths = (location: Location, index: string, paths: ReadonlyArray<string>) =>
    paths.length === 0
      ? Effect.void
      : git(
          location,
          ["add", "--force", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
          { index, literal: true, stdin: `${paths.join("\0")}\0` },
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
    return {
      revision: output.revision,
      files: output.files.filter((file) => inScope(file.path, location.scope, excludes)),
    };
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
      FROM atelier_vcs_plugin_checkpoints
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
      INSERT OR REPLACE INTO atelier_vcs_plugin_checkpoints
        (repository_root, checkpoint_ref, plugin_id, strategy, revision, base_revision,
         files_json, created_at)
      VALUES (${location.root}, ${checkpointRef}, ${kind}, ${record.strategy}, ${record.revision},
        ${record.baseRevision}, ${filesJson}, ${createdAt})
    `.pipe(Effect.mapError(failed));
  });

  const nativeDiff = (location: Location, cwd: string, from: string, to: string) =>
    runner.runJson("checkpointDiff", VcsPluginCheckpointDiffOutput, {
      cwd,
      values: { repositoryRoot: location.root, fromRevision: from, toRevision: to },
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
      maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
    });

  const capture = {
    native: Effect.fn("pluginCheckpoints.captureNative")(function* (
      location: Location,
      cwd: string,
      checkpointRef: CheckpointRef,
    ) {
      const { revision } = yield* runner.runJson(
        "checkpointCapture",
        VcsPluginCheckpointCaptureOutput,
        {
          cwd,
          values: { repositoryRoot: location.root, checkpointRef },
          timeoutMs: CHECKPOINT_TIMEOUT_MS,
        },
      );
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
      for (const file of changes.files) {
        const absolute = path.join(location.root, file.path);
        // A symbolic link counts even when its target is gone.
        const present =
          file.status !== "deleted" &&
          ((yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false))) ||
            Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option)));
        files.push(present || file.status === "deleted" ? file : { ...file, status: "deleted" });
      }
      yield* ensureShadow(location);
      const commit = yield* withIndex(location, (index) =>
        stagePaths(
          location,
          index,
          files.filter((file) => file.status !== "deleted").map((file) => file.path),
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
        ...[...context.metadataFolders, ...excludes].map((exclude) => `:(top,exclude)${exclude}`),
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
      const result = yield* capture[strategy](
        location,
        input.cwd,
        input.checkpointRef,
        input.excludePaths ?? [],
      ).pipe(Effect.result);
      if (result._tag === "Success") {
        return yield* writeRecord(location, input.checkpointRef, result.success);
      }
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
          if (bytes === null) continue;
          entries.push(`100644 ${yield* writeBlob(location, bytes)}\t${file.path}`);
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
      const { patch } = yield* nativeDiff(location, input.cwd, from.revision, to.revision);
      const filtered = input.filePaths ? filterPatch(patch, new Set(input.filePaths)) : patch;
      return input.format === "numstat" ? patchToNumstat(filtered) : filtered;
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
        ...(input.filePaths
          ? ["--", ...input.filePaths.map((file) => `:(top,literal)${file}`)]
          : []),
      ],
      { maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES, truncate: true },
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

  const removePath = (location: Location, file: string) =>
    fs
      .remove(path.join(location.root, file), { recursive: true, force: true })
      .pipe(Effect.mapError(storageError("pluginCheckpoints.restore", location.root)));

  const restoreCheckpoint: VcsCheckpointOps["restoreCheckpoint"] = Effect.fn(
    "pluginCheckpoints.restoreCheckpoint",
  )(function* (input) {
    const location = yield* locate(input.cwd);
    const target = yield* readRecord(location, input.checkpointRef);
    if (target === null) return false;
    const excludes = input.excludePaths ?? [];
    if (target.strategy === "native") {
      yield* runner.run("checkpointRestore", {
        cwd: input.cwd,
        values: { repositoryRoot: location.root, revision: target.revision },
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      });
      return true;
    }
    if (target.strategy === "full") {
      const current = yield* withIndex(location, (index) =>
        stageFull(location, index, excludes).pipe(Effect.andThen(commitIndex(location, index))),
      );
      const changes = yield* git(location, [
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--name-status",
        current,
        target.revision,
      ]);
      const parts = changes.split("\0").filter((part) => part.length > 0);
      const write: string[] = [];
      for (let index = 0; index + 1 < parts.length; index += 2) {
        const file = parts[index + 1]!;
        // A nested scope's files stay its own, even where the older snapshot still has them.
        if (!inScope(file, location.scope, excludes)) continue;
        if (parts[index] === "D") yield* removePath(location, file);
        else write.push(file);
      }
      yield* checkoutFrom(location, target.revision, write);
      return true;
    }
    const current = yield* changedFiles(location, input.cwd, excludes);
    if (current.revision !== target.baseRevision)
      return yield* unsupported(
        "restoreCheckpoint",
        `The ${runner.label} revision changed since this checkpoint, so its files cannot be restored.`,
      );
    const kept = (file: string) => inScope(file, location.scope, excludes);
    const overlay = (yield* listTreeFiles(location, target.revision)).filter(kept);
    const overlaySet = new Set(overlay);
    const targetFiles = (target.files ?? []).filter((file) => kept(file.path));
    const targetPaths = new Set(targetFiles.map((file) => file.path));
    for (const file of targetFiles) {
      if (file.status === "deleted") yield* removePath(location, file.path);
    }
    for (const file of current.files) {
      if (targetPaths.has(file.path)) {
        // A folder the checkpoint added may have gained files since.
        if (file.status === "added") {
          for (const extra of yield* listFiles(location, file.path)) {
            if (!overlaySet.has(extra)) yield* removePath(location, extra);
          }
        }
        continue;
      }
      // The checkpoint left this path at its base state.
      if (file.status === "added") {
        yield* removePath(location, file.path);
        continue;
      }
      const bytes = yield* readBaseFile(location, input.cwd, target.baseRevision!, file.path);
      // A modified or deleted path existed at its base, so no answer is a failed read.
      if (bytes === null)
        return yield* unsupported(
          "restoreCheckpoint",
          `${runner.label} could not read ${file.path} at its base revision.`,
        );
      const destination = path.join(location.root, file.path);
      // Replaced, not written through: the path may now be a link to another file. A regular
      // file keeps its mode, such as the executable bit.
      const previous = yield* fs.stat(destination).pipe(Effect.option);
      const isLink = Option.isSome(yield* fs.readLink(destination).pipe(Effect.option));
      yield* removePath(location, file.path);
      yield* fs
        .makeDirectory(path.dirname(destination), { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFile(destination, bytes)),
          Effect.andThen(
            Option.isSome(previous) && !isLink && previous.value.type === "File"
              ? fs.chmod(destination, previous.value.mode)
              : Effect.void,
          ),
          Effect.mapError(storageError("pluginCheckpoints.restore", location.root)),
        );
    }
    yield* checkoutFrom(location, target.revision, overlay);
    return true;
  });

  /** Files below `folder` (repository-relative), or the folder itself when it is a file. */
  const listFiles = Effect.fn("pluginCheckpoints.listFiles")(function* (
    location: Location,
    folder: string,
  ) {
    const absolute = path.join(location.root, folder);
    const info = yield* fs.stat(absolute).pipe(Effect.orElseSucceed(() => null));
    if (info === null) return [];
    if (info.type !== "Directory") return [folder];
    const entries = yield* fs
      .readDirectory(absolute, { recursive: true })
      .pipe(Effect.orElseSucceed((): string[] => []));
    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(absolute, entry);
      // A link is removed itself; its target, maybe outside the checkout, is never visited.
      const isLink = Option.isSome(yield* fs.readLink(entryPath).pipe(Effect.option));
      const stat = isLink ? null : yield* fs.stat(entryPath).pipe(Effect.orElseSucceed(() => null));
      if (isLink || stat?.type === "File")
        files.push(`${folder}/${entry.split(path.sep).join("/")}`);
    }
    return files;
  });

  const hasCheckpointRef: VcsCheckpointOps["hasCheckpointRef"] = Effect.fn(
    "pluginCheckpoints.hasCheckpointRef",
  )(function* (input) {
    const location = yield* locate(input.cwd);
    const record = yield* readRecord(location, input.checkpointRef);
    if (record === null) return false;
    if (record.strategy !== "native") return true;
    // A plugin's snapshot can be gone with its worktree; only one it still reads counts.
    return yield* nativeDiff(location, input.cwd, record.revision, record.revision).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });

  const deleteCheckpointRefs: VcsCheckpointOps["deleteCheckpointRefs"] = Effect.fn(
    "pluginCheckpoints.deleteCheckpointRefs",
  )(function* (input) {
    const location = yield* locate(input.cwd);
    for (const checkpointRef of input.checkpointRefs) {
      const record = yield* readRecord(location, checkpointRef);
      if (record === null) continue;
      if (record.strategy === "native") {
        if (runner.has("checkpointDelete"))
          yield* runner
            .run("checkpointDelete", {
              cwd: input.cwd,
              values: { repositoryRoot: location.root, revision: record.revision },
            })
            .pipe(Effect.ignore);
      } else {
        yield* git(location, ["update-ref", "-d", checkpointRef]).pipe(Effect.ignore);
      }
      yield* sql`
        DELETE FROM atelier_vcs_plugin_checkpoints
        WHERE repository_root = ${location.root} AND checkpoint_ref = ${checkpointRef}
      `.pipe(
        Effect.mapError(storageError("pluginCheckpoints.deleteCheckpointRefs", location.root)),
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
  for (let index = 0; index < quoted.length; index++) {
    const char = quoted[index]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = quoted[index + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(quoted.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const DIFF_HEADER =
  /^diff --git (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.+?)) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+?))$/m;

/** The old and new paths of a patch section, quoted or not. */
function diffHeaderPaths(section: string): readonly [string, string] | null {
  const header = DIFF_HEADER.exec(section);
  if (header === null) return null;
  const from = header[1] !== undefined ? unquoteGitPath(header[1]) : header[2]!;
  const to = header[3] !== undefined ? unquoteGitPath(header[3]) : header[4]!;
  return [from, to];
}

/** Keeps the sections of a Git patch whose old or new path is in `paths`. */
function filterPatch(patch: string, paths: ReadonlySet<string>): string {
  const sections = patch.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      const header = diffHeaderPaths(section);
      return header !== null && (paths.has(header[0]) || paths.has(header[1]));
    })
    .join("");
}

/** `git diff --numstat -z` records for a Git patch, for plugins that only print patches. */
function patchToNumstat(patch: string): string {
  const records: string[] = [];
  for (const section of patch.split(/(?=^diff --git )/m)) {
    const header = diffHeaderPaths(section);
    if (header === null) continue;
    const binary = /^Binary files .* differ$/m.test(section) || /^GIT binary patch$/m.test(section);
    let added = 0;
    let deleted = 0;
    for (const line of section.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) deleted++;
    }
    const counts = binary ? "-\t-" : `${added}\t${deleted}`;
    const [from, to] = header;
    records.push(from === to ? `${counts}\t${to}` : `${counts}\t\0${from}\0${to}`);
  }
  return records.length === 0 ? "" : `${records.join("\0")}\0`;
}
