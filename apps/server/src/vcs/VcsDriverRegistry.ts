import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  GIT_VCS_KIND,
  VcsDriverKind,
  VcsUnsupportedOperationError,
  type VcsError,
  type VcsRepositoryIdentity,
} from "@t3tools/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriver from "./VcsDriver.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
// Detection costs three git processes per cwd; cached hits still stat disk, so TTL bounds only undetectable changes.
const DETECTION_CACHE_TTL = Duration.minutes(5);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriver.VcsDriver["Service"];
}

export class VcsDriverRegistry extends Context.Service<
  VcsDriverRegistry,
  {
    readonly hasAdditionalDrivers: boolean;
    readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriver.VcsDriver["Service"], VcsError>;
    readonly detect: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
    readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
  }
>()("t3/vcs/VcsDriverRegistry") {}

export const makeWithDrivers = Effect.fn("VcsDriverRegistry.makeWithDrivers")(function* (
  additionalDrivers: ReadonlyMap<VcsDriverKind, VcsDriver.VcsDriver["Service"]>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const git = yield* GitVcsDriver.makeVcsDriver;
  const get: VcsDriverRegistry["Service"]["get"] = (kind) => {
    const driver = kind === GIT_VCS_KIND ? git : additionalDrivers.get(kind);
    if (!driver) {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "VcsDriverRegistry.get",
          kind,
          detail: `No ${kind} VCS driver is registered.`,
        }),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    // Status, review and source control show a repository Git cannot read as none at all.
    // Checkpoints need the failure, so CheckpointStore asks the driver directly.
    const repository = yield* driver.detectRepository(cwd).pipe(
      Effect.catchTags({
        VcsProcessExitError: (error) =>
          kind === GIT_VCS_KIND && error.operation === GitVcsDriver.WORK_TREE_PROBE_OPERATION
            ? Effect.succeed(null)
            : Effect.fail(error),
      }),
    );
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
    } satisfies VcsDriverHandle;
  });

  // Symlinks can put cwd outside root; then inspect cwd alone.
  const foldersBelowRoot = (cwd: string, rootPath: string) => {
    const relative = path.relative(path.resolve(rootPath), path.resolve(cwd));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return [cwd];
    return Array.from({ length: relative.split(path.sep).length }, (_, levelsUp) =>
      path.resolve(cwd, ...Array<string>(levelsUp).fill("..")),
    );
  };

  const readDiskState = (cwd: string, repository: VcsRepositoryIdentity) =>
    Effect.all({
      gitEntries: Effect.forEach(foldersBelowRoot(cwd, repository.rootPath), (folder) =>
        fileSystem.exists(path.join(folder, ".git")),
      ),
      repositoryOnDisk: Effect.forEach(
        repository.metadataPath === null
          ? [cwd]
          : [cwd, path.resolve(cwd, repository.metadataPath)],
        (target) => fileSystem.exists(target),
      ).pipe(Effect.map((results) => results.every(Boolean))),
    }).pipe(Effect.orElseSucceed(() => null));

  const detectionCache = yield* Cache.makeWith<
    string,
    { readonly handle: VcsDriverHandle; readonly gitEntries: ReadonlyArray<boolean> } | null,
    VcsError
  >(
    (cwd) =>
      Effect.gen(function* () {
        const handle = yield* detectWithDriver(GIT_VCS_KIND, git, cwd);
        if (handle === null) return null;
        const disk = yield* readDiskState(cwd, handle.repository);
        return { handle, gitEntries: disk?.gitEntries ?? [] };
      }),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (detected) => (detected === null ? Duration.zero : DETECTION_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const detectGit = Effect.fn("VcsDriverRegistry.detectGit")(function* (cwd: string) {
    const cached = yield* Cache.get(detectionCache, cwd);
    if (cached === null) return null;
    const disk = yield* readDiskState(cwd, cached.handle.repository);
    if (
      disk?.repositoryOnDisk &&
      disk.gitEntries.length === cached.gitEntries.length &&
      disk.gitEntries.every((exists, index) => exists === cached.gitEntries[index])
    ) {
      return cached.handle;
    }
    yield* Cache.invalidate(detectionCache, cwd);
    return (yield* Cache.get(detectionCache, cwd))?.handle ?? null;
  });

  const canonicalPath = (cwd: string) =>
    fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));

  const detect: VcsDriverRegistry["Service"]["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      const kind = yield* projectConfig.resolveKind(input);
      if (kind === GIT_VCS_KIND) return yield* detectGit(input.cwd);
      if (kind !== "auto" && kind !== "unknown") {
        return yield* detectWithDriver(kind, yield* get(kind), input.cwd);
      }

      if (additionalDrivers.size === 0) return yield* detectGit(input.cwd);
      const roots = new Map<string, VcsDriverHandle>();
      for (const [kind, driver] of additionalDrivers) {
        if (kind === GIT_VCS_KIND) continue;
        const handle = yield* detectWithDriver(kind, driver, input.cwd).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (handle === null) continue;
        const root = yield* canonicalPath(handle.repository.rootPath);
        if (!roots.has(root)) roots.set(root, handle);
      }
      if (roots.size === 0) return yield* detectGit(input.cwd);

      // Marker probes run on every lookup, so a new nested repository wins over a cached parent.
      const cwd = yield* canonicalPath(input.cwd);
      let folder = cwd;
      while (true) {
        const candidate = roots.get(folder);
        if (candidate) return candidate;
        if (
          yield* fileSystem
            .exists(path.join(folder, ".git"))
            .pipe(Effect.orElseSucceed(() => false))
        ) {
          const handle = yield* detectGit(cwd).pipe(Effect.orElseSucceed(() => null));
          if (handle && (yield* canonicalPath(handle.repository.rootPath)) === folder)
            return handle;
        }
        const parent = path.dirname(folder);
        if (parent === folder) return yield* detectGit(cwd);
        folder = parent;
      }
    },
  );

  const resolve: VcsDriverRegistry["Service"]["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsDriverRegistry.resolve",
        kind: requestedKind === "auto" ? VcsDriverKind.make("unknown") : requestedKind,
        detail:
          requestedKind === "auto"
            ? `No supported VCS repository was detected at ${input.cwd}.`
            : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      });
    },
  );

  return VcsDriverRegistry.of({
    get hasAdditionalDrivers() {
      return additionalDrivers.size > 0;
    },
    get,
    detect,
    resolve,
  });
});

export const make = makeWithDrivers(new Map());

export const layer = Layer.effect(VcsDriverRegistry, make).pipe(
  Layer.provide(VcsProjectConfig.layer),
);
