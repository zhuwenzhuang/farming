import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from '../fixtures'

type SendSample = { requestId: string; sent: number; accepted?: number; frame?: number }
type ProbeWindow = Window & { __composerSamples: SendSample[]; __composerLongTasks: Array<{ start: number; duration: number }> }

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) }
}

// Measure the real browser socket and server admission with a deterministic ACP
// provider. Acceptance is not model first-token latency or GPU presentation.
for (const command of ['codex', 'claude']) {
  test(`characterizes ${command} composer admission across repeated turns`, async ({ page, workspaceRoot }, testInfo) => {
    test.setTimeout(120_000)
    const workspace = path.join(workspaceRoot, `composer-performance-${command}`)
    fs.mkdirSync(workspace, { recursive: true })
    await page.addInitScript(() => {
      const samples: SendSample[] = []
      ;(window as ProbeWindow).__composerSamples = samples
      const longTasks: Array<{ start: number; duration: number }> = []
      ;(window as ProbeWindow).__composerLongTasks = longTasks
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration })
      }).observe({ type: 'longtask', buffered: true })
      const observed = new WeakSet<WebSocket>()
      const originalSend = WebSocket.prototype.send
      WebSocket.prototype.send = function send(data) {
        if (!observed.has(this)) {
          observed.add(this)
          this.addEventListener('message', event => {
            if (typeof event.data !== 'string') return
            let message: { type?: string; requestId?: string; phase?: string; accepted?: boolean }
            try { message = JSON.parse(event.data) } catch { return }
            if (!(message.type === 'composer-input-result' && message.accepted)
              && !(message.type === 'composer-input-status' && message.phase === 'submitted')) return
            const sample = samples.find(item => item.requestId === message.requestId)
            if (!sample || sample.accepted !== undefined) return
            sample.accepted = performance.now()
            requestAnimationFrame(() => { sample.frame = performance.now() })
          })
        }
        if (typeof data === 'string') {
          try {
            const message = JSON.parse(data) as { type?: string; requestId?: string }
            if (message.type === 'composer-input' && message.requestId) samples.push({ requestId: message.requestId, sent: performance.now() })
          } catch { /* Other socket protocols do not necessarily use JSON. */ }
        }
        return originalSend.call(this, data)
      }
    })
    const created = await page.request.post('/farming/api/control/agents', { data: { command, workspace, agentRuntimeMode: 'chat' } })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    try {
      await openFarming(page)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      const input = page.getByTestId('code-acp-composer-input')
      for (let index = 0; index < 31; index += 1) {
        await input.fill(`image attachment performance sample ${index}`)
        await page.getByTestId('code-acp-composer-send').click()
        await expect(page.getByTestId('code-acp-submission')).toHaveCount(0)
        await expect.poll(async () => (await (await page.request.get(`/farming/api/agents/${agentId}/acp-session`)).json()).session?.chatTurn?.status).toBe('completed')
        await page.waitForFunction(count => (window as ProbeWindow).__composerSamples.length === count
          && (window as ProbeWindow).__composerSamples.at(-1)?.frame !== undefined, index + 1)
      }
      const samples = await page.evaluate(() => (window as ProbeWindow).__composerSamples)
      const warm = samples.slice(1)
      const diagnostics = await (await page.request.get('/farming/api/diagnostics/performance')).json()
      const result = {
        command, cold: samples[0], samples,
        longTasks: await page.evaluate(() => (window as ProbeWindow).__composerLongTasks),
        warmAcceptanceMs: summarize(warm.map(sample => sample.accepted! - sample.sent)),
        warmFrameMs: summarize(warm.map(sample => sample.frame! - sample.sent)),
        diagnostics,
      }
      console.log(`composer-performance ${JSON.stringify({ command, warmAcceptanceMs: result.warmAcceptanceMs, warmFrameMs: result.warmFrameMs })}`)
      await testInfo.attach(`composer-performance-${command}.json`, { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' })
      expect(warm).toHaveLength(30)
      expect(result.warmAcceptanceMs.p95).toBeLessThan(250)
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    }
  })
}
