import fs from 'node:fs'
import path from 'node:path'
import type { WebSocketRoute } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'
import { selectCodeOption } from './code-select'

test('Plugins treats each Agent Home as an independent ordered Agent configuration', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  const currentSettingsResponse = await page.request.get('/farming/api/settings')
  expect(currentSettingsResponse.ok()).toBeTruthy()
  const currentSettings = await currentSettingsResponse.json() as {
    settings?: {
      agentHomes?: Record<string, Array<{
        id: string
        path: string
        order?: number
        newAgentDefaults?: { model?: string; reasoning?: string; fast?: string }
      }>>
    }
  }
  const codexDefault = currentSettings.settings?.agentHomes?.codex?.find(home => home.id === 'default')
  const claudeDefault = currentSettings.settings?.agentHomes?.claude?.find(home => home.id === 'default')
  expect(codexDefault?.path).toBeTruthy()
  expect(claudeDefault?.path).toBeTruthy()

  const claudePrimaryHome = path.join(workspaceRoot, 'claude-primary')
  const claudeWorkHome = path.join(workspaceRoot, 'claude-work')
  const codexWorkHome = path.join(workspaceRoot, 'codex-work')
  fs.mkdirSync(claudePrimaryHome, { recursive: true })
  fs.mkdirSync(claudeWorkHome, { recursive: true })
  fs.mkdirSync(codexWorkHome, { recursive: true })
  fs.writeFileSync(path.join(codexWorkHome, 'config.toml'), [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "high"',
    'service_tier = "priority"',
  ].join('\n'))
  fs.writeFileSync(path.join(claudePrimaryHome, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_MODEL: 'claude-primary-only' },
  }))
  fs.writeFileSync(path.join(claudeWorkHome, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_MODEL: 'claude-work-only' },
  }))
  const settingsResponse = await page.request.post('/farming/api/settings', {
    data: {
      agentHomes: {
        codex: [
          {
            ...codexDefault!,
            order: 2,
          },
          {
            id: 'work',
            path: codexWorkHome,
            order: 0,
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          },
        ],
        claude: [
          {
            id: 'primary',
            path: claudePrimaryHome,
            order: 1,
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          },
          {
            id: 'work',
            path: claudeWorkHome,
            order: 3,
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          },
          {
            ...claudeDefault!,
            order: 4,
          },
        ],
      },
    },
  })
  expect(settingsResponse.ok()).toBeTruthy()

  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  await expect(panel.getByTestId('code-plugin-tab-farming')).toHaveAttribute('aria-selected', 'true')
  await panel.getByTestId('code-plugin-tab-homes').click()
  await expect(panel.getByTestId('code-plugin-tab-homes')).toHaveAttribute('aria-selected', 'true')
  const agentSections = panel.locator('.code-plugin-agent-section')
  await expect.poll(() => agentSections.evaluateAll(sections => (
    sections.map(section => section.getAttribute('data-testid')).slice(0, 3)
  ))).toEqual([
    'code-plugin-section-agent-codex-work',
    'code-plugin-section-agent-claude-primary',
    'code-plugin-section-agent-codex-default',
  ])

  const openCode = panel.getByTestId('code-plugin-section-agent-opencode-default')
  await expect(openCode.getByText(/Inherited from|was not found/)).toBeVisible()
  await expect(openCode.getByRole('combobox')).toHaveCount(0)
  await expect(panel.locator('.code-plugin-extension')).toHaveCount(0)

  const claudePrimary = panel.getByTestId('code-plugin-section-agent-claude-primary')
  const claudeWork = panel.getByTestId('code-plugin-section-agent-claude-work')
  await expect(claudePrimary.locator('.code-plugin-agent-configuration')).toContainText('Model: claude-primary-only')
  await expect(claudeWork.locator('.code-plugin-agent-configuration')).toContainText('Model: claude-work-only')
  await expect(claudePrimary.getByRole('combobox')).toHaveCount(0)
  await expect(claudeWork.getByRole('combobox')).toHaveCount(0)

  const work = panel.getByTestId('code-plugin-section-agent-codex-work')
  await expect(work.getByText('work', { exact: true })).toBeVisible()
  await expect(work.getByText(codexWorkHome, { exact: true })).toBeVisible()
  await expect(work.locator('.code-plugin-agent-configuration')).toContainText('Model: gpt-5.6-sol')
  await expect(work.locator('.code-plugin-agent-configuration')).toContainText('Reasoning: high')
  await expect(work.locator('.code-plugin-agent-configuration')).toContainText('Service tier: priority')
  await expect(panel.locator('.code-plugins-panel-header h2')).toHaveCSS('font-size', '18px')
  await expect(panel.locator('.code-plugin-agent-sections-header h3')).toHaveCSS('font-size', '14px')
  await expect(work.locator('.code-plugin-agent-identity h3 > span')).toHaveCSS('font-size', '13px')
  await expect(work.locator('.code-plugin-agent-identity h3 > small')).toHaveCSS('font-size', '13px')
  await expect(work.locator('.code-plugin-agent-identity p code')).toHaveCSS('font-size', '14px')
  await expect(work.locator('.code-plugin-agent-configuration strong')).toHaveCSS('font-size', '14px')
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'dark' })
  await expect(work.locator('.code-plugin-agent-configuration strong')).toHaveCSS('color', 'rgb(216, 216, 216)')
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'light' })
  await work.getByRole('button', { name: 'Drag to reorder Agents', exact: true }).press('ArrowDown')
  await expect.poll(() => agentSections.evaluateAll(sections => (
    sections.map(section => section.getAttribute('data-testid')).slice(0, 2)
  ))).toEqual([
    'code-plugin-section-agent-claude-primary',
    'code-plugin-section-agent-codex-work',
  ])
  await work.getByRole('button', { name: 'Edit configuration', exact: true }).click()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('config.toml')
  await page.getByTestId('code-nav-plugins').click()
  await panel.getByTestId('code-plugin-tab-homes').click()

  await panel.getByRole('button', { name: 'Add Agent', exact: true }).click()
  const form = panel.getByTestId('code-plugin-agent-form')
  await selectCodeOption(form.getByLabel('Agent provider'), 'codex')
  await form.getByLabel('Home path').fill(`${workspaceRoot}/codex-work`)
  await form.getByLabel('Home name').fill('duplicate-work')
  const duplicateResponse = page.waitForResponse(response => (
    response.url().endsWith('/farming/api/settings')
    && response.request().method() === 'POST'
  ))
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await duplicateResponse).status()).toBe(409)
  await expect(panel.locator('.code-plugin-agent-form + .code-plugin-error')).toContainText('same Home path')
  const codexReviewHome = path.join(workspaceRoot, 'codex-review')
  await form.getByLabel('Home path').fill(codexReviewHome)
  await form.getByLabel('Home name').fill('review')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  const review = panel.getByTestId('code-plugin-section-agent-codex-review')
  await expect(review).toBeVisible()

  await review.getByRole('button', { name: 'Edit configuration', exact: true }).click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('config.toml')
  await page.getByTestId('code-file-monaco').click()
  await page.evaluate(() => {
    const editor = window.__farmingFileEditorTest
    if (!editor?.focus() || !editor.insertText('model = "gpt-5.6-terra"\n')) {
      throw new Error('Failed to edit a new Agent Home configuration')
    }
  })
  await page.getByRole('button', { name: 'Save file' }).click()
  const reviewConfigFile = path.join(codexReviewHome, 'config.toml')
  await expect.poll(() => fs.existsSync(reviewConfigFile) ? fs.readFileSync(reviewConfigFile, 'utf8') : '').toContain('gpt-5.6-terra')
  await page.getByTestId('code-nav-plugins').click()
  await panel.getByTestId('code-plugin-tab-homes').click()

  page.once('dialog', dialog => dialog.accept())
  await review.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(review).toHaveCount(0)
})

test('Agent Homes use the Farming-managed ACP runtime without a user-facing runtime selector', {
  tag: ['@critical-behavior', '@behavior-CODE-PLUGINS-MANAGED-RUNTIME'],
}, async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  await panel.getByTestId('code-plugin-tab-homes').click()
  const codexHome = panel.getByTestId('code-plugin-section-agent-codex-default')
  await expect(codexHome.getByRole('combobox')).toHaveCount(0)
  await expect(codexHome.getByText('Custom executable')).toHaveCount(0)
  await expect(codexHome.getByRole('button', { name: 'Apply runtime' })).toHaveCount(0)
  const settingsResponse = await page.request.get('/farming/api/settings')
  expect(settingsResponse.ok()).toBeTruthy()
  const settings = await settingsResponse.json() as {
    settings?: { agentHomes?: Record<string, Array<{ id: string; acpRuntime?: { mode?: string; executable?: string } }>> }
  }
  expect(settings.settings?.agentHomes?.codex?.find(home => home.id === 'default')?.acpRuntime).toEqual({
    mode: 'managed',
    executable: '',
  })
})

test('Plugins keeps cached Agent Home configurations visible while refreshing', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  await panel.getByTestId('code-plugin-tab-homes').click()
  const configurations = panel.locator('.code-plugin-agent-section')
  await expect(configurations.first()).toBeVisible()
  await panel.getByTestId('code-plugin-tab-farming').click()

  let refreshRequests = 0
  let releaseRefresh: (() => void) | null = null
  const refreshBlocked = new Promise<void>(resolve => {
    releaseRefresh = resolve
  })
  await page.route('**/farming/api/agent-extensions', async route => {
    refreshRequests += 1
    await refreshBlocked
    await route.continue()
  })

  try {
    await panel.getByTestId('code-plugin-tab-extensions').click()
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => refreshRequests).toBe(1)
    await panel.getByTestId('code-plugin-tab-homes').click()
    await expect(configurations.first()).toBeVisible()
    await expect(panel.getByText('Loading Agent extensions...', { exact: true })).toHaveCount(0)
  } finally {
    releaseRefresh?.()
  }
  await expect(configurations.first()).toBeVisible()
})

test('Plugins reports a disconnected inventory read and retries after reconnecting', async ({ page }) => {
  let outage = false
  let activeSocket: WebSocketRoute | null = null
  let inventoryRequests = 0
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, async socket => {
    if (outage) {
      await socket.close({ code: 1012, reason: 'Plugin inventory reconnect regression' })
      return
    }
    activeSocket = socket
    socket.connectToServer()
  })
  await page.route('**/farming/api/agent-extensions', async route => {
    inventoryRequests += 1
    if (outage) {
      await route.abort('connectionfailed')
      return
    }
    await route.continue()
  })

  await openFarming(page)
  await expect.poll(() => Boolean(activeSocket)).toBe(true)
  outage = true
  await activeSocket?.close({ code: 1012, reason: 'Plugin inventory reconnect regression' })
  await expect(page.getByTestId('connection-status')).toBeVisible()
  await page.getByTestId('code-nav-plugins').click()

  const panel = page.getByTestId('code-plugins-panel')
  const homesCount = panel.getByTestId('code-plugin-tab-homes').locator('small')
  const extensionsCount = panel.getByTestId('code-plugin-tab-extensions').locator('small')
  await expect.poll(() => inventoryRequests).toBe(1)
  await expect(homesCount).toHaveText('!')
  await expect(extensionsCount).toHaveText('!')
  await panel.getByTestId('code-plugin-tab-homes').click()
  const inventoryAlert = panel.getByRole('alert').filter({ hasText: 'retry after reconnecting' })
  await expect(inventoryAlert).toBeVisible()

  outage = false
  await expect.poll(() => inventoryRequests, { timeout: 8_000 }).toBe(2)
  await expect(homesCount).not.toHaveText('!')
  await expect(extensionsCount).not.toHaveText('!')
  await expect(inventoryAlert).toHaveCount(0)
})

test('Plugins shows a read-only extension catalog from one exact Agent Home', {
  tag: ['@critical-behavior', '@behavior-CODE-PLUGINS-SOURCE-NAVIGATION'],
}, async ({ page, workspaceRoot }) => {
  await openFarming(page)
  const codexHome = path.join(workspaceRoot, 'codex-catalog')
  const pluginRoot = path.join(codexHome, 'plugins', 'example')
  fs.mkdirSync(path.join(codexHome, 'skills', 'home-skill'), { recursive: true })
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true })
  fs.mkdirSync(path.join(pluginRoot, 'skills', 'plugin-skill'), { recursive: true })
  fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(pluginRoot, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(pluginRoot, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="6" /></svg>')
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    '[mcp_servers.read-only-mcp]',
    'command = "node"',
    'enabled = false',
  ].join('\n'))
  fs.writeFileSync(path.join(codexHome, 'skills', 'home-skill', 'SKILL.md'), [
    '---',
    'name: Home Skill',
    'description: Visible from this exact Home.',
    '---',
  ].join('\n'))
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'example-plugin',
    version: '1.0.0',
    description: 'A production-shaped Agent plugin.',
    skills: './skills',
    mcpServers: './mcp.json',
    hooks: './hooks/hooks.json',
    interface: { logo: './assets/logo.svg' },
  }))
  for (let index = 0; index < 10; index += 1) {
    const extraRoot = path.join(codexHome, 'plugins', `extra-${index}`)
    fs.mkdirSync(path.join(extraRoot, '.codex-plugin'), { recursive: true })
    fs.writeFileSync(path.join(extraRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: `extra-plugin-${index}`,
      description: `Extra plugin ${index}`,
    }))
  }
  fs.writeFileSync(path.join(pluginRoot, 'skills', 'plugin-skill', 'SKILL.md'), [
    '---',
    'name: Plugin Skill',
    'description: Visible through the plugin manifest.',
    '---',
  ].join('\n'))
  fs.writeFileSync(path.join(pluginRoot, 'mcp.json'), JSON.stringify({
    mcpServers: { pluginMcp: { title: 'Plugin MCP', command: 'node' } },
  }))
  fs.writeFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: './stop.sh' }] }] },
  }))
  await page.request.post('/farming/api/settings', {
    data: {
      agentHomes: {
        codex: [{
          id: 'catalog',
          path: codexHome,
          order: 0,
          newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
        }],
      },
    },
  })

  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  await panel.getByTestId('code-plugin-tab-extensions').click()
  await expect(panel.getByTestId('code-plugin-extension-home-codex-catalog')).toHaveAttribute('aria-selected', 'true')

  await panel.getByTestId('code-plugin-extension-kind-skill').click()
  await expect(panel.getByText('Home Skill', { exact: true })).toBeVisible()
  await expect(panel.getByText('example-plugin: Plugin Skill', { exact: true })).toBeVisible()

  await panel.getByTestId('code-plugin-extension-kind-mcp').click()
  const disabledMcp = panel.getByRole('button', { name: /Read Only MCP/ })
  await expect(disabledMcp).toContainText('Disabled')
  await expect(panel.getByRole('button', { name: /Plugin MCP/ })).toContainText('Configured')

  await panel.getByTestId('code-plugin-extension-kind-hook').click()
  await expect(panel.getByText('example-plugin: Stop', { exact: true })).toBeVisible()

  await panel.getByTestId('code-plugin-extension-kind-plugin').click()
  const examplePlugin = panel.getByRole('button', { name: /Example Plugin/ })
  await expect(examplePlugin.locator('.code-plugin-manifest-icon')).toBeVisible()
  await examplePlugin.click()
  const detail = panel.getByTestId('code-plugin-detail-dialog')
  await expect(detail).toContainText('plugins/example/.codex-plugin/plugin.json')
  await expect(detail.locator('.code-plugin-manifest-icon')).toBeVisible()
  const pluginScrollTop = await page.locator('.code-plugins-view').evaluate(element => {
    element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight)
    element.dispatchEvent(new Event('scroll'))
    return element.scrollTop
  })
  expect(pluginScrollTop).toBeGreaterThan(0)
  await detail.getByRole('button', { name: 'Open source file' }).click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('plugin.json')
  await expect(page.locator('[data-file-path="plugins/example/.codex-plugin/plugin.json"].selected')).toBeVisible()

  await page.getByTestId('code-file-editor-history-back').click()
  await expect(panel.getByTestId('code-plugin-tab-extensions')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByTestId('code-plugin-extension-home-codex-catalog')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByTestId('code-plugin-extension-kind-plugin')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByTestId('code-plugin-detail-dialog')).toContainText('Example Plugin')
  await expect.poll(() => page.locator('.code-plugins-view').evaluate(element => element.scrollTop)).toBe(pluginScrollTop)

  await panel.getByTestId('code-plugin-detail-dialog').getByRole('button', { name: 'Close details' }).click()

  fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: './start.sh' }] }] },
  }))
  await page.getByTestId('code-nav-plugins').click()
  await panel.getByTestId('code-plugin-tab-extensions').click()
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
  await panel.getByTestId('code-plugin-extension-kind-hook').click()
  await expect(panel.getByText('SessionStart', { exact: true })).toBeVisible()
})
