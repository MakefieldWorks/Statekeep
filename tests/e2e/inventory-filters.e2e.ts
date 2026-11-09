import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { expect, fillPropertyKey, test } from './fixtures'

const timestamp = '2026-01-01T00:00:00.000Z'

test('filters inventory by template, missing required values, subtree, and property', async ({
  appPage,
  electronApp,
  workspaceDir,
}, testInfo) => {
  const projectDir = join(workspaceDir, 'Filtered Lab')
  mkdirSync(projectDir)
  writeFileSync(join(projectDir, 'Statekeep.statekeep'), JSON.stringify({
    version: 2,
    id: 'filtered-lab',
    name: 'Filtered Lab',
    created: timestamp,
    modified: timestamp,
    templates: {
      device: {
        label: 'Device',
        fields: {
          serial: { type: 'string', required: true },
          firmware: { type: 'version' },
        },
      },
    },
    nodes: [
      { id: 'root', parentId: null, name: 'Filtered Lab', order: 0, properties: {}, created: timestamp, modified: timestamp },
      { id: 'rack-a', parentId: 'root', name: 'Rack A', order: 0, properties: {}, created: timestamp, modified: timestamp },
      { id: 'device-a', parentId: 'rack-a', name: 'Device A', order: 0, templateId: 'device', properties: { firmware: 'v3.2' }, created: timestamp, modified: timestamp },
      { id: 'device-b', parentId: 'rack-a', name: 'Device B', order: 1, templateId: 'device', properties: { serial: 'SN-2', firmware: 'v2.0' }, created: timestamp, modified: timestamp },
      { id: 'rack-b', parentId: 'root', name: 'Rack B', order: 1, properties: {}, created: timestamp, modified: timestamp },
      { id: 'device-c', parentId: 'rack-b', name: 'Device C', order: 0, templateId: 'device', properties: { serial: 'SN-3', firmware: 'v3.8' }, created: timestamp, modified: timestamp },
    ],
  }, null, 2), 'utf8')

  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, projectDir)
  await appPage.getByTestId('open-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  await appPage.getByTestId('inventory-filter-toggle').click()
  await appPage.getByTestId('inventory-filter-template').selectOption('device')
  await expect(appPage.getByText('Result 1 of 3', { exact: false })).toBeVisible()

  await appPage.getByTestId('inventory-filter-missing-required').check()
  await expect(appPage.getByText('Result 1 of 1', { exact: false })).toBeVisible()
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Device A' })).toBeVisible()
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Device B' })).toHaveCount(0)

  await appPage.getByTestId('inventory-filter-clear').click()
  await appPage.locator('[data-testid="tree-node"]', { hasText: 'Rack A' }).click()
  await appPage.getByTestId('inventory-filter-use-selection').click()
  await expect(appPage.getByText('Result 1 of 3', { exact: false })).toBeVisible()
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Rack B' })).toHaveCount(0)
  await appPage.locator('[data-testid="tree-node"]', { hasText: 'Device A' }).click()
  await expect(appPage.getByTestId('inventory-filter-panel')).toContainText('Rack A')
  await expect(appPage.getByText('Result 1 of 3', { exact: false })).toBeVisible()

  await appPage.getByRole('button', { name: 'Entire project' }).click()
  await expect(appPage.locator('#inventory-property-keys option[value="firmware"]')).toHaveCount(1)
  await fillPropertyKey(appPage, 'firmware')
  await appPage.getByTestId('inventory-filter-property-operator').selectOption('contains')
  await expect(appPage.getByTestId('inventory-filter-toggle')).toHaveText('Filter')
  await appPage.getByTestId('inventory-filter-property-value').fill('v3')
  await expect(appPage.getByText('Result 1 of 2', { exact: false })).toBeVisible()
  await expect(appPage.locator('[data-testid="tree-node"][data-row-matched="true"]')).toHaveCount(2)
  await appPage.screenshot({ path: testInfo.outputPath('inventory-filters.png') })

  await appPage.getByTestId('search-input').fill('Device C')
  await expect(appPage.getByText('Result 1 of 1', { exact: false })).toBeVisible()
  await expect(appPage.getByTestId('detail-pane')).toContainText('Device C')

  await appPage.getByTestId('inventory-filter-clear').click()
  await expect(appPage.getByTestId('search-input')).toHaveValue('Device C')
  await expect(appPage.getByText('Result 1 of 1', { exact: false })).toBeVisible()

  await appPage.getByTestId('inventory-filter-template').selectOption('device')
  await expect(appPage.getByTestId('inventory-filter-toggle')).toHaveText('Filter 1')
  await appPage.getByTestId('search-input').press('Escape')
  await expect(appPage.getByTestId('search-input')).toHaveValue('')
  await expect(appPage.getByTestId('inventory-filter-toggle')).toHaveText('Filter')
  await expect(appPage.getByTestId('inventory-filter-panel')).toHaveCount(0)
})
