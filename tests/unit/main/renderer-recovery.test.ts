import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { installRendererRecovery } from '../../../src/main/renderer-recovery'
import { err, ErrorCode, ok } from '../../../src/shared/errors'

function setup(responses = [0]) {
  const contents = Object.assign(new EventEmitter(), { reload: vi.fn() })
  const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  const saveProject = vi.fn(async () => ok(undefined))
  const showDialog = vi.fn(async () => ({ response: responses.shift() ?? 0, checkboxChecked: false }))
  const controller = installRendererRecovery({ window: win as unknown as BrowserWindow, logger, hasProject: () => true, saveProject, showDialog })
  return { win, contents, saveProject, showDialog, controller }
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('renderer recovery', () => {
  it('saves main-process edits before reloading the UI after a crash', async () => {
    const { contents, saveProject, showDialog } = setup()
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    await settle()
    expect(showDialog).toHaveBeenCalledOnce()
    expect(saveProject).toHaveBeenCalledOnce()
    expect(contents.reload).toHaveBeenCalledOnce()
    expect(saveProject.mock.invocationCallOrder[0]).toBeLessThan(contents.reload.mock.invocationCallOrder[0]!)
  })
  it('waits on an unresponsive renderer and suppresses stacked prompts', async () => {
    const { win, contents, showDialog, controller } = setup()
    win.emit('unresponsive')
    controller.childProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 1 })
    await settle()
    expect(showDialog).toHaveBeenCalledOnce()
    expect(contents.reload).not.toHaveBeenCalled()
  })
  it('does not reload after a failed save without explicit acknowledgement', async () => {
    const { contents, saveProject, showDialog } = setup([0, 0])
    saveProject.mockResolvedValueOnce(err(ErrorCode.AUTOSAVE_WRITE_FAILED, 'Disk full'))
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    await settle()
    expect(showDialog).toHaveBeenCalledTimes(2)
    expect(contents.reload).not.toHaveBeenCalled()
  })
  it('ignores clean exits and avoids recovery after the window closes', async () => {
    const { win, contents, showDialog, controller } = setup()
    contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    controller.childProcessGone({ type: 'GPU', reason: 'clean-exit', exitCode: 0 })
    win.emit('closed')
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    await settle()
    expect(showDialog).not.toHaveBeenCalled()
  })
})
