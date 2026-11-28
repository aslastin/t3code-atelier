// @effect-diagnostics nodeBuiltinImport:off -- Synchronous digests and random temp file names.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  GitCommandError,
  VcsPluginCommitOutput,
  VcsPluginPullOutput,
  VcsPluginPushOutput,
  VcsPluginRefsOutput,
  VcsPluginStatusOutput,
  VcsPluginWorktreeCreateOutput,
  VcsPluginWorktreeListOutput,
  VcsUnsupportedOperationError,
  type VcsError,
  type VcsPluginManifest,
  type VcsRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as VcsDriver from "../vcs/VcsDriver.ts";
import { worktreeProjectFolder } from "../workspace/worktreeProjectPath.ts";
import { filterPatch, makePluginCheckpoints } from "./pluginCheckpoints.ts";
import { pluginMarksBeforeGit, withoutFirmlink } from "./VcsPluginDrivers.ts";
import { makePluginCommandRunner, type PluginCommandRunner } from "./pluginCommandRunner.ts";
import { checkpointStrategies, supportsWorktrees, usesPlaceholder } from "./pluginManifest.ts";

export interface ManifestVcsDriverInput {
  readonly directory: string;
  readonly manifest: VcsPluginManifest;
  readonly reportError: (operation: string, message: string) => Effect.Effect<void>;
  /** The folder new worktrees go in, as Settings → Worktrees picks it for Git. */
  readonly worktreesDirectory: Effect.Effect<string | null>;
  /** Marker paths of every installed plugin, so a checkpoint restore can tell their checkouts. */
  readonly installedMarkers?: () => ReadonlyArray<string>;
  /** Kept across rebuilds of the plugin's driver, so its native snapshots and new worktrees
   * stay serialized. */
  readonly locks?: { readonly native: Semaphore.Semaphore; readonly creating: Semaphore.Semaphore };
}

/** Marker probes only: detection never starts a process. */
const detectMarkerRoot = Effect.fn("ManifestVcsDriver.detectMarkerRoot")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  markers: ReadonlyArray<string>,
  cwd: string,
) {
  let folder = path.resolve(cwd);
  while (true) {
    for (const marker of markers) {
      if (yield* fs.exists(path.join(folder, marker)).pipe(Effect.orElseSucceed(() => false)))
        return { root: folder, marker };
    }
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
});

export const makeManifestVcsDriver = Effect.fn("ManifestVcsDriver.make")(function* (
  input: ManifestVcsDriverInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { manifest } = input;
  const kind = manifest.id;
  const runner = yield* makePluginCommandRunner(input);

  const unsupported = (operation: string, detail: string) =>
    new VcsUnsupportedOperationError({ operation, kind, detail });
  const toCommandError =
    (operation: string, cwd: string) =>
    (error: VcsError): GitCommandError =>
      new GitCommandError({
        vcs: kind,
        operation: `${kind}.${operation}`,
        command: operation,
        cwd,
        detail: error._tag === "VcsUnsupportedOperationError" ? error.detail : error.message,
        cause: error,
      });

  const attachWorktree = Effect.fn("ManifestVcsDriver.attachWorktree")(function* (
    cwd: string,
    root: string,
    worktreePath: string,
    ref: string,
  ) {
    if (manifest.commands.worktreeAttach === undefined)
      return yield* new GitCommandError({
        vcs: kind,
        operation: `${kind}.worktreeAttach`,
        command: "worktreeAttach",
        cwd,
        detail: `${manifest.label} cannot check out an existing branch into a new worktree.`,
      });
    yield* runner
      .run("worktreeAttach", {
        cwd,
        values: { repositoryRoot: root, worktreePath, ref },
        timeoutMs: null,
      })
      .pipe(Effect.mapError(toCommandError("worktreeAttach", cwd)));
    return ref;
  });

  // A folder reached through a symlink has its marker above the physical path, not the alias.
  // The repository is where the folder physically is: an alias inside one repository that
  // points into another belongs to the other.
  const detect = Effect.fnUntraced(function* (cwd: string) {
    const found = yield* detectMarkerRoot(fs, path, manifest.detect.markers, cwd);
    const real = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
    if (real === path.resolve(cwd)) return found;
    const physical = yield* detectMarkerRoot(fs, path, manifest.detect.markers, real);
    if (physical === null) return found;
    if (found === null) return physical;
    const foundReal = yield* fs.realPath(found.root).pipe(Effect.orElseSucceed(() => found.root));
    return foundReal === physical.root ? found : physical;
  });
  // macOS firmlinks: `/System/Volumes/Data/Users/…` and `/Users/…` are one folder, and
  // `realPath` keeps whichever spelling it was given. The prefix goes only when both spellings
  // are the same folder on disk, which is never so elsewhere or for paths that are not firmlinked.
  const real = Effect.fnUntraced(function* (target: string) {
    const resolved = yield* fs
      .realPath(target)
      .pipe(Effect.orElseSucceed(() => path.resolve(target)));
    return yield* withoutFirmlink(fs, resolved);
  });

  const repositoryRoot = Effect.fn("ManifestVcsDriver.repositoryRoot")(function* (cwd: string) {
    const found = yield* detect(cwd);
    if (found === null)
      return yield* unsupported("repositoryRoot", `No ${manifest.label} repository at ${cwd}.`);
    return found.root;
  });

  const repositoryRootForRefs = (cwd: string) =>
    repositoryRoot(cwd).pipe(Effect.mapError(toCommandError("listRefs", cwd)));
  const listedWorktrees = Effect.fnUntraced(function* (cwd: string) {
    if (!runner.has("worktreeList")) return [];
    const out = yield* json("worktreeList", VcsPluginWorktreeListOutput, cwd);
    const relative = out.worktrees.find((worktree) => !path.isAbsolute(worktree.path));
    if (relative !== undefined)
      return yield* new GitCommandError({
        vcs: kind,
        operation: `${kind}.worktreeList`,
        command: "worktreeList",
        cwd,
        detail: `worktreeList returned "${relative.path}", which is not an absolute path.`,
      });
    return out.worktrees;
  });
  const listWorktreePaths = (cwd: string) =>
    listedWorktrees(cwd).pipe(Effect.map((worktrees) => worktrees.map((entry) => entry.path)));

  const json = <S extends Parameters<PluginCommandRunner["runJson"]>[1]>(
    command: Parameters<PluginCommandRunner["runJson"]>[0],
    schema: S,
    cwd: string,
    values: Readonly<Record<string, string | undefined>> = {},
    timeoutMs?: number | null,
    anyOutput = false,
  ) =>
    repositoryRoot(cwd).pipe(
      Effect.flatMap((root) =>
        runner.runJson(command, schema, {
          cwd,
          values: { repositoryRoot: root, ...values },
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(anyOutput ? { anyOutput } : {}),
        }),
      ),
      Effect.mapError(toCommandError(command, cwd)),
    );

  /** A command whose stdout is plain text, such as a patch. */
  const text = (
    command: Parameters<PluginCommandRunner["run"]>[0],
    cwd: string,
    values: Readonly<Record<string, string | undefined>> = {},
    timeoutMs?: number | null,
  ) =>
    repositoryRoot(cwd).pipe(
      Effect.flatMap((root) =>
        runner.run(command, {
          cwd,
          values: { repositoryRoot: root, ...values },
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }),
      ),
      Effect.map((output) => output.stdout),
      Effect.mapError(toCommandError(command, cwd)),
    );

  // One path per line, so a name with a line break cannot be listed unambiguously.
  const pathsFileText = Effect.fnUntraced(function* (
    paths: ReadonlyArray<string> | undefined,
    cwd: string,
  ) {
    if (paths === undefined) return undefined;
    const broken = paths.find((entry) => /[\r\n]/.test(entry));
    if (broken !== undefined)
      return yield* new GitCommandError({
        vcs: kind,
        operation: `${kind}.pathsFile`,
        command: "pathsFile",
        cwd,
        detail: `${manifest.label} takes one path per line, so a name with a line break cannot be listed.`,
      });
    return paths.join("\n");
  });

  // Long text reaches the command as a file, never as an argument.
  const withTextFile = <A, E, R>(
    text: string | undefined,
    use: (file: string | undefined) => Effect.Effect<A, E, R>,
  ) =>
    text === undefined
      ? use(undefined)
      : Effect.acquireUseRelease(
          Effect.gen(function* () {
            const file = path.join(NodeOS.tmpdir(), `t3-plugin-${NodeCrypto.randomUUID()}.txt`);
            yield* fs.writeFileString(file, text).pipe(Effect.orDie);
            return file;
          }),
          use,
          (file) => fs.remove(file, { force: true }).pipe(Effect.ignore),
        );

  const status = Effect.fn("ManifestVcsDriver.status")(function* (cwd: string) {
    const out = yield* json("status", VcsPluginStatusOutput, cwd);
    const root = yield* repositoryRoot(cwd).pipe(Effect.orElseSucceed(() => undefined));
    const files = (out.files ?? []).map((file) => ({
      path: file.path,
      insertions: file.insertions ?? 0,
      deletions: file.deletions ?? 0,
      ...(file.untracked === true ? { untracked: true } : {}),
    }));
    return {
      isRepo: true,
      hasPrimaryRemote: out.hasPrimaryRemote ?? false,
      isDefaultRef: out.default ?? false,
      refName: out.ref,
      hasWorkingTreeChanges: files.length > 0,
      workingTree: {
        ...(root ? { rootPath: root } : {}),
        files,
        insertions: files.reduce((sum, file) => sum + file.insertions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      },
      hasUpstream: out.hasUpstream ?? false,
      aheadCount: out.aheadCount ?? 0,
      behindCount: out.behindCount ?? 0,
      pr: null,
    } satisfies VcsStatusResult;
  });

  const listRefNames = Effect.fn("ManifestVcsDriver.listRefNames")(function* (cwd: string) {
    if (!runner.has("refList")) {
      const current = yield* status(cwd);
      return current.refName === null
        ? []
        : [{ name: current.refName, current: true, default: current.isDefaultRef }];
    }
    return (yield* json("refList", VcsPluginRefsOutput, cwd)).refs;
  });

  const managedWorktreePath = Effect.fn("ManifestVcsDriver.managedWorktreePath")(function* (
    root: string,
    branch: string,
    cwd: string,
  ) {
    const parent = yield* input.worktreesDirectory;
    if (parent === null)
      return yield* new GitCommandError({
        vcs: kind,
        operation: `${kind}.worktreeCreate`,
        command: "worktreeCreate",
        cwd,
        detail:
          "The worktree location must be an absolute folder. Change it in Settings → Worktrees.",
      });
    const hash = NodeCrypto.createHash("sha256").update(`${root}\0${branch}`).digest("hex");
    let prefix = "";
    // Only plain characters: `\` and `:` are separators or drives on Windows.
    for (const character of branch.replace(/[^A-Za-z0-9._-]/g, "-")) {
      if (Buffer.byteLength(prefix + character) > 23) break;
      prefix += character;
    }
    const base = path.join(parent, path.basename(root), `${prefix}-${hash.slice(0, 16)}`);
    let candidate = base;
    for (
      let suffix = 2;
      yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      suffix++
    )
      candidate = `${base}-${suffix}`;
    return candidate;
  });

  const commands = manifest.commands;
  // One creation at a time: the occupancy check and the plugin's command are not one step.
  const creating = input.locks?.creating ?? (yield* Semaphore.make(1));
  const workflow: VcsDriver.VcsWorkflowOps = {
    status: (request) => status(request.cwd),
    listRefs: Effect.fn("ManifestVcsDriver.listRefs")(function* (request) {
      const query = request.query?.toLowerCase();
      // Where each branch is checked out, when the plugin's worktree list says.
      const checkedOut = new Map(
        (yield* listedWorktrees(request.cwd).pipe(Effect.orElseSucceed(() => []))).flatMap(
          (worktree) =>
            worktree.ref === undefined ? [] : [[worktree.ref, worktree.path] as const],
        ),
      );
      const refs: VcsRef[] = (yield* listRefNames(request.cwd))
        .filter((ref) => {
          if (request.refKind === "local" && ref.remote) return false;
          if (request.refKind === "remote" && !ref.remote) return false;
          return query === undefined || ref.name.toLowerCase().includes(query);
        })
        .map((ref) => ({
          name: ref.name,
          current: ref.current ?? false,
          isDefault: ref.default ?? false,
          worktreePath: checkedOut.get(ref.name) ?? null,
          ...(ref.remote !== undefined ? { isRemote: ref.remote } : {}),
          ...(ref.remoteName !== undefined ? { remoteName: ref.remoteName } : {}),
        }));
      const start = request.cursor ?? 0;
      const end = request.limit === undefined ? refs.length : start + request.limit;
      return {
        refs: refs.slice(start, end),
        isRepo: true,
        isAtRepositoryRoot:
          (yield* real(request.cwd)) === (yield* real(yield* repositoryRootForRefs(request.cwd))),
        hasPrimaryRemote: false,
        nextCursor: end < refs.length ? end : null,
        totalCount: refs.length,
      };
    }),
    ...(commands.commit && {
      commit: Effect.fn("ManifestVcsDriver.commit")(function* (request) {
        if (request.commitMessage === undefined)
          return yield* new GitCommandError({
            vcs: kind,
            operation: `${kind}.commit`,
            command: "commit",
            cwd: request.cwd,
            detail: `Write a commit message: ${manifest.label} commits need one.`,
          });
        if (request.filePaths && !usesPlaceholder(commands.commit, "pathsFile"))
          return yield* new GitCommandError({
            vcs: kind,
            operation: `${kind}.commit`,
            command: "commit",
            cwd: request.cwd,
            detail: `${manifest.label} commits every change; it cannot commit only the selected files.`,
          });
        // "Commit all" lists every changed file, so {pathsFile} always names what to commit.
        const paths =
          request.filePaths ??
          (usesPlaceholder(commands.commit, "pathsFile")
            ? ((yield* json("status", VcsPluginStatusOutput, request.cwd)).files ?? []).map(
                (file) => file.path,
              )
            : undefined);
        const pathsText = yield* pathsFileText(paths, request.cwd);
        const out = yield* withTextFile(request.commitMessage, (messageFile) =>
          withTextFile(pathsText, (pathsFile) =>
            json(
              "commit",
              VcsPluginCommitOutput,
              request.cwd,
              { messageFile, pathsFile },
              // Hooks and large checkouts can run long, as `git commit` may.
              null,
              true,
            ),
          ),
        );
        return {
          status: "created" as const,
          ...(out.commitSha !== undefined ? { commitSha: out.commitSha } : {}),
          ...(out.subject !== undefined ? { subject: out.subject } : {}),
        };
      }),
    }),
    ...(commands.log && {
      recentCommitSubjects: Effect.fn("ManifestVcsDriver.recentCommitSubjects")(
        function* (request) {
          return (yield* text("log", request.cwd))
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(0, 20);
        },
      ),
    }),
    ...(commands.branchCreate && {
      createBranch: Effect.fn("ManifestVcsDriver.createBranch")(function* (request) {
        const root = yield* repositoryRoot(request.cwd).pipe(
          Effect.mapError(toCommandError("branchCreate", request.cwd)),
        );
        yield* runner
          .run("branchCreate", {
            cwd: request.cwd,
            values: { repositoryRoot: root, newRef: request.refName },
          })
          .pipe(Effect.mapError(toCommandError("branchCreate", request.cwd)));
      }),
    }),
    ...(commands.branchRename && {
      renameBranch: Effect.fn("ManifestVcsDriver.renameBranch")(function* (request) {
        const failed = toCommandError("branchRename", request.cwd);
        const root = yield* repositoryRoot(request.cwd).pipe(Effect.mapError(failed));
        const branch =
          request.exactName === true || request.oldBranch === request.newBranch
            ? request.newBranch
            : freeBranchName(
                request.newBranch,
                (yield* listRefNames(request.cwd))
                  .filter((ref) => !ref.remote && ref.name !== request.oldBranch)
                  .map((ref) => ref.name),
              );
        if (branch === null)
          return yield* new GitCommandError({
            vcs: kind,
            operation: `${kind}.branchRename`,
            command: "branchRename",
            cwd: request.cwd,
            detail: `No free branch name like ${request.newBranch}.`,
          });
        if (branch === request.oldBranch) return { branch };
        yield* runner
          .run("branchRename", {
            cwd: request.cwd,
            values: { repositoryRoot: root, oldRef: request.oldBranch, newRef: branch },
          })
          .pipe(Effect.mapError(failed));
        return { branch };
      }),
    }),
    ...(commands.fetchBase && {
      fetchWorktreeBase: Effect.fn("ManifestVcsDriver.fetchWorktreeBase")(function* (request) {
        // Network work: no deadline, as `git fetch` has none.
        const baseRef = (yield* text(
          "fetchBase",
          request.cwd,
          { ref: request.refName },
          null,
        )).trim();
        if (baseRef === "")
          return yield* new GitCommandError({
            vcs: kind,
            operation: `${kind}.fetchBase`,
            command: "fetchBase",
            cwd: request.cwd,
            detail: "fetchBase printed no ref to start the worktree from.",
          });
        return { baseRef };
      }),
    }),
    ...(commands.diff && {
      workingDiff: Effect.fn("ManifestVcsDriver.workingDiff")(function* (request) {
        // An empty {pathsFile} asks for every change, so an empty selection never reaches it.
        if (request.filePaths?.length === 0) return "";
        const patch = yield* withTextFile(
          (yield* pathsFileText(request.filePaths, request.cwd)) ?? "",
          (pathsFile) => text("diff", request.cwd, { pathsFile }),
        );
        // A diff that takes no file list prints every change; only the selected ones may go on.
        return request.filePaths && !usesPlaceholder(commands.diff, "pathsFile")
          ? filterPatch(patch, new Set(request.filePaths))
          : patch;
      }),
    }),
    ...(commands.push && {
      push: Effect.fn("ManifestVcsDriver.push")(function* (request) {
        const out = yield* json("push", VcsPluginPushOutput, request.cwd, {}, null, true);
        return {
          status: "pushed" as const,
          ...(out.branch !== undefined ? { branch: out.branch } : {}),
          ...(out.upstreamBranch !== undefined ? { upstreamBranch: out.upstreamBranch } : {}),
        };
      }),
    }),
    ...(commands.pull && {
      pull: Effect.fn("ManifestVcsDriver.pull")(function* (request) {
        const out = yield* json("pull", VcsPluginPullOutput, request.cwd, {}, null, true);
        return {
          status: out.status ?? "pulled",
          refName: out.ref ?? (yield* status(request.cwd)).refName ?? "HEAD",
          upstreamRef: out.upstreamRef ?? null,
        };
      }),
    }),
    ...(supportsWorktrees(manifest) && {
      createWorktree: Effect.fn("ManifestVcsDriver.createWorktree")(function* (request) {
        const root = yield* repositoryRoot(request.cwd).pipe(
          Effect.mapError(toCommandError("worktreeCreate", request.cwd)),
        );
        const newRef = request.newRefName ?? request.refName;
        const worktreePath = path.resolve(
          request.cwd,
          request.path ?? (yield* managedWorktreePath(root, newRef, request.cwd)),
        );
        // As `git worktree add`: never into a folder that holds anything, or one that cannot be
        // looked into. The plugin's own command might write over its files.
        const occupied = yield* fs.readDirectory(worktreePath).pipe(
          Effect.map((names) => names.length > 0),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
          Effect.orElseSucceed(() => true),
        );
        if (occupied)
          return yield* new GitCommandError({
            vcs: kind,
            operation: `${kind}.worktreeCreate`,
            command: "worktreeCreate",
            cwd: request.cwd,
            detail: `${worktreePath} already holds files, so no checkout is created there.`,
          });
        yield* fs
          .makeDirectory(path.dirname(worktreePath), { recursive: true })
          .pipe(Effect.ignore);
        // Without a new ref, as `git worktree add <path> <branch>`: check out the ref that exists.
        const refName =
          request.newRefName === undefined
            ? yield* attachWorktree(request.cwd, root, worktreePath, request.refName)
            : ((yield* json(
                "worktreeCreate",
                VcsPluginWorktreeCreateOutput,
                request.cwd,
                { worktreePath, newRef, baseRef: request.baseRefName ?? request.refName },
                // Large checkouts can run for many minutes, as `git worktree add` does.
                null,
                true,
              )).ref ?? newRef);
        // A project in a subfolder works in the same subfolder of the new checkout (#12).
        const relative = path.relative(yield* real(root), yield* real(request.cwd));
        const projectPath = yield* worktreeProjectFolder(fs, path, relative, worktreePath);
        return { worktree: { path: worktreePath, projectPath, refName } };
      }, creating.withPermits(1)),
      // The plugin keeps its own worktree list; T3 Code has nothing of its own to forget.
      pruneWorktrees: () => Effect.void,
      removeWorktree: Effect.fn("ManifestVcsDriver.removeWorktree")(function* (request) {
        const root = yield* repositoryRoot(request.cwd).pipe(
          Effect.mapError(toCommandError("worktreeRemove", request.cwd)),
        );
        // As for Git: a path inside a checkout, such as a project subfolder, names the whole
        // checkout. A folder already gone is passed as given.
        const requested = path.resolve(request.cwd, request.path);
        const marked = yield* detect(requested);
        // Without the plugin's own list, only a folder with its marker is a worktree.
        if (marked === null && !runner.has("worktreeList"))
          return yield* new GitCommandError({
            vcs: kind,
            operation: `${kind}.worktreeRemove`,
            command: "worktreeRemove",
            cwd: request.cwd,
            detail: `${requested} is not a ${manifest.label} worktree.`,
          });
        const listed = runner.has("worktreeList") ? yield* listWorktreePaths(request.cwd) : [];
        const isListed = Effect.fnUntraced(function* (candidate: string) {
          const realCandidate = yield* real(candidate);
          for (const entry of listed) {
            if (path.resolve(entry) === candidate || (yield* real(entry)) === realCandidate)
              return true;
          }
          return false;
        });
        // A listed path names that checkout itself, never one around it that a stale entry's
        // folder happens to sit in.
        // A `.git` or another plugin's marker nearer than this one's makes the path that
        // repository's, not the checkout's.
        const owned =
          marked !== null &&
          (yield* pluginMarksBeforeGit(fs, path, requested, manifest.detect.markers, [
            ".git",
            ...(input.installedMarkers?.() ?? []).filter(
              (marker) => !manifest.detect.markers.includes(marker),
            ),
          ]));
        const target =
          (yield* isListed(requested)) || !owned ? requested : (marked?.root ?? requested);
        const refuse = (detail: string) =>
          new GitCommandError({
            vcs: kind,
            operation: `${kind}.worktreeRemove`,
            command: "worktreeRemove",
            cwd: request.cwd,
            detail,
          });
        const inside = (parent: string, child: string) => {
          const relative = path.relative(parent, child);
          // `..name` is a child; only `..` itself or `../…` leaves the folder.
          return (
            relative === "" ||
            (relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          );
        };
        // Never the repository T3 Code works from, nor a checkout that holds the caller, however
        // either is spelled.
        const [realTarget, realRoot, realCwd] = [
          yield* real(target),
          yield* real(root),
          yield* real(request.cwd),
        ];
        if (
          target === root ||
          realTarget === realRoot ||
          inside(target, path.resolve(request.cwd)) ||
          inside(realTarget, realCwd)
        )
          return yield* refuse("The repository itself is not a worktree.");
        // A folder still there must be the plugin's checkout, its marker at its own root, forced
        // or not: a stale entry can name a folder put in its place since.
        if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true))) {
          const own = yield* detect(target);
          if (own === null || (yield* real(own.root)) !== realTarget)
            return yield* refuse(`${target} is not a ${manifest.label} checkout.`);
        }
        if (runner.has("worktreeList") && !(yield* isListed(target)))
          return yield* refuse(`${manifest.label} does not list ${target} as a worktree.`);
        // As `git worktree remove` without --force: local work keeps the checkout.
        if (
          request.force !== true &&
          (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))
        ) {
          const files = (yield* json("status", VcsPluginStatusOutput, target)).files ?? [];
          if (files.length > 0)
            return yield* refuse(
              `${target} has uncommitted changes (${files.length} ${files.length === 1 ? "file" : "files"}).`,
            );
        }
        yield* runner
          .run("worktreeRemove", {
            cwd: request.cwd,
            // `true` only when local changes may go, as with `git worktree remove --force`.
            values: {
              repositoryRoot: root,
              worktreePath: target,
              force: request.force === true ? "true" : "false",
            },
            timeoutMs: null,
          })
          .pipe(Effect.mapError(toCommandError("worktreeRemove", request.cwd)));
      }),
    }),
    listWorktrees: Effect.fn("ManifestVcsDriver.listWorktrees")(function* (request) {
      return yield* listWorktreePaths(request.cwd);
    }),
  };

  const checkpoints = yield* makePluginCheckpoints({
    runner,
    strategies: checkpointStrategies(manifest),
    metadataFolders: [
      ...new Set(manifest.detect.markers.map((marker) => marker.split(/[/\\]/)[0]!)),
    ],
    repositoryMarkers: () => [...manifest.detect.markers, ...(input.installedMarkers?.() ?? [])],
    ...(input.locks === undefined ? {} : { nativeSnapshots: input.locks.native }),
    repositoryRoot,
  });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "ManifestVcsDriver.detectRepository",
  )(function* (cwd) {
    const found = yield* detect(cwd);
    if (found === null) return null;
    return {
      kind,
      rootPath: found.root,
      metadataPath: path.join(found.root, found.marker),
      freshness: {
        source: "live-local",
        observedAt: yield* DateTime.now,
        expiresAt: Option.none(),
      },
    } as const;
  });

  return VcsDriver.VcsDriver.of({
    workflow,
    capabilities: {
      kind,
      supportsWorktrees: supportsWorktrees(manifest),
      supportsCommit: commands.commit !== undefined,
      supportsPush: commands.push !== undefined,
      supportsReviewDiff: false,
      supportsSparseCheckout: false,
      supportsBookmarks: false,
      supportsAtomicSnapshot: false,
      supportsPushDefaultRemote: false,
      ignoreClassifier: "git-compatible-fallback",
      supportsBranchCreate: commands.branchCreate !== undefined,
      supportsPartialCommit: usesPlaceholder(commands.commit, "pathsFile"),
      supportsPull: commands.pull !== undefined,
      supportsFetchBase: commands.fetchBase !== undefined,
    },
    execute: Effect.fn("ManifestVcsDriver.execute")(function* () {
      return yield* unsupported("execute", "Plugins run only their own commands.");
    }),
    checkpoints,
    detectRepository,
    isInsideWorkTree: Effect.fn("ManifestVcsDriver.isInsideWorkTree")(function* (cwd) {
      return (yield* detect(cwd)) !== null;
    }),
    listWorkspaceFiles: Effect.fn("ManifestVcsDriver.listWorkspaceFiles")(function* () {
      return yield* unsupported("listWorkspaceFiles", "Plugins do not list workspace files.");
    }),
    // Remotes only feed change-request hosts, which plugins do not have yet.
    listRemotes: Effect.fn("ManifestVcsDriver.listRemotes")(function* () {
      return {
        remotes: [],
        freshness: {
          source: "live-local" as const,
          observedAt: yield* DateTime.now,
          expiresAt: Option.none(),
        },
      };
    }),
    // Nothing counts as ignored: the plugin reports its own changes.
    filterIgnoredPaths: Effect.fn("ManifestVcsDriver.filterIgnoredPaths")(function* () {
      return yield* Effect.succeed([]);
    }),
    initRepository: Effect.fn("ManifestVcsDriver.initRepository")(function* () {
      return yield* unsupported("initRepository", "Plugins cannot create repositories.");
    }),
  });
});

/** As Git picks one: the name, or with a numbered suffix, unless a branch or one under it has it. */
function freeBranchName(requested: string, existing: ReadonlyArray<string>): string | null {
  const branches = new Set(existing.map((name) => name.toLowerCase()));
  const blocked = new Set(branches);
  for (const branch of branches) {
    const segments = branch.split("/");
    for (let index = 1; index < segments.length; index += 1)
      blocked.add(segments.slice(0, index).join("/"));
  }
  const segments = requested.split("/");
  const underBranch = segments.some(
    (_, index) => index > 0 && branches.has(segments.slice(0, index).join("/").toLowerCase()),
  );
  const desired = underBranch ? segments.join("-") : requested;
  if (!blocked.has(desired.toLowerCase())) return desired;
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const candidate = `${desired}-${suffix}`;
    if (!blocked.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}
