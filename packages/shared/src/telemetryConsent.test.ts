import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/observability";
import {
  bindExporter,
  ExportChannel,
  resolveTelemetry,
  switchingTracer,
} from "./telemetryConsent.ts";

it("preserves an explicit OTLP destination and applies each external restriction to its own channels", () => {
  const limits = {
    endpoint: false,
    connect: true,
    sdk: false,
    t3: true,
    pending: false,
    managed: false,
  };
  const fresh = resolveTelemetry(undefined, limits);
  assert.isFalse(fresh.preferences.enabled);
  assert.equal(fresh.analytics, "off");
  assert.equal(fresh.connect, "off");
  assert.equal(fresh.otlp, "noEndpoint");
  const migrated = resolveTelemetry(undefined, { ...limits, endpoint: true });
  assert.deepEqual(migrated.preferences, {
    enabled: true,
    otlp: true,
    connect: false,
    analytics: false,
  });
  const all = { enabled: true, otlp: true, connect: true, analytics: true };
  for (const [override, t3, connect, otlp] of [
    [{ t3: false }, "environment", "environment", "on"],
    [{ managed: true }, "policy", "policy", "on"],
    [{ sdk: true }, "on", "sdk", "sdk"],
    [{ pending: true }, "pending", "pending", "on"],
    [{ connect: false }, "on", "unavailable", "on"],
  ] as const) {
    const state = resolveTelemetry(all, { ...limits, endpoint: true, ...override });
    assert.deepEqual([state.analytics, state.connect, state.otlp], [t3, connect, otlp]);
  }
});

it.effect(
  "revoking an exporter discards its queued spans, retry and final flush across re-enabling",
  () =>
    Effect.gen(function* () {
      const channel = new ExportChannel();
      const url = "http://localhost/v1/traces";
      const sent: string[] = [];
      const failed = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          sent.push(
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
          );
          if (sent.length === 1) yield* Deferred.succeed(failed, undefined);
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: sent.length === 1 ? 503 : 200 }),
          );
        }),
      );
      yield* Effect.gen(function* () {
        channel.set(url);
        let builds = 0;
        const read = yield* bindExporter(channel, (endpoint) =>
          OtlpTracer.make({
            url: endpoint,
            resource: { serviceName: "test" },
            exportInterval: "1 hour",
          }).pipe(
            Effect.tap(() => (++builds === 2 ? Deferred.succeed(ready, undefined) : Effect.void)),
          ),
        );
        const span = (name: string) =>
          Effect.void.pipe(Effect.withSpan(name), Effect.withTracer(switchingTracer(read)));
        const { flush } = yield* OtlpExporter.Flusher;
        yield* span("first-attempt");
        const sending = yield* Effect.forkChild(flush);
        yield* Deferred.await(failed);
        yield* span("queued-before-revocation");
        channel.set();
        yield* span("while-disabled");
        channel.set(url);
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(sending);
        yield* Deferred.await(ready);
        yield* span("fresh-consent");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            OtlpExporter.layerFlusher,
            OtlpSerialization.layerJson,
            Layer.succeed(HttpClient.HttpClient, http),
          ),
        ),
      );
      assert.lengthOf(sent, 2);
      assert.include(sent[0]!, "first-attempt");
      assert.include(sent[1]!, "fresh-consent");
      assert.notMatch(sent[1]!, /first-attempt|queued-before-revocation|while-disabled/);
    }),
);
