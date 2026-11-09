# Offline Help

**Help → Statekeep Help** opens the user documentation in a Statekeep window. It
works with no network connection. **Help → Online Documentation** opens the same
docs on the public website, <https://statekeep.app>.

## One source

The docs are written once, as Markdown in the website repository
(`statekeep-website`, under `src/content/docs/docs/`). The website's
`bun run build:offline-help` builds those pages as static files: the same
Starlight pages, sidebar, styles, and Pagefind search as the website, without
the landing, download, and changelog pages, which need live release data.

Statekeep commits that output under `resources/help/`. App builds and releases
never fetch the website repo or anything else from the network, and every
release ships the docs that were committed with it.

`resources/help/offline-help.json` records where the bundle came from:

```json
{
  "format": 1,
  "entry": "/docs/start/introduction/",
  "site": "https://statekeep.app",
  "source": { "repository": "statekeep-website", "commit": "<sha>", "dirty": false }
}
```

The website build is reproducible: building the same commit again produces
identical files, so a refresh shows only real docs changes.

## Updating the bundle

Do this after a docs change merges on the website's `main`, and before a
release whose features the docs describe.

```bash
# in a statekeep-website checkout
git checkout main && git pull && bun install

# in this repo
bun run help:update -- ../statekeep-website
bun run test   # includes checks on the committed bundle
```

`help:update` refuses a website checkout with uncommitted changes, because the
recorded commit would not describe the bundle. `--allow-dirty` exists for a
local preview; don't commit its output (the bundle test fails on `dirty: true`).
Commit all of `resources/help/` in one PR, and name the website commit in the
PR description. Pin to a commit on the website's `main`, not a PR branch: the
website squash-merges, so branch commits disappear after merge.

## How the app serves it

`src/main/offline-help.ts` holds the rules and `src/main/help-window.ts` wires
them into Electron.

- **Protocol.** The bundle is served from `statekeep-help://help/`, a scheme
  registered as standard, secure, and fetch-capable before the app is ready.
  A real origin is what makes Astro's root-relative URLs (`/_astro/…`,
  `/docs/…`), module scripts, and Pagefind's `fetch` and WebAssembly work. A
  `file://` URL would break all three.
- **Containment.** Each request is decoded, mapped to a path, and rejected
  unless the resolved path is inside `resources/help/`. This catches encoded
  `..` segments and Windows separators (`%5c`). Directory URLs serve their
  `index.html`. Anything missing gets the bundle's `404.html`.
- **Content Security Policy.** Every response carries a CSP that allows only
  the bundle's own origin, plus inline scripts and styles (Starlight inlines
  its theme script) and `wasm-unsafe-eval` (Pagefind). Nothing can load from
  the network.
- **Window.** One Help window is reused. It has no preload, sandboxing is on,
  and it has no access to project APIs. Pages in the bundle load in place.
  Links to pages the bundle leaves out (download, changelog) open on the
  public site in the browser. Other http(s) links open in the browser too.
  Everything else is blocked.
- **Menus.** Project commands chosen while Help is in front still apply to the
  project window. Undo and redo apply to Help's own fields, such as search,
  like they do in Settings.
- **Location.** The bundle lives at `resources/help/` next to `out/`, in the
  repository during development and inside `app.asar` when packaged. The main
  process resolves it from its own folder (`out/main`), so the same path works
  in `bun run dev`, E2E runs, and installed apps.

If the bundle is missing or `offline-help.json` is invalid, Statekeep Help shows
a dialog that offers the online documentation instead.

## Verification

- `tests/unit/main/offline-help.test.ts`: path containment (including encoded
  traversal and Windows paths), content types, navigation rules, and bundle
  metadata parsing.
- `tests/unit/main/offline-help-bundle.test.ts`: checks the committed bundle.
  It must come from a clean website commit, stay under 5 MB, include the
  search index, load nothing from the network, and have every `/_astro/` and
  `/pagefind/` reference resolve.
- `tests/e2e/help.e2e.ts`: opens and reuses the Help window, follows a link,
  searches offline, sends online-only pages and web links to the browser, and
  refuses traversal over the protocol.
- `bun run package:verify` asserts that every file of `resources/help/` is in
  `app.asar` for the host platform. Linux CI runs it on every PR. The opt-in
  `ci:full` platform run covers macOS and Windows.

## Manual smoke check

On a packaged build with networking turned off:

1. Help → Statekeep Help opens "What is Statekeep?" with styles and the sidebar.
2. Search for "snapshot" and open a result.
3. Toggle light/dark with the theme picker.
4. Choose Help → Statekeep Help again. The same window comes to the front.
5. With a project open and Help focused, File → Save still saves the project,
   and Undo in the Help search field does not undo a project edit.
6. Help → Report an Issue… shows the issue address and says diagnostics were
   copied.
