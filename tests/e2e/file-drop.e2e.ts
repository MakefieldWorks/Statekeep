import { writeFileSync } from 'fs'
import { join } from 'path'
import { clickNativeMenuCommand, expect, test } from './fixtures'

async function dropFile(page: import('@playwright/test').Page, path: string) {
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'drop-test-input'
    document.body.append(input)
  })
  await page.locator('#drop-test-input').setInputFiles(path)
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#drop-test-input')!
    const transfer = new DataTransfer()
    transfer.items.add(input.files![0]!)
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }))
    input.remove()
  })
}

test('drops a real project file and previews CSV without applying it', async ({ appPage, electronApp, workspaceDir }) => {
  const projectPath = join(workspaceDir, 'Dropped project')
  const created = await appPage.evaluate(async path => window.api.project.create('Dropped project', path), workspaceDir)
  expect(created.ok).toBe(true)
  await appPage.reload()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await clickNativeMenuCommand(electronApp, 'project:close')
  await expect(appPage.getByTestId('open-project-btn')).toBeVisible()
  await dropFile(appPage, join(projectPath, 'Statekeep.statekeep'))
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  const csv = join(workspaceDir, 'inventory.csv')
  writeFileSync(csv, 'name,serial\nNew equipment,DEMO-123\n')
  await dropFile(appPage, csv)
  await expect(appPage.getByRole('dialog', { name: 'Import', exact: true })).toBeVisible()
  await expect(appPage.getByText('inventory.csv', { exact: false }).first()).toBeVisible()
  const current = await appPage.evaluate(() => window.api.project.getCurrent())
  expect(current.ok && current.data?.nodes).toHaveLength(1)
})

test('unsupported drops show a nonblocking message', async ({ appPage, workspaceDir }) => {
  const path = join(workspaceDir, 'unsupported.txt')
  writeFileSync(path, 'hello')
  await dropFile(appPage, path)
  await expect(appPage.getByRole('status')).toContainText('Unsupported file')
  await expect(appPage.getByTestId('create-project-btn')).toBeEnabled()
})
