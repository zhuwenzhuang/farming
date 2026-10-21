import { expect, openFarming, test } from './fixtures'

test('peer messages stay readable with bounded expansion, unknown inputs, send outcomes and replay', async ({ page, workspaceRoot }, testInfo) => {
  await page.request.post('/farming/api/settings', { data: { language: 'zh' } })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  const peerCreated = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(peerCreated.ok()).toBeTruthy()
  const { agentId: peerId } = await peerCreated.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${peerId}"]`).click()
  await page.getByTestId('code-acp-composer-input').fill('image attachment')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Received 0 image.', { exact: true })).toBeVisible()
  const inventory = await (await page.request.get('/farming/api/control/agents')).json() as { agents: Array<{ id: string; providerSessionId?: string }> }
  const peerSessionId = inventory.agents.find(agent => agent.id === peerId)?.providerSessionId
  expect(peerSessionId).toBeTruthy()
  const renamed = await page.request.post(`/farming/api/control/agents/${peerId}/title`, {
    data: { title: 'Cleanroom HDFS TPCDS 单机验收与多机接线' },
  })
  expect(renamed.ok()).toBeTruthy()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await page.getByTestId('code-acp-composer-input').fill(`native peer communication extended peer-session=${peerSessionId}`)
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Peer communication example complete.', { exact: true })).toBeVisible()

  const summary = page.getByTestId('code-agent-transcript-process-summary').last()
  await expect(summary).toHaveAttribute('aria-expanded', 'false')
  await expect(summary).toContainText('5 条 Agent 消息')
  await expect(summary).toHaveAttribute('title', /失败 · 1/)
  await expect(summary).toHaveAttribute('title', /正在发送消息 · 1/)
  await expect(summary.getByTestId('code-agent-outgoing-preview')).toHaveCount(2)
  await expect(summary).toContainText('Cleanroom HDFS TPCDS 单机验收与多机接线')
  await expect(summary.getByTestId('code-agent-outgoing-preview').first()).toHaveText('发给 Cleanroom HDFS TPCDS 单机验收与多机接线: 保持 共享传输配置 不变。')
  await expect(summary).not.toContainText('**')
  await expect(summary).not.toContainText('`')
  await expect(page.getByTestId('code-agent-outgoing-message')).toHaveCount(0)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
      await page.evaluate(() => document.fonts.ready)
      await summary.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const bounds = await summary.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      const screenshot = await page.getByTestId('code-agent-chat-view').screenshot({
        path: testInfo.outputPath(`worked-messages-${width}-${appearance}.png`), animations: 'disabled',
      })
      expect(screenshot.readUInt32BE(16)).toBeGreaterThan(250)
      expect(screenshot.readUInt32BE(20)).toBeGreaterThan(300)
      await summary.screenshot({
        path: testInfo.outputPath(`worked-summary-detail-${width}-${appearance}.png`), animations: 'disabled',
      })
      const preview = summary.getByTestId('code-agent-outgoing-preview').first()
      expect(await preview.evaluate(element => getComputedStyle(element).fontSize)).toBe('13px')
      expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(40)
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(summary).toHaveAttribute('aria-expanded', 'true')
  const messages = page.getByTestId('code-agent-outgoing-message')
  await expect(messages).toHaveCount(5)
  const first = messages.first()
  const firstBody = first.getByTestId('code-agent-outgoing-body')
  await expect(first.getByTestId('code-agent-message-recipient')).toContainText('Cleanroom HDFS TPCDS 单机验收与多机接线')
  await expect(firstBody.locator('strong')).toHaveText('共享传输配置')
  await expect(firstBody.locator('pre code')).toHaveText('farming list --json\n')
  await expect(firstBody).toContainText('验收后同步结果。')
  await expect(messages.nth(1).getByTestId('code-agent-outgoing-body')).toHaveText(await firstBody.innerText(), { useInnerText: true })
  await expect(messages.nth(2).getByRole('status')).toHaveText('失败')
  await expect(messages.nth(4).getByRole('status')).toHaveText('正在发送消息')
  await expect(page.getByTestId('code-agent-message-source')).toHaveCount(0)
  const steer = page.getByTestId('code-agent-transcript-steer')
  await expect(steer).toContainText('来源未由 Provider 提供。')
  await expect(steer.getByTestId('code-agent-transcript-steer-label')).toHaveText('Steer')
  await expect(first.getByTestId('code-agent-transcript-outgoing-time')).toBeVisible()
  await expect(page.getByTestId('code-agent-transcript-collaboration-evidence')).toHaveCount(0)

  // Full body uses the same authoritative detail route as tool evidence.
  // A failed read stays visibly incomplete and can be retried; no send is replayed.
  const long = messages.nth(3)
  const expand = long.getByRole('button', { name: '展开全文' })
  let reads = 0
  await page.route('**/acp-tool-details/peer-send-3', async route => {
    reads += 1
    if (reads === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Simulated unavailable detail"}' })
    else await route.continue()
  })
  await expect(long.getByTestId('code-agent-outgoing-body')).toHaveClass(/collapsed/)
  await expect(long).not.toContainText('FULL_MESSAGE_END')
  await expand.click()
  await expect(long.getByRole('alert')).toHaveText('未能读取完整消息。')
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  await expand.click()
  await expect(long.getByTestId('code-agent-outgoing-body')).toContainText('FULL_MESSAGE_END')
  await expect(long.getByRole('alert')).toHaveCount(0)
  await expect(long.getByTestId('code-agent-outgoing-body')).not.toHaveClass(/collapsed/)
  expect(reads).toBe(2)
  await long.getByRole('button', { name: '收起', exact: true }).click()
  await expand.click()
  expect(reads).toBe(2)
  await long.getByRole('button', { name: '收起', exact: true }).click()

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
      await page.evaluate(() => document.fonts.ready)
      await page.mouse.move(0, 0)
      await first.scrollIntoViewIfNeeded()
      const nameBounds = await first.getByTestId('code-agent-message-recipient').boundingBox()
      const bodyBounds = await firstBody.boundingBox()
      expect(nameBounds!.y + nameBounds!.height).toBeLessThanOrEqual(bodyBounds!.y)
      expect(await firstBody.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const bounds = await first.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      const meta = first.locator('.code-agent-transcript-outgoing-meta')
      expect((await meta.boundingBox())!.y).toBeGreaterThan(bodyBounds!.y + bodyBounds!.height)
      const screenshot = await page.getByTestId('code-agent-chat-view').screenshot({
        path: testInfo.outputPath(`outgoing-${width}-${appearance}.png`), animations: 'disabled',
      })
      expect(screenshot.readUInt32BE(16)).toBeGreaterThan(250)
      expect(screenshot.readUInt32BE(20)).toBeGreaterThan(300)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  await expect(summary).toContainText('5 条 Agent 消息')
  if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
  await expect(messages).toHaveCount(5)
  await expect(messages.nth(2).getByRole('status')).toHaveText('失败')
  await expect(messages.nth(4).getByRole('status')).toHaveText('正在发送消息')
  await expect(page.getByTestId('code-agent-message-source')).toHaveCount(0)
  await expect(long).not.toContainText('FULL_MESSAGE_END')
  await expand.click()
  await expect(long).toContainText('FULL_MESSAGE_END')
  await first.getByTestId('code-agent-outgoing-details').click()
  const evidence = page.getByTestId('code-agent-transcript-collaboration-evidence')
  await expect(evidence).toBeVisible()
  await expect(evidence.getByTestId('code-collaboration-open-details')).toHaveCount(0)
  await expect(page.getByTestId('code-native-related-row')).toHaveCount(0)
})

for (const scenario of ['single', 'single pending']) {
  test(`Worked keeps ${scenario} outgoing message visible without a separate card`, async ({ page, workspaceRoot }, testInfo) => {
    await page.request.post('/farming/api/settings', { data: { language: 'en' } })
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await page.getByTestId('code-acp-composer-input').fill(`native peer communication ${scenario}`)
    await page.getByTestId('code-acp-composer-send').click()
    await expect(page.getByText('Peer communication example complete.', { exact: true })).toBeVisible()
    const summary = page.getByTestId('code-agent-transcript-process-summary')
    await expect(summary).toContainText('1 Agent message')
    await expect(summary).toContainText('shared transport')
    await expect(summary.getByTestId('code-agent-outgoing-preview')).toHaveCount(1)
    if (scenario.includes('pending')) await expect(summary).toHaveAttribute('title', /Sending message · 1/)
    await expect(page.getByTestId('code-agent-outgoing-message')).toHaveCount(0)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      for (const appearance of ['light', 'dark', 'paper']) {
        await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
        await page.evaluate(() => document.fonts.ready)
        await summary.scrollIntoViewIfNeeded()
        expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        await page.getByTestId('code-agent-chat-view').screenshot({
          path: testInfo.outputPath(`worked-${scenario.replace(' ', '-')}-${width}-${appearance}.png`), animations: 'disabled',
        })
      }
    }
    await summary.focus()
    await page.keyboard.press('Space')
    await expect(page.getByTestId('code-agent-outgoing-message')).toHaveCount(1)
    await summary.click()
    await expect(page.getByTestId('code-agent-outgoing-message')).toHaveCount(0)
    await page.reload()
    await expect(summary).toContainText('1 Agent message')
    if (scenario.includes('pending')) await expect(summary).toHaveAttribute('title', /Sending message · 1/)
  })
}
