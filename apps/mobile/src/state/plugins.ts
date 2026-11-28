import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";

import { connectionAtomRuntime } from "../connection/runtime";

// Atelier fork: VCS plugins, for servers that advertise them.
export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);
