import { expect, openFarming, test } from './fixtures'

function progressEntries(label: string) {
  return [
    { id: `${label}-request`, type: 'message', role: 'user', content: [{ type: 'text', text: `${label}: verify the build and tests.` }] },
    { id: `${label}-progress`, type: 'message', role: 'assistant', _meta: { codex: { phase: 'commentary' } },
      content: [{ type: 'text', text: `${label}: build passed; checking test results.` }] },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `${label}-receipt-${i}`, type: 'message', role: 'user', sessionMessage: true,
      content: [{ type: 'text', text: '' }], _meta: { peerMessage: { version: 1, direction: 'incoming',
        senderAddress: i % 2 ? '/root/reviewer' : '/root/tester', bodyUnavailable: 'encrypted', timestamp: '2026-01-01T10:30:00Z' } } })),
    { id: `${label}-tool`, type: 'tool', title: 'Run verification', kind: 'execute', status: 'completed', content: [] },
    { id: `${label}-latest`, type: 'message', role: 'assistant', _meta: { codex: { phase: 'commentary' } },
      content: [{ type: 'text', text: `${label}: all 42 checks passed.` }] },
  ]
}

test('parent and child keep progress readable across unavailable receipts, settlement and reload', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  await openFarming(page)
  const parentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await parentRow.click()
  await page.getByTestId('code-acp-composer-input').fill('related workflow demo')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Review group ready.')
  const envelope = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json()
  envelope.toRevision += 10000
  envelope.replace = true
  envelope.transcript = { ...envelope.transcript, state: 'working', revision: envelope.toRevision, includesLatest: true,
    chatTurn: { status: 'active', turnId: 'parent-turn' }, entries: progressEntries('Parent') }
  await page.route(`**/api/agents/${agentId}/acp-transcript?*`, route => route.fulfill({ json: envelope }))
  await page.route(`**/api/agents/${agentId}/acp-subagents/*/transcript?*`, route => {
    const sessionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!)
    return route.fulfill({ json: { version: 2, protocol: 'acp', provider: 'codex', sessionId, state: 'idle',
      includesLatest: true, nextCursor: null, hasMoreBefore: false,
      entries: [...progressEntries('Child'), { id: 'child-final', type: 'message', role: 'assistant',
        _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: 'Child: verification complete.' }] }] } })
  })
  for (let pass = 0; pass < 2; pass++) {
    await page.reload()
    await parentRow.click()
    await parentRow.hover()
    const disclosure = parentRow.getByTestId('code-agent-row-related-visibility')
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
    const finished = page.getByTestId('code-native-related-finished')
    if (await finished.getAttribute('open') === null) await finished.locator('summary').click()
    await page.getByTestId('code-native-related-row').filter({ hasText: 'Review 0' }).click()
    const panel = page.getByTestId('code-related-session-panel')
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      for (const label of ['Parent', 'Child']) {
        await expect(page.getByText(`${label}: build passed; checking test results.`, { exact: true })).toBeVisible()
        await expect(page.getByText(`${label}: all 42 checks passed.`, { exact: true })).toBeVisible()
      }
      await expect(panel.getByText('Child: verification complete.', { exact: true })).toBeVisible()
      await expect(page.getByTestId('code-agent-transcript-missing-final-reply')).toHaveCount(0)
      const receipts = page.getByTestId('code-agent-peer-receipts')
      await expect(receipts).toHaveCount(2)
      await expect(receipts.first().locator('summary')).toHaveText('8 encrypted messages from Codex')
      await expect(page.locator('.code-agent-transcript-message-unavailable').first()).toBeHidden()
      await panel.getByTestId('code-agent-peer-receipts').locator('summary').focus()
      await panel.getByTestId('code-agent-peer-receipts').locator('summary').press('Enter')
      await expect(panel.locator('.code-agent-transcript-message-unavailable')).toBeVisible()
      await expect(panel.getByTestId('code-agent-peer-receipts').getByText('/root/reviewer', { exact: true })).toHaveCount(4)
      await panel.getByTestId('code-agent-peer-receipts').locator('summary').click()
      const screenshot = await page.screenshot({ path: testInfo.outputPath(`${appearance}-${pass}.png`), animations: 'disabled' })
      expect([screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)]).toEqual([1600, 1000])
    }
  }
  await page.setViewportSize({ width: 760, height: 900 })
  const switcher = page.getByRole('navigation', { name: 'Related sessions' })
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    for (const label of ['Parent', 'Review 0']) {
      await switcher.getByRole('button', { name: label, exact: true }).click()
      await expect(page.getByText(`${label === 'Parent' ? 'Parent' : 'Child'}: all 42 checks passed.`, { exact: true })).toBeVisible()
      const image = await page.screenshot({ path: testInfo.outputPath(`${appearance}-compact-${label}.png`), animations: 'disabled' })
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([760, 900])
    }
  }
})
