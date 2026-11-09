#!/usr/bin/env node
// Rebuilds resources/help/ (the offline Help bundle) from a website repo
// checkout (statekeep-website). See docs/OFFLINE_HELP.md.
//
//   bun run help:update -- ../statekeep-website [--allow-dirty]
//
// The website repo owns the docs and how they are exported; this script only
// runs that export and replaces the committed copy, so app builds never need
// the website repo or a network connection.

import { execFileSync } from 'child_process'
import { cpSync, existsSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const HELP_DIR = join(ROOT_DIR, 'resources', 'help')

const args = process.argv.slice(2)
const allowDirty = args.includes('--allow-dirty')
// Default to a sibling checkout of the website repo.
const defaultWebsiteDir = join(ROOT_DIR, '..', 'statekeep-website')
const websiteDir = resolve(args.find(arg => !arg.startsWith('--')) ?? defaultWebsiteDir)
const outputDir = join(websiteDir, 'dist-offline-help')

function fail(message) {
  console.error(`help:update: ${message}`)
  process.exit(1)
}

if (!existsSync(join(websiteDir, 'scripts', 'offline-help', 'build.mjs'))) {
  fail(`${websiteDir} is not a website checkout with the offline Help build`)
}

const status = execFileSync('git', ['status', '--porcelain'], { cwd: websiteDir, encoding: 'utf8' }).trim()
if (status && !allowDirty) {
  fail(`${websiteDir} has uncommitted changes. Commit them, or pass --allow-dirty for a local preview that must not be committed.`)
}

// The website squash-merges, so only commits on its main survive. A bundle
// built from a PR branch would record a commit that later disappears.
try {
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: websiteDir, stdio: 'ignore' })
} catch {
  console.warn(`help:update: warning: ${websiteDir} HEAD is not on origin/main. Commit the refreshed bundle only after rebuilding from the website's main.`)
}

execFileSync('bun', ['run', 'build:offline-help'], { cwd: websiteDir, stdio: 'inherit' })

const info = JSON.parse(readFileSync(join(outputDir, 'offline-help.json'), 'utf8'))
rmSync(HELP_DIR, { recursive: true, force: true })
cpSync(outputDir, HELP_DIR, { recursive: true })

console.log(`\nUpdated resources/help/ from the website at ${info.source.commit.slice(0, 7)}${info.source.dirty ? ' (uncommitted changes)' : ''}.`)
console.log('Run `bun run test` to check the bundle, then commit resources/help/.')
