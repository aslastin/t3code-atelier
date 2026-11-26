import * as Effect from "effect/Effect";
import * as VcsDriver from "../VcsDriver.ts";

const unexpected = () => Effect.die("Unexpected VCS driver operation");

export function testVcsDriver(overrides: Partial<VcsDriver.VcsDriver["Service"]>) {
  return VcsDriver.VcsDriver.of({
    execute: unexpected,
    detectRepository: unexpected,
    isInsideWorkTree: unexpected,
    listWorkspaceFiles: unexpected,
    listRemotes: unexpected,
    filterIgnoredPaths: unexpected,
    initRepository: unexpected,
    get checkpoints(): VcsDriver.VcsCheckpointOps {
      throw new Error("Unexpected checkpoint operation");
    },
    ...overrides,
  });
}
