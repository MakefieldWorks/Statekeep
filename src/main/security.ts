import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, Session, WebContents } from 'electron'
import { fileURLToPath } from 'url'
import { resolve } from 'path'
import { err, ErrorCode } from '../shared/errors'
import { IPC } from '../shared/ipc'

type SenderEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>
export interface IpcSecurityOptions {
  rendererFile: string
  devServerUrl?: string
  roleFor(sender: WebContents): 'project' | 'settings' | null
}

const settingsChannels = new Set<string>([
  IPC.WINDOW_FOCUS_GET, IPC.SETTINGS_GET, IPC.SETTINGS_UPDATE_WORKSPACE,
  IPC.SETTINGS_GET_PREFERENCES, IPC.SETTINGS_UPDATE_PREFERENCES,
  IPC.SETTINGS_RESET_LAYOUT, IPC.SETTINGS_CLOSE_WINDOW,
])

/** Only our known top-level document may call preload APIs; file: origins alone
 * cannot distinguish the application from other local files. */
export function isTrustedIpcSender(event: SenderEvent, channel: string, options: IpcSecurityOptions): boolean {
  try {
    if (event.sender.isDestroyed()) return false
    const role = options.roleFor(event.sender)
    if (!role || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false
    if (role === 'settings' && !settingsChannels.has(channel)) return false
    const url = new URL(event.senderFrame.url)
    if (url.protocol === 'file:') return resolve(fileURLToPath(url)) === resolve(options.rendererFile)
    if (!options.devServerUrl) return false
    const dev = new URL(options.devServerUrl)
    return (dev.protocol === 'http:' || dev.protocol === 'https:') &&
      url.origin === dev.origin && url.pathname === dev.pathname
  } catch {
    return false
  }
}

/** Validate before entering handlers, including before destructuring payloads. */
export function secureIpcMain(ipc: Pick<IpcMain, 'handle' | 'on'>, options: IpcSecurityOptions) {
  return {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
      ipc.handle(channel, (event, ...args) => isTrustedIpcSender(event, channel, options)
        ? listener(event, ...args)
        : err(ErrorCode.IPC_SENDER_DENIED, 'This window is not allowed to access this application API.'))
    },
    on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
      ipc.on(channel, (event, ...args) => {
        if (isTrustedIpcSender(event, channel, options)) listener(event, ...args)
      })
    },
  }
}

const securedSessions = new WeakSet<Session>()
export function denySessionPermissions(session: Session): void {
  if (securedSessions.has(session)) return
  securedSessions.add(session)
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}

export function denyWebviews(contents: WebContents): void {
  contents.on('will-attach-webview', event => event.preventDefault())
}
