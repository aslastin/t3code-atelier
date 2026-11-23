import {
  legacyTelemetryPreferences,
  type TelemetryPreferences,
  type TelemetryStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientResponse } from "effect/http";

export class ExportChannel {
  current: { readonly url: string; readonly revision?: number | undefined } | undefined;
  private readonly listeners = new Set<() => void>();

  set(url?: string, revision?: number) {
    if (url === this.current?.url && (!url || revision === this.current?.revision)) return;
    this.current = url ? { url, revision } : undefined;
    for (const notify of this.listeners) notify();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function resolveTelemetry(
  preferences: TelemetryPreferences | undefined,
  limits: {
    endpoint: boolean;
    legacyEndpoint?: boolean;
    connect: boolean;
    sdk: boolean;
    t3: boolean;
    managed: boolean;
    pending: boolean;
  },
): TelemetryStatus {
  const choices =
    preferences ?? legacyTelemetryPreferences(limits.endpoint || limits.legacyEndpoint === true);
  const t3Block = limits.managed
    ? "policy"
    : limits.pending
      ? "pending"
      : !limits.t3
        ? "environment"
        : undefined;
  const selected = (value: boolean) => (choices.enabled && value ? "on" : "off");
  const connect = t3Block ?? (limits.sdk ? "sdk" : selected(choices.connect));
  return {
    preferences: choices,
    rendererConnect: connect,
    analytics: t3Block ?? selected(choices.analytics),
    connect: limits.connect ? connect : "unavailable",
    otlp: limits.sdk ? "sdk" : !limits.endpoint ? "noEndpoint" : selected(choices.otlp),
  };
}

// Each consent period owns a separate SDK buffer. Its transport also checks the lease on every retry and final flush.
export const bindExporter = Effect.fn("Telemetry.bindExporter")(function* <A, R>(
  channel: ExportChannel,
  build: (
    url: string,
    revision?: number,
  ) => Effect.Effect<A, never, R | Scope.Scope | HttpClient.HttpClient>,
  refresh = Effect.void,
) {
  const client = yield* HttpClient.HttpClient;
  const parent = yield* Scope.Scope;
  const changes = yield* Queue.sliding<void>(1);
  let active: { lease: NonNullable<ExportChannel["current"]>; value: A } | undefined;
  let scope: Scope.Closeable | undefined;
  const synchronize = Effect.gen(function* () {
    const lease = channel.current;
    if (active?.lease === lease) return;
    active = undefined;
    if (scope) yield* Scope.close(scope, Exit.void);
    if (!lease) return;
    scope = yield* Scope.fork(parent);
    const guarded = client.pipe(
      HttpClient.transform((send, request) =>
        refresh.pipe(
          Effect.andThen(() =>
            channel.current === lease
              ? send
              : Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
                ),
          ),
        ),
      ),
    );
    const value = yield* build(lease.url, lease.revision).pipe(
      Effect.provideService(HttpClient.HttpClient, guarded),
      Scope.provide(scope),
    );
    active = { lease, value };
  });
  const unsubscribe = channel.subscribe(() => Queue.offerUnsafe(changes, undefined));
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  yield* synchronize;
  yield* Queue.take(changes).pipe(Effect.andThen(synchronize), Effect.forever, Effect.forkScoped);
  return () => (active && active.lease === channel.current ? active.value : undefined);
});

export function switchingTracer(read: () => Tracer.Tracer | undefined) {
  return Tracer.make({ span: (options) => (read() ?? Tracer.nativeTracer).span(options) });
}

export interface TelemetrySettings {
  readonly telemetry?: TelemetryPreferences | undefined;
  readonly telemetryRevisions?: TelemetryStatus["revisions"];
  readonly otlpTracesUrl?: string | undefined;
  readonly otlpMetricsUrl?: string | undefined;
  readonly otlpLogsUrl?: string | undefined;
}
