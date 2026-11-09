<p align="center">
  <img src="resources/statekeep.svg" alt="Statekeep logo" width="160" />
</p>

<h1 align="center">Statekeep</h1>

<p align="center">
  Local-first project structure, named snapshots, and a diff view that explains what changed.
</p>

<p align="center">
  Built with Electron, TypeScript, Svelte 5, Tailwind, SQLite FTS5, and Git.
</p>

Statekeep is a desktop app for managing structured, hierarchical projects without hiding your data behind a service.

The core idea is simple. Your project lives as a readable `Statekeep.statekeep` file on disk. Statekeep gives you a native UI for editing that structure, saving named snapshots, searching nodes and properties, and comparing project states with semantic diffs instead of raw text churn.

## Why Statekeep

- Local-first. Your project data stays in your folder, under your control.
- Human-readable storage. State is persisted to `Statekeep.statekeep`, not locked in an opaque database.
- Named history. Snapshots are backed by Git, but surfaced as product features.
- Semantic diffs. Compare changes like added, removed, moved, renamed, reordered, and property-changed nodes.
- Fast search. SQLite FTS5 indexes names and properties for renderer-side search.

## Current Features

- Create and open Statekeep projects from the desktop app.
- Manage hierarchical node trees with add, rename, delete, reorder, and move operations.
- Duplicate a node and its descendants with a name preview, fresh IDs, and remapped internal references. Use the tree context menu, Project menu, or Cmd/Ctrl+D.
- Select multiple visible nodes with Cmd/Ctrl-click or Shift-click, then set, add, or clear one property with a mixed-value preview and one-step Undo/Redo.
- Undo and redo project edits, template changes, and imports during the current session; text fields keep native text undo. See [Undo/Redo behavior](docs/UNDO_REDO.md).
- Search names and properties with an exact total and structured filters for subtree, template, property value, and missing required fields. Inspect the same result set in the hierarchy or a sortable table with configurable property columns, then export it to CSV. See [Inventory filters](docs/INVENTORY_FILTERS.md) and [Inventory table](docs/INVENTORY_TABLE.md).
- Edit node properties in the detail pane, with optional typed-property templates (string, number, boolean, date, version, enum, and node-to-node `reference` fields) — typing lives in project-level templates while values stay clean JSON primitives.
- Import existing structured data from CSV into the hierarchy.
- Autosave project changes back to disk.
- Create named snapshots with optional descriptions that capture purpose, test/run IDs, outcomes, or evidence links, then restore prior states.
- Compare snapshots, or compare the current project against a snapshot, across the whole project or one selected subtree; scope and snapshot descriptions carry into the merged diff/tree view and exported Markdown, CSV, or self-contained HTML review.
- Follow the system appearance or choose a fixed appearance plus any built-in light and dark
  scheme independently from Settings.
- Read the user documentation offline in the app (Help → Statekeep Help), or online at [statekeep.app](https://statekeep.app); see [offline Help](docs/OFFLINE_HELP.md).
- Check for updates on demand from the Help menu; see [manual update and offline installation guidance](docs/UPDATES.md).

## Stack

- Electron
- TypeScript
- Svelte 5
- Tailwind CSS
- `better-sqlite3` for local FTS5 search
- System Git for snapshot history

## Requirements

You will need:

- [Bun](https://bun.sh/)
- Git available on your system `PATH`
- macOS 13 or newer, Windows, or Linux for Electron development

`better-sqlite3` is a native dependency, but it ships prebuilt Node-API binaries, so no rebuild step is needed. `bun install` also downloads the Electron binary for your platform. `trustedDependencies` in `package.json` replaces Bun's default trusted list so no dependency install scripts run, which keeps Bun from compiling better-sqlite3 from source; the root `postinstall` downloads Electron (see `docs/ARCHITECTURE.md`).
On Linux, Electron uses Wayland by default; use `--ozone-platform=x11` on X11-only systems. Linux release builds are published but **not officially supported** yet (see [docs/RELEASING.md](docs/RELEASING.md#platform-support)); on x86_64 Ubuntu LTS and Fedora Workstation, use the `.deb` or `.rpm` for desktop integration, or the AppImage as a portable fallback.

## Quick Start

```bash
bun install
bun run dev
```

## Scripts

```bash
bun run dev             # start Electron in dev mode
bun run build           # production build
bun run test            # unit test suite
bun run test:e2e        # Electron end-to-end tests
bun run package         # build distributable desktop packages
bun run generate:brand  # regenerate app/web icons from resources/statekeep.svg
bun run generate:lab    # generate a realistic sample lab project (typed templates + snapshot timeline)
```

On macOS, Electron E2E tests run with hidden, unfocused windows by default so
they do not take over the desktop. Run `STATEKEEP_E2E_VISIBLE=1 bun run test:e2e`
to watch them or exercise the native focus/blur test. On Windows and Linux the
tests show their windows by default, because hidden windows render too slowly
for the UI tests to finish in time; on Linux without a display, wrap the run in
`xvfb-run --auto-servernum`.

To create a sample project to explore, run `bun run generate:lab -- --output ./tmp/lab --force`,
then open `./tmp/lab` from the app's welcome screen. It produces a ~7k-node lab
(rooms → racks → computers → hardware/software components) with typed-property
templates and ~40 daily snapshots of realistic change, so the diff/compare and
history features have meaningful data to work against.

## Project Layout

```text
src/main         Electron main process, IPC handlers, project lifecycle
src/preload      contextBridge API exposed to the renderer
src/renderer     Svelte renderer app
src/shared       shared types, IPC contracts, diff logic
tests/unit       unit tests
tests/e2e        Playwright Electron tests
resources        source branding assets and generated desktop icons
docs             product, architecture, and roadmap documentation
```

## Data Model

Each Statekeep project is stored in a folder containing a `Statekeep.statekeep` file. The capitalization is part of the canonical filename on case-sensitive filesystems.

That file is the source of truth. Search indexes are rebuildable. Snapshot history is Git-backed. The app is designed so the durable project state remains inspectable and portable. Internal recovery payloads under `.statekeep/recovery/` intentionally remain JSON sidecar files; they are not Statekeep project documents.

## Branding

The repository branding is generated from [resources/statekeep.svg](resources/statekeep.svg).

To refresh app icons and web assets after updating the mark:

```bash
bun run generate:brand
```

This regenerates:

- desktop packaging icons in `resources/`
- renderer favicon and logo assets in `src/renderer/public/`

## Documentation

Start here for project docs:

- [docs/README.md](docs/README.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)
- [docs/UI_PRINCIPLES.md](docs/UI_PRINCIPLES.md)

## Status

Statekeep is still early-stage open source software.

The core desktop workflows are in place and covered by unit and Electron end-to-end tests, but the product is still being refined. Expect iteration around UX, packaging, and polish.

## Contributing

There is no formal `CONTRIBUTING.md` yet.

If you want to contribute, start by:

1. Reading [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
2. Running the test suite locally.
3. Keeping changes aligned with the local-first model and semantic diff direction.

## License

Statekeep is licensed under the [MIT License](LICENSE).
