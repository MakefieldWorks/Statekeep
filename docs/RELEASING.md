# Releasing Statekeep

Release assets come from `.github/workflows/release.yml`. It runs only for a
`v*` tag or a manual dispatch, so macOS and Windows runners never start from an
ordinary push or PR (see the CI policy in `CLAUDE.md`).

| Platform | Asset | Alpha signing |
|----------|-------|---------------|
| macOS (arm64, x64) | `Statekeep-<version>-mac-<arch>.dmg` | The app inside is Developer ID signed (hardened runtime), notarized and stapled; the DMG image itself is unsigned |
| Windows (x64) | `Statekeep-<version>-win-x64.exe` (NSIS) | The app and installer are Authenticode signed through Azure Trusted Signing when it is configured (see below); otherwise they are unsigned. SmartScreen may still warn until the certificate builds download reputation |
| Linux (x64) | `Statekeep-<version>-linux-x86_64.AppImage`, `.deb`, `.rpm` | Unsigned; verify the published SHA256SUMS before installing any Linux asset |

Every release also carries `SHA256SUMS.txt` covering all assets.

## Platform support

Officially supported during the alpha: **macOS 13+ on Apple silicon (arm64)**
and **Windows x64**. These are the platforms tested by hand before each release.

The **Intel Mac (x64) DMG** and all **Linux** assets are still built, signed
where applicable and verified by the release workflow, but they are **not
officially supported**: there is no Intel Mac or Linux desktop machine to test
them on before a release. Say so in the release notes. Linux becomes supported
once a test machine can run the Linux desktop checklist in
[PILOT_DOGFOOD.md](PILOT_DOGFOOD.md).

## Local builds versus release builds

- `bun run package:verify` builds an **unsigned** unpacked app for the host
  platform and checks that its `app.asar` holds the icons and the complete
  offline Help bundle. On macOS it disables identity discovery and ad-hoc signs the
  bundle, so it never touches your keychain. Use it for local testing only.
- `bun run package` runs electron-builder with the full config. On a Mac with a
  Developer ID Application identity in the login keychain, electron-builder
  signs with it automatically; it notarizes only when the `APPLE_API_*`
  variables below are set. Without them it logs "skipped macOS notarization".
  Without a certificate, run it as `CSC_IDENTITY_AUTO_DISCOVERY=false
  STATEKEEP_ADHOC_SIGN=1 bun run package` to get an ad-hoc signed app that
  launches after Open Anyway (`scripts/adhoc-sign-mac.cjs`).
- Release builds come only from the release workflow, so every published asset
  is built from a tagged commit on clean runners.

`node scripts/verify_release.mjs` checks whatever electron-builder put in
`dist/` and writes `dist/SHA256SUMS-<os>.txt`. With `--require-signed` it fails
on an unsigned or unnotarized macOS app or an unsigned Windows executable. The
release workflow passes that flag for tagged macOS builds, and for tagged
Windows builds once `AZURE_SIGNING_ENDPOINT` is set.

## Signing secrets

Add these under **Settings → Secrets and variables → Actions**. The macOS
values below are all **Repository secrets**; the Windows section says which of
its values are variables. Missing macOS secrets produce an unsigned build,
which a tagged release then rejects.

| Secret | Value |
|--------|-------|
| `MAC_CSC_LINK` | Base64 of the Developer ID Application certificate exported as `.p12` (with its private key): `base64 -i DeveloperID.p12 \| pbcopy` |
| `MAC_CSC_KEY_PASSWORD` | Password chosen when exporting the `.p12` |
| `APPLE_API_KEY_P8` | Full text of the App Store Connect API key file `AuthKey_<KEYID>.p8` |
| `APPLE_API_KEY_ID` | That key's Key ID |
| `APPLE_API_ISSUER` | The Issuer ID shown above the keys list in App Store Connect |

To export the certificate: open Keychain Access, find "Developer ID
Application: …" under My Certificates, expand it to confirm the private key is
attached, then right-click the certificate and choose Export. The API key comes
from App Store Connect → Users and Access → Integrations → App Store Connect
API; a key with the Developer role can notarize. Apple lets you download the
`.p8` once, so keep the original somewhere safe outside the repository.

Notarization runs in `scripts/notarize-mac.cjs` (an `afterSign` hook) rather
than electron-builder's built-in `notarize`, so that stapling can be retried
when `xcrun stapler` loses its connection to Apple's ticket service. If it
still fails, the build continues with a notarized but unstapled app; a dry run
reports that, and a tag push fails in the verify step.

The workflow writes the `.p8` to the runner's temp directory for the duration of
the job and deletes it afterwards. The certificate goes to electron-builder as
`CSC_LINK`, which imports it into a temporary keychain.

### Windows (Azure Trusted Signing)

Windows builds are signed by an Azure Trusted Signing certificate profile, so
no certificate file ever leaves Azure. The account and profile names are not
secret and go under **Repository variables**; the service principal that is
allowed to sign goes under **Repository secrets**.

| Name | Kind | Value |
|------|------|-------|
| `AZURE_SIGNING_ENDPOINT` | Variable | The Trusted Signing account's regional endpoint, such as `https://eus.codesigning.azure.net/` (Account URI on the account's Overview page) |
| `AZURE_SIGNING_ACCOUNT` | Variable | The Trusted Signing account name |
| `AZURE_SIGNING_PROFILE` | Variable | The certificate profile name inside that account |
| `AZURE_TENANT_ID` | Secret | Directory (tenant) ID of the app registration |
| `AZURE_CLIENT_ID` | Secret | Application (client) ID of the app registration |
| `AZURE_CLIENT_SECRET` | Secret | A client secret value for that app registration |

The app registration needs the **Artifact Signing Certificate Profile Signer**
role (formerly Trusted Signing Certificate Profile Signer; Microsoft renamed
Trusted Signing to Artifact Signing) on the certificate profile (Access control (IAM) on the profile or the
account). electron-builder installs the `TrustedSigning` PowerShell module on
the runner, signs `Statekeep.exe`, the uninstaller and the installer, and
timestamps them with `http://timestamp.acs.microsoft.com`. Client secrets
expire, so note the expiry date and rotate the secret before it lapses.

Once `AZURE_SIGNING_ENDPOINT` is set, a tag push fails if the Windows build is
not signed. Without it, Windows builds stay unsigned and are not enforced.

## Cutting a release

1. Set `version` in `package.json` to the release version (for example
   `0.1.0-alpha.2`) in a PR, and merge it. The workflow fails if the tag and
   `package.json` disagree.
   If the website docs changed since the last refresh, update the offline Help
   bundle first (`bun run help:update`; see [OFFLINE_HELP.md](OFFLINE_HELP.md)).
2. Optional dry run: **Actions → Release → Run workflow** on `main`. It builds
   and verifies all three platforms and uploads them as workflow artifacts,
   without creating a release, even when started from a tag. With the
   certificate secrets set, the macOS build is Developer ID signed (and
   notarized when the API key is set too), but a Developer ID signature is not
   enforced the way a tag push enforces it. Without the certificate it is
   ad-hoc signed, so a tester can launch it after approving it under System
   Settings → Privacy & Security → Open Anyway.
3. Tag the merged commit and push the tag:

   ```bash
   git checkout main && git pull
   git tag -a v0.1.0-alpha.2 -m "Statekeep 0.1.0-alpha.2"
   git push origin v0.1.0-alpha.2
   ```

4. The workflow creates a **draft** release with generated notes. Tags with a
   hyphen (`-alpha.N`, `-beta.N`) are marked as prereleases.
5. Download the DMG on a Mac that has never run a development build, open it,
   and launch Statekeep from Applications. Gatekeeper should open it without a
   warning. Check the Windows installer the same way, then edit the notes
   (marking the Intel Mac and Linux assets as not officially supported) and
   publish the draft. The Intel DMG and Linux assets are not tested by hand
   (see [Platform support](#platform-support)); when a Linux test machine is
   available, install the `.deb` on Ubuntu and the `.rpm` on Fedora and follow
   the Linux desktop checklist in [PILOT_DOGFOOD.md](PILOT_DOGFOOD.md).

A published release is public and cannot be fully recalled once people have
downloaded it. If an asset is wrong, delete the draft and the tag, fix, and tag
again rather than replacing files on a published release.

## Identity

The app ID is `com.makefieldworks.statekeep`. It becomes the macOS bundle
identifier and seeds the Windows installer GUID, so changing it after a release
makes macOS and Windows treat the next build as a different application.
