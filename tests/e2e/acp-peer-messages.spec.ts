import { expect, openFarming, test } from './fixtures'

test('incoming Agent messages use ordinary bubbles and stable attribution in every appearance', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.request.post('/farming/api/settings', { data: { language: 'zh' } })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  await expect(input).toBeEditable()
  await input.fill('peer incoming appearance')
  await page.getByTestId('code-acp-composer-send').click()
  const sources = page.getByTestId('code-agent-message-source')
  await expect(sources).toHaveCount(2)
  await expect(sources.first()).toHaveText('Cleanroom HDFS TPCDS 单机验收与多机接线')
  await expect(page.getByText('已改名的新任务', { exact: true })).toHaveCount(0)
  await expect(page.locator('.code-agent-transcript-message-unavailable')).toHaveText('已收到消息，Codex 未提供可读取的正文。')
  const peerBubble = page.locator('.code-agent-transcript-user').filter({ hasText: '我负责 HDFS' })
  await expect(peerBubble).toHaveCount(1)
  await expect(peerBubble.locator('.code-collaboration-agent-icon')).toBeVisible()
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    await page.evaluate(() => document.fonts.ready)
    await page.mouse.move(1400, 870)
    await expect(peerBubble).toBeVisible()
    expect(await peerBubble.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const screenshot = await page.getByTestId('code-agent-chat-view').screenshot({ path: testInfo.outputPath(`incoming-${appearance}.png`), animations: 'disabled' })
    expect(screenshot.readUInt32BE(16)).toBeGreaterThan(500)
    expect(screenshot.readUInt32BE(20)).toBeGreaterThan(300)
  }
  await page.reload()
  await expect(page.getByTestId('code-agent-message-source')).toHaveCount(2)
  await expect(page.getByTestId('code-agent-message-source').first()).toHaveText('Cleanroom HDFS TPCDS 单机验收与多机接线')
})
