import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

async function openProjectFile(page: Parameters<typeof openFarming>[0], projectName: string, filePath: string) {
  const project = page.getByTestId('code-project-group').filter({ hasText: projectName })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const segments = filePath.split('/')
  for (let index = 0; index < segments.length - 1; index += 1) {
    const directoryPath = segments.slice(0, index + 1).join('/')
    const directory = files.locator(`[data-testid="code-file-row"][data-file-path="${directoryPath}"]`)
    await expect(directory).toBeVisible()
    if (await directory.getAttribute('aria-expanded') !== 'true') await directory.click()
  }

  const file = files.locator(`[data-testid="code-file-row"][data-file-path="${filePath}"]`)
  await expect(file).toBeVisible()
  await file.dblclick()
}

test('renders Markdown files by default and keeps preview, source, and split controls coherent', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'file-markdown-preview')
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'docs', 'next.md'), '# Next document\n')
  fs.writeFileSync(path.join(workspace, 'docs', 'guide.md'), [
    '---',
    'title: Markdown guide',
    'draft: false',
    '---',
    '',
    '# Farming Preview',
    '',
    '| Column | Value |',
    '| --- | --- |',
    '| Preview | ready |',
    '',
    '$E = mc^2$',
    '',
    '```mermaid',
    'flowchart LR',
    '  Plan --> Build',
    '```',
    '',
    '[Open next document](next.md)',
    '',
    '<script>window.markdownPreviewUnsafe = true</script>',
    '',
  ].join('\n'))

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)
  await openProjectFile(page, 'file-markdown-preview', 'docs/guide.md')

  const editor = page.getByTestId('code-file-editor')
  const preview = editor.getByTestId('code-file-markdown-preview')
  await expect(preview).toBeVisible()
  await expect(preview.getByRole('heading', { name: 'Farming Preview' })).toBeVisible()
  await expect(preview.locator('.code-markdown-frontmatter')).toContainText('Markdown guide')
  await expect(preview.locator('table').nth(1)).toContainText('Preview')
  await expect(preview.locator('.katex')).toBeVisible()
  await expect(preview.locator('.code-markdown-mermaid-canvas > svg')).toBeVisible({ timeout: 20_000 })
  await expect(preview.locator('script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as typeof window & { markdownPreviewUnsafe?: boolean }).markdownPreviewUnsafe)).toBeUndefined()

  const main = page.getByTestId('code-main')
  const agentToggle = editor.getByRole('button', { name: 'Show Agent beside resource' })
  await expect(agentToggle).toBeVisible()
  await agentToggle.click()
  await expect(main).toHaveClass(/resource-agent-side-open/)
  await expect(page.getByTestId('code-agent-terminal-view')).toBeVisible()
  const editorBox = await editor.boundingBox()
  const agentBox = await page.getByTestId('code-terminal-grid').boundingBox()
  if (!editorBox || !agentBox) throw new Error('Resource and Agent panes must have measurable bounds')
  expect(agentBox.width).toBeGreaterThanOrEqual(360)
  expect(agentBox.width).toBeLessThanOrEqual(480)
  expect(editorBox.width).toBeGreaterThan(agentBox.width)
  await editor.getByRole('button', { name: 'Hide Agent beside resource' }).click()
  await expect(main).not.toHaveClass(/resource-agent-side-open/)
  await expect(page.getByTestId('code-terminal-grid')).toBeHidden()

  await editor.getByRole('button', { name: 'Show Markdown source' }).click()
  await expect(editor.getByTestId('code-file-markdown-preview')).toHaveCount(0)
  await expect(editor.getByTestId('code-file-monaco')).toBeVisible()

  await editor.getByRole('button', { name: 'Open Markdown preview to side' }).click()
  await expect(editor.getByTestId('code-file-markdown-preview')).toBeVisible()
  await expect(editor.getByTestId('code-file-monaco')).toBeVisible()

  await preview.getByRole('link', { name: 'Open next document' }).click()
  await expect(editor.getByRole('tab', { selected: true })).toContainText('next.md')
  await expect(editor.getByTestId('code-file-markdown-preview').getByRole('heading', { name: 'Next document' })).toBeVisible()
})

test('reuses the existing Agent Chat beside a file', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'file-agent-chat-side-panel')
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Keep the resource visible while chatting.\n')

  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible({ timeout: 30_000 })
  await openProjectFile(page, 'file-agent-chat-side-panel', 'notes.txt')

  const editor = page.getByTestId('code-file-editor')
  await editor.getByRole('button', { name: 'Show Agent beside resource' }).click()
  await expect(page.getByTestId('code-main')).toHaveClass(/resource-agent-side-open/)
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
  await expect(editor).toBeVisible()
  await expect(page.getByTestId('code-acp-composer-input')).toBeVisible()

  await editor.getByRole('button', { name: 'Hide Agent beside resource' }).click()
  await expect(page.getByTestId('code-main')).not.toHaveClass(/resource-agent-side-open/)
  await expect(editor).toBeVisible()
})
