import {
  PLUGIN_PROTOCOL,
  VcsPluginOutputError,
  VcsUnsupportedOperationError,
  type VcsDriverKind,
  type VcsError,
  type VcsPluginManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  classifyExecutable,
  renderArgv,
  resolvePluginFile,
  type ManifestCommandName,
} from "./pluginManifest.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

// Commands see only what a CLI needs to find itself and its credentials.
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

const pluginEnvironment = (directory: string, inherited: NodeJS.ProcessEnv) => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (
      value !== undefined &&
      INHERITED_ENV.some((key) => key.toUpperCase() === name.toUpperCase())
    )
      env[name] = value;
  }
  env.T3_PLUGIN_PROTOCOL = PLUGIN_PROTOCOL;
  env.T3_PLUGIN_DIR = directory;
  return env;
};

export interface PluginRunOptions {
  readonly cwd: string;
  readonly values?: Readonly<Record<string, string | undefined>>;
  /** Null waits as long as the command runs, as `git worktree add` does. */
  readonly timeoutMs?: number | null;
  readonly maxOutputBytes?: number;
  readonly onStdoutChunk?: (chunk: Uint8Array) => void;
  /** False keeps a failure out of the plugin's last error in Settings. */
  readonly reportFailures?: boolean;
}

export interface PluginCommandRunner {
  readonly kind: VcsDriverKind;
  readonly label: string;
  readonly has: (command: ManifestCommandName) => boolean;
  readonly run: (
    command: ManifestCommandName,
    options: PluginRunOptions,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
  readonly runJson: <S extends Schema.Top>(
    command: ManifestCommandName,
    schema: S,
    options: PluginRunOptions,
  ) => Effect.Effect<S["Type"], VcsError, S["DecodingServices"]>;
}

export const makePluginCommandRunner = Effect.fn("pluginCommandRunner.make")(function* (input: {
  readonly directory: string;
  readonly manifest: VcsPluginManifest;
  readonly reportError: (operation: string, message: string) => Effect.Effect<void>;
}) {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { manifest, directory } = input;
  const kind = manifest.id;
  const argvFor = (command: ManifestCommandName) =>
    command === "check" ? manifest.check : manifest.commands[command];

  const unsupported = (command: ManifestCommandName, detail: string) =>
    new VcsUnsupportedOperationError({ operation: `${kind}.${command}`, kind, detail });

  const run: PluginCommandRunner["run"] = Effect.fn("pluginCommandRunner.run")(
    function* (command, options) {
      const argv = argvFor(command);
      if (argv === undefined)
        return yield* unsupported(command, `${manifest.label} has no ${command} command.`);
      const executable = classifyExecutable(argv[0]!);
      let resolved: string;
      if (executable.kind === "plugin") {
        const file = yield* resolvePluginFile(fs, path, directory, executable.relativePath);
        if (file === null)
          return yield* unsupported(command, `${argv[0]} is not a file in the plugin folder.`);
        resolved = file;
      } else if (executable.kind === "path") {
        resolved = executable.name;
      } else {
        return yield* unsupported(command, `The command ${executable.reason}.`);
      }
      const rendered = renderArgv(argv, options.values ?? {});
      if ("missing" in rendered)
        return yield* unsupported(command, `No value for {${rendered.missing}} here.`);
      return yield* vcsProcess.run({
        operation: `plugin.${kind}.${command}`,
        command: resolved,
        args: rendered.argv.slice(1),
        cwd: options.cwd,
        cleanEnv: true,
        // Arguments are an argv, never a command line a shell could reinterpret.
        forbidShell: true,
        env: pluginEnvironment(directory, process.env),
        timeoutMs:
          options.timeoutMs === null
            ? Number.POSITIVE_INFINITY
            : (options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        ...(options.onStdoutChunk ? { onStdoutChunk: options.onStdoutChunk } : {}),
        outputMode: options.onStdoutChunk ? "truncate" : "error",
      });
    },
  );

  const runJson: PluginCommandRunner["runJson"] = (command, schema, options) =>
    run(command, options).pipe(
      Effect.flatMap((output) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(output.stdout).pipe(
          Effect.catchTags({
            SchemaError: (error) => {
              const detail = output.stdout.trim() === "" ? "stdout was empty" : error.message;
              return input
                .reportError(command, `Output does not match ${PLUGIN_PROTOCOL}: ${detail}`)
                .pipe(
                  Effect.andThen(
                    Effect.fail(new VcsPluginOutputError({ operation: command, kind, detail })),
                  ),
                );
            },
          }),
        ),
      ),
      Effect.tapError((error) =>
        error._tag === "VcsPluginOutputError" || error._tag === "VcsUnsupportedOperationError"
          ? Effect.void
          : input.reportError(command, error.message),
      ),
    );

  return {
    kind,
    label: manifest.label,
    has: (command) => argvFor(command) !== undefined,
    run: (command, options) =>
      run(command, options).pipe(
        Effect.tapError((error) =>
          error._tag === "VcsUnsupportedOperationError" || options.reportFailures === false
            ? Effect.void
            : input.reportError(command, error.message),
        ),
      ),
    runJson,
  } satisfies PluginCommandRunner;
});
