import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

const citation = '\uE200cite\uE202turn944082view0\uE201'
for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`renders private citations without leaking opaque references in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.request.post('/farming/api/settings', { data: { appearance } })
    const workspace = path.join(workspaceRoot, 'citation-reader')
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
    let text = 'Verified answer.\uE200cite\uE202turn944082'
    let state = 'working'
    await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
        fromRevision: null, toRevision: revision, replace: true, settled: true, hasMoreBefore: false,
        transcript: { sessionId: identity.sessionId, provider: 'codex', revision, state, entries: [
          { id: 'question', type: 'message', role: 'user', content: [{ type: 'text', text: 'Summarize the source.' }] },
          { id: 'answer', type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text }] },
        ] },
      }),
    }))
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const answer = page.locator('.code-agent-transcript-answer')
    await expect(answer).toHaveText('Verified answer.')
    text = `Verified answer.${citation} See [the source](https://example.com/source).\n\nLiteral syntax: \`${citation}\`\n\n\`\`\`text\n${citation}\n\`\`\``
    revision += 1
    state = 'idle'
    await page.evaluate(() => {
      window.dispatchEvent(new Event('farming:backend-disconnected'))
      window.dispatchEvent(new Event('farming:backend-connected'))
    })
    await expect(answer.getByRole('link', { name: 'the source' })).toHaveAttribute('href', 'https://example.com/source')
    await expect(answer.locator('p').first()).toHaveText('Verified answer. See the source.')
    await expect(answer.locator('p code')).toHaveText(citation)
    await expect(answer.locator('pre code')).toContainText(citation)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: testInfo.outputPath(`citations-${appearance}.png`), animations: 'disabled' })
  })
}
