// @effect-diagnostics nodeBuiltinImport:off - Fixtures edit a fake repository directly.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CheckpointRef, VcsDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as PluginService from "./PluginService.ts";
import { fakeCalls, makeFakeRepository, writeFakeVcsPlugin } from "./testing/fakeVcsPlugin.ts";
import type { FakeVcsPluginOptions } from "./testing/fakeVcsPlugin.ts";
import { VcsPluginDrivers } from "./VcsPluginDrivers.ts";

const KITE = VcsDriverKind.make("kite");
const ref = (name: string) => CheckpointRef.make(`refs/t3/checkpoints/test/${name}`);

/** A T3 home with the Kite plugin imported, and a Kite repository to run it in. */
const setup = Effect.fn("test.setup")(function* (options: FakeVcsPluginOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-home-" });
  const source = writeFakeVcsPlugin(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-source-" }),
    options,
  );
  const repository = makeFakeRepository(
    yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-kite-repo-" })),
    { "a.txt": "one\n", "sub/b.txt": "two\n" },
  );
  const context = yield* Layer.build(
    PluginService.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provide(ServerConfig.layerTest(home, home)),
    ),
  );
  const plugins = Context.get(context, PluginService.PluginService);
  const drivers = Context.get(context, VcsPluginDrivers);
  const imported = yield* plugins.importFolder(source);
  const driver = (yield* drivers.current).get(KITE);
  // The strategy each checkpoint was taken with, from the fork's table.
  const strategies = Effect.gen(function* () {
    const sql = Context.get(context, SqlClient.SqlClient);
    const rows = yield* sql<{ readonly strategy: string }>`
      SELECT strategy FROM atelier_vcs_plugin_checkpoints ORDER BY checkpoint_ref
    `;
    return rows.map((row) => row.strategy);
  });
  return { plugins, imported, driver, repository, home, source, path, strategies };
});

const layer = NodeServices.layer;

describe("PluginService", () => {
  it.live("imports a plugin, checks it, and serves its driver", () =>
    Effect.gen(function* () {
      const { imported, driver, home, plugins } = yield* setup();
      const [summary] = imported.plugins;
      assert.strictEqual(summary?.status, "available");
      assert.strictEqual(summary?.version, "1.2.3");
      assert.deepStrictEqual(summary?.checkpoints, ["changed-files"]);
      assert.include(summary?.iconSvg ?? "", "<svg");
      assert.isTrue(NodeFS.existsSync(`${home}/plugins/kite/plugin.json`));
      assert.isDefined(driver);

      // Disable and Remove are the way back out.
      const disabled = yield* plugins.setEnabled("kite", false);
      assert.strictEqual(disabled.plugins[0]?.status, "disabled");
      const removed = yield* plugins.remove("kite");
      assert.deepStrictEqual(removed.plugins, []);
      assert.isFalse(NodeFS.existsSync(`${home}/plugins/kite`));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("marks a plugin unavailable when its check reports problems", () =>
    Effect.gen(function* () {
      const { imported, driver } = yield* setup({ problem: "Sign in with kite login." });
      assert.strictEqual(imported.plugins[0]?.status, "unavailable");
      assert.deepStrictEqual(imported.plugins[0]?.problems, ["Sign in with kite login."]);
      // Its repositories stay undetected.
      assert.isUndefined(driver);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("refuses a manifest whose command escapes the plugin folder", () =>
    Effect.gen(function* () {
      const error = yield* setup({
        extraManifest: { check: ["./../outside.mjs"] },
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "PluginError");
      assert.include(error.message, "check:");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("shows output that breaks the contract as the plugin's last error", () =>
    Effect.gen(function* () {
      const { driver, repository, plugins } = yield* setup({ statusCommand: "bad-status" });
      const failure = yield* driver!.workflow!.status!({ cwd: repository }).pipe(Effect.flip);
      assert.strictEqual(failure.vcs, KITE);
      const listed = yield* plugins.list;
      assert.strictEqual(listed.plugins[0]?.lastError?.operation, "status");
      assert.include(listed.plugins[0]?.lastError?.message ?? "", "t3-plugin/1");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

describe("ManifestVcsDriver", () => {
  it.live("detects by marker and reads status", () =>
    Effect.gen(function* () {
      const { driver, repository } = yield* setup();
      NodeFS.writeFileSync(`${repository}/a.txt`, "changed\n");
      const identity = yield* driver!.detectRepository(`${repository}/sub`);
      assert.strictEqual(identity?.rootPath, repository);
      const status = yield* driver!.workflow!.status!({ cwd: `${repository}/sub` });
      assert.strictEqual(status.refName, "main");
      assert.deepStrictEqual(
        status.workingTree.files.map((file) => file.path),
        ["a.txt"],
      );
      assert.isTrue(status.hasWorkingTreeChanges);

      const committed = yield* driver!.workflow!.commit!({
        cwd: `${repository}/sub`,
        commitMessage: "Change a\n\nBody",
      });
      assert.deepStrictEqual(committed, {
        status: "created",
        commitSha: "kite-1",
        subject: "Change a",
      });
      const after = yield* driver!.workflow!.status!({ cwd: repository });
      assert.isFalse(after.hasWorkingTreeChanges);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("creates a worktree where T3 puts it, keeps the project subfolder, and removes it", () =>
    Effect.gen(function* () {
      const { driver, repository, home } = yield* setup();
      const workflow = driver!.workflow!;
      const created = yield* workflow.createWorktree!({
        cwd: `${repository}/sub`,
        refName: "main",
        newRefName: "t3code/feature",
        path: null,
      });
      const { worktree } = created;
      assert.isTrue(worktree.path.startsWith(`${home}/worktrees/`));
      assert.strictEqual(worktree.refName, "t3code/feature");
      assert.strictEqual(worktree.projectPath, `${worktree.path}/sub`);
      assert.deepStrictEqual(yield* workflow.listWorktrees!({ cwd: repository }), [worktree.path]);

      // Callers pass the thread's folder, the subfolder; the whole checkout goes, as with Git.
      yield* workflow.removeWorktree!({ cwd: `${repository}/sub`, path: worktree.projectPath! });
      assert.isFalse(NodeFS.existsSync(worktree.path));
      assert.deepStrictEqual(yield* workflow.listWorktrees!({ cwd: repository }), []);

      // Brought back on the branch it had, as T3 Code does after cleanup removed a worktree.
      yield* workflow.pruneWorktrees!({ cwd: `${repository}/sub` });
      const restored = yield* workflow.createWorktree!({
        cwd: `${repository}/sub`,
        refName: "t3code/feature",
        path: worktree.path,
      });
      assert.strictEqual(restored.worktree.refName, "t3code/feature");
      assert.strictEqual(
        NodeFS.readFileSync(`${worktree.path}/.kite/HEAD`, "utf8").trim(),
        "t3code/feature",
      );
      assert.include(fakeCalls(repository), `worktree-attach ${worktree.path} t3code/feature`);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("captures, diffs and restores native snapshots", () =>
    Effect.gen(function* () {
      const { driver, repository } = yield* setup({ checkpoints: ["native"] });
      const checkpoints = driver!.checkpoints;
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("0") });
      NodeFS.writeFileSync(`${repository}/a.txt`, "edited\n");
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("1") });

      const diff = { cwd: repository, fromCheckpointRef: ref("0"), toCheckpointRef: ref("1") };
      const patch = yield* checkpoints.diffCheckpoints({ ...diff, ignoreWhitespace: false });
      assert.include(patch, "+edited");
      const numstat = yield* checkpoints.diffCheckpoints({
        ...diff,
        ignoreWhitespace: false,
        format: "numstat",
      });
      assert.strictEqual(numstat, "1\t1\ta.txt\0");

      assert.isTrue(
        yield* checkpoints.restoreCheckpoint({ cwd: repository, checkpointRef: ref("0") }),
      );
      assert.strictEqual(NodeFS.readFileSync(`${repository}/a.txt`, "utf8"), "one\n");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("never uses a strategy the plugin does not list", () =>
    Effect.gen(function* () {
      // No `checkpoints` field: only changed-files, never native and never full.
      const { driver, repository, strategies } = yield* setup();
      yield* driver!.checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("0") });
      const calls = fakeCalls(repository);
      assert.isFalse(calls.some((call) => call.startsWith("snapshot")));
      assert.isTrue(calls.includes("changed"));
      assert.deepStrictEqual(yield* strategies, ["changed-files"]);

      // A failing listed strategy does not fall back to full either.
      const nativeOnly = yield* setup({ checkpoints: ["native"] });
      NodeFS.writeFileSync(`${nativeOnly.repository}/.kite/broken-snapshots`, "");
      yield* nativeOnly
        .driver!.checkpoints.captureCheckpoint({
          cwd: nativeOnly.repository,
          checkpointRef: ref("0"),
        })
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* nativeOnly.strategies, []);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("falls through when a native snapshot does not read back", () =>
    Effect.gen(function* () {
      const { driver, repository } = yield* setup({ checkpoints: ["native", "changed-files"] });
      NodeFS.writeFileSync(`${repository}/.kite/broken-snapshots`, "");
      yield* driver!.checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("0") });
      const calls = fakeCalls(repository);
      assert.deepStrictEqual(
        calls.map((call) => call.split(" ")[0]),
        ["snapshot", "snapshot-diff", "changed"],
      );
      assert.isTrue(
        yield* driver!.checkpoints.hasCheckpointRef({ cwd: repository, checkpointRef: ref("0") }),
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live(
    "keeps a thread on the strategy it fell back to, so its checkpoints stay comparable",
    () =>
      Effect.gen(function* () {
        const { driver, repository, strategies } = yield* setup({
          checkpoints: ["native", "changed-files"],
        });
        const checkpoints = driver!.checkpoints;
        const broken = `${repository}/.kite/broken-snapshots`;
        NodeFS.writeFileSync(broken, "");
        yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("0") });
        // Native works again, but the thread's next checkpoint stays on changed-files.
        NodeFS.rmSync(broken);
        NodeFS.writeFileSync(`${repository}/a.txt`, "edited\n");
        yield* checkpoints.captureCheckpoint({
          cwd: repository,
          checkpointRef: ref("1"),
          previousCheckpointRef: ref("0"),
        });
        assert.deepStrictEqual(yield* strategies, ["changed-files", "changed-files"]);
        const patch = yield* checkpoints.diffCheckpoints({
          cwd: repository,
          fromCheckpointRef: ref("0"),
          toCheckpointRef: ref("1"),
          ignoreWhitespace: false,
        });
        assert.include(patch, "+edited");
        // A new thread, with no previous checkpoint, tries native first again.
        yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("2") });
        assert.deepStrictEqual(yield* strategies, ["changed-files", "changed-files", "native"]);
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("leaves the turn without a checkpoint, and says why, when no strategy works", () =>
    Effect.gen(function* () {
      const { driver, repository } = yield* setup({ checkpoints: ["native"] });
      NodeFS.writeFileSync(`${repository}/.kite/broken-snapshots`, "");
      const error = yield* driver!.checkpoints
        .captureCheckpoint({ cwd: repository, checkpointRef: ref("0") })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "VcsUnsupportedOperationError");
      const detail = error._tag === "VcsUnsupportedOperationError" ? error.detail : "";
      // The turn shows this note; paths and process details stay in the server log.
      assert.include(detail, "`native`: `checkpointDiff` exited with code 1.");
      assert.notInclude(detail, repository);
      assert.isFalse(
        yield* driver!.checkpoints.hasCheckpointRef({ cwd: repository, checkpointRef: ref("0") }),
      );

      const none = yield* setup({ checkpoints: [] });
      const unlisted = yield* none
        .driver!.checkpoints.captureCheckpoint({ cwd: none.repository, checkpointRef: ref("0") })
        .pipe(Effect.flip);
      assert.include(
        unlisted._tag === "VcsUnsupportedOperationError" ? unlisted.detail : "",
        "lists no checkpoint strategy",
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("changed-files reads only the paths the plugin lists", () =>
    Effect.gen(function* () {
      const { driver, repository } = yield* setup({ checkpoints: ["changed-files"] });
      const checkpoints = driver!.checkpoints;
      // Unreadable and unchanged: reading it would fail the capture.
      NodeFS.writeFileSync(`${repository}/.kite/base/secret.bin`, "base");
      NodeFS.writeFileSync(`${repository}/secret.bin`, "base");
      NodeFS.chmodSync(`${repository}/secret.bin`, 0o000);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.chmodSync(`${repository}/secret.bin`, 0o644)),
      );

      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("0") });
      NodeFS.writeFileSync(`${repository}/a.txt`, "edited\n");
      NodeFS.rmSync(`${repository}/sub/b.txt`);
      NodeFS.mkdirSync(`${repository}/fresh/deep`, { recursive: true });
      NodeFS.writeFileSync(`${repository}/fresh/deep/c.txt`, "new\n");
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("1") });

      const patch = yield* checkpoints.diffCheckpoints({
        cwd: repository,
        fromCheckpointRef: ref("0"),
        toCheckpointRef: ref("1"),
        ignoreWhitespace: false,
      });
      assert.include(patch, "+edited");
      assert.include(patch, "+new");
      assert.include(patch, "-two");
      // Only the files the older side left unchanged came from readFile.
      assert.deepStrictEqual(
        fakeCalls(repository).filter((call) => call.startsWith("show")),
        ["show base-1 a.txt", "show base-1 sub/b.txt"],
      );

      assert.isTrue(
        yield* checkpoints.restoreCheckpoint({ cwd: repository, checkpointRef: ref("0") }),
      );
      assert.strictEqual(NodeFS.readFileSync(`${repository}/a.txt`, "utf8"), "one\n");
      assert.strictEqual(NodeFS.readFileSync(`${repository}/sub/b.txt`, "utf8"), "two\n");
      assert.isFalse(NodeFS.existsSync(`${repository}/fresh`));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("full stages the whole folder, but never the VCS's own metadata", () =>
    Effect.gen(function* () {
      const { driver, repository } = yield* setup({ checkpoints: ["full"] });
      const checkpoints = driver!.checkpoints;
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("0") });
      NodeFS.writeFileSync(`${repository}/a.txt`, "edited\n");
      NodeFS.writeFileSync(`${repository}/new.txt`, "new\n");
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("1") });
      const patch = yield* checkpoints.diffCheckpoints({
        cwd: repository,
        fromCheckpointRef: ref("0"),
        toCheckpointRef: ref("1"),
        ignoreWhitespace: false,
      });
      assert.include(patch, "b/new.txt");
      assert.notInclude(patch, ".kite/");
      yield* checkpoints.restoreCheckpoint({ cwd: repository, checkpointRef: ref("0") });
      assert.strictEqual(NodeFS.readFileSync(`${repository}/a.txt`, "utf8"), "one\n");
      assert.isFalse(NodeFS.existsSync(`${repository}/new.txt`));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
