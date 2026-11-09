# Statekeep TODOS

## P1 — Must do in Phase 2

### Playwright/Electron E2E Harness
**Status:** DONE — `playwright.config.ts`, isolated Electron fixtures, and workflow specs cover the desktop application.
**Verification:** `bun run test:e2e` covers project hub, example-project, settings, import, snapshots, templates, reports, and tree workflows.
**Was:** P1, blocked Phase 2 E2E coverage.

Deferred work from CEO review (2026-04-07).

## P1 — Pilot readiness

### First-User Dogfood Pass
**Status:** IN PROGRESS — The local packaged macOS lab, first-run, Finder file-open, and automated checks are recorded in [the dogfood report](PILOT_DOGFOOD_2026-09-26.md). Automated clean-runner checks passed on macOS and Windows, including the expanded packaged edit/restart/revert/recovery test in PR #100. Native-shell clean-machine and manual Windows checks remain.
**What:** Package the app and run a realistic project through create/open/edit/search/snapshot/compare/restore using a generated or hand-authored pilot-style hierarchy.
**Why:** The core v1 surface now exists and passes unit, E2E, typecheck, and packaging verification. The highest-value next signal is whether the workflows feel clear and durable for a real first user.
**Pros:** Finds UX friction before adding features. Produces concrete evidence for the import/schema roadmap.
**Cons:** May surface polish work rather than a single clean feature branch.
**Effort:** S
**Priority:** P1
**Depends on:** Current build and packaging verification passing

### CSV/JSON Import MVP
**Status:** DONE — CSV imports support preview, mapping, hierarchy paths, validation, typed coercion, update-on-key, and summary reporting. NetBox dumpdata JSON also has a dedicated import path.
**What:** Add a small import path for existing structured data into Statekeep hierarchies.
**Why:** Manual entry is likely the biggest adoption barrier for pilot users with existing spreadsheets or exported datasets.
**Pros:** Converts Statekeep from an empty editor into a migration-friendly tool. Creates a practical reason to pilot the product.
**Cons:** Column mapping and parent-child inference can grow quickly; start with a constrained MVP informed by dogfood fixtures.
**Effort:** M (human) -> S (CC+gstack)
**Priority:** P1.5
**Depends on:** First-user dogfood pass and at least one representative data shape

## P1 — Tree Rewrite + Compare Mode (deferred scope items)

These items were explicitly deferred during the 2026-04-10 eng review of the tree rewrite + inline compare mode plan. They are known, reasoned decisions — not oversights.

### DnD Reorder for Tree Nodes
**What:** Drag-and-drop reordering of nodes within the tree (change parent or sibling order).
**Why:** Faster than the existing Move Up / Move Down context menu for multi-level restructuring.
**Pros:** More intuitive for large hierarchies.
**Cons:** Virtualized DnD is a hard problem. `svelte-dnd-action` doesn't play well with virtual lists. Would require either a custom DnD implementation or accepting that DnD only works on the visible rendered window, which is broken UX. The existing context menu (Move Up, Move Down, Move To) covers the base case.
**Context:** Deferred from tree rewrite plan (2026-04-10). The context menu solution ships with PR #1.
**Effort:** L (human) -> M (CC+gstack)
**Priority:** P1.5 (post-tree-rewrite, pre-v1 release if pilot feedback demands it)
**Depends on:** Tree rewrite (PR #1) landing

### Search-in-Tree
**Status:** DONE — unified visible search updated 2026-06-22. The search box filters the hierarchy to matching nodes plus ancestors, keeps the tree visible, highlights name matches, shows property-match snippets inline, and supports Enter/Shift+Enter/Escape for next/previous/clear. Typing while the tree is focused feeds that same search box instead of starting a separate hidden typeahead mode.
**What:** Searching filters/highlights matching nodes inline without leaving the tree to a separate results panel.
**Why:** Faster navigation in large hierarchies with known node names.
**Was:** P1.5, deferred from tree rewrite plan (2026-04-10). Existing search panel works; this was an enhancement.

### Inline Rename in Tree Row (F2 in-row)
**What:** Pressing F2 on a tree row shows a name input directly inside the row, without switching to the Detail pane.
**Why:** Faster for keyboard users who want to rename without looking right.
**Cons:** DetailPane already has inline rename. A second rename path means two places to maintain validation, error display, dedupe checking. Risk of drift.
**Context:** Explicitly deferred during tree rewrite plan (2026-04-10). F2 signal-based approach ships in PR #1: F2 bumps `renameRequestId` in App.svelte, DetailPane's `$effect` picks it up and starts editing. Users who prefer tree-row editing can be addressed post-v1.
**Effort:** S (human) -> S (CC+gstack)
**Priority:** P2 (post-v1)
**Depends on:** Tree rewrite (PR #1), DetailPane signal-based rename landing

### Fix ErrorCode.GIT_COMMIT_FAILED Mislabel in Snapshot Compare
**Status:** DONE — compare/load compare failures now use `SNAPSHOT_READ_FAILED`.
**Verification:** Covered by `tests/unit/main/project-manager-snapshots.test.ts`.
**Was:** P2 cleanup identified during code quality review (2026-04-10).

## P2 — Post-v1 or late v1

### Saved Import Mappings
**What:** Let a user save and reuse a validated CSV mapping for recurring imports from the same source.
**Why:** The current import MVP handles one-off migration well; repeated operational imports should not require rebuilding column mappings.
**Pros:** Turns import into a reliable recurring workflow without adding formats speculatively.
**Cons:** Mapping identity, source drift, and where mappings live need pilot evidence.
**Context:** Pursue only if dogfood or a pilot dataset establishes a recurring-import pattern.
**Effort:** S
**Priority:** P2
**Depends on:** Representative recurring import data

### User-Defined Property Schema
**Status:** DONE — project-level typed templates define expected fields per node type, validate values, and participate in diff/history. Future work is a small, evidence-led starter-template library, not a marketplace.
**What:** Let users define expected properties per node type (e.g., "Instruments must have serial_number, firmware_version").
**Why:** Makes the diff engine domain-aware and the briefing view smarter. Properties can be classified by domain importance.
**Pros:** Stronger product differentiation. Enables domain-specific validation and richer diff output.
**Cons:** Schema UI design needs care to stay simple. Risk of over-engineering before validated.
**Context:** Deferred from CEO review. Start with freeform properties, let pilot usage inform schema design.
**Effort:** M (human) -> S (CC+gstack)
**Priority:** P2
**Depends on:** Pilot usage data, core diff engine working

### Virtual Tree Scrolling
**What:** ~~Implement virtual scrolling for the hierarchy tree view to handle >500 visible nodes.~~
**Status:** DONE — delivered in PR #1 (Tree rewrite, 2026-04-10). `@tanstack/svelte-virtual` ships with the tree rewrite. Closes this item.
**Was:** P2, identified during CEO review.

### Fractional Indexing for Sibling Order
**What:** Replace integer `order` field with string-based fractional indexing (e.g., "a0", "a0V") for sibling ordering.
**Why:** Integer ordering requires O(n) renumbering when inserting between existing siblings. At >100 siblings with frequent reordering, this means every drag-and-drop mutates dozens of nodes and triggers corresponding search index updates.
**Pros:** O(1) inserts and moves. No cascading order updates. Fewer mutations per operation.
**Cons:** String ordering is less intuitive to inspect in raw JSON. Requires a fractional index library or implementation. Migration from integer to string order values.
**Context:** Identified during eng review. Integer ordering is correct for v1 scale (<100 siblings typical). Consider this if pilot usage reveals projects with many siblings and frequent reordering.
**Effort:** S (human) -> S (CC+gstack)
**Priority:** P2
**Depends on:** Pilot usage data showing >100 siblings in practice
