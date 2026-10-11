import { expect, openFarming, test } from './fixtures'

test('keeps parent activity visible while child history fails, recovers and pages within a turn', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await page.getByTestId('code-acp-composer-input').fill('related workflow demo')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Review group ready.')
  const envelope = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json()
  const now = Date.now()
  envelope.toRevision += 10000
  envelope.replace = true
  envelope.transcript = {
    ...envelope.transcript, state: 'working', revision: envelope.toRevision, includesLatest: true,
    chatTurn: { status: 'active', turnId: 'parent-turn' },
    entries: [
      { id: 'question', type: 'message', role: 'user', turnStartedAt: now - 30000,
        content: [{ type: 'text', text: 'Inspect parser changes with parallel reviewers.' }] },
      { id: 'verification', type: 'tool', kind: 'execute', title: 'npm test --unit', status: 'completed',
        lastActivityAt: now, content: [], transcriptDetail: '42 checks passed' },
    ],
  }
  await page.route(`**/api/agents/${agentId}/acp-transcript?*`, route => route.fulfill({ json: envelope }))
  let failRead = true
  await page.route(`**/api/agents/${agentId}/acp-subagents/*/transcript?*`, route => {
    if (failRead) return route.fulfill({ status: 409, json: { error: 'Provider history read unavailable. Retry this page.' } })
    const url = new URL(route.request().url())
    const sessionId = decodeURIComponent(url.pathname.split('/').at(-2)!)
    const older = Boolean(url.searchParams.get('cursor'))
    return route.fulfill({ json: {
      version: 2, protocol: 'acp', provider: 'codex', sessionId, state: 'idle',
      includesLatest: !older, nextCursor: older ? null : 'older-item-boundary', hasMoreBefore: !older,
      entries: [
        ...(!older ? Array.from({ length: 30 }, (_, index) => ({
          id: `peer-${index}`, type: 'message', role: 'user',
          content: [{ type: 'text', text: `Peer history message ${index}.` }],
          _meta: { peerMessage: { version: 1, direction: 'incoming', senderAddress: '/root/reviewer' } },
        })) : []),
        { id: older ? 'earlier-output' : 'latest-answer', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: older ? 'Earlier tool output from the same long turn.' : 'Review complete. Latest result remains readable.' }] },
      ],
    } })
  })
  await page.reload()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const recent = page.getByTestId('code-agent-transcript-live-activity')
  await expect(recent).toContainText('Last activity: npm test --unit')
  await expect(recent.getByTestId('code-agent-transcript-live-activity-icon')).toHaveAttribute('data-kind', 'processing')
  await page.getByTestId('code-native-related-finished').locator('summary').click()
  await page.getByTestId('code-native-related-row').filter({ hasText: 'Review 0' }).click()
  const panel = page.getByTestId('code-related-session-panel')
  await expect(panel.getByRole('alert')).toContainText('Transcript read failed:')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await expect(recent).toBeVisible()
    const image = await page.screenshot({ path: testInfo.outputPath(`${appearance}-read-error.png`), animations: 'disabled' })
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([1600, 1000])
  }
  failRead = false
  await panel.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(panel).toContainText('Latest result remains readable.')
  await expect(panel).toContainText('Peer history message 0.')
  await expect(panel).toContainText('Peer history message 29.')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Load earlier messages' }).click()
  await expect(panel).toContainText('Earlier tool output from the same long turn.')
  await expect(panel.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Return to latest' }).click()
  await expect(panel).toContainText('Latest result remains readable.')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await expect(recent).toBeVisible()
    await panel.getByText('Review complete. Latest result remains readable.', { exact: true }).scrollIntoViewIfNeeded()
    await expect(panel.getByText('Review complete. Latest result remains readable.', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${appearance}-recovered.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 760, height: 900 })
  const switcher = page.getByRole('navigation', { name: 'Related sessions' })
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await switcher.getByRole('button', { name: 'Parent', exact: true }).click()
    await expect(recent).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${appearance}-compact-parent.png`), animations: 'disabled' })
    await switcher.getByRole('button', { name: 'Review 0', exact: true }).click()
    await expect(panel).toBeVisible()
    await panel.getByText('Review complete. Latest result remains readable.', { exact: true }).scrollIntoViewIfNeeded()
    await expect(panel.getByText('Review complete. Latest result remains readable.', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${appearance}-compact-child.png`), animations: 'disabled' })
  }
})
