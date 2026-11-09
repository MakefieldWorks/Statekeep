// electron-builder afterPack hook. When a macOS build has no Developer ID
// certificate (STATEKEEP_ADHOC_SIGN=1, set by the release workflow's unsigned
// path), ad-hoc sign the bundle before the DMG is made. Packaging edits the
// Electron bundle and breaks its original seal, and Apple silicon refuses to
// run code with a broken signature ("damaged"); an ad-hoc signature only needs
// the tester's Open Anyway approval. Signed builds skip this and let
// electron-builder sign with the real identity.

const { execFileSync } = require('child_process')
const { join } = require('path')

exports.default = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.STATEKEEP_ADHOC_SIGN !== '1') return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
