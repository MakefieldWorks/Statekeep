# Desktop security

All project/preference IPC handlers are registered through `secureIpcMain`.
The caller must be the live main frame of a known project or Settings window,
loading the exact application HTML file (or configured development-server
document). Other local files, subframes, Help, and additional windows are denied
before handlers parse their arguments. Settings can call only settings/window
APIs. The menu-state send channel uses the same boundary. Packaged apps ignore
`ELECTRON_RENDERER_URL` when selecting the document to load.

Every Electron session denies permission requests and permission checks.
Every WebContents prevents `will-attach-webview`, including Help and future
windows/partitions. Navigation, sandboxing, isolation, and CSP remain separate
defenses.

## Packaged runtime

`scripts/harden-electron.cjs` runs in electron-builder's `afterPack` stage,
before code signing. It disables RunAsNode, NODE_OPTIONS/environment options,
and CLI inspector fuses; enables ASAR-only application loading; and enables
embedded ASAR integrity on macOS and Windows. Electron does not implement
embedded integrity on Linux. The hook reads the fuse states back and fails
packaging on a mismatch. It resets the macOS ad-hoc signature after modifying
the Electron Framework; the existing release signing still follows it.

Electron-builder 25 writes the ASAR integrity metadata into the macOS Info.plist
and Windows executable resources. Its older packager does not embed the extra
Electron 41+ digest protecting the macOS plist integrity dictionary itself.
Archive/header and file integrity checking still applies, but protecting that
dictionary against replacement is follow-up work when upgrading the packager.
See [Electron ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)
and [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses).

`bun run package:verify` verifies actual packaged fuse states in addition to
assets. Development Electron stays unmodified so Playwright can attach its
inspector. Signed Windows/macOS installer testing remains required; the host
package check is not a substitute for the release matrix in RELEASING.md.

Packaged dogfood needs Playwright's main-process inspector. `run-dogfood.mjs`
first verifies the original release fuse policy, then creates a disposable copy
of the entire package outside `dist`, enables only that copy's inspector fuse,
and ad-hoc signs the macOS copy. ASAR contents are unchanged. The test copy is
removed after the run, and the original package's fuse policy is checked again.
These workflow tests cover packaged resources and behavior, while the package
verifier covers the hardened release executable. The instrumented copy does not
prove Developer ID/Authenticode trust; installer launch QA uses original assets.

## Verification

- `tests/unit/main/security.test.ts` checks sender/frame/document boundaries,
  Settings restrictions, deny-before-handler behavior, permissions and webviews.
- `tests/e2e/security.e2e.ts` checks real Electron IPC from the application and
  an unauthorized window, plus the installed browser capability restrictions.
- To inspect a release binary manually: `bunx electron-fuses read --app <path>`.
