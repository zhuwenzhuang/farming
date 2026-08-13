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

test('renders Markdown files by default and keeps preview, source, and split controls coherent', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1680, height: 900 })
  const workspace = path.join(workspaceRoot, 'file-markdown-preview')
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'docs', 'next document.md'), '# Next document\n')
  fs.writeFileSync(path.join(workspace, 'docs', 'preview image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n')
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
    '[Open next document](next%20document.md)',
    '',
    '![Preview asset](preview%20image.svg)',
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
  await expect.poll(() => preview.getByRole('img', { name: 'Preview asset' }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(8)
  await expect(preview.locator('script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as typeof window & { markdownPreviewUnsafe?: boolean }).markdownPreviewUnsafe)).toBeUndefined()

  const main = page.getByTestId('code-main')
  const agentToggle = editor.getByRole('button', { name: 'Show Agent beside resource' })
  await expect(agentToggle).toBeVisible()
  await agentToggle.click()
  await expect(main).toHaveClass(/resource-agent-side-open/)
  await expect(page.getByTestId('code-agent-terminal-view')).toBeVisible()
  await expect(page.getByTestId('code-terminal-mode-toggle')).toHaveCount(0)
  const agentResizer = page.getByTestId('code-resource-agent-resizer')
  await expect(agentResizer).toBeVisible()
  const editorBox = await editor.boundingBox()
  const agentBox = await page.getByTestId('code-terminal-grid').boundingBox()
  const resizerBox = await agentResizer.boundingBox()
  if (!editorBox || !agentBox || !resizerBox) throw new Error('Resource, divider, and Agent panes must have measurable bounds')
  expect(agentBox.width).toBeGreaterThanOrEqual(360)
  expect(agentBox.width).toBeLessThanOrEqual(480)
  expect(editorBox.width).toBeGreaterThan(agentBox.width)
  expect(Math.abs(editorBox.x + editorBox.width - resizerBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(resizerBox.x + resizerBox.width - agentBox.x)).toBeLessThanOrEqual(1)
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'paper' })
  await expect(main).toHaveCSS('background-color', 'rgb(249, 248, 244)')
  await expect(agentResizer).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await agentResizer.hover()
  await expect(agentResizer).toHaveCSS('background-color', 'rgb(40, 41, 34)')
  await page.mouse.down()
  await page.mouse.move(resizerBox.x - 80, resizerBox.y + (resizerBox.height / 2))
  await page.mouse.up()
  const resizedAgentBox = await page.getByTestId('code-terminal-grid').boundingBox()
  if (!resizedAgentBox) throw new Error('Resized Agent pane must have measurable bounds')
  expect(resizedAgentBox.width).toBeGreaterThan(agentBox.width + 60)
  const mainBox = await main.boundingBox()
  if (!mainBox) throw new Error('Main workspace must have measurable bounds')
  await agentResizer.hover()
  await page.mouse.down()
  await page.mouse.move(mainBox.x, resizerBox.y + (resizerBox.height / 2))
  await page.mouse.up()
  const maximizedAgentBox = await page.getByTestId('code-terminal-grid').boundingBox()
  const narrowedEditorBox = await editor.boundingBox()
  if (!maximizedAgentBox || !narrowedEditorBox) throw new Error('Maximized Agent and resource panes must have measurable bounds')
  expect(maximizedAgentBox.width).toBeGreaterThanOrEqual(798)
  expect(maximizedAgentBox.width).toBeLessThanOrEqual(801)
  expect(narrowedEditorBox.width).toBeGreaterThanOrEqual(320)
  await page.mouse.move(editorBox.x + 20, editorBox.y + 20)
  await expect(agentResizer).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const composerShell = main.locator(':scope > .code-composer-shell')
  const composer = composerShell.locator('.code-composer')
  await expect(composerShell).toHaveCSS('background-color', 'rgb(249, 248, 244)')
  await expect(composer).toHaveCSS('margin-bottom', '12px')
  await expect(composer).toHaveCSS('border-bottom-right-radius', '12px')
  const paperSidePanelScreenshot = testInfo.outputPath('file-terminal-agent-side-panel-paper.png')
  await main.screenshot({ path: paperSidePanelScreenshot })
  await testInfo.attach('file-terminal-agent-side-panel-paper', {
    path: paperSidePanelScreenshot,
    contentType: 'image/png',
  })
  await editor.getByRole('button', { name: 'Hide Agent beside resource' }).click()
  await expect(main).not.toHaveClass(/resource-agent-side-open/)
  await expect(page.getByTestId('code-terminal-grid')).toBeHidden()
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'light' })

  await editor.getByRole('button', { name: 'Show Markdown source' }).click()
  await expect(editor.getByTestId('code-file-markdown-preview')).toHaveCount(0)
  await expect(editor.getByTestId('code-file-monaco')).toBeVisible()

  await editor.getByRole('button', { name: 'Open Markdown preview to side' }).click()
  await expect(editor.getByTestId('code-file-markdown-preview')).toBeVisible()
  await expect(editor.getByTestId('code-file-monaco')).toBeVisible()

  await preview.getByRole('link', { name: 'Open next document' }).click()
  await expect(editor.getByRole('tab', { selected: true })).toContainText('next document.md')
  await expect(editor.getByTestId('code-file-markdown-preview').getByRole('heading', { name: 'Next document' })).toBeVisible()

  await editor.getByRole('button', { name: 'Show Agent beside resource' }).click()
  await expect(main).toHaveClass(/resource-agent-side-open/)
  await page.setViewportSize({ width: 900, height: 800 })
  await expect(editor.getByTestId('code-resource-agent-toggle')).toBeHidden()
  await expect(editor).toBeVisible()
  await expect(page.getByTestId('code-terminal-grid')).toBeHidden()
})

test('reuses the existing Agent Chat beside a file', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1680, height: 900 })
  const workspace = path.join(workspaceRoot, 'file-agent-chat-side-panel')
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Keep the resource visible while chatting.\n')

  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  let transcriptRequests = 0
  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    transcriptRequests += 1
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          sessionId: 'file-agent-chat-side-panel-session',
          state: 'idle',
          revision: 1,
          entries: [
            {
              id: 'file-agent-chat-user',
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'Keep this Chat mounted beside the file.' }],
            },
            {
              id: 'file-agent-chat-answer',
              type: 'message',
              role: 'assistant',
              _meta: { codex: { phase: 'final_answer' } },
              content: [{ type: 'text', text: 'The existing Chat is ready.' }],
            },
          ],
        },
      }),
    })
  })
  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-session(?:\\?includeEntries=0)?$`), async route => {
    await route.fulfill({ json: { session: {
      provider: 'codex',
      sessionId: 'file-agent-chat-side-panel-session',
      state: 'ready',
      error: '',
      stopReason: '',
      availableCommands: [],
      currentModeId: 'full-access',
      modes: {
        currentModeId: 'full-access',
        availableModes: [{ id: 'full-access', name: 'Full access' }],
      },
      configOptions: [
        { id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-5.6-sol', options: [{ value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }] },
        { id: 'reasoning', name: 'Reasoning', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
      ],
      usage: null,
    } } })
  })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('code-terminal-mode-toggle')).toBeVisible()
  await expect(page.getByText('The existing Chat is ready.', { exact: true })).toBeVisible()
  await expect.poll(() => transcriptRequests).toBe(1)
  await page.getByTestId('code-agent-chat-view').evaluate(element => {
    element.setAttribute('data-preserved-chat', 'true')
  })
  await openProjectFile(page, 'file-agent-chat-side-panel', 'notes.txt')
  await expect(page.getByTestId('code-agent-chat-view')).toBeHidden()

  const editor = page.getByTestId('code-file-editor')
  await editor.getByRole('button', { name: 'Show Agent beside resource' }).click()
  await expect(page.getByTestId('code-main')).toHaveClass(/resource-agent-side-open/)
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
  await expect(page.getByTestId('code-terminal-mode-toggle')).toHaveCount(0)
  await expect(page.getByTestId('code-agent-chat-view')).toHaveAttribute('data-preserved-chat', 'true')
  await expect(page.getByText('The existing Chat is ready.', { exact: true })).toBeVisible()
  await expect(page.locator('.code-agent-transcript-state.subtle')).toHaveCount(0)
  expect(transcriptRequests).toBe(1)
  await expect(editor).toBeVisible()
  await expect(page.getByTestId('code-acp-composer-input')).toBeVisible()
  const composerCollapseZone = page.locator('.code-composer-collapse-zone')
  await expect(composerCollapseZone).toBeVisible()
  await composerCollapseZone.hover()
  await page.getByTestId('code-composer-collapse').click()
  await expect(page.getByTestId('code-acp-composer')).toHaveCount(0)
  await page.getByTestId('code-composer-restore').click()
  await expect(page.getByTestId('code-acp-composer-input')).toBeVisible()
  await expect(page.locator('.code-composer-approval-label')).toBeHidden()
  await expect(page.getByTestId('code-acp-mode')).toHaveCSS('width', '34px')
  await expect(page.locator('.code-composer-model-label.desktop')).toBeHidden()
  await expect(page.locator('.code-composer-model-label.mobile')).toBeVisible()
  const main = page.getByTestId('code-main')
  const resizer = page.getByTestId('code-resource-agent-resizer')
  const mainBox = await main.boundingBox()
  const resizerBox = await resizer.boundingBox()
  if (!mainBox || !resizerBox) throw new Error('Agent side-panel resize geometry is unavailable')
  await resizer.hover()
  await page.mouse.down()
  await page.mouse.move(mainBox.x, resizerBox.y + (resizerBox.height / 2))
  await page.mouse.up()
  const transcriptScroll = page.getByTestId('code-agent-transcript-scroll')
  await expect(transcriptScroll).toHaveCSS('padding-left', '12px')
  await expect(transcriptScroll).toHaveCSS('padding-right', '12px')
  const transcriptGeometry = await transcriptScroll.evaluate(element => {
    const scroller = element.getBoundingClientRect()
    const turn = element.querySelector<HTMLElement>('.code-agent-transcript-turn')?.getBoundingClientRect()
    const answer = element.querySelector<HTMLElement>('.code-agent-transcript-answer')?.getBoundingClientRect()
    if (!turn || !answer) throw new Error('Agent side-panel transcript geometry is unavailable')
    return {
      scrollerWidth: scroller.width,
      turnLeftGap: turn.left - scroller.left,
      turnRightGap: scroller.right - turn.right,
      answerLeftGap: answer.left - scroller.left,
      answerRightGap: scroller.right - answer.right,
    }
  })
  expect(transcriptGeometry.scrollerWidth).toBeGreaterThanOrEqual(760)
  expect(transcriptGeometry.turnLeftGap).toBeGreaterThanOrEqual(11)
  expect(transcriptGeometry.turnLeftGap).toBeLessThanOrEqual(13)
  expect(transcriptGeometry.turnRightGap).toBeGreaterThanOrEqual(11)
  expect(transcriptGeometry.turnRightGap).toBeLessThanOrEqual(13)
  expect(transcriptGeometry.answerLeftGap).toBeGreaterThanOrEqual(11)
  expect(transcriptGeometry.answerLeftGap).toBeLessThanOrEqual(13)
  expect(transcriptGeometry.answerRightGap).toBeGreaterThanOrEqual(11)
  expect(transcriptGeometry.answerRightGap).toBeLessThanOrEqual(13)
  const composerToolbarFits = await page.getByTestId('code-acp-composer-toolbar').evaluate(element => (
    element.scrollWidth <= element.clientWidth
  ))
  expect(composerToolbarFits).toBe(true)
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'paper' })
  const composerShell = main.locator(':scope > .code-composer-shell')
  const composer = composerShell.locator('.code-composer')
  await expect(composerShell).toHaveCSS('background-color', 'rgb(249, 248, 244)')
  await expect(composer).toHaveCSS('margin-bottom', '12px')
  await expect(composer).toHaveCSS('border-bottom-right-radius', '12px')
  const paperSidePanelScreenshot = testInfo.outputPath('file-chat-agent-side-panel-paper.png')
  await main.screenshot({ path: paperSidePanelScreenshot })
  await testInfo.attach('file-chat-agent-side-panel-paper', {
    path: paperSidePanelScreenshot,
    contentType: 'image/png',
  })

  await editor.getByRole('button', { name: 'Hide Agent beside resource' }).click()
  await expect(page.getByTestId('code-main')).not.toHaveClass(/resource-agent-side-open/)
  await expect(editor).toBeVisible()
})
