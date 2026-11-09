import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { describe, expect, it } from 'vitest'
import { HELP_ORIGIN, readOfflineHelpInfo, resolveHelpRequest } from '../../../src/main/offline-help'

// Checks the committed resources/help/ bundle itself, so a bad regeneration
// fails here rather than in a user's Help window.
const HELP_ROOT = join(process.cwd(), 'resources', 'help')

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

const htmlFiles = listFiles(HELP_ROOT).filter(path => path.endsWith('.html'))

describe('committed offline Help bundle', () => {
  it('has provenance from a committed website revision', () => {
    const info = readOfflineHelpInfo(HELP_ROOT)
    expect(info).not.toBeNull()
    expect(info?.site).toBe('https://statekeep.app')
    expect(info?.source?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(info?.source?.dirty).toBe(false)
  })

  it('stays small enough to commit', () => {
    const bytes = listFiles(HELP_ROOT).reduce((total, path) => total + statSync(path).size, 0)
    expect(bytes).toBeLessThan(5 * 1024 * 1024)
  })

  it('includes the search index', () => {
    expect(existsSync(join(HELP_ROOT, 'pagefind', 'pagefind.js'))).toBe(true)
  })

  it('loads no scripts, styles, images, or fonts from the network', () => {
    const remote = /<(?:script|img|iframe|source|video|audio)\b[^>]*\ssrc="(?:https?:)?\/\/|<link\b(?=[^>]*\brel="(?:stylesheet|preload|modulepreload|icon|shortcut icon)")[^>]*\shref="(?:https?:)?\/\//i
    const offenders = htmlFiles.filter(path => remote.test(readFileSync(path, 'utf8')))
    expect(offenders.map(path => relative(HELP_ROOT, path))).toEqual([])
  })

  it('resolves every root-relative asset reference inside the bundle', () => {
    const missing = new Set<string>()
    for (const path of htmlFiles) {
      const html = readFileSync(path, 'utf8')
      for (const match of html.matchAll(/\s(?:src|href)="(\/(?:_astro|pagefind)\/[^"#?]+)"/g)) {
        const file = resolveHelpRequest(HELP_ROOT, `${HELP_ORIGIN}${match[1]}`)
        if (!file || !existsSync(file)) missing.add(`${relative(HELP_ROOT, path).split(sep).join('/')}: ${match[1]}`)
      }
    }
    expect([...missing]).toEqual([])
  })
})
