# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop (Electron)

## Users

**Primary (confirmed):** lab and test-facility operations leads who manage physical and configuration
hierarchies — rooms, racks, shelves, devices, firmware and software revisions — and who need an audit
trail of what the configuration looked like at each meaningful moment. Their situation is concrete:
they change hardware or software, run a test, and later must answer *what did we change, and what did
it look like before it broke?* Spreadsheets flatten the structure; Git is too technical for the job.

Statekeep ships publicly, so the audience is strangers with this job, not a known team. First-run,
empty states, and activation are real product scope, not internal-tool afterthoughts.

The three other personas documented in `docs/PRODUCT_USAGE_MODEL.md` (product/research lead,
technical architect, solo builder) are **illustrative, not confirmed v1 users**. They may be served
incidentally; they must not drive v1 decisions or be cited as evidence of demand.

## Product Purpose

Statekeep is a local-first desktop app for managing structured, hierarchical projects, with named
snapshots and a diff view that explains what actually changed.

A project lives as a readable `Statekeep.statekeep` file in the user's own folder. Statekeep gives that file
a real editing UI, saves named checkpoints of it, and compares any two states semantically.

Success means a user can model an evolving structure, checkpoint it at meaningful moments, understand
the difference between two moments without reading raw JSON or Git output, and recover a prior state
without losing the record of what happened in between.

## Positioning

Two commitments a neighboring product could not truthfully copy at the same time:

1. **Semantic change, not text churn.** Diffs are expressed as added, removed, moved, renamed,
   reordered, and property-changed nodes — statements about the structure, not about lines in a file.
   This is the core differentiator and gets the heaviest test coverage in the codebase.
2. **Git-backed history without Git as a user concept.** Snapshots are durable and inspectable
   because Git backs them, but the user never manages branches, commits, or merges. History is
   surfaced as product features.

Underneath both: the data is a human-readable file in the user's folder. Nothing is held hostage by
the app or by a service.

## Operating Context

The grounding scenario, from `docs/PRODUCT_USAGE_MODEL.md`:

1. Enter the initial lab configuration → snapshot `initial-lab-config`.
2. Install new equipment → snapshot `new-equipment-installed`.
3. Run a test.
4. Upgrade software revisions → snapshot `software-upgrade-test-fails`.
5. Compare the two snapshots to understand the failure.
6. Revert the current project to the last good snapshot.
7. Make different changes → snapshot `alternate-software-test-passes`.

The revert in step 6 does not erase the failed state. That is the point: the record of the failed
attempt is what makes the story tellable later.

Work happens on a desktop, offline-capable, against a folder the user owns. Projects can be large
enough that tree rendering is virtualized and search is indexed.

## Capabilities and Constraints

### Shipped capability

Recorded from README "Current Features" — shipped behavior, not in-flight branch work.

- Create and open Statekeep projects.
- Hierarchical node trees: add, rename, delete, reorder, move.
- Type-to-jump in the tree; Enter/Shift+Enter cycles matches, Escape clears.
- Node properties in the detail pane, with optional project-level typed-property templates
  (string, number, boolean, date, version, enum, and node-to-node `reference` fields). Typing lives
  in templates; values stay clean JSON primitives.
- CSV import into the hierarchy.
- Autosave to disk.
- Named snapshots and restore.
- Compare two snapshots, or the current project against a snapshot, in a merged diff/tree view;
  export the diff as Markdown or CSV.
- Search across node names and property values.

### Core model (three product nouns)

This is the *intended* product model, from `docs/PRODUCT_USAGE_MODEL.md`. Parts of it are specified
rather than verified as built — README claims only "create named snapshots and restore prior states."
Treat this section as the contract design work must honor, not as a list of shipped behavior.

1. **Current Project** — the only editable thing. Autosaved to `Statekeep.statekeep`.
2. **Immutable Snapshot Timeline** — append-only, chronological. A snapshot is never mutated in place.
3. **Revert Events** — revert changes the current project to match a prior snapshot and appends an
   event. It does not rewrite or delete later snapshots.

The event timeline is linear. Content lineage may fork, and Statekeep records that honestly via
`basedOnSnapshotId` and `createdAfterRevertEventId` — without exposing Git branches.

Revert must preserve unsnapshotted work automatically, as a recovery point (not a first-class
timeline snapshot). This is not optional. Revert notes are required when reverting past existing
later snapshots, optional otherwise.

Compare is read-only. Editing controls are unavailable or clearly disabled while comparing.

### Terminology contract

Binding. Copied from `docs/PRODUCT_USAGE_MODEL.md` because the wording, not the summary, is the
constraint.

**Use:** `Current Project` · `Save Snapshot` · `Save Current Project as Snapshot` ·
`Revert Current Project to This Snapshot` · `Current project matches <snapshot>` ·
`Unsnapshotted changes` · `Snapshot Timeline` · `Revert Event` · `Compare snapshots` ·
`Current project` (as a compare source/target) · `Compare current project to snapshot`

**Avoid:** `Switch to snapshot` · `Open snapshot` · `Edit snapshot` · `Current snapshot` ·
`Version tree` · `Branch`

Prefer "snapshot" over "checkpoint" or "version". "Version" implies editable or branching versions,
which the model does not have. The UI must never imply the user is editing a saved snapshot.

### Technical constraints

- Electron + TypeScript + Svelte 5 + Tailwind + electron-vite. `better-sqlite3` (FTS5) for search,
  system Git for snapshot history. Git must be on the user's `PATH`.
- The renderer never touches the filesystem. All mutations go through IPC.
- IPC channels are declared in `src/shared/ipc.ts` before implementation; all responses use
  `Result<T>` and never throw across the boundary.
- Validation lives in `src/shared/validation.ts`; error codes in `src/shared/errors.ts`.
- Trees are large enough to require virtualization; UI work must not assume small trees.

### Explicitly undecided

Open, and not to be resolved by design work inventing an answer:

- Whether users can duplicate a snapshot into a separate project.
- Whether snapshot creation should require a note/description beyond the name.
- Whether content lineage gets its own view, or stays metadata inside the chronological timeline.

Non-goals for v1, confirmed: real-time collaboration, an integration marketplace, a plugin ecosystem,
a power-user CLI suite.

## Brand Commitments

- Name: **Statekeep**. Existing mark at `resources/statekeep.svg`, with renderer assets at
  `src/renderer/public/statekeep-mark.svg` / `.png` and a generator at
  `scripts/generate_brand_assets.py`.
- Voice: plain, concrete, unhurried. The product explains structure and change without jargon and
  without borrowing developer-tool vocabulary.
- The product is deliberately positioned as *not* a visual or conceptual continuation of the prior
  Archon product. It inherits Archon's strongest ideas, not its obligations.

## Evidence on Hand

Real:

- Working application with the shipped capabilities above.
- Semantic diff engine with the heaviest unit-test coverage in the codebase.
- Generated fixtures for realistic scale: `scripts/generate-project.mjs`, `scripts/generate-lab.mjs`,
  and `statekeep-large-fixture/`.
- Packaged-desktop dogfood verification (`scripts/run-dogfood.mjs`, `docs/PILOT_DOGFOOD.md`).

Absent — future work must not fabricate these:

- No users, customers, testimonials, case studies, or press.
- No published benchmarks or performance claims.
- No pricing, paid tier, or commercial offering. (Licensing itself *is* settled: MIT, © 2026 Robert
  Gehrsitz — see `LICENSE`.)
- No deployment, hosting, or sync service. (`src/shared/cloud-sync.ts` exists in the tree; it is not
  a shipped, claimable capability.)

## Product Principles

1. **Structure without heaviness.** Users model complex hierarchies without feeling trapped in a
   rigid enterprise tool.
2. **Change should be understandable.** The product's job is explaining *what* changed, not
   reporting *that* something changed.
3. **Local-first and inspectable.** Storage stays durable, readable, and recoverable in the user's
   own folder.
4. **History should feel approachable.** Snapshots, diffs, and revert are ordinary parts of the
   product, not specialist tools bolted on.
5. **Power present, not oppressive.** Keyboard support, quick actions, and advanced panels exist
   without dominating the default experience.

## Accessibility & Inclusion

Binding requirements:

- **Full keyboard operation.** Every core flow — tree navigation, node editing, snapshot creation,
  revert, and compare — must be completable without a mouse. Focus must remain visible and its order
  predictable across panels and dialogs.
- **Colorblind-safe change states.** Added, removed, moved, renamed, reordered, and property-changed
  must never be distinguishable by hue alone. Each state carries a non-color signal — icon, glyph,
  label, or position.

No formal conformance standard (e.g. WCAG 2.1 AA) has been committed to yet.
