import { existsSync, readFileSync } from 'fs'
import path from 'path'

// Offline Help is the website's docs, built as static files and committed under
// resources/help/ (see docs/OFFLINE_HELP.md). This module holds the pure rules
// for serving them; help-window.ts wires them into Electron.

// A privileged, standard scheme gives the bundle a real origin, so Astro's
// root-relative URLs (/_astro/..., /docs/...) resolve, and fetch, module
// scripts, and Pagefind's WebAssembly search work as they do on the website.
export const HELP_SCHEME = 'statekeep-help'
export const HELP_HOST = 'help'
export const HELP_ORIGIN = `${HELP_SCHEME}://${HELP_HOST}`
export const HELP_INFO_FILE = 'offline-help.json'

// Starlight inlines small scripts and styles (theme, search dialog). Nothing may
// load from the network, and Pagefind needs to compile its WebAssembly index.
export const HELP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

export interface OfflineHelpInfo {
  /** Path of the first page to show, such as /docs/start/introduction/. */
  entry: string
  /** Public site that serves the same docs, for pages the bundle leaves out. */
  site: string
  source: { repository: string; commit: string; dirty: boolean } | null
}

export type HelpNavigation =
  | { action: 'allow' }
  | { action: 'external'; url: string }
  | { action: 'block' }

type PathModule = Pick<typeof path, 'resolve' | 'sep'>

export function helpRootFor(mainDir: string): string {
  // mainDir is the built main process folder (out/main), inside app.asar when
  // packaged. Resolving from it rather than app.getAppPath() also works when
  // Electron is started on out/main/index.js directly, as the E2E tests do.
  return path.join(mainDir, '..', '..', 'resources', 'help')
}

export function helpUrl(pathname: string): string {
  return new URL(pathname, `${HELP_ORIGIN}/`).toString()
}

/**
 * Maps a statekeep-help:// URL to a file inside the bundle, or null when the
 * URL is for another scheme or host, is malformed, or would leave the bundle.
 * Directory URLs map to their index.html.
 */
export function resolveHelpRequest(root: string, url: string, paths: PathModule = path): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${HELP_SCHEME}:` || parsed.host !== HELP_HOST) return null

  // URL parsing already drops literal ".." segments. Decoding can produce new
  // ones (%2e%2e%2f) or Windows separators (%5c), so containment is checked on
  // the final file path, not on the URL.
  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  if (pathname.endsWith('/')) pathname += 'index.html'

  const resolvedRoot = paths.resolve(root)
  const filePath = paths.resolve(resolvedRoot, `.${pathname}`)
  if (!filePath.startsWith(resolvedRoot + paths.sep)) return null
  return filePath
}

export function helpContentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Decides what a link or redirect inside the Help window does. Pages in the
 * bundle load in place; pages it leaves out (download, changelog) and other
 * http(s) links open in the browser; anything else is blocked.
 */
export function helpNavigation(
  url: string,
  options: { root: string; site: string | null; exists(filePath: string): boolean },
): HelpNavigation {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { action: 'block' }
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return { action: 'external', url: parsed.toString() }
  }
  if (parsed.protocol !== `${HELP_SCHEME}:`) return { action: 'block' }

  const filePath = resolveHelpRequest(options.root, url)
  if (!filePath) return { action: 'block' }
  if (options.exists(filePath) || options.exists(path.join(filePath, 'index.html'))) {
    return { action: 'allow' }
  }
  if (!options.site) return { action: 'block' }
  return { action: 'external', url: new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, options.site).toString() }
}

/** Reads the bundle's offline-help.json, or null when Help is not bundled. */
export function readOfflineHelpInfo(root: string): OfflineHelpInfo | null {
  const infoPath = path.join(root, HELP_INFO_FILE)
  if (!existsSync(infoPath)) return null
  try {
    const raw = JSON.parse(readFileSync(infoPath, 'utf8')) as Record<string, unknown>
    const entry = typeof raw.entry === 'string' && raw.entry.startsWith('/') ? raw.entry : null
    const site = typeof raw.site === 'string' && /^https:\/\//.test(raw.site) ? raw.site : null
    if (!entry || !site) return null
    if (!existsSync(resolveHelpRequest(root, helpUrl(entry)) ?? '')) return null
    const source = raw.source as Record<string, unknown> | undefined
    return {
      entry,
      site,
      source: source && typeof source.commit === 'string'
        ? { repository: String(source.repository ?? ''), commit: source.commit, dirty: source.dirty === true }
        : null,
    }
  } catch {
    return null
  }
}
