import { clickNativeMenuCommand, expect, test } from './fixtures'

for (const starterId of ['lab', 'network', 'maintenance']) {
  test(`creates and reopens an editable ${starterId} starter`, async ({ appPage, electronApp, workspaceDir }, testInfo) => {
    await appPage.getByTestId('browse-starters-btn').click()
    await appPage.getByTestId('project-starter-select').selectOption(starterId)
    await expect(appPage.getByTestId('starter-preview')).toContainText('Compare baseline')
    if (starterId === 'lab') {
      const screenshot = testInfo.outputPath('starter-selection.png')
      await appPage.screenshot({ path: screenshot })
      await testInfo.attach('Starter selection', { path: screenshot, contentType: 'image/png' })
    }
    await appPage.getByTestId('project-name-input').fill(`My ${starterId}`)
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, workspaceDir)
    await appPage.getByTestId('choose-folder-btn').click()
    await appPage.getByTestId('create-btn').click()
    await expect(appPage.getByTestId('project-view')).toBeVisible()
    const result = await appPage.evaluate(async () => {
      const current = await window.api.project.getCurrent()
      if (!current.ok || !current.data) throw Error('No project')
      const node = current.data.nodes[1]!
      const edited = await window.api.node.update(node.id, { name: 'My custom location' })
      if (!edited.ok) throw Error(edited.error.message)
      const saved = await window.api.snapshot.create('my-edits', 'Edited starter')
      const compared = await window.api.snapshot.compare('baseline', 'my-edits')
      return { saved: saved.ok, changes: compared.ok && compared.data.length > 0 }
    })
    expect(result).toEqual({ saved: true, changes: true })
    await clickNativeMenuCommand(electronApp, 'project:close')
    await expect(appPage.getByTestId('recent-project-list')).toBeVisible()
    await appPage.getByTestId('reopen-last-project-btn').click()
    await expect(appPage.getByTestId('project-view')).toBeVisible()
    const names = await appPage.evaluate(async () => {
      const result = await window.api.project.getCurrent()
      return result.ok ? result.data?.nodes.map(node => node.name) : []
    })
    expect(names).toContain('My custom location')
  })
}
