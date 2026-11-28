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
  refList: ["repositoryRoot"],
  commit: ["repositoryRoot", "messageFile", "pathsFile"],
  diff: ["repositoryRoot", "pathsFile"],
  log: ["repositoryRoot"],
  branchCreate: ["repositoryRoot", "newRef"],
  branchRename: ["repositoryRoot", "oldRef", "newRef"],
  fetchBase: ["repositoryRoot", "ref"],
  push: ["repositoryRoot"],
  pull: ["repositoryRoot"],
  worktreeCreate: ["repositoryRoot", "worktreePath", "newRef", "baseRef"],
  worktreeRemove: ["repositoryRoot", "worktreePath", "force"],
  worktreeAttach: ["repositoryRoot", "worktreePath", "ref"],
  worktreeList: ["repositoryRoot"],
  checkpointCapture: ["repositoryRoot"],
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

// `{{` and `}}` are a literal brace, so an argument such as `@{{upstream}}` stays as written.
const PLACEHOLDER = /\{\{|\}\}|\{([A-Za-z]+)\}/g;
const MAX_ICON_BYTES = 64 * 1024;

const KNOWN_STRATEGIES: ReadonlyArray<string> = ["native", "changed-files", "full"];
const isStrategy = (name: string): name is VcsPluginCheckpointStrategy =>
  KNOWN_STRATEGIES.includes(name);

/** The listed strategies this server knows, or by default every one the commands allow. */
export const checkpointStrategies = (
  manifest: VcsPluginManifest,
): ReadonlyArray<VcsPluginCheckpointStrategy> =>
  manifest.checkpoints === undefined
    ? (["native", "changed-files"] as const).filter((strategy) =>
        STRATEGY_COMMANDS[strategy].every((command) => manifest.commands[command] !== undefined),
      )
    : manifest.checkpoints.filter(isStrategy);

export const supportsWorktrees = (manifest: VcsPluginManifest) =>
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
        if (placeholder !== undefined && !allowed.includes(placeholder))
          errors.push(`${field}: {${placeholder}} is not available here.`);
      }
    }
  }
  for (const marker of manifest.detect.markers) {
    // Only `/` separates folders, so every platform and every check reads the same path.
    if (!isSafeRelativePath(marker) || marker.includes("\\"))
      errors.push(
        `detect.markers: "${marker}" must be a path inside the repository folder, with no spaces around it and \`/\` between folders.`,
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
      : argument.replace(PLACEHOLDER, (match, name: string | undefined) => {
          if (name === undefined) return match[0]!;
          const value = values[name];
          if (value === undefined) missing ??= name;
          return value ?? match;
        }),
  );
  return missing === undefined ? { argv: rendered } : { missing };
}

export const usesPlaceholder = (argv: ReadonlyArray<string> | undefined, name: string) =>
  argv
    ?.slice(1)
    .some((argument) => [...argument.matchAll(PLACEHOLDER)].some(([, found]) => found === name)) ===
  true;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(VcsPluginManifest));
const decodeFields = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const MANIFEST_FIELDS = new Set([
  "protocol",
  "kind",
  "id",
  "label",
  "icon",
  "check",
  "detect",
  "checkpoints",
  "commands",
]);

/** Fields, commands and strategies this server skips: a typo would otherwise go unnoticed. */
const ignoredParts = Effect.fnUntraced(function* (text: string, manifest: VcsPluginManifest) {
  const fields = yield* decodeFields(text).pipe(Effect.orElseSucceed(() => ({})));
  const notes: string[] = [];
  for (const field of Object.keys(fields))
    if (!MANIFEST_FIELDS.has(field))
      notes.push(`${field}: not a field this server knows; ignored.`);
  const commands = (fields as Record<string, unknown>).commands;
  if (typeof commands === "object" && commands !== null)
    for (const command of Object.keys(commands))
      if (command === "check" || !(command in COMMAND_PLACEHOLDERS))
        notes.push(`commands.${command}: not a command this server knows; ignored.`);
  for (const strategy of manifest.checkpoints ?? [])
    if (!isStrategy(strategy))
      notes.push(`checkpoints: "${strategy}" is not a strategy this server knows; skipped.`);
  return notes;
});

export interface ReadManifestResult {
  readonly manifest: VcsPluginManifest | null;
  /**
   * Atelier fork: the safe markers the file names, even when it is invalid, so the plugin's
   * checkouts stay guarded from walks and from Git while it cannot run.
   */
  readonly markers: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
  /** What the server ignored, such as an unknown command; the plugin still works. */
  readonly notes: ReadonlyArray<string>;
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
      markers: [],
      errors: [`${PLUGIN_MANIFEST_FILE_NAME} is missing or unreadable.`],
      notes: [],
    } satisfies ReadManifestResult;
  const markers = namedMarkers(text.value);
  const decoded = yield* decodeManifest(text.value).pipe(Effect.result);
  if (decoded._tag === "Failure")
    return {
      manifest: null,
      markers,
      errors: [`${PLUGIN_MANIFEST_FILE_NAME}: ${decoded.failure.message}`],
      notes: [],
    } satisfies ReadManifestResult;
  const errors = validateManifest(decoded.success);
  return {
    manifest: errors.length === 0 ? decoded.success : null,
    markers,
    errors,
    notes: yield* ignoredParts(text.value, decoded.success),
  } satisfies ReadManifestResult;
});

function namedMarkers(text: string): ReadonlyArray<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const markers = (parsed as { detect?: { markers?: unknown } } | null)?.detect?.markers;
  if (!Array.isArray(markers)) return [];
  // As many as a valid manifest may hold: every walk probes each one.
  return markers
    .slice(0, 8)
    .filter(
      (marker): marker is string =>
        typeof marker === "string" && isSafeRelativePath(marker) && !marker.includes("\\"),
    );
}

/** Resolves `./` inside the real plugin folder, so a symlink cannot reach outside it. */
export const resolvePluginFile = Effect.fn("pluginManifest.resolvePluginFile")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, directory: string, relativePath: string) {
    const root = yield* fs.realPath(directory);
    const target = yield* fs.realPath(path.join(root, relativePath));
    const relative = path.relative(root, target);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return null;
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

// A whole SVG document, so a cut-off file is refused rather than drawn as nothing: one `<svg>`
// root, every element closed in order, and only comments or whitespace around it.
const isWholeSvg = (text: string) => {
  const body = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/i, "")
    .trim();
  if (!/^<svg[\s>/]/i.test(body) || !/<\/svg\s*>$/i.test(body)) return false;
  // Every `<` starts a whole tag, so a quote left open cannot hide one.
  const tag =
    /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s"'<>/=]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
  const open: string[] = [];
  let closedRoot = false;
  for (let at = body.indexOf("<"); at !== -1; at = body.indexOf("<", tag.lastIndex)) {
    tag.lastIndex = at;
    const match = tag.exec(body);
    if (match === null || closedRoot) return false;
    const name = match[2]!;
    // An attribute given twice makes the document invalid XML.
    const attributes = [
      ...match[3]!.matchAll(/\s+([^\s"'<>/=]+)\s*=\s*(?:"[^"<]*"|'[^'<]*')/g),
    ].map((found) => found[1]);
    if (new Set(attributes).size !== attributes.length) return false;
    if (match[1] === "/") {
      if (open.pop() !== name || match[4] === "/" || attributes.length > 0) return false;
    } else if (match[4] !== "/") open.push(name);
    if (open.length === 0) closedRoot = true;
  }
  return closedRoot;
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
