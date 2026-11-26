import type { PluginSummary } from "@t3tools/contracts";
import { msg, useGT } from "gt-react-native";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";

import { m } from "../../../i18n/messages";
import { useEnvironmentQuery } from "../../../state/query";
import { pluginEnvironment } from "../../../state/plugins";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsProviderRow } from "./SettingsProviderRow";
import { SettingsSection } from "./SettingsSection";

// Atelier fork: the VCS plugins on each environment and whether they work. Importing and removing
// plugins runs commands on the server, so it stays in the web and desktop Settings.

function pluginSummary(plugin: PluginSummary): string {
  if (plugin.problems.length > 0) return plugin.problems.join(" ");
  if (plugin.lastError) return plugin.lastError.message;
  switch (plugin.status) {
    case "disabled":
      return m(msg("Turned off"));
    case "checking":
      return m(msg("Checking…"));
    case "available":
      return plugin.checkpoints.length > 0
        ? m(msg("Checkpoints: {strategies}", { strategies: plugin.checkpoints.join(", ") }))
        : m(msg("No checkpoints: turns in its repositories cannot be diffed or rolled back."));
    default:
      return m(msg("Unavailable"));
  }
}

function EnvironmentPlugins(props: {
  readonly environment: SettingsTarget;
  readonly title: string;
}) {
  const { environmentId } = props.environment;
  const list = useEnvironmentQuery(pluginEnvironment.list({ environmentId, input: {} }));
  const plugins = list.data?.plugins ?? [];
  if (plugins.length === 0) return null;
  return (
    <SettingsSection title={props.title}>
      {plugins.map((plugin, index) => (
        <SettingsProviderRow
          key={plugin.id}
          icon={
            plugin.iconSvg ? (
              <View className="size-[18px]">
                <SvgXml xml={plugin.iconSvg} width="100%" height="100%" />
              </View>
            ) : null
          }
          label={plugin.label}
          detail={plugin.version}
          description={pluginSummary(plugin)}
          ready={plugin.status === "available"}
          separated={index > 0}
        />
      ))}
    </SettingsSection>
  );
}

export function VcsPluginsSection(props: { readonly environments: readonly SettingsTarget[] }) {
  const gt = useGT();
  const environments = props.environments.filter(
    (target) => target.serverConfig.environment.capabilities.vcsPlugins === true,
  );
  return (
    <>
      {environments.map((environment) => (
        <EnvironmentPlugins
          key={environment.environmentId}
          environment={environment}
          title={
            props.environments.length > 1
              ? gt("VCS plugins · {environment}", { environment: environment.label })
              : gt("VCS plugins")
          }
        />
      ))}
    </>
  );
}
