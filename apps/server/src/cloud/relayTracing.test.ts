import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { relayLayer } from "./relayTracing.ts";

const tracesTo = (policy?: ManagedPolicyDocument) =>
  Effect.service(RelayTracing.RelayClientTracer).pipe(
    Effect.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
      ).pipe(
        Layer.provide(ManagedPolicy.layerTest(policy)),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-tracing-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.map(Option.isSome),
  );

it.effect("a policy with telemetry off stops relay tracing to T3 Connect", () =>
  Effect.gen(function* () {
    assert.isTrue(yield* tracesTo());
    assert.isFalse(
      yield* tracesTo({
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { telemetry: false },
      }),
    );
  }),
);

it.effect(
  "standalone CLI reads its environment's consent and discards traces revoked before exit",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-telemetry-" });
      const base = yield* Effect.service(ServerConfig.ServerConfig).pipe(
        Effect.provide(ServerConfig.layerTest(baseDir, baseDir)),
      );
      const destination = {
        tracesUrl: "https://collector.test/v1/traces",
        tracesToken: "local",
        tracesDataset: "test",
      };
      const config = ServerConfig.make(
        base,
        {},
        {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: destination.tracesUrl,
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: destination.tracesToken,
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: destination.tracesDataset,
        },
      );
      const save = (enabled: boolean, revision: number) =>
        fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            observability: {
              telemetry: { enabled, connect: true, analytics: false, otlp: false },
              telemetryRevisions: { connect: revision, otlp: 0 },
            },
          }),
        );
      const batches: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body._tag === "Uint8Array")
            batches.push(new TextDecoder().decode(request.body.body));
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
        }),
      );
      const cli = relayLayer(
        { client: "headless-cli", serviceName: "test-cli", runtime: "node" },
        destination,
      ).pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      );
      const span = (name: string) =>
        Effect.void.pipe(Effect.withSpan(name), RelayTracing.withRelayClientTracing);
      yield* span("cli-before-consent").pipe(Effect.provide(cli));
      assert.isEmpty(batches);
      yield* save(true, 1);
      yield* Effect.gen(function* () {
        yield* span("cli-revoked");
        yield* save(false, 2);
        yield* save(true, 3);
      }).pipe(Effect.provide(cli));
      assert.isEmpty(batches);
      yield* span("cli-after-consent").pipe(Effect.provide(cli));
      assert.lengthOf(batches, 1);
      assert.include(batches[0]!, "cli-after-consent");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
