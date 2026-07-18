import { expect, openFarming, test } from '../fixtures'

type RenderSnapshot = {
  app: number
  codeWorkspace: number
}

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
