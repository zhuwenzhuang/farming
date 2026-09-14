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

test('balances the default Chat pane with available space and preserves manual sizing', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'responsive-agent-pane')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'ranking.ts'), [
    'export function rankCandidates(scores: number[]) {',
    '  return scores.toSorted((left, right) => right - left)',
    '}',
  ].join('\n'))
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await page.getByTestId('code-acp-composer-input').fill('phase-aware mermaid explain the ranking implementation')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Phase-aware rich answer.', { exact: false })).toBeVisible()
  const files = page.getByTestId('code-project-group').filter({ hasText: 'responsive-agent-pane' }).getByTestId('code-files-section')
  const title = files.locator('.code-files-title').first()
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
  await files.locator('[data-testid="code-file-row"][data-file-path="ranking.ts"]').dblclick()
  const editor = page.getByTestId('code-file-editor')
  await editor.getByTestId('code-resource-agent-toggle').click()
  const main = page.getByTestId('code-main')
  const pane = page.getByTestId('code-terminal-grid')
  const paneWidth = async () => Math.round((await pane.boundingBox())?.width ?? 0)
  await expect(main).toHaveClass(/resource-agent-side-open/)
  await page.evaluate(() => document.fonts.ready)

  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    for (const width of [1100, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(async () => {
        const available = (await main.boundingBox())!.width
        const expected = Math.min(Math.floor((available - 1) / 2), Math.max(480, Math.min(600, Math.round(available * 0.4))))
        return Math.abs(await paneWidth() - expected)
      }).toBeLessThanOrEqual(1)
      expect((await editor.boundingBox())!.width).toBeGreaterThanOrEqual(319)
      expect((await editor.boundingBox())!.width).toBeGreaterThanOrEqual(await paneWidth())
      await expect(page.getByText('Phase-aware rich answer.', { exact: false })).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-input')).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`${appearance}-${width}.png`), animations: 'disabled' })
    }
  }

  const resizer = page.getByTestId('code-resource-agent-resizer')
  await resizer.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(paneWidth).toBe(616)
  await page.setViewportSize({ width: 1100, height: 900 })
  await expect.poll(paneWidth).toBeLessThan(616)
  await page.setViewportSize({ width: 1920, height: 900 })
  await expect.poll(paneWidth).toBe(616)
  await resizer.hover()
  await page.mouse.down()
  await page.mouse.move((await main.boundingBox())!.x + (await main.boundingBox())!.width - 550, 300)
  await page.mouse.up()
  await expect.poll(paneWidth).toBe(550)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(pane).toBeHidden()
  await expect(editor).toBeVisible()
  await page.setViewportSize({ width: 1920, height: 900 })
  await expect.poll(paneWidth).toBe(550)
})
