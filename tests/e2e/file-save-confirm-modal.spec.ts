import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  PLAYWRIGHT_WORKSPACE_ROOT,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

test('contains file save confirmation focus and restores the close trigger', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'file-save-confirm-modal')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'draft.txt'), 'original\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toHaveCount(1, { timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await files.locator('[data-testid="code-file-row"][data-file-path="draft.txt"]').click()

  const editor = page.getByTestId('code-file-editor')
  await expect(editor.locator('.code-file-monaco')).toBeVisible()
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.insertText('edited ') === true)).toBe(true)
  const activeTab = editor.getByRole('tab', { selected: true })
  await expect(activeTab.locator('.code-file-editor-dirty')).toBeVisible()
  const closeButton = activeTab.getByRole('button', { name: /Close .*draft\.txt/i })
  await activeTab.hover()
  await closeButton.click()

  const modal = page.getByTestId('code-file-save-confirm')
  const dialog = modal.getByRole('dialog')
  const saveButton = dialog.getByRole('button', { name: 'Save', exact: true })
  const cancelButton = dialog.getByRole('button', { name: 'Cancel' })
  await expect(dialog).toBeVisible()
  await expect(cancelButton).toBeFocused()
  await expect(page.locator('#root')).toHaveAttribute('inert', '')

  await page.keyboard.press('Tab')
  await expect(saveButton).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(cancelButton).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(activeTab).toHaveCount(1)
  await expect(activeTab.locator('.code-file-editor-dirty')).toBeVisible()
  await expect(closeButton).toBeFocused()
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '')

  let releaseSave!: () => void
  const saveGate = new Promise<void>(resolve => {
    releaseSave = resolve
  })
  await page.route('**/api/files/file', async route => {
    if (route.request().method() === 'PUT') await saveGate
    await route.continue()
  })
  await activeTab.hover()
  await closeButton.click()
  await expect(cancelButton).toBeFocused()
  const saveResponse = page.waitForResponse(response => (
    new URL(response.url()).pathname.endsWith('/api/files/file')
    && response.request().method() === 'PUT'
    && response.ok()
  ))
  await saveButton.click()
  await expect(dialog.locator('button.primary')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(modal).toBeVisible()
  releaseSave()
  await saveResponse
  await expect(modal).toHaveCount(0)
  await expect(activeTab).toHaveCount(0)
})
