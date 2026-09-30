import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'
import { MAX_LOADED_ACP_ENTRIES } from '../../src/components/code/acp/acp-transcript-envelope'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`scrolling back to latest after loading history hides the jump control in ${appearance}`, async ({ page, workspaceRoot }) => {
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
    await expect(scroll).toContainText('Earlier paragraph 54.')
    await page.mouse.wheel(0, -400)
    await expect(jump).toBeVisible()
    await scroll.hover()
    await page.mouse.wheel(0, 100000)
    await expect.poll(() => scroll.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1)
    await expect(page.getByText('Latest answer.', { exact: true })).toBeInViewport()
    await expect(jump).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath(`scroll-back-to-latest-${appearance}.png`), animations: 'disabled', caret: 'hide' })
    await page.mouse.wheel(0, -400)
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

test('keeps return to latest available when loading history evicts the live tail', async ({ page, workspaceRoot }) => {
  test.setTimeout(90_000)
  const workspace = path.join(workspaceRoot, 'chat-history-capacity')
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as { sessionId: string; runtimeEpoch: string }
  let historyReads = 0
  let latestReads = 0
  const entriesPerPage = 256
  const turnsPerPage = 4
  const pageCount = Math.ceil(MAX_LOADED_ACP_ENTRIES / entriesPerPage)
  await page.route(new RegExp(`/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    const history = Boolean(cursor)
    const pageIndex = history ? Number(cursor!.replace('older-', '')) : -1
    if (history) historyReads += 1
    else latestReads += 1
    const entries = history
      ? Array.from({ length: turnsPerPage }, (_, offset) => {
        const index = (pageCount - pageIndex - 1) * turnsPerPage + offset
        return [
          { id: `older-user-${index}`, type: 'message', role: 'user', content: [{ type: 'text', text: `Earlier question ${index}` }] },
          ...Array.from({ length: entriesPerPage / turnsPerPage - 2 }, (_, step) => ({
            id: `older-tool-${index}-${step}`, type: 'tool', toolCallId: `call-${index}-${step}`,
            title: `Read example file ${step}`, kind: 'read', status: 'completed',
          })),
          { id: `older-answer-${index}`, type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: `Earlier answer ${index}` }] },
        ]
      }).flat()
      : [
        { id: 'latest-user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Latest question' }] },
        { id: 'latest-answer', type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: 'Latest answer.' }] },
      ]
    await route.fulfill({ json: {
      version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
      fromRevision: null, toRevision: 1000000, replace: true, settled: true, hasMoreBefore: pageIndex < pageCount - 1,
      transcript: { sessionId: identity.sessionId, revision: 1000000, state: 'idle', entries,
        hasMoreBefore: pageIndex < pageCount - 1,
        nextCursor: pageIndex < pageCount - 1 ? `older-${pageIndex + 1}` : null,
        entryPatch: { version: 1, order: entries.map(entry => entry.id), pageCursor: cursor },
      },
    } })
  })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByText('Latest answer.', { exact: true })).toBeVisible()
  const scroll = page.getByTestId('code-agent-transcript-scroll')
  const jump = page.getByTestId('code-agent-transcript-jump-bottom')
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    await scroll.hover()
    await page.mouse.wheel(0, -100000)
    await expect.poll(() => historyReads).toBeGreaterThan(pageIndex)
    await expect(scroll.getByText(`Earlier answer ${(pageCount - pageIndex - 1) * turnsPerPage}`, { exact: true })).toBeAttached()
  }
  await expect(scroll.getByText('Latest answer.', { exact: true })).toHaveCount(0)
  await page.mouse.wheel(0, 100000)
  await expect.poll(() => scroll.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1)
  await expect(jump).toBeVisible()
  const readsBeforeJump = latestReads
  await jump.click()
  await expect.poll(() => latestReads).toBeGreaterThan(readsBeforeJump)
  await expect(page.getByText('Latest answer.', { exact: true })).toBeVisible()
  await expect(jump).toHaveCount(0)
})

test('a just-sent long mobile message follows latest without a jump control', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'mobile-send-scroll')
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await page.setViewportSize({ width: 390, height: 844 })
  await openFarming(page)
  await page.getByTestId('code-mobile-menu').click()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const message = Array.from({ length: 55 }, (_, index) => `Mobile message line ${index + 1}`).join('\n')
  await page.getByTestId('code-acp-composer-input').fill(message)
  await page.getByTestId('code-acp-composer-send').click()
  const scroll = page.getByTestId('code-agent-transcript-scroll')
  const jump = page.getByTestId('code-agent-transcript-jump-bottom')
  await expect(scroll.locator('.code-agent-transcript-user')).toContainText('Mobile message line 55')
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(96)
  await expect(jump).toHaveCount(0)
  await scroll.hover()
  await page.mouse.wheel(0, -3000)
  await expect(jump).toBeVisible()
  const buttonGap = await jump.evaluate(element => {
    const transcript = element.closest('.code-agent-transcript')!
    return transcript.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom
  })
  expect(buttonGap).toBeGreaterThanOrEqual(10)
  expect(buttonGap).toBeLessThanOrEqual(18)
  await jump.click()
  await expect(jump).toHaveCount(0)
})
