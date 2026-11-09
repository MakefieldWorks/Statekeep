import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { expect, test } from './fixtures'
import { CURRENT_PROJECT_REF } from '../../src/shared/snapshot-ref'
import { HistoryOperationStore } from '../../src/main/history-operation'

import type { ElectronApplication, Page } from '@playwright/test'

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
): Promise<void> {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill(projectName)

  await setDialogPath(electronApp, parentDir)
  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
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

async function addChildNode(page: Page, parentName: string, childName: string): Promise<void> {
  await openContextMenuAction(page, parentName, 'Add Child')
  await page.getByTestId('add-child-input').fill(childName)
  await page.getByTestId('add-child-commit').click()
  await expect(treeRow(page, childName)).toBeVisible()
}

async function openSnapshotsPanel(page: Page): Promise<void> {
  await page.getByTestId('open-snapshots-btn').click()
  await expect(page.getByTestId('snapshots-panel')).toBeVisible()
}

async function createSnapshot(page: Page, name: string, description?: string): Promise<void> {
  await page.getByTestId('snapshot-name-input').fill(name)
  if (description) await page.getByTestId('snapshot-description-input').fill(description)
  await page.getByTestId('create-snapshot-btn').click()
  await expect(page.getByTestId('snapshot-row').filter({ hasText: name })).toBeVisible()
}

async function compareSnapshots(page: Page, from: string, to: string): Promise<void> {
  await page.getByTestId('compare-from-select').selectOption(from)
  await page.getByTestId('compare-to-select').selectOption(to)
  await expect(page.getByTestId('compare-snapshots-btn')).toBeEnabled()
  await page.getByTestId('compare-snapshots-btn').click()
  await expect(page.getByTestId('snapshot-diff-list')).toBeVisible()
}

test('creates, compares, and reverts snapshots from the renderer surface', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Snapshot UI Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)

  await openSnapshotsPanel(appPage)
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current Project')
  await expect(appPage.getByText('Timeline, checkpoints, and semantic diffs.')).toBeVisible()
  await expect(appPage.getByText('Current State', { exact: true })).toHaveCount(0)
  await expect(treeRow(appPage, projectName)).toBeVisible()

  await createSnapshot(appPage, 'baseline', 'Known-good empty lab before rack installation')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current project matches baseline')
  await expect(appPage.getByTestId('snapshot-timeline-event').filter({ hasText: 'Saved snapshot "baseline"' })).toBeVisible()
  await expect(appPage.getByText('Known-good empty lab before rack installation')).toBeVisible()

  await appPage.getByTestId('snapshot-name-input').fill('baseline')
  await appPage.getByTestId('snapshot-description-input').fill('Preserve this text after a failed save')
  await appPage.getByTestId('create-snapshot-btn').click()
  await expect(appPage.getByTestId('snapshot-error')).toContainText('already exists')
  await expect(appPage.getByTestId('snapshot-name-input')).toHaveValue('baseline')
  await expect(appPage.getByTestId('snapshot-description-input')).toHaveValue('Preserve this text after a failed save')

  await appPage.getByRole('button', { name: 'Close snapshots' }).click()
  await expect(appPage.getByTestId('snapshots-panel')).toHaveCount(0)

  await addChildNode(appPage, projectName, 'Rack A')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')
  await treeRow(appPage, 'Rack A').click()

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'with-rack', 'Rack A installed and ready for review')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current project matches with-rack')
  await expect(appPage.getByTestId('compare-scope-checkbox')).toBeEnabled()
  await appPage.getByTestId('compare-scope-checkbox').check()
  await compareSnapshots(appPage, 'baseline', 'with-rack')

  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Comparing baseline -> with-rack')
  await expect(appPage.getByTestId('compare-scope-label')).toContainText(`${projectName} / Rack A`)
  await expect(appPage.getByText('From: Known-good empty lab before rack installation')).toBeVisible()
  await expect(appPage.getByText('To: Rack A installed and ready for review')).toBeVisible()
  await expect(appPage.getByTestId('snapshot-timeline')).toHaveCount(0)
  await expect(appPage.getByTestId('snapshot-name-input')).toHaveCount(0)
  await expect(appPage.getByTestId('compare-from-select')).toHaveCount(0)
  await expect(appPage.getByTestId('detail-readonly-banner')).toContainText('Snapshots are read-only')
  await expect(appPage.getByTestId('compare-change-group-added')).toBeVisible()
  await expect(appPage.getByTestId('compare-change-group-count-added')).toHaveText('1')
  await expect(appPage.getByTestId('compare-change-group-modified')).toHaveCount(0)
  await expect(appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Added' })).toBeVisible()
  await expect(appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Rack A' })).toBeVisible()
  await expect(treeRow(appPage, 'Rack A')).toBeVisible()
  await expect(appPage.getByTestId('exit-compare-btn')).toBeVisible()

  await appPage.getByTestId('exit-compare-btn').click()
  await expect(appPage.getByTestId('snapshot-diff-list')).toHaveCount(0)
  await expect(appPage.getByTestId('exit-compare-btn')).toHaveCount(0)
  await expect(appPage.getByTestId('snapshot-timeline')).toBeVisible()
  await expect(appPage.getByTestId('compare-from-select')).toBeVisible()
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current project matches with-rack')
  await addChildNode(appPage, projectName, 'Temporary Probe')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')

  await appPage
    .getByRole('button', { name: 'Revert Current Project to This Snapshot: baseline' })
    .click()
  await expect(appPage.getByTestId('revert-dialog')).toBeVisible()
  await appPage.getByTestId('revert-confirm-btn').click()
  await expect(appPage.getByTestId('revert-dialog-error')).toContainText('revert note is required')
  await appPage.getByTestId('revert-note-input').fill('Rolled back to retry the lab test')
  await appPage.getByTestId('revert-confirm-btn').click()
  await expect(appPage.getByTestId('revert-dialog')).toHaveCount(0)

  await expect(appPage.getByTestId('snapshot-diff-list')).toHaveCount(0)
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current project matches baseline')
  await expect(appPage.getByTestId('snapshots-panel')).toBeVisible()
  await expect(appPage.getByTestId('snapshot-timeline-event').filter({ hasText: 'Reverted current project to "baseline"' })).toBeVisible()
  await expect(appPage.getByText('Rolled back to retry the lab test')).toBeVisible()
  await expect(appPage.getByTestId('compare-from-select')).toBeVisible()
  await expect(treeRow(appPage, 'Rack A')).toHaveCount(0)
  await expect(treeRow(appPage, 'Temporary Probe')).toHaveCount(0)

  await appPage
    .getByTestId('snapshot-timeline-event')
    .filter({ hasText: 'Reverted current project to "baseline"' })
    .getByTestId('apply-recovery-btn')
    .click()
  await expect(appPage.getByTestId('recovery-dialog')).toBeVisible()
  await appPage.getByTestId('recovery-confirm-btn').click()
  await expect(appPage.getByTestId('recovery-dialog')).toHaveCount(0)
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')
  await expect(treeRow(appPage, 'Rack A')).toBeVisible()
  await expect(treeRow(appPage, 'Temporary Probe')).toBeVisible()
  await expect(appPage.getByTestId('snapshot-timeline-event').filter({ hasText: 'Recovered current project from a recovery point' })).toBeVisible()
})

test('exports and reviews a portable archive before restoring a separate project folder', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Portable Lab')
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline', 'Archive context')
  await addChildNode(appPage, 'Portable Lab', 'Current rack')
  const archive = join(workspaceDir, 'Portable.statekeeparchive')
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, archive)
  await appPage.getByTestId('open-archives-btn').click()
  const modal = appPage.getByTestId('project-archive-dialog')
  await modal.getByTestId('archive-export').click()
  await expect(modal.getByRole('status')).toContainText('Verified archive saved')
  await setDialogPath(electronApp, archive)
  await modal.getByTestId('archive-review').click()
  await expect(modal.getByTestId('archive-preview')).toContainText('Portable Lab')
  await modal.screenshot({ path: test.info().outputPath('project-archive-preview.png') })
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(readdirSync(workspaceDir).filter(name => name.startsWith('Statekeep-restored-'))).toEqual([])
  await modal.getByTestId('archive-review').click()
  await expect(modal.getByTestId('archive-preview')).toBeVisible()
  await setDialogPath(electronApp, workspaceDir)
  await modal.getByTestId('archive-restore').click()
  await expect(modal.getByRole('status')).toContainText('Verified project restored')
  const restored = readdirSync(workspaceDir).filter(name => name.startsWith('Statekeep-restored-'))
  expect(restored).toHaveLength(1)
  const saved = JSON.parse(readFileSync(join(workspaceDir, restored[0], 'Statekeep.statekeep'), 'utf8'))
  expect(saved.nodes.some((node: { name: string }) => node.name === 'Current rack')).toBe(true)
  const current = await appPage.evaluate(() => window.api.project.getCurrent())
  expect(current.ok && current.data?.path).not.toBe(join(workspaceDir, restored[0]))
  await modal.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(treeRow(appPage, 'Current rack')).toBeVisible()
})

test('reviews unfinished history, preserves evidence on cancel, and explicitly resumes editing', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Interrupted Lab')
  await addChildNode(appPage, 'Interrupted Lab', 'Preserved rack')
  const current = await appPage.evaluate(async () => {
    await window.api.project.save()
    return window.api.project.getCurrent()
  })
  if (!current.ok || !current.data?.path) throw new Error('Missing project')
  const path = current.data.path
  const file = join(path, 'Statekeep.statekeep')
  const store = new HistoryOperationStore(path, current.data.id)
  // Simulate the durable boundary immediately before an interrupted operation.
  store.begin('Create snapshot: interrupted', readFileSync(file, 'utf8'), JSON.stringify({ version: 1, events: [], snapshots: {}, recoveryPoints: [], currentBaseSnapshotId: null, pendingRevertEventId: null }))
  const banner = appPage.getByTestId('interrupted-history')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Review unfinished operation' }).click()
  const modal = appPage.getByTestId('interrupted-history-review')
  await expect(modal).toContainText('Create snapshot: interrupted')
  await modal.screenshot({ path: test.info().outputPath('interrupted-history-review.png') })
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(store.pending()).toBe(true)
  await banner.getByRole('button', { name: 'Review unfinished operation' }).click()
  await modal.getByRole('button', { name: 'Continue with current inventory' }).click()
  await expect(banner).toHaveCount(0)
  expect(store.pending()).toBe(false)
  await expect(treeRow(appPage, 'Preserved rack')).toBeVisible()
  await expect(appPage.getByTestId('project-undo-btn')).toBeDisabled()
  expect(readdirSync(store.recoveryPath).some(name => name.endsWith('-before.document.json'))).toBe(true)
  await addChildNode(appPage, 'Interrupted Lab', 'Resumed rack')
  await expect(treeRow(appPage, 'Resumed rack')).toBeVisible()
})

test('automatically accepts exact evidence that an interrupted snapshot completed', async ({ appPage, electronApp, workspaceDir }) => {
  // Unit tests inject the interrupted finish into real operations. This UI
  // smoke test constructs the equivalent durable record before reopening.
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Completed Interruption Lab')
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'completed')
  const current = await appPage.evaluate(() => window.api.project.getCurrent())
  if (!current.ok || !current.data?.path) throw new Error('Missing project')
  const path = current.data.path
  const document = readFileSync(join(path, 'Statekeep.statekeep'))
  const history = readFileSync(join(path, '.statekeep', 'history.json'))
  const parsedHistory = JSON.parse(history.toString())
  const event = parsedHistory.events.at(-1)
  const store = new HistoryOperationStore(path, current.data.id)
  store.begin('Create snapshot: completed', document.toString(), history.toString(), {
    kind: 'snapshot-create', eventId: event.id, targetId: 'completed',
    expectedDocumentHash: createHash('sha256').update(document).digest('hex'),
  })
  const record = store.candidate().record
  const evidenceFiles = [
    join(store.recoveryPath, `recovery-${record.id}-operation.json`),
    join(store.recoveryPath, record.inventoryFile),
    join(store.recoveryPath, record.historyFile),
  ]
  const reopened = await appPage.evaluate(projectPath => window.api.project.open(projectPath), path)
  expect(reopened.ok).toBe(true)
  await expect(appPage.getByTestId('interrupted-history')).toHaveCount(0)
  expect(store.pending()).toBe(false)
  expect(readdirSync(store.recoveryPath).some(name => name.endsWith('-operation.json'))).toBe(true)
  await appPage.getByTestId('interrupted-evidence-review').click()
  const evidence = appPage.getByTestId('interrupted-evidence-row')
  await expect(evidence).toContainText('Create snapshot: completed')
  await evidence.getByRole('button', { name: 'Review permanent deletion' }).click()
  const confirmation = appPage.getByTestId('interrupted-evidence-confirmation')
  await expect(confirmation).toContainText('cannot be undone')
  await confirmation.screenshot({ path: test.info().outputPath('interrupted-evidence-cleanup.png') })
  await confirmation.getByTestId('interrupted-evidence-delete').click()
  await expect(appPage.getByTestId('interrupted-evidence-cleanup').getByRole('status')).toContainText('Permanently deleted 3 evidence files')
  await expect(evidence).toHaveCount(0)
  expect(evidenceFiles.every(file => !existsSync(file))).toBe(true)
  await appPage.getByRole('button', { name: 'Close snapshots' }).click()
  await addChildNode(appPage, 'Completed Interruption Lab', 'Editing resumed')
  await expect(treeRow(appPage, 'Editing resumed')).toBeVisible()
})

test('reviews an interrupted metadata restore while history is unreadable', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Metadata Interruption Lab')
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')
  const current = await appPage.evaluate(() => window.api.project.getCurrent())
  if (!current.ok || !current.data?.path) throw new Error('Missing project')
  const path = current.data.path
  const document = readFileSync(join(path, 'Statekeep.statekeep'))
  const backup = readFileSync(join(path, '.statekeep', 'history.backup.json'))
  const damaged = Buffer.from('{damaged history')
  writeFileSync(join(path, '.statekeep', 'history.json'), damaged)
  const store = new HistoryOperationStore(path, current.data.id)
  store.beginMetadata('Restore history from automatic backup', document.toString(), damaged, {
    kind: 'history-backup-restore', targetId: 'history.backup.json',
    expectedDocumentHash: createHash('sha256').update(document).digest('hex'),
    expectedHistoryHash: '0'.repeat(64),
  }, backup)

  const reopened = await appPage.evaluate(projectPath => window.api.project.open(projectPath), path)
  expect(reopened.ok).toBe(true)
  const banner = appPage.getByTestId('interrupted-history')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Review unfinished operation' }).click()
  const review = appPage.getByTestId('interrupted-history-review')
  await expect(review).toContainText('keeps the current inventory and history bytes as they are')
  await review.getByRole('button', { name: 'Continue with current inventory' }).click()
  await expect(banner).toHaveCount(0)
  expect(readFileSync(join(path, '.statekeep', 'history.json'))).toEqual(damaged)
  expect(store.pending()).toBe(false)
  const status = await appPage.evaluate(() => window.api.snapshot.historyBackupStatus())
  if (!status.ok || !status.data.available) throw new Error(JSON.stringify(status))
  const restored = await appPage.evaluate(token => window.api.snapshot.restoreHistoryBackup({ token }), status.data.token)
  expect(restored.ok).toBe(true)
})

for (const choice of ['keep-local', 'load-external'] as const) {
  test(`preserves outside edits and resolves through ${choice}`, async ({ appPage, electronApp, workspaceDir }) => {
    await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Conflict Lab')
    await addChildNode(appPage, 'Conflict Lab', 'Local rack')
    const current = await appPage.evaluate(() => window.api.project.getCurrent())
    if (!current.ok || !current.data?.path) throw new Error('Missing project')
    const file = join(current.data.path, 'Statekeep.statekeep')
    const external = JSON.parse(readFileSync(file, 'utf8'))
    external.nodes = external.nodes.filter((node: { parentId: string | null }) => node.parentId === null)
    external.nodes[0].name = 'Outside root'
    const bytes = JSON.stringify(external)
    writeFileSync(file, bytes)
    const banner = appPage.getByTestId('external-document-conflict')
    await expect(banner).toBeVisible({ timeout: 8000 })
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    await banner.getByRole('button', { name: 'Review both versions' }).click()
    const modal = appPage.getByTestId('external-document-review')
    await expect(modal).toContainText('Both available versions will be preserved')
    if (choice === 'keep-local') await modal.screenshot({ path: test.info().outputPath('external-document-review.png') })
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    await banner.getByRole('button', { name: 'Review both versions' }).click()
    await modal.getByTestId(`conflict-${choice}`).click()
    await expect(banner).toHaveCount(0)
    if (choice === 'keep-local') {
      await expect(treeRow(appPage, 'Local rack')).toBeVisible()
      await expect(appPage.getByTestId('project-undo-btn')).toBeEnabled()
    } else {
      await expect(treeRow(appPage, 'Outside root')).toBeVisible()
      await expect(treeRow(appPage, 'Local rack')).toHaveCount(0)
      await expect(appPage.getByTestId('project-undo-btn')).toBeDisabled()
    }
    const recovery = join(current.data.path, '.statekeep', 'recovery')
    const preserved = readdirSync(recovery).map(name => readFileSync(join(recovery, name), 'utf8'))
    expect(preserved.some(content => content === bytes)).toBe(true)
    expect(preserved.some(content => content.includes('Local rack'))).toBe(true)
  })
}

test('top-bar snapshots button toggles panel open and closed', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Snapshots Toggle Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)

  const toggle = appPage.getByTestId('open-snapshots-btn')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(appPage.getByTestId('snapshots-panel')).toHaveCount(0)

  await toggle.click()
  await expect(appPage.getByTestId('snapshots-panel')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await toggle.click()
  await expect(appPage.getByTestId('snapshots-panel')).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('shows preserved history metadata errors and resumes after the file is restored', async ({ appPage, electronApp, workspaceDir }) => {
  const name = 'History Preservation Lab'
  await createProjectThroughUi(appPage, electronApp, workspaceDir, name)
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline', 'Keep this context')
  const project = await appPage.evaluate(() => window.api.project.getCurrent())
  if (!project.ok || !project.data?.path) throw new Error('Project path unavailable')
  const historyPath = join(project.data.path, '.statekeep', 'history.json')
  const original = readFileSync(historyPath, 'utf8')
  const damaged = '{interrupted history write'
  writeFileSync(historyPath, damaged)
  await appPage.getByTestId('refresh-snapshots-btn').click()
  await expect(appPage.getByTestId('snapshot-error')).toContainText('The original file is preserved')
  await expect(appPage.getByTestId('snapshot-error')).toContainText('known-good backup')
  await expect(appPage.getByText('No snapshots yet.', { exact: true })).toHaveCount(0)
  await expect(appPage.getByTestId('snapshot-timeline-event')).toHaveCount(0)
  await appPage.getByTestId('snapshot-name-input').fill('blocked')
  await appPage.getByTestId('create-snapshot-btn').click()
  await expect(appPage.getByTestId('snapshot-error')).toContainText('Snapshot creation, revert, and recovery are blocked')
  expect(readFileSync(historyPath, 'utf8')).toBe(damaged)

  writeFileSync(historyPath, original)
  await appPage.getByTestId('refresh-snapshots-btn').click()
  await expect(appPage.getByTestId('snapshot-error')).toHaveCount(0)
  await expect(appPage.getByText('Keep this context')).toBeVisible()
  await createSnapshot(appPage, 'after-repair')
})

test('reviews and restores an automatic history backup without replacing current inventory', async ({ appPage, electronApp, workspaceDir }) => {
  const name = 'Automatic Backup Lab'
  await createProjectThroughUi(appPage, electronApp, workspaceDir, name)
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline', 'Preserved backup context')
  await addChildNode(appPage, name, 'Unsnapshotted rack')
  const current = await appPage.evaluate(() => window.api.project.getCurrent())
  if (!current.ok || !current.data?.path) throw new Error('Project unavailable')
  const metadataDir = join(current.data.path, '.statekeep')
  const path = join(metadataDir, 'history.json')
  const damaged = '{damaged metadata'
  writeFileSync(path, damaged)
  await appPage.getByTestId('refresh-snapshots-btn').click()
  await appPage.getByTestId('history-backup-review').click()
  const repair = appPage.getByTestId('history-backup-repair')
  await expect(repair).toContainText('Your current inventory and Undo/Redo remain unchanged')
  await repair.screenshot({ path: test.info().outputPath('history-backup-preview.png') })
  await repair.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(readFileSync(path, 'utf8')).toBe(damaged)
  await appPage.getByTestId('history-backup-review').click()
  await appPage.getByTestId('history-backup-confirm').click()
  await expect(appPage.getByTestId('snapshot-error')).toHaveCount(0)
  await expect(appPage.getByText('Preserved backup context')).toBeVisible()
  await expect(treeRow(appPage, 'Unsnapshotted rack')).toBeVisible()
  const preserved = readdirSync(metadataDir).filter(file => file.startsWith('history.json.damaged-'))
  expect(preserved).toHaveLength(1)
  expect(readFileSync(join(metadataDir, preserved[0]), 'utf8')).toBe(damaged)
  await createSnapshot(appPage, 'after-repair')
})

test('reviews an unlisted recovery file, adds it without replacing inventory, and recovers separately', async ({ appPage, electronApp, workspaceDir }) => {
  const name = 'Recovery Files Lab'
  await createProjectThroughUi(appPage, electronApp, workspaceDir, name)
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')
  const current = await appPage.evaluate(() => window.api.project.getCurrent())
  if (!current.ok || !current.data?.path) throw new Error('Project unavailable')
  const directory = join(current.data.path, '.statekeep', 'recovery')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'recovery-unlisted.document.json'), JSON.stringify(current.data))
  await addChildNode(appPage, name, 'Current rack')
  const bytes = readFileSync(join(current.data.path, '.statekeep', 'history.json'))
  const files = appPage.getByTestId('recovery-files')
  await files.getByTestId('recovery-files-review').click()
  await files.getByRole('button', { name: 'Review adding this file' }).click()
  await expect(files.getByTestId('recovery-file-confirmation')).toContainText('No files will be deleted')
  await files.screenshot({ path: test.info().outputPath('recovery-files-preview.png') })
  await files.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(readFileSync(join(current.data.path, '.statekeep', 'history.json'))).toEqual(bytes)
  await files.getByTestId('recovery-files-review').click()
  await files.getByRole('button', { name: 'Review adding this file' }).click()
  await files.getByTestId('recovery-file-add').click()
  await expect(files.getByRole('status')).toContainText('Recovery point added')
  await expect(treeRow(appPage, 'Current rack')).toBeVisible()
  await files.getByTestId('reconciled-recovery-point').getByRole('button', { name: 'Recover', exact: true }).click()
  await expect(appPage.getByTestId('recovery-dialog')).toContainText('Original save time and operation context are unknown')
  await appPage.getByTestId('recovery-confirm-btn').click()
  await expect(treeRow(appPage, 'Current rack')).toHaveCount(0)
  await expect(appPage.getByTestId('recovery-dialog')).toHaveCount(0)
  const added = files.getByTestId('reconciled-recovery-point')
  await added.getByRole('button', { name: 'Remove from list' }).click()
  await added.getByTestId('recovery-file-forget').click()
  await expect(added).toHaveCount(0)
  expect(readFileSync(join(directory, 'recovery-unlisted.document.json'), 'utf8')).toBe(JSON.stringify(current.data))
})

test('surfaces removed nodes in snapshot compare mode', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Removal Compare Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Rack A')
  await addChildNode(appPage, 'Rack A', 'Server 1')
  await addChildNode(appPage, 'Server 1', 'Disk 1')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'with-rack')

  await appPage.getByRole('button', { name: 'Close snapshots' }).click()
  appPage.once('dialog', (dialog) => dialog.accept())
  await openContextMenuAction(appPage, 'Rack A', 'Delete…')
  await expect(treeRow(appPage, 'Rack A')).toHaveCount(0)
  await expect(treeRow(appPage, 'Server 1')).toHaveCount(0)

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'without-rack')
  await compareSnapshots(appPage, 'with-rack', 'without-rack')

  const removedRows = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Removed' })
  const rackRow = removedRows.filter({
    has: appPage.getByText(`${projectName} / Rack A`, { exact: true }),
  })
  await expect(appPage.getByTestId('compare-change-group-removed')).toBeVisible()
  await expect(appPage.getByTestId('compare-change-group-count-removed')).toHaveText('3')
  await expect(appPage.getByTestId('compare-review-focus')).toContainText('1 removal includes 2 descendants')
  await expect(rackRow).toBeVisible()
  await expect(rackRow).toContainText('Rack A')
  await expect(appPage.getByTestId('removed-impact-details')).toHaveCount(1)
  await expect(rackRow.getByTestId('removed-impact-details')).toBeVisible()

  const cascadeFocus = appPage.getByTestId('review-focus-item').filter({ hasText: '1 removal includes 2 descendants' })
  await cascadeFocus.click()
  await expect(cascadeFocus).toHaveAttribute('aria-pressed', 'true')
  await expect(appPage.getByTestId('compare-focus-summary')).toContainText('Showing 3 contributing node rows.')
  await expect(appPage.getByTestId('snapshot-diff-row')).toHaveCount(3)
  await expect(rackRow.getByTestId('removed-impact-details')).toHaveJSProperty('open', true)
  await appPage.getByTestId('compare-focus-clear').click()
  await expect(cascadeFocus).toHaveAttribute('aria-pressed', 'false')

  await rackRow.locator('[data-testid="removed-impact-details"] summary').click()
  await expect(rackRow.getByTestId('removed-impact-descendants')).toContainText('Server 1')
  await expect(rackRow.getByTestId('removed-impact-descendants')).toContainText('Disk 1')

  await rackRow.getByTestId('snapshot-diff-row-header').click()
  await expect(appPage.locator('[data-testid="tree-node"][data-row-status="removed"]', { hasText: 'Rack A' })).toBeVisible()
})

test('surfaces property-only snapshot diffs', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Property Compare Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Rack A')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')

  await treeRow(appPage, 'Rack A').click()
  await appPage.getByTestId('new-prop-key').fill('serial')
  await appPage.getByTestId('new-prop-value').fill('SN-42')
  await appPage.getByTestId('add-prop-btn').click()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-42' })).toBeVisible()

  await createSnapshot(appPage, 'tagged')
  await compareSnapshots(appPage, 'baseline', 'tagged')

  const propertyRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Property Changed' })
  await expect(propertyRow).toBeVisible()
  await expect(propertyRow).toContainText('Rack A')
  await expect(propertyRow.getByTestId('diff-classification-badge')).toHaveText('Data')
  await expect(propertyRow.getByTestId('diff-severity-reason')).toContainText('Medium: field "serial" changed.')
  await expect(propertyRow.getByTestId('diff-classification-why')).toContainText('changes recorded names or property values')
  await expect(propertyRow).toContainText('Added serial: SN-42')
  await expect(appPage.getByTestId('compare-filter-all')).toHaveText('All 1')
  await expect(appPage.getByTestId('compare-filter-medium')).toHaveText('Medium 1')
  await expect(appPage.getByTestId('compare-change-group-modified')).toBeVisible()
  await expect(appPage.getByTestId('compare-change-group-count-modified')).toHaveText('1')
  await expect(appPage.getByTestId('compare-change-group-added')).toHaveCount(0)

  await appPage.getByTestId('compare-filter-high').click()
  await expect(appPage.getByTestId('snapshot-diff-row')).toHaveCount(0)
  await expect(appPage.getByTestId('compare-filter-empty')).toContainText('No high changes')

  await appPage.getByTestId('compare-filter-all').click()
  await expect(propertyRow).toBeVisible()
  await appPage.getByTestId('compare-change-group-toggle-modified').click()
  await expect(propertyRow).toHaveCount(0)
  await appPage.getByTestId('compare-change-group-toggle-modified').click()
  await expect(propertyRow).toBeVisible()

  await propertyRow.click()
  await expect(appPage.locator('[data-testid="tree-node"][data-row-status="property-changed"]', { hasText: 'Rack A' })).toBeVisible()
})

test('surfaces order-only snapshot diffs', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Order Compare Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Alpha')
  await addChildNode(appPage, projectName, 'Beta')
  await addChildNode(appPage, projectName, 'Gamma')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')

  await openContextMenuAction(appPage, 'Gamma', 'Move Up ↑')
  await createSnapshot(appPage, 'reordered')
  await compareSnapshots(appPage, 'baseline', 'reordered')

  const orderRows = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Order Changed' })
  await expect(orderRows).toHaveCount(2)
  await expect(orderRows.filter({ hasText: 'Gamma' })).toBeVisible()
  await expect(orderRows.filter({ hasText: 'Beta' })).toBeVisible()
  await expect(appPage.locator('[data-testid="tree-node"][data-row-status="order-changed"]')).toHaveCount(2)
})

test('surfaces move and rename snapshot diffs for the same node', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Move Rename Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Alpha')
  await addChildNode(appPage, projectName, 'Beta')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')

  await openContextMenuAction(appPage, 'Alpha', 'Rename')
  await appPage.getByTestId('name-input').fill('Alpha Prime')
  await appPage.getByTestId('name-input').press('Enter')
  await expect(treeRow(appPage, 'Alpha Prime')).toBeVisible()

  await openContextMenuAction(appPage, 'Alpha Prime', 'Move To…')
  await appPage.getByTestId('move-target').filter({ hasText: 'Beta' }).click()
  await appPage.getByTestId('move-confirm').click()

  await createSnapshot(appPage, 'migrated')
  await compareSnapshots(appPage, 'baseline', 'migrated')

  const movedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Moved' }).filter({ hasText: 'Alpha Prime' })
  const renamedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Renamed' }).filter({ hasText: 'Alpha Prime' })

  await expect(movedRow).toBeVisible()
  await expect(movedRow.getByTestId('move-parent-before')).toHaveText('Move Rename Lab')
  await expect(movedRow.getByTestId('move-parent-after')).toHaveText('Move Rename Lab / Beta')
  await expect(renamedRow).toBeVisible()
  await expect(appPage.getByTestId('compare-filter-all')).toHaveText('All 3')
  await expect(appPage.getByTestId('compare-filter-high')).toHaveText('High 1')
  await expect(appPage.getByTestId('compare-filter-medium')).toHaveText('Medium 1')
  await expect(appPage.getByTestId('compare-order-document')).toHaveAttribute('aria-pressed', 'true')
  await expect(appPage.getByTestId('compare-order-priority')).toHaveAttribute('aria-pressed', 'false')
  await appPage.getByTestId('compare-order-priority').click()
  await expect(appPage.getByTestId('compare-order-document')).toHaveAttribute('aria-pressed', 'false')
  await expect(appPage.getByTestId('compare-order-priority')).toHaveAttribute('aria-pressed', 'true')

  const highPriorityFocus = appPage.getByTestId('review-focus-item').filter({ hasText: '1 high-priority change' })
  await highPriorityFocus.press('Enter')
  await expect(highPriorityFocus).toHaveAttribute('aria-pressed', 'true')
  await expect(appPage.getByTestId('compare-filter-all')).toHaveAttribute('aria-pressed', 'true')
  await expect(appPage.getByTestId('compare-focus-summary')).toContainText('Showing 1 contributing node row.')
  await expect(movedRow).toBeVisible()
  await expect(renamedRow).toHaveCount(0)
  await appPage.getByTestId('compare-focus-clear').click()
  await expect(highPriorityFocus).toHaveAttribute('aria-pressed', 'false')
  await expect(movedRow).toBeVisible()
  await expect(renamedRow).toBeVisible()

  const priorityRows = await appPage.getByTestId('snapshot-diff-row').evaluateAll(rows =>
    rows.map(row => row.textContent ?? '')
  )
  const movedIndex = priorityRows.findIndex(text => text.includes('Moved'))
  const renamedIndex = priorityRows.findIndex(text => text.includes('Renamed'))
  expect(movedIndex).toBeGreaterThanOrEqual(0)
  expect(renamedIndex).toBeGreaterThanOrEqual(0)
  expect(movedIndex).toBeLessThan(renamedIndex)
  await expect(appPage.getByTestId('compare-change-group-modified')).toBeVisible()
  await expect(appPage.getByTestId('compare-change-group-count-modified')).toHaveText('3')
  await expect(appPage.getByTestId('compare-change-group-added')).toHaveCount(0)

  await appPage.getByTestId('compare-filter-high').click()
  await expect(appPage.getByTestId('compare-order-priority')).toHaveAttribute('aria-pressed', 'true')
  await expect(appPage.getByTestId('compare-filter-summary')).toContainText('Showing 1 of 3 node changes.')
  await expect(appPage.getByTestId('compare-change-group-count-modified')).toHaveText('1 / 3')
  await expect(movedRow).toBeVisible()
  await expect(renamedRow).toHaveCount(0)

  await appPage.getByTestId('compare-filter-medium').click()
  await expect(appPage.getByTestId('compare-change-group-count-modified')).toHaveText('1 / 3')
  await expect(movedRow).toHaveCount(0)
  await expect(renamedRow).toBeVisible()

  await appPage.getByTestId('compare-filter-all').click()
  await expect(movedRow).toBeVisible()
  await expect(renamedRow).toBeVisible()

  await renamedRow.click()
  await expect(appPage.locator('[data-testid="tree-node"][data-row-status="mixed"]', { hasText: 'Alpha Prime' })).toBeVisible()
})

test('keeps compare headings, focus titles, and tree names readable with three panes open', async ({ appPage, electronApp, workspaceDir }, testInfo) => {
  const projectName = 'Pilot Lab With A Deliberately Long Branch Name'
  const longNodeName = 'Device With A Descriptive Name That Needs Two Lines'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline-before-a-long-pilot-comparison')
  await addChildNode(appPage, projectName, longNodeName)
  await addChildNode(appPage, projectName, 'Second Device')
  await addChildNode(appPage, projectName, 'Third Device')
  await createSnapshot(appPage, 'after-a-long-pilot-comparison')
  await compareSnapshots(appPage, 'baseline-before-a-long-pilot-comparison', 'after-a-long-pilot-comparison')

  await expect(appPage.getByRole('heading', { name: 'Comparing baseline-before-a-long-pilot-comparison to after-a-long-pilot-comparison' })).toBeVisible()
  const heading = appPage.getByTestId('compare-heading')
  await expect(heading).toContainText('baseline-before-a-long-pilot-comparison')
  await expect(heading).toContainText('after-a-long-pilot-comparison')
  await expect.poll(() => heading.evaluate(element => element.clientHeight)).toBeGreaterThan(20)

  const focusTitle = appPage.getByTestId('review-focus-title').filter({ hasText: `changes under ${projectName}` })
  await expect(focusTitle).toBeVisible()
  await expect.poll(() => focusTitle.evaluate(element => element.clientHeight)).toBeGreaterThan(16)

  const row = treeRow(appPage, longNodeName)
  await expect(row).toHaveCSS('height', '64px')
  await expect(row).toHaveCSS('overflow', 'hidden')
  const name = row.getByTestId('tree-node-name')
  await expect.poll(() => name.evaluate(element => element.clientHeight)).toBeGreaterThan(16)
  expect(await name.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
  await appPage.screenshot({ path: testInfo.outputPath('readable-three-pane-compare.png') })
})

test('shows the project name when a node moves back to the root', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Root Move Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Beta')
  await addChildNode(appPage, 'Beta', 'Alpha')
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'nested')

  await openContextMenuAction(appPage, 'Alpha', 'Move To…')
  await appPage.getByRole('button', { name: `${projectName} (root)`, exact: true }).click()
  await appPage.getByTestId('move-confirm').click()
  await createSnapshot(appPage, 'at-root')
  await compareSnapshots(appPage, 'nested', 'at-root')

  const movedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Moved' }).filter({ hasText: 'Alpha' })
  await expect(movedRow.getByTestId('move-parent-before')).toHaveText('Root Move Lab / Beta')
  await expect(movedRow.getByTestId('move-parent-after')).toHaveText(projectName)
})

test('compares generated snapshot fixtures without dropping the diff list', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = `${workspaceDir}/generated-compare`

  execFileSync(
    'bun',
    [
      'run',
      'generate:project',
      '--',
      '--output',
      projectDir,
      '--name',
      'Generated Compare Lab',
      '--nodes',
      '180',
      '--depth',
      '5',
      '--branching',
      '4',
      '--snapshots',
      '2',
      '--seed',
      '7',
      '--force',
    ],
    { cwd: process.cwd(), stdio: 'pipe' }
  )

  await openProjectThroughUi(appPage, electronApp, projectDir)
  await openSnapshotsPanel(appPage)
  await compareSnapshots(appPage, 'generated-01', 'generated-02')

  await expect(appPage.getByText('No changes')).toHaveCount(0)
  await expect.poll(async () => appPage.getByTestId('snapshot-diff-row').count()).toBeGreaterThan(0)
  await expect(treeRow(appPage, 'Generated Compare Lab')).toBeVisible()
})

// Issue #3: Ghost rows (removed nodes in compare mode) are selectable and load
// into the DetailPane in read-only "tombstone" mode so the user can inspect
// what the removed node contained.
test('selecting a ghost row shows the tombstone DetailPane (read-only)', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  const projectName = 'Tombstone Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Doomed Rack')

  // Give it a property so we can verify the tombstone view shows it read-only.
  await treeRow(appPage, 'Doomed Rack').click()
  await appPage.getByTestId('new-prop-key').fill('serial')
  await appPage.getByTestId('new-prop-value').fill('SN-99')
  await appPage.getByTestId('add-prop-btn').click()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-99' })).toBeVisible()

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'with-doomed')

  // Delete the node, then create a second snapshot.
  await appPage.getByRole('button', { name: 'Close snapshots' }).click()
  appPage.once('dialog', (dialog) => dialog.accept())
  await openContextMenuAction(appPage, 'Doomed Rack', 'Delete…')
  await expect(treeRow(appPage, 'Doomed Rack')).toHaveCount(0)

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'without-doomed')
  await compareSnapshots(appPage, 'with-doomed', 'without-doomed')

  // Click the diff row to surface and select the ghost.
  const removedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Removed' })
  await expect(removedRow).toBeVisible()
  await removedRow.click()

  // The ghost row is now visible in the tree and is the selected DetailPane target.
  const ghostRow = appPage.locator(
    '[data-testid="tree-node"][data-row-status="removed"][data-row-ghost="true"]',
    { hasText: 'Doomed Rack' },
  )
  await expect(ghostRow).toBeVisible()
  await ghostRow.click()

  // Tombstone banner is shown; the generic read-only banner is NOT.
  await expect(appPage.getByTestId('detail-tombstone-banner')).toBeVisible()
  await expect(appPage.getByTestId('detail-tombstone-banner')).toHaveAttribute(
    'data-ghost-status',
    'removed',
  )
  await expect(appPage.getByTestId('detail-readonly-banner')).toHaveCount(0)

  // The historical property value is rendered so the user can read it.
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-99' })).toBeVisible()

  // No edit controls: Add Property form is suppressed.
  await expect(appPage.getByTestId('add-prop-btn')).toHaveCount(0)
  await expect(appPage.getByTestId('new-prop-key')).toHaveCount(0)
})

test('compares the current project against a snapshot without a throwaway snapshot', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Current Compare Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Rack A')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')

  // Make an unsnapshotted edit, then compare it against the snapshot directly.
  await addChildNode(appPage, projectName, 'Rack B')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')

  // With a single snapshot present the compare picker is reachable (gate is >=1),
  // and "Current project" is offered on BOTH sides.
  await expect(appPage.getByTestId('compare-from-select')).toBeVisible()
  await expect(
    appPage.getByTestId('compare-from-select').locator('option', { hasText: 'Current project' }),
  ).toHaveCount(1)
  await expect(
    appPage.getByTestId('compare-to-select').locator('option', { hasText: 'Current project' }),
  ).toHaveCount(1)

  await compareSnapshots(appPage, 'baseline', CURRENT_PROJECT_REF)
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Comparing baseline -> Current project')

  const addedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Added' })
  await expect(addedRow).toBeVisible()
  await expect(addedRow).toContainText('Rack B')

  await appPage.getByTestId('exit-compare-btn').click()
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')
})
