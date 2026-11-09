// electron-builder afterSign hook. Notarizes the signed macOS app and staples
// the ticket, replacing electron-builder's built-in `notarize`, which fails the
// whole build the first time `xcrun stapler` cannot reach Apple's ticket
// service (Error 68, "The network connection was lost"). Notarization itself
// is one notarytool submission; stapling is retried with backoff, and if it
// still fails the build continues with an unstapled app. Gatekeeper fetches
// the ticket online in that case, and scripts/verify_release.mjs
// --require-signed still rejects an unstapled app for tagged releases.
//
// Runs only when APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID and
// APPLE_API_ISSUER are all set, and never for ad-hoc builds.

const { execFileSync, spawnSync } = require('child_process')
const { mkdtempSync, rmSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')

const STAPLE_RETRY_DELAYS_SECONDS = [30, 60, 120]

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

function notarytool(args) {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env
  const credentials = ['--key', APPLE_API_KEY, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER]
  // notarytool can exit non-zero for a rejected submission while still
  // printing its JSON result, so read stdout before judging the exit code.
  const result = spawnSync('xcrun', ['notarytool', ...args, ...credentials, '--output-format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`xcrun notarytool ${args[0]} failed (exit ${result.status}):\n${result.stdout}${result.stderr}${result.error ?? ''}`)
  }
}

function submit(app) {
  const workDir = mkdtempSync(join(tmpdir(), 'statekeep-notarize-'))
  try {
    const zip = join(workDir, 'Statekeep.zip')
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
    console.log(`  • notarizing ${app}`)
    const result = notarytool(['submit', zip, '--wait', '--timeout', '30m'])
    if (!result.id) throw new Error(`notarytool submit returned no submission:\n${JSON.stringify(result, null, 2)}`)
    if (result.status !== 'Accepted') {
      let log
      try {
        log = JSON.stringify(notarytool(['log', result.id]), null, 2)
      } catch (error) {
        log = `(could not fetch the notarization log: ${error.message})`
      }
      throw new Error(`Notarization of ${app} finished with status ${result.status} (submission ${result.id}):\n${log}`)
    }
    console.log(`  • notarized (submission ${result.id})`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

async function staple(app) {
  for (let attempt = 0; ; attempt++) {
    const result = spawnSync('xcrun', ['stapler', 'staple', app], { encoding: 'utf8' })
    if (result.status === 0) {
      console.log(`  • stapled the notarization ticket to ${app}`)
      return
    }
    const delay = STAPLE_RETRY_DELAYS_SECONDS[attempt]
    if (delay === undefined) {
      console.warn(`  ⚠ could not staple ${app} after ${attempt + 1} attempts; it is notarized but unstapled:\n${result.stdout}${result.stderr}`)
      return
    }
    console.warn(`  ⚠ stapling failed (attempt ${attempt + 1}); retrying in ${delay}s`)
    await sleep(delay)
  }
}

exports.default = async function notarizeMac(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.STATEKEEP_ADHOC_SIGN === '1') return
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.log('  • skipped macOS notarization (APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are not all set)')
    return
  }

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // electron-builder runs afterSign even when it skipped signing, so only
  // submit an app that actually carries a Developer ID signature.
  const signature = spawnSync('codesign', ['--display', '--verbose=2', app], { encoding: 'utf8' })
  if (!`${signature.stdout}${signature.stderr}`.includes('Authority=Developer ID Application')) {
    console.log('  • skipped macOS notarization (the app has no Developer ID signature)')
    return
  }
  submit(app)
  await staple(app)
}
