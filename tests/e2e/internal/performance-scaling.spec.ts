import fs from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page, WebSocket } from '@playwright/test'
import { expect, openFarming, test } from '../fixtures'

function scaleAgentCounts() {
  const configured = String(process.env.FARMING_SCALE_AGENT_COUNTS || '').trim()
  if (!configured) return [1, 10, 20, 50]
  const counts = [...new Set(configured.split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right)
  return counts.length > 0 ? counts : [1, 10, 20, 50]
}

const AGENT_COUNTS = scaleAgentCounts()
const CREATE_BATCH_SIZE = 5

type RenderSnapshot = {
  app: number
  codeWorkspace: number
}

type WireFrame = {
  at: number
  type: string
  bytes: number
  sequence: number
  agentId: string
  agentCount: number
  snapshotComplete: boolean
  snapshotId: string
  snapshotOffset: number
  statePageAgentCount: number
  stateAgentIds: string[]
  stateAgents: Array<{
    activityLevel?: string
    id: string
    terminalInputReceived?: boolean
    unread?: boolean
  }>
  projectAgentSummaries: Array<{
    activeCount: number
    agentCount: number
    maxAttentionScore: number
    unreadCount: number
    workspace: string
    zombieCount: number
  }>
  upsertAgentIds: string[]
  upsertCount: number
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

function requiredAgentId(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} Agent is unavailable`)
  return value
}

function trackWireFrames(page: Page) {
  const frames: WireFrame[] = []
  const visibleAgentIds = new Set<string>()
  const record = (payload: string | Buffer) => {
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
    try {
      const message = JSON.parse(text) as {
        type?: string
        sequence?: number
        state?: {
          agents?: Array<{
            activityLevel?: string
            id?: string
            isMain?: boolean
            terminalInputReceived?: boolean
            unread?: boolean
          }>
          projectAgentSummaries?: WireFrame['projectAgentSummaries']
        }
        snapshot?: { complete?: boolean; id?: string; offset?: number }
        upserts?: Array<{ id?: string; isMain?: boolean }>
        removedAgentIds?: string[]
        update?: { agentId?: string }
        read?: { agentId?: string }
        preview?: { agentId?: string }
        activity?: { agentId?: string }
        stream?: { agentId?: string }
      }
      if (message.type === 'state' && Array.isArray(message.state?.agents)) {
        if (!message.snapshot || message.snapshot.offset === 0) visibleAgentIds.clear()
        message.state.agents.forEach(agent => {
          if (agent.id && agent.isMain !== true) visibleAgentIds.add(agent.id)
        })
      } else if (message.type === 'state-delta') {
        message.removedAgentIds?.forEach(agentId => visibleAgentIds.delete(agentId))
        message.upserts?.forEach(agent => {
          if (!agent.id) return
          if (agent.isMain === true) visibleAgentIds.delete(agent.id)
          else visibleAgentIds.add(agent.id)
        })
      }
      frames.push({
        at: performance.now(),
        type: message.type || 'unknown',
        bytes: byteLength(payload),
        sequence: Number.isInteger(message.sequence) ? Number(message.sequence) : -1,
        agentId: message.update?.agentId
          || message.read?.agentId
          || message.preview?.agentId
          || message.activity?.agentId
          || message.stream?.agentId
          || '',
        agentCount: message.type === 'state' || message.type === 'state-delta'
          ? visibleAgentIds.size
          : 0,
        snapshotComplete: message.snapshot?.complete === true,
        snapshotId: message.snapshot?.id || '',
        snapshotOffset: message.snapshot?.offset ?? -1,
        statePageAgentCount: message.type === 'state' ? message.state?.agents?.length ?? 0 : 0,
        stateAgentIds: message.type === 'state'
          ? message.state?.agents?.flatMap(agent => agent.id ? [agent.id] : []) ?? []
          : [],
        stateAgents: message.type === 'state'
          ? message.state?.agents?.flatMap(agent => agent.id ? [{ ...agent, id: agent.id }] : []) ?? []
          : [],
        projectAgentSummaries: message.type === 'state'
          ? message.state?.projectAgentSummaries ?? []
          : [],
        upsertAgentIds: message.type === 'state-delta'
          ? message.upserts?.flatMap(agent => agent.id ? [agent.id] : []) ?? []
          : [],
        upsertCount: message.type === 'state-delta' ? message.upserts?.length ?? 0 : 0,
      })
    } catch {
      frames.push({
        at: performance.now(),
        type: 'invalid',
        bytes: byteLength(payload),
        sequence: -1,
        agentId: '',
        agentCount: 0,
        snapshotComplete: false,
        snapshotId: '',
        snapshotOffset: -1,
        statePageAgentCount: 0,
        stateAgentIds: [],
        stateAgents: [],
        projectAgentSummaries: [],
        upsertAgentIds: [],
        upsertCount: 0,
      })
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
        frame.type === 'state' || frame.type === 'state-delta' || frame.type === 'session-preview'
          || frame.type === 'agent-activity' || frame.type === 'agent-update'
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

test(`characterizes Code workspace scaling through ${AGENT_COUNTS.at(-1)} live Agents`, async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(Math.max(240_000, (AGENT_COUNTS.at(-1) || 50) * 4_000))
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
    await expect.poll(() => frames.findLast(frame => (
      frame.type === 'state' || frame.type === 'state-delta'
    ))?.agentCount ?? -1, {
      timeout: 60_000,
    }).toBe(targetCount)
    await page.evaluate(() => window.__farmingPerformanceTest?.reset())
    const settleFrameStart = frames.length
    const settleMs = await waitForWireQuiet(frames)
    const settleRenders = await renderSnapshot(page)
    const settleMessages = messageCounts(frames.slice(settleFrameStart))

    await cdp.send('HeapProfiler.collectGarbage')
    const settledMetrics = await browserMetrics(cdp)
    const latestState = frames.findLast(frame => (
      (frame.type === 'state' || frame.type === 'state-delta')
      && frame.agentCount === targetCount
    ))
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
    const previewAgentId = agentIds[targetCount > 1 ? targetCount - 2 : 0]
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
    const previewWindowMessages = messageCounts(previewWindowFrames)

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
      previewWindowMessages,
    }
    results.push(result)
    console.log(`performance-scale ${JSON.stringify(result)}`)

    expect(idleRenders.app).toBeLessThanOrEqual(2)
    expect(idleRenders.codeWorkspace).toBeLessThanOrEqual(2)
    expect(previewLatencyMs).toBeLessThan(15_000)
    expect(previewWindowMessages.state || 0).toBe(0)
    expect(previewWindowMessages['state-delta'] || 0).toBe(0)
    expect(previewRenders.app).toBe(0)
    if (targetCount > 1) expect(previewRenders.codeWorkspace).toBe(0)
    expect(result.statePayloadBytes).toBeGreaterThan(0)
  }

  await testInfo.attach('performance-scaling.json', {
    body: Buffer.from(`${JSON.stringify({ results }, null, 2)}\n`),
    contentType: 'application/json',
  })
})

test('restores a large Agent inventory through progressive authoritative pages', async ({ page, workspaceRoot }) => {
  test.setTimeout(240_000)
  const workspace = path.join(workspaceRoot, 'progressive-agent-snapshot')
  const secondaryWorkspace = path.join(workspaceRoot, 'progressive-agent-snapshot-secondary')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(secondaryWorkspace, { recursive: true })
  const targetCount = 70
  const primaryAgentIds = await createBashAgents(page, workspace, 40)
  const secondaryAgentIds = await createBashAgents(page, secondaryWorkspace, 30)
  const initialAgentIds = [...primaryAgentIds, ...secondaryAgentIds]
  const mutatedAgentId = initialAgentIds.at(-1) || ''
  await page.addInitScript(({ mutationAgentId, summaryProjectId }) => {
    type SnapshotProbe = {
      completeMessageAt: number
      firstMessageAt: number
      firstRowAt: number
      mutationRequested: boolean
      mutationRequestedAt: number
      summaryProjectAgentCount: number
      summaryProjectAt: number
      socket: WebSocket | null
    }
    const browserWindow = window as typeof window & { __farmingSnapshotProbe?: SnapshotProbe }
    const probe: SnapshotProbe = {
      completeMessageAt: 0,
      firstMessageAt: 0,
      firstRowAt: 0,
      mutationRequested: false,
      mutationRequestedAt: 0,
      summaryProjectAgentCount: -1,
      summaryProjectAt: 0,
      socket: null,
    }
    browserWindow.__farmingSnapshotProbe = probe
    const NativeWebSocket = window.WebSocket
    class SnapshotWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        probe.socket = this
        this.addEventListener('message', event => {
          try {
            const message = JSON.parse(String(event.data)) as {
              type?: string
              snapshot?: { complete?: boolean; offset?: number }
            }
            if (message.type !== 'state' || !message.snapshot) return
            if (message.snapshot.offset === 0 && probe.firstMessageAt === 0) {
              probe.firstMessageAt = performance.now()
              probe.mutationRequested = true
              probe.mutationRequestedAt = performance.now()
              void fetch(`/farming/api/agents/${encodeURIComponent(mutationAgentId)}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ customTitle: 'Progressive snapshot mutation' }),
              }).then(response => {
                if (!response.ok) throw new Error(`Mutation failed with ${response.status}`)
              })
            }
            if (message.snapshot.complete === true && probe.completeMessageAt === 0) {
              probe.completeMessageAt = performance.now()
            }
          } catch {
            // The product protocol validator owns malformed-message handling.
          }
        })
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: SnapshotWebSocket })
    document.addEventListener('DOMContentLoaded', () => {
      const observer = new MutationObserver(() => {
        if (probe.firstRowAt === 0 && document.querySelector('[data-testid="code-agent-row"]')) {
          probe.firstRowAt = performance.now()
        }
        if (probe.summaryProjectAt === 0) {
          const title = document.querySelector<HTMLElement>(
            `[data-testid="code-project-title"][data-project-id="${CSS.escape(summaryProjectId)}"]`,
          )
          const group = title?.closest<HTMLElement>('[data-testid="code-project-group"]')
          const agentCount = Number(group?.dataset.projectAgentCount)
          if (Number.isInteger(agentCount) && agentCount >= 0) {
            probe.summaryProjectAgentCount = agentCount
            probe.summaryProjectAt = performance.now()
          }
        }
        if (probe.firstRowAt !== 0 && probe.summaryProjectAt !== 0) observer.disconnect()
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }, { once: true })
  }, { mutationAgentId: mutatedAgentId, summaryProjectId: secondaryWorkspace })

  const frames = trackWireFrames(page)
  await page.goto(`/farming/?agent=${encodeURIComponent(mutatedAgentId)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect.poll(() => frames.findLast(frame => (
    frame.type === 'state'
    && frame.snapshotComplete
    && frame.agentCount === targetCount
  ))?.agentCount ?? -1, { timeout: 60_000 }).toBe(targetCount)

  const first = frames.find(frame => frame.type === 'state' && frame.snapshotOffset === 0)
  expect(first).toBeTruthy()
  expect(first?.snapshotComplete).toBe(false)
  expect(first?.statePageAgentCount).toBe(32)
  expect(first?.stateAgentIds.some(agentId => secondaryAgentIds.includes(agentId))).toBe(false)
  const secondaryProjectSummary = first?.projectAgentSummaries.find(
    summary => summary.workspace === secondaryWorkspace,
  )
  expect(secondaryProjectSummary).toMatchObject({
    workspace: secondaryWorkspace,
    agentCount: 30,
    unreadCount: 0,
    zombieCount: 0,
  })
  expect(secondaryProjectSummary?.activeCount).toBeGreaterThanOrEqual(0)
  expect(secondaryProjectSummary?.activeCount).toBeLessThanOrEqual(30)
  expect(secondaryProjectSummary?.maxAttentionScore).toBeGreaterThanOrEqual(0)
  expect(secondaryProjectSummary?.maxAttentionScore).toBeLessThanOrEqual(100)
  const snapshotFrames = frames.filter(frame => (
    frame.type === 'state' && frame.snapshotId === first?.snapshotId
  ))
  expect(snapshotFrames.length).toBeGreaterThan(1)
  expect(snapshotFrames.at(-1)?.snapshotComplete).toBe(true)
  expect(snapshotFrames.at(-1)?.agentCount).toBe(targetCount)
  const snapshotPayloadBytes = snapshotFrames.reduce((sum, frame) => sum + frame.bytes, 0)
  expect(first?.bytes ?? 0).toBeLessThan(snapshotPayloadBytes)
  console.log(`progressive-agent-snapshot ${JSON.stringify({
    firstPageAgents: first?.statePageAgentCount,
    firstPageBytes: first?.bytes,
    frameCount: snapshotFrames.length,
    snapshotPayloadBytes,
    wireSpanMs: (snapshotFrames.at(-1)?.at ?? 0) - (first?.at ?? 0),
  })}`)
  const paintProbe = await page.evaluate(() => (
    (window as typeof window & { __farmingSnapshotProbe?: {
      completeMessageAt: number
      firstMessageAt: number
      firstRowAt: number
      mutationRequested: boolean
      mutationRequestedAt: number
      summaryProjectAgentCount: number
      summaryProjectAt: number
    } }).__farmingSnapshotProbe
  ))
  expect(paintProbe?.firstMessageAt).toBeGreaterThan(0)
  expect(paintProbe?.firstRowAt).toBeGreaterThan(paintProbe?.firstMessageAt ?? 0)
  expect(paintProbe?.firstRowAt).toBeLessThan(paintProbe?.completeMessageAt ?? 0)
  expect(paintProbe?.summaryProjectAgentCount).toBe(30)
  expect(paintProbe?.summaryProjectAt).toBeGreaterThan(paintProbe?.firstMessageAt ?? 0)
  expect(paintProbe?.summaryProjectAt).toBeLessThan(paintProbe?.completeMessageAt ?? 0)
  expect(paintProbe?.mutationRequested).toBe(true)
  expect(paintProbe?.mutationRequestedAt).toBeGreaterThanOrEqual(paintProbe?.firstMessageAt ?? 0)
  expect(paintProbe?.mutationRequestedAt).toBeLessThan(paintProbe?.completeMessageAt ?? 0)
  await expect.poll(() => frames.findLast(frame => (
    frame.type === 'state-delta'
    && frame.agentCount === targetCount
    && frame.upsertAgentIds.includes(mutatedAgentId)
  ))?.upsertAgentIds.includes(mutatedAgentId) ?? false, { timeout: 30_000 }).toBe(true)
  const mutationDelta = frames.findLast(frame => (
    frame.type === 'state-delta' && frame.upsertAgentIds.includes(mutatedAgentId)
  ))
  expect(mutationDelta?.at).toBeGreaterThan(snapshotFrames.at(-1)?.at ?? 0)
  expect(mutationDelta?.upsertCount).toBeLessThan(first?.statePageAgentCount ?? 32)
  const secondaryProjectGroup = page.locator(
    `[data-testid="code-project-title"][data-project-id="${secondaryWorkspace}"]`,
  ).locator('xpath=ancestor::*[@data-testid="code-project-group"]')
  const projectContentRenders = await page.evaluate(async ({ agentId, projectId }) => {
    const title = document.querySelector<HTMLElement>(
      `[data-testid="code-project-title"][data-project-id="${CSS.escape(projectId)}"]`,
    )
    const group = title?.closest<HTMLElement>('[data-testid="code-project-group"]')
    if (!group) return -3
    window.__farmingPerformanceTest?.reset()
    return new Promise<number>(resolve => {
      let settled = false
      const finish = (value: number) => {
        if (settled) return
        settled = true
        observer.disconnect()
        window.clearTimeout(timeout)
        resolve(value)
      }
      const committed = () => (
        group.dataset.projectZombieCount === '1'
        && group.dataset.projectMaxAttention === '100'
      )
      const observer = new MutationObserver(() => {
        if (committed()) {
          finish(window.__farmingPerformanceTest?.snapshot().projectSectionContent ?? -1)
        }
      })
      const timeout = window.setTimeout(() => finish(-2), 2_000)
      observer.observe(group, {
        attributeFilter: ['data-project-zombie-count', 'data-project-max-attention'],
        attributes: true,
      })
      window.__farmingAgentActivityTest?.update(agentId, {
        lastActivity: Date.now(),
        activityLevel: 'hot',
        attentionScore: 100,
        isZombie: true,
      })
      if (committed()) {
        finish(window.__farmingPerformanceTest?.snapshot().projectSectionContent ?? -1)
      }
    })
  }, { agentId: secondaryAgentIds[0], projectId: secondaryWorkspace })
  expect(projectContentRenders).toBe(0)
  await expect(secondaryProjectGroup).toHaveAttribute('data-project-zombie-count', '1')
  await expect(secondaryProjectGroup).toHaveAttribute('data-project-max-attention', '100')
  await expect(page.locator(
    `[data-testid="code-terminal-pane"][data-agent-id="${mutatedAgentId}"]`,
  )).toBeVisible()
  expect(new Set(frames.filter(frame => frame.type === 'state').map(frame => frame.snapshotId)).size).toBe(1)

  const codePreviewSeedStart = frames.length
  const codePreviewSeed = await page.request.post(
    `/farming/api/control/agents/${encodeURIComponent(mutatedAgentId)}/input`,
    { data: { input: "printf '__FARMING_PREVIEW_SCOPE__\\n'\r" } },
  )
  expect(codePreviewSeed.ok()).toBeTruthy()
  await expect.poll(() => frames.slice(codePreviewSeedStart).some(frame => (
    frame.type === 'session-preview' && frame.agentId === mutatedAgentId
  )), { timeout: 30_000 }).toBe(true)
  await waitForWireQuiet(frames, 300, 5_000)
  const codeResyncStart = frames.length
  await page.evaluate(() => {
    const socket = (window as typeof window & {
      __farmingSnapshotProbe?: { socket: WebSocket | null }
    }).__farmingSnapshotProbe?.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Code WebSocket is not open for state resync')
    }
    socket.send(JSON.stringify({ type: 'state-resync' }))
  })
  await expect.poll(() => frames.slice(codeResyncStart).find(frame => (
    frame.type === 'state'
    && frame.snapshotOffset === 0
    && frame.snapshotId !== first?.snapshotId
  ))?.snapshotId ?? '', { timeout: 30_000 }).not.toBe('')
  const resyncSnapshotId = frames.slice(codeResyncStart).find(frame => (
    frame.type === 'state'
    && frame.snapshotOffset === 0
    && frame.snapshotId !== first?.snapshotId
  ))?.snapshotId ?? ''
  await expect.poll(() => frames.findLast(frame => (
    frame.type === 'state'
    && frame.snapshotId === resyncSnapshotId
    && frame.snapshotComplete
  ))?.agentCount ?? -1, { timeout: 30_000 }).toBe(targetCount)
  await waitForWireQuiet(frames, 300, 5_000)
  expect(frames.slice(codeResyncStart).some(frame => (
    frame.type === 'session-preview' && frame.agentId === mutatedAgentId
  ))).toBe(true)

  await page.waitForTimeout(500)
  const codeDeltaCountBeforeCrt = frames.filter(frame => frame.type === 'state-delta').length
  const crtPage = await page.context().newPage()
  const crtFrames = trackWireFrames(crtPage)
  await crtPage.addInitScript(() => {
    const crtWindow = window as typeof window & { __farmingCrtSocket?: WebSocket | null }
    crtWindow.__farmingCrtSocket = null
    const NativeWebSocket = window.WebSocket
    class CrtWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        crtWindow.__farmingCrtSocket = this
      }
    }
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: CrtWebSocket,
      writable: true,
    })
  })
  await crtPage.goto(`/farming/crt/?agent=${encodeURIComponent(mutatedAgentId)}`, { waitUntil: 'domcontentloaded' })
  await expect.poll(() => crtFrames.findLast(frame => (
    frame.type === 'state'
    && frame.snapshotComplete
    && frame.agentCount === targetCount
  ))?.agentCount ?? -1, { timeout: 60_000 }).toBe(targetCount)
  const firstCrtFrame = crtFrames.find(frame => frame.type === 'state' && frame.snapshotOffset === 0)
  expect(firstCrtFrame?.statePageAgentCount).toBe(32)
  await expect(crtPage.locator('#session-modal')).toHaveClass(/active/)
  await expect(crtPage.locator('body')).toContainText(`AGENTS: ${targetCount + 1}/${targetCount + 1}`)
  const focusedPreviewResyncStart = crtFrames.length
  await crtPage.evaluate(() => {
    const socket = (window as typeof window & { __farmingCrtSocket?: WebSocket | null }).__farmingCrtSocket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('CRT WebSocket is not open for state resync')
    }
    socket.send(JSON.stringify({ type: 'state-resync' }))
  })
  await expect.poll(() => crtFrames.slice(focusedPreviewResyncStart).some(frame => (
    frame.type === 'state' && frame.snapshotComplete
  )), { timeout: 30_000 }).toBe(true)
  await waitForWireQuiet(crtFrames, 300, 5_000)
  const focusedPreviewFrames = crtFrames.slice(focusedPreviewResyncStart).filter(frame => (
    frame.type === 'session-preview'
  ))
  expect(focusedPreviewFrames).toHaveLength(0)
  console.log(`focused-preview-resync ${JSON.stringify({
    previewBytes: focusedPreviewFrames.reduce((sum, frame) => sum + frame.bytes, 0),
    previewFrames: focusedPreviewFrames.length,
  })}`)
  await page.waitForTimeout(500)
  expect(frames.filter(frame => frame.type === 'state-delta')).toHaveLength(codeDeltaCountBeforeCrt)

  const unrelatedAgentId = requiredAgentId(
    initialAgentIds.find(agentId => agentId !== mutatedAgentId),
    'Unrelated scope test',
  )
  const unrelatedCodeDeltaStart = frames.length
  const unrelatedCrtDeltaStart = crtFrames.length
  const unrelatedMutation = await page.request.patch(
    `/farming/api/agents/${encodeURIComponent(unrelatedAgentId)}`,
    { data: { customTitle: 'Focused scope unrelated mutation' } },
  )
  expect(unrelatedMutation.ok()).toBeTruthy()
  await expect.poll(() => frames.slice(unrelatedCodeDeltaStart).find(frame => (
    frame.type === 'state-delta' && frame.upsertAgentIds.includes(unrelatedAgentId)
  ))?.sequence ?? -1, { timeout: 30_000 }).toBeGreaterThanOrEqual(0)
  const unrelatedCodeDelta = frames.slice(unrelatedCodeDeltaStart).find(frame => (
    frame.type === 'state-delta' && frame.upsertAgentIds.includes(unrelatedAgentId)
  ))
  await expect.poll(() => crtFrames.slice(unrelatedCrtDeltaStart).find(frame => (
    frame.type === 'state-delta' && frame.sequence === unrelatedCodeDelta?.sequence
  ))?.upsertCount ?? -1, { timeout: 30_000 }).toBe(0)
  const unrelatedCrtDelta = crtFrames.slice(unrelatedCrtDeltaStart).find(frame => (
    frame.type === 'state-delta' && frame.sequence === unrelatedCodeDelta?.sequence
  ))
  expect(unrelatedCrtDelta?.upsertAgentIds).toEqual([])
  expect(unrelatedCrtDelta?.bytes ?? Number.MAX_SAFE_INTEGER).toBeLessThan(unrelatedCodeDelta?.bytes ?? 0)
  console.log(`focused-state-delta ${JSON.stringify({
    fullBytes: unrelatedCodeDelta?.bytes,
    checkpointBytes: unrelatedCrtDelta?.bytes,
    sequence: unrelatedCodeDelta?.sequence,
  })}`)

  const unrelatedUpdateCodeStart = frames.length
  const unrelatedUpdateCrtStart = crtFrames.length
  const unrelatedInput = await page.request.post(
    `/farming/api/control/agents/${encodeURIComponent(unrelatedAgentId)}/input`,
    { data: { input: 'true\r' } },
  )
  expect(unrelatedInput.ok()).toBeTruthy()
  await expect.poll(() => frames.slice(unrelatedUpdateCodeStart).some(frame => (
    frame.type === 'agent-update' && frame.agentId === unrelatedAgentId
  )), { timeout: 30_000 }).toBe(true)
  await waitForWireQuiet(crtFrames, 300, 5_000)
  expect(crtFrames.slice(unrelatedUpdateCrtStart).some(frame => (
    frame.type === 'agent-update' && frame.agentId === unrelatedAgentId
  ))).toBe(false)

  const focusedCodeDeltaStart = frames.length
  const focusedCrtDeltaStart = crtFrames.length
  const focusedMutation = await page.request.patch(
    `/farming/api/agents/${encodeURIComponent(mutatedAgentId)}`,
    { data: { customTitle: 'Focused scope target mutation' } },
  )
  expect(focusedMutation.ok()).toBeTruthy()
  await expect.poll(() => frames.slice(focusedCodeDeltaStart).find(frame => (
    frame.type === 'state-delta' && frame.upsertAgentIds.includes(mutatedAgentId)
  ))?.sequence ?? -1, { timeout: 30_000 }).toBeGreaterThanOrEqual(0)
  const focusedCodeDelta = frames.slice(focusedCodeDeltaStart).find(frame => (
    frame.type === 'state-delta' && frame.upsertAgentIds.includes(mutatedAgentId)
  ))
  await expect.poll(() => crtFrames.slice(focusedCrtDeltaStart).find(frame => (
    frame.type === 'state-delta'
    && frame.sequence === focusedCodeDelta?.sequence
    && frame.upsertAgentIds.includes(mutatedAgentId)
  ))?.upsertAgentIds.includes(mutatedAgentId) ?? false, { timeout: 30_000 }).toBe(true)

  const focusedUpdateCrtStart = crtFrames.length
  const focusedInput = await page.request.post(
    `/farming/api/control/agents/${encodeURIComponent(mutatedAgentId)}/input`,
    { data: { input: 'true\r' } },
  )
  expect(focusedInput.ok()).toBeTruthy()
  await expect.poll(() => crtFrames.slice(focusedUpdateCrtStart).some(frame => (
    frame.type === 'agent-update' && frame.agentId === mutatedAgentId
  )), { timeout: 30_000 }).toBe(true)

  const dashboardSnapshotStart = crtFrames.length
  await crtPage.getByRole('button', { name: 'Close session, Ctrl+Escape' }).click()
  await expect.poll(() => crtFrames.slice(dashboardSnapshotStart).findLast(frame => (
    frame.type === 'state' && frame.snapshotComplete
  ))?.agentCount ?? -1, { timeout: 30_000 }).toBe(targetCount)
  const dashboardSnapshotId = crtFrames.slice(dashboardSnapshotStart).find(frame => (
    frame.type === 'state' && frame.snapshotOffset === 0
  ))?.snapshotId
  const recoveredUnrelatedAgent = crtFrames.filter(frame => (
    frame.type === 'state' && frame.snapshotId === dashboardSnapshotId
  )).flatMap(frame => frame.stateAgents).find(agent => agent.id === unrelatedAgentId)
  expect(recoveredUnrelatedAgent?.terminalInputReceived).toBe(true)
  expect(recoveredUnrelatedAgent?.activityLevel).toBeTruthy()
  expect(typeof recoveredUnrelatedAgent?.unread).toBe('boolean')
  const dashboardDeltaStart = crtFrames.length
  const dashboardMutation = await page.request.patch(
    `/farming/api/agents/${encodeURIComponent(unrelatedAgentId)}`,
    { data: { customTitle: 'All scope dashboard mutation' } },
  )
  expect(dashboardMutation.ok()).toBeTruthy()
  await expect.poll(() => crtFrames.slice(dashboardDeltaStart).some(frame => (
    frame.type === 'state-delta' && frame.upsertAgentIds.includes(unrelatedAgentId)
  )), { timeout: 30_000 }).toBe(true)

  const autoCloseAgentId = requiredAgentId(initialAgentIds.find(agentId => (
    agentId !== mutatedAgentId && agentId !== unrelatedAgentId
  )), 'Automatic close test')
  await crtPage.evaluate(async agentId => {
    const openCrtSession = (window as typeof window & {
      openSession?: (targetAgentId: string) => Promise<void>
    }).openSession
    if (!openCrtSession) throw new Error('CRT openSession is unavailable')
    await openCrtSession(agentId)
  }, autoCloseAgentId)
  await expect(crtPage.locator('#session-modal')).toHaveClass(/active/)
  const automaticCloseSnapshotStart = crtFrames.length
  const removeFocusedAgent = await page.request.delete(
    `/farming/api/control/agents/${encodeURIComponent(autoCloseAgentId)}?recordHistory=0`,
  )
  expect(removeFocusedAgent.ok()).toBeTruthy()
  await expect(crtPage.locator('#session-modal')).not.toHaveClass(/active/, { timeout: 30_000 })
  await expect.poll(() => crtFrames.slice(automaticCloseSnapshotStart).findLast(frame => (
    frame.type === 'state' && frame.snapshotComplete
  ))?.agentCount ?? -1, { timeout: 30_000 }).toBe(targetCount - 1)
  const automaticCloseDeltaStart = crtFrames.length
  const automaticCloseMutation = await page.request.patch(
    `/farming/api/agents/${encodeURIComponent(unrelatedAgentId)}`,
    { data: { customTitle: 'Automatic close all-scope mutation' } },
  )
  expect(automaticCloseMutation.ok()).toBeTruthy()
  await expect.poll(() => crtFrames.slice(automaticCloseDeltaStart).some(frame => (
    frame.type === 'state-delta' && frame.upsertAgentIds.includes(unrelatedAgentId)
  )), { timeout: 30_000 }).toBe(true)

  const showMore = page.getByTestId('code-agent-show-more')
  for (let attempt = 0; attempt < 20 && await showMore.count(); attempt += 1) {
    await showMore.first().click()
  }
  await expect(showMore).toHaveCount(0)
  await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${mutatedAgentId}"]`)).toBeAttached()
  await expect(crtPage.locator('body')).toContainText(`AGENTS: ${targetCount}/${targetCount}`)
})
