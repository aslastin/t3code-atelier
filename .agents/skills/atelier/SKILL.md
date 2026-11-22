---
name: atelier
description: Maintain the T3 Code Atelier fork. Use when the user finishes a fork feature, asks to build, rebuild, install, or update the T3 Code (Atelier) app, or asks to sync the fork with upstream T3 Code.
---

# T3 Code Atelier

This checkout is T3 Code Atelier, a personal fork of T3 Code. [ATELIER.md](../../../ATELIER.md)
describes it. Installed builds are named `T3 Code (Atelier)` and are versioned
`<upstream version>+atelier.<N>`:

- The upstream version comes from `apps/desktop/package.json`. Never edit it.
- `N` is the number of finished fork features, stored in `atelier-build-number` at the repository
  root. It only grows. It changes only when the user says a feature is finished, never at build
  time and never when upstream changes.

Pick the workflow that matches the request. Ask the user when the request is ambiguous rather than
guessing.

## Finish a feature

Use when the user says a fork feature is done or ready, or asks to land it.

1. Confirm which branch holds the feature and which branch the fork builds from (normally `main`).
   If either is unclear, or it is unclear whether the work is a finished feature, ask.
2. Merge the feature branch into the build branch. Stop and show the user any conflicts.
3. Increase the number in `atelier-build-number` by exactly 1.
4. Add the feature to the numbered list in "Differences from upstream" in `ATELIER.md`, using the
   new number and one line describing what it does for the user. A sync preview checks features
   by running the test files the fork changed, so if the feature has no tests, say so and offer to
   add them.
5. Run `vp run check:changed`, then commit steps 3 and 4 together as
   `chore(atelier): feature <N>: <short name>`.

Tests, fixes, refactors, and follow-up commits to a feature that already has a number do not
raise `N`. A finished feature raises it once, however many commits it took.

## Build and install the app

Use when the user asks to build, rebuild, install, or update the installed app. Do not change
`atelier-build-number` here.

1. Prerequisites: `vp` (Vite+, in `~/.local/share/vite-plus/bin` if not on `PATH`), Xcode Command
   Line Tools (`xcode-select -p`), and Rust (`rustc --version`). If one is missing, tell the user
   how to install it and stop.
2. Build from the branch the user wants (default: the build branch):

   ```sh
   vp i
   vp run dist:atelier:dmg
   ```

   It prints `[atelier-dmg] building T3 Code (Atelier) <version>`, and the desktop build lists the
   artifacts at the end. electron-builder drops `+atelier.<N>` from file names, so the DMG is
   `release/T3-Code-<upstream version>-<arch>.dmg` and each build overwrites the previous one.
   Pass extra flags such as `--arch x64` after the command.

3. Before replacing the installed app, check whether it is running with
   `lsappinfo info -only pid io.github.aslastin.t3code-atelier`: it prints `"pid"=<n>` only while
   the app runs. If it is running, ask the user to quit it with Cmd+Q and wait for their
   confirmation. Never quit or kill it yourself.
4. Install the DMG you just built:

   ```sh
   dmg="release/T3-Code-<upstream version>-<arch>.dmg"
   mnt="$(mktemp -d)"
   hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg"
   rm -rf "/Applications/T3 Code (Atelier).app"
   ditto "$mnt/T3 Code (Atelier).app" "/Applications/T3 Code (Atelier).app"
   hdiutil detach "$mnt"
   ```

   Only ever replace `T3 Code (Atelier).app`. The official `T3 Code (Beta).app` must stay
   untouched.

5. Verify the installed version and report it to the user. `Info.plist` and Finder show only the
   upstream version; the app itself, its About panel, and version checks use the full one. Read it
   from the app bundle, running from `scripts/`, which has `@electron/asar`:

   ```sh
   node -e 'const asar = require("@electron/asar"); console.log(JSON.parse(asar.extractFile(process.argv[1], "package.json")).version)' "/Applications/T3 Code (Atelier).app/Contents/Resources/app.asar"
   ```

   Also confirm `plutil -extract CFBundleIdentifier raw "/Applications/T3 Code (Atelier).app/Contents/Info.plist"`
   prints `io.github.aslastin.t3code-atelier`.

User data lives in `~/.t3-atelier` and `~/Library/Application Support/t3code-atelier`, outside the
app, so replacing the app keeps it. A new build may migrate the database forward, so before an
update that includes upstream changes, offer to back up `~/.t3-atelier` while the app is closed.
Never delete or edit that data, and never touch the official app's `~/.t3`.

## Preview a sync

Use when the user asks whether syncing with upstream is safe, and always as the first part of a
sync. It never touches the build branch.

1. Make sure the remote exists: `git remote get-url upstream` should be
   `https://github.com/pingdotgg/t3code.git`. Add it if missing. Then `git fetch upstream`.
2. Survey what is coming. Work out the fork's files from git instead of trusting a list, because
   fork features also edit upstream files:

   ```sh
   base="$(git merge-base main upstream/main)"
   git log --oneline main..upstream/main                 # incoming commits; none means stop here
   git diff --name-only --no-renames "$base" main | sort > /tmp/atelier-fork-files
   git diff --name-only --no-renames "$base" upstream/main | sort > /tmp/atelier-upstream-files
   comm -12 /tmp/atelier-fork-files /tmp/atelier-upstream-files   # files both sides changed
   ```

   For each file both sides changed, note the upstream commits that touched it
   (`git log --oneline "$base"..upstream/main -- <file>`). These are the likely conflicts and the
   places where a clean rebase can still break a fork feature.

3. Scan upstream for changes that could silently undo the fork's identity. Upstream code that
   introduces a data path, profile name, or bundle id without going through the code the fork
   patched would make the Atelier app read or write the official app's data in `~/.t3`:

   ```sh
   git diff --no-renames "$base" upstream/main -- apps packages scripts ':!*.test.*' \
     | grep -nE '^\+.*(com\.t3tools\.t3code|T3 Code \(Beta\)|t3code-v2|\.t3["/]|assets/prod)'
   ```

   Read each hit and decide whether it bypasses the fork's changes. Hits inside the fork's own
   files are expected.

4. Trial the rebase in a separate worktree next to this checkout, on a throwaway branch:

   ```sh
   git rev-parse main            # include this commit in the report
   git worktree add -b atelier/sync-preview ../t3code-atelier-sync main
   cd ../t3code-atelier-sync
   git rebase upstream/main
   ```

   If it stops on conflicts, record each conflicted file with both sides, run
   `git rebase --abort`, and skip to the report. Never resolve fork-specific code on your own.

5. If the rebase applied, check it in that worktree:

   ```sh
   vp i
   vp run check:changed
   vp test run $(git diff --name-only --diff-filter=d "$base" main -- '*.test.*')   # fork's tests
   ```

6. Report to the user, starting with what the sync brings: from the incoming commit titles, the new
   features and the fixes for bugs the user could hit, each in one plain line, grouped by area. Skip
   internal refactors, CI, and tests, and say so plainly when nothing notable arrives. Then: how
   many upstream commits arrive, the files both sides changed, any conflicts, the identity scan hits
   that need attention, and the check results with the output of anything that failed. Name fork
   features without tests as unverified. End with a recommendation that weighs what the sync brings
   against its risk: sync now, sync after resolving the listed conflicts together, or wait.
7. If the user does not go on to sync, remove the worktree and branch:
   `git worktree remove ../t3code-atelier-sync && git branch -D atelier/sync-preview`.

## Sync with upstream

Use when the user asks to update the fork from upstream T3 Code.

1. Run "Preview a sync" first and show the report. Continue only after the user confirms, and
   only if the preview rebase applied and its checks passed or the user accepted the failures.
2. Make sure the build branch is clean and `git rev-parse main` still prints the commit the
   preview started from. If it moved, preview again.
3. Keep a way back, then move the build branch onto the checked result:

   ```sh
   git tag "atelier/pre-sync-$(date +%Y-%m-%d)" main
   git switch main
   git reset --hard atelier/sync-preview
   git worktree remove ../t3code-atelier-sync
   git branch -D atelier/sync-preview
   vp i
   ```

   To undo the sync, `git reset --hard atelier/pre-sync-<date>` on the build branch.

4. Leave `atelier-build-number` unchanged. Pushing a rebased branch needs a force push; ask the
   user before pushing anything, including the tag.
5. Offer to build and install the updated app afterwards.
