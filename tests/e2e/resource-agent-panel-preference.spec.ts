import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

test('remembers the explicit Agent side-panel choice across eligible files', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'resource-agent-panel-preference')
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'first.txt'), 'first\n')
  fs.writeFileSync(path.join(workspace, 'second.txt'), 'second\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const openFile = async (filePath: string) => {
    await files.locator(`[data-testid="code-file-row"][data-file-path="${filePath}"]`).dblclick()
    await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText(filePath)
  }

  await openFile('first.txt')
  const main = page.getByTestId('code-main')
  const editor = page.getByTestId('code-file-editor')
  const toggle = editor.getByTestId('code-resource-agent-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(main).toHaveClass(/resource-agent-side-open/)

  await editor.getByTestId('code-file-editor-back').click()
  await expect(page.getByTestId('code-agent-terminal-view')).toBeVisible()
  await openFile('second.txt')
  await expect(main).toHaveClass(/resource-agent-side-open/)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await toggle.click()
  await expect(main).not.toHaveClass(/resource-agent-side-open/)
  await editor.getByTestId('code-file-editor-back').click()
  await openFile('first.txt')
  await expect(main).not.toHaveClass(/resource-agent-side-open/)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  await toggle.click()
  await expect(main).toHaveClass(/resource-agent-side-open/)
  await page.reload()
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await expect(main).toHaveClass(/resource-agent-side-open/)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})
