import type { WorktreeCleanupRules } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as GitVcsDriver from "./GitVcsDriver.ts";

type FileRetention = {
  readonly worktreeKeepWhen: WorktreeCleanupRules["worktreeKeepWhen"] | "all-files";
};

const errorCode = (error: PlatformError) =>
  error.cause instanceof Error && "code" in error.cause ? error.cause.code : undefined;

export function worktreeRemovalChecks(
  execute: GitVcsDriver.GitVcsDriver["Service"]["execute"],
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return path.sep === "\\" ? resolved.toLowerCase() : resolved;
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
  // Git status and non-forced worktree removal both skip assume-unchanged and skip-worktree files.
  const hiddenTrackedChange = Effect.fn("StorageCleanup.hiddenTrackedChange")(function* (
    cwd: string,
  ) {
    const inspect = (args: string[], stdin?: string) =>
      execute({
        operation: "StorageCleanup.hiddenTrackedChanges",
        cwd,
        args,
        ...(stdin === undefined ? {} : { stdin }),
        maxOutputBytes: 1024 * 1024,
      });
    const sparse = yield* inspect([
      "config",
      "--type=bool",
      "--default=false",
      "core.sparseCheckout",
    ]);
    // Sparse checkouts flag every file outside the cone; Git 2.37+ unflags those it finds on disk.
    const hiddenTag = sparse.stdout.trim() === "true" ? /^[a-z]$/ : /^(?:S|[a-z])$/;
    const flagged: Array<{ readonly mode: string; readonly id: string; readonly file: string }> =
      [];
    let overflow = false;
    yield* execute({
      operation: "StorageCleanup.hiddenTrackedChanges",
      cwd,
      args: ["-c", "core.quotePath=false", "ls-files", "-s", "-v"],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
      keepLineCallbacksAfterTruncation: true,
      progress: {
        onStdoutLine: (line) =>
          Effect.sync(() => {
            const match = /^(\S) (\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(line);
            if (match === null || !hiddenTag.test(match[1]!) || match[2] === "160000") return;
            if (flagged.length < 10_000)
              flagged.push({ mode: match[2]!, id: match[3]!, file: match[4]! });
            else overflow = true;
          }),
      },
    });
    if (overflow) return "hidden tracked files exceed the inspection limit";
    const reason = (file: string) => `has uncommitted changes hidden from git status (${file})`;
    // Quoted names (control characters, quotes, backslashes) and names that are not valid UTF-8
    // decode to text that is not the path on disk.
    const unreadable = flagged.find(({ file }) => file.startsWith('"') || file.includes("\uFFFD"));
    if (unreadable !== undefined) return reason(unreadable.file);
    const onDisk = yield* Effect.forEach(
      flagged,
      (entry) => {
        const file = path.join(cwd, entry.file);
        return fs.readLink(file).pipe(
          Effect.map((target) => ({ ...entry, type: "SymbolicLink", target })),
          Effect.catchIf(
            (error) => errorCode(error) === "EINVAL",
            () => fs.stat(file).pipe(Effect.map((info) => ({ ...entry, type: info.type }))),
          ),
          Effect.catchIf(
            (error) => errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR",
            () => Effect.succeed(null),
          ),
        );
      },
      { concurrency: 16 },
    );
    const files: Array<{ readonly id: string; readonly file: string }> = [];
    // Without core.symlinks a tracked link is a regular file holding its target, compared unfiltered.
    const linkFiles: typeof files = [];
    for (const entry of onDisk) {
      if (entry === null) continue;
      if (entry.type === "File") (entry.mode === "120000" ? linkFiles : files).push(entry);
      else if (!("target" in entry) || entry.mode !== "120000") return reason(entry.file);
      // Hashing a link's path would hash the file it points to.
      else if (
        (yield* inspect(["hash-object", "--stdin"], entry.target)).stdout.trim() !== entry.id
      )
        return reason(entry.file);
    }
    const hashPaths = (entries: ReadonlyArray<{ readonly file: string }>, flags: string[]) =>
      entries.length === 0
        ? Effect.succeed([])
        : inspect(
            ["hash-object", ...flags, "--stdin-paths"],
            entries.map(({ file }) => `${file}\n`).join(""),
          ).pipe(Effect.map((result) => result.stdout.split("\n")));
    const worktreeIds = yield* hashPaths(files, []);
    const linkIds = yield* hashPaths(linkFiles, ["--no-filters"]);
    const changed =
      files.find(({ id }, i) => worktreeIds[i] !== id) ??
      linkFiles.find(({ id }, i) => linkIds[i] !== id);
    return changed === undefined ? null : reason(changed.file);
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
    rules: FileRetention,
  ) {
    const status = yield* execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        rules.worktreeKeepWhen === "tracked-changes"
          ? "--untracked-files=no"
          : "--untracked-files=all",
      ],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
    });
    if (status.stdoutTruncated) return "local changes exceed the inspection limit";
    const records = status.stdout.split("\0").filter(Boolean);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
    }
    if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
    const hidden = yield* hiddenTrackedChange(cwd);
    if (hidden !== null) return hidden;
    if (rules.worktreeKeepWhen !== "any-local-files" && rules.worktreeKeepWhen !== "all-files")
      return null;
    const ignored = yield* execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    const file = ignored.stdout
      .split("\0")
      .find(
        (entry) =>
          entry !== "" &&
          (rules.worktreeKeepWhen === "all-files" || !/(^|\/)node_modules\/$/.test(entry)),
      );
    return file === undefined ? null : `has ignored files (${file})`;
  });

  const submoduleRemoval = Effect.fn("StorageCleanup.submoduleRemoval")(
    function* (cwd: string, rules: FileRetention) {
      const inspect = (args: string[], maxOutputBytes = 64 * 1024) =>
        execute({
          operation: "StorageCleanup.submodules",
          cwd,
          args,
          maxOutputBytes,
        });
      const admin = yield* inspect(["rev-parse", "--absolute-git-dir"]);
      if (admin.stdoutTruncated || admin.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const modules = path.join(admin.stdout.replace(/\n$/, ""), "modules");
      const stored = yield* fs.exists(modules);
      if (!stored && !(yield* fs.exists(path.join(cwd, ".gitmodules"))))
        return { force: false, reason: null };
      const populated = yield* inspect([
        "submodule",
        "foreach",
        "--recursive",
        "--quiet",
        'printf "%s\\0" "$toplevel/$sm_path"',
      ]);
      if (populated.stdoutTruncated || populated.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const paths = populated.stdout.split("\0").filter(Boolean);
      const pending = [modules];
      for (const submodule of paths) {
        const directory = yield* inspect(["-C", submodule, "rev-parse", "--absolute-git-dir"]);
        if (directory.stdoutTruncated || directory.stderrTruncated)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        pending.push(directory.stdout.replace(/\n$/, ""));
      }
      const visited = new Set<string>();
      while (pending.length > 0) {
        const directory = pending.pop()!;
        if (!(yield* fs.exists(directory))) continue;
        const canonical = yield* fs.realPath(directory);
        if (visited.has(canonical)) continue;
        visited.add(canonical);
        if (visited.size > 10_000)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        if ((yield* fs.stat(directory)).type !== "Directory")
          return { force: false, reason: "submodule repository could not be inspected" };
        if (yield* fs.exists(path.join(directory, "HEAD"))) {
          const unpushed = yield* inspect([
            "--git-dir",
            directory,
            "--work-tree",
            cwd,
            "rev-list",
            "--max-count=1",
            "HEAD",
            // Checkpoint refs hold workspace snapshots, not commits a user could lose.
            "--exclude=refs/t3/*",
            "--all",
            "--reflog",
            "--not",
            "--remotes",
          ]);
          if (unpushed.stdoutTruncated || unpushed.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          if (unpushed.stdout.trim() !== "")
            return { force: false, reason: "submodule has commits not on a remote-tracking ref" };
          pending.push(path.join(directory, "modules"));
        } else {
          for (const name of yield* fs.readDirectory(directory))
            pending.push(path.join(directory, name));
        }
      }
      // Check files after walking stored history to shorten the gap before forced removal.
      for (const submodule of paths) {
        const changes = yield* localChangesReason(submodule, rules);
        if (changes !== null) return { force: false, reason: `submodule ${changes}` };
      }
      const force = stored || paths.length > 0;
      if (force && rules.worktreeKeepWhen !== "tracked-changes") {
        const root = yield* fs.realPath(cwd);
        // Git status and foreach omit files inside deinitialized gitlink directories.
        const populatedPaths = new Set(paths.map(pathKey));
        const unchecked: string[] = [];
        for (const repository of [root, ...paths]) {
          const index = yield* inspect(
            ["-C", repository, "ls-files", "--stage", "-z"],
            16 * 1024 * 1024,
          );
          if (index.stdoutTruncated || index.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          for (const entry of index.stdout.split("\0")) {
            if (!entry.startsWith("160000 ")) continue;
            const submodule = path.resolve(repository, entry.slice(entry.indexOf("\t") + 1));
            if (!inside(root, submodule))
              return { force: false, reason: "submodules could not be inspected" };
            if (!populatedPaths.has(pathKey(submodule)) && (yield* fs.exists(submodule)))
              unchecked.push(submodule);
          }
        }
        let inspected = unchecked.length;
        while (unchecked.length > 0) {
          if (inspected > 10_000)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          const target = unchecked.pop()!;
          if (
            (yield* fs.realPath(target)) !== path.resolve(target) ||
            (yield* fs.stat(target)).type !== "Directory"
          )
            return { force: false, reason: "submodule has local files" };
          if (rules.worktreeKeepWhen !== "all-files" && path.basename(target) === "node_modules")
            continue;
          const names = yield* fs.readDirectory(target);
          inspected += names.length;
          for (const name of names) unchecked.push(path.join(target, name));
        }
      }
      return { force, reason: null };
    },
    Effect.orElseSucceed(() => ({ force: false, reason: "submodules could not be inspected" })),
  );

  return { localChangesReason, submoduleRemoval };
}
