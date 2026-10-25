import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  for (const width of [1440, 390]) {
    test(`keeps Markdown whole across Steer in ${appearance} at ${width}px`, async ({ page, workspaceRoot }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.request.post('/farming/api/settings', { data: { appearance } })
      const workspace = path.join(workspaceRoot, 'steer-markdown')
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
      const fragment = (id: string, text: string) => ({
        id, type: 'message', role: 'assistant', messageId: 'explanation',
        _meta: { codex: { phase: 'commentary' } }, content: [{ type: 'text', text }],
      })
      const steer = (id: string, text: string) => ({
        id, type: 'message', role: 'user', _meta: { farming: { steer: true } }, content: [{ type: 'text', text }],
      })
      const entries: Array<Record<string, unknown>> = [
        { id: 'question', type: 'message', role: 'user', content: [{ type: 'text', text: 'Explain the plan limit.' }] },
        { id: 'read', type: 'tool', title: 'Read settings', kind: 'read', status: 'completed' },
        fragment('first', '**23,400 comes from 780 × 30.**\n\nSee [Settings.java](https://example.com/demo/src/Set'),
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
      const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'Explain the plan limit.' })
      const progress = turn.getByTestId('code-acp-progress-update')
      await expect(progress).toContainText('23,400 comes from 780 × 30.')
      entries.push(steer('steer-link', '为什么成功结束后还需要重启 Worker？'))
      await refresh()
      await expect(turn.getByTestId('code-agent-transcript-steer')).toHaveCount(1)
      entries.push(fragment('second', 'tings.java#L26).\n\n```sql\nselect '))
      await refresh()
      await expect(progress.getByRole('link', { name: 'Settings.java' })).toHaveAttribute('href', 'https://example.com/demo/src/Settings.java#L26')
      entries.push(steer('steer-code', 'Also check the calculation.'))
      entries.push(fragment('third', '780 * 30;\n```\n\n| Limit | Value |\n| --- | --- |\n| instances | 23'))
      await refresh()
      await expect(progress.locator('pre code')).toContainText('select 780 * 30;')
      entries.push(steer('steer-table', 'Keep the source reference.'))
      entries.push(fragment('fourth', '400 |'))
      await refresh()
      const verify = async () => {
        await expect(progress).toHaveCount(1)
        await expect(progress.getByRole('link', { name: 'Settings.java' })).toHaveAttribute('href', 'https://example.com/demo/src/Settings.java#L26')
        await expect(progress.locator('pre code')).toHaveText('select 780 * 30;')
        await expect(progress.getByRole('cell', { name: '23400', exact: true })).toBeVisible()
        await expect(turn.getByTestId('code-agent-transcript-steer')).toHaveCount(3)
        const order = await turn.locator('.code-agent-transcript-process-list').evaluate(element =>
          Array.from(element.children).filter(child => child.matches('[data-testid="code-acp-progress-update"], [data-testid="code-agent-transcript-steer"]'))
            .map(child => child.getAttribute('data-testid')))
        expect(order).toEqual(['code-acp-progress-update', ...Array(3).fill('code-agent-transcript-steer')])
      }
      await verify()
      await page.screenshot({ path: testInfo.outputPath(`steer-markdown-live-${appearance}-${width}.png`), animations: 'disabled' })
      entries.push({ id: 'final', type: 'message', role: 'assistant', messageId: 'final', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: 'Verified the calculation and source.' }] })
      active = false
      await refresh()
      await expect(turn.locator('.code-agent-transcript-answer')).toContainText('Verified the calculation and source.')
      await page.reload()
      await expect(progress).toHaveCount(0)
      await turn.getByTestId('code-agent-transcript-process-summary').click()
      await verify()
      await page.screenshot({ path: testInfo.outputPath(`steer-markdown-restored-${appearance}-${width}.png`), animations: 'disabled' })
    })
  }
}
