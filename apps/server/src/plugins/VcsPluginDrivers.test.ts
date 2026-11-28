import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { withoutFirmlink } from "./VcsPluginDrivers.ts";

it.layer(NodeServices.layer)("withoutFirmlink", (it) => {
  it.effect("drops the Data volume prefix only where both spellings are one folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-firm-" }));
      // Paths outside the Data volume, and prefixed ones naming nothing, stay as they are.
      assert.strictEqual(yield* withoutFirmlink(fs, home), home);
      const missing = "/System/Volumes/Data/t3-no-such-folder";
      assert.strictEqual(yield* withoutFirmlink(fs, missing), missing);
      // On macOS a firmlinked temp folder has a prefixed spelling; elsewhere it does not exist.
      const prefixed = `/System/Volumes/Data${home}`;
      if (yield* fs.exists(prefixed))
        assert.strictEqual(yield* withoutFirmlink(fs, prefixed), home);
    }).pipe(Effect.scoped),
  );
});
