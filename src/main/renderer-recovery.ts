import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { Result } from '../shared/types'
import type { Logger } from './logger'

interface RecoveryOptions {
  window: BrowserWindow
  logger: Logger
  hasProject(): boolean
  saveProject(): Promise<Result<void>>
  showDialog(options: MessageBoxOptions): Promise<MessageBoxReturnValue>
}

/** The project lives in the main process. Reload only the UI: do not close or
 * reopen the project, which could discard changes awaiting autosave.
 */
export function installRendererRecovery(options: RecoveryOptions): {
  childProcessGone(details: { type: string; reason: string; exitCode: number }): void
} {
  const { window: win, logger } = options
  let promptActive = false
  let disposed = false

  async function recover(kind: 'crashed' | 'unresponsive' | 'child'): Promise<void> {
    if (disposed || win.isDestroyed() || promptActive) return
    promptActive = true
    try {
      const unresponsive = kind === 'unresponsive'
      const answer = await options.showDialog({
        type: 'warning',
        title: 'Statekeep Recovery',
        message: unresponsive ? 'Statekeep is not responding.'
          : kind === 'child' ? 'A Statekeep helper process stopped unexpectedly.' : 'The Statekeep window stopped unexpectedly.',
        detail: 'You can reload the window while keeping the open project and edits already received by the app. Text that was not submitted may need to be entered again. No crash report is uploaded.',
        buttons: unresponsive ? ['Wait', 'Reload Window'] : ['Reload Window', 'Keep Window'],
        defaultId: 0,
        cancelId: unresponsive ? 0 : 1,
        noLink: true,
      })
      if (answer.response !== (unresponsive ? 1 : 0) || disposed || win.isDestroyed()) return
      if (options.hasProject()) {
        const saved = await options.saveProject()
        if (!saved.ok) {
          logger.warn('recovery save failed', { code: saved.error.code })
          const failedSave = await options.showDialog({
            type: 'warning', title: 'Project Could Not Be Saved',
            message: 'The latest project changes could not be saved to disk.',
            detail: 'Reloading keeps the project in memory in this app process. After reloading, resolve any save or history warning before quitting. Text not submitted to the app cannot be recovered.',
            buttons: ['Keep Window', 'Reload Window'], defaultId: 0, cancelId: 0, noLink: true,
          })
          if (failedSave.response !== 1) return
        }
      }
      if (!disposed && !win.isDestroyed()) win.webContents.reload()
    } catch (error) {
      logger.error('recovery prompt failed', { error: error instanceof Error ? error.message : String(error) })
    } finally { promptActive = false }
  }

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('renderer process gone', { reason: details.reason, exitCode: details.exitCode })
    if (details.reason !== 'clean-exit') void recover('crashed')
  })
  win.on('unresponsive', () => {
    logger.warn('renderer unresponsive')
    void recover('unresponsive')
  })
  win.once('closed', () => { disposed = true })

  return {
    childProcessGone(details) {
      logger.error('child process gone', details)
      if (details.reason !== 'clean-exit') void recover('child')
    },
  }
}
