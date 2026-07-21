import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  test,
} from './fixtures'
import type { Agent } from '../../src/types/agent'

type FarmingState = {
  agents: Agent[]
  taskHistory: unknown[]
  mainPageSessionKeys: string[]
  mainAgentId: string | null
  systemStats: null
}

declare global {
  interface Window {
    __farmingEmitState?: (state: FarmingState) => void
  }
}

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function expectNoPageOverflow(page: import('@playwright/test').Page) {
  await expect.poll(async () => page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ innerWidth: 390, scrollWidth: 390 })
}

async function revealMobileSidebar(page: import('@playwright/test').Page) {
  const workspace = page.getByTestId('code-workspace')
  if ((await workspace.getAttribute('class'))?.includes('sidebar-collapsed')) {
    await page.getByTestId('code-mobile-menu').click()
  }
  await expect(page.getByTestId('code-sidebar')).toBeVisible()
}

async function createControlAgent(page: import('@playwright/test').Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function installStateSocket(page: import('@playwright/test').Page, initialState: FarmingState) {
  await page.addInitScript((state) => {
    const sockets = new Set<{
      readyState: number
      onopen: ((event: Event) => void) | null
      onmessage: ((event: MessageEvent) => void) | null
      onclose: ((event: CloseEvent) => void) | null
      send: (data: string) => void
      close: () => void
    }>()

    class MockWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 3

      readyState = MockWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      heartbeatTimer: number | null = null

      constructor() {
        sockets.add(this)
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN
          this.onopen?.(new Event('open'))
          this.onmessage?.({ data: JSON.stringify({ type: 'state', state }) } as MessageEvent)
          this.heartbeatTimer = window.setInterval(() => {
            this.onmessage?.({ data: JSON.stringify({ type: 'state', state }) } as MessageEvent)
          }, 2_000)
        }, 0)
      }

      send() {}

      close() {
        if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer)
        this.readyState = MockWebSocket.CLOSED
        this.onclose?.(new CloseEvent('close'))
        sockets.delete(this)
      }
    }

    window.__farmingEmitState = nextState => {
      for (const socket of sockets) {
        if (socket.readyState === MockWebSocket.OPEN) {
          socket.onmessage?.({ data: JSON.stringify({ type: 'state', state: nextState }) } as MessageEvent)
        }
      }
    }
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket
  }, initialState)
}

async function startMobileAgentFromOpenDialog(page: import('@playwright/test').Page, name: string, workspace: string) {
  const previousPaneIds = new Set(await page.getByTestId('code-terminal-pane').evaluateAll(panes => panes
    .map(pane => pane.getAttribute('data-agent-id'))
    .filter((id): id is string => Boolean(id))))
  await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
  const agentOption = page.getByTestId(`agent-option-${name}`)
  await expect(agentOption).toBeEnabled({ timeout: 30_000 })
  await agentOption.click()
  await expect(page.getByTestId('workspace-step')).toBeVisible()
  await page.getByTestId('workspace-input').fill(workspace)
  await page.getByTestId('workspace-start').click()
  await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 30_000 })
  await expect.poll(async () => {
    const ids = await page.getByTestId('code-terminal-pane').evaluateAll(panes => panes
      .map(pane => pane.getAttribute('data-agent-id'))
      .filter((id): id is string => Boolean(id)))
    return ids.find(id => !previousPaneIds.has(id)) ?? ''
  }, { timeout: 30_000 }).not.toBe('')
  const agentId = (await page.getByTestId('code-terminal-pane').evaluateAll(panes => panes
    .map(pane => pane.getAttribute('data-agent-id'))
    .filter((id): id is string => Boolean(id))))
    .find(id => !previousPaneIds.has(id))
  if (!agentId) throw new Error('New mobile terminal pane is missing after launch')
  await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 30_000 })
  return agentId
}

function runtimeMenuAgent(agentId: string, workspace: string, mode: 'terminal' | 'chat'): Agent {
  return {
    id: agentId,
    command: 'codex',
    cwd: workspace,
    projectWorkspace: workspace,
    output: '',
    previewText: 'Mobile runtime menu fixture',
    status: 'running',
    isMain: false,
    activityLevel: 'cold',
    lastActivity: Date.now(),
    attentionScore: 0,
    isZombie: false,
    providerSessionProvider: 'codex',
    providerHomeId: 'default',
    providerSessionId: 'mobile-runtime-menu-session',
    providerSessionKey: 'agent-session:codex:mobile-runtime-menu-session',
    providerSessionTemporary: false,
    providerCapabilities: {
      supportedRuntimes: ['terminal', 'acp'],
      runtimeSwitch: true,
      terminalProfile: true,
      goals: false,
      chatRuntime: 'acp',
      supportsChat: true,
      supportsSteer: true,
    },
    runtimeBinding: mode === 'terminal'
      ? { kind: 'terminal' }
      : {
          kind: 'acp',
          state: 'ready',
          error: '',
          stopReason: '',
          supportsSteer: true,
          pendingPermission: null,
          pendingPermissions: [],
          pendingElicitation: null,
          pendingElicitations: [],
          activeElicitations: [],
          sessionUpdatedAt: new Date().toISOString(),
          sessionRevision: 1,
        },
    runtimeObservation: {
      kind: 'codex',
      phase: 'idle',
      confidence: 'authoritative',
      source: 'structured-runtime',
      observerVersion: 'mobile-runtime-menu-fixture',
      observedAt: Date.now(),
    },
  }
}

test.describe('mobile Farming Code user story', () => {
  test('switches Chat and Terminal from the Agent three-dot menu', async ({ page, workspaceRoot }) => {
    const agentId = `agent-mobile-runtime-menu-${Date.now()}`
    const state = (mode: 'terminal' | 'chat'): FarmingState => ({
      agents: [runtimeMenuAgent(agentId, workspaceRoot, mode)],
      taskHistory: [],
      mainPageSessionKeys: ['agent-session:codex:mobile-runtime-menu-session'],
      mainAgentId: null,
      systemStats: null,
    })
    const requestedModes: string[] = []

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true })
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await installStateSocket(page, state('terminal'))
    await page.route(`/farming/api/agents/${agentId}`, async route => {
      const payload = route.request().postDataJSON() as { agentRuntimeMode?: string }
      requestedModes.push(payload.agentRuntimeMode || '')
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          restarted: true,
          restartedAgentId: agentId,
          agentRuntimeMode: payload.agentRuntimeMode,
        }),
      })
    })

    await openFarming(page)
    await revealMobileSidebar(page)
    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await agentRow.getByTestId('code-agent-row-more').click()
    const menu = page.getByTestId('code-agent-context-menu')
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: /Switch to Chat|切换到对话/ }).click()
    await expect(menu).toBeHidden()
    await expect.poll(() => requestedModes).toEqual(['chat'])

    await page.evaluate(nextState => window.__farmingEmitState?.(nextState), state('chat'))
    await revealMobileSidebar(page)
    await agentRow.getByTestId('code-agent-row-more').click()
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: /Switch to Terminal|切换到终端/ }).click()
    await expect(menu).toBeHidden()
    await expect.poll(() => requestedModes).toEqual(['chat', 'terminal'])
  })

  test('keeps mobile actions compact and moves settings out of the three-dot menu', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true })
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await openFarming(page)
    await expect(page.getByTestId('code-mobile-topbar')).toBeVisible()
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('Farming Code')
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('Local server')
    await expectNoPageOverflow(page)

    await page.getByTestId('code-mobile-more').click()
    const mobileOptions = page.getByTestId('code-options-menu')
    await expect(mobileOptions).toBeVisible()
    await expect(mobileOptions.getByRole('menuitem', { name: 'Chat' })).toHaveCount(0)
    await expect(mobileOptions.getByRole('menuitem', { name: 'Terminal' })).toHaveCount(0)
    await expect(mobileOptions.getByRole('menuitem', { name: 'Share page' })).toBeVisible()
    await expect(mobileOptions).not.toContainText('Settings')
    await expect(page.getByTestId('code-mobile-more')).toHaveAttribute('aria-label', 'Open options')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-empty-workspace')).toContainText('Start or select an agent')
    const inactiveComposerInput = page.getByTestId('code-composer-input')
    await expect(inactiveComposerInput).toHaveAttribute('placeholder', 'Open an agent terminal first')
    await expect(inactiveComposerInput).toBeDisabled()

    await page.getByTestId('code-empty-workspace').getByRole('button', { name: 'New Agent' }).click()
    await expect(page.getByTestId('input-dialog')).toContainText('Start New Agent')
    await expect(page.getByTestId('input-dialog-close')).toHaveAttribute('aria-label', 'Close')
    await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.input-dialog .group-label').first()).toContainText(/coding agents|other/i)
    await page.getByTestId('input-dialog-close').click()
    await expect(page.getByTestId('input-dialog')).toBeHidden()

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByTestId('code-sidebar-options')).toBeVisible()
    await page.getByTestId('code-sidebar-options').click()
    const settingsPanel = page.getByTestId('code-settings-panel')
    await expect(settingsPanel).toBeVisible()
    await settingsPanel.getByRole('button', { name: '中文' }).click()
    await expect(settingsPanel.getByRole('button', { name: '中文' })).toHaveClass(/active/)
    await settingsPanel.getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => page.locator('body').getAttribute('data-appearance')).toBe('light')

    const settingsResponse = await page.request.get('/farming/api/settings')
    const settingsData = await settingsResponse.json()
    expect(settingsData.settings?.appearance).toBe('light')
    expect(settingsData.settings?.language).toBe('zh')

  })

  test('keeps running transcript status docked near the mobile composer', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'mobile-transcript-status')
    fs.mkdirSync(path.join(projectDir, 'src/components/code'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'backend/tests'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'src/components/code/useMobileComposerHeight.ts'), 'export const mobile = true\n')
    fs.writeFileSync(path.join(projectDir, 'backend/tests/test-mobile.js'), 'console.log("mobile")\n')
    const sessionId = `019f-mobile-status-${Date.now()}`
    const agentId = `agent-mobile-status-${Date.now()}`
    const providerSessionKey = `agent-session:codex:${sessionId}`

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true })
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await installStateSocket(page, {
      agents: [{
        id: agentId,
        command: 'codex',
        cwd: projectDir,
        projectWorkspace: projectDir,
        output: '',
        previewText: 'Codex mobile transcript fixture',
        status: 'running',
        isMain: false,
        activityLevel: 'warm',
        lastActivity: Date.now(),
        attentionScore: 0,
        isZombie: false,
        providerSessionProvider: 'codex',
        providerHomeId: 'default',
        providerHomePath: '',
        providerSessionId: sessionId,
        providerSessionKey,
        providerSessionSource: 'json-cli',
        providerCapabilities: {
          supportedRuntimes: ['terminal', 'json'],
          runtimeSwitch: true,
          terminalProfile: true,
          goals: false,
        },
        runtimeBinding: {
          kind: 'json',
          state: 'working',
          error: '',
          transcriptUpdatedAt: new Date().toISOString(),
        },
        runtimeObservation: {
          kind: 'codex',
          phase: 'working',
          confidence: 'authoritative',
          source: 'structured-runtime',
          observerVersion: 'mobile-status-fixture',
          observedAt: Date.now(),
        },
        terminalBusy: true,
      }],
      taskHistory: [],
      mainPageSessionKeys: [providerSessionKey],
      mainAgentId: null,
      systemStats: null,
    })
    await page.route(/\/farming\/api\/agents\/[^/]+\/json-cli-transcript(?:\?.*)?$/, async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            available: true,
            sessionId,
            updatedAt: new Date('2026-07-10T00:00:00.000Z').toISOString(),
            source: 'mobile-status-fixture',
            turns: [
              {
                id: 'completed-turn',
                userMessage: 'Keep long mobile transcript content readable without horizontal scrolling.',
                finalMessage: [
                  'Mobile chat should wrap long commands and paths:',
                  '',
                  '```bash',
                  'node backend/tests/test-mobile.js --workspace /very/long/workspace/path/that/should/wrap/instead/of/creating/a-horizontal-scrollbar --mode mobile-chat',
                  '```',
                  '',
                  'Inline paths such as `src/components/code/useMobileComposerHeight.ts` should wrap too.',
                ].join('\n'),
                startedAt: Date.now() - 120_000,
                completedAt: Date.now() - 90_000,
                durationMs: 30_000,
                status: 'completed',
                processItems: [
                  { id: 'completed-patch', type: 'patch', title: 'Edited 2 files', detail: 'update src/components/code/useMobileComposerHeight.ts +34 -4\nupdate src/styles/main.css +21 -9', status: 'completed' },
                ],
              },
              {
                id: 'running-turn',
                userMessage: 'Continue and keep the file changes close to the composer.',
                finalMessage: '',
                startedAt: Date.now() - 45_000,
                status: 'inProgress',
                processItems: [
                  { id: 'running-command', type: 'command', title: 'Ran mobile layout audit', detail: 'measuring visual viewport and composer gap', status: 'completed' },
                  { id: 'running-patch', type: 'patch', title: 'Edited 3 files', detail: 'update src/components/code/CodeComposer.tsx +18 -6\nupdate src/components/code/useMobileComposerHeight.ts +11 -2\nupdate src/styles/main.css +29 -14', status: 'running' },
                ],
              },
            ],
          },
        }),
      })
    })
    await page.route(`/farming/api/agents/${agentId}`, async route => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) })
    })

    await openFarming(page)
    await expect(page.getByTestId('code-mobile-topbar')).toBeVisible()
    await revealMobileSidebar(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(page.getByTestId('code-codex-transcript')).toBeVisible()
    await page.getByTestId('code-codex-transcript-scroll').evaluate(element => {
      element.scrollTop = element.scrollHeight
    })
    const composerInput = page.getByTestId('code-composer-input')
    await composerInput.click()
    await composerInput.fill('follow up\nkeep compact')
    await expect(composerInput).toBeFocused()

    const metrics = await page.evaluate(() => {
      const composer = document.querySelector('[data-testid="code-composer"]') as HTMLElement | null
      const input = document.querySelector('[data-testid="code-composer-input"]') as HTMLElement | null
      const rows = Array.from(document.querySelectorAll('.code-codex-transcript-status-row')) as HTMLElement[]
      const statusRow = rows.at(-1) ?? null
      const runningPlaceholder = document.querySelector('.code-codex-transcript-turn.running:last-child .code-codex-transcript-placeholder') as HTMLElement | null
      return {
        innerWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        composerHeight: Math.round(composer?.getBoundingClientRect().height ?? 0),
        inputHeight: Math.round(input?.getBoundingClientRect().height ?? 0),
        inputAutocomplete: input?.getAttribute('autocomplete'),
        inputMode: input?.getAttribute('inputmode'),
        inputName: input?.getAttribute('name'),
        inputRole: input?.getAttribute('role'),
        placeholderDisplay: runningPlaceholder ? getComputedStyle(runningPlaceholder).display : '',
        statusGapToComposer: statusRow && composer
          ? Math.round(composer.getBoundingClientRect().top - statusRow.getBoundingClientRect().bottom)
          : -1,
      }
    })
    expect(metrics.documentScrollWidth).toBe(metrics.innerWidth)
    expect(metrics.bodyScrollWidth).toBe(metrics.innerWidth)
    expect(metrics.composerHeight).toBeLessThanOrEqual(118)
    expect(metrics.inputHeight).toBeGreaterThanOrEqual(34)
    expect(metrics.inputHeight).toBeLessThanOrEqual(52)
    expect(metrics.inputAutocomplete).toBe('off')
    expect(metrics.inputMode).toBe('text')
    expect(metrics.inputName).toBe('farming-chat-message')
    expect(metrics.inputRole).toBeNull()
    expect(metrics.placeholderDisplay).toBe('none')
    expect(metrics.statusGapToComposer).toBeGreaterThanOrEqual(0)
    expect(metrics.statusGapToComposer).toBeLessThanOrEqual(24)
  })

  test('returns to a remote shell, opens files, and uses touch-accessible blame', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'mobile-project')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), [
      '# Mobile project',
      'mobile-target-line',
      'blame-target-line',
      '',
    ].join('\n'))
    git(projectDir, ['init'])
    git(projectDir, ['config', 'user.email', 'mobile-story@example.com'])
    git(projectDir, ['config', 'user.name', 'Mobile Story'])
    git(projectDir, ['add', 'README.md'])
    git(projectDir, ['commit', '-m', 'Seed mobile README'])

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true })
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await openFarming(page)
    await expect(page.getByTestId('code-mobile-topbar')).toBeVisible()
    await expectNoPageOverflow(page)

    await revealMobileSidebar(page)
    await openNewAgentDialog(page)
    const agentId = await startMobileAgentFromOpenDialog(page, 'bash', projectDir)
    await expect(page.getByTestId('code-mobile-topbar')).toContainText(path.basename(projectDir))
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
    await expectNoPageOverflow(page)

    // Chromium exposes SpeechRecognition even in a touch-sized viewport;
    // iOS Safari usually does not. The mobile composer should follow the
    // capability rather than hard-code one browser's result.
    const mobileMic = page.getByTestId('code-composer-mic')
    if (await mobileMic.count()) {
      await expect(mobileMic).toBeVisible()
    }
    await expect(page.getByTestId('code-composer-send')).toBeVisible()
    const composerInput = page.getByTestId('code-composer-input')
    expect(await composerInput.evaluate(element => element.tagName)).toBe('TEXTAREA')
    await expect(composerInput).toHaveAttribute('autocorrect', 'off')
    await expect(composerInput).toHaveAttribute('autocapitalize', 'none')
    await expect(composerInput).toHaveAttribute('spellcheck', 'false')
    await expect(composerInput).toHaveAttribute('data-lpignore', 'true')
    await expect(composerInput).toHaveAttribute('data-1p-ignore', 'true')
    await expect(composerInput).toHaveAttribute('data-bwignore', 'true')
    await expect(composerInput).toHaveAttribute('data-form-type', 'other')
    expect(await composerInput.evaluate(element => element.getAttribute('role'))).toBeNull()
    await expect(composerInput).toHaveAttribute('autocomplete', 'off')
    expect(await composerInput.evaluate(element => element.getAttribute('aria-autocomplete'))).toBeNull()
    await expect(composerInput).toHaveAttribute('inputmode', 'text')
    await expect(composerInput).toHaveAttribute('name', 'farming-chat-message')
    await composerInput.focus()
    await expect(composerInput).toBeFocused()
    await expect(page.locator('input[type="password"], input[autocomplete="new-password"]')).toHaveCount(0)
    const terminalInput = page.locator('.xterm-helper-textarea').first()
    if (await terminalInput.count()) {
      await expect(terminalInput).toHaveAttribute('autocomplete', 'off')
      await expect(terminalInput).toHaveAttribute('autocorrect', 'off')
      await expect(terminalInput).toHaveAttribute('autocapitalize', 'none')
      await expect(terminalInput).toHaveAttribute('data-form-type', 'other')
    }
    const compactComposerMetrics = await page.getByTestId('code-composer').evaluate(element => {
      const rect = element.getBoundingClientRect()
      const input = element.querySelector('[data-testid="code-composer-input"]') as HTMLElement | null
      const inputRect = input?.getBoundingClientRect()
      return { height: rect.height, inputHeight: inputRect?.height ?? 0 }
    })
    expect(compactComposerMetrics.height).toBeLessThanOrEqual(100)
    expect(compactComposerMetrics.inputHeight).toBeGreaterThanOrEqual(22)
    expect(compactComposerMetrics.inputHeight).toBeLessThanOrEqual(52)
    await composerInput.fill(['line one', 'line two', 'line three', 'line four'].join('\n'))
    await expect.poll(async () => page.getByTestId('code-composer').evaluate(element => {
      const input = element.querySelector('[data-testid="code-composer-input"]') as HTMLElement | null
      const inputRect = input?.getBoundingClientRect()
      return inputRect?.height ?? 0
    })).toBeGreaterThanOrEqual(56)
    const expandedComposerHeight = await page.getByTestId('code-composer').evaluate(element => element.getBoundingClientRect().height)
    expect(expandedComposerHeight).toBeLessThanOrEqual(122)
    await composerInput.fill('')

    const marker = `mobile-story-${Date.now()}`
    await composerInput.click()
    await page.keyboard.insertText(`echo ${marker}`)
    await expect(composerInput).toHaveValue(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(composerInput).toHaveValue('')
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      const data = await response.json()
      return [
        data.session?.output,
        data.session?.renderOutput,
        data.session?.previewText,
      ].filter(Boolean).join('\n')
    }).toContain(marker)

    await revealMobileSidebar(page)
    const filesSection = page.getByTestId('code-files-section').first()
    const filesToggle = filesSection.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') {
      await filesToggle.click()
    }
    const fileSearch = filesSection.getByPlaceholder('Search or path:line')
    await expect(fileSearch).toHaveAttribute('type', 'search')
    await expect(fileSearch).toHaveAttribute('autocomplete', 'off')
    await expect(fileSearch).toHaveAttribute('autocorrect', 'off')
    await expect(fileSearch).toHaveAttribute('autocapitalize', 'none')
    await expect(fileSearch).toHaveAttribute('spellcheck', 'false')
    await expect(fileSearch).toHaveAttribute('data-form-type', 'other')
    await fileSearch.fill('README.md:2')
    await expect(page.getByTestId('code-file-search-results')).toBeVisible()
    await page.getByTestId('code-file-search-results').getByRole('option').first().click()

    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('README.md')
    await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 2, Col 1')
    await expectNoPageOverflow(page)

    const sourcePreviewToggle = page.getByRole('button', { name: 'Show Markdown source' })
    if (await sourcePreviewToggle.isVisible()) {
      await sourcePreviewToggle.click()
    }
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 42, y: 38 } })
    await page.getByTestId('code-editor-context-menu').getByRole('menuitem', { name: 'Annotate with Blame' }).click()
    const inlineBlame = page.locator('.code-file-inline-blame')
    await expect(inlineBlame).toHaveCount(3)
    await expect.poll(async () => inlineBlame.first().evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(110)
    await inlineBlame.first().click()
    await expect(page.getByTestId('code-file-blame-detail')).toContainText('Seed mobile README')
    await expectNoPageOverflow(page)

    await page.getByTestId('code-mobile-back').click()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
    await revealMobileSidebar(page)
    await page.getByTestId('code-nav-search').click()
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('Search')
    await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
    await expectNoPageOverflow(page)

    await revealMobileSidebar(page)
    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-mobile-topbar')).toContainText('History')
    await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
    await expectNoPageOverflow(page)
  })
})
