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

test('keeps ACP Chat live while the browser page is hidden', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'background-chat-continuity')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  let backendSocketClosed = 0

  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith('/ws')) return
    socket.on('close', () => { backendSocketClosed += 1 })
  })

  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
  await expect(page.getByTestId('connection-status')).toHaveCount(0)

  const composerInput = page.getByTestId('code-acp-composer-input')
  await composerInput.fill('draft survives composer collapse')
  await page.locator('.code-composer-collapse-zone').hover()
  await page.getByTestId('code-composer-collapse').click()
  await expect(page.getByTestId('code-acp-composer')).toHaveCount(0)
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
  await page.getByTestId('code-composer-restore').click()
  await expect(composerInput).toHaveValue('draft survives composer collapse')
  await composerInput.fill('')

  await composerInput.fill('streaming thought')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('streaming thought', { exact: true })).toBeVisible()

  await setPageVisibility(page, 'hidden')
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden')

  await page.waitForTimeout(1_800)
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden')
  expect(await page.getByText('Streaming thought complete.', { exact: true }).count()).toBe(1)
  expect(backendSocketClosed).toBe(0)

  await setPageVisibility(page, 'visible')
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
  await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible()
  await expect(page.getByTestId('connection-status')).toHaveCount(0)
  expect(backendSocketClosed).toBe(0)
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
  const firstScroll = firstPane.getByTestId('code-codex-transcript-scroll')
  await expect(firstPane.getByText('FIRST cached answer 19.', { exact: false })).toBeVisible()
  const firstProcessSummary = firstPane.getByTestId('code-codex-transcript-process-summary').last()
  await firstProcessSummary.click()
  await expect(firstProcessSummary).toHaveAttribute('aria-expanded', 'true')
  const savedScrollTop = await firstScroll.evaluate(element => {
    element.closest<HTMLElement>('[data-testid="code-agent-work-pane"]')!.dataset.cacheProbe = 'retained'
    const sentinel = Array.from(element.querySelectorAll<HTMLElement>('.code-codex-transcript-assistant'))
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
    const scroller = pane?.querySelector<HTMLElement>('[data-testid="code-codex-transcript-scroll"]')
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
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const transcriptScroll = page.getByTestId('code-codex-transcript-scroll')
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
  await expect(page.getByTestId('code-codex-transcript-jump-bottom')).toBeVisible()
})

test('starts a short ACP turn at the top with a compact copy affordance', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'compact-chat-tail')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible()
  await row.click()

  await page.getByTestId('code-acp-composer-input').fill('image attachment')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Received 0 image.', { exact: true })).toBeVisible()

  const geometry = await page.getByTestId('code-codex-transcript-copy-answer').evaluate(element => {
    const action = element.getBoundingClientRect()
    const icon = element.querySelector('svg')?.getBoundingClientRect()
    const turn = element.closest<HTMLElement>('.code-codex-transcript-turn')
    const user = turn?.querySelector<HTMLElement>('.code-codex-transcript-user')?.getBoundingClientRect()
    const answer = turn?.querySelector<HTMLElement>('.code-codex-transcript-answer')?.getBoundingClientRect()
    const scroller = element.closest<HTMLElement>('.code-codex-transcript-scroll')?.getBoundingClientRect()
    const composer = document.querySelector<HTMLElement>('.code-composer')?.getBoundingClientRect()
    if (!icon || !user || !answer || !scroller || !composer) {
      throw new Error('Chat turn geometry is unavailable')
    }
    return {
      actionWidth: action.width,
      actionHeight: action.height,
      iconWidth: icon.width,
      iconHeight: icon.height,
      userTopOffset: user.top - scroller.top,
      answerGap: answer.top - user.bottom,
      composerGap: composer.top - action.bottom,
    }
  })

  expect(geometry.userTopOffset).toBeGreaterThanOrEqual(30)
  expect(geometry.userTopOffset).toBeLessThanOrEqual(60)
  expect(geometry.answerGap).toBeGreaterThanOrEqual(16)
  expect(geometry.answerGap).toBeLessThanOrEqual(28)
  expect(geometry.composerGap).toBeGreaterThan(200)
  expect(geometry).toMatchObject({
    actionWidth: 20,
    actionHeight: 20,
    iconWidth: 14,
    iconHeight: 14,
  })
})

test('keeps a human reader stationary while an ACP answer streams below', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'streaming-reader-scroll-stability')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible()
  await row.click()

  const transcript = page.getByTestId('code-codex-transcript-scroll')
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
  await expect(page.getByTestId('code-codex-transcript-jump-bottom')).toBeVisible()

  for (let index = 1; index <= 6; index += 1) {
    await expect(page.getByText(`Streaming tail ${index}`, { exact: false })).toBeAttached({ timeout: 10_000 })
    const positionDelta = Math.abs(
      (await transcript.evaluate(element => element.scrollTop)) - readingPosition,
    )
    expect(positionDelta).toBeLessThanOrEqual(1)
  }

  await page.getByTestId('code-codex-transcript-jump-bottom').click()
  await expect.poll(async () => transcript.evaluate(element => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(1)
})
