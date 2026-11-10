# Installer release QA

Run this checklist against the exact artifacts proposed for publication, on a
clean machine or VM for each officially supported platform: macOS 13+ Apple
silicon and Windows x64. Record the OS version, artifact hash, result, and
screenshots using the evidence template below. A CI or unsigned local build
does not verify Gatekeeper, SmartScreen, or clean-machine signing behavior.

Intel Mac and Linux remain unverified/unsupported until actual hardware or VMs
complete the appropriate matrix. Linux's detailed Ubuntu/Fedora Wayland/X11
checks live in [PILOT_DOGFOOD.md](PILOT_DOGFOOD.md#linux-desktop-handoff) and
issue #58. Reference that record here instead of substituting xvfb results.

## Before testing

- Download the release candidate from the draft release/workflow artifact. Record
  version, commit, filename, SHA256, OS, architecture, test date, and tester.
- Compare SHA256 against the workflow's published checksums. Keep the artifact
  unchanged through the test; a rebuilt artifact requires a new record.
- Test with an ordinary non-administrator account, without a Statekeep dev
  checkout or prior approval of its executable. Use disposable OS snapshots
  for clean install, upgrade, and uninstall scenarios.
- Keep a project outside the install directory with recognizable edits and
  named snapshots. Record hashes/back up that fixture before upgrade/uninstall.

## macOS Apple silicon

- Check the app's Developer ID identity and hardened runtime with
  `codesign --verify --deep --strict --verbose=2 /Applications/Statekeep.app`
  and `codesign -dv --verbose=4 /Applications/Statekeep.app`.
- Check notarization/stapling with
  `spctl --assess --type execute --verbose=4 /Applications/Statekeep.app` and
  `xcrun stapler validate /Applications/Statekeep.app`. Record output.
- Open the downloaded DMG, copy the app into Applications, and launch it from
  Finder with quarantine intact. Record Gatekeeper behavior; a first-download
  confirmation is distinct from an unverified-developer warning.
- Verify name/icon, native titlebar, macOS application menu, Settings, keyboard
  shortcuts, and file/folder dialogs. Capture titlebar/menu screenshots.
- Double-click a `.statekeep` document while the app is closed and again while
  running. Confirm the correct project opens and the app reuses its window.
- Exercise the shared application checks below; quit/relaunch from Finder.
- Replace the previous Statekeep version with the candidate, reopen the fixture,
  and confirm current content, snapshots, and comparison survive.
- Remove the app from Applications. Confirm project folders/backups are intact;
  reinstall and reopen the fixture. Preferences may remain by design.

## Windows x64

- Record `Get-AuthenticodeSignature` output for the installer, installed
  `Statekeep.exe`, and uninstaller. Inspect certificate identity, validity, and
  timestamp. A signed binary can still produce SmartScreen reputation warnings;
  record the precise warning and outcome rather than assuming signing suppresses it.
- Start the downloaded installer as a standard user. Verify Statekeep branding
  on Welcome, informational MIT License (**Next**, without acceptance wording),
  Install For, Destination, Shortcuts, and Finish pages.
- Test **Only for me**: no elevation, expected per-user destination, custom
  destination honored, Start menu launch works, and Finish → Run Statekeep works.
- Repeat from a clean VM with desktop shortcut checked and unchecked. Confirm
  actual desktop presence/absence and persistent Start menu shortcut.
- Test **Anyone who uses this computer**: elevation prompt, correct Program
  Files destination, all-users shortcuts, launch from a second standard account.
  Also cancel elevation and confirm no broken partial installation is left.
- Cancel the wizard before installation and confirm it exits cleanly.
- Verify `.statekeep` association, icon, double-click opening when closed and
  running, taskbar identity, titlebar/menu/dialogs, and keyboard shortcuts.
  Capture screenshots.
- Exercise shared application checks, then quit/reopen from Start menu.
- Upgrade an existing **Statekeep** install in each mode and a custom folder;
  verify registry-selected mode/folder reuse, shortcuts, user preferences,
  project data, and snapshots. Do not infer this from a fresh install.
- **Legacy Manifest:** its app ID/install identity differs. Test coexistence and
  opening a copied legacy project through supported project-document migration;
  record association changes. Do not describe this as an in-place upgrade or
  silently remove the old product. Back up legacy projects before testing.
- On a disposable VM, test silent `/S` install and silent uninstall with the
  stock NSIS command syntax; confirm desktop/Start menu cleanup and data retention.
- Uninstall both per-user and all-users installs. Verify executable and shortcuts
  are removed, and projects/backups remain intact. Preferences are intentionally
  retained (`deleteAppDataOnUninstall: false`). Reinstall and reopen the fixture.

## Shared application checks

- Choose a bundled starter; create an independent project in a user-selected
  folder. Edit, autosave, create a snapshot, compare, revert, quit, and reopen.
- With networking disabled, open Help, navigate/search bundled docs, and verify
  project editing still works. Check online-link failure messages separately
  using a machine with no available browser; disconnection alone may still
  successfully launch the browser.
- Help → Check for Updates opens the correct release page when online. Verify
  the documented manual replacement/update flow; the app has no auto-updater.
- Copy Diagnostics and Export Diagnostics Bundle. Review the exported file for
  local-path/project-context omission and confirm nothing is uploaded.
- Check native recovery dialog/reload and an unresponsive-window **Wait** path
  in a disposable test run; verify autosaved work remains after recovery.

## Evidence template

Copy this template into `docs/qa/<version>-<platform>-<date>.md`, attach/link
screenshots and command output, then link the record from the release PR.
Use **PASS**, **FAIL**, or **NOT RUN**. Missing evidence is NOT RUN.

```markdown
# Installer QA: <version>, <platform>, <date>

Tester:
OS/version/architecture:
Clean machine/VM snapshot and account privilege:
Commit/tag:
Artifact filename/source:
SHA256 (expected/actual):
Signing identity/timestamp/notarization results:

| Scenario | Result | Evidence / issue |
|---|---|---|
| Clean install / first launch / OS trust prompt | NOT RUN | |
| Branding / wizard / per-user mode | NOT RUN | |
| All-users elevation (Windows) | NOT RUN | |
| Custom folder and shortcut choices (Windows) | NOT RUN | |
| Association, closed/running double-click open | NOT RUN | |
| Menus/titlebar/keyboard/file dialogs | NOT RUN | |
| Starter/edit/save/snapshot/compare/revert/reopen | NOT RUN | |
| Offline Help / online links / update flow | NOT RUN | |
| Recovery / diagnostics export | NOT RUN | |
| Previous Statekeep upgrade, same mode/folder | NOT RUN | |
| Legacy Manifest coexistence/migration | NOT RUN | |
| Silent install/uninstall (Windows) | NOT RUN | |
| Uninstall, shortcuts removed, project retained | NOT RUN | |

Fixture location and before/after hashes (keep private paths out of public records):
Screenshots/output:
Failures and linked follow-up issues:
Untested scenarios and reason:
Release decision and remaining support limitations:
```

## Current evidence

No completed signed-installer manual matrix is recorded by this document.
Automated/local build checks are development evidence only. Issues #55 and #58
remain open until their respective hands-on requirements have records.
