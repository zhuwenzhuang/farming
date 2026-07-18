import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from '../fixtures'

type RenderSnapshot = {
  app: number
  codeWorkspace: number
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
        }
        frames.push({
          type: message.type || 'unknown',
          agentId: message.preview?.agentId || message.update?.agentId || '',
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
    frame.type === 'session-preview' && frame.agentId === parkedAgentId
  )), { timeout: 15_000 }).toBe(true)
  await page.waitForTimeout(100)

  const renders = await page.evaluate(() => (
    window.__farmingPerformanceTest?.snapshot() ?? { app: 0, codeWorkspace: 0 }
  )) as RenderSnapshot
  expect(frames.filter(frame => frame.type === 'state')).toHaveLength(0)
  expect(renders.app).toBe(0)
  expect(renders.codeWorkspace).toBe(0)
})
