import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from '../fixtures'

type RenderSnapshot = {
  app: number
  codeWorkspace: number
  completedTranscriptTurn: number
  liveTranscriptTurn: number
  completedTranscriptMarkdown: number
  liveTranscriptMarkdown: number
}

type AcpRevisionFrame = {
  agentId: string
  revision: number
}

type AgentActivityFrame = {
  agentId: string
  lastActivity: number
}

function trackAcpRevisionFrames(page: import('@playwright/test').Page) {
  const frames: AcpRevisionFrame[] = []
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith('/ws')) return
    socket.on('framereceived', event => {
      if (typeof event.payload !== 'string') return
      try {
        const message = JSON.parse(event.payload) as {
          type?: string
          session?: { agentId?: string; revision?: number }
        }
        if (
          message.type === 'acp-session-revision'
          && message.session?.agentId
          && Number.isInteger(message.session.revision)
        ) {
          frames.push({
            agentId: message.session.agentId,
            revision: Number(message.session.revision),
          })
        }
      } catch {
        // Ignore non-JSON frames owned by another WebSocket protocol.
      }
    })
  })
  return frames
}

function trackAgentActivityFrames(page: import('@playwright/test').Page) {
  const frames: AgentActivityFrame[] = []
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith('/ws')) return
    socket.on('framereceived', event => {
      if (typeof event.payload !== 'string') return
      try {
        const message = JSON.parse(event.payload) as {
          type?: string
          activity?: { agentId?: string; lastActivity?: number }
        }
        if (message.type === 'agent-activity' && message.activity?.agentId) {
          frames.push({
            agentId: message.activity.agentId,
            lastActivity: Number(message.activity.lastActivity) || 0,
          })
        }
      } catch {
        // Ignore non-JSON frames owned by another WebSocket protocol.
      }
    })
  })
  return frames
}

function trackServerMessageTypes(page: import('@playwright/test').Page) {
  const types: string[] = []
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith('/ws')) return
    socket.on('framereceived', event => {
      if (typeof event.payload !== 'string') return
      try {
        const message = JSON.parse(event.payload) as { type?: string }
        if (message.type) types.push(message.type)
      } catch {
        // Ignore non-JSON frames owned by another WebSocket protocol.
      }
    })
  })
  return types
}

async function cleanupControlAgents(request: import('@playwright/test').APIRequestContext) {
  const response = await request.get('/farming/api/control/agents').catch(() => null)
  if (!response?.ok()) return
  const data = await response.json() as { agents?: Array<{ id?: string }> }
  await Promise.all((data.agents ?? [])
    .map(agent => agent.id)
    .filter((id): id is string => Boolean(id))
    .map(id => request.delete(`/farming/api/control/agents/${id}`).catch(() => null)))
}

test.beforeEach(async ({ request }) => {
  await cleanupControlAgents(request)
})

test.afterEach(async ({ request }) => {
  await cleanupControlAgents(request)
})

test('live status updates stay within the idle render budget', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page)
  const messageCounts = new Map<string, number>()
  let latestStatePayload = ''
  let baselineStatePayload = ''
  let diagnosticsActive = false
  const stateDiagnostics: Array<{ equalToBaseline: boolean; payloadBytes: number; agentCount: number }> = []
  await cdp.send('Network.enable')
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    try {
      const message = JSON.parse(response.payloadData) as { type?: string }
      const type = message.type || 'unknown'
      messageCounts.set(type, (messageCounts.get(type) || 0) + 1)
      if (type === 'state') {
        const payload = JSON.stringify((message as { state?: unknown }).state)
        latestStatePayload = payload
        if (diagnosticsActive) {
          const state = (message as { state?: { agents?: unknown[] } }).state
          stateDiagnostics.push({
            equalToBaseline: payload === baselineStatePayload,
            payloadBytes: new TextEncoder().encode(payload).length,
            agentCount: Array.isArray(state?.agents) ? state.agents.length : 0,
          })
        }
      }
    } catch {
      messageCounts.set('invalid', (messageCounts.get('invalid') || 0) + 1)
    }
  })
  await openFarming(page)
  await page.waitForFunction(() => Boolean(window.__farmingPerformanceTest))
  await page.waitForTimeout(2_000)
  messageCounts.clear()
  baselineStatePayload = latestStatePayload
  diagnosticsActive = true
  await page.evaluate(() => window.__farmingPerformanceTest?.reset())

  await page.waitForTimeout(3_200)
  const renders = await page.evaluate(() => (
    window.__farmingPerformanceTest?.snapshot() ?? { app: 0, codeWorkspace: 0 }
  )) as RenderSnapshot
  const networkMessages = Object.fromEntries(messageCounts)

  console.log(`performance-budget idle-renders=${JSON.stringify(renders)} network-messages=${JSON.stringify(networkMessages)} state-diagnostics=${JSON.stringify(stateDiagnostics)} windowMs=3200`)
  test.info().annotations.push({
    type: 'performance-budget',
    description: `idle 3.2s App renders=${renders.app}, CodeWorkspace renders=${renders.codeWorkspace}`,
  })

  expect(renders.app).toBeLessThanOrEqual(2)
  expect(renders.codeWorkspace).toBeLessThanOrEqual(2)
})

test('Agent activity updates only the subscribed Agent row', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'agent-activity-render-isolation')
  fs.mkdirSync(workspace, { recursive: true })
  await openFarming(page)
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await page.waitForFunction(() => Boolean(
    window.__farmingPerformanceTest && window.__farmingAgentActivityTest,
  ))
  await page.waitForTimeout(1_000)
  await page.evaluate(() => window.__farmingPerformanceTest?.reset())

  await page.evaluate((id) => {
    for (let index = 0; index < 50; index += 1) {
      window.__farmingAgentActivityTest?.update(id, {
        lastActivity: Date.now() + index,
        activityLevel: index === 49 ? 'hot' : 'warm',
        attentionScore: index,
        isZombie: false,
      })
    }
  }, agentId)

  await expect(row).toHaveAttribute('data-activity-level', 'hot')
  const renders = await page.evaluate(() => (
    window.__farmingPerformanceTest?.snapshot() ?? { app: 0, codeWorkspace: 0 }
  )) as RenderSnapshot
  expect(renders.app).toBe(0)
  expect(renders.codeWorkspace).toBe(0)
})

test('dense Chat revisions preserve completed Turns and coalesce transcript work', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'chat-live-render-budget')
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  const sessionId = `chat-live-render-budget-${agentId}`
  const runtimeEpoch = `chat-live-render-budget-epoch-${agentId}`
  let sourceRevision = 1
  let transcriptRequests = 0
  let gapInjected = false
  let checkpointRecoveries = 0
  let awaitingGapCheckpoint = false

  const transcriptEntries = (revision: number) => [
    ...Array.from({ length: 4 }, (_, index) => ([
      {
        id: `completed-user-${index}`,
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: `Completed question ${index + 1}` }],
      },
      {
        id: `completed-answer-${index}`,
        type: 'message',
        role: 'assistant',
        _meta: { codex: { phase: 'final_answer' } },
        content: [{
          type: 'text',
          text: `Completed answer ${index + 1}.\n\n$E = mc^2$\n\n\`\`\`ts\nconst completedTurn = ${index + 1}\n\`\`\``,
        }],
      },
    ])).flat(),
    {
      id: 'live-user',
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: 'Stream a dense answer.' }],
    },
    {
      id: 'live-answer',
      type: 'message',
      role: 'assistant',
      _meta: { codex: { phase: 'final_answer' } },
      content: [{
        type: 'text',
        text: [
          `## Live revision ${revision}`,
          '',
          ...Array.from({ length: 12 }, (_, index) => (
            `- Revision ${revision} detail ${index + 1}: **bounded Markdown** with $x_${index + 1}^2$.`
          )),
          '',
          '```ts',
          `const liveRevision = ${revision}`,
          '```',
        ].join('\n'),
      }],
    },
  ]

  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    transcriptRequests += 1
    const sinceRevisionValue = new URL(route.request().url()).searchParams.get('sinceRevision')
    const sinceRevision = sinceRevisionValue === null ? null : Number(sinceRevisionValue)
    const replace = sinceRevision === null
    let fromRevision: number | null = replace ? null : sinceRevision
    let toRevision = Math.max(sourceRevision, sinceRevision ?? 0)
    if (!replace && !gapInjected) {
      gapInjected = true
      fromRevision = Number(sinceRevision) + 1
      toRevision = Math.max(toRevision, fromRevision)
      awaitingGapCheckpoint = true
    } else if (replace && awaitingGapCheckpoint) {
      checkpointRecoveries += 1
      awaitingGapCheckpoint = false
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        agentId,
        sessionId,
        runtimeEpoch,
        fromRevision,
        toRevision,
        replace,
        settled: true,
        transcript: {
          sessionId,
          state: 'working',
          revision: toRevision,
          delta: !replace,
          entries: transcriptEntries(toRevision),
        },
      }),
    })
  })

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const readMetrics = async () => {
    const result = await cdp.send('Performance.getMetrics') as {
      metrics: Array<{ name: string; value: number }>
    }
    const metrics = new Map(result.metrics.map(metric => [metric.name, metric.value]))
    return {
      scriptMs: (metrics.get('ScriptDuration') || 0) * 1_000,
      taskMs: (metrics.get('TaskDuration') || 0) * 1_000,
    }
  }

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByRole('heading', { name: 'Live revision 1' })).toBeVisible()
  await page.waitForFunction(() => Boolean(
    window.__farmingPerformanceTest && window.__farmingAgentActivityTest,
  ))
  const controlResponse = await page.request.get('/farming/api/control/agents')
  expect(controlResponse.ok()).toBeTruthy()
  const controlBody = await controlResponse.json() as {
    agents?: Array<{ id?: string; runtimeBinding?: Record<string, unknown> }>
  }
  const runtimeBinding = controlBody.agents?.find(agent => agent.id === agentId)?.runtimeBinding
  expect(runtimeBinding?.kind).toBe('acp')

  transcriptRequests = 0
  checkpointRecoveries = 0
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__farmingPerformanceTest?.reset())
  const metricsBefore = await readMetrics()
  const sourceTimer = setInterval(() => {
    sourceRevision = Math.min(31, sourceRevision + 1)
  }, 33)
  try {
    await page.evaluate(async ({ id, binding }) => {
      await new Promise<void>(resolve => {
        let revision = 2
        const timer = window.setInterval(() => {
          window.__farmingAgentActivityTest?.update(id, {
            runtimeBinding: {
              ...binding,
              sessionRevision: revision,
              sessionUpdatedAt: new Date().toISOString(),
            },
          })
          if (revision >= 31) {
            window.clearInterval(timer)
            resolve()
          }
          revision += 1
        }, 33)
      })
    }, { id: agentId, binding: runtimeBinding })
  } finally {
    clearInterval(sourceTimer)
  }
  sourceRevision = 32
  await page.evaluate(({ id, binding }) => {
    window.__farmingAgentActivityTest?.update(id, {
      runtimeBinding: {
        ...binding,
        sessionRevision: 32,
        sessionUpdatedAt: new Date().toISOString(),
      },
    })
  }, { id: agentId, binding: runtimeBinding })

  await expect(page.getByRole('heading', { name: 'Live revision 32' })).toBeVisible()
  await expect.poll(() => checkpointRecoveries).toBe(1)
  await page.waitForTimeout(250)
  const metricsAfter = await readMetrics()
  const renders = await page.evaluate(() => window.__farmingPerformanceTest?.snapshot()) as RenderSnapshot
  const result = {
    transcriptRequests,
    checkpointRecoveries,
    finalRevision: 32,
    renderCounts: renders,
    scriptMs: Math.max(0, metricsAfter.scriptMs - metricsBefore.scriptMs),
    taskMs: Math.max(0, metricsAfter.taskMs - metricsBefore.taskMs),
  }
  console.log(`performance-chat-live ${JSON.stringify(result)}`)
  testInfo.annotations.push({
    type: 'performance-budget',
    description: `dense Chat GETs=${transcriptRequests}, completed Turn renders=${renders.completedTranscriptTurn}, completed Markdown renders=${renders.completedTranscriptMarkdown}`,
  })
  await testInfo.attach('performance-chat-live.json', {
    body: Buffer.from(`${JSON.stringify(result, null, 2)}\n`),
    contentType: 'application/json',
  })

  expect(renders.completedTranscriptTurn).toBe(0)
  expect(renders.completedTranscriptMarkdown).toBe(0)
  expect(renders.liveTranscriptTurn).toBeLessThanOrEqual(40)
  expect(renders.liveTranscriptMarkdown).toBeLessThanOrEqual(40)
  expect(transcriptRequests).toBeLessThanOrEqual(16)
})

test('routes ACP revisions only to focused browsers and restores focus after reconnect', async ({ page, browser, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'acp-revision-interest')
  fs.mkdirSync(workspace, { recursive: true })
  const createAgent = async (name: string) => {
    const agentWorkspace = path.join(workspace, name)
    fs.mkdirSync(agentWorkspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: {
        command: 'claude',
        workspace: agentWorkspace,
        agentRuntimeMode: 'chat',
      },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json() as { agentId?: string }
    expect(body.agentId).toBeTruthy()
    return body.agentId as string
  }
  const firstAgentId = await createAgent('first')
  const secondAgentId = await createAgent('second')
  const firstFrames = trackAcpRevisionFrames(page)

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`).click()
  await expect(page.getByTestId('code-acp-composer-input')).toBeEditable()
  await expect.poll(() => firstFrames.filter(frame => frame.agentId === firstAgentId).length)
    .toBeGreaterThan(0)

  const secondContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const secondPage = await secondContext.newPage()
    const secondFrames = trackAcpRevisionFrames(secondPage)
    await secondPage.goto('/farming/', { waitUntil: 'domcontentloaded' })
    await expect(secondPage.getByTestId('app-shell')).toBeVisible()
    await secondPage.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`).click()
    await expect(secondPage.getByTestId('code-acp-composer-input')).toBeEditable()
    await expect.poll(() => secondFrames.filter(frame => frame.agentId === secondAgentId).length)
      .toBeGreaterThan(0)
    firstFrames.length = 0
    secondFrames.length = 0

    const firstPrompt = await page.request.post(
      `/farming/api/control/agents/${firstAgentId}/messages`,
      {
        data: {
          message: 'live commentary stream',
          requestId: 'revision-interest-first',
          delivery: 'prompt',
        },
      },
    )
    expect(firstPrompt.status()).toBe(202)
    await expect(page.getByText('Live commentary stream complete.', { exact: true })).toBeVisible()
    await expect.poll(() => firstFrames.filter(frame => frame.agentId === firstAgentId).length)
      .toBeGreaterThan(0)
    await secondPage.waitForTimeout(150)
    expect(secondFrames.filter(frame => frame.agentId === firstAgentId)).toHaveLength(0)

    const secondCheckpointStart = secondFrames.length
    await secondPage.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`).click()
    await expect.poll(() => secondFrames.slice(secondCheckpointStart)
      .filter(frame => frame.agentId === firstAgentId).length).toBeGreaterThan(0)
    await expect(secondPage.getByText('Live commentary stream complete.', { exact: true })).toBeVisible()

    await secondPage.getByTestId('code-nav-history').click()
    await expect(secondPage.getByTestId('code-history-panel')).toBeVisible()
    const firstReconnectStart = firstFrames.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(() => firstFrames.slice(firstReconnectStart)
      .filter(frame => frame.agentId === firstAgentId).length).toBeGreaterThan(0)

    const firstSecondPromptStart = firstFrames.length
    const secondSecondPromptStart = secondFrames.length
    const secondPrompt = await page.request.post(
      `/farming/api/control/agents/${firstAgentId}/messages`,
      {
        data: {
          message: 'streaming thought',
          requestId: 'revision-interest-second',
          delivery: 'prompt',
        },
      },
    )
    expect(secondPrompt.status()).toBe(202)
    await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible()
    await expect.poll(() => firstFrames.slice(firstSecondPromptStart)
      .filter(frame => frame.agentId === firstAgentId).length).toBeGreaterThan(0)
    await secondPage.waitForTimeout(150)
    expect(secondFrames.slice(secondSecondPromptStart)
      .filter(frame => frame.agentId === firstAgentId)).toHaveLength(0)
  } finally {
    await secondContext.close()
  }
})

test('routes Agent activity by browser view without hiding Project supervision', async ({ page, browser, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'agent-activity-interest')
  fs.mkdirSync(workspace, { recursive: true })
  const createResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(createResponse.ok()).toBeTruthy()
  const { agentId } = await createResponse.json() as { agentId: string }
  const firstFrames = trackAgentActivityFrames(page)

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()

  const secondContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const secondPage = await secondContext.newPage()
    const secondFrames = trackAgentActivityFrames(secondPage)
    const secondMessageTypes = trackServerMessageTypes(secondPage)
    await secondPage.goto('/farming/', { waitUntil: 'domcontentloaded' })
    await expect(secondPage.getByTestId('app-shell')).toBeVisible()

    const triggerActivity = async (marker: string) => {
      const response = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
        data: { input: `printf '${marker}\\n'\r` },
      })
      expect(response.ok()).toBeTruthy()
    }

    await page.waitForTimeout(1_100)
    firstFrames.length = 0
    secondFrames.length = 0
    await triggerActivity('ACTIVITY_SCOPE_PROJECTS')
    await expect.poll(() => firstFrames.filter(frame => frame.agentId === agentId).length).toBeGreaterThan(0)
    await expect.poll(() => secondFrames.filter(frame => frame.agentId === agentId).length).toBeGreaterThan(0)

    await secondPage.getByTestId('code-nav-history').click()
    await expect(secondPage.getByTestId('code-history-panel')).toBeVisible()
    await page.waitForTimeout(1_100)
    const firstHistoryStart = firstFrames.length
    const secondHistoryStart = secondFrames.length
    await triggerActivity('ACTIVITY_SCOPE_HISTORY')
    await expect.poll(() => firstFrames.slice(firstHistoryStart)
      .filter(frame => frame.agentId === agentId).length).toBeGreaterThan(0)
    await secondPage.waitForTimeout(250)
    expect(secondFrames.slice(secondHistoryStart)
      .filter(frame => frame.agentId === agentId)).toHaveLength(0)

    const returnMessageStart = secondMessageTypes.length
    await secondPage.getByTestId('code-history-back').click()
    await expect(secondPage.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)).toBeVisible()
    await expect.poll(() => secondMessageTypes.slice(returnMessageStart)
      .filter(type => type === 'agent-activity-snapshot').length).toBe(1)
    expect(secondMessageTypes.slice(returnMessageStart).filter(type => type === 'state')).toHaveLength(0)
    await page.waitForTimeout(1_100)
    const firstReturnStart = firstFrames.length
    const secondReturnStart = secondFrames.length
    await triggerActivity('ACTIVITY_SCOPE_RETURN')
    await expect.poll(() => firstFrames.slice(firstReturnStart)
      .filter(frame => frame.agentId === agentId).length).toBeGreaterThan(0)
    await expect.poll(() => secondFrames.slice(secondReturnStart)
      .filter(frame => frame.agentId === agentId).length).toBeGreaterThan(0)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.waitForTimeout(1_100)
    const reconnectStart = firstFrames.length
    await triggerActivity('ACTIVITY_SCOPE_RECONNECT')
    await expect.poll(() => firstFrames.slice(reconnectStart)
      .filter(frame => frame.agentId === agentId).length).toBeGreaterThan(0)
  } finally {
    await secondContext.close()
  }
})

test('scopes CRT Agent activity to the dashboard or open Session', async ({ page, browser, workspaceRoot }) => {
  test.setTimeout(60_000)
  const workspace = path.join(workspaceRoot, 'crt-agent-activity-interest')
  fs.mkdirSync(workspace, { recursive: true })
  const createAgent = async (name: string) => {
    const agentWorkspace = path.join(workspace, name)
    fs.mkdirSync(agentWorkspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace: agentWorkspace },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json() as { agentId?: string }
    expect(body.agentId).toBeTruthy()
    return body.agentId as string
  }
  const firstAgentId = await createAgent('first')
  const secondAgentId = await createAgent('second')
  const frames = trackAgentActivityFrames(page)
  const triggerActivity = async (agentId: string, marker: string) => {
    const response = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
      data: { input: `printf '${marker}\\n'\r` },
    })
    expect(response.ok()).toBeTruthy()
  }

  await page.goto('/farming/crt/', { waitUntil: 'networkidle' })
  const firstCard = page.locator(`#map-area .agent-block[data-agent-id="${firstAgentId}"]`)
  await expect(firstCard).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(`#map-area .agent-block[data-agent-id="${secondAgentId}"]`)).toBeVisible()

  await page.waitForTimeout(1_100)
  frames.length = 0
  await triggerActivity(firstAgentId, 'CRT_ACTIVITY_DASHBOARD_FIRST')
  await expect.poll(() => frames.filter(frame => frame.agentId === firstAgentId).length).toBeGreaterThan(0)
  await triggerActivity(secondAgentId, 'CRT_ACTIVITY_DASHBOARD_SECOND')
  await expect.poll(() => frames.filter(frame => frame.agentId === secondAgentId).length).toBeGreaterThan(0)

  const observerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const observerPage = await observerContext.newPage()
    const observerFrames = trackAgentActivityFrames(observerPage)
    await observerPage.goto('/farming/crt/', { waitUntil: 'networkidle' })
    await expect(observerPage.locator(`#map-area .agent-block[data-agent-id="${secondAgentId}"]`)).toBeVisible()

    await firstCard.click()
    await expect(page.locator('#session-modal')).toHaveClass(/active/)
    await page.waitForTimeout(1_100)
    const focusedStart = frames.length
    const observerStart = observerFrames.length
    await triggerActivity(secondAgentId, 'CRT_ACTIVITY_OTHER_SESSION')
    await expect.poll(() => observerFrames.slice(observerStart)
      .filter(frame => frame.agentId === secondAgentId).length).toBeGreaterThan(0)
    await page.waitForTimeout(150)
    expect(frames.slice(focusedStart).filter(frame => frame.agentId === secondAgentId)).toHaveLength(0)

    const focusedAgentStart = frames.length
    await triggerActivity(firstAgentId, 'CRT_ACTIVITY_FOCUSED_SESSION')
    await expect.poll(() => frames.slice(focusedAgentStart)
      .filter(frame => frame.agentId === firstAgentId).length).toBeGreaterThan(0)

    await page.keyboard.press('Control+Escape')
    await expect(page.locator('#session-modal')).not.toHaveClass(/active/)
    await page.waitForTimeout(1_100)
    const dashboardReturnStart = frames.length
    await triggerActivity(secondAgentId, 'CRT_ACTIVITY_DASHBOARD_RETURN')
    await expect.poll(() => frames.slice(dashboardReturnStart)
      .filter(frame => frame.agentId === secondAgentId).length).toBeGreaterThan(0)
  } finally {
    await observerContext.close()
  }
})

test('parked Agent output does not update workspace roots', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'parked-agent-output-isolation')
  fs.mkdirSync(workspace, { recursive: true })
  const frames: Array<{ type: string; agentId: string }> = []
  page.on('websocket', socket => {
    socket.on('framereceived', ({ payload }) => {
      const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
      try {
        const message = JSON.parse(text) as {
          type?: string
          preview?: { agentId?: string }
          update?: { agentId?: string }
          activity?: { agentId?: string }
        }
        frames.push({
          type: message.type || 'unknown',
          agentId: message.preview?.agentId || message.update?.agentId || message.activity?.agentId || '',
        })
      } catch {
        frames.push({ type: 'invalid', agentId: '' })
      }
    })
  })

  await openFarming(page)
  const createAgent = async () => {
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json() as { agentId?: string }
    expect(body.agentId).toBeTruthy()
    return body.agentId as string
  }
  const parkedAgentId = await createAgent()
  const activeAgentId = await createAgent()
  const activeRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${activeAgentId}"]`)
  await expect(activeRow).toBeVisible({ timeout: 30_000 })
  await activeRow.click()
  await expect(activeRow).toHaveClass(/active/, { timeout: 30_000 })
  await page.waitForTimeout(2_000)
  frames.length = 0
  await page.evaluate(() => window.__farmingPerformanceTest?.reset())

  const inputResponse = await page.request.post(`/farming/api/control/agents/${parkedAgentId}/input`, {
    data: { input: "printf '__FARMING_PARKED_AGENT__\\n'\r" },
  })
  expect(inputResponse.ok()).toBeTruthy()
  await expect.poll(() => frames.some(frame => (
    frame.type === 'agent-activity' && frame.agentId === parkedAgentId
  )), { timeout: 15_000 }).toBe(true)
  await page.waitForTimeout(100)

  const renders = await page.evaluate(() => (
    window.__farmingPerformanceTest?.snapshot() ?? { app: 0, codeWorkspace: 0 }
  )) as RenderSnapshot
  expect(frames.filter(frame => frame.type === 'state')).toHaveLength(0)
  expect(frames.filter(frame => frame.type === 'state-delta')).toHaveLength(0)
  expect(frames.filter(frame => (
    frame.type === 'session-preview' && frame.agentId === parkedAgentId
  ))).toHaveLength(0)
  expect(renders.app).toBe(0)
  expect(renders.codeWorkspace).toBe(0)
})
