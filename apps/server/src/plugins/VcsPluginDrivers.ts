import type { VcsDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Stream from "effect/Stream";

import type * as VcsDriver from "../vcs/VcsDriver.ts";

/** The drivers of available VCS plugins, for the driver registry. */
export class VcsPluginDrivers extends Context.Service<
  VcsPluginDrivers,
  {
    /** Waits for the checks the server started with. */
    readonly current: Effect.Effect<ReadonlyMap<VcsDriverKind, VcsDriver.VcsDriver["Service"]>>;
    /** Any plugin installed and enabled, available or not yet checked. */
    readonly hasAny: () => boolean;
    /** Marker paths of every available plugin, for walks that look for a checkout root. */
    readonly markers: () => ReadonlyArray<string>;
    /**
     * Marker paths of every installed plugin, off or unavailable too, for checks that must not
     * mistake a plugin checkout for a stray folder.
     */
    readonly installedMarkers: () => ReadonlyArray<string>;
    /**
     * Available plugins in the order the driver registry tries them: the first whose marker a
     * folder holds owns it.
     */
    readonly available: () => ReadonlyArray<{
      readonly markers: ReadonlyArray<string>;
      readonly worktrees: boolean;
    }>;
    /** An available plugin's name, and whether it can bring back a worktree cleanup removed. */
    readonly describe: (kind: string) =>
      | {
          readonly label: string;
          readonly recreatesWorktrees: boolean;
          readonly markers: ReadonlyArray<string>;
        }
      | undefined;
    /** Emits after a plugin is checked, imported, turned on or off, or removed. */
    readonly changes: Stream.Stream<void>;
  }
>()("t3/plugins/VcsPluginDrivers") {}

/**
 * Whether an installed plugin's marker is in `cwd` or a physical parent before any `.git`. Such a
 * checkout is the plugin's even while the plugin is off, so Git never treats it as its own.
 */
export const pluginMarksBeforeGit = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  markers: ReadonlyArray<string>,
  // What else ends the search, nearer than a marker: `.git` unless told otherwise.
  others: ReadonlyArray<string> = [".git"],
) {
  if (markers.length === 0) return false;
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  let folder = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  while (true) {
    for (const marker of markers) if (yield* exists(path.join(folder, marker))) return true;
    for (const other of others) if (yield* exists(path.join(folder, other))) return false;
    const parent = path.dirname(folder);
    if (parent === folder) return false;
    folder = parent;
  }
});
