import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(cwd);
        }),
      ),
    );
  });

// A restore rewrites files under its directory, so it must exclude provider
// startup in any overlapping workspace: symlink aliases, parents, and children.
// Kept apart from withWorkspaceLease because that lease is non-reentrant and
// restores call Git work that leases the project root.
interface Reservation {
  readonly cwd: string;
  readonly kind: "exclusive" | "shared";
}

const reservations = new Set<Reservation>();
let reservationReleased = Deferred.makeUnsafe<void>();

// path.relative folds win32 drive-letter case and treats a POSIX backslash as
// part of a name, unlike a raw prefix check.
const contains = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const conflicts = (path: Path.Path, a: Reservation, b: Reservation) =>
  (a.kind === "exclusive" || b.kind === "exclusive") &&
  (contains(path, a.cwd, b.cwd) || contains(path, b.cwd, a.cwd));

const reserve = (path: Path.Path, reservation: Reservation): Effect.Effect<void> =>
  Effect.suspend(() => {
    for (const held of reservations) {
      if (conflicts(path, held, reservation)) {
        return Deferred.await(reservationReleased).pipe(Effect.andThen(reserve(path, reservation)));
      }
    }
    reservations.add(reservation);
    return Effect.void;
  });

const release = (reservation: Reservation) =>
  Effect.sync(() => {
    if (!reservations.delete(reservation)) return;
    const released = reservationReleased;
    reservationReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  });

// A worktree removed by storage cleanup is recreated inside the reserved
// section, so resolve its nearest existing ancestor: a symlink alias above it
// must still canonicalize the same on both sides. Walks at most the path depth.
export const resolveWorkspaceLocation = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.Effect<string, PlatformError> =>
  fileSystem.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target);
      return parent === target
        ? Effect.succeed(target)
        : resolveWorkspaceLocation(fileSystem, path, parent).pipe(
            Effect.map((resolved) => path.join(resolved, path.basename(target))),
          );
    }),
  );

const withReservation =
  (kind: Reservation["kind"]) =>
  <A, E, R>(
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    resolveWorkspaceLocation(fileSystem, path, cwd).pipe(
      Effect.orElseSucceed(() => cwd),
      Effect.flatMap((canonical) => {
        const reservation: Reservation = { cwd: canonical, kind };
        return reserve(path, reservation).pipe(
          Effect.andThen(effect),
          Effect.ensuring(release(reservation)),
        );
      }),
    );

/** Used while restoring or removing files in a workspace. */
export const withExclusiveWorkspaceReservation = withReservation("exclusive");

/** Protects thread binding and turn startup from changes to any overlapping workspace. */
export const withSharedWorkspaceReservation = withReservation("shared");
