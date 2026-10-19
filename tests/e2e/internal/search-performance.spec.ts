import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from '../fixtures'

test('characterizes global file search through a 2000-file workspace', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'search-performance')
  fs.mkdirSync(workspace, { recursive: true })
  for (let index = 0; index < 2000; index += 1) {
    fs.writeFileSync(path.join(workspace, `needle-${String(index).padStart(4, '0')}.txt`), 'search fixture\n')
  }
  expect((await page.request.post('/farming/api/projects/mount', { data: { workspace } })).ok()).toBeTruthy()
  await openFarming(page)
  await page.getByTestId('code-nav-search').click()
  const input = page.getByRole('combobox', { name: 'Search projects, agents, or files' })
  await input.evaluate(element => {
    element.addEventListener('input', () => { element.setAttribute('data-bench-input-at', String(performance.now())) })
  })
  const samples: number[] = []
  for (let index = 0; index < 21; index += 1) {
    const query = `needle-${String(index).padStart(4, '0')}`
    await input.fill(query)
    const elapsed = await input.evaluate((element, expected) => new Promise<number>((resolve, reject) => {
      const start = Number(element.getAttribute('data-bench-input-at'))
      const inspect = () => {
        const rows = [...document.querySelectorAll('[data-testid="code-global-file-search-result"]')]
        if (rows.length === 1 && rows[0]?.textContent?.includes(expected) && rows[0].getBoundingClientRect().height > 0) {
          resolve(performance.now() - start)
        } else if (performance.now() - start > 8000) reject(new Error(`Search did not display ${expected}`))
        else requestAnimationFrame(inspect)
      }
      requestAnimationFrame(inspect)
    }), query)
    samples.push(elapsed)
  }
  const sorted = samples.slice(1).sort((a, b) => a - b)
  const result = {
    files: 2000, coldMs: samples[0], warmSamplesMs: samples.slice(1),
    p50Ms: sorted[9], p95Ms: sorted[18], maxMs: sorted[19],
    diagnostics: await (await page.request.get('/farming/api/diagnostics/performance')).json(),
  }
  console.log(`search-performance ${JSON.stringify({ coldMs: result.coldMs, p50Ms: result.p50Ms, p95Ms: result.p95Ms, maxMs: result.maxMs })}`)
  await testInfo.attach('search-performance.json', { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' })
  expect(samples).toHaveLength(21)
})
