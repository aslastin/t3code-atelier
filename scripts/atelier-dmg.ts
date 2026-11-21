#!/usr/bin/env node
// Builds the Atelier DMG as <upstream version>+atelier.<N>; see "Rebuild and update" in ATELIER.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

class AtelierDmgError extends Schema.TaggedError<AtelierDmgError>()("AtelierDmgError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const buildAtelierDmg = Effect.fn("atelier-dmg.build")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = path.dirname(import.meta.dirname);
  const buildNumberPath = path.join(repoRoot, "atelier-build-number");

  const raw = (yield* fs.readFileString(buildNumberPath)).trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    return yield* new AtelierDmgError({
      reason: `${buildNumberPath} must hold a positive integer, found "${raw}".`,
    });
  }
  const version = `${desktopPackageJson.version}+atelier.${raw}`;
  yield* Console.log(`[atelier-dmg] building T3 Code (Atelier) ${version}`);

  const extraArgs = (yield* HostProcess.Arguments).slice(2);
  const exitCode = yield* ChildProcess.make(
    yield* HostProcess.ExecutablePath,
    [
      path.join(repoRoot, "scripts/build-desktop-artifact.ts"),
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--build-version",
      version,
      ...extraArgs,
    ],
    { cwd: repoRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  ).pipe(
    Effect.flatMap((child) => child.exitCode),
    Effect.scoped,
  );
  if (exitCode !== 0) {
    return yield* new AtelierDmgError({ reason: `DMG build failed with exit code ${exitCode}.` });
  }
});

if (import.meta.main) {
  buildAtelierDmg().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
