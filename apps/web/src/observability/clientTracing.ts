import * as Effect from "effect/Effect";
import { bindExporter, ExportChannel, switchingTracer } from "@t3tools/shared/telemetryConsent";
import type { ServerObservability } from "@t3tools/contracts";
import { relayTelemetryEnabled, resolveRelayTracingConfig } from "../cloud/publicConfig";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/observability";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { releaseChannelOf, releaseResourceAttributes } from "@t3tools/shared/releaseResource";
import * as ClientTracer from "./clientTracer";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";
import { isElectron } from "../env";
import { APP_VERSION } from "~/branding";

const DEFAULT_EXPORT_INTERVAL_MS = 1_000;
interface NavigatorUserAgentData {
  readonly platform: string;
  readonly mobile: boolean;
  readonly brands: ReadonlyArray<{ readonly brand: string; readonly version: string }>;
}

/**
 * The `browser.*` and `user_agent.original` attributes the OpenTelemetry browser
 * resource detector reports. `userAgentData` exists only in Chromium, which
 * includes the desktop app.
 */
const browserResourceAttributes = (): Record<string, unknown> => {
  if (typeof navigator === "undefined") return {};
  const userAgentData = (navigator as Navigator & { userAgentData?: NavigatorUserAgentData })
    .userAgentData;
  return {
    "user_agent.original": navigator.userAgent,
    "browser.language": navigator.language,
    ...(userAgentData && {
      "browser.platform": userAgentData.platform,
      "browser.mobile": userAgentData.mobile,
      "browser.brands": userAgentData.brands.map(({ brand, version }) => `${brand} ${version}`),
    }),
  };
};

// PR previews can't mark themselves in APP_VERSION without breaking the version-skew check against the server.
const RELEASE_CHANNEL =
  import.meta.env.DEV || import.meta.env.VITE_RELEASE_CHANNEL === "dev"
    ? "dev"
    : import.meta.env.VITE_RELEASE_CHANNEL === "preview"
      ? "preview"
      : releaseChannelOf(APP_VERSION);
const CLIENT_TRACING_RESOURCE = {
  serviceName: "t3code-web",
  attributes: {
    "service.namespace": "t3code",
    "service.instance.id": ClientTracer.serviceInstanceId,
    ...releaseResourceAttributes(RELEASE_CHANNEL),
    "service.runtime": "t3-web",
    "t3code.client.surface": isElectron ? "desktop" : "web",
    "service.version": APP_VERSION,
    ...browserResourceAttributes(),
  },
} as const;

const layerDelegateRuntime = Layer.mergeAll(
  PrimaryEnvironmentHttpLayer.layer,
  OtlpExporter.layerFlusher,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const traces = new ExportChannel();
export const connect = new ExportChannel();

export function configureClientTracing(state?: ServerObservability) {
  const status = state?.telemetry;
  const forward = status?.otlp === "on" && state?.otlpTracesEnabled;
  traces.set(
    status && (state?.localTracingEnabled || forward)
      ? resolvePrimaryEnvironmentHttpUrl("/api/observability/v1/traces")
      : undefined,
    forward ? (status.revisions?.otlp ?? 0) : undefined,
  );
  connect.set(
    (status?.rendererConnect ?? status?.connect) === "on" && relayTelemetryEnabled() === true
      ? resolveRelayTracingConfig()?.tracesUrl
      : undefined,
    status?.revisions?.connect,
  );
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const read = yield* bindExporter(traces, (url, revision) =>
      OtlpTracer.make({
        url,
        headers: { "x-t3-telemetry-revision": revision === undefined ? "local" : String(revision) },
        exportInterval: `${DEFAULT_EXPORT_INTERVAL_MS} millis`,
        resource: CLIENT_TRACING_RESOURCE,
      }),
    );
    ClientTracer.setDelegate(switchingTracer(read));
    yield* Effect.addFinalizer(() => Effect.sync(() => ClientTracer.setDelegate(null)));
  }),
).pipe(Layer.provide(layerDelegateRuntime));
