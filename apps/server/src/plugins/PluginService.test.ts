// @effect-diagnostics nodeBuiltinImport:off - Fixtures edit a fake repository directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

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
      SELECT strategy FROM atelier_vcs_plugin_checkpoint_records ORDER BY checkpoint_ref
    `;
    return rows.map((row) => row.strategy);
  });
  const sql = Context.get(context, SqlClient.SqlClient);
  return { plugins, imported, driver, repository, home, source, path, strategies, sql };
});

const layer = NodeServices.layer;

const buildPlugins = (home: string) =>
  Layer.build(
    PluginService.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provide(ServerConfig.layerTest(home, home)),
    ),
  );

it.live("puts back a plugin an interrupted reimport had set aside", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-home-" });
    writeFakeVcsPlugin(`${home}/plugins/.previous-1234`);
    NodeFS.mkdirSync(`${home}/plugins/.import-5678`, { recursive: true });
    const plugins = Context.get(yield* buildPlugins(home), PluginService.PluginService);
    assert.deepStrictEqual(
      (yield* plugins.list).plugins.map((plugin) => plugin.id),
      ["kite"],
    );
    assert.isFalse(NodeFS.existsSync(`${home}/plugins/.import-5678`));
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.live("refuses an import whose check grows the copy past the limits", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-home-" });
    const source = writeFakeVcsPlugin(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-source-" }),
    );
    NodeFS.writeFileSync(`${source}/grow-on-check`, "");
    const plugins = Context.get(yield* buildPlugins(home), PluginService.PluginService);
    const refused = yield* plugins.importFolder(source).pipe(Effect.flip);
    assert.include(refused.detail, "too large");
    assert.isFalse(NodeFS.existsSync(`${home}/plugins/kite`));
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.live("keeps a plugin turned off while its startup check was still running", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-home-" });
    const installed = writeFakeVcsPlugin(`${home}/plugins/kite`);
    NodeFS.writeFileSync(`${installed}/hold-check`, "");
    const context = yield* Layer.build(
      PluginService.layer.pipe(
        Layer.provide(VcsProcess.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(ServerConfig.layerTest(home, home)),
      ),
    );
    const plugins = Context.get(context, PluginService.PluginService);
    yield* plugins.setEnabled("kite", false);
    NodeFS.writeFileSync(`${installed}/release-check`, "");
    yield* Context.get(context, VcsPluginDrivers).current;
    const listed = yield* plugins.list;
    assert.strictEqual(listed.plugins[0]?.status, "disabled");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

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
      NodeFS.writeFileSync(`${repository}/new.txt`, "new\n");
      // A name can start with a space; it is a different file from the trimmed one.
      NodeFS.writeFileSync(`${repository}/ lead.txt`, "lead\n");
      const identity = yield* driver!.detectRepository(`${repository}/sub`);
      assert.strictEqual(identity?.rootPath, repository);
      // An alias inside this repository that points into another belongs to the other one.
      const other = makeFakeRepository(
        NodeFS.realpathSync(NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/t3-kite-other-`)),
        { "sub/c.txt": "three\n" },
      );
      NodeFS.symlinkSync(`${other}/sub`, `${repository}/link`);
      assert.strictEqual((yield* driver!.detectRepository(`${repository}/link`))?.rootPath, other);
      NodeFS.rmSync(`${repository}/link`);
      // An alias whose own parents have no marker still finds the repository it points into.
      const alias = `${NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/t3-kite-alias-`)}/sub`;
      NodeFS.symlinkSync(`${repository}/sub`, alias);
      assert.strictEqual(
        (yield* driver!.detectRepository(alias))?.rootPath,
        NodeFS.realpathSync(repository),
      );
      const status = yield* driver!.workflow!.status!({ cwd: `${repository}/sub` });
      assert.strictEqual(status.refName, "main");
      assert.deepStrictEqual(
        status.workingTree.files.map((file) => [file.path, file.untracked === true]),
        [
          [" lead.txt", true],
          ["a.txt", false],
          ["new.txt", true],
        ],
      );
      assert.isTrue(status.hasWorkingTreeChanges);
      assert.include(
        yield* driver!.workflow!.workingDiff!({ cwd: repository }),
        "diff --git a/a.txt b/a.txt",
      );

      // One path per line: a name with a line break cannot be listed for the plugin.
      const ambiguous = yield* driver!.workflow!.commit!({
        cwd: repository,
        commitMessage: "Nothing",
        filePaths: ["a\nb"],
      }).pipe(Effect.flip);
      assert.include(ambiguous.message, "line break");

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
      assert.deepStrictEqual(yield* driver!.workflow!.recentCommitSubjects!({ cwd: repository }), [
        "Change a",
      ]);
      assert.isTrue(driver!.capabilities?.supportsBranchCreate);
      yield* driver!.workflow!.createBranch!({ cwd: repository, refName: "feature/next" });
      assert.strictEqual(
        (yield* driver!.workflow!.status!({ cwd: repository })).refName,
        "feature/next",
      );
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
      const refs = yield* workflow.listRefs!({ cwd: repository });
      assert.strictEqual(
        refs.refs.find((ref) => ref.name === "t3code/feature")?.worktreePath,
        worktree.path,
      );
      assert.isTrue(refs.isAtRepositoryRoot);
      assert.isFalse((yield* workflow.listRefs!({ cwd: `${repository}/sub` })).isAtRepositoryRoot);
      // The repository itself, and a checkout holding the caller, are never removed.
      const repositoryAlias = `${NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/t3-kite-alias-`)}/repo`;
      NodeFS.symlinkSync(repository, repositoryAlias);
      for (const [cwd, target] of [
        [`${repository}/sub`, repository],
        [`${worktree.path}/sub`, worktree.path],
        // Another spelling of the repository is still the repository.
        [`${repository}/sub`, repositoryAlias],
      ] as const) {
        const refused = yield* workflow.removeWorktree!({ cwd, path: target }).pipe(Effect.flip);
        assert.include(refused.message, "not a worktree");
      }
      assert.isTrue(NodeFS.existsSync(worktree.path));

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

      // An added "++i;" is the hunk line "+++i;", not a file header.
      NodeFS.writeFileSync(`${repository}/a.txt`, "++i;\n");
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("1b") });
      assert.strictEqual(
        yield* checkpoints.diffCheckpoints({
          cwd: repository,
          fromCheckpointRef: ref("1"),
          toCheckpointRef: ref("1b"),
          ignoreWhitespace: false,
          format: "numstat",
        }),
        "1\t1\ta.txt\0",
      );

      // Git quotes a name outside ASCII; the summary still lists it.
      NodeFS.writeFileSync(`${repository}/café.txt`, "new\n");
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("2") });
      const quoted = yield* checkpoints.diffCheckpoints({
        cwd: repository,
        fromCheckpointRef: ref("1b"),
        toCheckpointRef: ref("2"),
        ignoreWhitespace: false,
        format: "numstat",
      });
      assert.strictEqual(quoted, "1\t0\tcafé.txt\0");

      assert.isTrue(
        yield* checkpoints.restoreCheckpoint({ cwd: repository, checkpointRef: ref("0") }),
      );
      assert.strictEqual(NodeFS.readFileSync(`${repository}/a.txt`, "utf8"), "one\n");

      // A snapshot the plugin can no longer read still exists, so a turn start keeps its ref,
      // but it cannot be restored, and its diff says why instead of showing nothing.
      NodeFS.rmSync(`${repository}/.kite/snapshots`, { recursive: true });
      assert.isTrue(
        yield* checkpoints.hasCheckpointRef({ cwd: repository, checkpointRef: ref("1") }),
      );
      assert.isFalse(
        yield* checkpoints.verifyRestorable!({ cwd: repository, checkpointRef: ref("1") }),
      );
      const unreadable = yield* checkpoints
        .diffCheckpoints({ ...diff, ignoreWhitespace: false })
        .pipe(Effect.flip);
      assert.strictEqual(unreadable._tag, "VcsUnsupportedOperationError");
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

  it.live("changed-files restores without writing through links or guessing a deletion", () =>
    Effect.gen(function* () {
      const { driver, repository, sql } = yield* setup({ checkpoints: ["changed-files"] });
      const checkpoints = driver!.checkpoints;
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("0") });

      // a.txt became a link to another tracked file; restoring it must not rewrite that file.
      NodeFS.rmSync(`${repository}/a.txt`);
      NodeFS.symlinkSync(`${repository}/sub/b.txt`, `${repository}/a.txt`);
      yield* checkpoints.restoreCheckpoint({ cwd: repository, checkpointRef: ref("0") });
      assert.strictEqual(NodeFS.readFileSync(`${repository}/sub/b.txt`, "utf8"), "two\n");
      assert.isFalse(NodeFS.lstatSync(`${repository}/a.txt`).isSymbolicLink());
      assert.strictEqual(NodeFS.readFileSync(`${repository}/a.txt`, "utf8"), "one\n");

      // A modified file existed at its base: a failed read stops the restore, nothing is deleted.
      NodeFS.writeFileSync(`${repository}/a.txt`, "edited\n");
      NodeFS.writeFileSync(`${repository}/.kite/broken-show`, "");
      yield* checkpoints
        .restoreCheckpoint({ cwd: repository, checkpointRef: ref("0") })
        .pipe(Effect.flip);
      assert.strictEqual(NodeFS.readFileSync(`${repository}/a.txt`, "utf8"), "edited\n");

      // Another plugin's record for the same ref sits beside this one, never replacing it.
      yield* sql`
        INSERT INTO atelier_vcs_plugin_checkpoint_records
          (repository_root, checkpoint_ref, plugin_id, strategy, revision, created_at)
        SELECT repository_root, checkpoint_ref, 'other', 'native', 'x', created_at
        FROM atelier_vcs_plugin_checkpoint_records
      `;
      assert.isTrue(
        yield* checkpoints.hasCheckpointRef({ cwd: repository, checkpointRef: ref("0") }),
      );
      yield* sql`DELETE FROM atelier_vcs_plugin_checkpoint_records WHERE plugin_id = 'kite'`;
      assert.isFalse(
        yield* checkpoints.hasCheckpointRef({ cwd: repository, checkpointRef: ref("0") }),
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("changed-files restores nothing through a linked folder or into a nested scope", () =>
    Effect.gen(function* () {
      const { driver, repository } = yield* setup({ checkpoints: ["changed-files"] });
      const checkpoints = driver!.checkpoints;
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("0") });

      // A deletion recorded under sub/, then sub/ replaced by a link to another folder.
      NodeFS.rmSync(`${repository}/sub/b.txt`);
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("1") });
      const elsewhere = NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/t3-kite-elsewhere-`);
      NodeFS.writeFileSync(`${elsewhere}/b.txt`, "keep\n");
      NodeFS.rmSync(`${repository}/sub`, { recursive: true });
      NodeFS.symlinkSync(elsewhere, `${repository}/sub`);
      yield* checkpoints
        .restoreCheckpoint({ cwd: repository, checkpointRef: ref("1") })
        .pipe(Effect.flip);
      assert.strictEqual(NodeFS.readFileSync(`${elsewhere}/b.txt`, "utf8"), "keep\n");
      NodeFS.rmSync(`${repository}/sub`);
      NodeFS.mkdirSync(`${repository}/sub`);
      NodeFS.writeFileSync(`${repository}/sub/b.txt`, "two\n");

      // An added folder holding a nested scope loses only its own files.
      NodeFS.mkdirSync(`${repository}/generated/nested`, { recursive: true });
      NodeFS.writeFileSync(`${repository}/generated/own.txt`, "own\n");
      NodeFS.writeFileSync(`${repository}/generated/nested/keep.txt`, "keep\n");
      yield* checkpoints.restoreCheckpoint({
        cwd: repository,
        checkpointRef: ref("0"),
        excludePaths: ["generated/nested"],
      });
      assert.isFalse(NodeFS.existsSync(`${repository}/generated/own.txt`));
      assert.isTrue(NodeFS.existsSync(`${repository}/generated/nested/keep.txt`));

      // Exclusions are relative to the scope's folder.
      yield* checkpoints.captureCheckpoint({ cwd: `${repository}/sub`, checkpointRef: ref("2") });
      NodeFS.writeFileSync(`${repository}/sub/b.txt`, "mine\n");
      yield* checkpoints.restoreCheckpoint({
        cwd: `${repository}/sub`,
        checkpointRef: ref("2"),
        excludePaths: ["b.txt"],
      });
      assert.strictEqual(NodeFS.readFileSync(`${repository}/sub/b.txt`, "utf8"), "mine\n");

      // Files of a moved base cannot be restored, and a rollback learns that up front.
      NodeFS.writeFileSync(`${repository}/.kite/revision`, "base-2");
      assert.isFalse(
        yield* checkpoints.verifyRestorable!({ cwd: repository, checkpointRef: ref("0") }),
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.live("full keeps file bytes the repository's attributes would convert", () =>
    Effect.gen(function* () {
      const { driver, repository } = yield* setup({ checkpoints: ["full"] });
      const checkpoints = driver!.checkpoints;
      NodeFS.writeFileSync(`${repository}/.gitattributes`, "*.txt text eol=lf\n");
      NodeFS.writeFileSync(`${repository}/crlf.txt`, "x\r\n");
      yield* checkpoints.captureCheckpoint({ cwd: repository, checkpointRef: ref("0") });
      NodeFS.writeFileSync(`${repository}/crlf.txt`, "changed\r\n");
      yield* checkpoints.restoreCheckpoint({ cwd: repository, checkpointRef: ref("0") });
      assert.strictEqual(NodeFS.readFileSync(`${repository}/crlf.txt`, "utf8"), "x\r\n");
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

      // A folder that has its own checkpoints now keeps its files, though this snapshot has them.
      NodeFS.writeFileSync(`${repository}/sub/b.txt`, "changed\n");
      yield* checkpoints.restoreCheckpoint({
        cwd: repository,
        checkpointRef: ref("0"),
        excludePaths: ["sub"],
      });
      assert.strictEqual(NodeFS.readFileSync(`${repository}/sub/b.txt`, "utf8"), "changed\n");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
