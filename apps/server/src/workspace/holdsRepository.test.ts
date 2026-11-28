import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { holdsRepository } from "./holdsRepository.ts";

it.layer(NodeServices.layer)("holdsRepository", (it) => {
  it.effect("stops at a plugin's checkout or a mount, and can leave Git's to its owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-holds-repository-" });
      yield* fs.makeDirectory(path.join(root, "notes"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "clone", ".git", "objects"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "clone", ".git", "refs"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "clone", ".git", "HEAD"), "ref: main\n");
      const gitless = { bareRepositories: false };
      // A Git clone counts only where Git's checkouts are not the caller's to delete.
      assert.isTrue(yield* holdsRepository(fs, path, root, [".git"]));
      assert.isFalse(yield* holdsRepository(fs, path, root, [".kite/HEAD"], gitless));
      yield* fs.makeDirectory(path.join(root, "notes", "mono", ".kite"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "notes", "mono", ".kite", "HEAD"), "main\n");
      assert.isTrue(yield* holdsRepository(fs, path, root, [".kite/HEAD"], gitless));
      yield* fs.remove(path.join(root, "notes", "mono"), { recursive: true });
      // Another file system mounted below, at `.git`, or at the root itself is never walked into.
      const mountedAt = (mount: string) =>
        FileSystem.FileSystem.of({
          ...fs,
          stat: (target) =>
            fs
              .stat(target)
              .pipe(
                Effect.map((info) =>
                  target === mount || target.startsWith(`${mount}/`)
                    ? { ...info, dev: info.dev + 1n }
                    : info,
                ),
              ),
        });
      for (const mount of [
        path.join(root, "notes"),
        path.join(root, "clone", ".git"),
        path.join(root, "clone", ".git", "objects"),
        root,
      ]) {
        assert.isTrue(yield* holdsRepository(mountedAt(mount), path, root, [], gitless));
      }
    }).pipe(Effect.scoped),
  );
});
