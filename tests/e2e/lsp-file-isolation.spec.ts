import fs from 'node:fs'
import path from 'node:path'
import { expect, mockLanguageServerTransport, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`stalled LSP cannot block Files or returning to Chat in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    fs.writeFileSync(path.join(workspaceRoot, 'Demo.java'), 'class Demo { int count = 1; }\n')
    fs.writeFileSync(path.join(workspaceRoot, 'Other.java'), 'class Other { int count = 2; }\n')
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/acp-session?includeEntries=0`)
      const body = await response.json() as { session?: { state?: string } }
      return body.session?.state
    }).toBe('idle')
    const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as { sessionId: string; runtimeEpoch: string }
    await page.route(new RegExp(`/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({ json: {
      version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
      fromRevision: null, toRevision: 1000000, replace: true, settled: true, hasMoreBefore: false,
      transcript: { sessionId: identity.sessionId, revision: 1000000, state: 'idle', entries: [
        { id: 'prompt', type: 'message', role: 'user', content: [{ type: 'text', text: 'Inspect the example.' }] },
        { id: 'answer', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: `Open [Demo.java](${path.join(workspaceRoot, 'Demo.java')}) to inspect the example.` }] },
      ] },
    } }))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let semanticStarts = 0
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await mockLanguageServerTransport(page, async request => {
      if (request.operation === 'capability') return { result: {
        status: 'ready', source: 'managed', enabled: true, features: ['semanticTokens', 'inlayHints', 'diagnostics'],
        workspaces: [], connections: [],
      } }
      semanticStarts += 1
      await gate
      return { error: { code: 'LANGUAGE_SERVER_PROCESS_EXITED', status: 503, message: 'Example server exited during startup' } }
    })
    try {
      await page.request.post('/farming/api/settings', { data: { appearance } })
      await page.setViewportSize({ width: 1280, height: 800 })
      await openFarming(page)
      const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
      await row.click()
      const chat = page.getByTestId('code-agent-transcript-scroll')
      const link = chat.getByRole('link', { name: 'Demo.java', exact: true })
      await link.click()
      await expect(page.getByTestId('code-file-monaco')).toBeVisible()
      await expect.poll(() => semanticStarts).toBeGreaterThanOrEqual(1)
      const files = page.getByTestId('code-files-section').first()
      const title = files.locator('.code-files-title').first()
      if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
      await files.locator('[data-testid="code-file-row"][data-file-path="Other.java"]').click()
      await expect(page.locator('.monaco-editor .view-lines')).toContainText('class Other', { timeout: 5000 })
      await row.click()
      await expect(link).toBeVisible()
      release()
      await link.click()
      await expect(page.locator('.monaco-editor .view-lines')).toContainText('class Demo')
      await row.click()
      await expect(link).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-input')).toBeEditable()
      await expect(page.getByTestId('code-acp-error')).toHaveCount(0)
      expect(errors).toEqual([])
      const screenshot = await page.screenshot({ path: testInfo.outputPath(`lsp-isolation-${appearance}.png`), animations: 'disabled' })
      expect(screenshot.readUInt32BE(16)).toBe(1280)
      expect(screenshot.readUInt32BE(20)).toBe(800)
      await testInfo.attach(`lsp-isolation-${appearance}`, { body: screenshot, contentType: 'image/png' })
    } finally {
      release()
    }
  })
}
