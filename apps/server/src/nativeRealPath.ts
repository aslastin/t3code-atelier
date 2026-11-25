// @effect-diagnostics nodeBuiltinImport:off - native realpath preserves on-disk casing on macOS and resolves symlinks before following '..'.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";

export const nativeRealPath = (entry: string) =>
  Effect.callback<string, NodeJS.ErrnoException>((resume) => {
    NodeFS.realpath.native(entry, (error, resolved) => {
      resume(error ? Effect.fail(error) : Effect.succeed(resolved));
    });
  });
