import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useEnvironments } from "../state/environments";
import { pluginEnvironment } from "../state/plugins";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/**
 * Atelier fork: after a project is added, warns when it sits in a subfolder of a VCS plugin's
 * repository whose only checkpoints are native snapshots, so its turns will get none.
 */
export function useWarnUncheckpointedProject() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const listPlugins = useAtomQueryRunner(pluginEnvironment.list, {
    reportFailure: false,
    refresh: true,
  });
  return (environmentId: EnvironmentId, projectId: string) => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    if (environment?.serverConfig?.environment.capabilities.vcsPlugins !== true) return;
    void listPlugins({ environmentId, input: {} }).then((result) => {
      if (result._tag !== "Success") return;
      for (const plugin of result.value.plugins) {
        const project = plugin.uncheckpointedProjects?.find(
          (entry) => entry.projectId === projectId,
        );
        if (project === undefined) continue;
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: gt("{plugin} cannot checkpoint turns in {project}", {
              plugin: plugin.label,
              project: project.title,
            }),
            description: gt(
              "Its snapshots cover the whole repository, and this project is a subfolder of it, so turns here cannot be diffed or rolled back. Add changed-files to the plugin, or open the repository root as the project.",
            ),
          }),
        );
        return;
      }
    });
  };
}
