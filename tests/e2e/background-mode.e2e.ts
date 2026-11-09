import { expect, test } from './fixtures'

test('E2E windows stay hidden and do not take native focus', async ({ electronApp, appPage }) => {
  test.skip(process.env['STATEKEEP_E2E_BACKGROUND'] !== '1', 'Visible E2E run requested')

  await expect(appPage.getByTestId('create-project-btn')).toBeVisible()
  const mainWindow = await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return { visible: win.isVisible(), focused: win.isFocused() }
  })
  expect(mainWindow).toEqual({ visible: false, focused: false })

  const settingsPagePromise = electronApp.waitForEvent('window')
  await electronApp.evaluate(({ Menu }) => {
    const settings = Menu.getApplicationMenu()?.items
      .flatMap(item => item.submenu?.items ?? [])
      .find(item => item.label.startsWith('Settings'))
    if (!settings) throw new Error('Settings menu item was not found')
    settings.click?.()
  })
  const settingsPage = await settingsPagePromise
  await expect(settingsPage.getByRole('heading', { name: 'General' })).toBeVisible()
  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focused: win.isFocused() }))
  )
  expect(windows).toEqual([
    { visible: false, focused: false },
    { visible: false, focused: false },
  ])
})
