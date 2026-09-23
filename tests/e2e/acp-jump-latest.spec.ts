import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`jump to latest stays at latest after window resize in ${appearance}`, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'chat-scroll')
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as { sessionId: string; runtimeEpoch: string }
    let historyReads = 0
    await page.route(new RegExp(`/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
      const history = Boolean(new URL(route.request().url()).searchParams.get('cursor'))
      if (history) historyReads += 1
      const entries = [
        { id: history ? 'older-user' : 'latest-user', type: 'message', role: 'user', content: [{ type: 'text', text: history ? 'Earlier question' : 'Latest question' }] },
        { id: history ? 'older-answer' : 'latest-answer', type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: history ? Array.from({ length: 55 }, (_, i) => `Earlier paragraph ${i}.`).join('\n\n') : 'Latest answer.' }] },
      ]
      await route.fulfill({ json: {
        version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
        fromRevision: null, toRevision: 1000000, replace: true, settled: true, hasMoreBefore: true,
        transcript: { sessionId: identity.sessionId, revision: 1000000, state: 'idle', entries,
          nextCursor: history ? 'older-again' : 'older',
          entryPatch: { version: 1, order: entries.map(entry => entry.id), pageCursor: history ? 'older' : null },
        },
      } })
    })
    await page.request.post('/farming/api/settings', { data: { appearance } })
    await page.setViewportSize({ width: 1600, height: 1000 })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(page.getByText('Latest answer.', { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 1100, height: 780 })
    const scroll = page.getByTestId('code-agent-transcript-scroll')
    const jump = page.getByTestId('code-agent-transcript-jump-bottom')
    await scroll.hover()
    await page.mouse.wheel(0, -600)
    await expect.poll(() => historyReads).toBeGreaterThan(0)
    await expect(jump).toBeVisible()
    await jump.click()
    await expect(page.getByText('Latest answer.', { exact: true })).toBeVisible()
    await expect(jump).toHaveCount(0)
    const readsAtLatest = historyReads
    // A resize and its resulting scroll notification must not reopen history.
    await page.setViewportSize({ width: 1000, height: 660 })
    await scroll.dispatchEvent('scroll')
    // Observe beyond the wheel-gesture expiry and queued transcript read.
    await page.waitForTimeout(650)
    await expect(jump).toHaveCount(0)
    expect(historyReads).toBe(readsAtLatest)
    await expect.poll(() => scroll.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1)
  })
}
