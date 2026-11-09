# Pilot Dogfood Checklist

The [2026-09-26 macOS dogfood record](PILOT_DOGFOOD_2026-09-26.md) contains
completed local checks, observed friction, and the remaining platform handoff.

Use this checklist to test Statekeep as a first user would: with enough data,
history, and change volume to reveal workflow friction. CSV and NetBox JSON
imports are already shipped; use the notes to decide whether a *refinement*,
such as saved import mappings, is warranted.

## Setup

Generate a representative local project:

```bash
bun run generate:project -- --output ./tmp/pilot-dogfood --name "Pilot Lab Inventory" --nodes 750 --depth 6 --branching 4 --snapshots 4 --seed 20260424 --force
```

Package verification should pass before the dogfood pass:

```bash
bun run typecheck
bun run test
bun run test:e2e
bun run package:verify
bun run test:dogfood -- --project ./tmp/pilot-dogfood --packaged
```

`package:verify` builds and inspects the host package. On macOS it also ad-hoc
signs and verifies the local unsigned `.app` bundle so launch-blocking signature
issues are caught before manual testing. `test:dogfood -- --packaged` opens the
generated project through the packaged executable. The test copies the supplied
project, including its Git history, to a disposable workspace before editing.
It checks search and comparison, adds and renames a node, edits two properties,
relaunches to verify persistence and search, saves and compares a snapshot,
reverts, and relaunches again to verify the retained timeline and recovery of
unsnapshotted work. The supplied project is left unchanged. Omit `--packaged`
to test the development Electron build instead. The full `test:e2e` suite also
uses that development build.

The default Linux CI job runs `package:verify` and the packaged dogfood test
on every PR. On Linux the packaged executable is `dist/linux-unpacked/statekeep`;
run the test under `xvfb-run --auto-servernum` when no display is available.

## Linux Desktop Handoff

Linux builds are **not officially supported** yet, because there is no Linux
desktop machine to run this checklist on before a release (see
[RELEASING.md](RELEASING.md#platform-support)). Once there is, support will be
limited to **x86_64 Ubuntu LTS** and **x86_64 Fedora Workstation**. AppImage
remains available as a portable fallback, but only the native package is
expected to register the launcher, icon, and `.statekeep` association
persistently.

Build the Linux release artifacts from a clean checkout, then inspect them
before testing:

```bash
bun run build
node node_modules/electron-builder/cli.js --linux --publish never
bun run package:verify:linux-desktop
```

On Ubuntu, install the generated `.deb`; on Fedora, install the generated
`.rpm`. For each system, verify all of the following before publishing a
release:

- The application launcher is named **Statekeep**, appears in the Office or
  Productivity category, and shows the Statekeep icon at normal and high-DPI
  sizes.
- A `Statekeep.statekeep` file displays the Statekeep document icon,
  appears as a Statekeep Project (or equivalent desktop label), opens by
  double-clicking, and opens from `xdg-open`. Opening it while Statekeep is
  already running focuses the existing window and loads the selected project.
- The native frame/titlebar, File/Edit/Project menus, keyboard accelerators,
  modal dialogs, and folder/file pickers work under both the default Wayland
  session and an X11 session (`--ozone-platform=x11`).
- The packaged dogfood scenario completes and a replacement package preserves
  projects outside the install directory. Confirm the AppImage also launches,
  while recording any desktop-integration behavior supplied by the user's
  desktop environment rather than promising it.

Record distro and version, desktop environment, session type (Wayland/X11),
graphics stack, tested package version, and any deviations. Xvfb CI validates
packaged application behavior but cannot substitute for this desktop-session
matrix.

Add the `ci:full` label to a PR, or dispatch `Pilot platform checks` manually,
to run these checks on fresh macOS and Windows runners. The workflow generates
the fixture without `--force` because each runner starts clean; use `--force`
when repeating the local command above. Its results provide automated
clean-runner evidence; the final native shell launch still needs a manual
Finder/Explorer pass.

## Core Workflow

- Launch with no recent projects and choose **Open Example Project**. Confirm
  that it creates a reusable `Statekeep Sample Lab` in the user's Documents
  folder, then inspect its templates and compare `baseline-lab` with
  `firmware-update`.
- Open `./tmp/pilot-dogfood` from the packaged app.
- Expand and collapse several deep branches.
- Search for a known property value such as `active`, `maintenance`, or `serial`.
- Select a search result and confirm the tree scrolls to the selected node.
- Rename a mid-tree node and confirm autosave persists after reopening.
- Add a child to a deep node and edit at least two properties.
- Move that child to another parent and confirm ordering remains predictable.
- Create a new snapshot named `dogfood-edit-pass`.
- Compare `generated-04` to `dogfood-edit-pass`.
- Confirm added, moved, renamed, property-changed, and order-only changes are legible.
- Restore `generated-04` and confirm search results and tree selection still behave normally.

## Windows Handoff

Switch to the Windows machine after the macOS verification commands above pass
and the dogfood project has been generated or copied over. From
`C:\code\Statekeep`, run:

```powershell
bun install
bun run typecheck
bun run test
bun run test:e2e
bun run package:verify
bun run generate:project -- --output ./tmp/pilot-dogfood --name "Pilot Lab Inventory" --nodes 750 --depth 6 --branching 4 --snapshots 4 --seed 20260424 --force
bun run test:dogfood -- --project ./tmp/pilot-dogfood --packaged
```

After the automated checks pass, manually open `dist\win-unpacked\Statekeep.exe`
and verify the native Windows frame, taskbar icon, Open Recent menu, file-open
flow, close/quit save behavior, snapshot compare readability, and the
`.statekeep` document icon in Explorer. On macOS, also inspect the
`.statekeep` document icon in Finder.

## Notes To Capture

- Any confusing labels, empty states, or disabled controls.
- Any operation that requires too many clicks for a first user.
- Any place where snapshot/compare language feels like Git instead of product UX.
- Any search query a user would naturally try that does not work.
- The shape of data a first import should support.

## Import Refinement Decision Gate

Consider saved mappings or other import refinements only after the dogfood
notes answer:

- What columns/properties are common enough to seed the MVP?
- Is parent-child structure best represented by path columns, parent IDs, indentation, or repeated category columns?
- Should the first import be command/menu-driven, or is a visible onboarding action needed?
- What validation errors must be shown before writing `Statekeep.statekeep`?
