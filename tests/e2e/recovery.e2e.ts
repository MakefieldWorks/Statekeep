import { readFileSync } from 'fs'
import { join } from 'path'
import { test, expect } from './fixtures'
import { PROJECT_DOCUMENT_FILE } from '../../src/main/project-document-file'

test('recovers an actual renderer crash without discarding main-process edits', async ({ appPage, electronApp, workspaceDir }) => {
  const projectPath = await appPage.evaluate(async (directory) => {
    const created = await window.api.project.create('Recovery Lab', directory)
    if (!created.ok) throw new Error(created.error.message)
    const added = await window.api.node.create(created.data.nodes[0]!.id, 'Recovered Device')
    if (!added.ok) throw new Error(added.error.message)
    return created.data.path!
  }, workspaceDir)

  const crash = await electronApp.evaluate(async ({ dialog, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    const main = BrowserWindow.getAllWindows().find(win => !win.getParentWindow())
    if (!main) throw new Error('Project window not found')
    const contents = main.webContents
    // On Linux forcefullyCrashRenderer returns before the renderer is gone.
    // Sending executeJavaScript in that interval can leave its promise attached
    // to the dead renderer forever, preventing expect.poll from retrying.
    return await new Promise<{ reason: string; exitCode: number }>((resolve, reject) => {
      let observedCrash: { reason: string; exitCode: number } | null = null
      const cleanup = () => {
        clearTimeout(timer)
        contents.removeListener('render-process-gone', onGone)
        contents.removeListener('did-finish-load', onReloaded)
      }
      const onReloaded = () => {
        cleanup()
        resolve(observedCrash!)
      }
      const onGone = (_event: unknown, details: { reason: string; exitCode: number }) => {
        observedCrash = { reason: details.reason, exitCode: details.exitCode }
        contents.once('did-finish-load', onReloaded)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(observedCrash
          ? `Renderer crashed (${observedCrash.reason}) but recovery did not finish loading.`
          : 'Renderer did not report the requested crash.'))
      }, 10_000)
      contents.once('render-process-gone', onGone)
      try { contents.forcefullyCrashRenderer() } catch (error) { cleanup(); reject(error) }
    })
  })
  expect(crash.reason).not.toBe('clean-exit')

  await expect.poll(async () => {
    // Playwright permanently marks the old Page as crashed even after Electron
    // reloads its WebContents. Inspect the replacement renderer through the
    // surviving main-process connection rather than using that stale Page.
    try {
      return await electronApp.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(window => !window.getParentWindow())
        if (!win || win.webContents.isCrashed() || win.webContents.isLoading()) return false
        return await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="project-view"]')) && Array.from(document.querySelectorAll('[data-testid="tree-node"]')).some(node => node.textContent.includes('Recovered Device'))`)
      })
    } catch { return false }
  }, { timeout: 15_000 }).toBe(true)
  const current = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!
    return await win.webContents.executeJavaScript('window.api.project.getCurrent()')
  })
  expect(current.ok && current.data?.nodes.some(node => node.name === 'Recovered Device')).toBe(true)
  const disk = JSON.parse(readFileSync(join(projectPath, PROJECT_DOCUMENT_FILE), 'utf8'))
  expect(disk.nodes.some((node: { name: string }) => node.name === 'Recovered Device')).toBe(true)
})

test('exports a local diagnostics bundle through Help without private paths', async ({ appPage, electronApp, workspaceDir }) => {
  await expect(appPage.getByTestId('create-project-btn')).toBeVisible()
  const destination = join(workspaceDir, 'diagnostics.json')
  await electronApp.evaluate(({ dialog, Menu }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    const item = Menu.getApplicationMenu()?.items.find(entry => entry.label === 'Help')?.submenu?.items
      .find(entry => entry.label === 'Export Diagnostics Bundle...')
    if (!item) throw new Error('Diagnostics export menu item not found')
    item.click()
  }, destination)
  await expect.poll(() => {
    try { return JSON.parse(readFileSync(destination, 'utf8')).format } catch { return null }
  }).toBe(1)
  const bundle = JSON.parse(readFileSync(destination, 'utf8'))
  expect(bundle.diagnostics).toContain('Platform:')
  expect(bundle.logs).toHaveProperty(['app.log'])
  expect(JSON.stringify(bundle)).not.toContain(workspaceDir)
})
