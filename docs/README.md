<p align="center">
  <img src="../resources/statekeep.svg" alt="Statekeep logo" width="120" />
</p>

# Statekeep — Docs

Planning and architecture documentation for Statekeep.

Statekeep is a local-first desktop app for managing structured, hierarchical projects with named snapshots, semantic change awareness, and a clean diff view. Built with Electron + TypeScript + Svelte 5 + Tailwind.

---

## Document map

| Doc | Purpose |
|-----|---------|
| [VISION.md](VISION.md) | Product intent, target users, and v1 success criteria |
| [PRODUCT_USAGE_MODEL.md](PRODUCT_USAGE_MODEL.md) | Product semantics, personas, and current-project/snapshot flows |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Technical shape: stack, IPC contract, data model, storage, diff engine, security |
| [ROADMAP.md](ROADMAP.md) | Phase-by-phase delivery plan (Phases 1–5) |
| [UI_PRINCIPLES.md](UI_PRINCIPLES.md) | Visual and interaction principles for the renderer |
| [TODOS.md](TODOS.md) | Active and deferred product/engineering work |
| [PILOT_DOGFOOD.md](PILOT_DOGFOOD.md) | Pilot-readiness dogfood checklist and import decision gate |
| [PILOT_DOGFOOD_2026-09-26.md](PILOT_DOGFOOD_2026-09-26.md) | Recorded macOS packaged pilot exercise and remaining handoff |
| [INSTALLER_QA.md](INSTALLER_QA.md) | Repeatable supported-platform installer matrix and evidence template |
| [RELEASING.md](RELEASING.md) | Signed release builds, signing secrets, unsigned local builds, and cutting a release |
| [PROJECT_STARTERS.md](PROJECT_STARTERS.md) | Bundled use-case starters, exercises, catalog authoring, and verification |
| [SECURITY.md](SECURITY.md) | Renderer trust boundaries, denied permissions, and packaged Electron fuses |
| [ACCESSIBILITY_QA.md](ACCESSIBILITY_QA.md) | Keyboard, focus, contrast/motion behavior, automated checks, and manual QA |
| [CRASH_RECOVERY.md](CRASH_RECOVERY.md) | Renderer recovery, local-only crash policy, and redacted diagnostics export |
| [OFFLINE_HELP.md](OFFLINE_HELP.md) | Bundled offline Help: website docs as the one source, refreshing the bundle, and how the app serves it |
| [UPDATES.md](UPDATES.md) | Manual alpha/beta update flow, channels, offline installation, and downgrade limits |
| [UNDO_REDO.md](UNDO_REDO.md) | Project editing history, text undo, and snapshot/session boundaries |
| [INVENTORY_FILTERS.md](INVENTORY_FILTERS.md) | Structured inventory filters, matching semantics, and paging behavior |
| [INVENTORY_TABLE.md](INVENTORY_TABLE.md) | Tabular inventory, sorting, columns, selection, and CSV export |
| [SNAPSHOT_CONTEXT.md](SNAPSHOT_CONTEXT.md) | Optional snapshot descriptions and where that context appears |
| [SCOPED_COMPARISON.md](SCOPED_COMPARISON.md) | Selected-subtree comparison and scope-aware reporting |
| [REVIEW_REPORT.md](REVIEW_REPORT.md) | Self-contained HTML change reviews and their trust boundary |
| [HISTORY_PRESERVATION.md](HISTORY_PRESERVATION.md) | History preservation, automatic metadata backup, and explicit restore |
| [PROJECT_ARCHIVES.md](PROJECT_ARCHIVES.md) | Portable archives, verified restore, included history, and format limits |
| [EXTERNAL_DOCUMENT_CHANGES.md](EXTERNAL_DOCUMENT_CHANGES.md) | External-edit detection, preserved versions, and conflict resolution |
| [INTERRUPTED_HISTORY.md](INTERRUPTED_HISTORY.md) | Durable evidence and explicit continuation after interrupted history operations |

---

## Status

The core v1 surface is implemented: project lifecycle, hierarchy editing, search,
named snapshots, semantic compare, restore, E2E coverage, and packaging
verification.

Inventory views now provide complete paged search, structured filters, a sortable
table, configurable property columns, and CSV export over the same result set.

Snapshots can carry optional immutable descriptions through the timeline,
comparison, node history, and exported reports.

Comparison can be limited to a selected subtree, with the resolved scope carried
through the diff and exported review.

Self-contained HTML reviews carry snapshot context, scope, complete prioritized
findings, severity, classification, and detailed changes into an offline browser
artifact that can be shared or printed without Statekeep.

---

## Key decisions (locked)

- **Stack:** Electron + TypeScript + Svelte 5 + Tailwind + electron-vite
- **Storage:** Single `Statekeep.statekeep` per project, Git-backed snapshots
- **Snapshots:** System `git` CLI only, hidden behind product UX
- **IPC:** Typed `contextBridge` whitelist (~31 channels), domain calls use the `Result<T>` envelope
- **Search:** SQLite FTS5 via `better-sqlite3`, rebuildable, non-authoritative
- **Diff:** Semantic, node-level, 7 change types (added, removed, moved, renamed, property-changed, template-changed, order-changed), multi-change per node
- **Distribution:** `electron-builder` (macOS DMG, Windows NSIS, Linux AppImage)
