import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { clickNativeMenuCommand, expect, fillPropertyKey, test } from './fixtures'

const timestamp = '2026-01-01T00:00:00.000Z'

test('table view sorts, selects columns, preserves node identity, and exports the complete filtered set', async ({
  appPage,
  electronApp,
  workspaceDir,
}, testInfo) => {
  const projectDir = join(workspaceDir, 'Inventory Table Lab')
  mkdirSync(projectDir)
  writeFileSync(join(projectDir, 'Statekeep.statekeep'), JSON.stringify({
    version: 2,
    id: 'table-lab',
    name: 'Inventory Table Lab',
    created: timestamp,
    modified: timestamp,
    templates: { device: { label: 'Device', fields: { firmware: { type: 'version' } } } },
    nodes: [
      { id: 'root', parentId: null, name: 'Inventory Table Lab', order: 0, properties: {}, created: timestamp, modified: timestamp },
      { id: 'rack', parentId: 'root', name: 'Rack', order: 0, properties: {}, created: timestamp, modified: timestamp },
      { id: 'device-10', parentId: 'rack', name: 'Device 10', order: 0, templateId: 'device', properties: { firmware: 'v2.0' }, created: timestamp, modified: timestamp },
      { id: 'device-2', parentId: 'rack', name: 'Device 2', order: 1, templateId: 'device', properties: { firmware: 'v3.2' }, created: timestamp, modified: timestamp },
      { id: 'device-3', parentId: 'rack', name: 'Device 3', order: 2, templateId: 'device', properties: { firmware: 'v3.8' }, created: timestamp, modified: timestamp },
    ],
  }, null, 2), 'utf8')

  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, projectDir)
  await appPage.getByTestId('open-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  await appPage.getByTestId('inventory-filter-toggle').click()
  await fillPropertyKey(appPage, 'firmware')
  await appPage.getByTestId('inventory-filter-property-operator').selectOption('contains')
  await appPage.getByTestId('inventory-filter-property-value').fill('v3')
  await expect(appPage.getByText('Result 1 of 2', { exact: false })).toBeVisible()

  await appPage.getByTestId('inventory-view-table').click()
  await expect(appPage.getByTestId('inventory-table')).toContainText('2 nodes')
  await expect(appPage.getByTestId('inventory-row')).toHaveCount(2)
  await appPage.getByTestId('inventory-column-picker').selectOption('firmware')
  await appPage.getByTestId('inventory-column-add').click()
  await expect(appPage.getByTestId('inventory-table')).toContainText('v3.2')
  await expect(appPage.getByTestId('inventory-table')).toContainText('v3.8')
  await appPage.screenshot({ path: testInfo.outputPath('inventory-table.png') })

  await appPage.getByTestId('inventory-sort-name').click()
  const names = await appPage.getByTestId('inventory-row').evaluateAll(rows => rows.map(row => row.textContent ?? ''))
  expect(names[0]).toContain('Device 3')
  expect(names[1]).toContain('Device 2')

  await appPage.locator('[data-testid="inventory-row"][data-node-id="device-3"]').click()
  await expect(appPage.getByTestId('detail-pane')).toContainText('Device 3')

  const exportPath = join(workspaceDir, 'filtered-inventory.csv')
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, exportPath)
  await appPage.getByTestId('inventory-export-csv').click()
  await expect(appPage.getByText('Exported 2 inventory rows.')).toBeVisible()
  await expect.poll(() => readFileSync(exportPath, 'utf8')).toContain('Device 3')
  const csv = readFileSync(exportPath, 'utf8')
  expect(csv).toContain('Device 2')
  expect(csv).not.toContain('Device 10')

  await electronApp.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined })
  })
  const cancelled = await appPage.evaluate(() => window.api.inventory.exportCsv({
    query: '',
    filters: {},
    columns: ['name'],
    sortColumn: 'name',
    sortDirection: 'asc',
  }))
  expect(cancelled).toEqual({ ok: true, data: { savedPath: null, rowCount: 0 } })

  await appPage.getByTestId('inventory-view-tree').click()
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Device 3' })).toBeVisible()
  await expect(appPage.getByTestId('detail-pane')).toContainText('Device 3')
  await appPage.getByTestId('inventory-view-table').click()
  await expect(appPage.getByTestId('inventory-sort-property:firmware')).toBeVisible()
  await expect(appPage.locator('[data-testid="inventory-row"][data-node-id="device-3"]')).toHaveClass(/bg-sky-50/)
})

test('Add Sibling from Table view switches to Tree view and focuses the add form', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  const projectDir = join(workspaceDir, 'Sibling Table Lab')
  mkdirSync(projectDir)
  writeFileSync(join(projectDir, 'Statekeep.statekeep'), JSON.stringify({
    version: 2,
    id: 'sibling-table-lab',
    name: 'Sibling Table Lab',
    created: timestamp,
    modified: timestamp,
    templates: {},
    nodes: [
      { id: 'root', parentId: null, name: 'Sibling Table Lab', order: 0, properties: {}, created: timestamp, modified: timestamp },
      { id: 'rack', parentId: 'root', name: 'Rack', order: 0, properties: {}, created: timestamp, modified: timestamp },
      { id: 'switch', parentId: 'rack', name: 'Core Switch', order: 0, properties: {}, created: timestamp, modified: timestamp },
    ],
  }, null, 2), 'utf8')

  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, projectDir)
  await appPage.getByTestId('open-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  await appPage.getByTestId('inventory-view-table').click()
  await appPage.locator('[data-testid="inventory-row"][data-node-id="switch"]').click()
  await expect(appPage.getByTestId('detail-pane')).toContainText('Core Switch')

  await clickNativeMenuCommand(electronApp, 'node:addSibling')
  await expect(appPage.getByTestId('inventory-table')).toHaveCount(0)
  await expect(appPage.getByTestId('add-child-input')).toBeFocused()
  await appPage.getByTestId('add-child-input').fill('Access Switch')
  await appPage.getByTestId('add-child-input').press('Enter')
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Access Switch' })).toBeVisible()
})
