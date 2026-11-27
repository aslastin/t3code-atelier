# VCS plugins

A VCS plugin teaches T3 Code a version control system it does not ship. It is a folder with a
`plugin.json` manifest, an SVG icon, and optional wrapper scripts. The manifest maps T3 Code's
operations to commands your VCS's CLI already has. T3 Code runs them on the machine that hosts the
environment.

## Install, update, and remove a plugin

1. Put the plugin folder on the environment's machine.
2. Open **Settings → Source control**. Under **VCS plugins**, enter the folder's path or pick it
   with **Choose folder…**, then choose **Import**. You can also run **Import VCS plugin** from the
   command palette. For a remote environment, both browse that machine's folders, not yours.

T3 Code checks the manifest and the files it names, runs the plugin's `check` command, and copies
the folder to `<T3 home>/plugins/<id>/`. Importing a folder with the same `id` again replaces the
installed copy. Edits to the original folder have no effect until you import it again.

Each plugin shows whether it works. A plugin whose `check` fails, or reports a problem, is marked
**Unavailable** and its repositories are not detected. Fix the problem, then use the refresh
button on its row to check it again. The switch turns a plugin off without removing it, and
**Remove** deletes the installed copy. Importing a plugin, turning it on or off, and removing it
need permission to maintain the environment. The mobile app shows the list and status only.

A repository is detected by a marker file, without running anything. T3 Code looks for each
marker in the project folder and every folder above it. When a Git repository is found too, the
one closer to the project folder wins; in the same folder, the plugin wins. Avoid installing two
plugins whose markers can sit in the same folder: only one of them owns it.

In a plugin's repository, even while the plugin is off, T3 Code does not walk or index the
project's files: a large repository or a network mount could make that slow or download every
file. File mentions (`@`), the file tree's filter, and opening a link by file name find nothing,
and text search (`Ctrl+Shift+F` / `⌘⇧F`) says it is not available. Browsing the file tree one
folder at a time still works, and a Git repository inside keeps its own search.

## Write a plugin

```jsonc
{
  "protocol": "t3-plugin/1",
  "kind": "vcs",
  "id": "myvcs",
  "label": "MyVCS",
  "icon": "icon.svg",
  "check": ["./bin/check.mjs"],
  "detect": { "markers": [".myvcs/HEAD"] },
  "capabilities": { "worktrees": true },
  "checkpoints": ["native", "changed-files"],
  "commands": {
    "status": ["./bin/status.mjs"],
    "listRemotes": ["./bin/remotes.mjs"],
    "commit": ["myvcs", "commit", "--all", "--file", "{messageFile}"],
    "diff": ["./bin/diff.mjs"],
    "log": ["./bin/log.mjs"],
    "branchCreate": ["myvcs", "checkout", "-b", "{newRef}"],
    "worktreeCreate": ["./bin/worktree-add.mjs", "{path}", "{newRef}", "{baseRef}"],
    "worktreeRemove": ["./bin/worktree-remove.mjs", "{path}"],
    "worktreeAttach": ["./bin/worktree-attach.mjs", "{path}", "{ref}"],
    "worktreeList": ["./bin/worktree-list.mjs"],
    "checkpointCapture": ["./bin/snapshot.mjs"],
    "checkpointDiff": ["./bin/snapshot-diff.mjs", "{fromRevision}", "{toRevision}"],
    "checkpointRestore": ["./bin/snapshot-restore.mjs", "{revision}"],
    "changedFiles": ["./bin/changed-files.mjs"],
    "readFile": ["myvcs", "show", "{revision}:{path}"],
  },
}
```

- `id` is lowercase letters, digits, and dashes, and must match the folder name once installed.
  `git`, `jj`, `unknown`, and `auto` are taken.
- Commands are argument lists. No shell runs them, so on Windows a `.cmd` or `.bat` file is
  refused; use an executable or a script run by its interpreter. The first item is either `./` and a file in
  the plugin folder, or a bare name looked up on the server's `PATH`. Absolute paths are refused,
  and so is a `./` path that a symbolic link points outside the folder. The icon must also be an
  `.svg` file in the folder, at most 64 KB. It is shown as an image, so it does not take the
  theme's text color: give shapes an explicit `fill` or `stroke` and check the icon on both light
  and dark backgrounds.
- A placeholder such as `{path}` is replaced inside an argument and never splits it into more
  arguments. Each command may use only its own placeholders, listed below, and `{repositoryRoot}`.
- `detect.markers` are paths inside the repository's own metadata folder. Pick a specific one:
  `.myvcs/HEAD`, not `.myvcs`, if your VCS also keeps a folder of that name in the home directory.
- Commands run in the project folder with a clean environment: `PATH`, `HOME`, the locale, the
  temporary folder, and `SSH_AUTH_SOCK` are passed on, plus `T3_PLUGIN_DIR` and
  `T3_PLUGIN_PROTOCOL`. Most commands time out after 30 seconds; `worktreeCreate` never does.
- A command succeeds when it exits with 0. Its stderr is then ignored, so warnings there are
  harmless. On failure, T3 Code shows that the command failed, not its output.
- Long text, such as a commit message, is passed as a file.
- Output that does not match the contract below is an error. Settings shows the last one on the
  plugin's row.

### Operations

Every command except `readFile` prints one JSON object on stdout. Optional fields are marked `?`.

| Command             | Placeholders                      | Prints                                                                                                                                                                                  |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`             |                                   | `{ "version", "problems": [string] }`. Runs in the plugin folder.                                                                                                                       |
| `status` (required) |                                   | `{ "refName": string \| null, "isDefaultRef"?, "hasPrimaryRemote"?, "files"?: [{ "path", "insertions"?, "deletions"?, "untracked"? }], "hasUpstream"?, "aheadCount"?, "behindCount"? }` |
| `listRemotes`       |                                   | `{ "remotes": [{ "name", "url", "pushUrl"?, "isPrimary"? }] }`. A VCS without URLs uses `<vcs>://<repository>`.                                                                         |
| `listRefs`          |                                   | `{ "refs": [{ "name", "current"?, "isDefault"?, "isRemote"?, "remoteName"? }] }`. Without it, only the current ref is offered.                                                          |
| `commit`            | `{messageFile}`, `{pathsFile}`    | `{ "commitSha"?, "subject"? }`. `{pathsFile}` lists the files to commit, one per line: the selected ones, or every changed file. Without it, only "commit all" works.                   |
| `diff`              | `{pathsFile}`                     | `{ "patch" }`, the uncommitted changes as a Git-format patch, only of `{pathsFile}` when given. Optional.                                                                               |
| `log`               |                                   | `{ "subjects": [string] }`, recent commit subjects, newest first. Optional.                                                                                                             |
| `branchCreate`      | `{newRef}`                        | Anything. Start `{newRef}` from the checkout and switch to it, keeping uncommitted changes. Optional.                                                                                   |
| `push`              |                                   | `{ "branch"?, "upstreamBranch"? }`                                                                                                                                                      |
| `pull`              |                                   | `{ "status": "pulled" \| "skipped_up_to_date", "refName", "upstreamRef"? }`                                                                                                             |
| `worktreeCreate`    | `{path}`, `{newRef}`, `{baseRef}` | `{ "refName" }`. Create the checkout at `{path}`; T3 Code chooses it, as it does for Git.                                                                                               |
| `worktreeRemove`    | `{path}`                          | Anything.                                                                                                                                                                               |
| `worktreeAttach`    | `{path}`, `{ref}`                 | Anything. Check out the existing `{ref}` at `{path}`. Optional.                                                                                                                         |
| `worktreeList`      |                                   | `{ "worktrees": [{ "path" }] }` with absolute paths.                                                                                                                                    |
| `checkpointCapture` | `{checkpointRef}`                 | `{ "revision" }`                                                                                                                                                                        |
| `checkpointDiff`    | `{fromRevision}`, `{toRevision}`  | `{ "patch" }`, a Git-format patch. Must fail when either revision cannot be read.                                                                                                       |
| `checkpointRestore` | `{revision}`                      | Anything.                                                                                                                                                                               |
| `checkpointDelete`  | `{revision}`                      | Anything. Optional.                                                                                                                                                                     |
| `changedFiles`      |                                   | `{ "revision", "files": [{ "path", "status": "modified" \| "added" \| "deleted", "executable"?, "symlink"? }] }`; both flags are as at `revision`.                                      |
| `readFile`          | `{revision}`, `{path}`            | The file's bytes, or a link's target. Exit with a non-zero code when it does not exist at that revision.                                                                                |

Paths are relative to the repository root and use `/`. With `capabilities.worktrees`,
`worktreeCreate`, `worktreeRemove` and `worktreeList` are required, and **New worktree** is offered for the
plugin's repositories. Commit and push are offered only when their commands exist. Without a
typed message, T3 Code writes one as it does for Git, from the files `status` lists and, when the
plugin has it, the patch `diff` prints. With `log`, the message follows your repository's recent
subjects. **Commit on a new branch** needs `branchCreate`; T3 Code names the branch as it does for
Git. Pull requests, the branch comparison, and sparse checkouts stay Git-only.

When a project is a subfolder of the repository, a new worktree's thread works in the same
subfolder of the new checkout.

Storage cleanup removes a plugin's worktrees as it does Git's, when their thread is deleted,
inactive or settled. The merged and unchanged rules need Git history, so they do not apply. A
worktree stays when:

- `status` lists a file, except one marked `"untracked": true` when cleanup keeps worktrees only
  for tracked changes.
- `status` reports an `aheadCount` above 0. If your VCS keeps a worktree's branch inside the
  worktree, report unpushed commits there, counted from the branch's base when it has no
  upstream, or they are lost with the worktree.
- Its thread is still live and the plugin cannot bring it back. A thread's next turn checks its
  branch out again with `worktreeAttach`, so the repository's `listRefs` must still list that
  branch. Without both commands, cleanup removes only a deleted thread's worktree.

### Checkpoints

T3 Code snapshots each turn so you can see its diff and roll it back. `checkpoints` lists the
strategies T3 Code may use, in order, and it never uses one you did not list. Without the field, a
plugin gets `["changed-files"]`. A thread's first snapshot tries them in that order. Later
snapshots in the thread try the strategy of the previous one first, because snapshots taken with
different strategies cannot be compared. After a fallback, the thread stays on the fallback, and
a new thread starts from the top of the list again.

- `native` uses `checkpointCapture`, `checkpointDiff`, and `checkpointRestore`. After each
  capture, T3 Code diffs the new snapshot against itself to make sure it reads back, and moves on
  to the next strategy if it does not. A native snapshot covers the whole repository, so it is
  used only for a project at the repository's root with no repository nested inside that keeps its
  own checkpoints. **Ignore whitespace** does not change its diffs. A revision must name one
  snapshot for good: never hand it out again once its snapshot is gone. Storage cleanup keeps a
  live thread's worktree that holds native snapshots, since the plugin may store them inside it.
- `changed-files` asks `changedFiles` for the changed paths and keeps a copy of them in a Git
  repository under T3 home. Only modified and added files are read, and deletions are recorded
  without reading anything. A new folder reported as one entry is read in full. Unchanged files
  are never read; when a diff needs their committed version, it comes from `readFile`. Two
  snapshots can be compared only when `changedFiles` reported the same `revision` for both.
- `full` copies the whole thread folder into that Git repository. It reads every file, so on a
  network or FUSE mount it downloads the whole folder. Only list it if that is acceptable. A Git
  repository inside the folder is kept as its commit alone.

With `changed-files` and `full`, a rollback never removes a repository inside the folder, whether
Git's, a bare one, or another installed plugin's checkout, and never writes into or over one. When
it would have to, it is refused before anything changes.

If no listed strategy works, the turn has no checkpoint. Its changes cannot be shown or rolled
back, and the conversation says why.

### Example wrapper script

A wrapper turns your CLI's own output into the contract. This `status` script assumes a CLI that
prints porcelain lines such as `M src/app.ts`:

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const branch = execFileSync("myvcs", ["branch", "--show-current"], { encoding: "utf8" }).trim();
const files = execFileSync("myvcs", ["status", "--porcelain"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map((line) => ({ path: line.slice(2).trim() }));

process.stdout.write(JSON.stringify({ refName: branch || null, files }));
```

Make scripts executable (`chmod +x bin/*.mjs`) before you import the folder.
