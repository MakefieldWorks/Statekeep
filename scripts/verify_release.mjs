#!/usr/bin/env node

// Checks the release assets electron-builder wrote to dist/ for the host
// platform, reports their signing state, and writes SHA256SUMS-<os>.txt.
//
//   node scripts/verify_release.mjs                  # report, fail only on broken signatures
//   node scripts/verify_release.mjs --require-signed # also fail when an asset is unsigned
//
// Linux AppImages are not signed, so --require-signed is a no-op there.

import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const DIST_DIR = join(ROOT_DIR, 'dist')
const VERSION = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version
const REQUIRE_SIGNED = process.argv.includes('--require-signed')

const OS = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]
const ASSET_EXTENSIONS = { mac: ['.dmg'], win: ['.exe'], linux: ['.AppImage', '.deb', '.rpm'] }[OS]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// Runs a command and returns its exit status with stdout and stderr combined.
// codesign and spctl write their findings to stderr even on success, which
// execFileSync would drop, so this uses spawnSync and never throws.
function probe(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  if (result.error) return { ok: false, output: String(result.error) }
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`, stdout: result.stdout }
}

function releaseAssets() {
  const prefix = `Statekeep-${VERSION}-${OS}-`
  const assets = readdirSync(DIST_DIR)
    .filter((name) => name.startsWith(prefix) && ASSET_EXTENSIONS.some((ext) => name.endsWith(ext)))
    .map((name) => join(DIST_DIR, name))
  assert(assets.length > 0, `No ${ASSET_EXTENSIONS.join('/')} assets named ${prefix}* in ${DIST_DIR}`)
  return assets
}

// electron-builder stages each mac arch in its own folder (mac, mac-arm64).
function macAppBundles() {
  return readdirSync(DIST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => join(DIST_DIR, entry.name, 'Statekeep.app'))
    .filter((path) => existsSync(path))
}

// `stapler validate` checks the stapled ticket against Apple's ticket service,
// which drops connections now and then (Error 68), so retry before concluding
// the ticket is missing.
function stapleValidate(app) {
  let result
  for (const delaySeconds of [0, 15, 30, 60]) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delaySeconds * 1000)
    result = probe('xcrun', ['stapler', 'validate', app])
    if (result.ok) return result
  }
  return result
}

function verifyMac() {
  const bundles = macAppBundles()
  assert(bundles.length > 0, `No Statekeep.app bundles under ${DIST_DIR}/mac*`)

  for (const app of bundles) {
    const details = probe('codesign', ['--display', '--verbose=4', app])
    const signed = details.ok && details.output.includes('Authority=Developer ID Application')

    if (!signed) {
      assert(!REQUIRE_SIGNED, `${app} is not signed with a Developer ID Application certificate`)
      // An unsigned build is ad-hoc signed by scripts/adhoc-sign-mac.cjs; a
      // broken seal would make macOS report the app as damaged.
      const adhoc = probe('codesign', ['--verify', '--deep', '--strict', app])
      assert(adhoc.ok, `${app} has no Developer ID signature and its ad-hoc seal is broken (was the certificate the wrong type?):\n${adhoc.output}`)
      console.log(`${app}: ad-hoc signed only (no Developer ID signature)`)
      continue
    }

    const verify = probe('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    assert(verify.ok, `codesign --verify failed for ${app}:\n${verify.output}`)
    assert(/flags=0x10000\(runtime\)/.test(details.output), `${app} is signed without the hardened runtime`)

    const stapled = stapleValidate(app)
    const gatekeeper = probe('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
    if (REQUIRE_SIGNED) {
      assert(stapled.ok, `${app} has no stapled notarization ticket:\n${stapled.output}`)
      assert(gatekeeper.ok, `Gatekeeper rejects ${app}:\n${gatekeeper.output}`)
    }

    const authority = details.output.match(/Authority=(Developer ID Application[^\n]*)/)[1]
    console.log(`${app}: signed by ${authority}; notarization ticket ${stapled.ok ? 'stapled' : 'NOT stapled'}; Gatekeeper ${gatekeeper.ok ? 'accepts' : 'REJECTS'}`)
    if (!stapled.ok) console.log(stapled.output)
  }
}

function authenticodeStatus(path) {
  // powershell -Command joins any trailing arguments into the script text, so
  // the path travels through an environment variable instead of being spliced
  // into code. -LiteralPath keeps [] and spaces from acting as wildcards.
  // Windows PowerShell can write CLIXML progress records to stderr on a fresh
  // runner, so silence progress and read the status from stdout only.
  const script = "$ProgressPreference = 'SilentlyContinue'; (Get-AuthenticodeSignature -LiteralPath $env:STATEKEEP_SIGN_TARGET).Status"
  const result = probe('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { STATEKEEP_SIGN_TARGET: path })
  assert(result.ok, `Get-AuthenticodeSignature failed for ${path}:\n${result.output}`)
  return result.stdout.trim()
}

function verifyWindows(assets) {
  const targets = [join(DIST_DIR, 'win-unpacked', 'Statekeep.exe'), ...assets]
  for (const path of targets) {
    assert(existsSync(path), `Missing ${path}`)
    const status = authenticodeStatus(path)
    console.log(`${path}: Authenticode ${status}`)

    if (status === 'NotSigned') {
      assert(!REQUIRE_SIGNED, `${path} is not Authenticode-signed`)
      continue
    }
    assert(status === 'Valid', `${path} has an invalid Authenticode signature (${status})`)
  }
}

function verifyLinux(assets) {
  const appImages = assets.filter(path => path.endsWith('.AppImage'))
  const debs = assets.filter(path => path.endsWith('.deb'))
  const rpms = assets.filter(path => path.endsWith('.rpm'))
  assert(appImages.length === 1, `Expected one Linux AppImage, found ${appImages.length}`)
  assert(debs.length === 1, `Expected one Linux deb package, found ${debs.length}`)
  assert(rpms.length === 1, `Expected one Linux rpm package, found ${rpms.length}`)

  // Browsers drop the executable bit on download anyway, but a non-executable
  // build output means electron-builder did not finish the AppImage.
  assert((statSync(appImages[0]).mode & 0o111) !== 0, `${appImages[0]} is not executable`)
  console.log(`${appImages[0]}: AppImage (unsigned by design)`)
  console.log(`${debs[0]}: deb package`)
  console.log(`${rpms[0]}: rpm package`)
}

function writeChecksums(assets) {
  const lines = assets.map((path) => {
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
    // Two spaces before the name is the format `sha256sum -c` expects.
    return `${digest}  ${basename(path)}`
  })
  const out = join(DIST_DIR, `SHA256SUMS-${OS}.txt`)
  writeFileSync(out, `${lines.join('\n')}\n`)
  console.log(`Wrote ${out}`)
}

function main() {
  assert(OS, `Unsupported platform: ${process.platform}`)
  const assets = releaseAssets()

  if (OS === 'mac') verifyMac()
  else if (OS === 'win') verifyWindows(assets)
  else verifyLinux(assets)

  writeChecksums(assets)
}

main()
