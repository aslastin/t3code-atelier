// @effect-diagnostics nodeBuiltinImport:off - Fixtures write a plugin folder and its fake CLI.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * "Kite", a made-up VCS for tests. A repository keeps its committed files in `.kite/base/`, its
 * branch in `.kite/HEAD`, and snapshots in `.kite/snapshots/`. Every call is logged to
 * `.kite/calls.log` so tests can see which commands, and which files, a strategy touched.
 */
const KITE_CLI = String.raw`#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);
const findRoot = (start) => {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".kite", "HEAD"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};
const root = findRoot(process.cwd());
const kite = root && path.join(root, ".kite");
if (kite) fs.appendFileSync(path.join(kite, "calls.log"), [command, ...args].join(" ") + "\n");
const out = (value) => process.stdout.write(JSON.stringify(value));
const fail = (message) => {
  process.stderr.write(message + "\n");
  process.exit(1);
};
const walk = (dir, prefix = "") => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (prefix === "" && entry.name === ".kite") return [];
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
};
// A real VCS knows a file is unchanged from its own index; an unreadable one counts as unchanged.
const sameContents = (a, b) => {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return true;
  }
};
const changes = () => {
  const base = path.join(kite, "base");
  const baseFiles = new Set(walk(base));
  const work = new Set(walk(root));
  const files = [];
  const addedDirs = new Set();
  for (const file of work) {
    if (!baseFiles.has(file)) {
      const top = file.split("/")[0];
      // A new folder is one entry, as a VCS reports an untracked folder.
      if (file.includes("/") && ![...baseFiles].some((b) => b.startsWith(top + "/"))) {
        if (!addedDirs.has(top)) files.push({ path: top, status: "added" });
        addedDirs.add(top);
      } else files.push({ path: file, status: "added" });
    } else if (!sameContents(path.join(root, file), path.join(base, file)))
      files.push({ path: file, status: "modified" });
  }
  for (const file of baseFiles) if (!work.has(file)) files.push({ path: file, status: "deleted" });
  return files;
};
const copyTree = (from, to) => {
  for (const file of walk(from)) {
    fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
    fs.copyFileSync(path.join(from, file), path.join(to, file));
  }
};
const patch = (fromDir, toDir) => {
  const names = new Set([...walk(fromDir), ...walk(toDir)]);
  let text = "";
  for (const file of [...names].sort()) {
    const a = fs.existsSync(path.join(fromDir, file)) ? fs.readFileSync(path.join(fromDir, file), "utf8") : null;
    const b = fs.existsSync(path.join(toDir, file)) ? fs.readFileSync(path.join(toDir, file), "utf8") : null;
    if (a === b) continue;
    const lines = (value) => (value === null || value === "" ? [] : value.replace(/\n$/, "").split("\n"));
    const before = lines(a);
    const after = lines(b);
    text += "diff --git a/" + file + " b/" + file + "\n";
    text += "--- " + (a === null ? "/dev/null" : "a/" + file) + "\n";
    text += "+++ " + (b === null ? "/dev/null" : "b/" + file) + "\n";
    text += "@@ -1," + before.length + " +1," + after.length + " @@\n";
    for (const line of before) text += "-" + line + "\n";
    for (const line of after) text += "+" + line + "\n";
  }
  return text;
};
const snapshotDir = (revision) => path.join(kite, "snapshots", revision);
const readRefs = () => {
  const file = path.join(kite, "refs.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
};
const readList = () => {
  const file = path.join(kite, "worktrees.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
};

switch (command) {
  case "check": {
    const problemsFile = path.join(process.env.T3_PLUGIN_DIR ?? "", "problems.txt");
    const problems = fs.existsSync(problemsFile) ? [fs.readFileSync(problemsFile, "utf8").trim()] : [];
    out({ version: "1.2.3", problems });
    break;
  }
  case "status": {
    const files = changes().map((file) => ({ path: file.path, insertions: 1, deletions: 0 }));
    out({ refName: fs.readFileSync(path.join(kite, "HEAD"), "utf8").trim(), isDefaultRef: true, files });
    break;
  }
  case "bad-status":
    process.stdout.write("not json");
    break;
  case "worktree-add": {
    const [target, newRef] = args;
    copyTree(path.join(kite, "base"), target);
    fs.mkdirSync(path.join(target, ".kite"), { recursive: true });
    fs.writeFileSync(path.join(target, ".kite", "HEAD"), newRef + "\n");
    copyTree(path.join(kite, "base"), path.join(target, ".kite", "base"));
    fs.writeFileSync(path.join(kite, "worktrees.json"), JSON.stringify([...readList(), target]));
    fs.writeFileSync(path.join(kite, "refs.json"), JSON.stringify([...readRefs(), newRef]));
    out({ refName: newRef });
    break;
  }
  case "worktree-attach": {
    const [target, ref] = args;
    copyTree(path.join(kite, "base"), target);
    fs.mkdirSync(path.join(target, ".kite"), { recursive: true });
    fs.writeFileSync(path.join(target, ".kite", "HEAD"), ref + "\n");
    copyTree(path.join(kite, "base"), path.join(target, ".kite", "base"));
    fs.writeFileSync(path.join(kite, "worktrees.json"), JSON.stringify([...readList().filter((p) => p !== target), target]));
    break;
  }
  case "worktree-remove": {
    const [target] = args;
    fs.rmSync(target, { recursive: true, force: true });
    fs.writeFileSync(path.join(kite, "worktrees.json"), JSON.stringify(readList().filter((p) => p !== target)));
    break;
  }
  case "refs": {
    const head = fs.readFileSync(path.join(kite, "HEAD"), "utf8").trim();
    const names = [...new Set(["main", ...readRefs()])];
    out({ refs: names.map((name) => ({ name, current: name === head, isDefault: name === "main" })) });
    break;
  }
  case "worktree-list":
    out({ worktrees: readList().map((p) => ({ path: p })) });
    break;
  case "snapshot": {
    const dir = path.join(kite, "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    const revision = "snap-" + fs.readdirSync(dir).length;
    copyTree(root, snapshotDir(revision));
    out({ revision });
    break;
  }
  case "snapshot-diff": {
    const [from, to] = args;
    if (fs.existsSync(path.join(kite, "broken-snapshots"))) fail("NoSuchObject " + from);
    if (!fs.existsSync(snapshotDir(from)) || !fs.existsSync(snapshotDir(to))) fail("unknown snapshot");
    out({ patch: patch(snapshotDir(from), snapshotDir(to)) });
    break;
  }
  case "snapshot-restore": {
    const [revision] = args;
    for (const file of walk(root)) fs.rmSync(path.join(root, file));
    copyTree(snapshotDir(revision), root);
    break;
  }
  case "commit": {
    const [messageFile, pathsFile] = args;
    const message = fs.readFileSync(messageFile, "utf8").trim();
    const only = pathsFile ? fs.readFileSync(pathsFile, "utf8").split("\n").filter(Boolean) : null;
    const base = path.join(kite, "base");
    for (const change of changes()) {
      if (only && !only.includes(change.path)) continue;
      const from = path.join(root, change.path);
      const to = path.join(base, change.path);
      if (change.status === "deleted") fs.rmSync(to, { force: true });
      else if (fs.statSync(from).isDirectory()) copyTree(from, to);
      else {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
    const log = path.join(kite, "commits.log");
    fs.appendFileSync(log, message.split("\n")[0] + "\n");
    const count = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    out({ commitSha: "kite-" + count, subject: message.split("\n")[0] });
    break;
  }
  case "diff":
    out({ patch: patch(path.join(kite, "base"), root) });
    break;
  case "changed":
    out({ revision: "base-1", files: changes() });
    break;
  case "show": {
    const [revision, file] = args;
    const target = path.join(kite, "base", file);
    if (revision !== "base-1" || !fs.existsSync(target)) fail("no such file");
    process.stdout.write(fs.readFileSync(target));
    break;
  }
  default:
    fail("unknown command " + command);
}
`;

export interface FakeVcsPluginOptions {
  readonly id?: string;
  readonly checkpoints?: ReadonlyArray<string>;
  readonly statusCommand?: string;
  readonly extraManifest?: Record<string, unknown>;
  /** What `check` reports as a problem. */
  readonly problem?: string;
}

/** Writes a plugin folder for the Kite VCS and returns its path. */
export function writeFakeVcsPlugin(directory: string, options: FakeVcsPluginOptions = {}) {
  NodeFS.mkdirSync(NodePath.join(directory, "bin"), { recursive: true });
  const cli = NodePath.join(directory, "bin", "kite.mjs");
  NodeFS.writeFileSync(cli, KITE_CLI, { mode: 0o755 });
  NodeFS.writeFileSync(
    NodePath.join(directory, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#3b82f6"/></svg>',
  );
  if (options.problem)
    NodeFS.writeFileSync(NodePath.join(directory, "problems.txt"), options.problem);
  const kite = "./bin/kite.mjs";
  NodeFS.writeFileSync(
    NodePath.join(directory, "plugin.json"),
    JSON.stringify(
      {
        protocol: "t3-plugin/1",
        kind: "vcs",
        id: options.id ?? "kite",
        label: "Kite",
        icon: "icon.svg",
        check: [kite, "check"],
        detect: { markers: [".kite/HEAD"] },
        capabilities: { worktrees: true },
        ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
        commands: {
          status: [kite, options.statusCommand ?? "status"],
          listRefs: [kite, "refs"],
          commit: [kite, "commit", "{messageFile}", "{pathsFile}"],
          diff: [kite, "diff"],
          worktreeCreate: [kite, "worktree-add", "{path}", "{newRef}", "{baseRef}"],
          worktreeRemove: [kite, "worktree-remove", "{path}"],
          worktreeAttach: [kite, "worktree-attach", "{path}", "{ref}"],
          worktreeList: [kite, "worktree-list"],
          checkpointCapture: [kite, "snapshot"],
          checkpointDiff: [kite, "snapshot-diff", "{fromRevision}", "{toRevision}"],
          checkpointRestore: [kite, "snapshot-restore", "{revision}"],
          changedFiles: [kite, "changed"],
          readFile: [kite, "show", "{revision}", "{path}"],
        },
        ...options.extraManifest,
      },
      null,
      2,
    ),
  );
  return directory;
}

/** A Kite repository whose committed files are `files`, checked out unchanged. */
export function makeFakeRepository(root: string, files: Readonly<Record<string, string>>) {
  for (const [file, contents] of Object.entries(files)) {
    for (const target of [NodePath.join(root, ".kite", "base", file), NodePath.join(root, file)]) {
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, contents);
    }
  }
  NodeFS.writeFileSync(NodePath.join(root, ".kite", "HEAD"), "main\n");
  return root;
}

/** Commands the fake CLI ran in the repository at `root`, oldest first. */
export function fakeCalls(root: string): ReadonlyArray<string> {
  const log = NodePath.join(root, ".kite", "calls.log");
  return NodeFS.existsSync(log)
    ? NodeFS.readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
    : [];
}
