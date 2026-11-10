import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

async function tabTo(page: Page, testId: string) {
  const target = page.getByTestId(testId)
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await target.evaluate(node => node === document.activeElement).catch(() => false)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Could not reach ${testId} with Tab`)
}

test('opens, edits, searches, and snapshots using only the keyboard', async ({ appPage }) => {
  await tabTo(appPage, 'open-example-project-btn')
  await appPage.keyboard.press('Enter')
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await tabTo(appPage, 'project-tree-view')
  await appPage.keyboard.press('Home')
  await appPage.keyboard.press('ArrowDown')
  await appPage.keyboard.press('Enter')
  await appPage.keyboard.press('Shift+F10')
  await expect(appPage.getByRole('menu', { name: 'Node actions' })).toBeVisible()
  await expect(appPage.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused()
  await appPage.keyboard.press('End')
  await expect(appPage.getByRole('menuitem', { name: 'Delete…', exact: true })).toBeFocused()
  await appPage.keyboard.press('Home')
  await appPage.keyboard.press('Enter')
  await expect(appPage.getByTestId('name-input')).toBeFocused()
  await appPage.keyboard.press('ControlOrMeta+A')
  await appPage.keyboard.insertText('Keyboard Systems Room')
  await appPage.keyboard.press('Enter')
  await expect(appPage.getByTestId('node-name')).toContainText('Keyboard Systems Room')

  await tabTo(appPage, 'search-input')
  await appPage.keyboard.insertText('Power')
  await expect(appPage.locator('[data-row-matched="true"]')).toHaveCount(1)
  await appPage.keyboard.press('Escape')
  await tabTo(appPage, 'open-snapshots-btn')
  await appPage.keyboard.press('Enter')
  await tabTo(appPage, 'snapshot-name-input')
  await appPage.keyboard.insertText('keyboard-checkpoint')
  await appPage.keyboard.press('Enter')
  await expect(appPage.getByTestId('snapshot-row').filter({ hasText: 'keyboard-checkpoint' })).toBeVisible()
  await expect(appPage.getByRole('status')).toContainText('keyboard-checkpoint')
})

test('custom modal traps Tab and restores focus on Escape', async ({ appPage, electronApp }) => {
  await tabTo(appPage, 'open-example-project-btn')
  await appPage.keyboard.press('Enter')
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await tabTo(appPage, 'search-input')
  // Opening a menu command is tested separately; this verifies actual modal
  // keyboard behavior, including attempts to Tab into the background.
  await electronApp.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById('project:templates')!
    item.click(item, BrowserWindow.getAllWindows()[0]!, undefined as never)
  })
  const dialog = appPage.getByRole('dialog', { name: 'Manage templates' })
  await expect(dialog).toBeVisible()
  await expect(appPage.getByTestId('template-label')).toBeFocused()
  for (let i = 0; i < 45; i++) {
    await appPage.keyboard.press(i % 3 === 0 ? 'Shift+Tab' : 'Tab')
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true)
  }
  await appPage.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await appPage.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0)
  await expect(appPage.getByTestId('search-input')).toBeFocused()
})

test('native menu commands cannot open another dialog or switch projects while Import is modal', async ({ appPage, electronApp }) => {
  await tabTo(appPage, 'open-example-project-btn')
  await appPage.keyboard.press('Enter')
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  const invoke = async (id: string) => electronApp.evaluate(({ Menu, BrowserWindow }, command) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById(command)!
    item.click(item, BrowserWindow.getAllWindows()[0]!, undefined as never)
  }, id)
  await invoke('project:import')
  const dialog = appPage.getByTestId('import-dialog')
  await expect(dialog).toBeVisible()
  await expect.poll(() => electronApp.evaluate(({ Menu }) => ['project:templates', 'project:open', 'project:close', 'node:rename']
    .every(id => !Menu.getApplicationMenu()!.getMenuItemById(id)!.enabled))).toBe(true)
  expect(await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('open-recent-projects')!.enabled)).toBe(false)
  // Simulate a queued click that was already sent before the main menu state
  // updated. The renderer independently rejects it against current UI state.
  await invoke('project:templates')
  await invoke('project:close')
  await electronApp.evaluate(({ Menu }) => {
    const recent = Menu.getApplicationMenu()!.items.find(item => item.label === 'File')!.submenu!.items
      .find(item => item.label === 'Open Recent')!.submenu!.items[0]!
    recent.click()
  })
  await expect(appPage.getByTestId('template-manager')).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await appPage.keyboard.press('Tab')
  expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true)
  await appPage.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await expect.poll(() => electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('project:templates')!.enabled)).toBe(true)
})

test('virtual tree publishes hierarchy and follows reduced motion', async ({ appPage }) => {
  await appPage.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  await tabTo(appPage, 'open-example-project-btn')
  await appPage.keyboard.press('Enter')
  await expect(appPage.getByRole('tree')).toBeVisible()
  const root = appPage.getByRole('treeitem').first()
  await expect(root).toHaveAttribute('aria-level', '1')
  await expect(root).toHaveAttribute('aria-posinset', '1')
  await expect(root).toHaveAttribute('aria-setsize', '1')
  await expect.poll(() => root.evaluate(node => getComputedStyle(node).transitionDuration)).toBe('1e-05s')
  await expect.poll(() => root.evaluate(node => getComputedStyle(node).forcedColorAdjust)).toBe('none')
  await expect.poll(() => root.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid')
})


test('captures the same project in light, dark, and forced-colors modes', async ({ appPage }, testInfo) => {
  await tabTo(appPage, 'open-example-project-btn')
  await appPage.keyboard.press('Enter')
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  for (const mode of ['light', 'dark', 'high-contrast'] as const) {
    const scheme = mode === 'dark' ? 'dark' : 'light'
    await appPage.emulateMedia({ colorScheme: scheme, forcedColors: mode === 'high-contrast' ? 'active' : 'none', reducedMotion: 'reduce' })
    await expect(appPage.locator('html')).toHaveAttribute('data-theme-scheme', scheme)
    const screenshot = testInfo.outputPath(`${mode}.png`)
    await appPage.screenshot({ path: screenshot })
    await testInfo.attach(`${mode} project`, { path: screenshot, contentType: 'image/png' })
  }
})
