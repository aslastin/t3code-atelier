import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { resolveWorkspaceLocation } from "./workspaceLease.ts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";

export const relativeProjectFolder = Effect.fn("relativeProjectFolder")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  projectCwd: string,
) {
  if (path.relative(repositoryRoot, projectCwd) === "") return "";
  return path.relative(yield* fs.realPath(repositoryRoot), yield* fs.realPath(projectCwd));
});

export const worktreeProjectFolder = Effect.fn("worktreeProjectFolder")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, relative: string, worktreeRoot: string) {
    if (!relative) return worktreeRoot;
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return null;
    const folder = path.join(worktreeRoot, relative);
    const realRoot = yield* fs.realPath(worktreeRoot);
    // A different branch can replace a project directory with a symlink.
    if (path.relative(realRoot, yield* fs.realPath(folder)) !== relative) return null;
    return (yield* fs.stat(folder)).type === "Directory" ? folder : null;
  },
  Effect.orElseSucceed(() => null),
);

// A removed checkout has no gitfile. Match the source project's subfolder component by component
// so recovery can find the same root, while a stored checkout root keeps its original meaning.
export const worktreeRootForProject = Effect.fn("worktreeRootForProject")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    folder: string,
    projectCwd: string | Effect.Effect<string | undefined>,
    isManagedRoot?: (candidate: string) => Effect.Effect<boolean>,
    /** Marker paths of VCS plugins, which mark a checkout root as `.git` does. */
    rootMarkers: ReadonlyArray<string> = [],
  ) {
    const resolved = path.resolve(folder);
    if (resolved !== folder) {
      const trailing = folder.slice(resolved.length);
      if (
        !folder.startsWith(resolved) ||
        ![...trailing].every((char) => char === "/" || char === path.sep)
      )
        return folder;
      folder = resolved;
    }
    const hasGit = Effect.fnUntraced(function* (dir: string) {
      if (yield* fs.exists(path.join(dir, ".git"))) return true;
      for (const marker of rootMarkers) {
        if (yield* fs.exists(path.join(dir, marker))) return true;
      }
      return false;
    });
    const gitDirectory = (dir: string) =>
      fs.stat(path.join(dir, ".git")).pipe(
        Effect.flatMap((info) =>
          info.type === "File" && info.size <= 1024n * 1024n
            ? fs.readFileString(path.join(dir, ".git"))
            : Effect.succeed(""),
        ),
        Effect.map((file) => /^gitdir: (.+)$/m.exec(file)?.[1]?.trim() || null),
        Effect.orElseSucceed(() => null),
      );
    const hasMarker = yield* hasGit(folder);
    const moduleDirectory = hasMarker ? yield* gitDirectory(folder) : null;
    if (
      hasMarker &&
      (moduleDirectory === null ||
        !path.normalize(moduleDirectory).split(path.sep).includes("modules"))
    )
      return folder;
    const cwd = typeof projectCwd === "string" ? projectCwd : yield* projectCwd;
    if (cwd === undefined) return folder;
    let source = yield* resolveWorkspaceLocation(fs, path, cwd);
    let target = folder;
    if (yield* hasGit(source)) return folder;
    while (path.relative(path.basename(source), path.basename(target)) === "") {
      if (source === path.dirname(source) || target === path.dirname(target)) break;
      source = path.dirname(source);
      target = path.dirname(target);
      if (yield* hasGit(source)) {
        if (moduleDirectory !== null) {
          const targetGit = (yield* gitDirectory(target)) ?? ".git";
          // Relative gitfiles start at the physical checkout, even when its caller used an alias.
          const modules = path.resolve(yield* fs.realPath(target), targetGit, "modules");
          const child = path.resolve(yield* fs.realPath(folder), moduleDirectory);
          const relative = path.relative(yield* fs.realPath(modules), yield* fs.realPath(child));
          if (
            !relative ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            return folder;
        }
        if ((yield* hasGit(target)) || (isManagedRoot && (yield* isManagedRoot(target))))
          return target;
        break;
      }
      if (yield* hasGit(target)) break;
    }
    return folder;
  },
  (effect, _fs, _path, folder) => effect.pipe(Effect.orElseSucceed(() => folder)),
);

export const restoreWorktreeProjectFolder = Effect.fn("restoreWorktreeProjectFolder")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  folder: string,
) {
  const relative = path.relative(root, folder);
  if (!relative) return;
  const outside = () =>
    new WorkspacePathOutsideRootError({ workspaceRoot: root, relativePath: relative });
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return yield* outside();
  const realRoot = yield* fs.realPath(root);
  let current = realRoot;
  // A branch can replace any ancestor of the missing directory with a symlink.
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!(yield* fs.exists(current))) yield* fs.makeDirectory(current);
    if (
      path.relative(current, yield* fs.realPath(current)) !== "" ||
      (yield* fs.stat(current)).type !== "Directory"
    )
      return yield* outside();
  }
});
