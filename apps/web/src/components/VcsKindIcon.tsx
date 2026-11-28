import { GIT_VCS_KIND, type EnvironmentId, type PluginSummary } from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { GitBranchIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { pluginEnvironment } from "../state/plugins";
import { useEnvironmentQuery } from "../state/query";

// Atelier fork: a branch in a VCS plugin's repository shows that plugin's icon, so a folder with
// both `.git` and another VCS's metadata says which one T3 Code picked.

/** The VCS plugin that owns a repository, by the driver kind its status reports. */
export function useVcsPlugin(environmentId: EnvironmentId, kind: string | undefined) {
  const list = useEnvironmentQuery(
    kind === undefined || kind === GIT_VCS_KIND
      ? null
      : pluginEnvironment.list({ environmentId, input: {} }),
    useMessages(),
  );
  return list.data?.plugins.find((plugin) => plugin.id === kind) ?? null;
}

/** The branch icon, or the plugin's own icon when a VCS plugin owns the repository. Callers name it. */
export function VcsKindIcon({
  plugin,
  className,
}: {
  readonly plugin: PluginSummary | null;
  readonly className?: string;
}) {
  if (plugin?.iconSvg == null)
    return <GitBranchIcon className={cn("size-3 shrink-0", className)} />;
  return (
    <img
      alt=""
      className={cn("size-3 shrink-0", className)}
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(plugin.iconSvg)}`}
    />
  );
}
