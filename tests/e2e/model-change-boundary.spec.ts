import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('keeps confirmed model changes between chat turns across reload and appearances', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'model-change-history')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, '.fake-acp-model-matrix'), '')
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  const send = page.getByTestId('code-acp-composer-send')
  const scroll = page.getByTestId('code-agent-transcript-scroll')
  const boundary = page.getByTestId('code-agent-transcript-model-change')
  await input.fill('phase-aware mermaid before changing model')
  await send.click()
  await expect(scroll.getByText('Phase-aware rich answer.', { exact: false })).toBeVisible()
  await page.getByTestId('code-acp-model-picker').click()
  await page.getByTestId('code-model-matrix-cell-luna-high').click()
  await expect(boundary).toHaveCount(1)
  await expect(boundary).toContainText('→ gpt-5.6-luna')
  const label = await boundary.innerText()
  const precedingTurn = await boundary.evaluate(element => element.previousElementSibling?.getAttribute('data-turn-id'))
  expect(precedingTurn).toMatch(/^acp-turn-/)
  await input.fill('image attachment after changing model')
  await send.click()
  await expect(scroll.getByText('Received 0 image.', { exact: true })).toBeVisible()
  await expect.poll(() => boundary.evaluate(element => ({
    before: element.previousElementSibling?.getAttribute('data-turn-id'),
    after: element.nextElementSibling?.textContent,
  }))).toEqual({ before: precedingTurn, after: expect.stringContaining('image attachment after changing model') })
  await page.reload()
  await expect(boundary).toHaveText(label)
  await expect.poll(() => boundary.evaluate(element => element.previousElementSibling?.getAttribute('data-turn-id'))).toBe(precedingTurn)
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await expect(boundary).toBeVisible()
    await expect(boundary).toHaveScreenshot(`model-change-${appearance}.png`)
    await scroll.screenshot({ path: test.info().outputPath(`model-change-context-${appearance}.png`) })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(boundary).toBeVisible()
  expect(await boundary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy()
  await expect(boundary).toHaveScreenshot('model-change-narrow.png')
})
