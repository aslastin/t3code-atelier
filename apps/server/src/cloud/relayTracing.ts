import * as TelemetrySettingsFile from "@t3tools/shared/telemetrySettingsFile";
import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

/** Relay traces leave the machine for T3 Connect, so a policy with `telemetry: false` stops them. */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const tracingConfig = config.telemetry.relayDestination;
      const policy = yield* ManagedPolicy.ManagedPolicy;
      const denied = ManagedPolicy.deniedBy(policy, "telemetry") !== undefined;
      config.telemetry.setManaged(denied);
      const refresh =
        resource.client === "headless-cli" && tracingConfig
          ? yield* TelemetrySettingsFile.follow(config.settingsPath, (settings) =>
              config.telemetry.update(settings),
            )
          : Effect.void;
      return RelayTracing.layer(
        denied ? null : tracingConfig,
        {
          ...resource,
          serviceInstanceId: processServiceInstanceId(config.otelEnvironment.resourceAttributes),
        },
        { channel: config.telemetry.connect, refresh },
      );
    }),
  );

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
