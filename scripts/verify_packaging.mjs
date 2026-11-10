#!/usr/bin/env node

import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { fileURLToPath } from 'url'

import { listPackage, extractFile } from '@electron/asar'
import plist from 'plist'
import { verifyFuses } from './harden-electron.cjs'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const DIST_DIR = join(ROOT_DIR, 'dist')
const REQUIRED_ASSETS = [
  join(ROOT_DIR, 'resources', 'statekeep.svg'),
  join(ROOT_DIR, 'resources', 'icon.png'),
  join(ROOT_DIR, 'resources', 'icon.icns'),
  join(ROOT_DIR, 'resources', 'icon.ico'),
]

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function ensureFile(path) {
  assert(existsSync(path), `Missing required file: ${path}`)
  assert(statSync(path).size > 0, `File is empty: ${path}`)
}

function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'inherit',
  })
}

function findBundle(startDir, suffix) {
  const stack = [startDir]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || !existsSync(current)) continue

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.endsWith(suffix)) return fullPath
        stack.push(fullPath)
      }
    }
  }

  return null
}

function buildHostPackage() {
  run('bun', ['run', 'build'])

  const args = ['--publish', 'never', '--dir']
  const env = {}

  if (process.platform === 'darwin') {
    args.unshift('-c.mac.identity=null')
    args.unshift('--mac')
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  }
  else if (process.platform === 'win32') args.unshift('--win')
  else args.unshift('--linux')

  run(join(ROOT_DIR, 'node_modules', '.bin', 'electron-builder'), args, env)
}

function verifyMacBundle() {
  const appBundle = findBundle(DIST_DIR, '.app')
  assert(appBundle, `Could not find a packaged .app bundle under ${DIST_DIR}`)

  run('codesign', ['--force', '--deep', '--sign', '-', appBundle])
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle])

  const infoPlistPath = join(appBundle, 'Contents', 'Info.plist')
  ensureFile(infoPlistPath)

  const info = plist.parse(readFileSync(infoPlistPath, 'utf8'))
  assert(info.CFBundleDisplayName === 'Statekeep' || info.CFBundleName === 'Statekeep', 'Packaged app bundle is not branded as Statekeep')

  const iconBaseName = String(info.CFBundleIconFile ?? 'Statekeep')
  const iconFileName = iconBaseName.endsWith('.icns') ? iconBaseName : `${iconBaseName}.icns`
  ensureFile(join(appBundle, 'Contents', 'Resources', iconFileName))

  verifyAsarAssets(join(appBundle, 'Contents', 'Resources', 'app.asar'))
  return appBundle
}

function verifyAsarAssets(asarPath) {
  ensureFile(asarPath)

  // listPackage joins entries with the host separator, so Windows reports
  // \resources\icon.png; compare with forward slashes everywhere.
  const asarEntries = new Set(listPackage(asarPath).map(entry => entry.replaceAll('\\', '/')))
  assert(
    asarEntries.has('/resources/icon.png') || asarEntries.has('resources/icon.png'),
    'Packaged app.asar is missing resources/icon.png for runtime icon usage'
  )
  assert(
    asarEntries.has('/out/renderer/favicon.png') || asarEntries.has('out/renderer/favicon.png'),
    'Packaged app.asar is missing the branded favicon asset'
  )
  verifyAsarOfflineHelp(asarEntries)
  // Starters are compiled into the main bundle, not fetched or copied from a
  // development-only resource directory. Check each starter's distinctive data.
  const mainBundle = extractFile(asarPath, 'out/main/index.js').toString('utf8')
  for (const sample of ['DEMO-SA-042', 'DEMO-SW-001', 'DEMO-AC-009']) {
    assert(mainBundle.includes(sample), `Packaged app.asar is missing starter sample ${sample}`)
  }
}

// Help → Statekeep Help reads the bundle from app.asar, so every file of the
// committed bundle must be packaged, not just its entry page.
function verifyAsarOfflineHelp(asarEntries) {
  const helpDir = join(ROOT_DIR, 'resources', 'help')
  const info = JSON.parse(readFileSync(join(helpDir, 'offline-help.json'), 'utf8'))
  const entryPage = `resources/help${info.entry}index.html`
  const missing = listFiles(helpDir)
    .map(path => `resources/help/${relative(helpDir, path).split(sep).join('/')}`)
    .filter(path => !asarEntries.has(`/${path}`) && !asarEntries.has(path))
  assert(missing.length === 0, `Packaged app.asar is missing offline Help files:\n  ${missing.join('\n  ')}`)
  assert(asarEntries.has(`/${entryPage}`) || asarEntries.has(entryPage), `Packaged app.asar is missing ${entryPage}`)
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

function verifyWindowsBundle() {
  const unpackedDir = join(DIST_DIR, 'win-unpacked')
  assert(existsSync(unpackedDir), `Could not find Windows unpacked output at ${unpackedDir}`)
  ensureFile(join(unpackedDir, 'Statekeep.exe'))
  verifyAsarAssets(join(unpackedDir, 'resources', 'app.asar'))
  return join(unpackedDir, 'Statekeep.exe')
}

// buildHostPackage passes --dir, so Linux produces linux-unpacked rather than
// the AppImage target; verify the unpacked executable and its bundled assets.
function verifyLinuxBundle() {
  const unpackedDir = join(DIST_DIR, 'linux-unpacked')
  assert(existsSync(unpackedDir), `Could not find Linux unpacked output at ${unpackedDir}`)
  ensureFile(join(unpackedDir, 'statekeep'))
  verifyAsarAssets(join(unpackedDir, 'resources', 'app.asar'))
  return join(unpackedDir, 'statekeep')
}

async function main() {
  REQUIRED_ASSETS.forEach(ensureFile)
  buildHostPackage()

  const executable = process.platform === 'darwin' ? verifyMacBundle()
    : process.platform === 'win32' ? verifyWindowsBundle() : verifyLinuxBundle()
  await verifyFuses(executable, process.platform)

  console.log(`Verified packaged branding, offline Help, starters, and Electron fuses for ${process.platform}`)
}

await main()
