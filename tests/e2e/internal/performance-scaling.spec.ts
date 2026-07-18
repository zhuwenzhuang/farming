import fs from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page, WebSocket } from '@playwright/test'
import { expect, openFarming, test } from '../fixtures'

const AGENT_COUNTS = [1, 10, 20, 50]
const CREATE_BATCH_SIZE = 5

type RenderSnapshot = {
  app: number
  codeWorkspace: number
}

type WireFrame = {
  at: number
  type: string
  bytes: number
  agentId: string
  agentCount: number
}

type BrowserMetrics = {
  jsHeapUsedBytes: number
  nodes: number
  scriptDurationMs: number
  taskDurationMs: number
}

type ScaleResult = {
  agentCount: number
  incrementalCreateMs: number
  settleMs: number
  settleRenders: RenderSnapshot
  settleMessages: Record<string, number>
  statePayloadBytes: number
  stateBytesPerAgent: number
  jsHeapUsedBytes: number
  domNodes: number
  idleRenders: RenderSnapshot
  idleScriptMs: number
  idleTaskMs: number
  previewLatencyMs: number
  previewPayloadBytes: number
  previewRenders: RenderSnapshot
  previewScriptMs: number
  previewTaskMs: number
  previewWindowMessages: Record<string, number>
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
        state?: { agents?: Array<{ isMain?: boolean }> }
        preview?: { agentId?: string }
        activity?: { agentId?: string }
        stream?: { agentId?: string }
      }
      frames.push({
        at: performance.now(),
        type: message.type || 'unknown',
        bytes: byteLength(payload),
        agentId: message.preview?.agentId || message.activity?.agentId || message.stream?.agentId || '',
        agentCount: Array.isArray(message.state?.agents)
          ? message.state.agents.filter(agent => agent.isMain !== true).length
          : 0,
      })
    } catch {
      frames.push({ at: performance.now(), type: 'invalid', bytes: byteLength(payload), agentId: '', agentCount: 0 })
    }
  }
  const attach = (socket: WebSocket) => socket.on('framereceived', event => record(event.payload))
  page.on('websocket', attach)
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

function metricDelta(after: BrowserMetrics, before: BrowserMetrics) {
  return {
    scriptMs: Math.max(0, after.scriptDurationMs - before.scriptDurationMs),
    taskMs: Math.max(0, after.taskDurationMs - before.taskDurationMs),
  }
}

function messageCounts(frames: WireFrame[]) {
  const counts: Record<string, number> = {}
  frames.forEach(frame => {
    counts[frame.type] = (counts[frame.type] || 0) + 1
  })
  return counts
}

async function waitForWireQuiet(frames: WireFrame[], quietMs = 1_500, timeoutMs = 20_000) {
  const startedAt = performance.now()
  let observedLength = frames.length
  let quietStartedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    if (frames.length !== observedLength) {
      const relevantFrames = frames.slice(observedLength).some(frame => (
        frame.type === 'state' || frame.type === 'session-preview' || frame.type === 'agent-activity'
      ))
      observedLength = frames.length
      if (relevantFrames) quietStartedAt = performance.now()
    }
    if (performance.now() - quietStartedAt >= quietMs) return performance.now() - startedAt
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Agent wire activity did not become quiet within ${timeoutMs}ms`)
}

async function createBashAgents(page: Page, workspace: string, count: number) {
  const agentIds: string[] = []
  for (let offset = 0; offset < count; offset += CREATE_BATCH_SIZE) {
    const batchSize = Math.min(CREATE_BATCH_SIZE, count - offset)
    const batch = await Promise.all(Array.from({ length: batchSize }, async () => {
      const response = await page.request.post('/farming/api/control/agents', {
        data: { command: 'bash', workspace },
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

async function renderSnapshot(page: Page) {
  return page.evaluate(() => (
    window.__farmingPerformanceTest?.snapshot() ?? { app: 0, codeWorkspace: 0 }
  )) as Promise<RenderSnapshot>
}

test('characterizes Code workspace scaling through 50 live Agents', async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(240_000)
  const workspace = path.join(workspaceRoot, 'performance-scaling')
  fs.mkdirSync(workspace, { recursive: true })

  const frames = trackWireFrames(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await openFarming(page)
  await page.waitForFunction(() => Boolean(window.__farmingPerformanceTest))

  const agentIds: string[] = []
  const results: ScaleResult[] = []

  for (const targetCount of AGENT_COUNTS) {
    const createStartedAt = performance.now()
    agentIds.push(...await createBashAgents(page, workspace, targetCount - agentIds.length))
    const incrementalCreateMs = performance.now() - createStartedAt

    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/control/agents')
      if (!response.ok()) return -1
      const body = await response.json() as { agents?: Array<{ isMain?: boolean }> }
      return body.agents?.filter(agent => agent.isMain !== true).length ?? 0
    }, { timeout: 60_000 }).toBe(targetCount)
    await expect.poll(() => frames.findLast(frame => frame.type === 'state')?.agentCount ?? -1, {
      timeout: 60_000,
    }).toBe(targetCount)
    await page.evaluate(() => window.__farmingPerformanceTest?.reset())
    const settleFrameStart = frames.length
    const settleMs = await waitForWireQuiet(frames)
    const settleRenders = await renderSnapshot(page)
    const settleMessages = messageCounts(frames.slice(settleFrameStart))

    await cdp.send('HeapProfiler.collectGarbage')
    const settledMetrics = await browserMetrics(cdp)
    const latestState = frames.findLast(frame => frame.type === 'state' && frame.agentCount === targetCount)
    expect(latestState).toBeTruthy()

    await page.evaluate(() => window.__farmingPerformanceTest?.reset())
    const idleMetricsBefore = await browserMetrics(cdp)
    await page.waitForTimeout(1_600)
    const idleMetricsAfter = await browserMetrics(cdp)
    const idleRenders = await renderSnapshot(page)
    const idleDelta = metricDelta(idleMetricsAfter, idleMetricsBefore)

    await page.evaluate(() => window.__farmingPerformanceTest?.reset())
    const previewFrameStart = frames.length
    const previewMetricsBefore = await browserMetrics(cdp)
    const previewStartedAt = performance.now()
    const previewAgentId = agentIds[targetCount - 1]
    const inputResponse = await page.request.post(`/farming/api/control/agents/${previewAgentId}/input`, {
      data: { input: `printf '__FARMING_SCALE_${targetCount}__\\n'\r` },
    })
    expect(inputResponse.ok()).toBeTruthy()
    await expect.poll(() => frames.slice(previewFrameStart).some(frame => (
      frame.type === 'session-preview' && frame.agentId === previewAgentId
    )), { timeout: 15_000 }).toBe(true)
    const previewFrame = frames.slice(previewFrameStart).find(frame => (
      frame.type === 'session-preview' && frame.agentId === previewAgentId
    ))
    const previewLatencyMs = performance.now() - previewStartedAt
    await page.waitForTimeout(100)
    const previewMetricsAfter = await browserMetrics(cdp)
    const previewRenders = await renderSnapshot(page)
    const previewDelta = metricDelta(previewMetricsAfter, previewMetricsBefore)
    const previewWindowFrames = frames.slice(previewFrameStart)

    const result: ScaleResult = {
      agentCount: targetCount,
      incrementalCreateMs,
      settleMs,
      settleRenders,
      settleMessages,
      statePayloadBytes: latestState?.bytes ?? 0,
      stateBytesPerAgent: (latestState?.bytes ?? 0) / targetCount,
      jsHeapUsedBytes: settledMetrics.jsHeapUsedBytes,
      domNodes: settledMetrics.nodes,
      idleRenders,
      idleScriptMs: idleDelta.scriptMs,
      idleTaskMs: idleDelta.taskMs,
      previewLatencyMs,
      previewPayloadBytes: previewFrame?.bytes ?? 0,
      previewRenders,
      previewScriptMs: previewDelta.scriptMs,
      previewTaskMs: previewDelta.taskMs,
      previewWindowMessages: messageCounts(previewWindowFrames),
    }
    results.push(result)
    console.log(`performance-scale ${JSON.stringify(result)}`)

    expect(idleRenders.app).toBeLessThanOrEqual(2)
    expect(idleRenders.codeWorkspace).toBeLessThanOrEqual(2)
    expect(previewLatencyMs).toBeLessThan(15_000)
    expect(result.statePayloadBytes).toBeGreaterThan(0)
  }

  await testInfo.attach('performance-scaling.json', {
    body: Buffer.from(`${JSON.stringify({ results }, null, 2)}\n`),
    contentType: 'application/json',
  })
})
