import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { managedWorktreesDirectories } from "./worktreesDirectory.ts";

it.effect("keeps the T3 home's worktrees managed when new ones go elsewhere", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const settings = { worktreesDirectory: "", previousWorktreesDirectories: [] };
    // T3CODE_WORKTREES_DIR moved new worktrees; the ones made before stay in reach.
    assert.deepStrictEqual(
      managedWorktreesDirectories(
        settings,
        "/home/dev/.t3-dev-worktrees/t3code/feature",
        path,
        "/home/dev",
        "/src/t3code/feature/.t3/worktrees",
      ),
      ["/home/dev/.t3-dev-worktrees/t3code/feature", "/src/t3code/feature/.t3/worktrees"],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
