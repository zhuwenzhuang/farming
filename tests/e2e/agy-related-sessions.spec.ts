import { expect, openFarming, test } from './fixtures'

test('native children hide unavailable state and recover only from authoritative status', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'agy', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  let available = false
  await page.route(`**/api/agents/${agentId}/related-sessions`, async route => {
    const response = await route.fetch()
    const inventory = await response.json()
    if (available) inventory.children = inventory.children.map((child: { sessionId: string; state: string; readable: boolean }, index: number) => ({
      ...child,
      state: index === 0 ? 'working' : index === 1 ? 'idle' : index === 2 ? 'working' : child.state,
      readable: index === 2 ? false : child.readable,
    }))
    await route.fulfill({ response, json: inventory })
  })
  await page.route(`**/api/agents/${agentId}/acp-subagents/*/transcript?*`, async route => {
    const response = await route.fetch()
    const transcript = await response.json()
    await route.fulfill({ response, json: { ...transcript, state: available ? 'working' : 'unknown' } })
  })
  await openFarming(page)
  const parent = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await parent.locator('.code-agent-name').click()
  await page.getByTestId('code-acp-composer-input').fill('agy registry children')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Four native children discovered.')
  const children = page.getByTestId('code-native-related-row')
  await expect(children).toHaveCount(0)
  await expect(parent.getByTestId('code-agent-row-related-visibility')).toHaveCount(0)
  await page.reload()
  await parent.locator('.code-agent-name').click()
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await page.evaluate(() => document.fonts.ready)
    await expect(children).toHaveCount(0)
    await expect(page.getByText('Status unavailable', { exact: true })).toHaveCount(0)
    await expect(parent.getByTestId('code-agent-row-related-visibility')).toHaveCount(0)
    const capture = await page.screenshot({ path: testInfo.outputPath(`agy-unavailable-hidden-${appearance}.png`), animations: 'disabled' })
    expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([1440, 900])
  }

  // Registry existence is retained by the backend even when the UI hides it.
  const inventory = await page.request.get(`/farming/api/agents/${agentId}/related-sessions`)
  expect((await inventory.json()).children).toHaveLength(4)
  available = true
  await page.reload()
  await parent.locator('.code-agent-name').click()
  const finished = page.getByTestId('code-native-related-finished')
  await expect(finished).toContainText('1')
  await finished.locator('summary').click()
  await expect(children).toHaveCount(2)
  await expect(children.filter({ hasText: 'Analyzer 2' })).toHaveCount(0)
  await expect(children.filter({ hasText: 'Analyzer 3' })).toHaveCount(0)
  await children.filter({ hasText: 'Analyzer 0' }).click()
  const panel = page.getByTestId('code-related-session-panel')
  await expect(panel).toContainText('Analysis result 0')
  await expect(panel.getByTestId('code-acp-subagent-stop')).toHaveCount(0)
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await expect(panel.locator('.code-agent-transcript-subagent-status')).toHaveText('In progress')
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`agy-available-${appearance}.png`), animations: 'disabled' })
  }
  // A fresh parent revision refreshes both inventory and an already open pane.
  available = false
  await page.getByTestId('code-acp-composer-input').fill('agy registry children')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(children).toHaveCount(0)
  await expect(panel).toHaveCount(0)
  await expect(parent.getByTestId('code-agent-row-related-visibility')).toHaveCount(0)
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Four native children discovered.')
  available = true
  await page.getByTestId('code-acp-composer-input').fill('agy registry children')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(children.filter({ hasText: 'Analyzer 0' })).toBeVisible()
  await expect(panel).toHaveCount(0)
})
