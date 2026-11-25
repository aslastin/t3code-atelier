import { GitCommandError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { nativeRealPathWithMissingTail } from "../nativeRealPath.ts";

// A setup can wait for a choice before the thread has a durable worktree binding.
const pending = new Set<{ root: string; threadId: ThreadId }>();
export function trackPendingWorktree(root: string, threadId: ThreadId) {
  const entry = { root, threadId };
  pending.add(entry);
  return () => pending.delete(entry);
}
export const pendingWorktrees = () => pending.values();

// Call under an exclusive workspace reservation, immediately before removing the checkout.
export const makeWorktreeUseGuard = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const path = yield* Path.Path;
  return Effect.fn("WorktreeUsage.ensureUnused")(function* (root: string, owner?: ThreadId) {
    const refuse = (detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: "WorktreeUsage.ensureUnused",
        cwd: root,
        command: "git worktree remove",
        detail,
        cause,
      });
    const check = Effect.gen(function* () {
      const physical = yield* nativeRealPathWithMissingTail(root);
      const contains = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return (
          relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        );
      };
      const occupies = (folder: string) =>
        contains(root, folder)
          ? Effect.succeed(true)
          : nativeRealPathWithMissingTail(folder).pipe(
              Effect.map((resolved) => contains(physical, resolved)),
            );
      for (const entry of pendingWorktrees())
        if (entry.threadId !== owner && (yield* occupies(entry.root)))
          return "Another thread is preparing this worktree.";
      const bindings = yield* projections.getThreadWorktreePaths({ includeArchived: true });
      for (const binding of bindings)
        if (binding.threadId !== owner && (yield* occupies(binding.worktreePath)))
          return "Another thread uses this worktree.";
      for (const project of yield* projects.listShells())
        if (yield* occupies(project.workspaceRoot)) return "A project uses this worktree.";
      return null;
    });
    const reason = yield* check.pipe(
      Effect.mapError((cause) =>
        refuse("Could not check which projects or threads use this worktree.", cause),
      ),
    );
    if (reason) return yield* refuse(reason);
  });
});
