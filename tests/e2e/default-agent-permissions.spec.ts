import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

const permissionModes = [
  { provider: 'codex', ordinary: 'agent', bypass: 'agent-full-access' },
  { provider: 'claude', ordinary: 'default', bypass: 'bypassPermissions' },
  { provider: 'qoder', ordinary: 'default', bypass: 'bypassPermissions' },
  { provider: 'qwen', ordinary: 'default', bypass: 'yolo' },
  { provider: 'agy', ordinary: 'agent_decides', bypass: 'bypassPermissions' },
]
for (const { provider, ordinary, bypass } of permissionModes) {
 for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`new ${provider} Agents honor the current bypass default in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const seeded = await page.request.post('/farming/api/settings', { data: {
      appearance,
      dangerouslySkipAgentPermissionsByDefault: false,
      agentLaunchProfiles: { codex: { approvalMode: 'approve' }, claude: { permissionMode: 'default' } },
    } })
    expect(seeded.ok()).toBe(true)
    const modesFixture = path.join(workspaceRoot, '.fake-acp-permission-modes')
    fs.writeFileSync(modesFixture, JSON.stringify({ currentModeId: ordinary,
      availableModes: [{ id: ordinary, name: 'Default' }, { id: bypass, name: 'Bypass permissions' }],
    }))
    try {
      await openFarming(page)
      await openNewAgentDialog(page)
      await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

      const launchChat = async (provider: string) => {
        const project = page.getByTestId('code-project-group').first()
        await project.hover()
        await project.getByTestId('code-project-new-agent').click({ force: true })
        await page.getByTestId(`code-project-agent-launch-${provider}`).click()
      }
      await launchChat(provider)
      const mode = page.getByTestId('code-acp-mode')
      await expect(mode).toHaveAttribute('data-acp-value', ordinary)

      await page.getByTestId('code-sidebar-options').click()
      const settings = page.getByTestId('code-settings-panel')
      const toggle = settings.getByRole('checkbox', { name: 'Skip all agent permission checks by default', exact: true })
      await expect(toggle).toHaveAttribute('aria-pressed', 'false')
      const saved = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'POST')
      await toggle.click()
      expect((await saved).ok()).toBe(true)
      await expect(toggle).toBeEnabled()
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')
      await settings.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(settings).toBeHidden()
      await expect(mode).toHaveAttribute('data-acp-value', ordinary)

      await launchChat(provider)
      await expect(mode).toHaveAttribute('data-acp-value', bypass)
      await testInfo.attach(`default-permissions-${provider}-${appearance}`, {
        body: await mode.screenshot({ path: testInfo.outputPath(`default-permissions-${provider}-${appearance}.png`) }),
        contentType: 'image/png',
      })
    } finally {
      fs.rmSync(modesFixture, { force: true })
      const reset = await page.request.post('/farming/api/settings', { data: { dangerouslySkipAgentPermissionsByDefault: false } })
      expect(reset.ok()).toBe(true)
    }
  })
 }
}

for (const provider of ['codex', 'claude', 'qoder', 'qwen', 'opencode', 'pi', 'agy'] as const) {
  for (const runtime of ['acp', 'terminal'] as const) {
    test(`${provider} ${runtime} resolves current permission defaults and explicit choices`, async ({ page, workspaceRoot }) => {
      const permissionKey = provider === 'codex' ? 'codexApprovalMode' : 'claudePermissionMode'
      const restrictedMode = provider === 'codex' ? 'approve' : provider === 'claude' ? 'plan' : ''
      const bypassMode = provider === 'claude' ? 'bypassPermissions' : provider === 'pi' ? '' : 'full'
      const ownedAgentIds = new Set<string>()
      const readAgent = async (agentId: string) => {
        const response = await page.request.get('/farming/api/control/agents')
        expect(response.ok()).toBe(true)
        const body = await response.json() as { agents: Array<{ id: string; launchPermissionMode: string }> }
        return body.agents.find(agent => agent.id === agentId)
      }
      const setDefault = async (enabled: boolean) => {
        const response = await page.request.post('/farming/api/settings', { data: {
          dangerouslySkipAgentPermissionsByDefault: enabled,
          agentLaunchProfiles: {
            codex: { approvalMode: 'approve' },
            claude: { permissionMode: 'plan' },
          },
        } })
        expect(response.ok()).toBe(true)
      }
      const create = async (options: Record<string, string | boolean> = {}) => {
        const response = await page.request.post('/farming/api/control/agents', { data: {
          command: provider, workspace: workspaceRoot, agentRuntimeMode: runtime, ...options,
        } })
        const body = await response.json() as { agentId?: string, error?: string }
        if (body.agentId) ownedAgentIds.add(body.agentId)
        expect(response.ok(), body.error).toBe(true)
        expect(body.agentId).toBeTruthy()
        return body.agentId!
      }
      try {
        await setDefault(false)
        const original = await create()
        await expect.poll(async () => (await readAgent(original))?.launchPermissionMode).toBe(restrictedMode)

        await setDefault(true)
        expect((await readAgent(original))?.launchPermissionMode).toBe(restrictedMode)
        const bypass = await create()
        await expect.poll(async () => (await readAgent(bypass))?.launchPermissionMode).toBe(bypassMode)

        const explicit = await create(provider === 'codex' || provider === 'claude'
          ? { [permissionKey]: restrictedMode } : { dangerouslySkipPermissions: false })
        await expect.poll(async () => (await readAgent(explicit))?.launchPermissionMode).toBe(restrictedMode)

        await setDefault(false)
        expect((await readAgent(bypass))?.launchPermissionMode).toBe(bypassMode)
        const restored = await create()
        await expect.poll(async () => (await readAgent(restored))?.launchPermissionMode).toBe(restrictedMode)
      } finally {
        // Attempt every exact owned cleanup even when another deletion fails.
        const cleanup = await Promise.allSettled([...ownedAgentIds].map(async agentId => {
          const response = await page.request.delete(`/farming/api/control/agents/${encodeURIComponent(agentId)}?recordHistory=0`)
          expect(response.ok()).toBe(true)
          await expect.poll(async () => Boolean(await readAgent(agentId))).toBe(false)
        }))
        await setDefault(false)
        for (const result of cleanup) {
          if (result.status === 'rejected') throw result.reason
        }
      }
    })
  }
}
