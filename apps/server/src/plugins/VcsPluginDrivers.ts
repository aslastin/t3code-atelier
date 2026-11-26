import type { VcsDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type * as VcsDriver from "../vcs/VcsDriver.ts";

/** The drivers of available VCS plugins, for the driver registry. */
export class VcsPluginDrivers extends Context.Service<
  VcsPluginDrivers,
  {
    /** Waits for the checks the server started with. */
    readonly current: Effect.Effect<ReadonlyMap<VcsDriverKind, VcsDriver.VcsDriver["Service"]>>;
    /** Any plugin installed and enabled, available or not yet checked. */
    readonly hasAny: () => boolean;
    /** Marker paths of every available plugin, for walks that look for a checkout root. */
    readonly markers: () => ReadonlyArray<string>;
    /** Emits after a plugin is checked, imported, turned on or off, or removed. */
    readonly changes: Stream.Stream<void>;
  }
>()("t3/plugins/VcsPluginDrivers") {}
