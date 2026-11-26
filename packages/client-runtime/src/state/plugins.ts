import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

// Atelier fork: VCS plugins installed on an environment. Every call answers with the whole list.

export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // Serial per environment: an import and a removal of the same plugin must not interleave.
  const command = <Tag extends (typeof MUTATIONS)[number]>(tag: Tag) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:plugins:${tag}`,
      tag,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    });
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plugins:list",
      tag: WS_METHODS.pluginsList,
    }),
    importFolder: command(WS_METHODS.pluginsImport),
    remove: command(WS_METHODS.pluginsRemove),
    setEnabled: command(WS_METHODS.pluginsSetEnabled),
    recheck: command(WS_METHODS.pluginsRecheck),
  };
}

const MUTATIONS = [
  WS_METHODS.pluginsImport,
  WS_METHODS.pluginsRemove,
  WS_METHODS.pluginsSetEnabled,
  WS_METHODS.pluginsRecheck,
] as const;
