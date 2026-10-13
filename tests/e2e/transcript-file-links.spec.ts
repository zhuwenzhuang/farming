import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`preserves C++ extension shorthand alongside working file links in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const settings = await page.request.post('/farming/api/settings', { data: { appearance } })
    expect(settings.ok()).toBeTruthy()
    const workspace = path.join(workspaceRoot, 'file-link-reader')
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'src', 'store.cpp'), '// Store implementation\nint value = 1;\n')
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    const response = await page.request.get(`/farming/api/agents/${agentId}/acp-transcript?maxTurns=5&media=external-v1`)
    expect(response.ok()).toBeTruthy()
    const identity = await response.json() as { sessionId: string; runtimeEpoch: string; toRevision: number }
    const revision = Number(identity.toRevision) + 1_000_000
    const shorthands = ['src/meta_store_base.h/.cpp', 'src/time_oracle_client.h/.cpp', 'src/async_http_server.h/.cpp']
    const text = [
      'These file pairs still need their extension points.',
      '',
      '| Location | Change |',
      '| --- | --- |',
      ...shorthands.map(reference => `| \`${reference}\` | Keep the provider interface |`),
      '| `src/Store.java` | Keep the executor interface |',
      '',
      'Inspect `src/store.cpp:2` or [the implementation](src/store.cpp).',
    ].join('\n')
    await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({
      json: {
        version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
        fromRevision: null, toRevision: revision, replace: true, settled: true, hasMoreBefore: false,
        transcript: { sessionId: identity.sessionId, provider: 'codex', revision, state: 'idle', entries: [
          { id: 'question', type: 'message', role: 'user', content: [{ type: 'text', text: 'List the remaining changes.' }] },
          { id: 'answer', type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text }] },
        ] },
      },
    }))
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const answer = page.locator('.code-agent-transcript-answer')
    await expect(answer.locator('table code')).toHaveText(shorthands)
    await expect(answer.getByRole('link', { name: '.cpp', exact: true })).toHaveCount(0)
    await expect(answer.getByRole('link', { name: 'Store.java', exact: true })).toBeVisible()
    await expect(answer.getByRole('link', { name: 'store.cpp', exact: true })).toBeVisible()
    const sourceLink = answer.getByRole('link', { name: 'store.cpp:2', exact: true })
    await expect(sourceLink).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await answer.screenshot({ path: testInfo.outputPath(`file-links-${appearance}.png`), animations: 'disabled' })
    await sourceLink.click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.getByRole('tab', { name: /^store\.cpp(?:,|$)/ })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getPosition()?.lineNumber)).toBe(2)
  })
}
