import { BrowserWindow, protocol, shell } from 'electron'
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { Logger } from './logger'
import {
  HELP_CONTENT_SECURITY_POLICY,
  HELP_SCHEME,
  helpContentType,
  helpNavigation,
  helpUrl,
  resolveHelpRequest,
  type OfflineHelpInfo,
} from './offline-help'

let helpWindow: BrowserWindow | null = null

/** Must run before the app is ready; Electron fixes scheme privileges at startup. */
export function registerHelpScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: HELP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  }])
}

/** Serves the bundle at root. Only files inside root are ever read. */
export function installHelpProtocol(root: string, logger: Logger): void {
  protocol.handle(HELP_SCHEME, async (request) => {
    const filePath = resolveHelpRequest(root, request.url)
    if (!filePath) {
      logger.warn('blocked help request', { url: request.url })
      return notFound(root)
    }
    try {
      const info = await stat(filePath)
      return await fileResponse(info.isDirectory() ? join(filePath, 'index.html') : filePath, 200)
    } catch {
      return notFound(root)
    }
  })
}

export function isHelpWindow(win: BrowserWindow | null | undefined): boolean {
  return Boolean(win) && win === helpWindow
}

export function closeHelpWindow(): void {
  if (helpWindow && !helpWindow.isDestroyed()) helpWindow.close()
}

/** Shows the Help window, creating it on first use and reusing it after. */
export function openHelpWindow(options: {
  root: string
  info: OfflineHelpInfo
  show: boolean
  icon: string | undefined
  backgroundColor: string
  logger: Logger
}): BrowserWindow {
  if (helpWindow && !helpWindow.isDestroyed()) {
    if (options.show) {
      if (helpWindow.isMinimized()) helpWindow.restore()
      helpWindow.show()
      helpWindow.focus()
    }
    return helpWindow
  }

  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 480,
    minHeight: 400,
    show: false,
    title: 'Statekeep Help',
    icon: options.icon,
    backgroundColor: options.backgroundColor,
    webPreferences: {
      // Help is static documentation: no preload, no Node, and no access to
      // the project APIs the main window's preload exposes.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Hidden E2E windows need timers, as in the main window.
      backgroundThrottling: options.show,
    },
  })

  const decide = (url: string) => helpNavigation(url, { root: options.root, site: options.info.site, exists: existsSync })
  const openExternal = (url: string) => {
    shell.openExternal(url).catch((error: unknown) => {
      options.logger.error('failed to open help link', { error: error instanceof Error ? error.message : String(error), url })
    })
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    const navigation = decide(url)
    if (navigation.action === 'external') openExternal(navigation.url)
    else if (navigation.action === 'allow') void win.loadURL(url)
    return { action: 'deny' }
  })
  const guardNavigation = (event: Electron.Event, url: string) => {
    const navigation = decide(url)
    if (navigation.action === 'allow') return
    event.preventDefault()
    if (navigation.action === 'external') openExternal(navigation.url)
    else options.logger.warn('blocked help navigation', { url })
  }
  win.webContents.on('will-navigate', guardNavigation)
  win.webContents.on('will-redirect', guardNavigation)

  if (options.show) win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (helpWindow === win) helpWindow = null
  })

  void win.loadURL(helpUrl(options.info.entry))
  helpWindow = win
  return win
}

async function fileResponse(filePath: string, status: number): Promise<Response> {
  const body = await readFile(filePath)
  return new Response(body, {
    status,
    headers: {
      'Content-Type': helpContentType(filePath),
      'Content-Security-Policy': HELP_CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

async function notFound(root: string): Promise<Response> {
  try {
    return await fileResponse(join(root, '404.html'), 404)
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
}
