import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { VcsPluginDrivers } from "../plugins/VcsPluginDrivers.ts";
import { worktreeRootForProject } from "./worktreeProjectPath.ts";

it.effect("finds a VCS plugin's checkout root by the markers of the running plugins", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-" }));
    const repository = path.join(base, "repo");
    const worktree = path.join(base, "worktrees", "feature");
    for (const root of [repository, worktree]) {
      yield* fs.makeDirectory(path.join(root, ".kite"), { recursive: true });
      yield* fs.writeFileString(path.join(root, ".kite", "HEAD"), "main\n");
      yield* fs.makeDirectory(path.join(root, "app"));
    }
    const find = worktreeRootForProject(
      fs,
      path,
      path.join(worktree, "app"),
      path.join(repository, "app"),
    );

    assert.strictEqual(yield* find, path.join(worktree, "app"));
    assert.strictEqual(
      yield* find.pipe(
        Effect.provideService(VcsPluginDrivers, {
          hasAny: () => true,
          markers: () => [".kite/HEAD"],
        } as unknown as VcsPluginDrivers["Service"]),
      ),
      worktree,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
