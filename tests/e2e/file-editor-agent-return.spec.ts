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

test('keeps the source Agent return action across Markdown document links', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'markdown-agent-return')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# First\n\n[Next document](next.md)\n')
  fs.writeFileSync(path.join(workspaceRoot, 'next.md'), '# Next\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toHaveCount(1, { timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')

  await files.locator('[data-testid="code-file-row"][data-file-path="README.md"]').click()
  await expect(page.getByTestId('code-file-markdown-preview')).toBeVisible()
  await expect(page.getByTestId('code-file-editor-back')).toBeVisible()

  await page.getByRole('link', { name: 'Next document' }).click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('next.md')
  await expect(page.getByTestId('code-file-editor-back')).toBeVisible()

  await page.getByTestId('code-file-editor-back').click()
  await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
  const selectedFileRow = files.locator('[data-testid="code-file-row"][data-file-path="next.md"]')
  await expect(selectedFileRow).not.toHaveClass(/active/)
  await expect.poll(() => selectedFileRow.evaluate(row => (
    getComputedStyle(row.closest('.code-file-tree-row-frame') as HTMLElement).backgroundColor
  ))).toBe('rgba(0, 0, 0, 0)')
})

test('keeps one Explorer selection surface when a directory replaces an open file selection', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'file-directory-selection-owner')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(path.join(workspaceRoot, 'folder'), { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# Selection owner\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const fileRow = files.locator('[data-testid="code-file-row"][data-file-path="README.md"]')
  const directoryRow = files.locator('[data-testid="code-file-row"][data-file-path="folder"]')
  await fileRow.click()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expect(fileRow).toHaveClass(/active/)

  await directoryRow.click()
  await expect(directoryRow).toHaveClass(/selected/)
  await expect(fileRow).not.toHaveClass(/active/)
  await expect.poll(() => fileRow.evaluate(row => (
    getComputedStyle(row.closest('.code-file-tree-row-frame') as HTMLElement).backgroundColor
  ))).toBe('rgba(0, 0, 0, 0)')
  await expect.poll(() => directoryRow.evaluate(row => (
    getComputedStyle(row.closest('.code-file-tree-row-frame') as HTMLElement).backgroundColor
  ))).not.toBe('rgba(0, 0, 0, 0)')
})

test('keeps file editing available when a local preview render fails and recovers', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'file-preview-error-boundary')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# Preview boundary\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await files.locator('[data-testid="code-file-row"][data-file-path="README.md"]').click()

  const editor = page.getByTestId('code-file-editor')
  const sourceToggle = editor.locator('.code-file-editor-action.source-preview')
  await expect(editor.getByTestId('code-file-markdown-preview')).toBeVisible()
  await sourceToggle.click()
  await expect(editor.getByTestId('code-file-monaco')).toBeVisible()
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.insertText('\nRetry keeps this draft.') === true)).toBe(true)

  await page.evaluate(() => {
    window.__farmingLocalRenderFaults = ['file-preview']
  })
  await sourceToggle.click()
  const previewError = editor.getByTestId('code-file-preview-render-error')
  await expect(previewError).toBeVisible()
  await expect(editor.getByRole('tab', { selected: true })).toContainText('README.md')
  await expect(editor.locator('.code-file-editor-dirty')).toBeVisible()
  await expect(page.getByTestId('app-error-fallback')).toHaveCount(0)

  await page.evaluate(() => {
    window.__farmingLocalRenderFaults = []
  })
  await previewError.getByRole('button', { name: 'Retry' }).click()
  await expect(editor.getByTestId('code-file-markdown-preview')).toContainText('Retry keeps this draft.')

  await page.evaluate(() => {
    window.__farmingLocalRenderFaults = ['file-markdown']
  })
  await editor.locator('.code-file-editor-action.markdown-split').click()
  const markdownError = editor.getByTestId('code-file-markdown-render-error')
  await expect(markdownError).toBeVisible()
  await expect(editor.getByTestId('code-file-monaco')).toBeVisible()

  await page.evaluate(() => {
    window.__farmingLocalRenderFaults = []
  })
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.insertText('\nReset key recovered.') === true)).toBe(true)
  await expect(markdownError).toHaveCount(0)
  await expect(editor.getByTestId('code-file-markdown-preview')).toContainText('Reset key recovered.')
  await expect(editor.locator('.code-file-editor-dirty')).toBeVisible()
  await expect(page.getByTestId('app-error-fallback')).toHaveCount(0)
})
