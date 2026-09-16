import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`ACP startup pending is quiet and real read failures stay visible in ${appearance}`, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'chat-startup')
    fs.mkdirSync(workspace, { recursive: true })
    const create = async (command: string) => {
      const response = await page.request.post('/farming/api/control/agents', {
        data: { command, workspace, ...(command === 'codex' ? { agentRuntimeMode: 'chat' } : {}) },
      })
      expect(response.ok()).toBeTruthy()
      return (await response.json() as { agentId: string }).agentId
    }
    const agentId = await create('codex')
    const shellId = await create('bash')
    const sessionPath = `/farming/api/agents/${agentId}/acp-session?includeEntries=0`
    await expect.poll(async () => {
      const response = await page.request.get(sessionPath)
      return (await response.json()).session?.state
    }).toBe('idle')
    let phase: 'pending' | 'failed' | 'ready' = 'pending'
    let pendingReads = 0
    await page.route(sessionPath, async route => {
      if (phase === 'pending') {
        pendingReads++
        await route.fulfill({ status: 202, json: { pending: true, session: null } })
      } else if (phase === 'failed') {
        await route.fulfill({ status: 409, json: { error: 'ACP initialization failed' } })
      } else {
        await route.continue()
      }
    })
    await openFarming(page)
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    const agentRow = (id: string) => page.locator(`[data-testid="code-agent-row"][data-agent-id="${id}"]`)
    await agentRow(agentId).click()
    await expect.poll(() => pendingReads).toBeGreaterThan(0)
    const input = page.getByTestId('code-acp-composer-input')
    await input.fill('Keep my draft while Chat connects')
    await expect(page.getByTestId('code-acp-error')).toHaveCount(0)
    await test.info().attach(`acp-startup-pending-${appearance}`, {
      body: await page.getByTestId('code-acp-composer-stack').screenshot(),
      contentType: 'image/png',
    })

    phase = 'failed'
    await agentRow(shellId).click()
    await agentRow(agentId).click()
    await expect(page.getByTestId('code-acp-error')).toContainText('ACP initialization failed')
    await expect(input).toHaveValue('Keep my draft while Chat connects')

    phase = 'ready'
    await agentRow(shellId).click()
    await agentRow(agentId).click()
    await expect(page.getByTestId('code-acp-error')).toHaveCount(0)
    await expect(input).toHaveValue('Keep my draft while Chat connects')
  })
}
