# Bundled project starters

Choose **New Project → Start with** to create a Test Lab, Network Equipment, or
Equipment Maintenance project. The project hub also has **Browse project
starters…**. Blank project creation remains available.

Each starter includes fictional data, typed node fields, and two snapshots:
`baseline` and `configuration-update`. Select them in Snapshots to compare the
example change, then edit a node and create your own snapshot. The preview in
the creation form suggests an exercise for that use case.

Choose a name and parent folder. Statekeep creates a new user-owned project;
an existing destination is rejected. If setup is interrupted by a disk/history error,
Statekeep opens the partial project with a warning so it can be reviewed and saved. Your copy can be edited or deleted like
any other project. App updates never refresh or replace your copy. Everything
needed to create the project ships inside the app and works offline.

## Authoring catalog format v1

- `src/shared/project-starters.ts` defines stable IDs, catalog versions,
  descriptions, hierarchy previews, and suggested exercises.
- `src/main/project-starters.ts` defines typed templates, parent-first nodes
  with local keys, one changed node, and one added node per starter. IDs are
  resolved to fresh project node IDs during creation. Keep values fictional.
- Use normal project validation and creation APIs for all changes. Additions to
  the catalog must retain stable IDs and increment the starter version when its
  content changes. This version describes the bundled definition; it is not an
  automatic migration mechanism for users' independent projects.
- Definitions compile into the main bundle, while preview metadata compiles into
  the renderer. There is no external catalog to download or copy manually.

Run `bun run test -- tests/unit/main/project-starters.test.ts` to validate every
starter through real project creation, Git snapshots, comparison, edits, and
reopening. Run `bun run build` and
`bunx playwright test tests/e2e/project-starters.e2e.ts` for the selection flow.
`bun run package:verify` checks the bundled starter definitions alongside the
other packaged resources.

The website repository owns offline Help content. Mirror this usage guidance in
its docs and refresh the bundled Help with `bun run help:update` before release.
Do not hand-edit generated `resources/help` pages.
