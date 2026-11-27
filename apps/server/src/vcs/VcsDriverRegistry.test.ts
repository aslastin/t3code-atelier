import { assert, it, describe } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  GIT_VCS_KIND,
  VcsDriverKind,
  VcsProcessExitError,
  VcsProcessSpawnError,
} from "@t3tools/contracts";

import { testVcsDriver } from "./testing/testVcsDriver.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import { VcsPluginDrivers } from "../plugins/VcsPluginDrivers.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

const DETECT_COMMAND = "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir";

describe("VcsDriverRegistry", () => {
  const makeDiskBackedLayer = (
    rootDir: string,
    calls: string[],
    drivers: ReadonlyMap<VcsDriverKind, VcsDriver.VcsDriver["Service"]> = new Map(),
  ) =>
    Layer.effect(
      VcsDriverRegistry.VcsDriverRegistry,
      VcsDriverRegistry.makeWithDrivers(drivers),
    ).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const command = normalizeGitArgs(input.args).join(" ");
              calls.push(command);
              let repoDir: string | null = input.cwd;
              while (repoDir !== null && !(yield* fs.exists(path.join(repoDir, ".git")))) {
                repoDir = repoDir === rootDir ? null : path.dirname(repoDir);
              }
              if (repoDir === null) {
                return {
                  ...processOutput(""),
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stderr: "fatal: not a git repository",
                };
              }
              if (command === DETECT_COMMAND) {
                return processOutput(
                  `true\n${repoDir}\n${path.relative(input.cwd, path.join(repoDir, ".git"))}\n`,
                );
              }
              return processOutput("");
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              Effect.orDie,
            ),
        }),
      ),
    );

  it.effect("detects again when a cached repository is removed from disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);

        yield* fs.remove(path.join(repoDir, ".git"), { recursive: true });

        assert.equal(yield* registry.detect({ cwd: repoDir }), null);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("never hands Git the checkout of an installed plugin that is off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" }),
      );
      yield* fs.makeDirectory(path.join(root, ".git"));
      const checkout = path.join(root, "mono");
      yield* fs.makeDirectory(path.join(checkout, ".kite"), { recursive: true });
      yield* fs.writeFileString(path.join(checkout, ".kite", "HEAD"), "main\n");
      yield* fs.makeDirectory(path.join(checkout, "app"));
      yield* fs.makeDirectory(path.join(root, "web"));
      const calls: string[] = [];
      const pluginOff = Layer.succeed(VcsPluginDrivers, {
        current: Effect.succeed(new Map()),
        hasAny: () => false,
        markers: () => [],
        installedMarkers: () => [".kite/HEAD"],
        available: () => [],
      } as unknown as VcsPluginDrivers["Service"]);

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        // The Git repository around it does not reach into the plugin's checkout.
        assert.equal(yield* registry.detect({ cwd: path.join(checkout, "app") }), null);
        assert.equal(
          (yield* registry.detect({ cwd: path.join(root, "web") }))?.repository.rootPath,
          root,
        );
      }).pipe(Effect.provide(makeDiskBackedLayer(root, calls).pipe(Layer.provide(pluginOff))));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects again when git init creates a repository inside a cached one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const projectDir = path.join(parentDir, "project");
      yield* fs.makeDirectory(path.join(parentDir, ".git"));
      yield* fs.makeDirectory(projectDir);
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: projectDir }))?.repository.rootPath, parentDir);

        yield* fs.makeDirectory(path.join(projectDir, ".git"));

        assert.equal(
          (yield* registry.detect({ cwd: projectDir }))?.repository.rootPath,
          projectDir,
        );
      }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("selects the closest marker, preferring the additional driver at the same root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const nested = path.join(parent, "nested");
      const cwd = path.join(nested, "project");
      yield* fs.makeDirectory(cwd, { recursive: true });
      yield* fs.makeDirectory(path.join(parent, ".git"));
      const kind = VcsDriverKind.make("test-vcs");
      const observedAt = yield* DateTime.now;
      const driver = testVcsDriver({
        detectRepository: () =>
          Effect.gen(function* () {
            for (const rootPath of [nested, parent]) {
              const metadataPath = path.join(rootPath, ".test-head");
              if (yield* fs.exists(metadataPath))
                return {
                  kind,
                  rootPath,
                  metadataPath,
                  freshness: {
                    source: "live-local" as const,
                    observedAt,
                    expiresAt: Option.none(),
                  },
                };
            }
            return null;
          }).pipe(Effect.orDie),
      });
      const offline = VcsDriverKind.make("offline");
      const failure = new VcsProcessSpawnError({
        operation: "detect",
        command: offline,
        cwd,
        cause: "missing executable",
      });
      const drivers = new Map([
        [offline, testVcsDriver({ detectRepository: () => Effect.fail(failure) })],
        [kind, driver],
      ]);
      const calls: string[] = [];
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal(
          yield* registry.detect({ cwd, requestedKind: offline }).pipe(Effect.flip),
          failure,
        );
        assert.equal((yield* registry.resolve({ cwd })).kind, GIT_VCS_KIND);
        yield* fs.writeFileString(path.join(parent, ".test-head"), "main");
        assert.equal((yield* registry.resolve({ cwd })).kind, kind);
        yield* fs.makeDirectory(path.join(nested, ".git"));
        assert.equal((yield* registry.resolve({ cwd })).kind, GIT_VCS_KIND);
        yield* fs.writeFileString(path.join(nested, ".test-head"), "main");
        const probes = calls.length;
        const winner = yield* registry.resolve({ cwd });
        assert.equal(winner.repository.rootPath, nested);
        assert.equal(winner.driver, driver);
        assert.equal(calls.length, probes);
        assert.equal(
          (yield* registry.resolve({ cwd, requestedKind: GIT_VCS_KIND })).kind,
          GIT_VCS_KIND,
        );
        yield* fs.remove(path.join(nested, ".test-head"));
        assert.equal((yield* registry.resolve({ cwd })).kind, GIT_VCS_KIND);
        assert.equal(
          (yield* registry.resolve({ cwd, requestedKind: kind })).repository.rootPath,
          parent,
        );
      }).pipe(Effect.provide(makeDiskBackedLayer(parent, calls, drivers)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects a repository created after a negative lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal(yield* registry.detect({ cwd: repoDir }), null);

        yield* fs.makeDirectory(path.join(repoDir, ".git"));

        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
  const makeFailingLayer = (detectOutput: VcsProcess.VcsProcessOutput) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            normalizeGitArgs(input.args).join(" ") === DETECT_COMMAND
              ? Effect.succeed(detectOutput)
              : Effect.fail(
                  new VcsProcessExitError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    exitCode: 128,
                    detail: "fatal: bad config line 1 in file .git/config",
                  }),
                ),
        }),
      ),
    );

  it.effect("reads only a failed work-tree probe as no repository", () =>
    Effect.gen(function* () {
      const probeFailure = yield* VcsDriverRegistry.VcsDriverRegistry.pipe(
        Effect.flatMap((registry) => registry.detect({ cwd: "/repo" })),
        Effect.provide(
          makeFailingLayer({
            ...processOutput(""),
            exitCode: ChildProcessSpawner.ExitCode(128),
            stderr: "fatal: bad config line 1 in file .git/config",
          }),
        ),
      );
      assert.equal(probeFailure, null);

      // A newline in the root path makes detection ask for it again, and main surfaced that failure.
      const fallbackFailure = yield* VcsDriverRegistry.VcsDriverRegistry.pipe(
        Effect.flatMap((registry) => registry.detect({ cwd: "/repo" })),
        Effect.provide(makeFailingLayer(processOutput("true\n/re\npo\n.git\n"))),
        Effect.flip,
      );
      assert.equal(fallbackFailure._tag, "VcsProcessExitError");
    }),
  );
});
