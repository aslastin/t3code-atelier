// @effect-diagnostics nodeBuiltinImport:off - native realpath preserves on-disk casing on macOS and resolves symlinks before following '..'.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

export const nativeRealPath = (entry: string) =>
  Effect.callback<string, NodeJS.ErrnoException>((resume) => {
    NodeFS.realpath.native(entry, (error, resolved) => {
      resume(error ? Effect.fail(error) : Effect.succeed(resolved));
    });
  });

// A missing project folder still protects its checkout. Resolve its nearest existing ancestor.
export const nativeRealPathWithMissingTail = (
  entry: string,
): Effect.Effect<string, NodeJS.ErrnoException> =>
  nativeRealPath(entry).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT" && NodePath.dirname(entry) !== entry,
      () =>
        nativeRealPathWithMissingTail(NodePath.dirname(entry)).pipe(
          Effect.map((parent) => NodePath.join(parent, NodePath.basename(entry))),
        ),
    ),
  );
