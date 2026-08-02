import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createAcpAgent(page: Page, workspace: string, command = 'claude') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

async function setPageVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate(nextState => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => nextState,
    })
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => nextState === 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

async function selectAgentOnCompactLayout(page: Page, agentId: string) {
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const mobileMenu = page.getByTestId('code-mobile-menu')
  if (!await row.isVisible().catch(() => false) && await mobileMenu.isVisible().catch(() => false)) {
    await mobileMenu.click()
  }
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
}

test('keeps ACP Chat live while the browser page is hidden', { tag: '@iphone-human' }, async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'background-chat-continuity')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  let backendSocketClosed = 0

  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith('/ws')) return
    socket.on('close', () => { backendSocketClosed += 1 })
  })

  await openFarming(page)
  await selectAgentOnCompactLayout(page, agentId)
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
  await expect(page.getByTestId('connection-status')).toHaveCount(0)

  const composerInput = page.getByTestId('code-acp-composer-input')
  await composerInput.fill('draft survives composer collapse')
  if (await page.locator('.code-composer-collapse-zone').count()) {
    await page.locator('.code-composer-collapse-zone').hover()
    await page.getByTestId('code-composer-collapse').click()
    await expect(page.getByTestId('code-acp-composer')).toHaveCount(0)
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    await page.getByTestId('code-composer-restore').click()
  } else {
    await expect(page.getByTestId('code-acp-composer')).toBeVisible()
  }
  await expect(composerInput).toHaveValue('draft survives composer collapse')
  await composerInput.fill('')

  await composerInput.fill('streaming thought')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('streaming thought', { exact: true })).toBeVisible()

  await setPageVisibility(page, 'hidden')
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden')

  await expect.poll(
    async () => page.getByText('Streaming thought complete.', { exact: true }).count(),
    { timeout: 15_000 },
  ).toBe(1)
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden')
  expect(backendSocketClosed).toBe(0)

  await setPageVisibility(page, 'visible')
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
  await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible()
  await expect(page.getByTestId('connection-status')).toHaveCount(0)
  expect(backendSocketClosed).toBe(0)
})

test('does not repeat Chat read receipts when only live runtime state changes', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'chat-read-receipt-stability')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  let readReceiptRequests = 0

  await page.route(new RegExp(`/farming/api/agents/${agentId}$`), async route => {
    const request = route.request()
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as { unread?: unknown }
      if (body.unread === false) readReceiptRequests += 1
    }
    await route.continue()
  })
  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          sessionId: 'chat-read-receipt-stability-session',
          state: 'idle',
          revision: 1,
          entries: [
            {
              id: 'read-receipt-user',
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'Keep the read receipt stable.' }],
            },
            {
              id: 'read-receipt-answer',
              type: 'message',
              role: 'assistant',
              _meta: { codex: { phase: 'final_answer' } },
              content: [{ type: 'text', text: 'The transcript content is unchanged.' }],
            },
          ],
        },
      }),
    })
  })

  await openFarming(page)
  await selectAgentOnCompactLayout(page, agentId)
  await expect(page.getByText('The transcript content is unchanged.', { exact: true })).toBeVisible()
  await page.waitForTimeout(300)
  readReceiptRequests = 0

  await page.evaluate(async id => {
    const liveState = window.__farmingAgentActivityTest as unknown as {
      update: (agentId: string, patch: Record<string, unknown>) => void
    }
    for (let index = 0; index < 12; index += 1) {
      liveState.update(id, { terminalBusy: index % 2 === 0 })
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
    }
  }, agentId)
  await page.waitForTimeout(300)

  expect(readReceiptRequests).toBe(0)
  await expect(page.getByTestId('app-error-fallback')).toHaveCount(0)
})

test('keeps retained Chat frontends mounted and refreshes them by revision after Agent switches', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'agent-chat-view-cache')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'cache-target.txt'), 'retained Chat file target\n')
  const firstAgentId = await createAcpAgent(page, workspace)
  const secondAgentId = await createAcpAgent(page, workspace, 'opencode')
  const transcriptEntries = new Map<string, Array<Record<string, unknown>>>()
  for (const label of ['FIRST', 'SECOND']) {
    transcriptEntries.set(label, Array.from({ length: 20 }, (_, index) => ([
      {
        id: `${label}-user-${index}`,
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: `${label} cached question ${index}` }],
      },
      ...Array.from({ length: 50 }, (_, toolIndex) => ({
        id: `${label}-tool-${index}-${toolIndex}`,
        type: 'tool',
        kind: toolIndex % 2 === 0 ? 'read' : 'command',
        title: `${toolIndex % 2 === 0 ? 'Read file' : 'Ran command'} ${toolIndex}`,
        status: 'completed',
        transcriptDetail: `tool ${toolIndex} output\n${'bounded retained detail '.repeat(70)}`,
        content: [],
      })),
      {
        id: `${label}-answer-${index}`,
        type: 'message',
        role: 'assistant',
        _meta: { codex: { phase: 'final_answer' } },
        content: [{
          type: 'text',
          text: `${label} cached answer ${index}. ${'Retained frontend state. '.repeat(6)}${index === 19 ? '\n\n[cache-target.txt](cache-target.txt)' : ''}`,
        }],
      },
    ])).flat())
  }
  const firstFixtureEntries = transcriptEntries.get('FIRST') ?? []
  expect(firstFixtureEntries.filter(entry => entry.type === 'tool')).toHaveLength(1_000)
  expect(Buffer.byteLength(JSON.stringify(firstFixtureEntries))).toBeGreaterThan(1.5 * 1024 * 1024)
  const requests = new Map<string, Array<string | null>>([
    [firstAgentId, []],
    [secondAgentId, []],
  ])
  let firstDeltaRequestCount = 0
  let releaseFirstDelta = () => {}
  const firstDeltaGate = new Promise<void>(resolve => {
    releaseFirstDelta = resolve
  })
  let markFirstDeltaStarted = () => {}
  const firstDeltaStarted = new Promise<void>(resolve => {
    markFirstDeltaStarted = resolve
  })
  let markFirstDeltaSettled = () => {}
  const firstDeltaSettled = new Promise<void>(resolve => {
    markFirstDeltaSettled = resolve
  })

  const routeTranscript = async (agentId: string, label: string) => {
    await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
      const sinceRevision = new URL(route.request().url()).searchParams.get('sinceRevision')
      requests.get(agentId)?.push(sinceRevision)
      const firstDeltaOrdinal = agentId === firstAgentId && sinceRevision !== null
        ? ++firstDeltaRequestCount
        : 0
      const heldStaleDelta = firstDeltaOrdinal === 1
      if (heldStaleDelta) {
        markFirstDeltaStarted()
        await firstDeltaGate
      }
      const deltaEntries = heldStaleDelta
        ? [
            {
              id: 'FIRST-stale-delta-user',
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'STALE delta user' }],
            },
            {
              id: 'FIRST-stale-delta-answer',
              type: 'message',
              role: 'assistant',
              _meta: { codex: { phase: 'final_answer' } },
              content: [{ type: 'text', text: 'STALE delta must never replace the newer view.' }],
            },
          ]
        : firstDeltaOrdinal === 2
          ? [
              {
                id: 'FIRST-fresh-delta-user',
                type: 'message',
                role: 'user',
                content: [{ type: 'text', text: 'FRESH delta user' }],
              },
              {
                id: 'FIRST-fresh-delta-answer',
                type: 'message',
                role: 'assistant',
                _meta: { codex: { phase: 'final_answer' } },
                content: [{ type: 'text', text: 'FRESH delta remains authoritative.' }],
              },
            ]
          : []
      try {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            transcript: {
              sessionId: `${label}-session`,
              state: 'idle',
              revision: sinceRevision === null
                ? 11
                : heldStaleDelta
                  ? 12
                  : agentId === firstAgentId
                    ? 13
                    : 11,
              delta: sinceRevision !== null,
              entries: sinceRevision === null ? transcriptEntries.get(label) ?? [] : deltaEntries,
            },
          }),
        })
      } catch (error) {
        if (route.request().failure()) return
        throw error
      } finally {
        if (heldStaleDelta) markFirstDeltaSettled()
      }
    })
  }

  await routeTranscript(firstAgentId, 'FIRST')
  await routeTranscript(secondAgentId, 'SECOND')
  await openFarming(page)

  const firstRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
  const secondRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`)
  await expect(firstRow).toBeVisible()
  await expect(secondRow).toBeVisible()

  await firstRow.click()
  const firstPane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${firstAgentId}"]`)
  const firstScroll = firstPane.getByTestId('code-agent-transcript-scroll')
  await expect(firstPane.getByText('FIRST cached answer 19.', { exact: false })).toBeVisible()
  const firstProcessSummary = firstPane.getByTestId('code-agent-transcript-process-summary').last()
  await firstProcessSummary.click()
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'true')
  const savedScrollTop = await firstScroll.evaluate(element => {
    element.closest<HTMLElement>('[data-testid="code-agent-work-pane"]')!.dataset.cacheProbe = 'retained'
    const sentinel = Array.from(element.querySelectorAll<HTMLElement>('.code-agent-transcript-assistant'))
      .find(candidate => candidate.textContent?.includes('FIRST cached answer 19.'))
    if (!sentinel) throw new Error('Cached transcript sentinel is missing')
    sentinel.dataset.cacheSentinel = 'retained'
    sentinel.scrollIntoView({ block: 'center' })
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    return element.scrollTop
  })
  expect(savedScrollTop).toBeGreaterThan(0)

  await secondRow.click()
  const secondPane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${secondAgentId}"]`)
  await expect(secondPane.getByText('SECOND cached answer 19.', { exact: false })).toBeVisible()
  await expect(firstPane).toBeAttached()
  await expect(firstPane).toBeHidden()
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')

  const cachedSwitchMs = await page.evaluate(agentId => new Promise<number>((resolve, reject) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    const pane = document.querySelector<HTMLElement>(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    const sentinel = pane?.querySelector<HTMLElement>('[data-cache-sentinel="retained"]')
    const scroller = pane?.querySelector<HTMLElement>('[data-testid="code-agent-transcript-scroll"]')
    if (!row || !pane || !sentinel || !scroller) {
      reject(new Error('Cached Agent row, pane, or transcript sentinel is unavailable'))
      return
    }
    const startedAt = performance.now()
    row.click()
    let frameCount = 0
    const observeVisibility = () => {
      frameCount += 1
      const paneStyle = window.getComputedStyle(pane)
      const sentinelStyle = window.getComputedStyle(sentinel)
      const sentinelRect = sentinel.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const transcriptVisible = frameCount >= 2
        && !pane.hidden
        && paneStyle.display !== 'none'
        && paneStyle.visibility !== 'hidden'
        && sentinelStyle.display !== 'none'
        && sentinelStyle.visibility !== 'hidden'
        && sentinelRect.width > 0
        && sentinelRect.height > 0
        && sentinelRect.bottom > scrollerRect.top
        && sentinelRect.top < scrollerRect.bottom
        && sentinelRect.right > scrollerRect.left
        && sentinelRect.left < scrollerRect.right
      if (transcriptVisible) {
        resolve(performance.now() - startedAt)
        return
      }
      if (performance.now() - startedAt > 1_000) {
        reject(new Error('Cached Agent pane did not become visible'))
        return
      }
      window.requestAnimationFrame(observeVisibility)
    }
    window.requestAnimationFrame(observeVisibility)
  }), firstAgentId)
  await firstDeltaStarted
  await expect(firstPane).toBeVisible()
  await expect(firstPane.getByText('FIRST cached answer 19.', { exact: false })).toBeVisible()
  expect(cachedSwitchMs).toBeLessThan(250)
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')
  expect(await firstScroll.evaluate(element => element.scrollTop)).toBeCloseTo(savedScrollTop, 0)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'true')

  await secondRow.click()
  await expect(firstPane).toBeHidden()
  await firstRow.click()
  await expect(firstPane).toBeVisible()
  await expect(firstPane.getByText('FIRST cached answer 19.', { exact: false })).toBeVisible()
  await expect(firstPane.getByText('FRESH delta remains authoritative.', { exact: true })).toBeVisible()
  releaseFirstDelta()
  await firstDeltaSettled
  await expect(firstPane.getByText('STALE delta must never replace the newer view.', { exact: true })).toHaveCount(0)
  await expect(firstPane.getByText('FRESH delta remains authoritative.', { exact: true })).toBeVisible()
  await expect.poll(() => requests.get(firstAgentId)?.filter(revision => revision === '11').length).toBeGreaterThanOrEqual(2)
  expect(requests.get(firstAgentId)?.filter(revision => revision === null)).toHaveLength(1)
  expect(requests.get(secondAgentId)?.filter(revision => revision === null)).toHaveLength(1)
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')
  const refreshedScrollTop = await firstScroll.evaluate(element => {
    const sentinel = element.querySelector<HTMLElement>('[data-cache-sentinel="retained"]')
    if (!sentinel) throw new Error('Cached transcript sentinel was replaced')
    return element.scrollTop
  })
  expect(refreshedScrollTop).toBeGreaterThan(0)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'true')

  await page.getByTestId('code-nav-history').click()
  await expect(page.getByTestId('code-history-panel')).toBeVisible()
  await expect(firstPane).toBeAttached()
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')

  await firstRow.click()
  await expect(firstPane).toBeVisible()
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')
  expect(await firstScroll.evaluate(element => element.scrollTop)).toBeCloseTo(refreshedScrollTop, 0)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'true')

  await page.getByTestId('code-nav-search').click()
  await expect(page.getByTestId('code-search-panel')).toBeVisible()
  await expect(firstPane).toBeAttached()
  await expect(firstPane).toBeHidden()
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')

  await firstRow.click()
  await expect(firstPane).toBeVisible()
  expect(await firstScroll.evaluate(element => element.scrollTop)).toBeCloseTo(refreshedScrollTop, 0)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'true')

  await firstPane.getByRole('link', { name: 'cache-target.txt' }).click()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expect(firstPane).toBeAttached()
  await expect(firstPane).toBeHidden()
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')

  await page.getByTestId('code-file-editor-back').click()
  await expect(firstPane).toBeVisible()
  expect(await firstScroll.evaluate(element => element.scrollTop)).toBeCloseTo(refreshedScrollTop, 0)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'true')

  const deleteResponse = await page.request.delete(`/farming/api/control/agents/${firstAgentId}`)
  expect(deleteResponse.ok()).toBeTruthy()
  await expect(firstPane).toHaveCount(0)
})

test('rejects an older successful ACP transcript response that arrives after a newer one', { tag: '@iphone-human' }, async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'acp-transcript-response-order')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  let deltaRequestCount = 0

  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    const sinceRevision = new URL(route.request().url()).searchParams.get('sinceRevision')
    const deltaOrdinal = sinceRevision === null ? 0 : ++deltaRequestCount
    const label = deltaOrdinal === 1
      ? 'STALE'
      : deltaOrdinal === 2
        ? 'FRESH'
        : deltaOrdinal === 3
          ? 'REGRESSED'
          : 'INITIAL'
    const revision = deltaOrdinal === 1 ? 12 : deltaOrdinal === 2 ? 13 : deltaOrdinal === 3 ? 12 : 11
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          sessionId: 'response-order-session',
          state: 'idle',
          revision,
          delta: sinceRevision !== null,
          entries: [
            {
              id: `${label}-user`,
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: `${label} response user` }],
            },
            {
              id: `${label}-answer`,
              type: 'message',
              role: 'assistant',
              _meta: { codex: { phase: 'final_answer' } },
              content: [{ type: 'text', text: `${label} response answer` }],
            },
          ],
        },
      }),
    })
  })

  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    let deltaResponseCount = 0
    let releaseHeldResponse = () => {}
    let markHeldResponseReady = () => {}
    const heldResponseReady = new Promise<void>(resolve => {
      markHeldResponseReady = resolve
    })
    const race = {
      heldResponseReady,
      releaseHeldResponse: () => releaseHeldResponse(),
    }
    ;(window as typeof window & { __farmingTranscriptResponseRace?: typeof race })
      .__farmingTranscriptResponseRace = race
    window.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : String(input)
      const url = new URL(rawUrl, window.location.href)
      if (!url.pathname.endsWith('/acp-transcript') || !url.searchParams.has('sinceRevision')) {
        return originalFetch(input, init)
      }
      deltaResponseCount += 1
      // Simulate a transport that has already accepted the request and cannot
      // be cancelled: both HTTP responses succeed, but the first is delivered
      // to the application only after the second response has committed.
      const response = await originalFetch(input, { ...init, signal: undefined })
      if (deltaResponseCount !== 1) return response
      markHeldResponseReady()
      await new Promise<void>(resolve => {
        releaseHeldResponse = resolve
      })
      return response
    }
  })

  await openFarming(page)
  await selectAgentOnCompactLayout(page, agentId)
  await expect(page.getByText('INITIAL response answer', { exact: true })).toBeVisible()

  await page.evaluate(() => {
    window.dispatchEvent(new Event('farming:backend-disconnected'))
    window.dispatchEvent(new Event('farming:backend-connected'))
  })
  await page.evaluate(() => (
    (window as typeof window & {
      __farmingTranscriptResponseRace?: { heldResponseReady: Promise<void> }
    }).__farmingTranscriptResponseRace?.heldResponseReady
  ))
  await page.evaluate(() => {
    window.dispatchEvent(new Event('farming:backend-disconnected'))
    window.dispatchEvent(new Event('farming:backend-connected'))
  })

  await expect(page.getByText('FRESH response answer', { exact: true })).toBeVisible()
  await page.evaluate(async () => {
    (window as typeof window & {
      __farmingTranscriptResponseRace?: { releaseHeldResponse: () => void }
    }).__farmingTranscriptResponseRace?.releaseHeldResponse()
    await new Promise<void>(resolve => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve())
      })
    })
  })

  expect(deltaRequestCount).toBe(2)
  await expect(page.getByText('FRESH response answer', { exact: true })).toBeVisible()
  await expect(page.getByText('STALE response answer', { exact: true })).toHaveCount(0)

  await page.evaluate(() => {
    window.dispatchEvent(new Event('farming:backend-disconnected'))
    window.dispatchEvent(new Event('farming:backend-connected'))
  })
  await expect.poll(() => deltaRequestCount).toBe(3)
  await expect(page.getByText('FRESH response answer', { exact: true })).toBeVisible()
  await expect(page.getByText('REGRESSED response answer', { exact: true })).toHaveCount(0)
})

test('keeps long ACP Chat stable when the Composer is collapsed and restored', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'composer-layout-anchor')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  const entries = Array.from({ length: 24 }, (_, index) => ([
    {
      id: `user-${index}`,
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: `Long conversation question ${index}` }],
    },
    {
      id: `answer-${index}`,
      type: 'message',
      role: 'assistant',
      _meta: { codex: { phase: 'final_answer' } },
      content: [{
        type: 'text',
        text: `Long answer ${index}.\n\n${'Keep this transcript tall enough to exercise layout anchoring. '.repeat(5)}`,
      }],
    },
  ])).flat()

  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          sessionId: 'composer-layout-anchor-session',
          state: 'idle',
          revision: 1,
          entries,
        },
      }),
    })
  })

  await openFarming(page)
  await selectAgentOnCompactLayout(page, agentId)
  const transcriptScroll = page.getByTestId('code-agent-transcript-scroll')
  await expect(transcriptScroll).toContainText('Long conversation question 23')
  await transcriptScroll.evaluate(element => {
    element.scrollTop = element.scrollHeight
  })

  const bottomDistance = () => transcriptScroll.evaluate(element => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))
  await expect.poll(bottomDistance).toBeLessThanOrEqual(2)

  await page.locator('.code-composer-collapse-zone').hover()
  await page.getByTestId('code-composer-collapse').click()
  await expect(page.getByTestId('code-acp-composer')).toHaveCount(0)
  await expect.poll(bottomDistance).toBeLessThanOrEqual(2)

  await page.getByTestId('code-composer-restore').click()
  await expect(page.getByTestId('code-acp-composer')).toBeVisible()
  await expect.poll(bottomDistance).toBeLessThanOrEqual(2)

  const readingTop = await transcriptScroll.evaluate(element => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 500)
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    return element.scrollTop
  })
  expect(readingTop).toBeGreaterThan(0)

  await page.locator('.code-composer-collapse-zone').hover()
  await page.getByTestId('code-composer-collapse').click()
  await page.getByTestId('code-composer-restore').click()
  await expect.poll(() => transcriptScroll.evaluate(element => element.scrollTop)).toBeCloseTo(readingTop, 0)
  await expect(page.getByTestId('code-agent-transcript-jump-bottom')).toBeVisible()
})

test('starts a short ACP turn at the top with a compact copy affordance', { tag: '@iphone-human' }, async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'compact-chat-tail')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  await selectAgentOnCompactLayout(page, agentId)

  await page.getByTestId('code-acp-composer-input').fill('image attachment')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Received 0 image.', { exact: true })).toBeVisible()
  const completedTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'image attachment' })
  await expect(completedTurn).toHaveCount(1)
  const userTime = completedTurn.getByTestId('code-agent-transcript-user-time')
  const answerTime = completedTurn.getByTestId('code-agent-transcript-answer-time')
  await expect(userTime).toHaveCSS('opacity', '0')
  await completedTurn.locator('.code-agent-transcript-user').hover()
  await expect(userTime).toHaveCSS('opacity', '1')
  await expect(answerTime).toHaveCSS('opacity', '0')
  await completedTurn.locator('.code-agent-transcript-answer').hover()
  await expect(answerTime).toHaveCSS('opacity', '1')
  expect(await userTime.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(await answerTime.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  const forkRequests: Array<{ mode?: string; targetRuntime?: string; expectedRevision?: number }> = []
  await page.route(`/farming/api/agents/${agentId}/fork`, async route => {
    forkRequests.push(route.request().postDataJSON() as {
      mode?: string
      targetRuntime?: string
      expectedRevision?: number
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ agentId }),
    })
  })
  const forkButton = page.getByTestId('code-agent-transcript-fork')
  await expect(forkButton).toHaveCount(1)
  await expect(forkButton).toBeVisible()
  await forkButton.evaluate(button => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await expect.poll(() => forkRequests.length).toBe(1)
  expect(forkRequests[0]).toMatchObject({
    mode: 'same-worktree',
    targetRuntime: 'chat',
  })
  expect(forkRequests[0].expectedRevision).toBeGreaterThan(0)

  const geometry = await page.getByTestId('code-agent-transcript-copy-answer').evaluate(element => {
    const action = element.getBoundingClientRect()
    const icon = element.querySelector('svg')?.getBoundingClientRect()
    const turn = element.closest<HTMLElement>('.code-agent-transcript-turn')
    const time = turn?.querySelector<HTMLElement>('[data-testid="code-agent-transcript-answer-time"]')?.getBoundingClientRect()
    const lastAction = turn?.querySelector<HTMLElement>('[data-testid="code-agent-transcript-fork"]')?.getBoundingClientRect() || action
    const user = turn?.querySelector<HTMLElement>('.code-agent-transcript-user')?.getBoundingClientRect()
    const answer = turn?.querySelector<HTMLElement>('.code-agent-transcript-answer')?.getBoundingClientRect()
    const scroller = element.closest<HTMLElement>('.code-agent-transcript-scroll')?.getBoundingClientRect()
    const composer = document.querySelector<HTMLElement>('.code-composer')?.getBoundingClientRect()
    if (!icon || !time || !user || !answer || !scroller || !composer) {
      throw new Error('Chat turn geometry is unavailable')
    }
    return {
      actionWidth: action.width,
      actionHeight: action.height,
      iconWidth: icon.width,
      iconHeight: icon.height,
      answerTimeGap: time.left - lastAction.right,
      answerTimeCenterDelta: Math.abs((time.top + time.height / 2) - (lastAction.top + lastAction.height / 2)),
      userTopOffset: user.top - scroller.top,
      answerGap: answer.top - user.bottom,
      composerGap: composer.top - action.bottom,
    }
  })

  const compactLayout = await page.locator('body').evaluate(element => element.classList.contains('code-compact-layout'))
  expect(geometry.userTopOffset).toBeGreaterThanOrEqual(compactLayout ? 0 : 30)
  expect(geometry.userTopOffset).toBeLessThanOrEqual(60)
  expect(geometry.answerGap).toBeGreaterThanOrEqual(16)
  expect(geometry.answerGap).toBeLessThanOrEqual(28)
  expect(geometry.answerTimeGap).toBe(8)
  expect(geometry.answerTimeCenterDelta).toBeLessThanOrEqual(1)
  expect(geometry.composerGap).toBeGreaterThan(200)
  expect(geometry).toMatchObject({
    actionWidth: 20,
    actionHeight: 20,
    iconWidth: 14,
    iconHeight: 14,
  })
})

test('keeps narrow Chat copyable and wraps long user text inside its bubble', { tag: '@iphone-human' }, async ({ page, workspaceRoot }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const workspace = path.join(workspaceRoot, 'narrow-chat-copy-wrap')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await page.getByTestId('code-mobile-menu').click()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()

  const input = page.getByTestId('code-acp-composer-input')
  const iosInput = await page.locator('body').evaluate(element => element.classList.contains('code-mobile-ios'))
  await expect(input).toHaveCSS('font-size', iosInput ? '16px' : '14px')
  await input.fill(`image attachment ${'amap_order_id,'.repeat(120)}`)
  await page.getByTestId('code-acp-composer-send').click()

  const copyAnswer = page.getByTestId('code-agent-transcript-copy-answer')
  await expect(page.getByText('Received 0 image.', { exact: true })).toBeVisible()
  await expect(copyAnswer).toBeVisible()
  const userBubble = page.locator('.code-agent-transcript-turn .code-agent-transcript-user').filter({ hasText: 'amap_order_id' })
  await expect(userBubble).toHaveCount(1)
  expect(await userBubble.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowWrap: getComputedStyle(element).overflowWrap,
  }))).toMatchObject({
    overflowWrap: 'anywhere',
  })
  expect(await userBubble.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(
    await userBubble.evaluate(element => element.clientWidth),
  )
})

test('forks the latest ACP answer into a new Chat Agent in the same workspace', { tag: '@iphone-human' }, async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'acp-conversation-fork')
  fs.mkdirSync(workspace, { recursive: true })
  const sourceAgentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  await selectAgentOnCompactLayout(page, sourceAgentId)
  await page.getByTestId('code-acp-composer-input').fill('phase-aware mermaid fork this conversation')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Phase-aware rich answer.', { exact: false })).toBeVisible()

  const compactLayout = await page.locator('body').evaluate(element => element.classList.contains('code-compact-layout'))
  const membershipItems = compactLayout
    ? page.getByTestId('code-agent-work-pane')
    : page.getByTestId('code-agent-row')
  const sourceAgentIds = await membershipItems.evaluateAll(elements => (
    elements.map(element => element.getAttribute('data-agent-id')).filter(Boolean)
  ))
  await page.getByTestId('code-agent-transcript-fork').click()
  await expect(membershipItems).toHaveCount(sourceAgentIds.length + 1)

  const agentIds = await membershipItems.evaluateAll(elements => (
    elements.map(element => element.getAttribute('data-agent-id')).filter(Boolean)
  ))
  const forkedAgentId = agentIds.find(id => !sourceAgentIds.includes(id))
  expect(forkedAgentId).toBeTruthy()
  const forkedPane = page.locator(
    `[data-testid="code-agent-work-pane"][data-agent-id="${forkedAgentId}"]`
  )
  await expect(forkedPane).toBeVisible()
  await expect(forkedPane.getByTestId('code-agent-chat-view')).toBeVisible()
  await expect(forkedPane.getByText('phase-aware mermaid fork this conversation', { exact: true })).toBeVisible()
  await expect(forkedPane.getByText('Phase-aware rich answer.', { exact: false })).toBeVisible()
})

test('keeps a human reader stationary while an ACP answer streams below', { tag: '@iphone-human' }, async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'streaming-reader-scroll-stability')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  await selectAgentOnCompactLayout(page, agentId)

  const transcript = page.getByTestId('code-agent-transcript-scroll')
  await page.getByTestId('code-acp-composer-input').fill('scroll stability')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Reading paragraph 48', { exact: false })).toBeVisible()
  await expect.poll(async () => transcript.evaluate(element => (
    element.scrollHeight - element.clientHeight
  ))).toBeGreaterThan(1)

  const readingPosition = await transcript.evaluate(element => {
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight)
    element.scrollTop = Math.max(0, bottom - 900)
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    return element.scrollTop
  })
  expect(await transcript.evaluate(element => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeGreaterThan(1)
  await expect(page.getByTestId('code-agent-transcript-jump-bottom')).toBeVisible()

  for (let index = 1; index <= 6; index += 1) {
    await expect(page.getByText(`Streaming tail ${index}`, { exact: false })).toBeAttached({ timeout: 10_000 })
    const positionDelta = Math.abs(
      (await transcript.evaluate(element => element.scrollTop)) - readingPosition,
    )
    expect(positionDelta).toBeLessThanOrEqual(1)
  }

  await page.getByTestId('code-agent-transcript-jump-bottom').click()
  await expect.poll(async () => transcript.evaluate(element => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(1)
})
