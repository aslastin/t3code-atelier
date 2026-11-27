// @effect-diagnostics nodeBuiltinImport:off - Fixtures build plugin folders with symlinks.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  checkpointStrategies,
  classifyExecutable,
  readManifest,
  renderArgv,
  usesPlaceholder,
} from "./pluginManifest.ts";
import { writeFakeVcsPlugin } from "./testing/fakeVcsPlugin.ts";

describe("pluginManifest", () => {
  it("resolves ./ in the plugin folder, bare names on PATH, and refuses other paths", () => {
    assert.deepStrictEqual(classifyExecutable("./bin/tool.mjs"), {
      kind: "plugin",
      relativePath: "bin/tool.mjs",
    });
    assert.deepStrictEqual(classifyExecutable("myvcs"), { kind: "path", name: "myvcs" });
    for (const refused of ["/usr/bin/myvcs", "C:\\tools\\myvcs.exe", "bin/tool", "./../tool", "./"])
      assert.strictEqual(classifyExecutable(refused).kind, "invalid", refused);
  });

  it("fills placeholders inside one argument and reports the first without a value", () => {
    assert.deepStrictEqual(
      renderArgv(["myvcs", "show", "{revision}:{path}", "--file", "{messageFile}"], {
        revision: "abc",
        path: "dir/a b.txt",
        messageFile: "/tmp/message",
      }),
      { argv: ["myvcs", "show", "abc:dir/a b.txt", "--file", "/tmp/message"] },
    );
    // A value with spaces or a shell character stays one argument.
    assert.deepStrictEqual(renderArgv(["x", "{path}"], { path: "a; rm -rf /" }), {
      argv: ["x", "a; rm -rf /"],
    });
    assert.deepStrictEqual(renderArgv(["x", "{path}", "{newRef}"], { path: "p" }), {
      missing: "newRef",
    });
    // Doubled braces are literal, so a CLI's own `@{upstream}` needs no wrapper.
    assert.deepStrictEqual(renderArgv(["x", "@{{upstream}}", "{{desc}}"], {}), {
      argv: ["x", "@{upstream}", "{desc}"],
    });
    assert.isFalse(usesPlaceholder(["x", "{{pathsFile}}"], "pathsFile"));
  });

  it.effect("names every rule a manifest breaks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = writeFakeVcsPlugin(yield* fs.makeTempDirectoryScoped(), {
        id: "git",
        checkpoints: ["native", "native", "full"],
        extraManifest: {
          check: ["/usr/bin/kite", "{path}"],
          detect: { markers: ["../.kite/HEAD", " .kite/HEAD", "./.kite/HEAD", ".kite\\HEAD"] },
          icon: "../icon.svg",
        },
      });
      const { manifest: decoded, errors } = yield* readManifest(fs, path, directory);
      assert.isNull(decoded);
      assert.deepStrictEqual(errors, [
        'id: "git" is reserved.',
        "check: the command is an absolute path; use ./ or a name from PATH.",
        "check: {path} is not available here.",
        'detect.markers: "../.kite/HEAD" must be a path inside the repository folder, with no spaces around it and `/` between folders.',
        'detect.markers: " .kite/HEAD" must be a path inside the repository folder, with no spaces around it and `/` between folders.',
        'detect.markers: "./.kite/HEAD" must be a path inside the repository folder, with no spaces around it and `/` between folders.',
        'detect.markers: ".kite\\HEAD" must be a path inside the repository folder, with no spaces around it and `/` between folders.',
        "icon: must be an .svg file inside the plugin folder.",
        "checkpoints: each strategy can be listed once.",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("picks strategies from the commands, and notes what it ignores", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = writeFakeVcsPlugin(yield* fs.makeTempDirectoryScoped());
      const read = (edit: (manifest: Record<string, any>) => void) => {
        const manifest = JSON.parse(NodeFS.readFileSync(`${directory}/plugin.json`, "utf8"));
        edit(manifest);
        NodeFS.writeFileSync(`${directory}/plugin.json`, JSON.stringify(manifest));
        return readManifest(fs, path, directory);
      };

      // Every strategy the commands allow, native first; full only when listed.
      const full = yield* read(() => {});
      assert.deepStrictEqual(checkpointStrategies(full.manifest!), ["native", "changed-files"]);

      // Only `check` and `status`: valid, with no checkpoints.
      const minimal = yield* read((manifest) => {
        manifest.commands = { status: manifest.commands.status };
      });
      assert.deepStrictEqual(minimal.errors, []);
      assert.deepStrictEqual(checkpointStrategies(minimal.manifest!), []);

      // A field, a command, or a strategy this server does not know still loads, with a note.
      const unknown = yield* read((manifest) => {
        manifest.capabilities = { worktrees: true };
        manifest.commands.worktreeLst = manifest.commands.status;
        manifest.checkpoints = ["future", "full"];
      });
      assert.deepStrictEqual(unknown.errors, []);
      assert.deepStrictEqual(checkpointStrategies(unknown.manifest!), ["full"]);
      assert.deepStrictEqual(unknown.notes, [
        "capabilities: not a field this server knows; ignored.",
        "commands.worktreeLst: not a command this server knows; ignored.",
        'checkpoints: "future" is not a strategy this server knows; skipped.',
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("rejects a ./ command that a symlink points outside the plugin folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { checkPluginFiles } = yield* Effect.promise(() => import("./pluginManifest.ts"));
      const outside = yield* fs.makeTempDirectoryScoped();
      NodeFS.writeFileSync(`${outside}/evil.mjs`, "");
      const directory = writeFakeVcsPlugin(yield* fs.makeTempDirectoryScoped());
      NodeFS.rmSync(`${directory}/bin/kite.mjs`);
      NodeFS.symlinkSync(`${outside}/evil.mjs`, `${directory}/bin/kite.mjs`);
      const { manifest } = yield* readManifest(fs, path, directory);
      const errors = yield* checkPluginFiles(fs, path, directory, manifest!);
      assert.include(errors[0] ?? "", "./bin/kite.mjs is not a file inside the plugin folder.");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
