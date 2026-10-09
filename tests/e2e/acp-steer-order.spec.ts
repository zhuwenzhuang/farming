import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII='
const assistant = (id: string, phase: string, text: string, withImage = false) => ({
  id, type: 'message', role: 'assistant', _meta: { codex: { phase } },
  content: [{ type: 'text', text }, ...(withImage ? [{ type: 'image', mimeType: 'image/png', data: image }] : [])],
})

for (const appearance of ['light', 'dark', 'paper'] as const) {
  for (const width of [1440, 390]) {
    test(`keeps continued Steer answers chronological in ${appearance} at ${width}px`, async ({ page, workspaceRoot }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.request.post('/farming/api/settings', { data: { appearance } })
      const workspace = path.join(workspaceRoot, 'steer-answer-order')
      fs.mkdirSync(workspace, { recursive: true })
      const created = await page.request.post('/farming/api/control/agents', {
        data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
      })
      expect(created.ok()).toBeTruthy()
      const { agentId } = await created.json() as { agentId: string }
      const identityResponse = await page.request.get(`/farming/api/agents/${agentId}/acp-transcript?maxTurns=5&media=external-v1`)
      expect(identityResponse.ok()).toBeTruthy()
      const identity = await identityResponse.json() as { sessionId: string; runtimeEpoch: string; toRevision: number }
      let revision = Number(identity.toRevision) + 1_000_000
      let active = true
      const entries: Array<Record<string, unknown>> = [
        { id: 'question', type: 'message', role: 'user', content: [{ type: 'text', text: 'Check the streamed answer order.' }] },
        assistant('comment-before', 'commentary', 'Inspecting the source.'),
        { id: 'steer', type: 'message', role: 'user', _meta: { farming: { steer: true } }, content: [{ type: 'text', text: 'Also check ordering.' }] },
        assistant('first-answer', 'final_answer', '**First finding** with an image.', true),
      ]
      await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
          fromRevision: null, toRevision: revision, replace: true, settled: true, hasMoreBefore: false,
          transcript: { sessionId: identity.sessionId, provider: 'codex', revision, state: active ? 'working' : 'idle', entries },
        }),
      }))
      const refresh = async () => {
        revision += 1
        await page.evaluate(() => {
          window.dispatchEvent(new Event('farming:backend-disconnected'))
          window.dispatchEvent(new Event('farming:backend-connected'))
        })
      }
      await openFarming(page)
      const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
      if (!await row.isVisible() && await page.getByTestId('code-mobile-menu').isVisible()) {
        await page.getByTestId('code-mobile-menu').click()
      }
      await row.click()
      const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'Check the streamed answer order.' })
      await expect(turn.locator('.code-agent-transcript-answer strong')).toHaveText('First finding')
      entries.push(assistant('comment-after', 'commentary', 'Checking the next detail.'))
      entries.push({ id: 'check-tool', type: 'tool', title: 'Check ordering', kind: 'execute', status: 'in_progress' })
      await refresh()
      const earlier = turn.getByTestId('code-acp-answer-segment')
      await expect(earlier.locator('strong')).toHaveText('First finding')
      await expect(earlier.locator('img')).toHaveCount(1)
      await expect(earlier.locator('img')).toHaveJSProperty('naturalWidth', 1)
      const chronology = () => turn.evaluate(element => Array.from(element.querySelectorAll(
        '.code-agent-transcript-process-list > [data-testid="code-acp-progress-update"], '
        + '.code-agent-transcript-process-list > [data-testid="code-acp-answer-segment"], '
        + '.code-agent-transcript-process-list > [data-testid="code-agent-transcript-steer"]',
      )).map(node => node.querySelector('.code-agent-transcript-steer-content')?.textContent?.trim() || node.textContent?.trim()))
      await expect.poll(chronology).toEqual([
        'Inspecting the source.', 'Also check ordering.', 'First finding with an image.', 'Checking the next detail.',
      ])
      await expect(turn.locator('.code-agent-transcript-answer')).toHaveCount(0)
      await expect.poll(async () => {
        const answerBox = await earlier.boundingBox()
        const commentBox = await turn.getByText('Checking the next detail.', { exact: true }).boundingBox()
        return Boolean(answerBox && commentBox && answerBox.y + answerBox.height <= commentBox.y)
      }).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`active-continuation-${appearance}-${width}.png`), animations: 'disabled' })
      entries.push(assistant('latest-answer', 'final_answer', 'Final'))
      await refresh()
      await expect(turn.locator('.code-agent-transcript-answer')).toHaveText('Final')
      entries[entries.length - 1] = assistant('latest-answer', 'final_answer', 'Final result.')
      await refresh()
      await expect(turn.locator('.code-agent-transcript-answer')).toContainText('Final result.')
      await expect(earlier).toHaveCount(1)
      await page.screenshot({ path: testInfo.outputPath(`active-final-${appearance}-${width}.png`), animations: 'disabled' })
      active = false
      await refresh()
      await expect(turn).not.toHaveClass(/running/)
      await expect(turn.locator('.code-agent-transcript-answer')).toContainText('Final result.')
      await expect(earlier).toHaveCount(0)
      await page.reload()
      await expect(turn.locator('.code-agent-transcript-answer')).toContainText('Final result.')
      await expect(earlier).toHaveCount(0)
      await turn.getByTestId('code-agent-transcript-process-summary').click()
      await expect(earlier.locator('strong')).toHaveText('First finding')
      await expect(earlier.locator('img')).toHaveJSProperty('naturalWidth', 1)
      await expect.poll(chronology).toEqual([
        'Inspecting the source.', 'Also check ordering.', 'First finding with an image.', 'Checking the next detail.',
      ])
      await page.screenshot({ path: testInfo.outputPath(`settled-expanded-${appearance}-${width}.png`), animations: 'disabled' })
    })
  }
}
