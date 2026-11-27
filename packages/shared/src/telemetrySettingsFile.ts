import * as Semaphore from "effect/Semaphore";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  parsePersistedServerObservabilitySettings,
  type PersistedServerObservabilitySettings,
} from "./serverSettings.ts";

const empty: PersistedServerObservabilitySettings = {
  otlpTracesUrl: undefined,
  otlpMetricsUrl: undefined,
  otlpLogsUrl: undefined,
};
const disabled = {
  ...empty,
  telemetry: { enabled: false, analytics: false, connect: false, otlp: false },
};

export const reader = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  let cached: { raw: string; settings: PersistedServerObservabilitySettings } | undefined;
  // A missing target behind an existing settings symlink may hold an explicit opt-out.
  const isAbsent = (file: string) =>
    fs.lstat(file).pipe(
      Effect.matchEffect({
        onSuccess: () => Effect.succeed(false),
        onFailure: (error) =>
          error.reason._tag === "NotFound"
            ? fs.exists(paths.dirname(file)).pipe(Effect.orElseSucceed(() => false))
            : Effect.succeed(false),
      }),
    );
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((raw) => {
        if (cached?.raw !== raw)
          cached = { raw, settings: parsePersistedServerObservabilitySettings(raw) };
        return cached.settings;
      }),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? isAbsent(file).pipe(Effect.map((absent) => (absent ? empty : disabled)))
          : Effect.succeed(disabled),
      ),
    );
  return { isAbsent, read };
});

// Desktop main and standalone CLI processes do not share the environment's in-memory settings service.
export const follow = Effect.fn("TelemetrySettingsFile.follow")(function* (
  source: string | SubscriptionRef.SubscriptionRef<string | null>,
  update: (settings: PersistedServerObservabilitySettings) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const { isAbsent, read } = yield* reader;
  const lock = yield* Semaphore.make(1);
  const currentPath = () =>
    typeof source === "string" ? source : SubscriptionRef.getUnsafe(source);
  let previousPath: string | null = null;
  const refresh = Effect.gen(function* () {
    const path = currentPath();
    if (previousPath !== path) {
      update(disabled);
      previousPath = path;
    }
    if (!path) return update(disabled);
    const settings = yield* read(path);
    update(path === currentPath() ? settings : disabled);
  }).pipe(lock.withPermit, Effect.withTracerEnabled(false));
  const watch = (path: string | null) => {
    if (!path) return Stream.make(undefined);
    const unc = path.startsWith("\\\\");
    const changes = fs.watch(paths.dirname(path)).pipe(
      Stream.filter((event) => paths.basename(event.path) === paths.basename(path)),
      Stream.as(undefined),
      Stream.catch(() => Stream.empty),
    );
    // Directory watches can miss replacements behind a symlink or changes from Linux on a WSL share.
    const metadataChanges = Stream.tick("3 seconds").pipe(
      Stream.mapEffect(() =>
        fs.stat(path).pipe(
          Effect.map((info) =>
            [
              info.dev,
              Option.getOrUndefined(info.ino),
              Option.getOrUndefined(info.mtime)?.getTime(),
              info.size,
              info.mode,
            ].join("/"),
          ),
          Effect.catch((error) =>
            error.reason._tag === "NotFound" ? isAbsent(path) : Effect.succeed(false),
          ),
        ),
      ),
      Stream.changes,
    );
    return Stream.concat(
      Stream.fromEffect(
        unc
          ? Effect.void
          : fs.makeDirectory(paths.dirname(path), { recursive: true }).pipe(Effect.ignore),
      ),
      Stream.merge(changes, metadataChanges),
    );
  };
  const files = typeof source === "string" ? Stream.make(source) : SubscriptionRef.changes(source);
  yield* files.pipe(
    Stream.changes,
    Stream.switchMap(watch),
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );
  yield* refresh;
  return refresh;
});
