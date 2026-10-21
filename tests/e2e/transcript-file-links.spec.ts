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
      '',
      `[File URL](file://${workspace}/src/store.cpp) · [Line](file://${workspace}/src/store.cpp#L2) · [Range](file://${workspace}/src/store.cpp#L2-L3)`,
      '',
      '[External source](https://example.com/store.cpp#L2) · [Unsafe](javascript:alert%281%29)',
      '[Missing reference](src/missing.cpp#L5)',
      '[`src/store.cpp:2`](src/also-missing.cpp)',
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
    const batches: string[][] = []
    const held: Array<() => void> = []
    let holdChecks = true
    await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => {
        const payload = JSON.parse(String(message)) as { type?: string; request?: { operation?: string; paths?: string[] } }
        if (payload.type === 'workspace-request' && payload.request?.operation === 'file-link-access') {
          batches.push(payload.request.paths || [])
          if (holdChecks) { held.push(() => server.send(message)); return }
        }
        server.send(message)
      })
    })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const answer = page.locator('.code-agent-transcript-answer')
    await expect(answer).toContainText('These file pairs still need their extension points.')
    await expect(answer.getByRole('link', { name: 'store.cpp:2', exact: true })).toHaveCount(0)
    await expect.poll(() => batches.length).toBeGreaterThan(0)
    expect(batches.flat().filter(path => path === 'src/store.cpp')).toHaveLength(1)
    holdChecks = false
    held.splice(0).forEach(send => send())
    await expect(answer.locator('table code')).toHaveText([...shorthands, 'src/Store.java'])
    await expect(answer.getByRole('link', { name: '.cpp', exact: true })).toHaveCount(0)
    await expect(answer.getByRole('link', { name: 'Store.java', exact: true })).toHaveCount(0)
    await expect(answer).toContainText('Missing reference')
    await expect(answer.getByRole('link', { name: 'Missing reference', exact: true })).toHaveCount(0)
    await expect(answer.getByRole('link', { name: 'store.cpp', exact: true })).toHaveCount(2)
    await expect(answer.getByRole('link', { name: 'store.cpp:2', exact: true })).toHaveCount(3)
    const sourceLink = answer.getByRole('link', { name: 'store.cpp:2', exact: true }).first()
    const fileUrlLinks = [
      answer.getByRole('link', { name: 'store.cpp', exact: true }).last(),
      answer.getByRole('link', { name: 'store.cpp:2', exact: true }).nth(1),
      answer.getByRole('link', { name: 'store.cpp:2', exact: true }).nth(2),
    ]
    await expect(sourceLink).toBeVisible()
    for (const link of fileUrlLinks) {
      await expect(link).toHaveAttribute('href', '#')
    }
    await expect(answer.getByRole('link', { name: 'External source', exact: true })).toHaveAttribute('href', 'https://example.com/store.cpp#L2')
    await expect(answer.getByRole('link', { name: 'Unsafe', exact: true })).toHaveCount(0)
    await page.evaluate(() => document.fonts.ready)
    await answer.screenshot({ path: testInfo.outputPath(`file-links-${appearance}.png`), animations: 'disabled' })
    await sourceLink.click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.getByRole('tab', { name: /^store\.cpp(?:,|$)/ })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getPosition()?.lineNumber)).toBe(2)
    for (const [index, link] of fileUrlLinks.entries()) {
      expect(await page.evaluate(() => window.__farmingFileEditorTest?.revealLine(1))).toBe(true)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      await link.click()
      await expect(page.getByTestId('code-file-editor')).toBeVisible()
      if (index > 0) {
        await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getPosition()?.lineNumber)).toBe(2)
      }
    }
  })
}
