import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:plugins:list",
    tag: WS_METHODS.pluginsList,
  });
  // Serial per environment: an import and a removal of the same plugin must not interleave.
  // A change made elsewhere, such as an import from the command palette, shows in every list.
  const command = <Tag extends (typeof MUTATIONS)[number]>(tag: Tag) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:plugins:${tag}`,
      tag,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    });
  return {
    list,
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
