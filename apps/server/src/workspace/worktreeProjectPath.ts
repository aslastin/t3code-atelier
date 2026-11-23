import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

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
  ) {
    if (path.resolve(folder) !== folder) return folder;
    const hasGit = (dir: string) => fs.exists(path.join(dir, ".git"));
    if (yield* hasGit(folder)) return folder;
    const cwd = typeof projectCwd === "string" ? projectCwd : yield* projectCwd;
    if (cwd === undefined) return folder;
    let source = yield* fs.realPath(cwd);
    let target = folder;
    if (yield* hasGit(source)) return folder;
    while (path.relative(path.basename(source), path.basename(target)) === "") {
      if (source === path.dirname(source) || target === path.dirname(target)) break;
      source = path.dirname(source);
      target = path.dirname(target);
      if (yield* hasGit(source)) {
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
