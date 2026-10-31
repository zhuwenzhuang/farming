import { expect, openFarming, test } from './fixtures'

test('agy child registry renders four read-only children with unconfirmed activity', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'agy', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  await openFarming(page)
  const parent = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await parent.locator('.code-agent-name').click()
  await page.getByTestId('code-acp-composer-input').fill('agy registry children')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Four native children discovered.')
  const children = page.getByTestId('code-native-related-row')
  await expect(children).toHaveCount(4)
  for (let index = 0; index < 4; index++) {
    await children.filter({ hasText: `Analyzer ${index}` }).click()
    const panel = page.getByTestId('code-related-session-panel')
    await expect(panel).toContainText(`Analysis result ${index}`)
    await expect(panel.getByTestId('code-acp-subagent-stop')).toHaveCount(0)
    await expect(panel.getByTestId('code-acp-composer-input')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Collapse related session' }).click()
  }
  await page.reload()
  await parent.locator('.code-agent-name').click()
  await expect(children).toHaveCount(4)
  await children.filter({ hasText: 'Analyzer 0' }).click()
  const panel = page.getByTestId('code-related-session-panel')
  await expect(panel).toContainText('Analysis result 0')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await page.evaluate(() => document.fonts.ready)
    await expect(children).toHaveCount(4)
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const capture = await page.screenshot({ path: testInfo.outputPath(`agy-children-${appearance}.png`), animations: 'disabled' })
    expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([1440, 900])
  }
})
