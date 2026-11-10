import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { IpcMain, IpcMainInvokeEvent, Session, WebContents } from 'electron'
import { denySessionPermissions, denyWebviews, isTrustedIpcSender, secureIpcMain, type IpcSecurityOptions } from '../../../src/main/security'
import { IPC } from '../../../src/shared/ipc'

const rendererFile = join(process.cwd(), 'out', 'renderer', 'index.html')
function fixture(url = pathToFileURL(rendererFile).href) {
  const frame = { url }
  const sender = { isDestroyed: () => false, mainFrame: frame } as unknown as WebContents
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const options: IpcSecurityOptions = { rendererFile, roleFor: s => s === sender ? 'project' : null }
  return { event, sender, options }
}

describe('IPC sender boundary', () => {
  it('allows the known application document, including Settings query/hash', () => {
    const f = fixture(`${pathToFileURL(rendererFile).href}?settings=1#appearance`)
    expect(isTrustedIpcSender(f.event, IPC.PROJECT_OPEN, f.options)).toBe(true)
  })
  it('rejects foreign local files even though both have a file origin', () => {
    const f = fixture(pathToFileURL(join(process.cwd(), 'out', 'renderer', 'untrusted.html')).href)
    expect(isTrustedIpcSender(f.event, IPC.PROJECT_OPEN, f.options)).toBe(false)
  })
  it('rejects child frames, detached frames, unknown windows and destroyed senders', () => {
    const f = fixture()
    expect(isTrustedIpcSender({ ...f.event, senderFrame: { url: f.event.senderFrame!.url } } as IpcMainInvokeEvent, IPC.PROJECT_OPEN, f.options)).toBe(false)
    expect(isTrustedIpcSender({ ...f.event, senderFrame: null } as IpcMainInvokeEvent, IPC.PROJECT_OPEN, f.options)).toBe(false)
    expect(isTrustedIpcSender(f.event, IPC.PROJECT_OPEN, { ...f.options, roleFor: () => null })).toBe(false)
    vi.spyOn(f.sender, 'isDestroyed').mockReturnValue(true)
    expect(isTrustedIpcSender(f.event, IPC.PROJECT_OPEN, f.options)).toBe(false)
  })
  it('restricts Settings to settings/window APIs', () => {
    const f = fixture()
    f.options.roleFor = () => 'settings'
    expect(isTrustedIpcSender(f.event, IPC.SETTINGS_UPDATE_PREFERENCES, f.options)).toBe(true)
    expect(isTrustedIpcSender(f.event, IPC.PROJECT_CREATE, f.options)).toBe(false)
    expect(isTrustedIpcSender(f.event, IPC.MENU_STATE_UPDATE, f.options)).toBe(false)
  })
  it('checks the exact configured dev origin and document path', () => {
    for (const [url, expected] of [
      ['http://localhost:5173/?settings=1', true],
      ['http://localhost:4173/', false], ['http://localhost:5173/foreign', false],
      ['https://evil.example/', false], ['about:blank', false],
    ] as const) {
      const f = fixture(url)
      expect(isTrustedIpcSender(f.event, IPC.PROJECT_OPEN, { ...f.options, devServerUrl: 'http://localhost:5173' })).toBe(expected)
    }
  })
  it('rejects invocation and menu sends before running their handlers', () => {
    const handles = new Map<string, Function>(); const listeners = new Map<string, Function>()
    const ipc = { handle: (c: string, f: Function) => handles.set(c, f), on: (c: string, f: Function) => listeners.set(c, f) } as unknown as IpcMain
    const f = fixture(); const invoked = vi.fn(); const menu = vi.fn()
    const secure = secureIpcMain(ipc, f.options)
    secure.handle(IPC.PROJECT_OPEN, invoked); secure.on(IPC.MENU_STATE_UPDATE, menu)
    const foreign = { ...f.event, senderFrame: null }
    expect(handles.get(IPC.PROJECT_OPEN)!(foreign, null)).toMatchObject({ ok: false, error: { code: 'IPC_SENDER_DENIED' } })
    listeners.get(IPC.MENU_STATE_UPDATE)!(foreign, {})
    expect(invoked).not.toHaveBeenCalled(); expect(menu).not.toHaveBeenCalled()
    handles.get(IPC.PROJECT_OPEN)!(f.event, { path: '/project' })
    expect(invoked).toHaveBeenCalledWith(f.event, { path: '/project' })
  })
})

describe('browser capabilities', () => {
  it('denies both permission request and synchronous checks, installed once per session', () => {
    const request = vi.fn(); const check = vi.fn()
    const session = { setPermissionRequestHandler: request, setPermissionCheckHandler: check } as unknown as Session
    denySessionPermissions(session); denySessionPermissions(session)
    expect(request).toHaveBeenCalledTimes(1)
    const callback = vi.fn()
    request.mock.calls[0][0](null, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(check.mock.calls[0][0]()).toBe(false)
  })
  it('prevents webview attachment', () => {
    const on = vi.fn(); denyWebviews({ on } as unknown as WebContents)
    const preventDefault = vi.fn()
    expect(on.mock.calls[0][0]).toBe('will-attach-webview')
    on.mock.calls[0][1]({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
  })
})
