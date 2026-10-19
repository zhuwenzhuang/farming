import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '../fixtures'

test('characterizes repeated Agent read-state changes', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'flags-performance')
  fs.mkdirSync(workspace, { recursive: true })
  const created = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  try {
    const samples: Array<{ unread: boolean; durationMs: number }> = []
    for (let index = 0; index < 40; index += 1) {
      const unread = index % 2 === 0
      const start = performance.now()
      const response = await page.request.patch(`/farming/api/agents/${agentId}`, { data: { unread } })
      const durationMs = performance.now() - start
      expect(response.ok()).toBeTruthy()
      samples.push({ unread, durationMs })
    }
    const sorted = samples.map(sample => sample.durationMs).sort((a, b) => a - b)
    const result = { samples, p50Ms: sorted[19], p95Ms: sorted[37], maxMs: sorted[39] }
    console.log(`agent-flags-performance ${JSON.stringify(result)}`)
    await testInfo.attach('agent-flags-performance.json', { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' })
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
  }
})
