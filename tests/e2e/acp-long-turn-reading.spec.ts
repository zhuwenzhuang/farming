import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`long Turn reading survives paging, reload and sending in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    test.setTimeout(120_000)
    const workspace = path.join(workspaceRoot, 'long-chat')
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as { sessionId: string; runtimeEpoch: string }
    const prompt = { id: 'prompt', type: 'message', role: 'user', turnStartedAt: Date.now() - 5_476_000, turnDurationMs: 5476000,
      content: [{ type: 'text', text: 'Inspect the workspace and validate each stage.' }] }
    const entries = Array.from({ length: 2304 }, (_, index) => index % 256 === 180
      ? { id: `entry-${index}`, type: 'message', role: 'user', _meta: { farming: { steer: true } },
        content: [{ type: 'text', text: 'Also check recovery before proceeding.' }] }
      : index % 32 === 0 || index % 256 === 100
      ? { id: `entry-${index}`, type: 'message', role: 'assistant',
        _meta: { codex: { phase: index % 256 === 100 ? 'final_answer' : 'commentary' } },
        content: [{ type: 'text', text: `Stage ${index}: validated the current changes and recorded the next verification step.\n\nThe session continues with the remaining checks.` }] }
      : { id: `entry-${index}`, type: 'tool', toolCallId: `tool-${index}`, title: `Read example ${index}`, kind: 'read', status: 'completed' })
    let historyReads = 0
    let latestReads = 0
    await page.route(new RegExp(`/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor')
      const start = cursor ? Number(cursor) - 256 : 2048
      if (cursor) historyReads += 1
      else latestReads += 1
      const batch = [prompt, ...entries.slice(start, start + 256)]
      await route.fulfill({ json: {
        version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
        fromRevision: null, toRevision: 1000000, replace: true, settled: true, hasMoreBefore: start > 0,
        transcript: { sessionId: identity.sessionId, revision: 1000000, state: 'working', entries: batch,
          hasMoreBefore: start > 0,
          nextCursor: start > 0 ? String(start) : null,
          entryPatch: { version: 1, order: batch.map(entry => entry.id), startId: `entry-${start}`, pageCursor: cursor },
        },
      } })
    })
    await page.request.post('/farming/api/settings', { data: { appearance } })
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const scroll = page.getByTestId('code-agent-transcript-scroll')
    const summary = scroll.getByTestId('code-agent-transcript-process-summary')
    await expect(scroll.locator('[data-progress-id="acp-progress-entry-2048"]')).toBeAttached()

    // Place an actual progress paragraph across the viewport's top, within
    // the history threshold. Its position must survive a same-Turn prepend.
    const anchor = scroll.locator('[data-progress-id="acp-progress-entry-2048"]')
    await scroll.evaluate(element => { element.scrollTop = 70 })
    const offset = () => anchor.evaluate(element => element.getBoundingClientRect().top
      - element.closest('[data-testid="code-agent-transcript-scroll"]')!.getBoundingClientRect().top)
    await scroll.hover()
    const before = await offset()
    await page.mouse.wheel(0, -1)
    await expect.poll(() => historyReads).toBeGreaterThan(0)
    await expect(scroll.locator('[data-progress-id="acp-progress-entry-1792"]')).toBeAttached()
    await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThan(3)

    // Cross the retention budget inside the same Turn, with stage answers.
    for (let start = 1536; start >= 256; start -= 256) {
      await scroll.hover()
      await expect(async () => {
        await page.mouse.wheel(0, -700)
        await expect(scroll.locator(`[data-progress-id="acp-progress-entry-${start}"]`)).toBeAttached({ timeout: 500 })
      }).toPass({ timeout: 15_000 })
    }
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(summary).not.toContainText('Worked for')
    await expect(scroll.locator('.code-agent-transcript-answer')).toHaveCount(0)
    await expect(scroll.getByTestId('code-acp-answer-segment').first()).toBeAttached()

    const historicalBlock = scroll.locator('[data-progress-id="acp-progress-entry-512"]')
    await historicalBlock.evaluate(element => {
      const scroller = element.closest('[data-testid="code-agent-transcript-scroll"]')!
      scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 12
    })
    await scroll.hover()
    await page.mouse.wheel(0, 1)
    const historicalOffset = await historicalBlock.evaluate(element => element.getBoundingClientRect().top
      - element.closest('[data-testid="code-agent-transcript-scroll"]')!.getBoundingClientRect().top)
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
      .filter(key => key.startsWith('farming.reading-anchor.v1:'))
      .some(key => localStorage.getItem(key)?.includes('acp-progress-entry-512')))).toBe(true)
    await page.reload()
    await expect(historicalBlock).toBeAttached()
    await expect.poll(async () => Math.abs(await historicalBlock.evaluate(element => element.getBoundingClientRect().top
      - element.closest('[data-testid="code-agent-transcript-scroll"]')!.getBoundingClientRect().top) - historicalOffset)).toBeLessThan(3)
    await page.screenshot({ path: testInfo.outputPath(`long-turn-restored-${appearance}.png`), animations: 'disabled' })

    // Sending is an explicit return to latest, but must not toggle disclosure.
    await summary.click()
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    const readsBeforeSend = latestReads
    await page.getByTestId('code-acp-composer-input').fill('Report the current status.')
    await page.getByTestId('code-acp-composer-send').click()
    await expect.poll(() => latestReads).toBeGreaterThan(readsBeforeSend)
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(scroll.locator('[data-progress-id="acp-progress-entry-2272"]')).toBeAttached()
    await summary.click()
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Agent needs permission', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`long-turn-latest-${appearance}.png`), animations: 'disabled' })
  })
}
