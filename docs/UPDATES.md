# Desktop Updates

Statekeep uses **manual updates** for the alpha and beta period. It does not
contact an update service at startup or in the background. **Help → Check for
Updates...** opens the [Statekeep releases page](https://github.com/MakefieldWorks/Statekeep/releases)
in the system browser when the user chooses it. Compare the installed version
in **About Statekeep** with the release version. This action needs internet
access; the app and local projects continue working without it.

## Release channels

- **Alpha:** `vX.Y.Z-alpha.N` tags, marked as GitHub prereleases. Expect
  frequent changes and use only with copied pilot projects.
- **Beta:** `vX.Y.Z-beta.N` tags, also marked as prereleases. Use for broader
  testing once alpha feedback is addressed.
- **Stable:** `vX.Y.Z` tags, published as regular releases when a supported
  release is ready.

There is no automatic channel setting or background download. Choose a release
on the releases page and install its asset for your operating system. If no
releases are listed yet, use the local pilot build. Development packages built
with `bun run package:verify` are local test artifacts, not an update feed.

## Installing with or without internet on the target computer

Download the appropriate release asset on a connected computer, transfer it
to the target computer if necessary, close Statekeep, and install it manually:

1. **macOS:** Open the DMG for the computer's architecture (arm64 for Apple
   silicon; x64 for Intel, which is not officially supported) and replace the
   existing Statekeep app in Applications.
2. **Windows:** Run the x64 NSIS installer. Choose current user (the default,
   no admin rights) or everyone (requires elevation), destination, and whether
   to create a desktop shortcut. Start menu access is always provided. Existing
   Statekeep installs should retain their install mode and folder; keep project
   folders separate. Legacy Manifest is a different installed product, so back
   up its projects and follow the documented project migration rather than
   assuming an in-place installer upgrade.
3. **Linux** (not officially supported yet): Choose the asset for the installed
   distribution: replace the x64 AppImage, make it executable if needed, and
   launch it; or install the x64 `.deb` on Ubuntu/Debian-family systems or the
   x64 `.rpm` on Fedora-family systems with the system package installer.
   Native packages register the launcher, icon, and `.statekeep`
   association; AppImage integration is deliberately portable and can vary by
   desktop environment.

Open an existing project and check its name, nodes, and snapshot timeline after
updating. Project folders are independent of the installed application. Keep a
copy of important project folders before installing a prerelease.

## Downgrades

App installation can be rolled back manually by installing an older asset, but
project data is **not guaranteed to be backward compatible**. Opening a project
with a newer Statekeep version may migrate its document or history format. To
roll back safely, restore a project-folder copy made before that newer version
opened it. Do not rely on an older app to reverse a migration.

Release assets are built by the release workflow described in
[RELEASING.md](RELEASING.md): the macOS app inside each DMG is signed and
notarized, the Windows app and installer are Authenticode signed through Azure
Trusted Signing when the repository has it configured, and the Linux AppImage is unsigned. Each release
lists a `SHA256SUMS.txt` for checking a download. Automated update delivery is
separate work; this page describes the manual pilot flow rather than promising
a supported public release channel.
