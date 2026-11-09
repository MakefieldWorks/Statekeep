import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { cpSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from './fixtures'
import { PROJECT_DOCUMENT_FILE } from '../../src/main/project-document-file'
import type { Project } from '../../src/shared/types'

const ROOT_DIR = process.cwd()
const MAIN_ENTRY = join(ROOT_DIR, 'out', 'main', 'index.js')
const dogfoodProjectPath = process.env['STATEKEEP_DOGFOOD_PROJECT']
const packagedExecutable = process.env['STATEKEEP_DOGFOOD_EXECUTABLE']

test.skip(!dogfoodProjectPath, 'Set STATEKEEP_DOGFOOD_PROJECT to run the generated project durability coverage.')

async function firstAppWindow(electronApp: ElectronApplication): Promise<Page> {
  const page = await electronApp.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 30_000 })
  return page
}

test('edits, snapshots, reverts, and reopens the generated dogfood project', async ({ workspaceDir }) => {
  // Includes three real process launches, including on slower Windows runners.
  test.setTimeout(process.platform === 'win32' ? 180_000 : 120_000)
  if (!dogfoodProjectPath) throw new Error('Missing STATEKEEP_DOGFOOD_PROJECT')
  if (!packagedExecutable && !existsSync(MAIN_ENTRY)) throw new Error(`Built Electron entrypoint not found: ${MAIN_ENTRY}`)
  if (packagedExecutable && !existsSync(packagedExecutable)) throw new Error(`Packaged Electron executable not found: ${packagedExecutable}`)
  if (!existsSync(dogfoodProjectPath)) throw new Error(`Dogfood project not found: ${dogfoodProjectPath}`)
  // Keep the supplied pilot project reusable, including its Git and recovery
  // history. All mutations and process restarts operate on a disposable copy.
  const originalBytes = readFileSync(join(dogfoodProjectPath, PROJECT_DOCUMENT_FILE))
  const projectPath = join(workspaceDir, 'pilot-project')
  cpSync(dogfoodProjectPath, projectPath, { recursive: true })
  const documentPath = join(projectPath, PROJECT_DOCUMENT_FILE)
  const readProject = () => JSON.parse(readFileSync(documentPath, 'utf8')) as Project
  const projectDocument = readProject()
  const expectedName = projectDocument.name

  const launch = () => electron.launch({
    timeout: 30_000,
    executablePath: packagedExecutable || undefined,
    args: [
      ...(packagedExecutable ? [] : [MAIN_ENTRY]),
      `--user-data-dir=${join(workspaceDir, 'electron-user-data')}`,
      projectPath,
    ],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      STATEKEEP_EXAMPLE_PROJECTS_DIR: join(workspaceDir, 'example-projects'),
    },
  })

  let electronApp: ElectronApplication | null = null
  let workflowFailed = false
  const restart = async (phase: string): Promise<Page> => {
    console.info(`[dogfood] Closing app before ${phase}`)
    const previousApp = electronApp
    // Clear ownership before closing so a close/relaunch failure cannot cause
    // teardown to close the old handle and mask the original error.
    electronApp = null
    await previousApp?.close()
    console.info(`[dogfood] Launching app for ${phase}`)
    electronApp = await launch()
    return firstAppWindow(electronApp)
  }
  try {
    console.info('[dogfood] Launching pilot project')
    electronApp = await launch()
    let page = await firstAppWindow(electronApp)

    await expect(page.getByTestId('project-titlebar')).toContainText(expectedName)

    const chrome = await page.evaluate(() => window.api.platform)
    const titlebarClass = await page.getByTestId('project-titlebar').getAttribute('class')
    expect(titlebarClass ?? '').toContain(chrome.reservesTrafficLightSpace ? 'pl-20' : 'pl-4')
    await expect(page.getByTestId('window-drag-region')).toHaveCount(chrome.supportsWindowDragRegion ? 1 : 0)

    await page.getByTestId('search-input').fill('active')
    await expect(page.getByTestId('tree-node').first()).toBeVisible()
    await page.getByTestId('search-input').press('Enter')
    await expect(page.getByTestId('node-name').getByRole('heading')).not.toHaveText(expectedName)

    await page.getByTestId('open-snapshots-btn').click()
    await expect(page.getByTestId('snapshots-panel')).toBeVisible()
    await page.getByTestId('compare-from-select').selectOption('generated-01')
    await page.getByTestId('compare-to-select').selectOption('generated-04')
    await expect(page.getByTestId('compare-snapshots-btn')).toBeEnabled()
    await page.getByTestId('compare-snapshots-btn').click()
    await expect(page.getByTestId('snapshot-diff-list')).toBeVisible({ timeout: 10_000 })
    await expect.poll(async () => page.getByTestId('snapshot-diff-row').count()).toBeGreaterThan(0)

    await page.getByTestId('exit-compare-btn').click()
    const saveSnapshot = async (name: string) => {
      await page.getByTestId('snapshot-name-input').fill(name)
      await page.getByTestId('create-snapshot-btn').click()
      await expect(page.getByTestId('snapshot-row').filter({ hasText: name })).toBeVisible()
    }
    await saveSnapshot('dogfood-baseline')
    const baseline = readProject()
    await page.getByRole('button', { name: 'Close snapshots' }).click()
    await page.getByTestId('search-input').fill('')

    const root = baseline.nodes.find(node => node.parentId === null)
    if (!root) throw new Error('Pilot project has no root node')
    const rootRow = page.getByTestId('tree-node').filter({ hasText: root.name }).first()
    await expect(rootRow).toBeVisible()
    await rootRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Add Child', exact: true }).click()
    await page.getByTestId('add-child-input').fill('Dogfood Probe')
    await page.getByTestId('add-child-commit').click()
    await expect(page.getByTestId('node-name').getByRole('heading')).toHaveText('Dogfood Probe')
    await page.getByTestId('node-name').click()
    await page.getByTestId('name-input').fill('Dogfood Probe Renamed')
    await page.getByTestId('name-input').press('Enter')
    await expect(page.getByTestId('node-name').getByRole('heading')).toHaveText('Dogfood Probe Renamed')

    for (const [key, value] of [['serial', 'DOGFOOD-REOPEN-001'], ['status', 'active']]) {
      await page.getByTestId('new-prop-key').fill(key)
      await page.getByTestId('new-prop-value').fill(value)
      await page.getByTestId('add-prop-btn').click()
      await expect(page.getByTestId('prop-value').filter({ hasText: value })).toBeVisible()
    }
    await expect.poll(() => readProject().nodes.find(node => node.name === 'Dogfood Probe Renamed')?.properties, { timeout: 15_000 })
      .toEqual({ serial: 'DOGFOOD-REOPEN-001', status: 'active' })
    const edited = readProject()

    // A fresh process must rebuild search and show the persisted property edits.
    page = await restart('persisted edit verification')
    await page.getByTestId('search-input').fill('DOGFOOD-REOPEN-001')
    await expect(page.getByTestId('node-name').getByRole('heading')).toHaveText('Dogfood Probe Renamed')
    await expect(page.getByTestId('prop-value').filter({ hasText: 'DOGFOOD-REOPEN-001' })).toBeVisible()
    expect(readProject().nodes).toEqual(edited.nodes)
    await page.getByTestId('open-snapshots-btn').click()
    await saveSnapshot('dogfood-edit-pass')
    await page.getByTestId('compare-from-select').selectOption('dogfood-baseline')
    await page.getByTestId('compare-to-select').selectOption('dogfood-edit-pass')
    await page.getByTestId('compare-snapshots-btn').click()
    await expect(page.getByTestId('snapshot-diff-row').filter({ hasText: 'Dogfood Probe Renamed' })).toBeVisible()
    await page.getByTestId('exit-compare-btn').click()

    // Revert must retain the later snapshot and recover unsnapshotted work.
    await page.getByRole('button', { name: 'Close snapshots' }).click()
    await page.getByTestId('node-name').click()
    await page.getByTestId('name-input').fill('Dogfood Unsnapshotted Probe')
    await page.getByTestId('name-input').press('Enter')
    await expect(page.getByTestId('node-name').getByRole('heading')).toHaveText('Dogfood Unsnapshotted Probe')
    // Revert captures safety recovery from in-memory edits, before autosave.
    await page.getByTestId('open-snapshots-btn').click()
    await page.getByRole('button', { name: 'Revert Current Project to This Snapshot: dogfood-baseline', exact: true }).click()
    await page.getByTestId('revert-note-input').fill('Packaged pilot rollback verification')
    await page.getByTestId('revert-confirm-btn').click()
    await expect(page.getByTestId('revert-dialog')).toHaveCount(0)
    await expect(page.getByTestId('project-mode-badge')).toHaveText('Current project matches dogfood-baseline')
    expect(readProject().nodes).toEqual(baseline.nodes)

    page = await restart('revert and recovery verification')
    expect(readProject().nodes).toEqual(baseline.nodes)
    await page.getByTestId('search-input').fill('DOGFOOD-REOPEN-001')
    await expect(page.getByTestId('search-no-results')).toBeVisible()
    await page.getByTestId('search-input').fill('')
    await page.getByTestId('open-snapshots-btn').click()
    await expect(page.getByTestId('snapshot-row').filter({ hasText: 'dogfood-edit-pass' })).toBeVisible()
    const revertEvent = page.getByTestId('snapshot-timeline-event')
      .filter({ hasText: 'Reverted current project to "dogfood-baseline"' })
    await expect(revertEvent).toContainText('Packaged pilot rollback verification')
    await revertEvent.getByTestId('apply-recovery-btn').click()
    await page.getByTestId('recovery-confirm-btn').click()
    await expect(page.getByTestId('recovery-dialog')).toHaveCount(0)
    await page.getByTestId('search-input').fill('DOGFOOD-REOPEN-001')
    await expect(page.getByTestId('node-name').getByRole('heading')).toHaveText('Dogfood Unsnapshotted Probe')
    expect(readProject().nodes.find(node => node.name === 'Dogfood Unsnapshotted Probe')?.properties)
      .toEqual({ serial: 'DOGFOOD-REOPEN-001', status: 'active' })
    expect(readFileSync(join(dogfoodProjectPath, PROJECT_DOCUMENT_FILE))).toEqual(originalBytes)
  } catch (error) {
    workflowFailed = true
    throw error
  } finally {
    if (electronApp) {
      console.info('[dogfood] Closing final app')
      try {
        await electronApp.close()
      } catch (error) {
        if (!workflowFailed) throw error
        console.error('[dogfood] Cleanup failed after workflow failure:', error)
      }
    }
  }
})
