import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path, { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  helpContentType,
  helpNavigation,
  helpRootFor,
  helpUrl,
  readOfflineHelpInfo,
  resolveHelpRequest,
} from '../../../src/main/offline-help'

const ROOT = path.resolve('/app/resources/help')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function bundleDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'statekeep-help-'))
  tempDirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

describe('helpRootFor', () => {
  it('finds resources/help next to the built main process, in development and in app.asar', () => {
    expect(helpRootFor(join('/repo', 'out', 'main'))).toBe(join('/repo', 'resources', 'help'))
    const asar = join('/Applications/Statekeep.app/Contents/Resources/app.asar')
    expect(helpRootFor(join(asar, 'out', 'main'))).toBe(join(asar, 'resources', 'help'))
  })
})

describe('resolveHelpRequest', () => {
  it('maps pages, directories, and assets inside the bundle', () => {
    expect(resolveHelpRequest(ROOT, 'statekeep-help://help/docs/start/install/'))
      .toBe(join(ROOT, 'docs', 'start', 'install', 'index.html'))
    expect(resolveHelpRequest(ROOT, 'statekeep-help://help/'))
      .toBe(join(ROOT, 'index.html'))
    expect(resolveHelpRequest(ROOT, 'statekeep-help://help/_astro/page.abc.js?v=1#top'))
      .toBe(join(ROOT, '_astro', 'page.abc.js'))
    expect(resolveHelpRequest(ROOT, 'statekeep-help://help/docs/a%20b/'))
      .toBe(join(ROOT, 'docs', 'a b', 'index.html'))
  })

  it('rejects other schemes and hosts', () => {
    expect(resolveHelpRequest(ROOT, 'file:///etc/passwd')).toBeNull()
    expect(resolveHelpRequest(ROOT, 'https://help/docs/')).toBeNull()
    expect(resolveHelpRequest(ROOT, 'statekeep-help://other/docs/')).toBeNull()
    expect(resolveHelpRequest(ROOT, 'not a url')).toBeNull()
  })

  it('never resolves outside the bundle', () => {
    // URL parsing drops literal ".." segments, so these stay inside the root.
    expect(resolveHelpRequest(ROOT, 'statekeep-help://help/../../etc/passwd')).toBe(join(ROOT, 'etc', 'passwd'))
    expect(resolveHelpRequest(ROOT, 'statekeep-help://help/%2e%2e/%2e%2e/etc/passwd')).toBe(join(ROOT, 'etc', 'passwd'))
    // Encoded separators survive parsing and only become ".." after decoding.
    for (const url of [
      'statekeep-help://help/..%2F..%2Fsecret',
      'statekeep-help://help/docs/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd',
      'statekeep-help://help/docs/..%2f..%2f..%2fpackage.json',
    ]) {
      expect(resolveHelpRequest(ROOT, url), url).toBeNull()
    }
  })

  it('keeps Windows separators inside the bundle', () => {
    const winRoot = 'C:\\Program Files\\Statekeep\\resources\\app.asar\\resources\\help'
    expect(resolveHelpRequest(winRoot, 'statekeep-help://help/docs/', path.win32))
      .toBe(`${winRoot}\\docs\\index.html`)
    expect(resolveHelpRequest(winRoot, 'statekeep-help://help/..%5c..%5c..%5cWindows%5cwin.ini', path.win32)).toBeNull()
    // A UNC-looking path stays a relative name under the bundle.
    expect(resolveHelpRequest(winRoot, 'statekeep-help://help/%5c%5cserver%5cshare', path.win32))
      .toBe(`${winRoot}\\server\\share`)
  })

  it('rejects malformed escapes and NUL bytes', () => {
    expect(resolveHelpRequest(ROOT, 'statekeep-help://help/%E0%A4%A')).toBeNull()
    expect(resolveHelpRequest(ROOT, 'statekeep-help://help/index.html%00.png')).toBeNull()
  })
})

describe('helpContentType', () => {
  it('serves module scripts, WebAssembly, and Pagefind data with explicit types', () => {
    expect(helpContentType('/x/page.js')).toBe('text/javascript; charset=utf-8')
    expect(helpContentType('/x/index.HTML')).toBe('text/html; charset=utf-8')
    expect(helpContentType('/x/a.wasm')).toBe('application/wasm')
    expect(helpContentType('/x/wasm.en.pagefind')).toBe('application/octet-stream')
    expect(helpContentType('/x/en_1.pf_fragment')).toBe('application/octet-stream')
  })
})

describe('helpNavigation', () => {
  const files = new Set([
    join(ROOT, 'docs', 'start', 'install', 'index.html'),
    join(ROOT, 'docs', 'start', 'install'),
  ])
  const options = { root: ROOT, site: 'https://statekeep.app', exists: (file: string) => files.has(file) }

  it('loads bundled pages in place, with or without the trailing slash', () => {
    expect(helpNavigation('statekeep-help://help/docs/start/install/#download', options)).toEqual({ action: 'allow' })
    expect(helpNavigation('statekeep-help://help/docs/start/install', options)).toEqual({ action: 'allow' })
  })

  it('sends pages the bundle leaves out to the public site', () => {
    expect(helpNavigation('statekeep-help://help/download/', options))
      .toEqual({ action: 'external', url: 'https://statekeep.app/download/' })
    expect(helpNavigation('statekeep-help://help/changelog/?x=1#v1', options))
      .toEqual({ action: 'external', url: 'https://statekeep.app/changelog/?x=1#v1' })
  })

  it('opens web links in the browser and blocks everything else', () => {
    expect(helpNavigation('https://github.com/MakefieldWorks/Statekeep', options))
      .toEqual({ action: 'external', url: 'https://github.com/MakefieldWorks/Statekeep' })
    expect(helpNavigation('file:///etc/passwd', options)).toEqual({ action: 'block' })
    expect(helpNavigation('javascript:alert(1)', options)).toEqual({ action: 'block' })
    expect(helpNavigation('statekeep-help://other/docs/', options)).toEqual({ action: 'block' })
    expect(helpNavigation('statekeep-help://help/download/', { ...options, site: null })).toEqual({ action: 'block' })
  })
})

describe('readOfflineHelpInfo', () => {
  const info = {
    format: 1,
    entry: '/docs/start/introduction/',
    site: 'https://statekeep.app',
    source: { repository: 'statekeep-website', commit: 'abc123', dirty: false },
  }

  it('reads a bundle whose entry page exists', () => {
    const dir = bundleDir({
      'offline-help.json': JSON.stringify(info),
      'docs/start/introduction/index.html': '<h1>Intro</h1>',
    })
    expect(readOfflineHelpInfo(dir)).toEqual({
      entry: info.entry,
      site: info.site,
      source: info.source,
    })
  })

  it('treats a missing, malformed, or incomplete bundle as no Help', () => {
    expect(readOfflineHelpInfo(bundleDir({}))).toBeNull()
    expect(readOfflineHelpInfo(bundleDir({ 'offline-help.json': '{' }))).toBeNull()
    expect(readOfflineHelpInfo(bundleDir({ 'offline-help.json': JSON.stringify(info) }))).toBeNull()
    expect(readOfflineHelpInfo(bundleDir({
      'offline-help.json': JSON.stringify({ ...info, site: 'http://example.com' }),
      'docs/start/introduction/index.html': '',
    }))).toBeNull()
  })
})

describe('helpUrl', () => {
  it('builds URLs on the help origin', () => {
    expect(helpUrl('/docs/start/introduction/')).toBe('statekeep-help://help/docs/start/introduction/')
  })
})
