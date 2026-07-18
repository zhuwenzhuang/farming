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
})
