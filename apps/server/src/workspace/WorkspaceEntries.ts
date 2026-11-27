// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectListIgnoredFilesInput,
  ProjectListIgnoredFilesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { VcsPluginDrivers } from "../plugins/VcsPluginDrivers.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedError<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedError<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedError<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get pathMissing(): boolean {
    return (this.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  }

  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

/**
 * Atelier fork: text search in a VCS plugin's repository. Walking or indexing its tree can be
 * costly, such as downloading every file on a FUSE mount, so it waits for search through the
 * plugin itself.
 */
export class WorkspaceEntriesSearchUnavailableError extends Schema.TaggedError<WorkspaceEntriesSearchUnavailableError>()(
  "WorkspaceEntriesSearchUnavailableError",
  { cwd: Schema.String },
) {
  override get message(): string {
    return `Text search is not available in a VCS plugin's repository, or a folder holding one, yet: ${this.cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceEntriesReadDirectoryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
  WorkspaceEntriesSearchUnavailableError,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly listIgnoredFiles: (
      input: ProjectListIgnoredFilesInput,
    ) => Effect.Effect<ProjectListIgnoredFilesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

/** Ignored files offered for copying; more than this is a build folder, not config. */
const IGNORED_FILES_LIMIT = 200;
// Atelier fork: how long a folder's probe for a VCS plugin's checkout below it holds.
const PLUGIN_CHECKOUT_PROBE_TTL_MS = 60_000;
const PLUGIN_CHECKOUT_MISS_TTL_MS = 5_000;

/** Paths sent to one `git check-ignore` call when labelling a folder's children. */
const IGNORE_CHECK_CHUNK_SIZE = 1000;

/** Children classified at once when listing a folder; each symlink costs a realpath and a stat. */
const SYMLINK_RESOLVE_BATCH_SIZE = 64;

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, yield* HostProcess.HomeDirectory));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(
    expandHomePath(input.cwd, yield* HostProcess.HomeDirectory),
    input.partialPath,
  );
});

/**
 * Atelier fork: mount points in `mount` output (macOS, `<device> on <path> (<options>)`) or in
 * `/proc/self/mounts` (Linux, octal-escaped fields).
 */
export function parseMountPoints(output: string, platform: string): ReadonlyArray<string> {
  const lines = output.split("\n").filter((line) => line.length > 0);
  if (platform === "linux")
    return lines.flatMap((line) => {
      const field = line.split(" ")[1];
      return field === undefined
        ? []
        : [
            field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
              String.fromCharCode(parseInt(octal, 8)),
            ),
          ];
    });
  return lines.flatMap((line) => {
    const match = / on (.+) \([^()]*\)$/.exec(line);
    return match === null ? [] : [match[1]!];
  });
}

/** @public */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsProcess = yield* VcsProcess.VcsProcess;

  // Atelier fork: a folder inside a VCS plugin's repository, installed plugins off included,
  // gets no tree walk or index. The nearest checkout root decides; in the same folder a plugin's
  // marker wins over `.git`, as the driver registry decides.
  const constructedPlugins = yield* Effect.serviceOption(VcsPluginDrivers);
  const inPluginRepository = Effect.fnUntraced(function* (cwd: string) {
    const current = Option.isSome(constructedPlugins)
      ? constructedPlugins
      : yield* Effect.serviceOption(VcsPluginDrivers);
    const markers = Option.isSome(current) ? current.value.installedMarkers() : [];
    if (markers.length === 0) return false;
    const exists = (target: string) =>
      Effect.promise(() =>
        NodeFSP.access(target).then(
          () => true,
          () => false,
        ),
      );
    // Physical ancestors, as the driver finds the repository: a link can point into one.
    const start = yield* Effect.promise(() => NodeFSP.realpath(cwd).catch(() => path.resolve(cwd)));
    for (let folder = start; ; folder = path.dirname(folder)) {
      for (const marker of markers) {
        if (yield* exists(path.join(folder, marker))) return true;
      }
      if (yield* exists(path.join(folder, ".git"))) return false;
      if (path.dirname(folder) === folder) return false;
    }
  });

  // A folder that holds a plugin's checkout a level or two down, such as a home folder or a
  // wrapper of repositories, walks into it as well. Probed as the folder scan does, and
  // remembered for a while: it reads the folder's children and theirs.
  const holdsPluginCheckout = new Map<string, { readonly at: number; readonly holds: boolean }>();
  // A checkout can be another file system, such as a FUSE mount, at any depth: none is walked.
  const platform = yield* HostProcess.Platform;
  let mounts: { readonly at: number; readonly points: ReadonlyArray<string> } | undefined;
  const mountPoints = Effect.fnUntraced(function* (now: number) {
    if (mounts !== undefined && now - mounts.at < PLUGIN_CHECKOUT_MISS_TTL_MS) return mounts.points;
    const output =
      platform === "linux"
        ? yield* Effect.promise(() => NodeFSP.readFile("/proc/self/mounts", "utf8").catch(() => ""))
        : platform === "darwin"
          ? ((yield* vcsProcess
              .run({
                operation: "WorkspaceEntries.mountPoints",
                command: "/sbin/mount",
                args: [],
                cwd: "/",
                allowNonZeroExit: true,
                timeoutMs: 5_000,
                maxOutputBytes: 1024 * 1024,
              })
              .pipe(Effect.orElseSucceed(() => undefined)))?.stdout ?? "")
          : "";
    mounts = { at: now, points: parseMountPoints(output, platform) };
    return mounts.points;
  });
  const containsPluginCheckout = Effect.fnUntraced(function* (cwd: string) {
    const current = Option.isSome(constructedPlugins)
      ? constructedPlugins
      : yield* Effect.serviceOption(VcsPluginDrivers);
    const markers = Option.isSome(current) ? current.value.installedMarkers() : [];
    if (markers.length === 0) return false;
    const now = yield* Clock.currentTimeMillis;
    const known = holdsPluginCheckout.get(cwd);
    // A checkout found stays found a while; none found is asked again soon, as one can appear.
    if (
      known !== undefined &&
      now - known.at < (known.holds ? PLUGIN_CHECKOUT_PROBE_TTL_MS : PLUGIN_CHECKOUT_MISS_TTL_MS)
    )
      return known.holds;
    const probed = yield* Effect.promise(async () => {
      const marked = async (folder: string) => {
        for (const marker of markers) {
          if (
            await NodeFSP.access(path.join(folder, marker)).then(
              () => true,
              () => false,
            )
          )
            return true;
        }
        return false;
      };
      const childFolders = async (folder: string) =>
        (await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => []))
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules",
          )
          .map((entry) => path.join(folder, entry.name));
      for (const child of await childFolders(cwd)) {
        if (await marked(child)) return true;
        for (const grandchild of await childFolders(child))
          if (await marked(grandchild)) return true;
      }
      return false;
    });
    const root = yield* Effect.promise(() => NodeFSP.realpath(cwd).catch(() => path.resolve(cwd)));
    const holds =
      probed ||
      (yield* mountPoints(now)).some((point) => {
        const relative = path.relative(root, point);
        return (
          relative !== "" &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      });
    holdsPluginCheckout.set(cwd, { at: now, holds });
    return holds;
  });
  const holdsMarkedFolder = Effect.fnUntraced(function* (
    cwd: string,
    entries: ReadonlyArray<ProjectEntry>,
  ) {
    const current = Option.isSome(constructedPlugins)
      ? constructedPlugins
      : yield* Effect.serviceOption(VcsPluginDrivers);
    const markers = Option.isSome(current) ? current.value.installedMarkers() : [];
    if (markers.length === 0) return false;
    return yield* Effect.promise(async () => {
      for (const entry of entries) {
        if (entry.kind !== "directory") continue;
        for (const marker of markers) {
          if (
            await NodeFSP.access(path.join(cwd, entry.path, marker)).then(
              () => true,
              () => false,
            )
          )
            return true;
        }
      }
      return false;
    });
  });
  const walksPluginRepository = (cwd: string) =>
    inPluginRepository(cwd).pipe(
      Effect.flatMap((inside) => (inside ? Effect.succeed(true) : containsPluginCheckout(cwd))),
    );

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  // Refreshing goes through `get`, which restarts the map's idle timer, so idleness is measured
  // from the last search, not the last refresh.
  const lastSearchedAt = new Map<string, number>();
  const indexIdleMillis = Duration.toMillis(WorkspaceSearchIndex.WORKSPACE_INDEX_IDLE_TTL);
  const markSearched = (indexKey: string, now: number) => {
    // A record older than the timeout counts the same as none, so it can go.
    for (const [key, searchedAt] of lastSearchedAt) {
      if (now - searchedAt >= indexIdleMillis) lastSearchedAt.delete(key);
    }
    lastSearchedAt.set(indexKey, now);
  };

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      let pluginRepository: boolean | undefined;
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        // An index made before a plugin claimed the folder is dropped, never refreshed.
        pluginRepository ??= yield* walksPluginRepository(normalizedCwd);
        if (pluginRepository) {
          lastSearchedAt.delete(indexKey);
          yield* workspaceSearchIndexes.invalidate(indexKey);
          continue;
        }
        const searchedAt = lastSearchedAt.get(indexKey) ?? 0;
        if ((yield* Clock.currentTimeMillis) - searchedAt >= indexIdleMillis) {
          lastSearchedAt.delete(indexKey);
          yield* workspaceSearchIndexes.invalidate(indexKey);
          continue;
        }
        const recoverRefreshFailure = Effect.fn("WorkspaceEntries.recoverRefreshFailure")(
          function* (
            cause:
              | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
              | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
          ) {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          },
        );
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      if (yield* walksPluginRepository(normalizedCwd))
        return { entries: [], truncated: false, unavailable: true };
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths");
      markSearched(indexKey, yield* Clock.currentTimeMillis);
      const result = yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(Effect.provide(workspaceSearchIndexes.get(indexKey)));
      if (input.kind === "directory" || input.imageOnly) return result;
      const worktreeFiles = yield* findNestedWorktreeFiles(
        normalizedCwd,
        input.query,
        result.entries,
      );
      if (worktreeFiles.length === 0) return result;
      const entries = [...worktreeFiles, ...result.entries];
      return {
        entries: entries.slice(0, input.limit),
        truncated: result.truncated || entries.length > input.limit,
      };
    },
  );

  // The index skips gitignored folders, where agents often put worktrees (`.worktrees/x`).
  // A path relative to such a worktree is found only when it names an existing file exactly.
  const findNestedWorktreeFiles = Effect.fn("WorkspaceEntries.findNestedWorktreeFiles")(function* (
    cwd: string,
    query: string,
    indexed: ReadonlyArray<ProjectEntry>,
  ) {
    const relativePath = query.trim().replaceAll("\\", "/");
    if (
      !relativePath.includes("/") ||
      relativePath.endsWith("/") ||
      path.isAbsolute(relativePath) ||
      isWindowsAbsolutePath(relativePath) ||
      relativePath.split("/").some((segment) => segment === "..") ||
      indexed.some(
        (entry) =>
          entry.kind === "file" &&
          (entry.path === relativePath || entry.path.endsWith(`/${relativePath}`)),
      )
    ) {
      return [];
    }
    const listWorktrees = (args: ReadonlyArray<string>) =>
      vcsProcess
        .run({
          operation: "WorkspaceEntries.listWorktrees",
          command: "git",
          args: ["worktree", "list", "--porcelain", ...args],
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout : undefined)),
          Effect.orElseSucceed(() => undefined),
        );
    // Only NUL framing keeps a newline in a worktree path. Pre-2.36 Git rejects `-z`.
    const listed =
      (yield* listWorktrees(["-z"])) ?? (yield* listWorktrees([]))?.replaceAll("\n", "\0");
    if (listed === undefined) return [];
    const realCwd = yield* Effect.promise(() => NodeFSP.realpath(cwd).catch(() => cwd));
    const worktreeRoots = listed.split("\0\0").flatMap((record) => {
      const fields = record.split("\0");
      const worktree = fields.find((field) => field.startsWith("worktree "));
      // A `prunable` record's directory is gone; another checkout may now sit there.
      if (worktree === undefined || fields.some((field) => field.startsWith("prunable"))) return [];
      const root = worktree.slice("worktree ".length);
      const relativeRoot = path.relative(realCwd, root);
      return relativeRoot === "" ||
        relativeRoot === ".." ||
        relativeRoot.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeRoot)
        ? []
        : [relativeRoot.split(path.sep).join("/")];
    });
    const matches = yield* Effect.promise(() =>
      Promise.all(
        worktreeRoots.map(async (relativeRoot) => {
          const candidate = `${relativeRoot}/${relativePath}`;
          const stat = await NodeFSP.stat(path.join(realCwd, candidate)).catch(() => null);
          return stat?.isFile() ? candidate : null;
        }),
      ),
    );
    return matches
      .filter((candidate) => candidate !== null)
      .map((candidate): ProjectEntry => ({ path: candidate, kind: "file" }));
  });

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    if (yield* walksPluginRepository(normalizedCwd))
      return yield* new WorkspaceEntriesSearchUnavailableError({ cwd: normalizedCwd });
    const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content");
    markSearched(indexKey, yield* Clock.currentTimeMillis);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(Effect.provide(workspaceSearchIndexes.get(indexKey)));
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      if (input.directoryPath !== undefined) {
        const directoryPath = input.directoryPath;
        const toError = (cause: unknown) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: directoryPath,
            parentPath: path.resolve(normalizedCwd, directoryPath),
            cause,
          });
        const target =
          directoryPath === ""
            ? { absolutePath: normalizedCwd, relativePath: "" }
            : yield* workspacePaths
                .resolveRelativePathWithinRoot({
                  workspaceRoot: normalizedCwd,
                  relativePath: directoryPath,
                })
                .pipe(Effect.mapError(toError));
        const { entries, throughSymlink, nestedGitRoots } = yield* Effect.tryPromise({
          try: async () => {
            const root = await NodeFSP.realpath(normalizedCwd);
            const directory = await NodeFSP.realpath(target.absolutePath);
            const relative = path.relative(root, directory);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes(".git") ||
              target.relativePath.split("/").includes(".git")
            ) {
              throw new Error("Directory must be inside the workspace and outside .git.");
            }
            const children = await NodeFSP.readdir(directory, { withFileTypes: true });
            const isSameOrInside = (parent: string, child: string) => {
              const relativeChild = path.relative(parent, child);
              return (
                relativeChild !== ".." &&
                !relativeChild.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relativeChild)
              );
            };
            // Reject canonical ancestors so "Expand all folders" cannot follow a cycle.
            let visitedFolders: Promise<ReadonlyArray<string>> | undefined;
            const loadVisitedFolders = () =>
              (visitedFolders ??= (async () => {
                const folders = [root];
                let current = normalizedCwd;
                for (const segment of target.relativePath.split("/").filter(Boolean)) {
                  current = path.join(current, segment);
                  folders.push(await NodeFSP.realpath(current));
                }
                return folders;
              })());
            const resolveSymlinkKind = async (
              name: string,
            ): Promise<ProjectEntry["kind"] | undefined> => {
              const resolved = await NodeFSP.realpath(path.join(directory, name)).catch(
                () => undefined,
              );
              if (
                resolved === undefined ||
                !isSameOrInside(root, resolved) ||
                path.relative(root, resolved).split(path.sep).includes(".git")
              ) {
                return undefined;
              }
              const stat = await NodeFSP.stat(resolved).catch(() => undefined);
              if (stat?.isFile()) return "file";
              if (!stat?.isDirectory()) return undefined;
              const folders = await loadVisitedFolders();
              return folders.some((folder) => isSameOrInside(resolved, folder))
                ? undefined
                : "directory";
            };
            // Bound filesystem work for directories such as pnpm node_modules.
            const kinds: Array<ProjectEntry["kind"] | undefined> = [];
            for (let offset = 0; offset < children.length; offset += SYMLINK_RESOLVE_BATCH_SIZE) {
              kinds.push(
                ...(await Promise.all(
                  children
                    .slice(offset, offset + SYMLINK_RESOLVE_BATCH_SIZE)
                    .map(async (child): Promise<ProjectEntry["kind"] | undefined> => {
                      if (child.name === ".git") return undefined;
                      if (child.isDirectory()) return "directory";
                      if (child.isFile()) return "file";
                      return child.isSymbolicLink() ? resolveSymlinkKind(child.name) : undefined;
                    }),
                )),
              );
            }
            const nestedGitRoots: Array<string> = [];
            const segments = target.relativePath.split("/").filter(Boolean);
            for (let index = 1; index <= segments.length; index += 1) {
              const candidate = segments.slice(0, index).join("/");
              const dotGit = await NodeFSP.lstat(path.join(normalizedCwd, candidate, ".git")).catch(
                () => null,
              );
              if (dotGit) nestedGitRoots.push(candidate);
            }
            return {
              nestedGitRoots,
              entries: children.flatMap((child, index): ProjectEntry[] => {
                const kind = kinds[index];
                if (kind === undefined) return [];
                return [
                  {
                    path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name,
                    kind,
                  },
                ];
              }),
              // Git refuses to classify paths beyond a symbolic link.
              throughSymlink: relative !== target.relativePath.split("/").join(path.sep),
            };
          },
          catch: toError,
        });
        // Atelier fork: a Git repository around a VCS plugin's checkout does not decide what the
        // plugin's files are; only one nested inside the folder does. Its tree is never opened
        // whole, so clients do not offer to.
        // A checkout among this folder's own, at any depth, stops a walk before it goes in.
        const pluginRepository = yield* inPluginRepository(normalizedCwd);
        const walk =
          pluginRepository ||
          (yield* containsPluginCheckout(normalizedCwd)) ||
          (yield* holdsMarkedFolder(normalizedCwd, entries))
            ? { treeWalkUnavailable: true }
            : {};
        if (nestedGitRoots.length === 0 && pluginRepository)
          return { entries, truncated: false, ...walk };
        let gitRoot = "";
        let gitPrefix = "";
        // stdin avoids argument limits; ignore classification is optional without git/repositories.
        const checkIgnore = (paths: ReadonlyArray<string>) =>
          vcsProcess
            .run({
              operation: "WorkspaceEntries.list",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              cwd: path.join(normalizedCwd, gitRoot),
              stdin: `${paths.map((entryPath) => entryPath.slice(gitPrefix.length)).join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
        // Git refuses paths inside a submodule (128) but still answers for nested clones.
        for (const nestedGitRoot of nestedGitRoots) {
          if ((yield* checkIgnore([`${nestedGitRoot}/.git`]))?.exitCode !== 128) continue;
          gitRoot = nestedGitRoot;
          gitPrefix = `${gitRoot}/`;
        }
        const directoryGitPath = target.relativePath.slice(gitPrefix.length);
        // Check ignored folders once to avoid child index lookups; exit 0 guarantees no tracked descendants.
        // Symlinks and pathspec magic still need per-child checks.
        if (
          entries.length > IGNORE_CHECK_CHUNK_SIZE &&
          directoryGitPath !== "" &&
          !throughSymlink &&
          !/^:|[*?[\\]/.test(directoryGitPath) &&
          (yield* checkIgnore([target.relativePath]))?.exitCode === 0
        ) {
          return {
            entries: entries.map((entry) => ({ ...entry, ignored: true })),
            truncated: false,
            ...walk,
          };
        }
        const ignored = new Set<string>();
        for (let offset = 0; offset < entries.length; offset += IGNORE_CHECK_CHUNK_SIZE) {
          const result = yield* checkIgnore(
            entries.slice(offset, offset + IGNORE_CHECK_CHUNK_SIZE).map((entry) => entry.path),
          );
          if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
          for (const ignoredPath of result.stdout.split("\0")) ignored.add(gitPrefix + ignoredPath);
        }
        return {
          entries: entries.map((entry) =>
            ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
          ),
          truncated: false,
          ...walk,
        };
      }
      // The whole tree at once; one folder at a time, above, reads only that folder.
      if (yield* walksPluginRepository(normalizedCwd)) return { entries: [], truncated: false };
      const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths");
      markSearched(indexKey, yield* Clock.currentTimeMillis);
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(Effect.provide(workspaceSearchIndexes.get(indexKey)));
    },
  );

  const listIgnoredFiles: WorkspaceEntries["Service"]["listIgnoredFiles"] = Effect.fn(
    "WorkspaceEntries.listIgnoredFiles",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    // Atelier fork: a Git repository around a VCS plugin's checkout would list its whole tree.
    if (yield* walksPluginRepository(normalizedCwd)) return { files: [], truncated: false };
    // `--directory` reports a folder holding nothing but ignored files as one
    // `name/` entry, which is how `node_modules` and build output drop out.
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceEntries.listIgnoredFiles",
        command: "git",
        args: [
          "-c",
          "core.fsmonitor=false",
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "--no-empty-directory",
          "-z",
        ],
        cwd: normalizedCwd,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!result || result.exitCode !== 0) return { files: [], truncated: false };
    // Filter before the cap so files sorting past it stay reachable by search.
    const query = input.query?.toLowerCase() ?? "";
    const paths = result.stdout
      .split("\0")
      .filter(
        (entry) => entry.length > 0 && !entry.endsWith("/") && entry.toLowerCase().includes(query),
      )
      .toSorted();
    const files = yield* Effect.promise(() =>
      Promise.all(
        paths.slice(0, IGNORED_FILES_LIMIT).map(async (relativePath) => {
          // lstat: a symlink usually points outside the workspace, where reads refuse to go.
          const stat = await NodeFSP.lstat(path.join(normalizedCwd, relativePath)).catch(
            () => null,
          );
          return stat?.isFile() ? { path: relativePath, byteLength: stat.size } : null;
        }),
      ),
    );
    return {
      files: files.filter((file) => file !== null),
      truncated: paths.length > IGNORED_FILES_LIMIT,
    };
  });

  return WorkspaceEntries.of({ browse, list, listIgnoredFiles, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
);
