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
**Unavailable**, with the failure or the problems under its name, and its repositories are not
detected. Fix the problem, then use the refresh button on its row to check it again. The switch
turns a plugin off without removing it, and **Remove** deletes the installed copy. Importing a
plugin, turning it on or off, and removing it need permission to maintain the environment. The
mobile app shows the list and status only.

A repository is detected by a marker file, without running anything. T3 Code looks for each
marker in the project folder and every folder above it. When a Git repository is found too, the
one closer to the project folder wins; in the same folder, the plugin wins. Avoid installing two
plugins whose markers can sit in the same folder: only one of them owns it.

In a plugin's repository, even while the plugin is off, T3 Code does not walk or index the
project's files: a large repository or a network mount could make that slow or download every
file. File mentions (`@`), the file tree's filter, and text search (`Ctrl+Shift+F` / `⌘⇧F`) say
file search is not available, though `@` still finds threads and models by name. Opening a link by
file name finds nothing. Browsing the file tree one folder at a time still works, and a Git
repository inside keeps its own search.

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
  "commands": {
    "status": ["./bin/status.mjs"],
    "refList": ["./bin/refs.mjs"],
    "commit": ["myvcs", "commit", "--all", "--file", "{messageFile}"],
    "push": ["myvcs", "push"],
    "pull": ["myvcs", "pull"],
    "diff": ["myvcs", "diff"],
    "log": ["myvcs", "log", "--format=%s", "-n", "20"],
    "branchCreate": ["myvcs", "checkout", "-b", "{newRef}"],
    "branchRename": ["myvcs", "branch", "-m", "{oldRef}", "{newRef}"],
    "fetchBase": ["./bin/fetch-base.mjs", "{ref}"],
    "worktreeCreate": ["myvcs", "worktree", "add", "{worktreePath}", "-b", "{newRef}", "{baseRef}"],
    "worktreeRemove": ["myvcs", "worktree", "remove", "{worktreePath}"],
    "worktreeAttach": ["myvcs", "worktree", "add", "{worktreePath}", "{ref}"],
    "worktreeList": ["./bin/worktree-list.mjs"],
    "changedFiles": ["./bin/changed-files.mjs"],
    "readFile": ["myvcs", "show", "{revision}:{path}"],
  },
}
```

- `id` is lowercase letters, digits, and dashes, and must match the folder name once installed.
  `git`, `jj`, `unknown`, and `auto` are taken.
- Only `check` and `status` are required. Every other command adds a feature, listed below.
- Commands are argument lists. No shell runs them, so on Windows a `.cmd` or `.bat` file is
  refused; use an executable or a script run by its interpreter. The first item is either `./`
  and a file in the plugin folder, or a bare name looked up on the server's `PATH`. Absolute
  paths are refused, and so is a `./` path that a symbolic link points outside the folder. The
  icon must also be an `.svg` file in the folder, at most 64 KB. It is shown as an image, so it
  does not take the theme's text color: give shapes an explicit `fill` or `stroke` and check the
  icon on both light and dark backgrounds.
- A placeholder such as `{newRef}` is replaced inside an argument and never splits it into more
  arguments. Each command may use only its own placeholders, listed below, and `{repositoryRoot}`.
  Write `{{` and `}}` for a literal brace, as in `@{{upstream}}`.
- `detect.markers` are paths inside the repository's own metadata folder. Pick a specific one:
  `.myvcs/HEAD`, not `.myvcs`, if your VCS also keeps a folder of that name in the home directory.
- Commands run in the project folder with a clean environment: `PATH`, `HOME`, the locale, the
  temporary folder, and `SSH_AUTH_SOCK` are passed on, plus `T3_PLUGIN_DIR` and
  `T3_PLUGIN_PROTOCOL`.
- Most commands time out after 30 seconds. Checkpoint commands get two minutes. `commit`,
  `push`, `pull`, `fetchBase`, `worktreeCreate`, `worktreeAttach` and `worktreeRemove` run as
  long as they need.
- A command succeeds when it exits with 0; its stderr is then ignored, so warnings there are
  harmless. When it fails, T3 Code shows the last line it wrote to stderr, up to 200 characters,
  as the reason. Make that line say what went wrong, and keep secrets out of it.
- Long text, such as a commit message, is passed as a file.
- Output that does not match the contract below is an error. Settings shows the last one on the
  plugin's row. A field, command, or checkpoint strategy this server does not know is ignored and
  noted there, so a typo in a command name shows.

### Operations

Commands print JSON only where the result is structured. Optional fields are marked `?`.

| Command             | Placeholders                              | Prints                                                                                                                                                                               |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `check` (required)  |                                           | `{ "version", "problems": [string] }`. Runs in the plugin folder. Settings shows each problem as the reason the plugin is unavailable, so say what to do, such as `Run myvcs login.` |
| `status` (required) |                                           | `{ "ref": string \| null, "default"?, "hasPrimaryRemote"?, "files"?: [{ "path", "insertions"?, "deletions"?, "untracked"? }], "hasUpstream"?, "aheadCount"?, "behindCount"? }`       |
| `refList`           |                                           | `{ "refs": [{ "name", "current"?, "default"?, "remote"?, "remoteName"? }] }`. Without it, only the current ref is offered.                                                           |
| `commit`            | `{messageFile}`, `{pathsFile}`            | Anything, or `{ "commitSha"?, "subject"? }`. `{pathsFile}` lists the files to commit, one per line: the selected ones, or every changed file. Without it, only "commit all" works.   |
| `push`              |                                           | Anything, or `{ "branch"?, "upstreamBranch"? }`.                                                                                                                                     |
| `pull`              |                                           | Anything, or `{ "status"?: "pulled" \| "skipped_up_to_date", "ref"?, "upstreamRef"? }`.                                                                                              |
| `diff`              | `{pathsFile}`                             | The uncommitted changes as a Git-format patch, only of `{pathsFile}` when given.                                                                                                     |
| `log`               |                                           | Recent commit subjects, one per line, newest first.                                                                                                                                  |
| `branchCreate`      | `{newRef}`                                | Anything. Start `{newRef}` from the checkout and switch to it, keeping uncommitted changes.                                                                                          |
| `branchRename`      | `{oldRef}`, `{newRef}`                    | Anything. Rename branch `{oldRef}` to `{newRef}`. T3 Code picks a `{newRef}` that `refList` does not list.                                                                           |
| `fetchBase`         | `{ref}`                                   | The ref or revision a worktree should start from, such as a remote-tracking ref. Bring `{ref}` up to date from the remote without changing the checkout or its files.                |
| `worktreeCreate`    | `{worktreePath}`, `{newRef}`, `{baseRef}` | Anything, or `{ "ref" }` when the VCS named the branch other than `{newRef}`. Create the checkout at `{worktreePath}`; T3 Code chooses it, as it does for Git.                       |
| `worktreeRemove`    | `{worktreePath}`                          | Anything.                                                                                                                                                                            |
| `worktreeAttach`    | `{worktreePath}`, `{ref}`                 | Anything. Check out the existing `{ref}` at `{worktreePath}`.                                                                                                                        |
| `worktreeList`      |                                           | `{ "worktrees": [{ "path", "ref"? }] }` with absolute paths; `ref` is the branch checked out there.                                                                                  |
| `checkpointCapture` |                                           | The new snapshot's revision.                                                                                                                                                         |
| `checkpointDiff`    | `{fromRevision}`, `{toRevision}`          | A Git-format patch between the two snapshots. Must fail when either revision cannot be read.                                                                                         |
| `checkpointRestore` | `{revision}`                              | Anything.                                                                                                                                                                            |
| `checkpointDelete`  | `{revision}`                              | Anything.                                                                                                                                                                            |
| `changedFiles`      |                                           | `{ "revision", "files": [{ "path", "status": "modified" \| "added" \| "deleted", "executable"?, "symlink"? }] }`; both flags are as at `revision`.                                   |
| `readFile`          | `{revision}`, `{path}`                    | The file's bytes, or a link's target. Exit with a non-zero code when it does not exist at that revision.                                                                             |

"Anything" means T3 Code reads nothing from the output unless it is a JSON object. Paths are
relative to the repository root and use `/`.

With `worktreeCreate`, `worktreeRemove` and `worktreeList`, **New worktree** is offered for the
plugin's repositories. A new worktree starts on a temporary branch; with `branchRename`, T3 Code
renames it after the thread's first message, as it does for Git, and without it the branch keeps
its temporary name. **Start from remote** is offered with `fetchBase`: T3 Code runs it in the
repository, then passes the ref it printed to `worktreeCreate` as `{baseRef}`. Commit, push and
pull are offered only when their commands exist. Without a typed message, T3 Code writes one as
it does for Git, from the files `status` lists and, when the plugin has it, the patch `diff`
prints. With `log`, the message follows your repository's recent subjects. **Commit on a new
branch** needs `branchCreate`; T3 Code names the branch as it does for Git. Pull requests, the
branch comparison, and sparse checkouts stay Git-only.

Within `t3-plugin/1`, new versions of T3 Code only add optional commands, optional output fields,
and placeholders for new commands, so a plugin keeps working as T3 Code updates.

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
  branch out again with `worktreeAttach`, so the repository's `refList` must still list that
  branch. Without both commands, cleanup removes only a deleted thread's worktree.

### Checkpoints

T3 Code snapshots each turn so you can see its diff and roll it back. `checkpoints` lists the
strategies T3 Code may use, in order, and it never uses one you did not list. Without the field,
a plugin gets every strategy its commands allow: `native`, then `changed-files`. `full` is used
only when listed. A thread's first snapshot tries them in that order. Later
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

process.stdout.write(JSON.stringify({ ref: branch || null, files }));
```

Make scripts executable (`chmod +x bin/*.mjs`) before you import the folder.
