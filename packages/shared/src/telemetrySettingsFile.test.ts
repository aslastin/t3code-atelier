import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { follow } from "./telemetrySettingsFile.ts";

it.effect("detects an atomic save to the settings symlink target while export is off", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const settings = path.join(directory, "settings.json");
    const external = yield* fs.makeTempDirectoryScoped();
    const target = path.join(external, "settings.json");
    const replacement = path.join(external, "next.json");
    const write = (file: string, enabled: boolean) =>
      fs.writeFileString(
        file,
        JSON.stringify({
          observability: { telemetry: { enabled, otlp: true, analytics: false, connect: false } },
        }),
      );
    yield* write(target, false);
    yield* fs.symlink(target, settings);
    const enabled = yield* Deferred.make<void>();
    let latest: boolean | undefined;
    const refresh = yield* follow(settings, (state) => {
      latest = state.telemetry?.enabled;
      if (latest) Deferred.doneUnsafe(enabled, Effect.void);
    });
    assert.isFalse(latest);
    yield* write(replacement, true);
    yield* fs.rename(replacement, target);
    yield* TestClock.adjust("3 seconds");
    yield* Deferred.await(enabled);
    yield* write(target, false);
    yield* refresh;
    assert.isFalse(latest);
    yield* fs.remove(target);
    yield* refresh;
    assert.isFalse(latest);
    yield* fs.remove(settings);
    yield* refresh;
    assert.isUndefined(latest);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "recognizes an environment-only receiver when the WSL state directory becomes available",
  () =>
    Effect.gen(function* () {
      const dir = String.raw`\\wsl.localhost\Ubuntu\home\user\.t3\userdata`;
      let available = false;
      const started = yield* Deferred.make<void>();
      const missing = FileSystem.makeNoop({});
      const fs = FileSystem.makeNoop({
        stat: (file) =>
          missing.stat(file).pipe(Effect.ensuring(Deferred.succeed(started, undefined))),
        exists: (file) => Effect.sync(() => file === dir && available),
      });
      let enabled: boolean | undefined;
      yield* follow(dir + "\\settings.json", (state) => {
        enabled = state.telemetry?.enabled ?? true;
      }).pipe(Effect.asVoid, Effect.provideService(FileSystem.FileSystem, fs));
      yield* Deferred.await(started);
      yield* TestClock.adjust("3 seconds");
      assert.isFalse(enabled);
      available = true;
      yield* TestClock.adjust("3 seconds");
      assert.isTrue(enabled);
    }).pipe(Effect.provide(NodePath.layerWin32)),
);
