import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import type { ServerObservability } from "@t3tools/contracts";
import {
  ExportChannel,
  resolveTelemetry,
  type TelemetrySettings,
} from "@t3tools/shared/telemetryConsent";
import type { ServerConfig } from "../config.ts";
import { relayClientTracingDestination } from "../cloud/publicConfig.ts";

type Config = Omit<ServerConfig["Service"], "telemetry">;

export class TelemetryControl {
  readonly analytics = new ExportChannel();
  readonly connect = new ExportChannel();
  readonly traces = new ExportChannel();
  readonly metrics = new ExportChannel();
  readonly logs = new ExportChannel();
  private managed = true;
  private readonly limitListeners = new Set<() => void>();
  private lastLimitKey = "";
  readonly #relay;
  #settings: TelemetrySettings;
  readonly #config: Config;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #allowT3: boolean;

  constructor(
    config: Config,
    settings: TelemetrySettings,
    env: Readonly<Record<string, string | undefined>>,
    allowT3 = true,
  ) {
    this.#config = config;
    this.#settings = settings;
    this.#env = env;
    this.#allowT3 = allowT3;
    this.#relay = relayClientTracingDestination(env);
    this.refresh();
  }

  setManaged(denied: boolean) {
    this.managed = denied;
    this.refresh();
  }

  update(settings: TelemetrySettings) {
    this.#settings = settings;
    this.refresh();
  }

  private endpoint(signal: "traces" | "metrics" | "logs", name: "Traces" | "Metrics" | "Logs") {
    const config = this.#config;
    const key = `otlp${name}Url` as const;
    const source = config[`otlp${name}Source`];
    if (source === "environment" || source === "bootstrap")
      return { url: config[key], source, variable: config[`otlp${name}Variable`] };
    const setting = config.otelEnvironment[signal];
    if (setting._tag === "Off")
      return { url: undefined, source: "environment" as const, variable: setting.variable };
    const url = this.#settings[key]?.trim() || undefined;
    return { url, source: url ? ("settings" as const) : undefined, variable: undefined };
  }

  describe() {
    const config = this.#config;
    const traces = this.endpoint("traces", "Traces");
    const metrics = this.endpoint("metrics", "Metrics");
    const logs = this.endpoint("logs", "Logs");
    const sdk = config.otelEnvironment.disabled;
    const preference = this.#env.T3CODE_TELEMETRY_ENABLED?.trim().toLowerCase();
    const status = resolveTelemetry(this.#settings.telemetry, {
      endpoint: Boolean(traces.url || metrics.url || logs.url),
      exportersDisabled: [traces, metrics, logs].every(
        (signal) => signal.source === "environment" && !signal.url,
      ),
      legacyEndpoint: Boolean(
        config.otelEnvironment.hasConfiguredEndpoint ||
        this.#settings.otlpTracesUrl ||
        this.#settings.otlpMetricsUrl ||
        this.#settings.otlpLogsUrl,
      ),
      connect: this.#relay !== null,
      sdk,
      managed: this.managed,
      t3: this.#allowT3 && (!preference || ["true", "1", "yes", "y", "on"].includes(preference)),
      pending: this.#env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1",
    });
    return {
      logsDirectoryPath: config.logsDir,
      localTracingEnabled: true,
      telemetry: {
        ...status,
        ...(config.otelEnvironment.disabledBy
          ? { sdkDisabledBy: config.otelEnvironment.disabledBy }
          : {}),
        ...(this.#settings.telemetryRevisions
          ? { revisions: this.#settings.telemetryRevisions }
          : {}),
      },
      otlpTracesUrl: traces.url,
      otlpTracesSource: traces.source,
      otlpTracesVariable: traces.variable,
      otlpMetricsUrl: metrics.url,
      otlpMetricsSource: metrics.source,
      otlpMetricsVariable: metrics.variable,
      otlpLogsUrl: logs.url,
      otlpLogsSource: logs.source,
      otlpLogsVariable: logs.variable,
      otlpTracesEnabled: !!traces.url && status.otlp === "on",
      otlpMetricsEnabled: !!metrics.url && status.otlp === "on",
      otlpLogsEnabled: !!logs.url && status.otlp === "on",
    } satisfies ServerObservability;
  }

  readonly subscribeLimitChanges = Effect.gen({ self: this }, function* () {
    const queue = yield* Queue.sliding<void>(1);
    const notify = () => Queue.offerUnsafe(queue, undefined);
    yield* Effect.acquireRelease(
      Effect.sync(() => this.limitListeners.add(notify)),
      () => Effect.sync(() => this.limitListeners.delete(notify)),
    );
    return Stream.fromQueue(queue);
  });

  refresh() {
    const limitKey = JSON.stringify([
      this.#env.T3CODE_TELEMETRY_ENABLED,
      this.#env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING,
      this.managed,
    ]);
    const state = this.describe();
    const revisions = this.#settings.telemetryRevisions;
    this.analytics.set(state.telemetry.analytics === "on" ? "analytics" : undefined);
    this.connect.set(
      state.telemetry.connect === "on" ? this.#relay?.tracesUrl : undefined,
      revisions?.connect,
    );
    this.traces.set(state.otlpTracesEnabled ? state.otlpTracesUrl : undefined, revisions?.otlp);
    this.metrics.set(state.otlpMetricsEnabled ? state.otlpMetricsUrl : undefined, revisions?.otlp);
    this.logs.set(state.otlpLogsEnabled ? state.otlpLogsUrl : undefined, revisions?.otlp);
    if (limitKey !== this.lastLimitKey) {
      this.lastLimitKey = limitKey;
      for (const notify of this.limitListeners) notify();
    }
  }
}
