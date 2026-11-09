import type { ElectronApplication, Page } from '@playwright/test'
import { DOCUMENTATION_URL, REPORT_ISSUE_URL } from '../../src/shared/external-links'
import { expect, test } from './fixtures'

const HELP_ENTRY = 'statekeep-help://help/docs/start/introduction/'

async function clickHelpItem(electronApp: ElectronApplication, label: string): Promise<void> {
  await expect.poll(() => electronApp.evaluate(({ Menu }, itemLabel) =>
    Menu.getApplicationMenu()?.items.find(item => item.label === 'Help')
      ?.submenu?.items.some(item => item.label === itemLabel) ?? false, label,
  )).toBe(true)
  await electronApp.evaluate(({ Menu }, itemLabel) => {
    const item = Menu.getApplicationMenu()?.items.find(entry => entry.label === 'Help')
      ?.submenu?.items.find(entry => entry.label === itemLabel)
    if (!item) throw new Error(`Help menu item not found: ${itemLabel}`)
    item.click()
  }, label)
}

async function openHelp(electronApp: ElectronApplication): Promise<Page> {
  await clickHelpItem(electronApp, 'Statekeep Help')
  // The window exists before its first page loads, so wait for the Help URL.
  let help: Page | undefined
  await expect.poll(() => {
    help = electronApp.windows().find(page => page.url().startsWith('statekeep-help:'))
    return Boolean(help)
  }).toBe(true)
  await help!.waitForLoadState('domcontentloaded')
  return help!
}

// Replaces shell.openExternal in the main process and records the URLs it gets.
async function recordExternalLinks(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __openedUrls?: string[] }).__openedUrls = opened
    shell.openExternal = async (url) => { opened.push(url) }
  })
}

function openedUrls(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(() => (globalThis as { __openedUrls?: string[] }).__openedUrls ?? [])
}

test('opens the bundled docs in a reusable Help window', async ({ appPage, electronApp }) => {
  await expect(appPage.getByTestId('create-project-btn')).toBeVisible()
  const help = await openHelp(electronApp)

  expect(help.url()).toBe(HELP_ENTRY)
  await expect(help.locator('h1')).toHaveText('What is Statekeep?')
  // Styles and module scripts load from the bundle under the help origin.
  await expect.poll(() => help.evaluate(() => [...document.styleSheets].some(sheet => sheet.href?.includes('/_astro/')))).toBe(true)
  await expect.poll(() => help.evaluate(() => customElements.get('starlight-theme-select') !== undefined)).toBe(true)

  await help.getByRole('link', { name: 'Install Statekeep' }).first().click()
  await expect(help).toHaveURL('statekeep-help://help/docs/start/install/')
  await expect(help.locator('h1')).toHaveText('Install Statekeep')

  const windowsBefore = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  await clickHelpItem(electronApp, 'Statekeep Help')
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore)
  await expect(help).toHaveURL('statekeep-help://help/docs/start/install/')
})

test('searches the bundled docs without a network', async ({ electronApp }) => {
  const help = await openHelp(electronApp)

  await help.locator('site-search button[data-open-modal]').first().click()
  await help.locator('site-search input').first().fill('snapshot')
  const firstResult = help.locator('site-search a[href^="/docs/"]').first()
  await expect(firstResult).toBeVisible({ timeout: 15_000 })
  await firstResult.click()
  await expect(help).toHaveURL(/^statekeep-help:\/\/help\/docs\//)
})

test('opens online-only pages and web links in the browser', async ({ electronApp }) => {
  await recordExternalLinks(electronApp)
  const help = await openHelp(electronApp)

  await help.getByRole('link', { name: 'Install Statekeep' }).first().click()
  await expect(help).toHaveURL('statekeep-help://help/docs/start/install/')

  // Each click is a navigation the Help window cancels. Playwright keeps
  // waiting on a cancelled navigation, so click all three from inside the page.
  await help.evaluate(() => {
    for (const selector of [
      'nav a[href="https://statekeep.app/changelog/"]',
      'main a[href="/download/"]',
      'a[href="https://github.com/MakefieldWorks/Statekeep"]',
    ]) {
      const link = document.querySelector<HTMLAnchorElement>(selector)
      if (!link) throw new Error(`Link not found: ${selector}`)
      link.click()
    }
  })

  await expect.poll(() => openedUrls(electronApp)).toEqual([
    'https://statekeep.app/changelog/',
    'https://statekeep.app/download/',
    'https://github.com/MakefieldWorks/Statekeep',
  ])
  // Playwright's own URL tracking waits on the cancelled navigations, so ask
  // Electron which page the Help window still shows.
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .map(win => win.webContents.getURL())
    .filter(url => url.startsWith('statekeep-help:')))).toEqual(['statekeep-help://help/docs/start/install/'])
})

test('refuses help URLs that point outside the bundle', async ({ electronApp }) => {
  const help = await openHelp(electronApp)
  const status = await help.evaluate(async () => {
    const response = await fetch('/..%2F..%2Fpackage.json')
    return response.status
  })
  expect(status).toBe(404)
})

test('opens the online documentation from Help', async ({ electronApp }) => {
  await recordExternalLinks(electronApp)
  await clickHelpItem(electronApp, 'Online Documentation')
  await expect.poll(() => openedUrls(electronApp)).toEqual([DOCUMENTATION_URL])
})

test('copies diagnostics and shows the issue address when the browser cannot open', async ({ appPage, electronApp }) => {
  await expect(appPage.getByTestId('create-project-btn')).toBeVisible()
  const result = await electronApp.evaluate(async ({ Menu, clipboard, shell, dialog }) => {
    const item = Menu.getApplicationMenu()?.items.find(entry => entry.label === 'Help')
      ?.submenu?.items.find(entry => entry.label === 'Report an Issue...')
    if (!item) throw new Error('Report an Issue menu item was not found')

    const originalOpenExternal = shell.openExternal
    const originalShowMessageBox = dialog.showMessageBox
    let capture!: (options: Electron.MessageBoxOptions) => void
    const shown = new Promise<Electron.MessageBoxOptions>(resolve => { capture = resolve })
    await clipboard.writeText('')
    shell.openExternal = async () => { throw new Error('No browser is available') }
    dialog.showMessageBox = async (...args) => {
      capture(args[args.length - 1] as Electron.MessageBoxOptions)
      return { response: 0, checkboxChecked: false }
    }
    try {
      item.click()
      const options = await shown
      return { type: options.type, message: options.message, detail: options.detail, clipboard: await clipboard.readText() }
    } finally {
      shell.openExternal = originalOpenExternal
      dialog.showMessageBox = originalShowMessageBox
    }
  })

  expect(result.type).toBe('error')
  expect(result.message).toContain('could not open the issue form')
  expect(result.detail).toContain(REPORT_ISSUE_URL)
  expect(result.detail).toContain('Diagnostics were copied to the clipboard')
  expect(result.clipboard).toContain('diagnostics')
  expect(result.clipboard).toContain('Platform: ')
})
