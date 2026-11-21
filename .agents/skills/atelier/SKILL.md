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
   new number and one line describing what it does for the user.
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

   It prints `[atelier-dmg] building T3 Code (Atelier) <version>` and writes
   `release/T3-Code-<version>-<arch>.dmg`. Pass extra flags such as `--arch x64` after the command.

3. Before replacing the installed app, check whether it is running with
   `lsappinfo info -only pid io.github.aslastin.t3code-atelier`: it prints `"pid"=<n>` only while
   the app runs. If it is running, ask the user to quit it with Cmd+Q and wait for their
   confirmation. Never quit or kill it yourself.
4. Install the DMG you just built:

   ```sh
   dmg="release/T3-Code-<version>-<arch>.dmg"
   mnt="$(mktemp -d)"
   hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg"
   rm -rf "/Applications/T3 Code (Atelier).app"
   ditto "$mnt/T3 Code (Atelier).app" "/Applications/T3 Code (Atelier).app"
   hdiutil detach "$mnt"
   ```

   Only ever replace `T3 Code (Atelier).app`. The official `T3 Code (Beta).app` must stay
   untouched.

5. Verify with
   `plutil -extract CFBundleShortVersionString raw "/Applications/T3 Code (Atelier).app/Contents/Info.plist"`
   and report the installed version to the user.

User data lives in `~/.t3-atelier` and `~/Library/Application Support/t3code-atelier`, outside the
app, so replacing the app keeps it. A new build may migrate the database forward, so before an
update that includes upstream changes, offer to back up `~/.t3-atelier` while the app is closed.
Never delete or edit that data, and never touch the official app's `~/.t3`.

## Sync with upstream

Use when the user asks to update the fork from upstream T3 Code.

1. Make sure the remote exists: `git remote get-url upstream` should be
   `https://github.com/pingdotgg/t3code.git`. Add it if missing.
2. On the build branch with a clean working tree:

   ```sh
   git fetch upstream
   git rebase upstream/main
   vp i
   vp run check:changed
   ```

3. Stop and show the user any rebase conflicts instead of resolving fork-specific code on your own.
   Fork changes mostly live in `ATELIER.md`, `atelier-build-number`, `assets/atelier/`,
   `scripts/atelier-dmg.ts`, and this skill.
4. Leave `atelier-build-number` unchanged. Pushing a rebased branch needs a force push; ask the
   user before pushing anything.
5. Offer to build and install the updated app afterwards.
