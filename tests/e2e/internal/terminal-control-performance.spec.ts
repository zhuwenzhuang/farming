import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '../fixtures'

function summary(samplesMs: number[]) {
  const sorted = [...samplesMs].sort((a, b) => a - b)
  return { n: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1), samplesMs }
}

// Control-plane timing for comparison with local terminal supervisors. This is
// HTTP admission/read observation, not the browser WebSocket/rendering path.
test('characterizes terminal control through 1 15 and 50 Agents', async ({ page, workspaceRoot, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  const workspace = path.join(workspaceRoot, 'terminal-control-performance')
  fs.mkdirSync(workspace, { recursive: true })
  const ids: string[] = []
  const results: unknown[] = []
  try {
    for (const count of [1, 15, 50]) {
      while (ids.length < count) {
        const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
        expect(response.ok()).toBeTruthy()
        ids.push((await response.json() as { agentId: string }).agentId)
      }
      const endpoint = `${baseURL}/farming/api/control/agents/${ids[0]}`
      const samples = { inputAdmission: [] as number[], inputToReadOutput: [] as number[], outputRead: [] as number[] }
      for (let index = 0; index < 35; index += 1) {
        const marker = `bench-output-${count}-${index}`
        const start = performance.now()
        const admission = await fetch(`${endpoint}/input`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: `printf 'bench-output-%s-%s\\n' ${count} ${index}\r` }),
        })
        await admission.text()
        const admissionMs = performance.now() - start
        expect(admission.ok).toBeTruthy()
        let readMs = 0
        for (;;) {
          const readStart = performance.now()
          const response = await fetch(`${endpoint}/output?tail=4096`)
          const output = await response.text()
          readMs = performance.now() - readStart
          expect(response.ok).toBeTruthy()
          if (output.includes(marker)) break
          if (performance.now() - start > 3000) throw new Error(`Missing terminal output: ${marker}`)
          await new Promise(resolve => setTimeout(resolve, 1))
        }
        samples.inputAdmission.push(admissionMs)
        samples.inputToReadOutput.push(performance.now() - start)
        samples.outputRead.push(readMs)
      }
      const result = { agents: count, metrics: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, summary(values.slice(5))])) }
      results.push(result)
      console.log(`terminal-control-performance ${JSON.stringify(result)}`)
    }
    await testInfo.attach('terminal-control-performance.json', { body: Buffer.from(JSON.stringify(results, null, 2)), contentType: 'application/json' })
  } finally {
    for (const id of ids) await page.request.delete(`/farming/api/control/agents/${id}?recordHistory=0`)
  }
})
