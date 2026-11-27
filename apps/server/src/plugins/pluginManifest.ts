import {
  PLUGIN_MANIFEST_FILE_NAME,
  VcsPluginManifest,
  type VcsPluginCheckpointStrategy,
  type VcsPluginCommandName,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type ManifestCommandName = VcsPluginCommandName | "check";

/** Placeholders each command may use; any other `{name}` is a manifest error. */
export const COMMAND_PLACEHOLDERS: Readonly<Record<ManifestCommandName, ReadonlyArray<string>>> = {
  check: [],
  status: ["repositoryRoot"],
  listRemotes: ["repositoryRoot"],
  listRefs: ["repositoryRoot"],
  commit: ["repositoryRoot", "messageFile", "pathsFile"],
  diff: ["repositoryRoot", "pathsFile"],
  log: ["repositoryRoot"],
  branchCreate: ["repositoryRoot", "newRef"],
  push: ["repositoryRoot"],
  pull: ["repositoryRoot"],
  worktreeCreate: ["repositoryRoot", "path", "newRef", "baseRef"],
  worktreeRemove: ["repositoryRoot", "path"],
  worktreeAttach: ["repositoryRoot", "path", "ref"],
  worktreeList: ["repositoryRoot"],
  checkpointCapture: ["repositoryRoot", "checkpointRef"],
  checkpointDiff: ["repositoryRoot", "fromRevision", "toRevision"],
  checkpointRestore: ["repositoryRoot", "revision"],
  checkpointDelete: ["repositoryRoot", "revision"],
  changedFiles: ["repositoryRoot"],
  readFile: ["repositoryRoot", "revision", "path"],
};

const STRATEGY_COMMANDS: Readonly<
  Record<VcsPluginCheckpointStrategy, ReadonlyArray<VcsPluginCommandName>>
> = {
  native: ["checkpointCapture", "checkpointDiff", "checkpointRestore"],
  "changed-files": ["changedFiles", "readFile"],
  full: [],
};

/** Ids the server already gives a meaning to. */
const RESERVED_IDS = new Set(["git", "jj", "unknown", "auto"]);

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;
const MAX_ICON_BYTES = 64 * 1024;

export const DEFAULT_CHECKPOINT_STRATEGIES: ReadonlyArray<VcsPluginCheckpointStrategy> = [
  "changed-files",
];

export const checkpointStrategies = (manifest: VcsPluginManifest) =>
  manifest.checkpoints ?? DEFAULT_CHECKPOINT_STRATEGIES;

export const supportsWorktrees = (manifest: VcsPluginManifest) =>
  manifest.capabilities?.worktrees === true &&
  manifest.commands.worktreeCreate !== undefined &&
  manifest.commands.worktreeRemove !== undefined &&
  manifest.commands.worktreeList !== undefined;

export type ExecutableKind =
  | { readonly kind: "plugin"; readonly relativePath: string }
  | { readonly kind: "path"; readonly name: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** `./x` runs a file in the plugin folder, a bare name comes from PATH, anything else is refused. */
export function classifyExecutable(executable: string): ExecutableKind {
  if (executable.length === 0) return { kind: "invalid", reason: "is empty" };
  if (executable.includes("{")) return { kind: "invalid", reason: "cannot use a placeholder" };
  if (executable.startsWith("./")) {
    const relativePath = executable.slice(2);
    const segments = relativePath.split(/[/\\]/);
    if (relativePath.length === 0 || segments.some((part) => part === ".." || part === ""))
      return { kind: "invalid", reason: "must name a file inside the plugin folder" };
    return { kind: "plugin", relativePath };
  }
  if (/^[A-Za-z]:|^[/\\]/.test(executable))
    return { kind: "invalid", reason: "is an absolute path; use ./ or a name from PATH" };
  if (/[/\\]/.test(executable))
    return { kind: "invalid", reason: "must start with ./ to run a file in the plugin folder" };
  return { kind: "path", name: executable };
}

const isSafeRelativePath = (value: string) =>
  value.trim() === value &&
  !/^[A-Za-z]:|^[/\\]/.test(value) &&
  value.split(/[/\\]/).every((part) => part !== ".." && part !== "." && part !== "");

export const manifestCommands = (manifest: VcsPluginManifest) =>
  [["check", manifest.check], ...Object.entries(manifest.commands)] as ReadonlyArray<
    readonly [ManifestCommandName, ReadonlyArray<string>]
  >;

/** Rules a schema cannot express. Each message names the field it is about. */
export function validateManifest(manifest: VcsPluginManifest): ReadonlyArray<string> {
  const errors: string[] = [];
  if (RESERVED_IDS.has(manifest.id)) errors.push(`id: "${manifest.id}" is reserved.`);
  for (const [name, argv] of manifestCommands(manifest)) {
    const field = name === "check" ? "check" : `commands.${name}`;
    const executable = classifyExecutable(argv[0]!);
    if (executable.kind === "invalid") errors.push(`${field}: the command ${executable.reason}.`);
    const allowed = COMMAND_PLACEHOLDERS[name];
    for (const argument of argv.slice(1)) {
      for (const [, placeholder] of argument.matchAll(PLACEHOLDER)) {
        if (!allowed.includes(placeholder!))
          errors.push(`${field}: {${placeholder}} is not available here.`);
      }
    }
  }
  for (const marker of manifest.detect.markers) {
    if (!isSafeRelativePath(marker))
      errors.push(
        `detect.markers: "${marker}" must be a path inside the repository folder, with no spaces around it.`,
      );
  }
  if (manifest.icon !== undefined) {
    const icon = manifest.icon.replace(/^\.\//, "");
    if (!isSafeRelativePath(icon) || !icon.toLowerCase().endsWith(".svg"))
      errors.push("icon: must be an .svg file inside the plugin folder.");
  }
  const strategies = checkpointStrategies(manifest);
  if (new Set(strategies).size !== strategies.length)
    errors.push("checkpoints: each strategy can be listed once.");
  for (const strategy of strategies) {
    for (const command of STRATEGY_COMMANDS[strategy]) {
      if (manifest.commands[command] === undefined)
        errors.push(`checkpoints: "${strategy}" needs commands.${command}.`);
    }
  }
  if (
    manifest.capabilities?.worktrees === true &&
    (manifest.commands.worktreeCreate === undefined ||
      manifest.commands.worktreeRemove === undefined ||
      manifest.commands.worktreeList === undefined)
  )
    errors.push(
      "capabilities.worktrees: needs commands.worktreeCreate, commands.worktreeRemove and commands.worktreeList.",
    );
  return errors;
}

/**
 * Fills `{name}` inside each argument. A value never splits into more arguments. Returns the
 * first placeholder that has no value instead, when there is one.
 */
export function renderArgv(
  argv: ReadonlyArray<string>,
  values: Readonly<Record<string, string | undefined>>,
): { readonly argv: ReadonlyArray<string> } | { readonly missing: string } {
  let missing: string | undefined;
  const rendered = argv.map((argument, index) =>
    index === 0
      ? argument
      : argument.replace(PLACEHOLDER, (match, name: string) => {
          const value = values[name];
          if (value === undefined) missing ??= name;
          return value ?? match;
        }),
  );
  return missing === undefined ? { argv: rendered } : { missing };
}

export const usesPlaceholder = (argv: ReadonlyArray<string> | undefined, name: string) =>
  argv?.slice(1).some((argument) => argument.includes(`{${name}}`)) === true;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(VcsPluginManifest));

export interface ReadManifestResult {
  readonly manifest: VcsPluginManifest | null;
  readonly errors: ReadonlyArray<string>;
}

/** Decodes `plugin.json` in `directory` and checks the rules the schema cannot. */
export const readManifest = Effect.fn("pluginManifest.readManifest")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
) {
  const text = yield* fs
    .readFileString(path.join(directory, PLUGIN_MANIFEST_FILE_NAME))
    .pipe(Effect.option);
  if (text._tag === "None")
    return {
      manifest: null,
      errors: [`${PLUGIN_MANIFEST_FILE_NAME} is missing or unreadable.`],
    } satisfies ReadManifestResult;
  const decoded = yield* decodeManifest(text.value).pipe(Effect.result);
  if (decoded._tag === "Failure")
    return {
      manifest: null,
      errors: [`${PLUGIN_MANIFEST_FILE_NAME}: ${decoded.failure.message}`],
    } satisfies ReadManifestResult;
  const errors = validateManifest(decoded.success);
  return {
    manifest: errors.length === 0 ? decoded.success : null,
    errors,
  } satisfies ReadManifestResult;
});

/** Resolves `./` inside the real plugin folder, so a symlink cannot reach outside it. */
export const resolvePluginFile = Effect.fn("pluginManifest.resolvePluginFile")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, directory: string, relativePath: string) {
    const root = yield* fs.realPath(directory);
    const target = yield* fs.realPath(path.join(root, relativePath));
    const relative = path.relative(root, target);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return (yield* fs.stat(target)).type === "File" ? target : null;
  },
  Effect.orElseSucceed(() => null),
);

/** Errors for `./` commands and an icon that do not resolve to a file in the plugin folder. */
export const checkPluginFiles = Effect.fn("pluginManifest.checkPluginFiles")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  manifest: VcsPluginManifest,
) {
  const errors: string[] = [];
  for (const [name, argv] of manifestCommands(manifest)) {
    const executable = classifyExecutable(argv[0]!);
    if (executable.kind !== "plugin") continue;
    if ((yield* resolvePluginFile(fs, path, directory, executable.relativePath)) === null)
      errors.push(
        `${name === "check" ? "check" : `commands.${name}`}: ${argv[0]} is not a file inside the plugin folder.`,
      );
  }
  if (manifest.icon !== undefined && (yield* readIcon(fs, path, directory, manifest)) === null)
    errors.push(
      `icon: ${manifest.icon} must be an SVG file inside the plugin folder, at most 64 KB.`,
    );
  return errors;
});

// A whole SVG document, so a cut-off file is refused rather than drawn as nothing: each `<svg>`
// opened is closed, and only comments or whitespace follow the outermost one.
const isWholeSvg = (text: string) => {
  const body = text.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!/<svg[\s>]/i.test(body) || !/<\/svg\s*>$/i.test(body)) return false;
  let depth = 0;
  for (const tag of body.matchAll(/<(\/?)svg\b[^>]*?(\/?)>/gi)) {
    if (tag[1] === "/") depth -= 1;
    else if (tag[2] !== "/") depth += 1;
    if (depth < 0) return false;
  }
  return depth === 0;
};

/** The icon's SVG text, or null when it is missing, too large, or outside the folder. */
export const readIcon = Effect.fn("pluginManifest.readIcon")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    directory: string,
    manifest: VcsPluginManifest,
  ) {
    if (manifest.icon === undefined) return null;
    const file = yield* resolvePluginFile(fs, path, directory, manifest.icon.replace(/^\.\//, ""));
    if (file === null) return null;
    const info = yield* fs.stat(file);
    if (info.size > BigInt(MAX_ICON_BYTES)) return null;
    const svg = yield* fs.readFileString(file);
    return isWholeSvg(svg) ? svg : null;
  },
  Effect.orElseSucceed(() => null),
);
