import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const provider of ['codex', 'claude']) {
  test(`does not insert child inventory errors while ${provider} connects`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, `${provider}-startup`)
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: provider, workspace, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    let phase = 'connecting'
    let requests = 0
    let failRead = true
    let binding: Record<string, unknown> | null = null
    let sendPhase: ((state: string) => void) | undefined
    await page.route(`**/api/agents/${agentId}/related-sessions`, async route => {
      requests++
      if (phase || failRead) {
        await route.fulfill({ status: 409, json: { error: phase ? 'ACP Agent is still connecting' : 'Inventory read failed' } })
      } else await route.continue()
    })
    await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => server.send(message))
      const holdStartup = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(holdStartup)
        if (!value || typeof value !== 'object') return value
        const record = value as Record<string, unknown>
        if (record.id === agentId && record.runtimeBinding && typeof record.runtimeBinding === 'object') {
          binding = record.runtimeBinding as Record<string, unknown>
          return { ...record, runtimeBinding: { ...binding, state: phase || binding.state } }
        }
        if (record.agentId === agentId && record.patch && typeof record.patch === 'object') {
          const patch = record.patch as Record<string, unknown>
          if (patch.runtimeBinding && typeof patch.runtimeBinding === 'object') {
            binding = patch.runtimeBinding as Record<string, unknown>
            return { ...record, patch: { ...patch, runtimeBinding: { ...binding, state: phase || binding.state } } }
          }
        }
        return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, holdStartup(child)]))
      }
      server.onMessage(message => socket.send(JSON.stringify(holdStartup(JSON.parse(String(message))))))
      sendPhase = state => {
        phase = state
        socket.send(JSON.stringify({ type: 'agent-update', update: { agentId, patch: {
          runtimeBinding: { ...binding, state: state || 'idle' },
        } } }))
      }
    })
    try {
      await openFarming(page)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      for (const state of ['starting', 'connecting', 'reconnecting']) {
        expect(binding).not.toBeNull()
        sendPhase?.(state)
        // Sample after layout/paint, not only after the eventual idle state.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await expect(page.getByTestId('code-related-inventory-error')).toHaveCount(0)
        expect(requests).toBe(0)
      }
      await page.screenshot({ path: testInfo.outputPath(`${provider}-connecting.png`), animations: 'disabled' })
      sendPhase?.('')
      await expect(page.getByTestId('code-related-inventory-error')).toBeVisible()
      expect(requests).toBe(1)
      failRead = false
      await page.getByTestId('code-related-inventory-error').click()
      await expect(page.getByTestId('code-related-inventory-error')).toHaveCount(0)
      await expect(page.getByTestId('code-native-related-row')).toHaveCount(0)
      expect(requests).toBe(2)
      await page.screenshot({ path: testInfo.outputPath(`${provider}-ready.png`), animations: 'disabled' })
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    }
  })
}
