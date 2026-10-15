import { encodeProviderSessionKey } from '../../shared/provider-session-identity'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`Chat disclosures expand downward and preserve reading in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as { sessionId: string; runtimeEpoch: string }
    const entries = [
      { id: 'prompt', type: 'message', role: 'user',
        _meta: { farmingHandoff: { version: 1, sourceSessionKey: encodeProviderSessionKey('codex', 'example-source') } },
        content: [{ type: 'text', text: Array.from({ length: 40 }, (_, line) => `Context line ${line}`).join('\n') }] },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `tool-${index}`, type: 'tool', toolCallId: `tool-${index}`, title: `Verify stage ${index}`,
        kind: 'execute', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: Array.from({ length: 40 }, (_, line) => `Stage ${index} output ${line}`).join('\n') } }],
      })),
      { id: 'answer', type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } },
        content: [{ type: 'text', text: 'Workspace checks complete.' }] },
    ]
    await page.route(new RegExp(`/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({ json: {
      version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
      fromRevision: null, toRevision: 1000000, replace: true, settled: true, hasMoreBefore: false,
      transcript: { sessionId: identity.sessionId, revision: 1000000, state: 'idle', entries, hasMoreBefore: false },
    } }))
    await page.request.post('/farming/api/settings', { data: { appearance } })
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const scroll = page.getByTestId('code-agent-transcript-scroll')
    const summary = scroll.getByTestId('code-agent-transcript-process-summary')
    const top = (locator: typeof summary) => locator.evaluate(element => element.getBoundingClientRect().top)
    // Start following latest: expanding a completed Turn must not pull the
    // heading offscreen even when its process list exceeds the viewport.
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    const context = scroll.getByTestId('code-agent-handoff-context')
    const contextSummary = context.locator('summary')
    const contextTop = await top(contextSummary)
    await contextSummary.click()
    await expect(context).toHaveAttribute('open')
    await expect.poll(async () => Math.abs(await top(contextSummary) - contextTop)).toBeLessThan(3)
    await contextSummary.press('Enter')
    await expect(context).not.toHaveAttribute('open')
    // Resume following before testing a React disclosure too.
    await scroll.hover()
    await page.mouse.wheel(0, 5000)
    const before = await top(summary)
    await summary.click()
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => Math.abs(await top(summary) - before)).toBeLessThan(3)
    const group = scroll.getByTestId('code-agent-transcript-process-group-toggle').first()
    await group.click()
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    const item = scroll.getByTestId('code-agent-transcript-process-item-toggle').first()
    await expect(item).toBeVisible()
    const itemTop = await top(item)
    await item.press('Enter')
    await expect(item).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => Math.abs(await top(item) - itemTop)).toBeLessThan(3)
    // A later layout change must not revive bottom following.
    await page.setViewportSize({ width: 1280, height: 760 })
    await expect.poll(async () => Math.abs(await top(item) - itemTop)).toBeLessThan(3)
    const screenshot = await page.screenshot({ path: testInfo.outputPath(`disclosure-${appearance}.png`), animations: 'disabled' })
    expect(screenshot.readUInt32BE(16)).toBe(1280)
    expect(screenshot.readUInt32BE(20)).toBe(760)
    await testInfo.attach(`disclosure-${appearance}`, { body: screenshot, contentType: 'image/png' })
    await item.press(' ')
    await expect(item).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => Math.abs(await top(item) - itemTop)).toBeLessThan(3)
    await summary.click()
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => Math.abs(await top(summary) - before)).toBeLessThan(3)
    await summary.press('Enter')
    await page.getByTestId('code-agent-transcript-jump-bottom').click()
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(3)
  })
}
