import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('agy native children are visible as collaboration during a mobile live turn', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'agy', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  try {
    await page.request.post('/farming/api/settings', { data: { language: 'en' } })
    await openFarming(page)
    if ((await page.getByTestId('code-workspace').getAttribute('class'))?.includes('sidebar-collapsed')) {
      await page.getByTestId('code-mobile-menu').click()
    }
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"] .code-agent-name`).click()
    await page.getByTestId('code-acp-composer-input').fill('agy registry children live')
    await page.getByTestId('code-acp-composer-send').click()
    const activities = page.getByTestId('code-agent-transcript-collaboration-event')
    await expect(activities).toHaveCount(5)
    const link = page.getByRole('button', { name: 'DeepCoder', exact: true })
    await expect(link).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Worker', exact: true })).toHaveCount(0)
    await expect(page.locator('pre [data-agent-reference]')).toHaveCount(0)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      await page.evaluate(() => document.fonts.ready)
      await expect(activities.filter({ hasText: 'Analyzer 4' })).toBeVisible()
      const collaboration = page.getByTestId('code-agent-transcript-collaboration')
      expect(await collaboration.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const capture = await page.screenshot({ path: testInfo.outputPath(`agy-live-mobile-${appearance}.png`), animations: 'disabled' })
      expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([390, 844])
    }
    await expect(link.locator('.turn-active')).toBeVisible()
    await link.click()
    const panel = page.getByTestId('code-related-session-panel')
    await expect(panel).toContainText('Analysis result 0')
    await expect(panel.locator('.code-agent-transcript-subagent-status')).toHaveText('In progress')
    await expect(panel.getByTestId('code-acp-subagent-stop')).toHaveCount(0)
    await fs.writeFile(path.join(workspaceRoot, '.finish-agy-child'), '')
    await expect(panel.locator('.code-agent-transcript-subagent-status')).toHaveText('Completed')
    await page.getByRole('button', { name: 'Collapse related session' }).click()
    await expect(link).toBeVisible()
    await expect(link.locator('.turn-active')).toHaveCount(0)
    await expect(link).toHaveAttribute('title', /Completed/)
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}`)
  }
})

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
  const link = page.getByRole('button', { name: 'DeepCoder', exact: true })
  await expect(link).toBeVisible()
  await expect(link.locator('.turn-active')).toHaveCount(0)
  await link.click()
  await expect(page.getByTestId('code-related-session-panel')).toContainText('Analysis result 0')
  await page.getByRole('button', { name: 'Collapse related session' }).click()
  const children = page.getByTestId('code-native-related-row')
  await expect(children).toHaveCount(0)
  await expect(parent.getByTestId('code-agent-children-toggle')).toHaveCount(0)
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
    await expect(parent.getByTestId('code-agent-children-toggle')).toHaveCount(0)
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
  await expect(panel).toContainText('Analysis result 0')
  await expect(panel.locator('.code-agent-transcript-subagent-status')).toHaveText('Status unavailable')
  await expect(parent.getByTestId('code-agent-children-toggle')).toHaveCount(0)
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Four native children discovered.')
  available = true
  await page.getByTestId('code-acp-composer-input').fill('agy registry children')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(children.filter({ hasText: 'Analyzer 0' })).toBeVisible()
  await expect(panel).toBeVisible()
})
