import * as Semaphore from "effect/Semaphore";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import {
  parsePersistedServerObservabilitySettings,
  type PersistedServerObservabilitySettings,
} from "./serverSettings.ts";

// Desktop main and standalone CLI processes do not share the environment's in-memory settings service.
export const follow = Effect.fn("TelemetrySettingsFile.follow")(function* (
  path: string,
  update: (settings: PersistedServerObservabilitySettings) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const refresh = fs.readFileString(path).pipe(
    Effect.map(parsePersistedServerObservabilitySettings),
    Effect.match({
      onSuccess: update,
      onFailure: (cause) =>
        update({
          ...(cause.reason._tag === "NotFound"
            ? {}
            : { telemetry: { enabled: false, analytics: false, connect: false, otlp: false } }),
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpLogsUrl: undefined,
        }),
    }),
    lock.withPermit,
    Effect.withTracerEnabled(false),
  );
  yield* fs.makeDirectory(paths.dirname(path), { recursive: true }).pipe(Effect.ignore);
  yield* fs.watch(paths.dirname(path)).pipe(
    Stream.filter((event) => paths.basename(event.path) === paths.basename(path)),
    Stream.runForEach(() => refresh),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* refresh;
  return refresh;
});
