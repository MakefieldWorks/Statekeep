import { expect, test } from './fixtures'

test('only registered project and settings windows can invoke preload APIs', async ({ appPage, electronApp }) => {
  expect(await appPage.evaluate(() => window.api.project.getCurrent())).toEqual({ ok: true, data: null })
  const result = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0]!
    // Even a duplicate of our own trusted document with our preload must not
    // acquire filesystem/project authority by URL alone.
    const foreign = new BrowserWindow({ show: false, webPreferences: {
      preload: `${process.cwd()}/out/preload/index.js`,
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    } })
    try {
      await foreign.loadURL(main.webContents.getURL())
      return await foreign.webContents.executeJavaScript('window.api.project.getCurrent()')
    } finally { foreign.destroy() }
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'IPC_SENDER_DENIED' } })
})

test('session permissions and webview attachment are denied', async ({ appPage, electronApp }) => {
  await expect(appPage.getByTestId('create-project-btn')).toBeVisible()
  const result = await electronApp.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents
    const prevented = { value: false }
    contents.emit('will-attach-webview', { preventDefault: () => { prevented.value = true } }, {}, {})
    return { webviewPrevented: prevented.value }
  })
  expect(result).toEqual({ webviewPrevented: true })
  expect(await appPage.evaluate(() => Notification.requestPermission())).toBe('denied')
})
