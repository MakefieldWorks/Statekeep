# Statekeep product reassessment — September 8, 2026

Status: proposed direction, grounded in the current repository and GitHub backlog. This assessment does not change the product contract or authorize implementation of every candidate below.

Progress through September 9: PRs #75–#80 completed safe inventory maintenance
and inventory views; PRs #81–#82 added snapshot descriptions and scoped
comparisons. The self-contained HTML review completes the bounded configuration
investigation milestone described below. Portable archive/restore and history
failure handling remain the next ownership-and-recovery work. The first safeguard
now preserves unreadable metadata and blocks history mutations before side
effects. Automatic metadata backup and explicit restore now give damaged or
missing history a recovery path. Users can now review and register unlisted
recovery payloads without inventing lost provenance or replacing inventory.
Portable archive export and verified restore to a new folder now preserve that
inventory and history together. External project-file changes now pause saves
and preserve both versions through explicit resolution. Interrupted snapshot,
revert, and recovery operations now retain durable before-state evidence and
require explicit continuation. Fully completed operations are now recognized
automatically from exact document, timeline, lineage, and Git evidence. Metadata-only
recovery registration and backup restoration now preserve before-state evidence,
recognize exact completion, and require review when uncertain. Automatic rollback
remains outside this increment. Retained interruption evidence now has an explicit,
stale-safe cleanup workflow that blocks registered recovery inventories and
never deletes unrelated files.

## Recommendation

Statekeep has the foundation of a useful configuration-history product. Its next milestone should complete the daily workflow for someone maintaining a real lab: bring in inventory, maintain it efficiently, record a meaningful configuration, investigate a failure, recover safely, and hand the evidence to another person.

Keep the primary audience in `PRODUCT.md`: lab and test-facility operations leads. This is a documented target, not proof of customer demand. No new user interviews or usage evidence were supplied for this assessment. Broader audiences should remain secondary until actual use supports expanding scope.

The promising product promise is: **Know what was in the lab, what changed, and how to get back to a known-good configuration.**

## Where work stopped

- Local checkout: `main`, initially clean, HEAD `27e981b` dated August 14, 2026. No open GitHub pull requests were returned on September 8.
- June work substantially strengthened comparison: severity and classification, template-driven importance, removal impact, actionable review findings, reports, search, and NetBox import.
- July work concentrated on desktop behavior: native commands, project opening, recent projects, save-on-close, workspace persistence, and packaged dogfood checks.
- Early August added project documents and hub, settings, a first-run example, safer property editing, dark mode and Graphite schemes. Latest commits addressed dependency security alerts.
- The remaining GitHub backlog is largely desktop readiness. It does not adequately represent the next set of product capabilities.
- The last recorded first-user dogfood task still requires manual Mac/Windows verification. No GitHub releases were returned by the release listing.

## What exists today

“Implemented” below means supported by inspected source and tests; it is not a claim of a completed public release or a newly completed manual usability pass.

| Area | Implemented | Product gap |
|---|---|---|
| Getting started | Project hub, recent projects, OS project opening, user-owned example lab | First-session guidance, small reusable lab starter configurations, offline help, installation without development expertise |
| Modeling | Virtualized hierarchy; add, rename, delete, move and reorder; typed templates; node references with deletion safeguards | Project-operation Undo/Redo, duplicate subtree, multi-selection and bulk editing |
| Bringing data in | CSV preview/mapping/validation/coercion/update-on-key; NetBox dumpdata JSON adapter | Reusable mappings, per-record change preview, clear recurring-import identity rules |
| Finding information | Indexed name/property search, results shown in the tree with ancestor context | Structured property filters, saved views, sortable tabular inventory, complete result counts |
| Explaining change | Current-versus-snapshot and snapshot-versus-snapshot semantic comparison; severity, classifications, schema changes, removal impact, focused findings | Explicit user-selected scope; operational context such as reason, test reference, result and decision |
| History | Immutable snapshots, revert/recover events and lineage, per-node history with index backfill | Snapshot descriptions and richer investigation context; careful treatment of recovery retention |
| Sharing | Markdown and CSV comparison reports | Full inventory export, readable review document, portable backup/handoff including history |
| Desktop | Settings, appearance, menus, persistence, diagnostics and packaging tools | Verified signed distribution, update procedure, clean-machine testing, keyboard/accessibility pass |

Evidence: `src/shared/ipc.ts`, `src/shared/types.ts`, `src/main/project-manager.ts`, `src/main/search-index.ts`, `src/renderer/src/App.svelte`, `src/renderer/src/components/DetailPane.svelte`, `src/shared/compare-review-insights.ts`, `src/shared/report.ts`, and corresponding unit/E2E tests.

## Product gaps worth prioritizing

### 1. Make repeated maintenance fast and reversible

The editor exposes one selected node and individual node mutations. Native Edit-menu Undo/Redo roles exist, but there is no project-operation undo contract. Property deletion explicitly says it cannot be undone. Whole-project snapshot recovery is too coarse for an accidental edit or delete.

Build in this order:

1. Project-level Undo/Redo for property edits, create/delete, rename, move and template-affecting operations. Define the boundary at project close, import and revert. Text-field undo must continue to behave normally.
2. Duplicate a node/subtree. Generate new node IDs, preserve templates and ordering, remap references within the copied subtree, and define how external references are preserved. Preview naming conflicts.
3. Multi-select and batch property updates with mixed-value handling, validation and an exact affected-node preview. One batch is one undoable operation; invalid records must not cause a silent partial update.

Acceptance scenario: duplicate a configured device, update firmware on 20 selected devices, undo the batch, redo it, snapshot the result, and confirm the semantic diff contains exactly the intended changes.

This is the first substantial feature milestone. Drag-and-drop reordering can follow if observed use shows the existing Move To workflow is a bottleneck.

### 2. Make large inventories answerable

Search currently returns at most 50 results through its default backend limit, without a total-count field in the API. That is a navigation aid, not a complete operational query. Before introducing bulk actions, distinguish the complete matching set from loaded or visible rows.

Start with filters for subtree, node template, property equals/contains, and missing required value. Add a table view over the same nodes with selected columns, sorting, row count and CSV export. Save useful views such as “devices missing serial numbers” or “firmware below the approved revision”; version comparisons must follow explicit version semantics rather than string sorting.

Acceptance: a query matching more than 50 devices produces a truthful count, allows inspection of every match, and exports the same set. Switching tree/table keeps node identity and selection consistent.

Do not add a dashboard before these underlying queries exist.

### 3. Capture why a configuration matters

Comparison already has considerable intelligence. The larger missing piece is user-entered context. `snapshot.create` takes only a name and creation stores `note: null`, despite the data model reserving a note field.

First add an optional description at snapshot creation. Recommend optional fields or a lightweight convention for test/run identifier, outcome, reason and external evidence link. Keep immutable snapshot semantics; any later annotation editing requires an explicit provenance decision.

Then make it easy to compare a selected room/rack/device against a chosen baseline and export a review containing the scope, before/after values, relevant dependencies and the user's explanation. Existing Markdown/CSV reports should be extended, not rebuilt. A standalone HTML report would provide a useful next sharing format.

Acceptance: someone who did not perform the changes can read the report and understand the configuration, changes and stated result without opening Statekeep. Observed differences must never be presented as proof of what caused a test failure.

### 4. Complete the ownership and recovery promise

The readable project document contains current state. History also relies on `.git` and `.statekeep/history.json`; recovery payloads live in `.statekeep/recovery`. Copying only the document does not preserve the complete project story. Cloud-folder detection warns about SQLite sync hazards but does not provide backup or synchronization.

Add a first-class portable archive and restore flow: capture a consistent current state plus snapshot data, timeline metadata and retained recovery points; exclude rebuildable indexes; verify integrity before restoring into a separate destination. Test restoration onto a clean machine.

Audit interrupted history operations before broader beta. The document and history metadata are individually replaced, but revert writes the current document before recording the event; history metadata parse failure currently falls back to empty metadata. These are inspection findings requiring failure-injection verification, not reproduced data-loss incidents. The product should explain damaged metadata and offer recovery rather than silently losing provenance.

Recovery points are currently capped at 10 and oldest payloads are pruned. Distinguish these temporary safety captures from durable snapshots, and make retention comprehensible. Also evaluate detection of external document modification; the app's single-instance lock does not itself protect against another program writing the file.

Acceptance: reopen after interrupted save/revert, restore a backup with timeline intact, and retain both versions when an external modification conflicts with local edits.

### 5. Turn import into a repeatable operational workflow

The initial import is already built. Do not schedule “CSV import MVP” again.

Once a representative recurring export is available, save mappings, detect changed source columns, show each planned create/update/conflict, and provide a recoverable apply operation. CSV update-on-key currently matches under the resolved parent; moving an asset in the source can therefore require a different identity strategy. Decide stable asset identity before promising synchronization. Missing source rows must not silently delete assets.

Acceptance: import the same export twice without duplicates, identify a changed firmware value before applying it, and handle a moved device and missing row explicitly.

## Delivery sequence

| Order | Milestone | Exit evidence |
|---|---|---|
| 0 | Establish a trustworthy baseline | One recorded end-to-end lab scenario on the packaged app; prioritize observed friction; review history interruption risks |
| 1 | Safe inventory maintenance | Project undo, duplication, batch editing; exact and reversible mutations demonstrated |
| 2 | Inventory views | Complete queries, structured filters, table and export operate on the same set |
| 3 | Configuration investigation | Snapshot context, scoped comparisons and shareable review tell the test/change story |
| 4 | Recurring data maintenance | A real recurring import can be previewed and reapplied safely |
| Before wider beta | Ownership and distribution | Verified archive restore, history failure handling, signed installers, update procedure, offline help and accessibility checks |

Backup/recovery and release work should accompany feature milestones rather than be left until the end. A proven data-loss defect would take priority over new features. Milestones are ordered by dependency and value, not estimated calendar dates.

## What to defer and why

- Broad generic project management: it weakens decisions about what belongs in v1.
- Real-time collaboration, cloud sync, merge workflows and plugins: substantial architecture and trust obligations without supplied demand evidence.
- AI-generated explanations: user context and deterministic comparison should be dependable first.
- Full attachment management, relationship graph canvas, multi-window workspaces and notification systems: useful candidates, but not prerequisites for the central workflow. Start with evidence links and navigable references.
- Fractional ordering and major framework/service rewrites: measure actual performance before changing the model. Virtualization does not prove that import, serialization, comparison or history indexing scales adequately.

Alternative directions considered: finish every desktop-polish ticket first, or broaden Statekeep into a general project platform. The recommended workflow sequence wins because it directly improves the documented lab job while preserving the existing architecture. Release blockers still gate public distribution.

## Repair the planning trail

The scattered status documents help explain why progress is hard to reconstruct:

- `docs/ROADMAP.md` remains an initial phase plan and proposes extensibility beyond the present v1 focus.
- `docs/README.md` still suggests scoping CSV/JSON import, although both import paths exist.
- `docs/PLAN_NODE_HISTORY.md` says ready to implement, although the feature and tests exist.
- README and PRODUCT search descriptions still describe the earlier type-to-jump behavior.
- Root `TODOS.md`, `docs/TODOS.md` and GitHub issues split the work list. Open desktop issues such as #45, #49, #50 and #52 overlap implemented work and need acceptance-criteria review, not automatic closure.

Use one current roadmap with a verified capability inventory and milestone links. Keep GitHub issues as executable work items; archive historical plans with an explicit status. This assessment is a proposal, so those existing documents and issues have not been overwritten or closed.

Existing release work to retain: [signing and notarization #47](https://github.com/MakefieldWorks/Statekeep/issues/47), [update flow #48](https://github.com/MakefieldWorks/Statekeep/issues/48), [accessibility #53](https://github.com/MakefieldWorks/Statekeep/issues/53), [packaged QA #55](https://github.com/MakefieldWorks/Statekeep/issues/55), and [offline help #65](https://github.com/MakefieldWorks/Statekeep/issues/65). A documented manual/offline update path may be sufficient initially; automatic updates are not inherently required.

## Verification and limits

- Fresh `bun run typecheck`: passed, zero errors/warnings.
- Fresh `bun run test`: 47 test files, 666 tests passed.
- Fresh `bun run build`: passed; emitted an advisory about stale Browserslist data.
- Desktop E2E attempted but did not start: native rebuild received EPERM creating `/Users/robertgehrsitz/.electron-gyp` under the current filesystem permissions. This is an environment limitation, not a failing workflow assertion.
- No new packaged cross-platform, clean-machine, manual UX, benchmark or customer-validation claim is made.

Concrete next action: run and record the existing packaged lab dogfood scenario, including one accidental deletion and one bulk-update task attempted with today's controls; use that evidence to finalize the project-operation Undo/Redo slice, then implement it before batch editing.
