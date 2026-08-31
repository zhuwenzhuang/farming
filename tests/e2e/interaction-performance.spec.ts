import fs from 'node:fs'
import path from 'node:path'
import { test, expect, openFarming } from './fixtures'

test('editor typing and save retain content-free interaction diagnostics', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'interaction-editor')
  fs.mkdirSync(workspace, { recursive: true })
  const file = path.join(workspace, 'large-example.txt')
  const original = Array.from({ length: 8000 }, (_, i) => `Example row ${i}: a production-shaped working copy.`).join('\n')
  fs.writeFileSync(file, original)
  expect((await page.request.post('/farming/api/projects/mount', { data: { workspace } })).ok()).toBeTruthy()
  await openFarming(page)
  const project = page.getByTestId('code-project-group').filter({ hasText: 'interaction-editor' })
  const files = project.getByTestId('code-files-section')
  const title = files.locator('.code-files-title').first()
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
  await files.locator('[data-file-path="large-example.txt"]').dblclick()
  const editor = page.getByTestId('code-file-editor')
  await expect(editor.locator('.monaco-editor')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe(original)
  await editor.locator('.view-lines').click({ position: { x: 40, y: 10 } })
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('PRIVATE_TYPED_VALUE', { delay: 30 })
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toContain('PRIVATE_TYPED_VALUE')
  await expect.poll(() => page.evaluate(() => window.farmingPerformance?.snapshot().records.filter(record => (
    record.operation === 'editor.input' && record.outcome === 'observed' && record.stages.frame !== undefined
  )).length ?? 0)).toBeGreaterThan(0)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('PRIVATE_TYPED_VALUE')
  await expect.poll(() => page.evaluate(() => window.farmingPerformance?.snapshot().records.some(record => record.operation === 'file.save' && record.outcome === 'completed'))).toBe(true)
  // A controlled browser main-thread stall must be visible independently of network timings.
  await page.evaluate(() => { setTimeout(() => { const until = performance.now() + 120; while (performance.now() < until) { /* controlled test workload */ } }, 0) })
  await expect.poll(() => page.evaluate(() => window.farmingPerformance?.snapshot().records.some(record => record.operation === 'browser.long-task' && record.metrics.longTaskMaxMs! >= 100))).toBe(true)
  const snapshot = await page.evaluate(() => window.farmingPerformance!.snapshot())
  expect(snapshot.records.filter(record => record.operation === 'file.open'), 'file-open observation must survive double-click pinning')
    .toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'observed' })]))
  expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_TYPED_VALUE|large-example|Example row|interaction-editor/)
  const typing = snapshot.records.filter(record => record.operation === 'editor.input' && record.outcome === 'observed')
  typing.forEach(record => {
    expect(record.stages.model).toBeLessThanOrEqual(record.stages.draft!)
    expect(record.stages.draft).toBeLessThanOrEqual(record.stages.frame!)
    expect(record.metrics.contentUnits).toBeGreaterThan(300000)
  })
  const durations = typing.map(record => record.durationMs).sort((a, b) => a - b)
  console.log(`editor interaction diagnostics: ${typing.length} keys, event-to-frame p95=${durations[Math.ceil(durations.length * .95) - 1]}ms`)
})
