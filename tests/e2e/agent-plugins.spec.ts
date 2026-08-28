import fs from 'node:fs'
import path from 'node:path'
import type { Route, WebSocketRoute } from '@playwright/test'
import {
  expect,
  interceptWorkspaceRequests,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  test,
} from './fixtures'
import { selectCodeOption } from './code-select'

const mobilePluginAuditDir = process.env.FARMING_MOBILE_PLUGIN_AUDIT_DIR

async function captureMobilePluginAudit(page: import('@playwright/test').Page, name: string) {
  if (!mobilePluginAuditDir) return
  fs.mkdirSync(mobilePluginAuditDir, { recursive: true })
  for (const [cardName, testId] of [
    ['browser', 'code-plugin-browser'],
    ['computer', 'code-plugin-computer'],
    ['language-server', 'code-plugin-language-server'],
  ] as const) {
    await page.getByTestId(testId).screenshot({
      path: path.join(mobilePluginAuditDir, `${name}-${cardName}.png`),
      animations: 'disabled',
      scale: 'css',
    })
  }
}

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
  await expect(openCode.getByRole('combobox')).toHaveValue('terminal')
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
  await expect(codexHome.getByTestId('code-plugin-agent-runtime-default-codex')).toHaveValue('terminal')
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

test('Agent Home and runtime launch defaults drive dialogs while project shortcuts stay explicit', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  const currentSettingsResponse = await page.request.get('/farming/api/settings')
  expect(currentSettingsResponse.ok()).toBeTruthy()
  const currentSettings = await currentSettingsResponse.json() as {
    settings?: {
      agentHomes?: Record<string, Array<{
        id: string
        path: string
        order?: number
        acpRuntime?: { mode?: string; executable?: string }
        newAgentDefaults?: { model?: string; reasoning?: string; fast?: string }
      }>>
    }
  }
  const codexDefault = currentSettings.settings?.agentHomes?.codex?.find(home => home.id === 'default')
  expect(codexDefault?.path).toBeTruthy()

  const codexWorkHome = path.join(workspaceRoot, 'codex-launch-default')
  fs.mkdirSync(codexWorkHome, { recursive: true })
  const seedResponse = await page.request.post('/farming/api/settings', {
    data: {
      agentHomes: {
        codex: [
          codexDefault!,
          {
            id: 'work',
            path: codexWorkHome,
            order: 100,
            acpRuntime: { mode: 'managed', executable: '' },
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          },
        ],
      },
    },
  })
  expect(seedResponse.ok()).toBeTruthy()

  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  await panel.getByTestId('code-plugin-tab-homes').click()
  const defaultHome = panel.getByTestId('code-plugin-section-agent-codex-default')
  const workHome = panel.getByTestId('code-plugin-section-agent-codex-work')
  await expect(defaultHome.getByText('Launch default', { exact: true })).toBeVisible()
  await workHome.getByTestId('code-plugin-agent-set-default-codex-work').click()
  await expect(workHome.getByText('Launch default', { exact: true })).toBeVisible()
  const runtimeDefault = workHome.getByTestId('code-plugin-agent-runtime-default-codex')
  await expect(runtimeDefault).toHaveValue('terminal')
  await runtimeDefault.selectOption('chat')
  await expect(runtimeDefault).toHaveValue('chat')

  await openNewAgentDialog(page)
  await page.getByTestId('agent-option-codex').click()
  await expect(page.getByTestId('agent-home-select')).toContainText('work')
  await expect(page.getByTestId('agent-runtime-mode').getByRole('button', { name: 'Chat', exact: true }))
    .toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const projectGroup = page.getByTestId('code-project-group').first()
  await projectGroup.hover()
  await projectGroup.getByTestId('code-project-new-agent').click({ force: true })
  const projectLaunchMenu = page.getByTestId('code-project-new-agent-menu')
  await expect(projectLaunchMenu).toBeVisible()
  await expect(page.getByTestId('code-project-agent-launch-chat-codex'))
    .toHaveAttribute('aria-label', 'Codex · Chat')
  await page.keyboard.press('Escape')

  await page.getByTestId('code-nav-plugins').click()
  await panel.getByTestId('code-plugin-tab-homes').click()
  const removableWorkHome = panel.getByTestId('code-plugin-section-agent-codex-work')
  page.once('dialog', dialog => dialog.accept())
  await removableWorkHome.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(removableWorkHome).toHaveCount(0)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    if (!response.ok()) return null
    const payload = await response.json() as {
      settings?: {
        agentLaunchProfiles?: Record<string, { homeId?: string; runtimeMode?: string }>
      }
    }
    const profile = payload.settings?.agentLaunchProfiles?.codex
    return profile ? { homeId: profile.homeId, runtimeMode: profile.runtimeMode } : null
  }).toEqual({ homeId: 'default', runtimeMode: 'chat' })
  await expect(defaultHome.getByText('Launch default', { exact: true })).toBeVisible()
  await expect(defaultHome.getByTestId('code-plugin-agent-runtime-default-codex')).toHaveValue('chat')
})

test('project shortcuts ignore an older Agent launch-default response', async ({ page, workspaceRoot }) => {
  const staleResponse = await page.request.get('/farming/api/executables')
  expect(staleResponse.ok()).toBeTruthy()
  const stalePayload = await staleResponse.json() as {
    agents?: Array<{ name?: string; launchDefaults?: { runtimeMode?: string } }>
  }
  expect(stalePayload.agents?.find(agent => agent.name === 'codex')?.launchDefaults?.runtimeMode)
    .toBe('terminal')

  const agentResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: workspaceRoot },
  })
  expect(agentResponse.ok()).toBeTruthy()

  let requestCount = 0
  let initialRequest: Route | null = null
  let resolveInitialRequest: (() => void) | null = null
  let resolveFreshRequest: (() => void) | null = null
  const initialRequestObserved = new Promise<void>(resolve => { resolveInitialRequest = resolve })
  const freshRequestCompleted = new Promise<void>(resolve => { resolveFreshRequest = resolve })
  await page.route('**/farming/api/executables', async route => {
    requestCount += 1
    if (requestCount === 1) {
      initialRequest = route
      resolveInitialRequest?.()
      return
    }
    const response = await route.fetch()
    await route.fulfill({ response })
    resolveFreshRequest?.()
  })

  await openFarming(page)
  await initialRequestObserved
  const settingsResponse = await page.request.post('/farming/api/settings', {
    data: {
      agentLaunchProfiles: {
        codex: { homeId: 'default', runtimeMode: 'chat' },
      },
    },
  })
  expect(settingsResponse.ok()).toBeTruthy()
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('farming-agent-homes-saved'))
  })
  await freshRequestCompleted
  expect(requestCount).toBe(2)
  await initialRequest!.fulfill({ json: stalePayload })

  const projectGroup = page.getByTestId('code-project-group').first()
  await expect(projectGroup).toBeVisible()
  await projectGroup.hover()
  await projectGroup.getByTestId('code-project-new-agent').click({ force: true })
  await expect(page.getByTestId('code-project-agent-launch-chat-codex'))
    .toHaveAttribute('aria-label', 'Codex · Chat')
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
  const pluginSourcePath = 'plugins/example/.codex-plugin/plugin.json'
  let failNextSourceRead = true
  let blockNextSourceRead = false
  let releaseSourceRead = () => {}
  let markSourceReadStarted = () => {}
  const sourceReadGate = new Promise<void>(resolve => { releaseSourceRead = resolve })
  const sourceReadStarted = new Promise<void>(resolve => { markSourceReadStarted = resolve })
  await interceptWorkspaceRequests(page, async request => {
    if (request.operation !== 'read-file' || request.path !== pluginSourcePath) return
    if (failNextSourceRead) {
      failNextSourceRead = false
      return {
        response: {
          ok: false,
          error: { code: 'FIXTURE_READ_FAILURE', message: 'fixture read failure', status: 500 },
        },
      }
    }
    if (!blockNextSourceRead) return
    blockNextSourceRead = false
    markSourceReadStarted()
    await sourceReadGate
  })
  await openFarming(page)
  const codexHome = path.join(workspaceRoot, 'codex-catalog')
  const pluginRoot = path.join(codexHome, 'plugins', 'example')
  fs.mkdirSync(path.join(codexHome, 'skills', 'home-skill'), { recursive: true })
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true })
  fs.mkdirSync(path.join(pluginRoot, 'skills', 'plugin-skill'), { recursive: true })
  fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(pluginRoot, 'assets'), { recursive: true })
  fs.copyFileSync(
    path.join(process.cwd(), 'frontend', 'skins', 'crt', 'assets', 'branding', 'farming-crt-logo-v1.png'),
    path.join(pluginRoot, 'assets', 'app-icon.png'),
  )
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
    interface: { logo: './assets/app-icon.png' },
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
  await expect(panel.getByTestId('code-plugin-history-forward')).toHaveCount(0)
  await panel.getByTestId('code-plugin-tab-extensions').click()
  const selectedHome = panel.getByTestId('code-plugin-extension-home-codex-catalog')
  const selectedKind = panel.getByTestId('code-plugin-extension-kind-plugin')
  await expect(selectedHome).toHaveAttribute('aria-selected', 'true')
  expect(await panel.locator('.code-plugin-extension-kind-tabs > button').evaluateAll(buttons => (
    buttons.map(button => button.getAttribute('data-testid'))
  ))).toEqual([
    'code-plugin-extension-kind-plugin',
    'code-plugin-extension-kind-skill',
    'code-plugin-extension-kind-mcp',
    'code-plugin-extension-kind-hook',
    'code-plugin-extension-kind-command',
  ])
  await expect(selectedKind).toHaveAttribute('aria-selected', 'true')
  const selectedTabStyle = await panel.locator('.code-plugin-tabs > button[aria-selected="true"]').evaluate(element => {
    const style = getComputedStyle(element)
    return { backgroundColor: style.backgroundColor, color: style.color }
  })
  for (const selectedOption of [selectedHome, selectedKind]) {
    await expect(selectedOption).toHaveCSS('background-color', selectedTabStyle.backgroundColor)
    await expect(selectedOption).toHaveCSS('color', selectedTabStyle.color)
  }

  await panel.getByTestId('code-plugin-extension-kind-skill').click()
  await expect(panel.getByText('Home Skill', { exact: true })).toBeVisible()
  await expect(panel.getByText('example-plugin: Plugin Skill', { exact: true })).toBeVisible()

  await panel.getByTestId('code-plugin-extension-kind-mcp').click()
  const disabledMcp = panel.getByRole('button', { name: /Read Only MCP/ })
  await expect(disabledMcp).toContainText('Disabled')
  await expect(panel.getByRole('button', { name: /Plugin MCP/ })).toContainText('Configured')

  await panel.getByTestId('code-plugin-extension-kind-hook').click()
  await expect(panel.getByText('example-plugin: Stop', { exact: true })).toBeVisible()
  await expect(panel.locator('.code-plugin-extension-group')).toHaveAttribute('data-kind', 'hook')
  await expect(panel.getByText('Home Skill', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('example-plugin: Plugin Skill', { exact: true })).toHaveCount(0)

  await panel.getByTestId('code-plugin-extension-kind-plugin').click()
  await expect(panel.locator('.code-plugin-extension-group')).toHaveAttribute('data-kind', 'plugin')
  const examplePlugin = panel.getByRole('button', { name: /Example Plugin/ })
  await expect(examplePlugin.locator('.code-plugin-manifest-icon')).toBeVisible()
  await expect.poll(() => examplePlugin.locator('.code-plugin-manifest-icon').evaluate(
    (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
  )).toBe(true)
  await expect(examplePlugin.locator('.code-plugin-manifest-icon')).toHaveAttribute('src', /\/api\/files\/raw\?/)
  const filterScrollTop = await page.locator('.code-plugins-view').evaluate(element => {
    element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight)
    element.dispatchEvent(new Event('scroll'))
    return element.scrollTop
  })
  expect(filterScrollTop).toBeGreaterThan(0)
  await page.evaluate(() => {
    const hookTab = document.querySelector<HTMLButtonElement>('[data-testid="code-plugin-extension-kind-hook"]')
    const scroller = document.querySelector<HTMLElement>('.code-plugins-view')
    if (!hookTab || !scroller) throw new Error('Plugin filter race fixture is unavailable')
    hookTab.click()
    scroller.dispatchEvent(new Event('scroll'))
  })
  await expect(panel.locator('.code-plugin-extension-group')).toHaveAttribute('data-kind', 'hook')
  await expect(panel.getByRole('button', { name: /Example Plugin/ })).toHaveCount(0)

  await panel.getByTestId('code-plugin-extension-kind-plugin').click()
  await expect(panel.locator('.code-plugin-extension-group')).toHaveAttribute('data-kind', 'plugin')
  await examplePlugin.click()
  const detail = panel.getByTestId('code-plugin-detail-dialog')
  await expect(detail).toContainText('plugins/example/.codex-plugin/plugin.json')
  await expect(detail.locator('.code-plugin-manifest-icon')).toBeVisible()
  await expect.poll(() => detail.locator('.code-plugin-manifest-icon').evaluate(
    (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
  )).toBe(true)
  const pluginScrollTop = await page.locator('.code-plugins-view').evaluate(element => {
    element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight)
    element.dispatchEvent(new Event('scroll'))
    return element.scrollTop
  })
  expect(pluginScrollTop).toBeGreaterThan(0)
  await detail.getByRole('button', { name: 'Open source file' }).click()
  await expect(detail).toContainText('Example Plugin')
  await expect(page.getByTestId('code-file-editor')).toHaveCount(0)

  blockNextSourceRead = true
  const openSource = detail.getByRole('button', { name: 'Open source file' }).click()
  await sourceReadStarted
  await expect(panel.getByTestId('code-plugin-detail-dialog')).toContainText('Example Plugin')
  await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
  releaseSourceRead()
  await openSource
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('plugin.json')
  await expect(page.locator('[data-file-path="plugins/example/.codex-plugin/plugin.json"].selected')).toBeVisible()

  await page.getByTestId('code-file-editor-history-back').click()
  await expect(panel.getByTestId('code-plugin-tab-extensions')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByTestId('code-plugin-extension-home-codex-catalog')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByTestId('code-plugin-extension-kind-plugin')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByTestId('code-plugin-detail-dialog')).toContainText('Example Plugin')
  await expect.poll(() => page.locator('.code-plugins-view').evaluate(element => element.scrollTop)).toBe(pluginScrollTop)

  await expect(detail.getByTestId('code-plugin-detail-history-forward')).toHaveCount(0)

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

test('Plugins keeps built-in capabilities aligned without page overflow on narrow screens', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  await expect(panel.getByTestId('code-plugin-tab-farming')).toHaveAttribute('aria-selected', 'true')

  for (const viewport of [
    { width: 720, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport)
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await panel.locator('.code-plugins-panel-header').scrollIntoViewIfNeeded()
      await page.evaluate(value => {
        document.documentElement.dataset.appearance = value
        document.body.dataset.appearance = value
      }, appearance)
      const cards = panel.locator('.code-plugin-card')
      await expect(cards).toHaveCount(4)
      await expect(cards.first()).toBeVisible()
      const layout = await panel.evaluate(element => {
        const view = element.closest('.code-plugins-view') as HTMLElement | null
        const tabs = element.querySelector<HTMLElement>('.code-plugin-tabs')
        const cardElements = Array.from(element.querySelectorAll<HTMLElement>('.code-plugin-card'))
        return {
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          viewClientWidth: view?.clientWidth ?? 0,
          viewScrollWidth: view?.scrollWidth ?? 0,
          tabsOverflow: tabs ? getComputedStyle(tabs).overflowX : '',
          tabsClientWidth: tabs?.clientWidth ?? 0,
          tabsScrollWidth: tabs?.scrollWidth ?? 0,
          cards: cardElements.map(card => {
            const rect = card.getBoundingClientRect()
            const icon = card.querySelector('.code-plugin-card-icon')?.getBoundingClientRect()
            const copy = card.querySelector('.code-plugin-card-copy')?.getBoundingClientRect()
            const toggle = card.querySelector('.code-plugin-toggle')?.getBoundingClientRect()
            return {
              left: rect.left,
              right: rect.right,
              width: rect.width,
              iconLeft: icon?.left ?? -1,
              copyLeft: copy?.left ?? -1,
              toggleLeft: toggle?.left ?? -1,
              toggleRight: toggle?.right ?? -1,
            }
          }),
        }
      })
      expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth)
      expect(layout.viewScrollWidth).toBeLessThanOrEqual(layout.viewClientWidth + 1)
      expect(layout.tabsOverflow).toBe('auto')
      if (viewport.width <= 320) expect(layout.tabsScrollWidth).toBeGreaterThan(layout.tabsClientWidth)
      expect(Math.max(...layout.cards.map(card => card.width)) - Math.min(...layout.cards.map(card => card.width)))
        .toBeLessThanOrEqual(1)
      expect(new Set(layout.cards.map(card => Math.round(card.iconLeft))).size).toBe(1)
      expect(new Set(layout.cards.map(card => Math.round(card.copyLeft))).size).toBe(1)
      for (const card of layout.cards) {
        expect(card.left).toBeGreaterThanOrEqual(0)
        expect(card.right).toBeLessThanOrEqual(layout.viewportWidth)
        expect(Math.abs(card.toggleLeft - card.copyLeft)).toBeLessThanOrEqual(1)
        expect(card.toggleRight).toBeLessThanOrEqual(card.right)
      }
      await captureMobilePluginAudit(page, `plugins-${viewport.width}px-${appearance}`)
    }
  }

  await page.setViewportSize({ width: 320, height: 720 })
  await panel.getByTestId('code-plugin-tab-extensions').click()
  const extensionSearch = panel.getByRole('searchbox', { name: 'Search extensions' })
  await extensionSearch.fill('long-extension-query-'.repeat(20))
  const extensionLayout = await panel.evaluate(element => {
    const view = element.closest('.code-plugins-view') as HTMLElement | null
    const header = element.querySelector('.code-plugin-extensions-header')?.getBoundingClientRect()
    const tools = element.querySelector('.code-plugin-extension-tools')?.getBoundingClientRect()
    const search = element.querySelector('.code-plugin-extension-search')?.getBoundingClientRect()
    return {
      viewClientWidth: view?.clientWidth ?? 0,
      viewScrollWidth: view?.scrollWidth ?? 0,
      headerRight: header?.right ?? Number.POSITIVE_INFINITY,
      toolsRight: tools?.right ?? Number.POSITIVE_INFINITY,
      searchRight: search?.right ?? Number.POSITIVE_INFINITY,
    }
  })
  expect(extensionLayout.viewScrollWidth).toBeLessThanOrEqual(extensionLayout.viewClientWidth + 1)
  expect(extensionLayout.headerRight).toBeLessThanOrEqual(320)
  expect(extensionLayout.toolsRight).toBeLessThanOrEqual(320)
  expect(extensionLayout.searchRight).toBeLessThanOrEqual(320)

  await page.setViewportSize({ width: 1024, height: 800 })
  await panel.getByTestId('code-plugin-tab-farming').click()
  const desktopCard = panel.getByTestId('code-plugin-browser')
  const desktopLayout = await desktopCard.evaluate(card => {
    const icon = card.querySelector('.code-plugin-card-icon')?.getBoundingClientRect()
    const copy = card.querySelector('.code-plugin-card-copy')?.getBoundingClientRect()
    const toggle = card.querySelector('.code-plugin-toggle')?.getBoundingClientRect()
    return {
      iconTop: icon?.top ?? -1,
      copyTop: copy?.top ?? -1,
      copyRight: copy?.right ?? Number.POSITIVE_INFINITY,
      toggleTop: toggle?.top ?? -1,
      toggleLeft: toggle?.left ?? -1,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }
  })
  expect(Math.abs(desktopLayout.iconTop - desktopLayout.copyTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(desktopLayout.toggleTop - desktopLayout.copyTop)).toBeLessThanOrEqual(1)
  expect(desktopLayout.toggleLeft).toBeGreaterThanOrEqual(desktopLayout.copyRight)
  expect(desktopLayout.pageWidth).toBeLessThanOrEqual(desktopLayout.viewportWidth)
})
