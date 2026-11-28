import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProjectTrackedFolder,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TaskFolders from "./TaskFolders.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";

export const taskFoldersTestProjectId = ProjectId.make("project:task-folders");

/** What the mocked stores answer with; a test fills it in once its folders exist. */
export interface TaskFoldersTestState {
  workspaceRoot: string;
  trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
  thread: { worktreePath: string | null; branch: string | null } | null;
  /** The worktrees a VCS plugin lists for its repository. */
  pluginWorktrees?: ReadonlyArray<string>;
  /** The local refs a VCS plugin lists, and the worktrees it was asked to create. */
  pluginRefs?: ReadonlyArray<{ readonly name: string; readonly isDefault?: boolean }>;
  pluginCreated?: Array<{ readonly path: string; readonly refName: string }>;
  /** The branch a VCS plugin names instead of the one asked for. */
  pluginNamesBranch?: string;
  /** Checkouts whose plugin status fails, as one whose store is gone. */
  brokenCheckouts?: ReadonlyArray<string>;
}

/**
 * The real service and record over real Git, for tests that create and remove worktrees. The
 * workflow service only adds settings lookups on top of the driver, so the driver stands in.
 */
export const layerTaskFoldersWithGit = (state: TaskFoldersTestState) => {
  const layerWorkflow = Layer.unwrap(
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const succeeds = (cwd: string, args: ReadonlyArray<string>) =>
        git
          .execute({ operation: "task-folders-test", cwd, args, allowNonZeroExit: true })
          .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));
      // A Kite repository, marked by `.kite/HEAD`, answers through its plugin instead of Git.
      const isKite = (cwd: string) =>
        fs.exists(`${cwd}/.kite/HEAD`).pipe(Effect.orElseSucceed(() => false));
      const markedKind = Effect.fnUntraced(function* (cwd: string) {
        for (const kind of ["kite", "other"]) {
          if (yield* fs.exists(`${cwd}/.${kind}/HEAD`).pipe(Effect.orElseSucceed(() => false)))
            return kind as never;
        }
        return "git" as never;
      });
      return Layer.mock(GitWorkflowService.GitWorkflowService)({
        createWorktree: (input, options) =>
          Effect.gen(function* () {
            if (!(yield* isKite(input.cwd))) return yield* git.createWorktree(input, options);
            const path = input.path!;
            (state.pluginCreated ??= []).push({ path, refName: input.refName });
            yield* fs.makeDirectory(`${path}/.kite`, { recursive: true }).pipe(Effect.orDie);
            yield* fs
              .writeFileString(`${path}/.kite/HEAD`, `${input.newRefName}\n`)
              .pipe(Effect.orDie);
            return {
              worktree: {
                path,
                refName: state.pluginNamesBranch ?? input.newRefName ?? input.refName,
              },
            };
          }),
        listRefs: () => Effect.sync(() => ({ refs: state.pluginRefs ?? [] }) as never),
        removeWorktree: git.removeWorktree,
        deleteLocalBranch: git.deleteLocalBranch,
        listLocalBranchNames: (cwd) =>
          Effect.gen(function* () {
            if (yield* isKite(cwd)) return (state.pluginRefs ?? []).map((ref) => ref.name);
            return yield* git.listLocalBranchNames(cwd);
          }),
        pruneWorktrees: git.pruneWorktrees,
        renameBranch: git.renameBranch,
        canRenameBranch: (cwd) => Effect.map(isKite(cwd), (kite) => !kite),
        fetchWorktreeBaseCommit: git.fetchWorktreeBaseCommit,
        hasCommit: ({ cwd, refName }) =>
          Effect.gen(function* () {
            if (yield* isKite(cwd)) {
              // As the workflow service asks a plugin: its local and remote refs by name.
              const name = /^refs\/(?:heads|remotes)\/(.+)$/.exec(refName)?.[1];
              return (
                name === undefined || (state.pluginRefs ?? []).some((ref) => ref.name === name)
              );
            }
            return (
              (yield* succeeds(cwd, [
                "rev-parse",
                "--verify",
                "--quiet",
                `${refName}^{commit}`,
              ])) !== null
            );
          }),
        currentBranch: (cwd) => succeeds(cwd, ["symbolic-ref", "--short", "--quiet", "HEAD"]),
        listWorktrees: () => Effect.sync(() => state.pluginWorktrees ?? []),
        // The VCS a folder answers to, by the marker a test gave it.
        vcsKind: (cwd) => markedKind(cwd),
        localStatus: ({ cwd }) =>
          (state.brokenCheckouts ?? []).includes(cwd)
            ? Effect.fail("its store is gone" as never)
            : Effect.map(markedKind(cwd), (kind) => ({ capabilities: { kind } }) as never),
      });
    }),
  );
  const project = () => ({
    projectId: taskFoldersTestProjectId,
    title: "Shop",
    hasCustomTitle: false,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    deletedAt: null,
    workspaceRoot: state.workspaceRoot,
    trackedFolders: state.trackedFolders,
  });
  return TaskFolders.layer.pipe(
    Layer.provideMerge(TaskFolderStore.layer),
    Layer.provide(layerWorkflow),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeedSome(project()),
          findActiveByWorkspaceRoot: (workspaceRoot) =>
            Effect.succeed(
              workspaceRoot === state.workspaceRoot ? Option.some(project()) : Option.none(),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed(
              state.thread === null
                ? null
                : ({
                    projectId: taskFoldersTestProjectId,
                    ...state.thread,
                  } as OrchestrationV2ThreadShell),
            ),
        }),
        ServerSettings.layerTest(),
        SqlitePersistence.layerMemory,
        VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
};
