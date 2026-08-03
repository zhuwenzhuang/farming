import fs from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page, Request, WebSocket } from '@playwright/test'
import { expect, openFarming, test } from '../fixtures'

const AGENT_COUNT = Math.max(1, Number(process.env.FARMING_ACP_SCALE_AGENT_COUNT) || 120)
const CREATE_BATCH_SIZE = Math.max(1, Number(process.env.FARMING_ACP_SCALE_CREATE_BATCH_SIZE) || 12)
const OPEN_SAMPLE_COUNT = Math.max(1, Number(process.env.FARMING_ACP_SCALE_OPEN_SAMPLE_COUNT) || 1)
const SCALE_MODEL = String(process.env.FARMING_ACP_SCALE_MODEL || '').trim()
const SCALE_REASONING = String(process.env.FARMING_ACP_SCALE_REASONING || 'low').trim()
const SCALE_SERVICE_TIER = String(process.env.FARMING_ACP_SCALE_SERVICE_TIER || 'default').trim()
const SCALE_PROVIDER_HOME_PATH = String(process.env.FARMING_ACP_SCALE_PROVIDER_HOME_PATH || '').trim()
const SEND_PROMPTS = process.env.FARMING_ACP_SCALE_SEND_PROMPTS !== '0'
const TURN_TIMEOUT_MS = Math.max(
  120_000,
  Number(process.env.FARMING_ACP_SCALE_TURN_TIMEOUT_MS) || AGENT_COUNT * 10_000,
)

type WireFrame = {
  at: number
  type: string
  bytes: number
  agentId: string
  stateAgents?: Array<{
    attentionSeq: number
    id: string
    providerSessionId: string
    providerSessionTitle: string
    runtimeState: string
    sessionTitle: string
  }>
}

type ScaleConfigOption = {
  category?: string
  currentValue?: unknown
  id?: string
  name?: string
  type?: string
}

type BrowserMetrics = {
  jsHeapUsedBytes: number
  nodes: number
  scriptDurationMs: number
  taskDurationMs: number
}

function byteLength(payload: string | Buffer) {
  return Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload)
}

function trackWireFrames(page: Page) {
  const frames: WireFrame[] = []
  const record = (payload: string | Buffer) => {
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
    try {
      const message = JSON.parse(text) as {
        type?: string
        update?: { agentId?: string }
        session?: { agentId?: string }
        read?: { agentId?: string }
        state?: {
          agents?: Array<{
            attentionSeq?: number
            id?: string
            providerSessionId?: string
            providerSessionTitle?: string
            runtimeBinding?: { state?: string }
            sessionTitle?: string
          }>
        }
      }
      frames.push({
        at: performance.now(),
        type: message.type || 'unknown',
        bytes: byteLength(payload),
        agentId: message.update?.agentId || message.session?.agentId || message.read?.agentId || '',
        ...(message.type === 'state' ? {
          stateAgents: (message.state?.agents || []).slice(-3).map(agent => ({
            attentionSeq: Number(agent.attentionSeq) || 0,
            id: agent.id || '',
            providerSessionId: agent.providerSessionId || '',
            providerSessionTitle: agent.providerSessionTitle || '',
            runtimeState: agent.runtimeBinding?.state || '',
            sessionTitle: agent.sessionTitle || '',
          })),
        } : {}),
      })
    } catch {
      frames.push({ at: performance.now(), type: 'invalid', bytes: byteLength(payload), agentId: '' })
    }
  }
  page.on('websocket', (socket: WebSocket) => {
    socket.on('framereceived', event => record(event.payload))
  })
  return frames
}

async function browserMetrics(cdp: CDPSession): Promise<BrowserMetrics> {
  const response = await cdp.send('Performance.getMetrics') as {
    metrics: Array<{ name: string; value: number }>
  }
  const metrics = new Map(response.metrics.map(metric => [metric.name, metric.value]))
  return {
    jsHeapUsedBytes: metrics.get('JSHeapUsedSize') || 0,
    nodes: metrics.get('Nodes') || 0,
    scriptDurationMs: (metrics.get('ScriptDuration') || 0) * 1000,
    taskDurationMs: (metrics.get('TaskDuration') || 0) * 1000,
  }
}

function messageStats(frames: WireFrame[]) {
  const count: Record<string, number> = {}
  const bytes: Record<string, number> = {}
  frames.forEach(frame => {
    count[frame.type] = (count[frame.type] || 0) + 1
    bytes[frame.type] = (bytes[frame.type] || 0) + frame.bytes
  })
  return { count, bytes }
}

async function waitForWireQuiet(frames: WireFrame[], quietMs = 750, timeoutMs = 30_000) {
  const startedAt = performance.now()
  let observedLength = frames.length
  let quietStartedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    if (frames.length !== observedLength) {
      const relevant = frames.slice(observedLength).some(frame => (
        frame.type === 'state'
        || frame.type === 'agent-update'
        || frame.type === 'acp-session-revision'
        || frame.type === 'agent-read'
      ))
      observedLength = frames.length
      if (relevant) quietStartedAt = performance.now()
    }
    if (performance.now() - quietStartedAt >= quietMs) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`ACP scale wire activity did not settle within ${timeoutMs}ms`)
}

async function createAcpAgents(page: Page, workspace: string, count: number) {
  const agentIds: string[] = []
  for (let offset = 0; offset < count; offset += CREATE_BATCH_SIZE) {
    const batchSize = Math.min(CREATE_BATCH_SIZE, count - offset)
    const batch = await Promise.all(Array.from({ length: batchSize }, async () => {
      const response = await page.request.post('/farming/api/control/agents', {
        data: {
          command: 'codex',
          workspace,
          agentRuntimeMode: 'chat',
        },
      })
      expect(response.ok()).toBeTruthy()
      const body = await response.json() as { agentId?: string }
      expect(body.agentId).toBeTruthy()
      return body.agentId as string
    }))
    agentIds.push(...batch)
  }
  return agentIds
}

async function configureScaleProfile(page: Page) {
  if (!SCALE_MODEL) return
  if (SCALE_PROVIDER_HOME_PATH) {
    expect(path.isAbsolute(SCALE_PROVIDER_HOME_PATH), 'scale Provider Home must be an absolute path').toBe(true)
    const currentResponse = await page.request.get('/farming/api/settings')
    expect(currentResponse.ok()).toBeTruthy()
    const current = await currentResponse.json() as {
      agentHomes?: Record<string, Array<{
        id?: string
        path?: string
        order?: number
        newAgentDefaults?: { model?: string; reasoning?: string; fast?: string }
      }>>
    }
    const agentHomes = current.agentHomes && typeof current.agentHomes === 'object'
      ? current.agentHomes
      : {}
    const codexHomes = Array.isArray(agentHomes.codex) ? agentHomes.codex : []
    const defaultHome = codexHomes.find(home => home.id === 'default')
    const homeResponse = await page.request.post('/farming/api/settings', {
      data: {
        agentHomes: {
          ...agentHomes,
          codex: [
            {
              ...defaultHome,
              id: 'default',
              path: SCALE_PROVIDER_HOME_PATH,
              order: Number.isFinite(defaultHome?.order) ? defaultHome?.order : 0,
              newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
            },
            ...codexHomes.filter(home => home.id !== 'default'),
          ],
        },
      },
    })
    expect(homeResponse.ok()).toBeTruthy()
  }
  const catalogResponse = await page.request.get('/farming/api/codex/models')
  expect(catalogResponse.ok()).toBeTruthy()
  const body = await catalogResponse.json() as {
    catalog?: Array<{
      value?: string
      reasoningLevels?: Array<{ value?: string }>
      serviceTiers?: Array<{ value?: string }>
    }>
  }
  const model = body.catalog?.find(candidate => candidate.value === SCALE_MODEL)
  expect(model, `${SCALE_MODEL} must exist in the live Codex catalog`).toBeTruthy()
  expect(
    model?.reasoningLevels?.some(level => level.value === SCALE_REASONING),
    `${SCALE_MODEL} must support ${SCALE_REASONING} reasoning`,
  ).toBe(true)
  expect(
    model?.serviceTiers?.some(tier => tier.value === SCALE_SERVICE_TIER),
    `${SCALE_MODEL} must support the ${SCALE_SERVICE_TIER} service tier`,
  ).toBe(true)
  const settingsResponse = await page.request.post('/farming/api/settings', {
    data: {
      codexModel: SCALE_MODEL,
      codexReasoningEffort: SCALE_REASONING,
      codexServiceTier: SCALE_SERVICE_TIER,
      codexModelPreset: `${SCALE_MODEL}:${SCALE_REASONING}`,
      agentLaunchProfiles: {
        codex: {
          approvalMode: 'approve',
          model: SCALE_MODEL,
          reasoningEffort: SCALE_REASONING,
          serviceTier: SCALE_SERVICE_TIER,
          modelPreset: `${SCALE_MODEL}:${SCALE_REASONING}`,
        },
      },
    },
  })
  expect(settingsResponse.ok()).toBeTruthy()
}

function uniformSamples<T>(values: T[], requestedCount: number): T[] {
  const count = Math.min(Math.max(1, requestedCount), values.length)
  return Array.from({ length: count }, (_, index) => (
    values[Math.round(index * (values.length - 1) / Math.max(1, count - 1))]
  )).filter((value, index, samples) => samples.indexOf(value) === index)
}

async function assertScaleProfileApplied(page: Page, agentIds: string[]) {
  if (!SCALE_MODEL) return []
  const expectedFast = ['fast', 'priority'].includes(SCALE_SERVICE_TIER)
  return Promise.all(uniformSamples(agentIds, Math.max(3, OPEN_SAMPLE_COUNT)).map(async agentId => {
    const response = await page.request.get(
      `/farming/api/agents/${encodeURIComponent(agentId)}/acp-session?includeEntries=0`,
    )
    expect(response.ok()).toBeTruthy()
    const body = await response.json() as { session?: { configOptions?: ScaleConfigOption[] } }
    const options = Array.isArray(body.session?.configOptions) ? body.session.configOptions : []
    const model = options.find(option => (
      option.type === 'select'
      && (option.category === 'model' || /model/i.test(`${option.id || ''} ${option.name || ''}`))
    ))
    const reasoning = options.find(option => (
      option.type === 'select'
      && (
        option.category === 'thought_level'
        || /(reasoning|thought|effort)/i.test(`${option.id || ''} ${option.name || ''}`)
      )
    ))
    const fast = options.find(option => (
      option.type === 'boolean'
      && /fast/i.test(`${option.id || ''} ${option.name || ''} ${option.category || ''}`)
    ))
    expect(model, `${agentId} must expose a model config option`).toBeTruthy()
    expect(reasoning, `${agentId} must expose a reasoning config option`).toBeTruthy()
    expect(fast, `${agentId} must expose a Fast config option`).toBeTruthy()
    expect(model?.currentValue).toBe(SCALE_MODEL)
    expect(reasoning?.currentValue).toBe(SCALE_REASONING)
    expect(fast?.currentValue).toBe(expectedFast)
    return {
      agentId,
      fast: fast?.currentValue,
      model: model?.currentValue,
      reasoning: reasoning?.currentValue,
    }
  }))
}

test(`keeps ${AGENT_COUNT} simultaneously working ACP Agents on scoped browser updates`, async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(Math.max(300_000, AGENT_COUNT * 5_000 + (SEND_PROMPTS ? TURN_TIMEOUT_MS : 0)))
  const workspace = path.join(workspaceRoot, 'acp-agent-scoped-scale')
  fs.mkdirSync(workspace, { recursive: true })

  const frames = trackWireFrames(page)
  const inFlightRequests = new Map<Request, number>()
  page.on('request', request => inFlightRequests.set(request, performance.now()))
  page.on('requestfinished', request => inFlightRequests.delete(request))
  page.on('requestfailed', request => inFlightRequests.delete(request))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await configureScaleProfile(page)
  await openFarming(page)
  await page.waitForFunction(() => Boolean(window.__farmingPerformanceTest))

  const createStartedAt = performance.now()
  const agentIds = await createAcpAgents(page, workspace, AGENT_COUNT)
  const createMs = performance.now() - createStartedAt
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/control/agents')
    if (!response.ok()) return -1
    const body = await response.json() as {
      agents?: Array<{ isMain?: boolean; runtimeBinding?: { kind?: string; state?: string } }>
    }
    return body.agents?.filter(agent => (
      agent.isMain !== true
      && agent.runtimeBinding?.kind === 'acp'
      && agent.runtimeBinding.state === 'idle'
    )).length ?? 0
  }, { timeout: Math.max(120_000, AGENT_COUNT * 2_000) }).toBe(AGENT_COUNT)
  const profileSamples = await assertScaleProfileApplied(page, agentIds)
  await waitForWireQuiet(frames)

  await cdp.send('HeapProfiler.collectGarbage')
  const settledMetrics = await browserMetrics(cdp)
  await page.evaluate(() => window.__farmingPerformanceTest?.reset())
  const turnFrameStart = frames.length
  const turnMetricsBefore = await browserMetrics(cdp)
  const turnStartedAt = performance.now()
  if (SEND_PROMPTS) {
    const responses = await Promise.all(agentIds.map(async (agentId, index) => {
      const response = await page.request.post(`/farming/api/control/agents/${agentId}/messages`, {
        data: {
          message: SCALE_MODEL
            ? 'Reply with exactly "Streaming thought complete." and no other text.'
            : `streaming thought scale ${index + 1}`,
          requestId: `acp-scale-${index + 1}`,
          delivery: 'prompt',
        },
        timeout: 120_000,
      })
      return {
        agentId,
        response,
        body: await response.text(),
      }
    }))
    responses.forEach(({ agentId, response, body }) => {
      expect(response.status(), `${agentId} prompt failed: ${body}`).toBe(202)
    })

    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/control/agents')
      if (!response.ok()) return -1
      const body = await response.json() as {
        agents?: Array<{
          id?: string
          attentionSeq?: number
          runtimeBinding?: { kind?: string; state?: string }
        }>
      }
      const targetIds = new Set(agentIds)
      return body.agents?.filter(agent => (
        targetIds.has(agent.id || '')
        && agent.attentionSeq === 1
        && agent.runtimeBinding?.kind === 'acp'
        && agent.runtimeBinding.state === 'idle'
      )).length ?? 0
    }, { timeout: TURN_TIMEOUT_MS }).toBe(AGENT_COUNT)
  }
  const turnMs = performance.now() - turnStartedAt
  await page.waitForTimeout(250)

  const turnMetricsAfter = await browserMetrics(cdp)
  const turnRenders = await page.evaluate(() => (
    window.__farmingPerformanceTest?.snapshot() ?? { app: 0, codeWorkspace: 0 }
  ))
  const turnFrames = frames.slice(turnFrameStart)
  const wire = messageStats(turnFrames)
  const runtimeUpdatedAgentCount = new Set(turnFrames
    .filter(frame => frame.type === 'agent-update')
    .map(frame => frame.agentId)).size
  const readUpdatedAgentCount = new Set(turnFrames
    .filter(frame => frame.type === 'agent-read')
    .map(frame => frame.agentId)).size
  const unexpectedStateFrames = turnFrames
    .filter(frame => frame.type === 'state')
    .map(frame => ({ at: frame.at, bytes: frame.bytes, agents: frame.stateAgents || [] }))

  const directProbeAgentId = (agentIds.at(-2) || agentIds.at(-1)) as string
  const directTranscriptStartedAt = performance.now()
  const directTranscriptResponse = await page.request.get(
    `/farming/api/agents/${directProbeAgentId}/acp-transcript?maxTurns=20&media=external-v1`,
  )
  const directTranscriptMs = performance.now() - directTranscriptStartedAt
  expect(directTranscriptResponse.ok()).toBeTruthy()

  const collapsedAgentGroups = page.getByTestId('code-agent-show-more')
  while (await collapsedAgentGroups.count()) {
    await collapsedAgentGroups.first().click()
  }
  const targetAgentId = agentIds.at(-1) as string
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${targetAgentId}"]`)
  await row.scrollIntoViewIfNeeded()
  const inFlightBeforeOpen = [...inFlightRequests.entries()].map(([request, startedAt]) => ({
    ageMs: performance.now() - startedAt,
    method: request.method(),
    url: request.url(),
  }))
  const transcriptRequestStartedAt = new Map<Request, number>()
  const transcriptResponseDurationsMs: number[] = []
  page.on('request', request => {
    if (request.url().includes(`/api/agents/${targetAgentId}/acp-transcript?`)) {
      transcriptRequestStartedAt.set(request, performance.now())
    }
  })
  page.on('response', response => {
    const startedAt = transcriptRequestStartedAt.get(response.request())
    if (startedAt === undefined) return
    transcriptRequestStartedAt.delete(response.request())
    transcriptResponseDurationsMs.push(performance.now() - startedAt)
  })
  await row.evaluate(element => {
    performance.mark('farming-acp-scale-open-start')
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    const target = element as HTMLElement
    target.click()
  })
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
  const chatShellOpenMs = await page.evaluate(() => {
    const mark = performance.getEntriesByName('farming-acp-scale-open-start').at(-1)
    return mark ? performance.now() - mark.startTime : -1
  })
  if (SEND_PROMPTS) {
    await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible()
  }
  const browserOpenTiming = await page.evaluate(agentId => {
    const mark = performance.getEntriesByName('farming-acp-scale-open-start').at(-1)
    const resource = performance.getEntriesByType('resource')
      .filter(entry => (
        entry.name.includes(`/api/agents/${agentId}/acp-transcript?`)
        && Boolean(mark && entry.startTime >= mark.startTime)
      ))
      .at(-1) as PerformanceResourceTiming | undefined
    return {
      openChatMs: mark ? performance.now() - mark.startTime : -1,
      transcriptRequestStartMs: mark && resource ? resource.startTime - mark.startTime : -1,
      transcriptBrowserDurationMs: resource?.duration ?? -1,
      transcriptResponseEndMs: mark && resource ? resource.responseEnd - mark.startTime : -1,
    }
  }, targetAgentId)

  const sampledAgentIds = uniformSamples(agentIds, OPEN_SAMPLE_COUNT)
  const switchSamples = [{ agentId: targetAgentId, chatShellOpenMs, ...browserOpenTiming }]
  for (const [index, agentId] of sampledAgentIds.entries()) {
    if (agentId === targetAgentId) continue
    const sampleRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await sampleRow.scrollIntoViewIfNeeded()
    const markName = `farming-acp-scale-switch-${index}`
    await sampleRow.evaluate((element, name) => {
      performance.mark(name)
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      ;(element as HTMLElement).click()
    }, markName)
    await expect(sampleRow).toHaveClass(/\bactive\b/)
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    const sampleShellOpenMs = await page.evaluate(name => {
      const mark = performance.getEntriesByName(name).at(-1)
      return mark ? performance.now() - mark.startTime : -1
    }, markName)
    if (SEND_PROMPTS) {
      await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible()
    } else {
      await expect(page.locator('.code-agent-transcript-state')).toHaveCount(0)
    }
    const timing = await page.evaluate(({ id, name }) => {
      const mark = performance.getEntriesByName(name).at(-1)
      const resource = performance.getEntriesByType('resource')
        .filter(entry => (
          entry.name.includes(`/api/agents/${id}/acp-transcript?`)
          && Boolean(mark && entry.startTime >= mark.startTime)
        ))
        .at(-1) as PerformanceResourceTiming | undefined
      return {
        agentId: id,
        chatShellOpenMs: -1,
        openChatMs: mark ? performance.now() - mark.startTime : -1,
        transcriptRequestStartMs: mark && resource ? resource.startTime - mark.startTime : -1,
        transcriptBrowserDurationMs: resource?.duration ?? -1,
        transcriptResponseEndMs: mark && resource ? resource.responseEnd - mark.startTime : -1,
      }
    }, { id: agentId, name: markName })
    switchSamples.push({ ...timing, chatShellOpenMs: sampleShellOpenMs })
  }

  const result = {
    agentCount: AGENT_COUNT,
    model: SCALE_MODEL || 'fixture-default',
    reasoning: SCALE_MODEL ? SCALE_REASONING : 'fixture-default',
    serviceTier: SCALE_MODEL ? SCALE_SERVICE_TIER : 'fixture-default',
    providerHomePath: SCALE_PROVIDER_HOME_PATH || 'fixture-default',
    sendPrompts: SEND_PROMPTS,
    profileSamples,
    createMs,
    turnMs,
    chatShellOpenMs,
    ...browserOpenTiming,
    directTranscriptMs,
    transcriptResponseDurationsMs,
    switchSamples,
    inFlightBeforeOpen,
    settledHeapBytes: settledMetrics.jsHeapUsedBytes,
    settledDomNodes: settledMetrics.nodes,
    turnHeapBytes: turnMetricsAfter.jsHeapUsedBytes,
    turnDomNodes: turnMetricsAfter.nodes,
    turnScriptMs: Math.max(0, turnMetricsAfter.scriptDurationMs - turnMetricsBefore.scriptDurationMs),
    turnTaskMs: Math.max(0, turnMetricsAfter.taskDurationMs - turnMetricsBefore.taskDurationMs),
    turnRenders,
    wire,
    runtimeUpdatedAgentCount,
    readUpdatedAgentCount,
    unexpectedStateFrames,
  }
  console.log(`acp-agent-scoped-scale ${JSON.stringify(result)}`)
  await testInfo.attach('acp-agent-scoped-scale.json', {
    body: Buffer.from(`${JSON.stringify(result, null, 2)}\n`),
    contentType: 'application/json',
  })
  expect(wire.count.state || 0).toBe(0)
  if (SEND_PROMPTS) {
    expect(runtimeUpdatedAgentCount).toBe(AGENT_COUNT)
    expect(readUpdatedAgentCount).toBe(AGENT_COUNT)
  }
  expect(turnRenders.app).toBeLessThanOrEqual(2)
  expect(turnRenders.codeWorkspace).toBeLessThanOrEqual(12)
  expect(chatShellOpenMs).toBeLessThan(100)
  expect(browserOpenTiming.transcriptRequestStartMs).toBeGreaterThanOrEqual(-1)
  expect(browserOpenTiming.transcriptRequestStartMs).toBeLessThan(100)
  expect(browserOpenTiming.transcriptBrowserDurationMs).toBeGreaterThanOrEqual(-1)
  expect(browserOpenTiming.transcriptBrowserDurationMs).toBeLessThan(250)
  expect(browserOpenTiming.openChatMs).toBeLessThan(500)
  expect(Math.max(...switchSamples.map(sample => sample.chatShellOpenMs))).toBeLessThan(100)
  expect(Math.min(...switchSamples.map(sample => sample.transcriptBrowserDurationMs))).toBeGreaterThanOrEqual(-1)
  expect(Math.max(...switchSamples.map(sample => sample.transcriptBrowserDurationMs))).toBeLessThan(250)
  expect(Math.max(...switchSamples.map(sample => sample.openChatMs))).toBeLessThan(500)
  expect(settledMetrics.jsHeapUsedBytes).toBeLessThan(64 * 1024 * 1024)
  expect(turnMetricsAfter.nodes).toBeLessThan(3_000)
})
