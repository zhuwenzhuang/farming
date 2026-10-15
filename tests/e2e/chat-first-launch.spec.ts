import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`Chat-first creation uses saved defaults and keeps overrides local in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const settings = await page.request.post('/farming/api/settings', { data: {
      appearance,
      agentLaunchProfiles: { codex: { runtimeMode: 'chat' }, claude: { runtimeMode: 'terminal' } },
    } })
    expect(settings.ok()).toBe(true)
    // An old browser preference must not win over the authoritative default.
    await page.addInitScript(() => localStorage.setItem('farming.code.newAgentRuntime.v1:/farming/', 'terminal'))
    await openFarming(page)
    await openNewAgentDialog(page)
    const dialog = page.getByTestId('input-dialog')
    await dialog.getByTestId('agent-option-codex').click()
    const modes = dialog.getByTestId('agent-runtime-mode')
    await expect(modes.getByRole('button')).toHaveText(['Chat', 'Terminal'])
    await expect(modes.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await testInfo.attach(`chat-first-create-${appearance}`, {
      body: await dialog.screenshot({ mask: [dialog.getByTestId('workspace-input')] }), contentType: 'image/png',
    })
    await modes.getByRole('button', { name: 'Terminal', exact: true }).click()
    await dialog.getByTestId('input-dialog-close').click()
    await expect(dialog).toBeHidden()
    await openNewAgentDialog(page)
    await dialog.getByTestId('agent-option-codex').click()
    await expect(modes.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByTestId('input-dialog-close').click()
    await expect(dialog).toBeHidden()
    await page.reload()
    await openNewAgentDialog(page)
    await dialog.getByTestId('agent-option-claude').click()
    await expect(modes.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByTestId('workspace-back').click()
    await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

    const project = page.getByTestId('code-project-group').first()
    await project.hover()
    await project.getByTestId('code-project-new-agent').click({ force: true })
    const menu = page.getByTestId('code-project-new-agent-menu')
    await expect(menu.getByTestId('code-project-agent-launch-codex')).toHaveAttribute('aria-label', 'Codex · Chat')
    await expect(menu.getByTestId('code-project-agent-launch-terminal-codex')).toHaveAttribute('aria-label', 'Codex · Terminal')
    // The project menu is a Chat entry point: a saved Terminal default affects
    // the New Agent dialog only, never the direction of this row.
    await expect(menu.getByTestId('code-project-agent-launch-claude')).toHaveAttribute('aria-label', 'Claude Code · Chat')
    await expect(menu.getByTestId('code-project-agent-launch-terminal-claude')).toHaveAttribute('aria-label', 'Claude Code · Terminal')
    await expect(menu.getByTestId('code-project-agent-launch-terminal-claude')).toHaveAttribute('title', 'Terminal')
    await expect(menu.locator('[data-testid^="code-project-agent-launch-chat-"]')).toHaveCount(0)
    await expect(menu.locator('.code-project-agent-launch svg:not(.agent-launch-icon)')).toHaveCount(0)
    await testInfo.attach(`chat-first-project-menu-${appearance}`, { body: await menu.screenshot(), contentType: 'image/png' })
    await menu.getByTestId('code-project-agent-launch-terminal-codex').click()
    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/control/agents')
      const { agents } = await response.json()
      return agents.some((agent: { command: string; runtimeBinding: { kind: string } }) => agent.command === 'codex' && agent.runtimeBinding.kind === 'terminal')
    }).toBe(true)

    await expect(page.getByTestId('code-terminal-mode-toggle').getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('code-nav-plugins').click()
    const panel = page.getByTestId('code-plugins-panel')
    await panel.getByTestId('code-plugin-tab-homes').click()
    const runtime = panel.getByTestId('code-plugin-agent-runtime-default-codex')
    await expect(runtime).toHaveValue('chat')
    await expect(runtime.locator('option')).toHaveText(['Chat', 'Terminal'])
    await testInfo.attach(`chat-first-plugin-${appearance}`, { body: await runtime.screenshot(), contentType: 'image/png' })
    const savedDefault = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'POST')
    await runtime.selectOption('terminal')
    expect((await savedDefault).ok()).toBe(true)
    await expect(runtime).toBeEnabled()
    await expect(runtime).toHaveValue('terminal')
    let releaseCatalog!: () => void
    const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve })
    await page.route('**/api/executables', async route => {
      await catalogGate
      await route.continue()
    })
    try {
      await openNewAgentDialog(page)
      await expect(dialog.getByTestId('agent-option-codex')).toBeDisabled()
    } finally {
      releaseCatalog()
    }
    await dialog.getByTestId('agent-option-codex').click()
    await expect(modes.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })
}

test('unspecified API mode uses Provider default and explicit Terminal remains available', async ({ page, workspaceRoot }) => {
  const settings = await page.request.post('/farming/api/settings', { data: { agentLaunchProfiles: { codex: { runtimeMode: 'chat' } } } })
  expect(settings.ok()).toBe(true)
  for (const [mode, kind] of [[undefined, 'acp'], ['terminal', 'terminal']] as const) {
    const response = await page.request.post('/farming/api/control/agents', { data: {
      command: 'codex', workspace: workspaceRoot, ...(mode ? { agentRuntimeMode: mode } : {}),
    } })
    expect(response.ok(), await response.text()).toBe(true)
    const { agentId } = await response.json()
    const inventory = await page.request.get('/farming/api/control/agents')
    const { agents } = await inventory.json()
    expect(agents.find((agent: { id: string }) => agent.id === agentId).runtimeBinding.kind).toBe(kind)
  }
})

test('failed inventory refresh cannot launch a cached Agent default', async ({ page }) => {
  await openFarming(page)
  await openNewAgentDialog(page)
  const dialog = page.getByTestId('input-dialog')
  await expect(dialog.getByTestId('agent-option-codex')).toBeEnabled()
  await dialog.getByTestId('input-dialog-close').click()
  await page.route('**/api/executables', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }))
  await openNewAgentDialog(page)
  await expect(dialog.getByTestId('agent-list-status')).toContainText('unavailable')
  await expect(dialog.getByTestId('agent-option-codex')).toBeDisabled()
})
