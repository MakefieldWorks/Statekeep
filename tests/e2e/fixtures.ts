import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MenuCommandId } from '../../src/shared/menu-commands'

const ROOT_DIR = process.cwd()
const MAIN_ENTRY = join(ROOT_DIR, 'out', 'main', 'index.js')

type StatekeepFixtures = {
  electronApp: ElectronApplication
  appPage: Page
  workspaceDir: string
}

export const test = base.extend<StatekeepFixtures>({
  workspaceDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'statekeep-e2e-'))
    try {
      await use(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },

  electronApp: async ({ workspaceDir }, use) => {
    void workspaceDir
    if (!existsSync(MAIN_ENTRY)) {
      throw new Error(`Built Electron entrypoint not found at ${MAIN_ENTRY}. Run "bun run build" first.`)
    }

    const electronApp = await electron.launch({
      // Keep each test independent from a running copy of Statekeep and from
      // any persisted user preferences on the development machine.
      args: [MAIN_ENTRY, `--user-data-dir=${join(workspaceDir, 'electron-user-data')}`],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        STATEKEEP_EXAMPLE_PROJECTS_DIR: join(workspaceDir, 'example-projects'),
      },
    })

    try {
      await use(electronApp)
    } finally {
      await electronApp.close()
    }
  },

  appPage: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('create-project-btn')).toBeVisible()
    await use(page)
  },
})

export { expect }

// Electron 39.8.10 on macOS exited with SIGSEGV when a hidden window opened the
// native datalist popup. Not yet rechecked on Electron 44. These tests exercise
// filtering, so suppress only the popup and keep normal input events.
export async function fillPropertyKey(page: Page, value: string): Promise<void> {
  const input = page.getByTestId('inventory-filter-property-key')
  if (process.env['STATEKEEP_E2E_BACKGROUND'] === '1') {
    await input.evaluate(element => element.removeAttribute('list'))
  }
  await input.fill(value)
}

export async function clickNativeMenuCommand(
  electronApp: ElectronApplication,
  command: MenuCommandId,
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!item) throw new Error(`Native menu command not found: ${id}`)
    if (!window) throw new Error(`No native window for menu command: ${id}`)
    item.click(item, window, undefined as never)
  }, command)
}
