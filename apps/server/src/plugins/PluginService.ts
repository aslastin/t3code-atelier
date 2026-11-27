// @effect-diagnostics-next-line nodeBuiltinImport:off -- Random names for staging folders.
import * as NodeCrypto from "node:crypto";

import {
  PLUGIN_MANIFEST_FILE_NAME,
  PluginCheckOutput,
  PluginError,
  type PluginListResult,
  type PluginStatus,
  type PluginSummary,
  type VcsDriverKind,
  type VcsPluginManifest,
} from "@t3tools/contracts";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { makeManifestVcsDriver } from "./ManifestVcsDriver.ts";
import { ensurePluginCheckpointTable } from "./pluginCheckpoints.ts";
import { makePluginCommandRunner } from "./pluginCommandRunner.ts";
import { VcsPluginDrivers } from "./VcsPluginDrivers.ts";
import {
  checkPluginFiles,
  checkpointStrategies,
  classifyExecutable,
  manifestCommands,
  readIcon,
  readManifest,
  supportsWorktrees,
} from "./pluginManifest.ts";

const STATE_FILE_NAME = ".state.json";
const IMPORT_MAX_FILES = 2_000;
const IMPORT_MAX_BYTES = 50_000_000;
const CHECK_TIMEOUT_MS = 30_000;
// Detection waits for the startup checks, so a slow one cannot hold every status read.
const STARTUP_CHECK_WAIT = Duration.seconds(45);

export class PluginService extends Context.Service<
  PluginService,
  {
    readonly list: Effect.Effect<PluginListResult>;
    readonly importFolder: (source: string) => Effect.Effect<PluginListResult, PluginError>;
    readonly remove: (id: string) => Effect.Effect<PluginListResult, PluginError>;
    readonly setEnabled: (
      id: string,
      enabled: boolean,
    ) => Effect.Effect<PluginListResult, PluginError>;
    readonly recheck: (id: string) => Effect.Effect<PluginListResult, PluginError>;
  }
>()("t3/plugins/PluginService") {}

interface PluginEntry {
  readonly folder: string;
  readonly directory: string;
  readonly manifest: VcsPluginManifest | null;
  readonly manifestErrors: ReadonlyArray<string>;
  readonly iconSvg: string | null;
  readonly enabled: boolean;
  readonly status: PluginStatus;
  readonly version: string | null;
  readonly problems: ReadonlyArray<string>;
  readonly lastError: PluginSummary["lastError"];
  readonly checkedAt: string | null;
  readonly driver: VcsDriver.VcsDriver["Service"] | null;
}

const PluginState = Schema.Struct({ disabled: Schema.Array(Schema.String) });
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(PluginState));

const summarize = (entry: PluginEntry): PluginSummary => ({
  id: entry.manifest?.id ?? entry.folder,
  kind: "vcs",
  label: entry.manifest?.label ?? entry.folder,
  enabled: entry.enabled,
  status: entry.status,
  version: entry.version,
  problems: [...entry.manifestErrors, ...entry.problems],
  lastError: entry.lastError,
  iconSvg: entry.iconSvg,
  checkpoints: entry.manifest ? [...checkpointStrategies(entry.manifest)] : [],
  supportsWorktrees: entry.manifest ? supportsWorktrees(entry.manifest) : false,
  checkedAt: entry.checkedAt,
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const services = yield* Effect.context<
    | VcsProcess.VcsProcess
    | FileSystem.FileSystem
    | Path.Path
    | SqlClient.SqlClient
    | ServerConfig.ServerConfig
  >();
  yield* ensurePluginCheckpointTable().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not create the VCS plugin checkpoint table", { cause }),
    ),
  );

  const directory = path.join(config.baseDir, "plugins");
  const statePath = path.join(directory, STATE_FILE_NAME);
  const entries = new Map<string, PluginEntry>();
  const lock = yield* Semaphore.make(1);
  const startupChecks = yield* Deferred.make<void>();
  // Status caches hold what a driver reported, so they refresh when the drivers change.
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const announce = PubSub.publish(changes, undefined);

  const failure = (operation: string, detail: string, pluginId?: string) =>
    new PluginError({ operation, detail, ...(pluginId === undefined ? {} : { pluginId }) });

  const readDisabled = fs.readFileString(statePath).pipe(
    Effect.flatMap(decodeState),
    Effect.map((state) => new Set(state.disabled)),
    Effect.orElseSucceed(() => new Set<string>()),
  );
  // Written beside and renamed over, so an interrupted write never reads as "nothing disabled".
  const writeDisabled = (disabled: ReadonlySet<string>) =>
    fs.makeDirectory(directory, { recursive: true }).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const staged = `${statePath}.${NodeCrypto.randomUUID()}.tmp`;
          yield* fs.writeFileString(
            staged,
            yield* encodeState({ disabled: [...disabled].toSorted() }).pipe(Effect.orDie),
          );
          yield* fs
            .rename(staged, statePath)
            .pipe(Effect.tapError(() => fs.remove(staged, { force: true }).pipe(Effect.ignore)));
        }),
      ),
      Effect.mapError((cause) =>
        failure("plugins.setEnabled", `Could not save plugin settings: ${cause.message}`),
      ),
    );

  const worktreesDirectory = Effect.gen(function* () {
    const setting = yield* settings.getSettings.pipe(
      Effect.map((value) => value.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    return resolveWorktreesDirectory(
      setting,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const reportError = (folder: string) => (operation: string, message: string) =>
    nowIso.pipe(
      Effect.map((at) => {
        const entry = entries.get(folder);
        if (entry) entries.set(folder, { ...entry, lastError: { operation, message, at } });
      }),
    );

  const load = Effect.fn("PluginService.load")(function* (
    folder: string,
    enabled: boolean,
    pluginDirectory = path.join(directory, folder),
  ) {
    const { manifest, errors } = yield* readManifest(fs, path, pluginDirectory);
    const fileErrors = manifest ? yield* checkPluginFiles(fs, path, pluginDirectory, manifest) : [];
    const idErrors =
      manifest && manifest.id !== folder && pluginDirectory === path.join(directory, folder)
        ? [`id: "${manifest.id}" must match the folder name "${folder}".`]
        : [];
    const manifestErrors = [...errors, ...fileErrors, ...idErrors];
    const valid = manifestErrors.length === 0 ? manifest : null;
    return {
      folder,
      directory: pluginDirectory,
      manifest: valid,
      manifestErrors,
      iconSvg: valid ? yield* readIcon(fs, path, pluginDirectory, valid) : null,
      enabled,
      status: valid === null ? "invalid" : enabled ? "checking" : "disabled",
      version: null,
      problems: [],
      lastError: null,
      checkedAt: null,
      driver: null,
    } satisfies PluginEntry as PluginEntry;
  });

  const missingCommands = Effect.fn("PluginService.missingCommands")(function* (
    manifest: VcsPluginManifest,
  ) {
    const names = new Set<string>();
    for (const [, argv] of manifestCommands(manifest)) {
      const executable = classifyExecutable(argv[0]!);
      if (executable.kind === "path") names.add(executable.name);
    }
    const missing: string[] = [];
    for (const name of names) {
      if (!(yield* isCommandAvailable(name))) missing.push(`${name} is not on the server's PATH.`);
    }
    return missing;
  });

  /** Runs `check` and, when it passes, builds the driver. */
  const check = Effect.fn("PluginService.check")(function* (entry: PluginEntry) {
    const checkedAt = yield* nowIso;
    const manifest = entry.manifest;
    if (manifest === null || !entry.enabled) return { ...entry, driver: null };
    const missing = yield* missingCommands(manifest);
    if (missing.length > 0)
      return {
        ...entry,
        status: "unavailable",
        problems: missing,
        checkedAt,
        driver: null,
      } satisfies PluginEntry;
    const runner = yield* makePluginCommandRunner({
      directory: entry.directory,
      manifest,
      reportError: () => Effect.void,
    });
    const result = yield* runner
      .runJson("check", PluginCheckOutput, {
        cwd: entry.directory,
        timeoutMs: CHECK_TIMEOUT_MS,
      })
      .pipe(Effect.result);
    if (result._tag === "Failure")
      return {
        ...entry,
        status: "unavailable",
        version: null,
        problems: [`check failed: ${result.failure.message}`],
        checkedAt,
        driver: null,
      } satisfies PluginEntry;
    const { version, problems } = result.success;
    if (problems.length > 0)
      return {
        ...entry,
        status: "unavailable",
        version,
        problems,
        checkedAt,
        driver: null,
      } satisfies PluginEntry;
    return yield* withDriver(entry, manifest, version, checkedAt);
  }, Effect.provideContext(services));

  /** An entry whose check passed, with its driver. */
  // One per plugin id, so a re-check's new driver waits on the deletion the old one started.
  const nativeSnapshotLocks = new Map<string, Semaphore.Semaphore>();
  const nativeSnapshotsFor = Effect.fnUntraced(function* (id: string) {
    const existing = nativeSnapshotLocks.get(id);
    if (existing !== undefined) return existing;
    const created = yield* Semaphore.make(1);
    nativeSnapshotLocks.set(id, created);
    return created;
  });

  const withDriver = Effect.fn("PluginService.withDriver")(function* (
    entry: PluginEntry,
    manifest: VcsPluginManifest,
    version: string,
    checkedAt: string,
  ) {
    const driver = yield* makeManifestVcsDriver({
      directory: entry.directory,
      manifest,
      reportError: reportError(entry.folder),
      worktreesDirectory: worktreesDirectory.pipe(Effect.provideService(Path.Path, path)),
      installedMarkers: () =>
        [...entries.values()].flatMap((other) => other.manifest?.detect.markers ?? []),
      nativeSnapshots: yield* nativeSnapshotsFor(manifest.id),
    });
    return {
      ...entry,
      status: "available",
      version,
      problems: [],
      lastError: null,
      checkedAt,
      driver,
    } satisfies PluginEntry;
  }, Effect.provideContext(services));

  const listFolders = fs.readDirectory(directory).pipe(
    Effect.map((names) => names.filter((name) => !name.startsWith(".")).toSorted()),
    Effect.orElseSucceed((): string[] => []),
  );

  const snapshot = (): PluginListResult => ({
    plugins: [...entries.values()].map(summarize),
    directory,
  });

  // An import interrupted mid-swap leaves the old copy aside: put it back, then drop leftovers.
  for (const name of yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): string[] => []))) {
    const leftover = path.join(directory, name);
    if (name.startsWith(".previous-")) {
      const aside = yield* readManifest(fs, path, leftover);
      // The name records the folder it came from; an older copy's name has only its manifest.
      const id = /^\.previous-(.+)\.[0-9a-f-]{36}$/.exec(name)?.[1] ?? aside.manifest?.id;
      if (
        id !== undefined &&
        !(yield* fs.exists(path.join(directory, id)).pipe(Effect.orElseSucceed(() => true)))
      ) {
        yield* fs.rename(leftover, path.join(directory, id)).pipe(Effect.ignore);
        continue;
      }
    }
    if (
      name.startsWith(".previous-") ||
      name.startsWith(".import-") ||
      name.startsWith(`${STATE_FILE_NAME}.`)
    )
      yield* fs.remove(leftover, { recursive: true, force: true }).pipe(Effect.ignore);
  }

  // Startup: read every folder now, check in the background.
  const disabledAtStart = yield* readDisabled;
  for (const folder of yield* listFolders) {
    const entry = yield* load(folder, !disabledAtStart.has(folder));
    entries.set(folder, entry);
  }
  yield* Effect.forEach(
    [...entries.values()],
    (entry) =>
      check(entry).pipe(
        // A plugin turned off, removed or replaced meanwhile keeps that newer state.
        Effect.tap((checked) =>
          Effect.sync(() => {
            if (entries.get(entry.folder) === entry) entries.set(entry.folder, checked);
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("VCS plugin check failed", { plugin: entry.folder, cause }),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  ).pipe(
    Effect.ensuring(Deferred.succeed(startupChecks, undefined).pipe(Effect.andThen(announce))),
    Effect.forkScoped,
  );

  const findFolder = (id: string, operation: string) => {
    if (!entries.has(id)) return Effect.fail(failure(operation, `No plugin named "${id}".`, id));
    return Effect.succeed(id);
  };

  const walkSource = Effect.fn("PluginService.walkSource")(function* (source: string) {
    let files = 0;
    let bytes = 0;
    const visit: (folder: string) => Effect.Effect<void, PluginError> = Effect.fn(
      "PluginService.visitSource",
    )(function* (folder: string) {
      const names = yield* fs
        .readDirectory(folder)
        .pipe(Effect.mapError(() => failure("plugins.import", `Cannot read ${folder}.`)));
      for (const name of names) {
        const target = path.join(folder, name);
        const link = yield* fs.readLink(target).pipe(Effect.option);
        if (Option.isSome(link))
          return yield* failure(
            "plugins.import",
            `${path.relative(source, target)} is a symbolic link. Copy the file into the plugin folder instead.`,
          );
        const info = yield* fs
          .stat(target)
          .pipe(Effect.mapError(() => failure("plugins.import", `Cannot read ${target}.`)));
        if (info.type === "Directory") {
          yield* visit(target);
          continue;
        }
        files++;
        bytes += Number(info.size);
        if (files > IMPORT_MAX_FILES || bytes > IMPORT_MAX_BYTES)
          return yield* failure(
            "plugins.import",
            "The folder is too large for a plugin. Leave dependencies and build output out of it.",
          );
      }
    });
    yield* visit(source);
  });

  const importFolder: PluginService["Service"]["importFolder"] = Effect.fn(
    "PluginService.importFolder",
  )(function* (requested) {
    const operation = "plugins.import";
    const source = yield* fs
      .realPath(path.resolve(requested))
      .pipe(
        Effect.mapError(() => failure(operation, `${requested} does not exist on the server.`)),
      );
    const info = yield* fs.stat(source).pipe(Effect.orElseSucceed(() => null));
    if (info?.type !== "Directory")
      return yield* failure(operation, `${requested} is not a folder.`);
    const realDirectory = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
    if (source === realDirectory || source.startsWith(`${realDirectory}${path.sep}`))
      return yield* failure(operation, "This folder is already in the plugins folder.");
    const preview = yield* readManifest(fs, path, source);
    if (preview.manifest === null) return yield* failure(operation, preview.errors.join(" "));
    yield* walkSource(source);
    const id = preview.manifest.id;

    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.mapError((cause) => failure(operation, cause.message, id)));
        const staging = path.join(directory, `.import-${NodeCrypto.randomUUID()}`);
        const cleanupStaging = fs
          .remove(staging, { recursive: true, force: true })
          .pipe(Effect.ignore);
        yield* fs
          .copy(source, staging)
          .pipe(Effect.mapError((cause) => failure(operation, cause.message, id)));
        // The source can change while it is copied; the limits hold for what will be installed.
        yield* walkSource(staging).pipe(Effect.tapError(() => cleanupStaging));
        const disabled = yield* readDisabled;
        // Paths are checked again in the copy, which is what will run.
        const staged = yield* load(id, !disabled.has(id), staging);
        if (staged.manifest === null) {
          yield* cleanupStaging;
          return yield* failure(operation, staged.manifestErrors.join(" "), id);
        }
        // The source can change after the preview; the copy installs under the id it carries.
        if (staged.manifest.id !== id) {
          yield* cleanupStaging;
          return yield* failure(operation, "The plugin's id changed while it was imported.", id);
        }
        // Compared as written: fields T3 Code does not read still configure the plugin.
        const manifestText = (folder: string) =>
          fs
            .readFileString(path.join(folder, PLUGIN_MANIFEST_FILE_NAME))
            .pipe(Effect.orElseSucceed(() => null));
        const approved = yield* manifestText(staging);
        const checked = yield* check(staged);
        // The check runs in the copy and can write there, so the limits are checked once more.
        yield* walkSource(staging).pipe(Effect.tapError(() => cleanupStaging));
        const sameManifest = Effect.fnUntraced(function* (folder: string) {
          return approved !== null && (yield* manifestText(folder)) === approved;
        });
        // What installs is what the check approved, not a manifest it rewrote.
        if (!(yield* sameManifest(staging))) {
          yield* cleanupStaging;
          return yield* failure(
            operation,
            "The plugin's manifest changed while it was checked.",
            id,
          );
        }
        // Nor can it remove a file the manifest names, before the installed copy is replaced.
        const afterCheck = yield* load(id, staged.enabled, staging);
        if (afterCheck.manifest === null) {
          yield* cleanupStaging;
          return yield* failure(operation, afterCheck.manifestErrors.join(" "), id);
        }
        const target = path.join(directory, id);
        const previous = path.join(directory, `.previous-${id}.${NodeCrypto.randomUUID()}`);
        const hadPrevious = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
        yield* Effect.gen(function* () {
          if (hadPrevious) yield* fs.rename(target, previous);
          // A failed swap puts the installed copy back where it was.
          yield* fs
            .rename(staging, target)
            .pipe(
              Effect.tapError(() =>
                hadPrevious ? fs.rename(previous, target).pipe(Effect.ignore) : Effect.void,
              ),
            );
        }).pipe(
          Effect.mapError((cause) => failure(operation, cause.message, id)),
          Effect.tapError(() => cleanupStaging),
        );
        if (hadPrevious)
          yield* fs.remove(previous, { recursive: true, force: true }).pipe(Effect.ignore);
        // Rebuild the driver on the installed folder, keeping what the check found: running the
        // check again could find something else than what was approved.
        const installed = yield* load(id, checked.enabled);
        entries.set(
          id,
          checked.status === "available"
            ? (yield* sameManifest(path.join(directory, id))) && installed.manifest !== null
              ? yield* withDriver(
                  installed,
                  installed.manifest!,
                  checked.version!,
                  checked.checkedAt!,
                )
              : yield* check(installed)
            : {
                ...installed,
                status: checked.status,
                version: checked.version,
                problems: checked.problems,
                checkedAt: checked.checkedAt,
              },
        );
        return snapshot();
      }),
    );
  });

  const remove: PluginService["Service"]["remove"] = Effect.fn("PluginService.remove")(
    function* (id) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const folder = yield* findFolder(id, "plugins.remove");
          yield* fs
            .remove(path.join(directory, folder), { recursive: true, force: true })
            .pipe(Effect.mapError((cause) => failure("plugins.remove", cause.message, id)));
          entries.delete(folder);
          const disabled = yield* readDisabled;
          if (disabled.delete(folder)) yield* writeDisabled(disabled);
          return snapshot();
        }),
      );
    },
  );

  const setEnabled: PluginService["Service"]["setEnabled"] = Effect.fn("PluginService.setEnabled")(
    function* (id, enabled) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const folder = yield* findFolder(id, "plugins.setEnabled");
          const disabled = yield* readDisabled;
          if (enabled) disabled.delete(folder);
          else disabled.add(folder);
          yield* writeDisabled(disabled);
          const entry = yield* load(folder, enabled);
          entries.set(folder, enabled ? yield* check(entry) : entry);
          return snapshot();
        }),
      );
    },
  );

  const recheck: PluginService["Service"]["recheck"] = Effect.fn("PluginService.recheck")(
    function* (id) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const folder = yield* findFolder(id, "plugins.recheck");
          // Read the folder again: someone may have edited the manifest in place.
          const entry = yield* load(folder, entries.get(folder)!.enabled);
          entries.set(folder, yield* check(entry));
          return snapshot();
        }),
      );
    },
  );

  const drivers = VcsPluginDrivers.of({
    current: Deferred.await(startupChecks).pipe(
      Effect.timeoutOption(STARTUP_CHECK_WAIT),
      Effect.map(() => {
        const available = new Map<VcsDriverKind, VcsDriver.VcsDriver["Service"]>();
        for (const entry of entries.values()) {
          if (entry.driver && entry.manifest) available.set(entry.manifest.id, entry.driver);
        }
        return available;
      }),
    ),
    hasAny: () => [...entries.values()].some((entry) => entry.manifest !== null && entry.enabled),
    describe: (kind) => {
      for (const { driver, manifest } of entries.values()) {
        if (driver && manifest?.id === kind)
          return {
            label: manifest.label,
            markers: manifest.detect.markers,
            // Recovery checks the branch is still there before checking it out again.
            recreatesWorktrees:
              supportsWorktrees(manifest) &&
              manifest.commands.worktreeAttach !== undefined &&
              manifest.commands.listRefs !== undefined,
          };
      }
      return undefined;
    },
    changes: Stream.fromPubSub(changes),
    markers: () =>
      [...entries.values()].flatMap((entry) =>
        entry.driver && entry.manifest ? entry.manifest.detect.markers : [],
      ),
    installedMarkers: () =>
      [...entries.values()].flatMap((entry) => entry.manifest?.detect.markers ?? []),
    available: () =>
      [...entries.values()].flatMap((entry) =>
        entry.driver && entry.manifest
          ? [
              {
                markers: entry.manifest.detect.markers,
                worktrees: supportsWorktrees(entry.manifest),
              },
            ]
          : [],
      ),
  });

  const announced =
    <Args extends ReadonlyArray<unknown>>(
      mutation: (...args: Args) => Effect.Effect<PluginListResult, PluginError>,
    ) =>
    (...args: Args) =>
      mutation(...args).pipe(Effect.tap(() => announce));

  return Context.make(
    PluginService,
    PluginService.of({
      list: Effect.sync(snapshot),
      importFolder: announced(importFolder),
      remove: announced(remove),
      setEnabled: announced(setEnabled),
      recheck: announced(recheck),
    }),
  ).pipe(Context.add(VcsPluginDrivers, drivers));
});

export const layer = Layer.effectContext(make);
