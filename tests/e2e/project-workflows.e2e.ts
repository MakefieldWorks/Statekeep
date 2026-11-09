import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { clickNativeMenuCommand, expect, test } from './fixtures'
import { PROJECT_DOCUMENT_FILE } from '../../src/main/project-document-file'
import { RELEASES_URL } from '../../src/shared/external-links'

type PersistedProject = {
  name: string
  path?: string
  nodes: Array<{
    id: string
    parentId: string | null
    name: string
    order: number
    properties: Record<string, string | number | boolean | null>
  }>
}

const ROOT_DIR = process.cwd()
const MAIN_ENTRY = join(ROOT_DIR, 'out', 'main', 'index.js')

function treeRow(page: Page, name: string) {
  return page.locator('[data-testid="tree-node"]', { hasText: name }).first()
}

async function setDialogPath(electronApp: ElectronApplication, selectedPath: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    })
  }, selectedPath)
}

async function createProjectThroughUi(
  appPage: Page,
  electronApp: ElectronApplication,
  parentDir: string,
  projectName: string
): Promise<string> {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill(projectName)

  await setDialogPath(electronApp, parentDir)
  await appPage.getByTestId('choose-folder-btn').click()
  await expect(appPage.getByTestId('selected-path')).toContainText(parentDir)

  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await expect(treeRow(appPage, projectName)).toBeVisible()

  return join(parentDir, projectName)
}

async function closeProjectViaMenu(page: Page, electronApp: ElectronApplication): Promise<void> {
  await expect.poll(() => electronApp.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.getMenuItemById('project:close')?.enabled ?? false,
  )).toBe(true)
  await clickNativeMenuCommand(electronApp, 'project:close')
  await expect(page.getByTestId('recent-project-list')).toBeVisible()
}

async function openProjectThroughUi(
  appPage: Page,
  electronApp: ElectronApplication,
  projectDir: string
): Promise<void> {
  await setDialogPath(electronApp, projectDir)
  await appPage.getByTestId('open-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
}

async function openContextMenuAction(page: Page, nodeName: string, actionLabel: string): Promise<void> {
  await treeRow(page, nodeName).click({ button: 'right' })
  await page.getByRole('menuitem', { name: actionLabel }).click()
}

async function currentProject(page: Page): Promise<PersistedProject> {
  const result = await page.evaluate(() => window.api.project.getCurrent())
  expect(result.ok).toBe(true)
  if (!result.ok || !result.data) {
    throw new Error('Expected an open project in the main process')
  }
  return result.data
}

async function nativeOpenRecentMenuItems(electronApp: ElectronApplication): Promise<Array<{
  label: string
  enabled: boolean
  sublabel?: string
}>> {
  return electronApp.evaluate(({ Menu }) => {
    const fileMenu = Menu.getApplicationMenu()?.items.find(item => item.label === 'File')
    const openRecentMenu = fileMenu?.submenu?.items.find(item => item.label === 'Open Recent')
    return openRecentMenu?.submenu?.items.map(item => ({
      label: item.label,
      enabled: item.enabled,
      sublabel: item.sublabel,
    })) ?? []
  })
}

async function openSettingsWindow(electronApp: ElectronApplication): Promise<Page> {
  const settingsWindow = electronApp.waitForEvent('window')
  await electronApp.evaluate(({ Menu }) => {
    const findSettingsItem = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label.startsWith('Settings')) return item
        const child = item.submenu && findSettingsItem(item.submenu.items)
        if (child) return child
      }
      return undefined
    }
    const settingsItem = findSettingsItem(Menu.getApplicationMenu()?.items ?? [])
    if (!settingsItem) throw new Error('Settings menu item was not found')
    settingsItem.click?.()
  })
  return settingsWindow
}

async function closeSettingsWindow(settingsPage: Page): Promise<void> {
  const closed = settingsPage.waitForEvent('close')
  // Done closes the window from its click handler, so the window can be gone
  // before Playwright finishes the click and the click then rejects with
  // "Target page, context or browser has been closed". That is the outcome we
  // want, so only rethrow when the window is still open.
  await settingsPage.getByTestId('settings-done').click().catch((error: unknown) => {
    if (!settingsPage.isClosed()) throw error
  })
  await closed
}

async function writeFixtureProject(targetDir: string, fixtureName: string): Promise<void> {
  mkdirSync(targetDir, { recursive: true })
  const fixturePath = join(process.cwd(), 'tests', 'fixtures', fixtureName)
  writeFileSync(join(targetDir, 'Statekeep.statekeep'), readFileSync(fixturePath, 'utf8'), 'utf8')
}

async function launchAppWithArgs(args: string[], userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, ...args],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  })
}

test('creates a new project from the welcome flow', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Bench Alpha')
  const documentPath = join(projectDir, PROJECT_DOCUMENT_FILE)

  expect(existsSync(documentPath)).toBe(true)
  expect(existsSync(join(projectDir, '.git'))).toBe(true)

  const saved = JSON.parse(readFileSync(documentPath, 'utf8')) as PersistedProject
  expect(saved.name).toBe('Bench Alpha')
  expect(saved.nodes).toHaveLength(1)
  expect(saved.nodes[0]?.parentId).toBeNull()
})

test('opens the releases page from Help → Check for Updates', async ({ electronApp }) => {
  await expect.poll(() => electronApp.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items.some(item =>
      item.label === 'Help' && item.submenu?.items.some(child => child.label === 'Check for Updates...'),
    ) ?? false,
  )).toBe(true)

  const openedUrl = await electronApp.evaluate(async ({ Menu, shell }) => {
    const helpMenu = Menu.getApplicationMenu()?.items.find(item => item.label === 'Help')
    const updateItem = helpMenu?.submenu?.items.find(item => item.label === 'Check for Updates...')
    if (!updateItem) throw new Error('Check for Updates menu item was not found')

    const originalOpenExternal = shell.openExternal
    let url: string | null = null
    shell.openExternal = async (target) => { url = target }
    try {
      await updateItem.click?.()
      return url
    } finally {
      shell.openExternal = originalOpenExternal
    }
  })

  expect(openedUrl).toBe(RELEASES_URL)
})

test('explains how to view releases when the browser cannot open', async ({ appPage, electronApp }) => {
  await expect(appPage.getByTestId('create-project-btn')).toBeVisible()
  const message = await electronApp.evaluate(async ({ Menu, shell, dialog }) => {
    const helpMenu = Menu.getApplicationMenu()?.items.find(item => item.label === 'Help')
    const updateItem = helpMenu?.submenu?.items.find(item => item.label === 'Check for Updates...')
    if (!updateItem) throw new Error('Check for Updates menu item was not found')

    const originalOpenExternal = shell.openExternal
    const originalShowMessageBox = dialog.showMessageBox
    let capture!: (options: Electron.MessageBoxOptions) => void
    const shown = new Promise<Electron.MessageBoxOptions>(resolve => { capture = resolve })
    shell.openExternal = async () => { throw new Error('No browser is available') }
    dialog.showMessageBox = async (...args) => {
      capture(args[args.length - 1] as Electron.MessageBoxOptions)
      return { response: 0, checkboxChecked: false }
    }
    try {
      updateItem.click?.()
      const options = await shown
      return { type: options.type, message: options.message, detail: options.detail }
    } finally {
      shell.openExternal = originalOpenExternal
      dialog.showMessageBox = originalShowMessageBox
    }
  })

  expect(message.type).toBe('error')
  expect(message.message).toContain('could not open the releases page')
  expect(message.detail).toContain(RELEASES_URL)
  expect(message.detail).toContain('local projects can still be used without internet access')
})

test('creates and opens an example project from the empty project hub', async ({ appPage, workspaceDir }) => {
  await appPage.getByTestId('open-example-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await treeRow(appPage, 'Systems Room').getByRole('button', { name: 'Expand' }).click()
  await treeRow(appPage, 'Rack A').getByRole('button', { name: 'Expand' }).click()
  await expect(treeRow(appPage, 'Telemetry Gateway')).toBeVisible()

  const project = await currentProject(appPage)
  expect(project.name).toBe('Statekeep Sample Lab')
  expect(project.path).toBe(
    join(workspaceDir, 'example-projects', 'Statekeep Sample Lab'),
  )

  const snapshots = await appPage.evaluate(() => window.api.snapshot.list())
  expect(snapshots.ok && snapshots.data.map(snapshot => snapshot.name).sort()).toEqual([
    'baseline-lab',
    'firmware-update',
  ])
})

test('keeps a focused selected tree row above an adjacent hovered row', async ({ appPage }) => {
  await appPage.getByTestId('open-example-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await treeRow(appPage, 'Systems Room').getByRole('button', { name: 'Expand' }).click()
  await treeRow(appPage, 'Rack A').getByRole('button', { name: 'Expand' }).click()

  const powerSupply = treeRow(appPage, 'Power Supply')
  const telemetryGateway = treeRow(appPage, 'Telemetry Gateway')
  await powerSupply.click()
  await telemetryGateway.hover()

  await expect.poll(() => powerSupply.evaluate(node => document.activeElement === node)).toBe(true)
  await expect.poll(async () => {
    const [selectedZIndex, hoveredZIndex] = await Promise.all([
      powerSupply.locator('xpath=..').evaluate(node => Number.parseInt(getComputedStyle(node).zIndex, 10) || 0),
      telemetryGateway.locator('xpath=..').evaluate(node => Number.parseInt(getComputedStyle(node).zIndex, 10) || 0),
    ])
    return selectedZIndex - hoveredZIndex
  }).toBeGreaterThan(0)
})

test('renders platform-aware desktop chrome', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Chrome Bench')

  const chrome = await appPage.evaluate(() => window.api.platform)
  const titlebarClass = await appPage.getByTestId('project-titlebar').getAttribute('class')
  expect(titlebarClass).not.toBeNull()
  const projectTitlebarClass = titlebarClass ?? ''

  await expect(appPage.getByTestId('window-drag-region')).toHaveCount(chrome.supportsWindowDragRegion ? 1 : 0)
  await expect(appPage.getByTestId('open-import-btn')).toHaveCount(0)
  await expect(appPage.getByTestId('open-templates-btn')).toHaveCount(0)
  await expect(appPage.getByTestId('close-project-btn')).toHaveCount(0)
  expect(projectTitlebarClass).toContain(chrome.reservesTrafficLightSpace ? 'pl-20' : 'pl-4')
  expect(projectTitlebarClass.includes('[-webkit-app-region:drag]')).toBe(chrome.supportsWindowDragRegion)
})

test('opens a dedicated settings window, syncs selected schemes, and saves preferences', async ({ appPage, electronApp }) => {
  await expect(appPage.getByTestId('create-project-btn')).toBeVisible()
  const settingsPage = await openSettingsWindow(electronApp)
  await settingsPage.waitForLoadState('domcontentloaded')

  await expect(settingsPage.getByRole('heading', { name: 'General' })).toBeVisible()
  expect(await settingsPage.getByTestId('light-theme-preference').locator('option').evaluateAll(options => options.map(option => option.value))).toEqual([
    'statekeep-light',
    'statekeep-graphite-light',
  ])
  expect(await settingsPage.getByTestId('dark-theme-preference').locator('option').evaluateAll(options => options.map(option => option.value))).toEqual([
    'statekeep-dark',
    'statekeep-graphite-dark',
  ])

  await settingsPage.getByTestId('theme-preference').selectOption('light')
  await settingsPage.getByTestId('light-theme-preference').selectOption('statekeep-graphite-light')
  await expect(settingsPage.getByRole('status')).toContainText('Appearance updated')
  await expect.poll(() => settingsPage.evaluate(() => document.documentElement.dataset.theme)).toBe('statekeep-graphite-light')
  await expect.poll(() => appPage.evaluate(() => document.documentElement.dataset.theme)).toBe('statekeep-graphite-light')
  await expect.poll(() => appPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-surface-canvas').trim()))
    .toBe('244 246 248')

  await settingsPage.getByTestId('dark-theme-preference').selectOption('statekeep-graphite-dark')
  await settingsPage.getByTestId('theme-preference').selectOption('dark')
  await expect.poll(() => settingsPage.evaluate(() => document.documentElement.dataset.theme)).toBe('statekeep-graphite-dark')
  await expect.poll(() => appPage.evaluate(() => document.documentElement.dataset.theme)).toBe('statekeep-graphite-dark')
  await expect.poll(() => appPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-surface-canvas').trim()))
    .toBe('16 21 27')

  await settingsPage.getByTestId('launch-behavior').selectOption('reopen-last-project')
  await expect(settingsPage.getByRole('status')).toContainText('Saved')

  const preferences = await settingsPage.evaluate(() => window.api.settings.getPreferences())
  expect(preferences).toEqual({
    ok: true,
    data: {
      launchBehavior: 'reopen-last-project',
      appearance: {
        mode: 'dark',
        lightThemeId: 'statekeep-graphite-light',
        darkThemeId: 'statekeep-graphite-dark',
      },
    },
  })
  await settingsPage.evaluate(() => window.api.settings.updatePreferences({
    launchBehavior: 'project-hub',
    appearance: { mode: 'system' },
  }))
  await closeSettingsWindow(settingsPage)
})

test('reopens the last project when that launch behavior is selected', async ({ workspaceDir }) => {
  const userDataDir = join(workspaceDir, 'reopen-last-project-user-data')
  const firstApp = await launchAppWithArgs([], userDataDir)
  const projectDir = join(workspaceDir, 'Reopen Lab')

  try {
    const firstPage = await firstApp.firstWindow()
    await expect(firstPage.getByTestId('create-project-btn')).toBeVisible()
    await createProjectThroughUi(firstPage, firstApp, workspaceDir, 'Reopen Lab')

    const settingsPage = await openSettingsWindow(firstApp)
    await settingsPage.getByTestId('launch-behavior').selectOption('reopen-last-project')
    await expect(settingsPage.getByRole('status')).toContainText('Saved')
    await settingsPage.getByTestId('dark-theme-preference').selectOption('statekeep-graphite-dark')
    await settingsPage.getByTestId('theme-preference').selectOption('dark')
    await expect(settingsPage.getByRole('status')).toContainText('Appearance updated')
    await closeSettingsWindow(settingsPage)
  } finally {
    await firstApp.close()
  }

  const reopenedApp = await launchAppWithArgs([], userDataDir)
  try {
    const reopenedPage = await reopenedApp.firstWindow()
    // firstWindow() can resolve before the renderer's initial navigation
    // commits; a raw evaluate() then fails when that navigation replaces the
    // page. Locator assertions retry across it, so wait for the app first.
    await expect(reopenedPage.getByTestId('project-view')).toBeVisible()
    await expect.poll(() => reopenedPage.evaluate(() => document.documentElement.dataset.theme)).toBe('statekeep-graphite-dark')
    await expect(treeRow(reopenedPage, 'Reopen Lab')).toBeVisible()
    const reopenedProject = await currentProject(reopenedPage)
    expect((reopenedProject as typeof reopenedProject & { path?: string }).path).toBe(projectDir)
  } finally {
    await reopenedApp.close()
  }
})

test('mutes the interface when its native window loses focus', async ({ appPage, electronApp }) => {
  test.skip(process.env['STATEKEEP_E2E_BACKGROUND'] === '1', 'Native focus requires a visible E2E run')
  await expect.poll(() => appPage.evaluate(() => document.documentElement.dataset.windowFocused)).toBe('true')

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.blur()
  })
  await expect.poll(() => appPage.evaluate(() => document.documentElement.dataset.windowFocused)).toBe('false')

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.focus()
  })
  await expect.poll(() => appPage.evaluate(() => document.documentElement.dataset.windowFocused)).toBe('true')
})

test('adds opened projects to native Open Recent and OS recent documents', async ({ appPage, electronApp, workspaceDir }) => {
  await electronApp.evaluate(({ app }) => {
    const state = globalThis as typeof globalThis & { __statekeepRecentDocuments?: string[] }
    state.__statekeepRecentDocuments = []
    app.addRecentDocument = (path: string) => {
      state.__statekeepRecentDocuments?.push(path)
    }
  })

  const projectDir = await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Recent Bench')
  const recentItems = await nativeOpenRecentMenuItems(electronApp)
  const addedDocuments = await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & { __statekeepRecentDocuments?: string[] }
    return state.__statekeepRecentDocuments ?? []
  })

  expect(recentItems[0]).toMatchObject({
    label: 'Recent Bench',
    enabled: true,
    sublabel: projectDir,
  })
  expect(addedDocuments).toContain(join(projectDir, PROJECT_DOCUMENT_FILE))
})

test('opens the most recent project from the project hub', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Welcome Back')

  await closeProjectViaMenu(appPage, electronApp)
  await expect(appPage.getByTestId('reopen-last-project-btn')).toContainText('Welcome Back')

  await appPage.getByTestId('reopen-last-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await expect(treeRow(appPage, 'Welcome Back')).toBeVisible()
  const reopened = await currentProject(appPage)
  expect((reopened as typeof reopened & { path?: string }).path).toBe(projectDir)
})

test('lists recent projects in most-recent-first order on the project hub', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Hub First')
  await closeProjectViaMenu(appPage, electronApp)

  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Hub Second')
  await closeProjectViaMenu(appPage, electronApp)
  const projects = appPage.getByTestId('recent-project-list').getByRole('button')
  await expect(projects.first()).toContainText('Hub Second')
  await expect(projects.filter({ hasText: 'Hub First' })).toHaveCount(1)
})

test('opens an existing project and renders its hierarchy', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = join(workspaceDir, 'Lab Setup')
  await writeFixtureProject(projectDir, 'project-with-nodes.json')

  await openProjectThroughUi(appPage, electronApp, projectDir)

  await expect(treeRow(appPage, 'Rack A')).toBeVisible()
  await treeRow(appPage, 'Rack A').click()
  await expect(appPage.getByTestId('node-name')).toContainText('Rack A')
  await expect(appPage.getByText('4 nodes')).toBeVisible()
})

test('adds, renames, and deletes a node through the tree UI', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Bench CRUD')

  await openContextMenuAction(appPage, 'Bench CRUD', 'Add Child')
  await appPage.getByTestId('add-child-input').fill('Rack A')
  await appPage.getByTestId('add-child-commit').click()
  await expect(treeRow(appPage, 'Rack A')).toBeVisible()

  await openContextMenuAction(appPage, 'Rack A', 'Rename')
  await expect(appPage.getByTestId('name-input')).toBeVisible()
  await appPage.getByTestId('name-input').fill('Rack Alpha')
  await appPage.getByTestId('name-input').press('Enter')
  await expect(treeRow(appPage, 'Rack Alpha')).toBeVisible()

  await openContextMenuAction(appPage, 'Rack Alpha', 'Delete…')
  await expect(treeRow(appPage, 'Rack Alpha')).toHaveCount(0)

  const project = await currentProject(appPage)
  expect(project.nodes).toHaveLength(1)
})

test('reorders siblings and reparents nodes', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = join(workspaceDir, 'Reorder Lab')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, 'Statekeep.statekeep'),
    JSON.stringify({
      version: 2,
      id: '01900000-0000-7000-8000-000000000100',
      name: 'Reorder Lab',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      nodes: [
        {
          id: '01900000-0000-7000-8000-000000000101',
          parentId: null,
          name: 'Reorder Lab',
          order: 0,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: '01900000-0000-7000-8000-000000000102',
          parentId: '01900000-0000-7000-8000-000000000101',
          name: 'Alpha',
          order: 0,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: '01900000-0000-7000-8000-000000000103',
          parentId: '01900000-0000-7000-8000-000000000101',
          name: 'Beta',
          order: 1,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: '01900000-0000-7000-8000-000000000104',
          parentId: '01900000-0000-7000-8000-000000000101',
          name: 'Gamma',
          order: 2,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
      ],
    }, null, 2),
    'utf8'
  )

  await openProjectThroughUi(appPage, electronApp, projectDir)

  await openContextMenuAction(appPage, 'Gamma', 'Move Up ↑')
  let project = await currentProject(appPage)
  const rootId = project.nodes.find((node) => node.parentId === null)?.id
  expect(rootId).toBeTruthy()
  let rootChildren = project.nodes
    .filter((node) => node.parentId === rootId)
    .sort((a, b) => a.order - b.order)
    .map((node) => node.name)
  expect(rootChildren).toEqual(['Alpha', 'Gamma', 'Beta'])

  await openContextMenuAction(appPage, 'Alpha', 'Move To…')
  await appPage.getByTestId('move-search-input').fill('Beta')
  await appPage.getByTestId('move-target').filter({ hasText: 'Beta' }).click()
  await appPage.getByTestId('move-confirm').click()

  project = await currentProject(appPage)
  const alpha = project.nodes.find((node) => node.name === 'Alpha')
  const beta = project.nodes.find((node) => node.name === 'Beta')
  expect(alpha?.parentId).toBe(beta?.id)

  await treeRow(appPage, 'Beta').getByRole('button', { name: 'Expand' }).click()
  await expect(treeRow(appPage, 'Alpha')).toBeVisible()
})

test('searches by property value and focuses the selected node', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = join(workspaceDir, 'Search Lab')
  await writeFixtureProject(projectDir, 'project-with-nodes.json')

  await openProjectThroughUi(appPage, electronApp, projectDir)

  await appPage.getByTestId('search-input').fill('SN-0002')

  await expect(appPage.getByTestId('node-name')).toContainText('Server 2')
  await expect(appPage.getByTestId('search-input')).toHaveValue('SN-0002')
  await expect(appPage.getByTestId('tree')).toBeVisible()
  await expect(appPage.getByTestId('search-results')).toHaveCount(0)
  await expect(appPage.locator('[data-testid="tree-node"][data-row-matched="true"]', { hasText: 'Server 2' })).toBeVisible()
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Server 1' })).toHaveCount(0)
})

test('opens a project passed as a launch argument', async ({ workspaceDir }) => {
  const projectDir = join(workspaceDir, 'Launch Arg Lab')
  await writeFixtureProject(projectDir, 'project-with-nodes.json')

  const launchedApp = await launchAppWithArgs([projectDir], join(workspaceDir, 'launch-argument-user-data'))
  try {
    const page = await launchedApp.firstWindow()
    await expect(page.getByTestId('project-view')).toBeVisible()
    await expect(treeRow(page, 'Rack A')).toBeVisible()
  } finally {
    await launchedApp.close()
  }
})

test('routes a second-instance project argument to the running window', async ({ appPage, electronApp, workspaceDir }) => {
  const firstProjectDir = join(workspaceDir, 'First Lab')
  const secondProjectDir = join(workspaceDir, 'Second Lab')
  await writeFixtureProject(firstProjectDir, 'empty-project.json')
  await writeFixtureProject(secondProjectDir, 'project-with-nodes.json')

  await openProjectThroughUi(appPage, electronApp, firstProjectDir)
  await expect(treeRow(appPage, 'Empty Project')).toBeVisible()

  const electronExecutable = await electronApp.evaluate(() => process.execPath)
  await electronApp.evaluate(({ app }, argv) => {
    app.emit('second-instance', {} as never, argv, process.cwd())
  }, [electronExecutable, MAIN_ENTRY, secondProjectDir])

  await expect(treeRow(appPage, 'Rack A')).toBeVisible()
  const project = await currentProject(appPage)
  expect(project.name).toBe('Lab Setup')
})

test('shows an empty state when search finds no matches', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = join(workspaceDir, 'Search Miss Lab')
  await writeFixtureProject(projectDir, 'project-with-nodes.json')

  await openProjectThroughUi(appPage, electronApp, projectDir)

  await appPage.getByTestId('search-input').fill('does-not-exist')
  await expect(appPage.getByTestId('search-no-results')).toBeVisible()
  await expect(appPage.getByTestId('search-no-results')).toContainText('No matching nodes')
})

test('autosaves edits to disk and reopens them cleanly', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Autosave Lab')
  const payloadPath = join(projectDir, 'Statekeep.statekeep')

  await openContextMenuAction(appPage, 'Autosave Lab', 'Add Child')
  await appPage.getByTestId('add-child-input').fill('Rack A')
  await appPage.getByTestId('add-child-commit').click()
  await expect(treeRow(appPage, 'Rack A')).toBeVisible()

  await appPage.getByTestId('new-prop-key').fill('serial')
  await appPage.getByTestId('new-prop-value').fill('SN-42')
  await appPage.getByTestId('add-prop-btn').click()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-42' })).toBeVisible()

  await expect.poll(() => {
    const saved = JSON.parse(readFileSync(payloadPath, 'utf8')) as PersistedProject
    return saved.nodes.find((node) => node.name === 'Rack A')?.properties.serial ?? null
  }).toBe('SN-42')

  await clickNativeMenuCommand(electronApp, 'project:close')
  await expect(appPage.getByTestId('create-project-btn')).toBeVisible()

  await openProjectThroughUi(appPage, electronApp, projectDir)
  await treeRow(appPage, 'Rack A').click()
  await expect(appPage.getByTestId('node-name')).toContainText('Rack A')
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-42' })).toBeVisible()
})
