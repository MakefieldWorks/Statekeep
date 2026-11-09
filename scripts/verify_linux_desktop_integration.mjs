#!/usr/bin/env node

// Inspect the desktop metadata emitted by electron-builder's Linux targets.
// This deliberately checks the finished artifacts, because desktop entries and
// MIME definitions are generated from build configuration rather than being
// source files that TypeScript/unit tests can exercise.

import { execFileSync, spawnSync } from 'child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, relative } from 'path'
import { fileURLToPath } from 'url'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const DIST_DIR = join(ROOT_DIR, 'dist')
const VERSION = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version
const PREFIX = `Statekeep-${VERSION}-linux-`
const MIME_TYPE = 'application/x-statekeep'
const PROJECT_GLOB = '*.statekeep'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? ROOT_DIR,
      encoding: options.encoding ?? 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
}

function asset(extension) {
  const matches = readdirSync(DIST_DIR)
    .filter(name => name.startsWith(PREFIX) && name.endsWith(extension))
    .map(name => join(DIST_DIR, name))
  assert(matches.length === 1, `Expected one ${extension} asset named ${PREFIX}*, found ${matches.length}`)
  return matches[0]
}

function walk(directory) {
  const entries = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else entries.push(path)
    }
  }
  return entries
}

function findDesktopFile(root) {
  const matches = walk(root).filter(path => path.endsWith('.desktop'))
  assert(matches.length === 1, `Expected one .desktop file under ${root}, found ${matches.length}`)
  return matches[0]
}

function desktopValue(contents, key) {
  const line = contents.split(/\r?\n/).find(candidate => candidate.startsWith(`${key}=`))
  return line?.slice(key.length + 1) ?? null
}

function verifyDesktopFile(path, label) {
  const contents = readFileSync(path, 'utf8')
  assert(desktopValue(contents, 'Name') === 'Statekeep', `${label}: desktop Name must be Statekeep`)
  assert(desktopValue(contents, 'Icon'), `${label}: desktop entry has no Icon`)
  assert(desktopValue(contents, 'Exec'), `${label}: desktop entry has no Exec command`)
  assert(desktopValue(contents, 'Categories')?.split(';').includes('Office'), `${label}: desktop Categories must include Office`)
  assert(desktopValue(contents, 'MimeType')?.split(';').includes(MIME_TYPE), `${label}: desktop MimeType must include ${MIME_TYPE}`)
}

function verifyMimeDefinition(root, label) {
  const definitions = walk(root).filter(path => path.endsWith('.xml') && path.includes('/mime/'))
  const definition = definitions.find(path => {
    const contents = readFileSync(path, 'utf8')
    return contents.includes(MIME_TYPE) && contents.includes(PROJECT_GLOB)
  })
  assert(definition, `${label}: missing MIME XML for ${PROJECT_GLOB} (${MIME_TYPE})`)
}

function verifyIcon(root, label, isAppImage) {
  const files = walk(root)
  const hasIcon = isAppImage
    // AppImage convention is a root .DirIcon (normally targeting statekeep.png)
    // rather than the hicolor hierarchy used by system packages.
    ? files.some(path => basename(path) === '.DirIcon' || basename(path) === 'statekeep.png')
    : files.some(path => /\/icons\/.+\.png$/i.test(path))
  assert(hasIcon, `${label}: no installed Statekeep icon was found`)
}

function verifyTree(root, label, { requireMimeDefinition, isAppImage = false }) {
  const desktop = findDesktopFile(root)
  verifyDesktopFile(desktop, label)
  verifyIcon(root, label, isAppImage)
  if (requireMimeDefinition) verifyMimeDefinition(root, label)
  console.log(`${label}: ${relative(root, desktop)} has Statekeep name, Office category, icon, and ${MIME_TYPE}`)
}

function withTemporaryDirectory(prefix, action) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  try {
    action(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function verifyAppImage(path) {
  assert((statSync(path).mode & 0o111) !== 0, `${path} is not executable`)
  withTemporaryDirectory('statekeep-appimage-', directory => {
    run(path, ['--appimage-extract'], { cwd: directory })
    verifyTree(join(directory, 'squashfs-root'), 'AppImage', { requireMimeDefinition: false, isAppImage: true })
  })
}

function verifyDeb(path) {
  withTemporaryDirectory('statekeep-deb-', directory => {
    run('dpkg-deb', ['--extract', path, directory])
    verifyTree(directory, 'deb', { requireMimeDefinition: true })
  })
}

function verifyRpm(path) {
  withTemporaryDirectory('statekeep-rpm-', directory => {
    // The cpio stream is the whole uncompressed app (hundreds of MB), far past
    // what execFileSync will buffer, so rpm2cpio writes it to a file instead.
    const archivePath = join(directory, 'payload.cpio')
    const archive = openSync(archivePath, 'w')
    let extract
    try {
      extract = spawnSync('rpm2cpio', [path], { stdio: ['ignore', archive, 'pipe'], encoding: 'utf8' })
    } finally {
      closeSync(archive)
    }
    if (extract.error || extract.status !== 0) {
      throw new Error(`rpm2cpio could not read ${basename(path)}: ${extract.stderr || extract.error}`)
    }

    const root = join(directory, 'root')
    mkdirSync(root)
    const input = openSync(archivePath, 'r')
    let unpack
    try {
      unpack = spawnSync('cpio', ['--extract', '--make-directories', '--quiet'], {
        cwd: root,
        stdio: [input, 'ignore', 'pipe'],
        encoding: 'utf8',
      })
    } finally {
      closeSync(input)
    }
    if (unpack.error || unpack.status !== 0) {
      throw new Error(`cpio could not extract ${basename(path)}: ${unpack.stderr || unpack.error}`)
    }
    verifyTree(root, 'rpm', { requireMimeDefinition: true })
  })
}

verifyAppImage(asset('.AppImage'))
verifyDeb(asset('.deb'))
verifyRpm(asset('.rpm'))
console.log('Verified Linux desktop integration metadata in AppImage, deb, and rpm artifacts')
