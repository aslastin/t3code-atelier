# T3 Code Atelier

## What this is

T3 Code Atelier is an unofficial personal fork of [T3 Code](https://github.com/pingdotgg/t3code).
It is not affiliated with or endorsed by T3 Tools Inc.

There are no prebuilt binaries. Build it from source.

## Differences from upstream

Each finished fork feature is numbered here. The latest number is in `atelier-build-number` and
appears in the app version as `+atelier.<N>`.

1. **Atelier identity.** The app is named **T3 Code (Atelier)**, uses the Atelier icon from
   `assets/atelier/`, and has its own bundle id (`io.github.aslastin.t3code-atelier`), data
   directory (`~/.t3-atelier`), and Electron profile
   (`~/Library/Application Support/t3code-atelier`), so it runs next to the official app.

## Build the macOS app

Requirements:

- [Vite+](https://viteplus.dev/guide/), which provides the `vp` command:
  `curl -fsSL https://vite.plus | bash`. `vp` installs the Node version pinned in `package.json`.
- Xcode Command Line Tools: `xcode-select --install`.
- Rust through [rustup](https://rust-lang.org/install).

From the repository root:

```sh
vp i
vp run dist:atelier:dmg
```

The DMG is written to `release/`. The build is unsigned and targets the host architecture by
default. Pass `--arch` for another target, for example `vp run dist:atelier:dmg --arch x64`.
Cross-architecture builds need the matching Rust target
(`rustup target add aarch64-apple-darwin x86_64-apple-darwin`).

If you copy the DMG to another Mac instead of building it there, macOS may refuse to open the
unsigned app. Clear the quarantine flag after installing:

```sh
xattr -dr com.apple.quarantine "/Applications/T3 Code (Atelier).app"
```

## Install alongside the official app

T3 Code (Atelier) and the official T3 Code can be installed and run at the same time. They have
separate app bundles, databases, settings, secrets, logs, and worktrees. The Atelier data lives in
`~/.t3-atelier` (`T3CODE_HOME` overrides it), and its bundled `t3` CLI launcher is
`~/.t3-atelier/bin/t3`.

The first launch starts with empty data: projects, threads, and settings from the official app are
not imported.

Both apps register the `t3code://` link scheme, so macOS opens external `t3code://` links (pairing
links, Codex sign-in handoff) in only one of them.

## Rebuild and update the installed app

Local builds have no update feed, so **Check for updates** stays disabled and there is no
auto-update. To update, rebuild and replace the app. Your data lives outside the app bundle, in
`~/.t3-atelier` and `~/Library/Application Support/t3code-atelier`, so replacing the app keeps
threads, projects, and settings.

`vp run dist:atelier:dmg` versions the build as `<upstream version>+atelier.<N>`, for example
`0.1.11+atelier.2`. The upstream version comes from `apps/desktop/package.json`, and `N` from
`atelier-build-number`: the number of finished fork features. `N` goes up by one when a feature is
finished, together with its entry in "Differences from upstream", and never resets, not even when
the upstream version changes. Builds never change it. Keeping the upstream version in front keeps
client and server version checks working as for upstream, and Atelier never edits the
`package.json` versions, which upstream releases change.

Agents follow these steps through the `atelier` skill in `.agents/skills/atelier/`: finishing a
feature, building and installing the app, and syncing with upstream.

```sh
git switch <branch you build from>
git merge <feature branch>        # or git pull
vp i                              # dependencies may have changed
vp run dist:atelier:dmg
```

Then quit T3 Code (Atelier) with Cmd+Q, open the new DMG from `release/`, drag the app to
**Applications**, and choose **Replace**. Database migrations run on the next launch.

A build can migrate the database forward, so an older build may not open the newer data. Before a
big update, quit the app and back up the data with `cp -R ~/.t3-atelier ~/.t3-atelier.bak`. Old
DMGs pile up in `release/`; delete the ones you no longer need.

## Development mode

```sh
vp run dev          # server + web
vp run dev:desktop  # Electron app
```

Both run from source with hot reload. In a git worktree, state lives in that worktree's `.t3`;
a plain clone uses `~/.t3/dev` unless you pass `--home-dir`. A new worktree's first start seeds a
read-only copy of recent data from the installed Atelier app (`~/.t3-atelier`), or from the
official app (`~/.t3`) if Atelier has no data yet. `vp run migrate-dev-db` refreshes it from the
same source. Dev never writes to either live install. See
[docs/operations/development.md](./docs/operations/development.md). The desktop app shows the
blue blueprint icon in development mode. This is intentional and keeps it apart from installed
builds.

## Syncing with upstream

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git  # once
git fetch upstream
git rebase upstream/main
vp run check:changed
```

Keep fork changes in separate files where possible (like this one and `assets/atelier/`) so
rebases stay conflict-free.

## Known limitations

- T3 Connect is disabled in a fresh clone, and passkeys need a signed, provisioned app. Expect
  neither to work in an unsigned Atelier build. For remote access, use your local network or
  Tailscale.
- The mobile app is not supported.

## License and trademarks

The code is MIT-licensed. [LICENSE](./LICENSE), with its T3 Tools Inc. copyright notice, is kept
unchanged. Third-party components keep their own licenses.

"T3 Code" and the T3 logo belong to their respective owners. The Atelier icon is a derivative
work made for this unofficial fork.
