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

test('opens a completed Chat shell immediately and renders its prepared snapshot', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'chat-initial-snapshot-reveal')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  const partialAnswer = 'Initial answer fragment that must stay hidden.'
  const completeAnswer = 'Initial answer is now complete and should appear once.'
  let transcriptRequests = 0

  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    transcriptRequests += 1
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          sessionId: 'chat-initial-snapshot-reveal-session',
          state: 'idle',
          revision: transcriptRequests,
          entries: [
            {
              id: 'initial-snapshot-user',
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'Open this existing Chat.' }],
            },
            {
              id: 'initial-snapshot-answer',
              type: 'message',
              role: 'assistant',
              _meta: { codex: { phase: 'final_answer' } },
              content: [{ type: 'text', text: completeAnswer }],
            },
          ],
        },
      }),
    })
  })

  await openFarming(page)
  await page.evaluate(fragment => {
    const state = window as typeof window & {
      __farmingInitialChatFragmentVisible?: boolean
      __farmingInitialChatObserver?: MutationObserver
    }
    state.__farmingInitialChatFragmentVisible = false
    state.__farmingInitialChatObserver = new MutationObserver(() => {
      if (document.body.innerText.includes(fragment)) {
        state.__farmingInitialChatFragmentVisible = true
      }
    })
    state.__farmingInitialChatObserver.observe(document.body, { childList: true, subtree: true })
  }, partialAnswer)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const firstTurnVisibleMs = await agentRow.evaluate(row => new Promise<number>((resolve, reject) => {
    const startedAt = performance.now()
    ;(row as HTMLElement).click()
    const observe = () => {
      const chat = document.querySelector<HTMLElement>('[data-testid="code-agent-chat-view"]')
      const firstTurn = chat?.querySelector<HTMLElement>('[data-turn-id]')
      if (chat && !chat.hidden && firstTurn && firstTurn.getBoundingClientRect().height > 0) {
        resolve(performance.now() - startedAt)
        return
      }
      if (performance.now() - startedAt > 1_000) {
        reject(new Error('Prepared Chat first Turn did not become visible'))
        return
      }
      window.requestAnimationFrame(observe)
    }
    window.requestAnimationFrame(observe)
  }))

  await expect(page.getByText(completeAnswer, { exact: true })).toBeVisible({ timeout: 10_000 })
  expect(transcriptRequests).toBeGreaterThanOrEqual(1)
  console.log(`performance-chat-open first-turn-visible-ms=${firstTurnVisibleMs.toFixed(1)}`)
  test.info().annotations.push({
    type: 'performance-budget',
    description: `prepared Chat first Turn visible in ${firstTurnVisibleMs.toFixed(1)}ms`,
  })
  expect(firstTurnVisibleMs).toBeLessThan(250)
  expect(await page.evaluate(() => (
    (window as typeof window & { __farmingInitialChatFragmentVisible?: boolean })
      .__farmingInitialChatFragmentVisible
  ))).toBe(false)
})

test('shows a stable Chat shell for an uncached snapshot and ignores its late result after navigation', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'chat-initial-snapshot-loading')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  let transcriptRequests = 0
  let releaseTranscript = () => {}
  const transcriptGate = new Promise<void>(resolve => {
    releaseTranscript = resolve
  })
  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    transcriptRequests += 1
    await transcriptGate
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          sessionId: 'chat-initial-snapshot-loading-session',
          state: 'idle',
          revision: 1,
          entries: [
            {
              id: 'initial-loading-user',
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'Open the uncached Chat.' }],
            },
            {
              id: 'initial-loading-answer',
              type: 'message',
              role: 'assistant',
              _meta: { codex: { phase: 'final_answer' } },
              content: [{ type: 'text', text: 'Late Chat answer must not steal navigation.' }],
            },
          ],
        },
      }),
    })
  })

  await openFarming(page)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await agentRow.click()
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
  await expect(page.locator('.code-agent-transcript-blank')).toHaveText('No conversation yet.')
  await expect(page.locator('.code-agent-transcript-state.subtle')).toHaveCount(0)
  await expect(page.getByText('Late Chat answer must not steal navigation.', { exact: true })).toHaveCount(0)
  await expect.poll(() => transcriptRequests).toBeGreaterThanOrEqual(1)

  await page.getByTestId('code-nav-history').click()
  await expect(page.getByTestId('code-history-panel')).toBeVisible()
  releaseTranscript()
  await page.evaluate(() => new Promise<void>(resolve => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
  }))
  await expect(page.getByTestId('code-history-panel')).toBeVisible()
  await expect(page.getByText('Late Chat answer must not steal navigation.', { exact: true })).toHaveCount(0)
})

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
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toHaveClass(/unread/)

  await setPageVisibility(page, 'visible')
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
  await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible()
  await expect(row).not.toHaveClass(/unread/)
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
  // Let the real read-receipt debounce drain before resetting the request counter.
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
  // Preserve the debounce boundary: the burst must not issue a delayed read receipt either.
  await page.waitForTimeout(300)

  expect(readReceiptRequests).toBe(0)
  await expect(page.getByTestId('app-error-fallback')).toHaveCount(0)
})

test('unmounts inactive Chat trees while preserving the active Chat behind resources', async ({ page, workspaceRoot }) => {
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
  const routeTranscript = async (agentId: string, label: string) => {
    await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
      const sinceRevision = new URL(route.request().url()).searchParams.get('sinceRevision')
      requests.get(agentId)?.push(sinceRevision)
      try {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            version: 1,
            agentId,
            sessionId: `${label}-session`,
            runtimeEpoch: `${label}-epoch`,
            fromRevision: null,
            toRevision: 11,
            replace: true,
            settled: true,
            hasMoreBefore: false,
            transcript: {
              sessionId: `${label}-session`,
              state: 'idle',
              revision: 11,
              entries: transcriptEntries.get(label) ?? [],
            },
          }),
        })
      } catch (error) {
        if (route.request().failure()) return
        throw error
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
    const pane = element.closest<HTMLElement>('[data-testid="code-agent-work-pane"]')!
    pane.dataset.cacheProbe = 'retained'
    const sentinel = Array.from(element.querySelectorAll<HTMLElement>('.code-agent-transcript-assistant'))
      .find(candidate => candidate.textContent?.includes('FIRST cached answer 19.'))
    if (!sentinel) throw new Error('Cached transcript sentinel is missing')
    sentinel.dataset.cacheSentinel = 'retained'
    sentinel.scrollIntoView({ block: 'center' })
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    return element.scrollTop
  })
  expect(savedScrollTop).toBeGreaterThan(0)
  const expectRestoredScroll = async (expected: number) => {
    await expect.poll(async () => {
      const actual = await firstScroll.evaluate(element => element.scrollTop)
      return Math.abs(actual - expected)
    }).toBeLessThan(80)
  }

  await secondRow.click()
  const secondPane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${secondAgentId}"]`)
  await expect(secondPane.getByText('SECOND cached answer 19.', { exact: false })).toBeVisible()
  await expect(firstPane).toBeAttached()
  await expect(firstPane).toBeHidden()
  await expect(firstPane.getByTestId('code-agent-transcript')).toHaveCount(0)
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')

  const cachedSwitchMs = await page.evaluate(agentId => new Promise<number>((resolve, reject) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    const pane = document.querySelector<HTMLElement>(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    if (!row || !pane) {
      reject(new Error('Cached Agent row or pane is unavailable'))
      return
    }
    const startedAt = performance.now()
    row.click()
    let frameCount = 0
    const observeVisibility = () => {
      frameCount += 1
      const paneStyle = window.getComputedStyle(pane)
      const sentinel = Array.from(pane.querySelectorAll<HTMLElement>('.code-agent-transcript-assistant'))
        .find(candidate => candidate.textContent?.includes('FIRST cached answer 19.'))
      const transcriptVisible = frameCount >= 2
        && !pane.hidden
        && paneStyle.display !== 'none'
        && paneStyle.visibility !== 'hidden'
        && Boolean(sentinel)
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
  await expect(firstPane).toBeVisible()
  await expect(firstPane.getByText('FIRST cached answer 19.', { exact: false })).toBeVisible()
  expect(cachedSwitchMs).toBeLessThan(300)
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')
  await expectRestoredScroll(savedScrollTop)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'false')

  await secondRow.click()
  await expect(firstPane).toBeHidden()
  await firstRow.click()
  await expect(firstPane).toBeVisible()
  await expect(firstPane.getByText('FIRST cached answer 19.', { exact: false })).toBeVisible()
  expect(requests.get(firstAgentId)?.every(revision => revision === null)).toBe(true)
  expect(requests.get(firstAgentId)?.filter(revision => revision === null).length).toBeGreaterThanOrEqual(3)
  expect(requests.get(secondAgentId)?.filter(revision => revision === null).length).toBeGreaterThanOrEqual(2)
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')
  const refreshedScrollTop = await firstScroll.evaluate(element => {
    return element.scrollTop
  })
  expect(refreshedScrollTop).toBeGreaterThan(0)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'false')

  await page.getByTestId('code-nav-history').click()
  await expect(page.getByTestId('code-history-panel')).toBeVisible()
  await expect(firstPane).toBeAttached()
  await expect(firstPane.getByTestId('code-agent-transcript')).toHaveCount(0)
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')

  await firstRow.click()
  await expect(firstPane).toBeVisible()
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')
  await expectRestoredScroll(refreshedScrollTop)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'false')

  await page.getByTestId('code-nav-search').click()
  await expect(page.getByTestId('code-search-panel')).toBeVisible()
  await expect(firstPane).toBeAttached()
  await expect(firstPane).toBeHidden()
  await expect(firstPane.getByTestId('code-agent-transcript')).toHaveCount(0)
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')

  await firstRow.click()
  await expect(firstPane).toBeVisible()
  await expectRestoredScroll(refreshedScrollTop)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'false')

  await firstPane.getByRole('link', { name: 'cache-target.txt' }).click()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expect(firstPane).toBeAttached()
  await expect(firstPane).toBeHidden()
  await expect(firstPane.getByTestId('code-agent-transcript')).toHaveCount(1)
  expect(await firstPane.getAttribute('data-cache-probe')).toBe('retained')

  await page.getByTestId('code-file-editor-back').click()
  await expect(firstPane).toBeVisible()
  await expectRestoredScroll(refreshedScrollTop)
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'false')

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

  const bottomTop = await transcriptScroll.evaluate(element => element.scrollTop)
  await transcriptScroll.hover()
  await page.mouse.wheel(0, -200)
  await expect.poll(async () => {
    const scrollTop = await transcriptScroll.evaluate(element => element.scrollTop)
    return scrollTop > 0 && scrollTop < bottomTop
  }).toBe(true)
  const readingTop = await transcriptScroll.evaluate(element => element.scrollTop)
  expect(readingTop).toBeGreaterThan(0)

  await page.locator('.code-composer-collapse-zone').hover()
  await page.getByTestId('code-composer-collapse').click()
  await page.getByTestId('code-composer-restore').click()
  await expect.poll(() => transcriptScroll.evaluate(element => element.scrollTop)).toBeCloseTo(readingTop, 0)
  await expect(page.getByTestId('code-agent-transcript-jump-bottom')).toBeVisible()
})

test('restores a persisted Chat message anchor after reload and loads older turns when needed', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'persisted-chat-reading-anchor')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  const entries = Array.from({ length: 36 }, (_, index) => ([
    {
      id: `anchor-user-${index}`,
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: `Persisted reading question ${index}` }],
    },
    {
      id: `anchor-answer-${index}`,
      type: 'message',
      role: 'assistant',
      _meta: { codex: { phase: 'final_answer' } },
      content: [{
        type: 'text',
        text: `Persisted answer ${index}. ${'Keep this turn tall enough to recover a fractional message anchor. '.repeat(4)}`,
      }],
    },
  ])).flat()
  const requestedTurnLimits: number[] = []

  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    requestedTurnLimits.push(Number(new URL(route.request().url()).searchParams.get('maxTurns') || 0))
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          sessionId: 'persisted-chat-reading-anchor-session',
          state: 'idle',
          revision: 1,
          entries,
        },
      }),
    })
  })

  await openFarming(page)
  await selectAgentOnCompactLayout(page, agentId)
  const transcript = page.getByTestId('code-agent-transcript-scroll')
  await expect(transcript).toContainText('Persisted reading question 35')
  const targetQuestion = transcript.getByText('Persisted reading question 2', { exact: true })
  for (let attempt = 0; attempt < 4 && await targetQuestion.count() === 0; attempt += 1) {
    const requestsBeforeScroll = requestedTurnLimits.length
    const heightBeforeScroll = await transcript.evaluate(element => element.scrollHeight)
    await transcript.evaluate(element => {
      element.dispatchEvent(new Event('touchstart', { bubbles: true }))
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
      element.dispatchEvent(new Event('touchend', { bubbles: true }))
    })
    await expect.poll(() => requestedTurnLimits.length).toBeGreaterThan(requestsBeforeScroll)
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight)).toBeGreaterThan(heightBeforeScroll)
  }
  await expect(targetQuestion).toBeAttached()

  await transcript.evaluate(element => {
    const target = Array.from(element.querySelectorAll<HTMLElement>('[data-turn-id]'))
      .find(turn => Array.from(turn.querySelectorAll<HTMLElement>('.code-agent-transcript-user'))
        .some(message => message.textContent?.trim() === 'Persisted reading question 2'))
    if (!target) throw new Error('Older persisted-anchor turn did not load')
    element.dispatchEvent(new Event('touchstart', { bubbles: true }))
    target.scrollIntoView({ block: 'center' })
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    element.dispatchEvent(new Event('touchend', { bubbles: true }))
  })
  const storageKey = `farming.reading-anchor.v1:agent:${agentId}:chat`
  await page.evaluate(key => sessionStorage.removeItem(key), storageKey)
  const snapshotKey = 'farming-e2e-persisted-chat-anchor'
  await page.addInitScript(({ anchorKey, resultKey }) => {
    sessionStorage.setItem(resultKey, localStorage.getItem(anchorKey) || '')
  }, { anchorKey: storageKey, resultKey: snapshotKey })
  const requestsBeforeReload = requestedTurnLimits.length

  await page.reload()
  const saved = await page.evaluate(key => {
    const anchor = JSON.parse(sessionStorage.getItem(key) || 'null')
    const id = String(anchor?.locator?.id || '')
    if (!id) throw new Error('Reloaded page did not capture a persisted Chat anchor')
    return {
      id,
      fraction: Number(anchor?.position?.value || 0),
    }
  }, snapshotKey)
  await selectAgentOnCompactLayout(page, agentId)
  const restoredTranscript = page.getByTestId('code-agent-transcript-scroll')
  await expect(restoredTranscript.locator(`[data-turn-id="${saved.id}"]`)).toBeAttached()
  await expect.poll(async () => restoredTranscript.evaluate((element, expected) => {
    const turn = element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(expected.id)}"]`)
    if (!turn) return Number.POSITIVE_INFINITY
    const turnRect = turn.getBoundingClientRect()
    const scrollerRect = element.getBoundingClientRect()
    return Math.abs((turnRect.top - scrollerRect.top) + turnRect.height * expected.fraction)
  }, saved)).toBeLessThanOrEqual(3)
  const requestsAfterReloadStarted = requestedTurnLimits.slice(requestsBeforeReload)
  const reloadStartIndex = requestsAfterReloadStarted.indexOf(5)
  expect(reloadStartIndex).toBeGreaterThanOrEqual(0)
  const reloadTurnLimits = requestsAfterReloadStarted.slice(reloadStartIndex)
  expect(reloadTurnLimits).toContain(15)
  expect(reloadTurnLimits).toContain(25)
  expect(reloadTurnLimits).toContain(35)
  expect(reloadTurnLimits).toContain(45)
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
  const forkOrigin = forkedPane.getByTestId('code-agent-transcript-fork-origin')
  await expect(forkOrigin).toHaveText('Forked from agent')
  await expect(forkedPane.getByTestId('code-agent-transcript-scroll').locator(
    ':scope > [data-testid="code-agent-transcript-fork-origin"]'
  )).toHaveCount(1)
  await expect(forkOrigin.locator(':scope > span[aria-hidden="true"]')).toHaveCount(2)
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
    element.dispatchEvent(new Event('touchstart', { bubbles: true }))
    element.scrollTop = Math.max(0, bottom - 900)
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    element.dispatchEvent(new Event('touchend', { bubbles: true }))
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

test('keeps following the bottom when a new ACP turn first grows', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'first-refresh-bottom-follow')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  await selectAgentOnCompactLayout(page, agentId)

  const transcript = page.getByTestId('code-agent-transcript-scroll')
  const bottomDistance = () => transcript.evaluate(element => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))

  await page.getByTestId('code-acp-composer-input').fill('scroll stability')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Streaming tail 6', { exact: false })).toBeVisible({ timeout: 15_000 })
  await expect.poll(bottomDistance).toBeLessThanOrEqual(2)

  await transcript.evaluate(element => {
    const latestTurn = element.querySelector<HTMLElement>('.code-agent-transcript-turn:last-child')
    if (!latestTurn) throw new Error('Latest Chat turn is unavailable')
    const delayedContent = document.createElement('div')
    delayedContent.style.height = '480px'
    latestTurn.append(delayedContent)
  })
  await expect.poll(bottomDistance).toBeLessThanOrEqual(2)

  await page.getByTestId('code-acp-composer-input').fill('bottom follow refresh')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Follow paragraph 36', { exact: false })).toBeVisible({ timeout: 10_000 })
  await expect.poll(bottomDistance).toBeLessThanOrEqual(2)
  for (let index = 1; index <= 3; index += 1) {
    await expect(page.getByText(`Follow tail ${index}`, { exact: false })).toBeVisible({ timeout: 10_000 })
    await expect.poll(bottomDistance).toBeLessThanOrEqual(2)
  }
  await expect(page.getByTestId('code-agent-transcript-jump-bottom')).toHaveCount(0)
})
