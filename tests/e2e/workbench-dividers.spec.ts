import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('workbench dividers share resting, hover and drag feedback in every appearance', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const workspace = path.join(workspaceRoot, 'divider-review')
  fs.mkdirSync(workspace, { recursive: true })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"] .code-agent-name`).click()
  await page.getByTestId('code-acp-composer-input').fill('Review parser edge cases (demo)')
  await page.getByTestId('code-acp-composer-send').click()
  await page.getByTestId('code-native-related-row').filter({ hasText: 'Parser reviewer' }).click()
  await expect(page.getByTestId('code-related-session-panel')).toContainText('Review complete')
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Parent completed without interruption.')
  const left = page.getByTestId('code-sidebar-resizer')
  const right = page.getByRole('separator', { name: 'Resize related session' })
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await page.mouse.move(0, 0)
    const resting = await left.evaluate(element => getComputedStyle(element).backgroundColor)
    expect(resting).not.toBe('rgba(0, 0, 0, 0)')
    if (appearance === 'paper') expect(resting).toBe('rgb(232, 230, 220)')
    await expect(right).toHaveCSS('background-color', resting)
    await page.screenshot({ path: testInfo.outputPath(`dividers-${appearance}.png`), animations: 'disabled' })
    let hoverColor = ''
    for (const divider of [left, right]) {
      const bounds = await divider.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.width).toBe(1)
      await divider.hover()
      const color = await divider.evaluate(element => getComputedStyle(element).backgroundColor)
      expect(color).not.toBe(resting)
      if (hoverColor) expect(color).toBe(hoverColor)
      hoverColor = color
      const before = Number(await divider.getAttribute('aria-valuenow'))
      await page.mouse.down()
      try {
        await page.mouse.move(bounds!.x + 20, bounds!.y + bounds!.height / 2)
        await expect(divider).toHaveCSS('background-color', hoverColor)
        await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).not.toBe(before)
      } finally {
        await page.mouse.up()
      }
      await page.mouse.move(0, 0)
      await expect(divider).toHaveCSS('background-color', resting)
    }
  }
})
