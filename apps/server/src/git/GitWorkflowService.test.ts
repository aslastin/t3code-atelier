import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  ProjectId,
  VcsDriverKind,
  type VcsStatusResult,
  type VcsDriverCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { testVcsDriver } from "../vcs/testing/testVcsDriver.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("GitWorkflowService", (it) => {
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
      const worktrees = yield* workflow.listWorktrees(cwd);
      assert.deepEqual(worktrees, [yield* fileSystem.realPath(cwd)]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(VcsDriverRegistry.layer),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect("routes status, refs and stacked actions to the selected driver", () =>
    Effect.gen(function* () {
      const cwd = "/test-repo";
      const kind = VcsDriverKind.make("test-vcs");
      const capabilities: VcsDriverCapabilities = {
        kind,
        supportsWorktrees: false,
        supportsBookmarks: true,
        supportsAtomicSnapshot: true,
        supportsCommit: true,
        supportsPush: false,
        supportsPushDefaultRemote: false,
        supportsReviewDiff: false,
        supportsSparseCheckout: false,
        ignoreClassifier: "native",
      };
      const status: VcsStatusResult = {
        isRepo: true,
        isDefaultRef: true,
        refName: "trunk",
        hasPrimaryRemote: false,
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "a.txt", insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 1,
        behindCount: 2,
        pr: null,
      };
      const commits: string[] = [];
      const written: Array<{
        summary: string;
        patch: string;
        subjects: ReadonlyArray<string> | undefined;
        includeBranch: boolean | undefined;
      }> = [];
      const branches: string[] = [];
      const diffPaths: Array<ReadonlyArray<string> | undefined> = [];
      const projects: Array<string | undefined> = [];
      const driver = testVcsDriver({
        capabilities,
        workflow: {
          status: () => Effect.succeed(status),
          switchRef: (input) => Effect.succeed({ refName: input.refName }),
          commit: (input) =>
            Effect.sync(() => {
              commits.push(input.commitMessage ?? "");
              return { status: "created" as const, commitSha: "abc" };
            }),
          workingDiff: (input) =>
            Effect.sync(() => {
              diffPaths.push(input.filePaths);
              return "diff --git a/a.txt b/a.txt";
            }),
          recentCommitSubjects: () => Effect.succeed(["Fix the parser"]),
          listRefs: (input) =>
            Effect.succeed({
              refs:
                input.refKind === "remote"
                  ? [{ name: "origin/trunk", isRemote: true, remoteName: "origin" }]
                  : [{ name: "trunk" }, { name: "feature/change-a-txt" }],
            } as never),
          createBranch: (input) =>
            Effect.sync(() => {
              branches.push(input.refName);
            }),
        },
      });
      const handle = {
        kind,
        driver,
        repository: {
          rootPath: cwd,
          metadataPath: null,
          kind,
          freshness: {
            source: "live-local" as const,
            observedAt: yield* DateTime.now,
            expiresAt: Option.none(),
          },
        },
      };
      const workflow = yield* GitWorkflowService.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              hasAdditionalDrivers: true,
              detect: () => Effect.succeed(handle),
              resolve: () => Effect.succeed(handle),
            }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(GitManager.GitManager)({
              writeCommitMessage: (input) =>
                Effect.sync(() => {
                  projects.push(input.projectId);
                  written.push({
                    summary: input.summary,
                    patch: input.patch,
                    subjects: input.subjects,
                    includeBranch: input.includeBranch,
                  });
                  return {
                    commitMessage: "Change a.txt",
                    ...(input.includeBranch ? { branch: "change-a-txt" } : {}),
                  };
                }),
            }),
          ),
        ),
      );
      assert.deepEqual(yield* workflow.status({ cwd }), { ...status, capabilities });
      assert.deepEqual((yield* workflow.localStatus({ cwd })).capabilities, capabilities);
      assert.equal((yield* workflow.remoteStatus({ cwd }))?.aheadCount, 1);
      assert.equal(yield* workflow.currentBranch(cwd), "trunk");
      assert.deepEqual(yield* workflow.upstreamDivergence(cwd), {
        refName: "trunk",
        aheadCount: 1,
        behindCount: 2,
      });
      assert.isNull(yield* workflow.readRefSnapshot(cwd));
      assert.equal(yield* workflow.repositoryRoot(cwd), cwd);
      assert.deepEqual(yield* workflow.switchRef({ cwd, refName: "topic" }), { refName: "topic" });
      const missing = yield* workflow
        .createWorktree({ cwd, refName: "topic", path: null })
        .pipe(Effect.flip);
      assert.include(missing, { _tag: "VcsUnsupportedOperationError", kind });
      const action = { cwd, actionId: "test", commitMessage: "save" };
      const partial = yield* workflow
        .runStackedAction({ ...action, action: "commit_push" })
        .pipe(Effect.flip);
      assert.include(partial, { _tag: "VcsUnsupportedOperationError", operation: "push", kind });
      assert.deepEqual(commits, []);
      const events: string[] = [];
      const result = yield* workflow.runStackedAction(
        { ...action, action: "commit" },
        {
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event.kind);
              }),
          },
        },
      );
      assert.deepEqual(commits, ["save"]);
      assert.equal(result.commit.commitSha, "abc");
      assert.deepEqual(events, ["action_started", "phase_started", "action_finished"]);

      // Without a typed message, it is written from the driver's status, patch and log, as for Git.
      yield* workflow.runStackedAction({
        cwd,
        actionId: "generated",
        action: "commit",
        projectId: ProjectId.make("project-1"),
      });
      // Committing everything still names the files, for a diff that takes a file list.
      assert.deepEqual(diffPaths, [["a.txt"]]);
      assert.deepEqual(projects, ["project-1"]);
      const writtenFor = (includeBranch: boolean) => ({
        summary: "a.txt (+1 -0)",
        patch: "diff --git a/a.txt b/a.txt",
        subjects: ["Fix the parser"],
        includeBranch,
      });
      assert.deepEqual(written, [writtenFor(false)]);
      assert.deepEqual(commits, ["save", "Change a.txt"]);

      // On a new branch: named with the message, made unique among the driver's refs.
      const onBranch = yield* workflow.runStackedAction({
        cwd,
        actionId: "branch",
        action: "commit",
        featureBranch: true,
      });
      assert.deepEqual(written, [writtenFor(false), writtenFor(true)]);
      assert.deepEqual(branches, ["feature/change-a-txt-2"]);
      assert.deepEqual(onBranch.branch, { status: "created", name: "feature/change-a-txt-2" });
      assert.deepEqual(commits, ["save", "Change a.txt", "Change a.txt"]);
      // A name the plugin could not read back is refused before a branch is started.
      const lineBreak = yield* workflow
        .runStackedAction({
          cwd,
          actionId: "line-break",
          action: "commit",
          featureBranch: true,
          filePaths: ["a\nb.txt"],
          commitMessage: "save",
        })
        .pipe(Effect.flip);
      assert.include(lineBreak, { _tag: "VcsUnsupportedOperationError" });
      assert.deepEqual(branches, ["feature/change-a-txt-2"]);
      // So is one among all the changes, when none are selected.
      const statusFiles = status.workingTree.files;
      (status.workingTree as { files: typeof statusFiles }).files = [
        ...statusFiles,
        { path: "c\nd.txt", insertions: 1, deletions: 0 },
      ];
      const allFiles = yield* workflow
        .runStackedAction({ cwd, actionId: "all", action: "commit", featureBranch: true })
        .pipe(Effect.flip);
      assert.include(allFiles, { _tag: "VcsUnsupportedOperationError" });
      assert.deepEqual(branches, ["feature/change-a-txt-2"]);
      (status.workingTree as { files: typeof statusFiles }).files = statusFiles;

      // A remote-tracking base is checked against the driver's remote refs.
      assert.isTrue(yield* workflow.hasCommit({ cwd, refName: "refs/remotes/origin/trunk" }));
      assert.isFalse(yield* workflow.hasCommit({ cwd, refName: "refs/remotes/origin/gone" }));

      // A driver that commits every change refuses selected files before starting a branch.
      const removed: string[] = [];
      let pendingFiles: VcsStatusResult["workingTree"]["files"] = [];
      const wholeOnly = {
        ...handle,
        driver: testVcsDriver({
          capabilities: { ...capabilities, supportsPartialCommit: false },
          workflow: {
            ...driver.workflow!,
            status: (input) =>
              Effect.sync(() =>
                input.cwd === "/worktrees/topic"
                  ? { ...status, workingTree: { ...status.workingTree, files: pendingFiles } }
                  : status,
              ),
            createWorktree: (input) =>
              Effect.succeed({
                worktree: { path: "/worktrees/topic", projectPath: null, refName: input.refName },
              }),
            removeWorktree: (input) =>
              Effect.sync(() => {
                removed.push(input.path);
              }),
          },
        }),
      };
      const refusingWorkflow = yield* GitWorkflowService.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              hasAdditionalDrivers: true,
              detect: () => Effect.succeed(wholeOnly),
              resolve: () => Effect.succeed(wholeOnly),
            }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(GitManager.GitManager)({}),
          ),
        ),
      );
      const refused = yield* refusingWorkflow
        .runStackedAction({
          cwd,
          actionId: "partial",
          action: "commit",
          featureBranch: true,
          filePaths: ["a.txt"],
          commitMessage: "save",
        })
        .pipe(Effect.flip);
      assert.include(refused, { _tag: "VcsUnsupportedOperationError" });
      assert.deepEqual(branches, ["feature/change-a-txt-2"]);

      // A new checkout without the project's folder lets the launch choose, as for Git.
      let missingFolder:
        | Parameters<NonNullable<GitVcsDriver.CreateWorktreeOptions["onMissingProjectFolder"]>>[0]
        | null = null;
      yield* refusingWorkflow.createWorktree(
        { cwd: `${cwd}/app`, refName: "trunk", newRefName: "topic", path: null },
        {
          onMissingProjectFolder: (input) =>
            Effect.sync(() => {
              missingFolder = input;
            }),
        },
      );
      assert.equal(missingFolder!.root, "/worktrees/topic");
      yield* missingFolder!.verify;
      // Work saved there while the launch waited is never discarded.
      pendingFiles = [{ path: "draft.txt", insertions: 1, deletions: 0 }];
      yield* missingFolder!.discard("topic").pipe(Effect.flip);
      assert.deepEqual(removed, []);
      pendingFiles = [];
      yield* missingFolder!.discard("topic");
      assert.deepEqual(removed, ["/worktrees/topic"]);
      // A branch the plugin keeps would be created again on the retry.
      const kept = yield* missingFolder!.discard("trunk").pipe(Effect.flip);
      assert.include(kept.message, "keeps the branch trunk");
    }),
  );

  it.effect("reads no HEAD path from a removed worktree without spawning Git", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-removed-wt-" });
      const removed = `${parent}/removed`;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.strictEqual(yield* workflow.headPath(removed), null);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ hasAdditionalDrivers: false }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              execute: (input) => Effect.die(`spawned Git in ${input.cwd}`),
            }),
          ),
        ),
      ),
    ),
  );
});
