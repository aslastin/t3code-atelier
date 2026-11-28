import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

/**
 * Atelier fork: whether `root` holds a repository (a marker, or a bare Git repository) or another
 * file system mounted below it. The walk stops at the first one, so a mount is neither read
 * through nor deleted with the folder. A folder it cannot read counts as holding one.
 */
export const holdsRepository = Effect.fn("holdsRepository")(
  function* (
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    root: string,
    markers: ReadonlyArray<string>,
    // Off for walks that only guard plugin checkouts and mounts: a `.git` folder holds HEAD,
    // objects and refs too. It is still walked for mounts inside it.
    options: { readonly bareRepositories?: boolean } = {},
  ) {
    const bareRepositories = options.bareRepositories !== false;
    // The parent's device, so `root` that is itself a mount counts too.
    const device = (yield* fileSystem.stat(path.dirname(root))).dev;
    if ((yield* fileSystem.stat(root)).dev !== device) return true;
    const queue = [root];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const folder = next;
      const entries = yield* fileSystem.readDirectory(folder);
      const names = new Set(entries.map((entry) => entry.toLowerCase()));
      // A bare repository: HEAD beside its objects and refs.
      if (bareRepositories && names.has("head") && names.has("objects") && names.has("refs"))
        return true;
      for (const marker of markers) {
        if (!names.has(marker.split("/")[0]!.toLowerCase())) continue;
        if (!marker.includes("/")) return true;
        if (yield* fileSystem.exists(path.join(folder, marker))) return true;
      }
      for (const entry of entries) {
        const child = path.join(folder, entry);
        if (Option.isSome(yield* fileSystem.readLink(child).pipe(Effect.option))) continue;
        const info = yield* fileSystem.stat(child);
        if (info.type !== "Directory") continue;
        if (info.dev !== device) return true;
        queue.push(child);
      }
    }
    return false;
  },
  Effect.orElseSucceed(() => true),
);
