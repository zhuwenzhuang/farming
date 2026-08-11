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
