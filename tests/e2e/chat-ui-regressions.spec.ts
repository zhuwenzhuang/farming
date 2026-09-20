import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

const shell = '"$S/venv/bin/python" "$S/host_client.py" poll example-job'

test('shell variables remain literal and exhausted Chat history stays exhausted after live deltas', async ({ page, workspaceRoot }, testInfo) => {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  const limits: number[] = []
  let omittedPrefixDeltas = 0
  await page.route(`**/api/agents/${agentId}/acp-transcript?*`, async route => {
    const response = await route.fetch()
    const payload = await response.json()
    limits.push(Number(new URL(route.request().url()).searchParams.get('maxTurns')))
    if (!payload.replace && payload.hasMoreBefore) omittedPrefixDeltas++
    for (const entry of payload.transcript?.entries || []) {
      if (entry.type !== 'message' || entry.role !== 'assistant') continue
      for (const content of entry.content || []) {
        if (content.type === 'text' && content.text.includes('Phase-aware rich answer.')) {
          content.text = `${shell}\n\nReal math: $x^2$.\n\n${Array.from({ length: 25 }, (_, i) => `History paragraph ${i}: preserve the original reading position.`).join('\n\n')}`
        }
      }
    }
    await route.fulfill({ response, json: payload })
  })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('phase-aware mermaid')
  await page.getByTestId('code-acp-composer-send').click()
  const scroll = page.getByTestId('code-agent-transcript-scroll')
  await expect(scroll).toContainText(shell)
  await expect(scroll.locator('.katex annotation')).toHaveText(['x^2'])
  await input.fill('streaming command activity')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(scroll).toContainText('Streaming command completed.')
  await expect.poll(() => omittedPrefixDeltas).toBeGreaterThan(0)
  await scroll.evaluate(element => { element.setAttribute('data-retained-probe', 'original'); element.scrollTop = 0 })
  await scroll.hover()
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -700)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(scroll).toHaveAttribute('data-retained-probe', 'original')
  }
  expect(limits.every(limit => limit === 5)).toBe(true)
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await scroll.screenshot({ path: testInfo.outputPath(`${appearance}-literal-shell.png`) })
  }
})

test('file refresh feedback disappears without flashing the idle glyph', async ({ page, workspaceRoot }, testInfo) => {
  fs.writeFileSync(path.join(workspaceRoot, 'sample.txt'), 'sample')
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: workspaceRoot },
  })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  const files = page.getByTestId('code-files-section').first()
  const header = files.locator('.code-files-header')
  const refresh = files.getByTestId('code-files-refresh')
  const actions = files.getByTestId('code-files-header-actions')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await header.hover()
    await refresh.click()
    await page.mouse.move(1000, 500)
    await expect(refresh).toHaveAttribute('data-refresh-status', 'success')
    await header.screenshot({ path: testInfo.outputPath(`${appearance}-refresh-success.png`) })
    const firstIdleOpacity = await actions.evaluate(element => new Promise<string>((resolve, reject) => {
      const deadline = performance.now() + 5000
      function sample() {
        if (element.getAttribute('data-refresh-status') === 'idle') {
          resolve(getComputedStyle(element).opacity)
          return
        }
        if (performance.now() > deadline) { reject(new Error('Refresh did not settle')); return }
        requestAnimationFrame(sample)
      }
      sample()
    }))
    expect(firstIdleOpacity).toBe('0')
    await header.hover()
    await expect(actions).toHaveCSS('opacity', '1')
    await expect(refresh).toHaveAccessibleName('Refresh files')
  }
})
