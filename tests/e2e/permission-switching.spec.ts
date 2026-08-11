import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import type { Agent } from '../../src/types/agent'

type SwitchState = {
  agents: Agent[]
  taskHistory: unknown[]
  mainPageSessionKeys: string[]
  mainAgentId: string | null
  systemStats: null
}

declare global {
  interface Window {
    __farmingEmitSwitchState?: (state: SwitchState) => void
  }
}

async function installSwitchStateSocket(page: Page, initialState: SwitchState) {
  await page.addInitScript(state => {
    const sockets = new Set<{
      readyState: number
      onopen: ((event: Event) => void) | null
      onmessage: ((event: MessageEvent) => void) | null
      onclose: ((event: CloseEvent) => void) | null
    }>()
    let sequence = 0

    const emit = (socket: (typeof sockets extends Set<infer T> ? T : never), nextState: SwitchState) => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'state',
          generation: 'runtime-switch-test',
          sequence: sequence += 1,
          state: nextState,
        }),
      } as MessageEvent)
    }

    class MockWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = MockWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor() {
        sockets.add(this)
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN
          this.onopen?.(new Event('open'))
          emit(this, state)
        }, 0)
      }

      send() {}

      close() {
        this.readyState = MockWebSocket.CLOSED
        this.onclose?.(new CloseEvent('close'))
        sockets.delete(this)
      }
    }

    window.__farmingEmitSwitchState = nextState => {
      for (const socket of sockets) {
        if (socket.readyState === MockWebSocket.OPEN) emit(socket, nextState)
      }
    }
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket
  }, initialState)
}

function runtimeSwitchAgent(options: {
  id: string
  workspace: string
  sessionId: string
  runtime: 'terminal' | 'chat'
  startedAt: number
  restartedFromAgentId?: string
  title?: string
}): Agent {
  return {
    id: options.id,
    command: 'codex',
    cwd: options.workspace,
    projectWorkspace: options.workspace,
    output: '',
    previewText: options.title || 'Historical Terminal session',
    task: options.title || 'Historical Terminal session',
    source: 'codex-history:test',
    status: 'running',
    isMain: false,
    activityLevel: 'cold',
    lastActivity: options.startedAt,
    attentionScore: 0,
    isZombie: false,
    startedAt: options.startedAt,
    providerSessionProvider: 'codex',
    providerHomeId: 'default',
    providerHomePath: '/tmp/codex-home',
    providerSessionId: options.sessionId,
    providerSessionKey: `agent-session:codex:${options.sessionId}`,
    providerSessionTemporary: false,
    providerCapabilities: {
      supportedRuntimes: ['terminal', 'acp'],
      runtimeSwitch: true,
      terminalProfile: true,
      goals: false,
      goalSubmission: null,
      terminalSessionFork: false,
      sessionFork: false,
      chatRuntime: 'acp',
      supportsChat: true,
      supportsSteer: true,
    },
    runtimeBinding: options.runtime === 'terminal'
      ? { kind: 'terminal' }
      : {
          kind: 'acp',
          state: 'idle',
          error: '',
          stopReason: '',
          supportsSteer: true,
          supportsFork: true,
          pendingPermission: null,
          pendingPermissions: [],
          pendingElicitation: null,
          pendingElicitations: [],
          activeElicitations: [],
          sessionUpdatedAt: new Date(options.startedAt).toISOString(),
          sessionRevision: 1,
        },
    runtimeObservation: {
      kind: 'codex',
      phase: 'idle',
      confidence: 'authoritative',
      source: 'structured-runtime',
      observerVersion: 'runtime-switch-test',
      observedAt: options.startedAt,
    },
    ...(options.restartedFromAgentId
      ? {
          restartedFromAgentId: options.restartedFromAgentId,
          restartedFromAgentIds: [options.restartedFromAgentId],
        }
      : {}),
  }
}

async function createControlAgent(page: Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function controlAgents(page: Page) {
  const response = await page.request.get('/farming/api/control/agents')
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as {
    agents?: Array<{
      id: string
      cwd?: string
      providerSessionTemporary?: boolean
      providerSessionId?: string
    }>
  }
  return data.agents ?? []
}

function agentRow(page: Page, agentId: string) {
  return page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
}

async function openPermissionTestApp(page: Page) {
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

test.describe('permission switching', () => {
  test('waits for the HTTP-owned Terminal to Chat replacement before selecting WS descendants', {
    tag: ['@critical-behavior', '@behavior-CODE-RUNTIME-SWITCHING'],
  }, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'historical-terminal-chat-identity')
    const sessionId = '019f0000-0000-7000-8000-00000000cafe'
    const originalId = 'agent-runtime-switch-original'
    const staleDescendantId = 'agent-runtime-switch-stale-descendant'
    const finalId = 'agent-runtime-switch-confirmed-chat'
    const unrelatedId = 'agent-runtime-switch-unrelated-chat'
    const baseTime = Date.now() - 60_000
    const original = runtimeSwitchAgent({
      id: originalId,
      workspace,
      sessionId,
      runtime: 'terminal',
      startedAt: baseTime,
      title: 'Historical Terminal conversation',
    })
    original.providerHomeId = ''
    const staleDescendant = runtimeSwitchAgent({
      id: staleDescendantId,
      workspace,
      sessionId,
      runtime: 'chat',
      startedAt: baseTime + 1_000,
      restartedFromAgentId: originalId,
      title: 'WRONG OLD DESCENDANT HISTORY',
    })
    const confirmed = runtimeSwitchAgent({
      id: finalId,
      workspace,
      sessionId,
      runtime: 'chat',
      startedAt: baseTime + 55_000,
      restartedFromAgentId: originalId,
      title: 'Historical Terminal conversation',
    })
    const unrelated = runtimeSwitchAgent({
      id: unrelatedId,
      workspace,
      sessionId: '019f0000-0000-7000-8000-00000000dead',
      runtime: 'chat',
      startedAt: baseTime + 40_000,
      title: 'WRONG UNRELATED HISTORY',
    })
    const state = (agents: Agent[]): SwitchState => ({
      agents,
      taskHistory: [],
      mainPageSessionKeys: [`agent-session:codex:${sessionId}`],
      mainAgentId: null,
      systemStats: null,
    })

    await installSwitchStateSocket(page, state([original, unrelated]))

    let releasePatch = () => {}
    let markPatchRequested = () => {}
    let markPatchReturned = () => {}
    const patchGate = new Promise<void>(resolve => { releasePatch = resolve })
    const patchRequested = new Promise<void>(resolve => { markPatchRequested = resolve })
    const patchReturned = new Promise<void>(resolve => { markPatchReturned = resolve })
    await page.route(`/farming/api/agents/${originalId}`, async route => {
      const body = route.request().postDataJSON() as { agentRuntimeMode?: string }
      expect(route.request().method()).toBe('PATCH')
      expect(body.agentRuntimeMode).toBe('chat')
      markPatchRequested()
      await patchGate
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          agentId: originalId,
          restarted: true,
          restartedAgentId: finalId,
          agentRuntimeMode: 'chat',
        }),
      })
      markPatchReturned()
    })

    const transcriptRequests: string[] = []
    await page.route(/\/farming\/api\/agents\/([^/]+)\/acp-transcript(?:\?.*)?$/, async route => {
      const match = new URL(route.request().url()).pathname.match(/\/api\/agents\/([^/]+)\/acp-transcript$/)
      const agentId = match?.[1] ?? ''
      transcriptRequests.push(agentId)
      const marker = agentId === finalId
        ? 'CORRECT ORIGINAL CONVERSATION HISTORY'
        : agentId === staleDescendantId
          ? 'WRONG OLD DESCENDANT HISTORY'
          : 'WRONG UNRELATED HISTORY'
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          agentId,
          sessionId: agentId === unrelatedId ? unrelated.providerSessionId : sessionId,
          runtimeEpoch: `${agentId}-epoch`,
          fromRevision: null,
          toRevision: 1,
          replace: true,
          settled: true,
          hasMoreBefore: false,
          transcript: {
            sessionId: agentId === unrelatedId ? unrelated.providerSessionId : sessionId,
            state: 'idle',
            revision: 1,
            entries: [{
              id: `${agentId}-answer`,
              type: 'message',
              role: 'assistant',
              _meta: { codex: { phase: 'final_answer' } },
              content: [{ type: 'text', text: marker }],
            }],
          },
        }),
      })
    })
    await page.route(/\/farming\/api\/agents\/([^/]+)\/acp-session(?:\?includeEntries=0)?$/, async route => {
      const match = new URL(route.request().url()).pathname.match(/\/api\/agents\/([^/]+)\/acp-session$/)
      const agentId = match?.[1] ?? ''
      await route.fulfill({ json: {
        session: {
          provider: 'codex',
          sessionId: agentId === unrelatedId ? unrelated.providerSessionId : sessionId,
          state: 'idle',
          error: '',
          stopReason: '',
          availableCommands: [],
          currentModeId: '',
          modes: null,
          configOptions: [],
          usage: null,
        },
      } })
    })

    await openPermissionTestApp(page)
    await agentRow(page, originalId).click()
    await expect(agentRow(page, originalId)).toHaveClass(/active/)
    await page.getByTestId('code-terminal-mode-toggle').getByRole('button', { name: 'Chat' }).click()
    await patchRequested
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()

    await page.evaluate(nextState => window.__farmingEmitSwitchState?.(nextState), state([
      staleDescendant,
      confirmed,
      unrelated,
    ]))
    await expect(agentRow(page, originalId)).toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await expect(page.getByTestId('code-agent-chat-view')).toHaveCount(0)
    expect(transcriptRequests).toEqual([])
    await expect(page.getByText('This session’s Chat history could not be loaded.')).toHaveCount(0)

    releasePatch()
    await patchReturned
    await expect(agentRow(page, finalId)).toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByText('CORRECT ORIGINAL CONVERSATION HISTORY', { exact: true })).toBeVisible()
    expect(transcriptRequests).toEqual([finalId])
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${staleDescendantId}"].active`)).toHaveCount(0)
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${unrelatedId}"].active`)).toHaveCount(0)
    const activeChat = page.getByTestId('code-agent-chat-view')
    await expect(activeChat).not.toContainText('WRONG OLD DESCENDANT HISTORY')
    await expect(activeChat).not.toContainText('WRONG UNRELATED HISTORY')
  })

  test('restores the HTTP-confirmed Terminal identity after a failed Chat switch', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'failed-terminal-chat-restore')
    const sessionId = '019f0000-0000-7000-8000-00000000fade'
    const originalId = 'agent-runtime-restore-original'
    const restoredId = 'agent-runtime-restore-confirmed'
    const baseTime = Date.now() - 10_000
    const original = runtimeSwitchAgent({
      id: originalId,
      workspace,
      sessionId,
      runtime: 'terminal',
      startedAt: baseTime,
      title: 'Restorable Terminal conversation',
    })
    const restored = runtimeSwitchAgent({
      id: restoredId,
      workspace,
      sessionId,
      runtime: 'terminal',
      startedAt: baseTime + 5_000,
      restartedFromAgentId: originalId,
      title: 'Restorable Terminal conversation',
    })
    const mismatchedRestore: Agent = {
      ...restored,
      providerSessionId: '019f0000-0000-7000-8000-00000000beef',
      providerHomePath: '/tmp/other-codex-home',
    }
    const state = (agents: Agent[]): SwitchState => ({
      agents,
      taskHistory: [],
      mainPageSessionKeys: [`agent-session:codex:${sessionId}`],
      mainAgentId: null,
      systemStats: null,
    })
    await installSwitchStateSocket(page, state([original]))

    let markPatchReturned = () => {}
    const patchReturned = new Promise<void>(resolve => { markPatchReturned = resolve })
    const warning = 'ACP target failed. Original runtime restored.'
    await page.route(`/farming/api/agents/${originalId}`, async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          agentId: originalId,
          restarted: true,
          restartedAgentId: restoredId,
          agentRuntimeMode: 'terminal',
          switchFailed: true,
          warning,
        }),
      })
      markPatchReturned()
    })

    await openPermissionTestApp(page)
    await agentRow(page, originalId).click()
    await page.getByTestId('code-terminal-mode-toggle').getByRole('button', { name: 'Chat' }).click()
    await patchReturned
    await expect(agentRow(page, originalId)).toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await expect(page.getByTestId('app-toast')).toHaveCount(0)

    await page.evaluate(nextState => window.__farmingEmitSwitchState?.(nextState), state([mismatchedRestore]))
    await expect(agentRow(page, originalId)).toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await expect(page.getByTestId('code-agent-chat-view')).toHaveCount(0)

    await page.evaluate(nextState => window.__farmingEmitSwitchState?.(nextState), state([restored]))
    await expect(agentRow(page, restoredId)).toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-agent-chat-view')).toHaveCount(0)
    await expect(page.getByTestId('app-toast')).toContainText(warning)
  })

  test('restarts a fresh Codex and never falls through to another agent', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'fresh-permission-switch')
    fs.mkdirSync(workspace, { recursive: true })
    const codexAgentId = await createControlAgent(page, 'codex', workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)
    const initialCodex = (await controlAgents(page)).find(agent => agent.id === codexAgentId)
    expect(initialCodex?.providerSessionTemporary).toBe(true)
    expect(initialCodex?.providerSessionId).toMatch(/^tmp_uuid_/)

    let patchCount = 0
    let restartedAgentId = ''
    let releaseResponse = () => {}
    let markBackendFinished = () => {}
    const backendFinished = new Promise<void>(resolve => { markBackendFinished = resolve })
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      patchCount += 1
      const response = await route.fetch()
      const payload = await response.json() as { restartedAgentId?: string }
      restartedAgentId = payload.restartedAgentId ?? ''
      markBackendFinished()
      await responseGate
      await route.fulfill({ response })
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    await expect(agentRow(page, codexAgentId)).toHaveClass(/active/)
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    const unsentDraft = 'keep this unsent draft across the permission restart'
    await page.getByTestId('code-composer-input').fill(unsentDraft)
    await page.getByTestId('code-composer-approval').click()
    const fullAccess = page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ })
    await fullAccess.evaluate(element => {
      ;(element as HTMLButtonElement).click()
      ;(element as HTMLButtonElement).click()
    })

    await backendFinished
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await expect(page.getByTestId('code-agent-work-pane')).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByTestId('code-composer-input')).toBeDisabled()
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
    expect(restartedAgentId).not.toBe('')
    await expect(agentRow(page, restartedAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    expect(patchCount).toBe(1)

    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    releaseResponse()
    await expect.poll(() => restartedAgentId).not.toBe('')
    await expect(agentRow(page, restartedAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
    await page.locator('body').evaluate(element => { element.dataset.appearance = 'dark' })
    await expect(page.getByTestId('code-composer-approval')).toHaveClass(/orange/)
    await expect(page.getByTestId('code-composer-approval')).toHaveCSS('color', 'rgb(229, 75, 0)')
    const replacement = (await controlAgents(page)).find(agent => agent.id === restartedAgentId)
    expect(replacement?.providerSessionTemporary).toBe(true)
    expect(replacement?.providerSessionId).toMatch(/^tmp_uuid_/)
    expect(replacement?.providerSessionId).not.toBe(initialCodex?.providerSessionId)
  })

  test('keeps the WebSocket replacement when the PATCH response is lost', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'lost-permission-response')
    fs.mkdirSync(workspace, { recursive: true })
    const codexAgentId = await createControlAgent(page, 'codex', workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)

    let restartedAgentId = ''
    let releaseAbort = () => {}
    let markBackendFinished = () => {}
    const backendFinished = new Promise<void>(resolve => { markBackendFinished = resolve })
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const payload = await response.json() as { restartedAgentId?: string }
      restartedAgentId = payload.restartedAgentId ?? ''
      markBackendFinished()
      await abortGate
      await route.abort('failed')
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    const unsentDraft = 'keep draft when the permission response disappears'
    await page.getByTestId('code-composer-input').fill(unsentDraft)
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    await backendFinished
    expect(restartedAgentId).not.toBe('')
    await expect(agentRow(page, restartedAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()

    releaseAbort()
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expect(agentRow(page, restartedAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
    await expect(page.getByTestId('code-composer-approval')).toBeEnabled()
  })

  test('reconciles a replacement that arrives after the PATCH has already failed', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'late-websocket-permission-replacement')
    fs.mkdirSync(workspace, { recursive: true })
    const codexAgentId = await createControlAgent(page, 'codex', workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)

    let markRequestAborted = () => {}
    const requestAborted = new Promise<void>(resolve => { markRequestAborted = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      await route.abort('failed')
      markRequestAborted()
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    const unsentDraft = 'keep draft when replacement arrives after fetch failure'
    await page.getByTestId('code-composer-input').fill(unsentDraft)
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    await requestAborted
    await page.waitForTimeout(100)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await expect(agentRow(page, codexAgentId)).toHaveClass(/active/)

    const replacementResponse = await page.request.patch(`/farming/api/agents/${codexAgentId}`, {
      data: { launchPermissionMode: 'full' },
    })
    expect(replacementResponse.ok()).toBeTruthy()
    const replacementPayload = await replacementResponse.json() as { restartedAgentId?: string }
    const replacementAgentId = replacementPayload.restartedAgentId ?? ''
    expect(replacementAgentId).not.toBe('')
    await expect(agentRow(page, replacementAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
  })

  test('follows a replacement restarted by another client before the first response returns', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'chained-permission-switch')
    fs.mkdirSync(workspace, { recursive: true })
    const codexAgentId = await createControlAgent(page, 'codex', workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)

    let intermediateAgentId = ''
    let releaseResponse = () => {}
    let markBackendFinished = () => {}
    const backendFinished = new Promise<void>(resolve => { markBackendFinished = resolve })
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const payload = await response.json() as { restartedAgentId?: string }
      intermediateAgentId = payload.restartedAgentId ?? ''
      markBackendFinished()
      await responseGate
      await route.fulfill({ response })
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    const unsentDraft = 'keep draft through a chained permission restart'
    await page.getByTestId('code-composer-input').fill(unsentDraft)
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    await backendFinished
    expect(intermediateAgentId).not.toBe('')
    await expect(agentRow(page, intermediateAgentId)).toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()

    const chainedResponse = await page.request.patch(`/farming/api/agents/${intermediateAgentId}`, {
      data: { launchPermissionMode: 'ask' },
    })
    expect(chainedResponse.ok()).toBeTruthy()
    const chainedPayload = await chainedResponse.json() as { restartedAgentId?: string }
    const finalAgentId = chainedPayload.restartedAgentId ?? ''
    expect(finalAgentId).not.toBe('')
    await expect(agentRow(page, finalAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, intermediateAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()

    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    releaseResponse()
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expect(agentRow(page, finalAgentId)).toHaveClass(/active/)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await page.waitForTimeout(250)
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
  })

  test('keeps an observing browser on the same agent and view', async ({ page, context, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'observing-browser-permission-switch')
    fs.mkdirSync(workspace, { recursive: true })
    const sessionId = '019f0000-0000-7000-8000-00000000b22f'
    const codexAgentId = await createControlAgent(page, `codex resume ${sessionId}`, workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)
    const observerPage = await context.newPage()

    await openPermissionTestApp(page)
    await openPermissionTestApp(observerPage)
    await agentRow(observerPage, codexAgentId).click()
    await expect(
      observerPage.getByTestId('code-terminal-mode-toggle').getByRole('button', { name: 'Terminal' }),
    ).toHaveAttribute('aria-pressed', 'true')
    const observerDraft = 'keep the observing browser draft and view'
    await observerPage.getByTestId('code-composer-input').fill(observerDraft)
    await observerPage.getByTestId('code-nav-history').click()
    await expect(observerPage.getByTestId('code-history-panel')).toBeVisible()

    await page.waitForTimeout(180)
    await agentRow(page, codexAgentId).click()
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    let replacementAgentId = ''
    await expect.poll(async () => {
      const agents = await controlAgents(page)
      replacementAgentId = agents.find(agent => (
        agent.cwd === workspace && agent.id !== codexAgentId && agent.id !== bashAgentId
      ))?.id ?? ''
      return replacementAgentId
    }).not.toBe('')
    await expect(agentRow(observerPage, replacementAgentId)).toHaveClass(/active/)
    await expect(agentRow(observerPage, codexAgentId)).toHaveCount(0)
    await expect(agentRow(observerPage, bashAgentId)).not.toHaveClass(/active/)
    await expect(observerPage.getByTestId('code-history-panel')).toBeVisible()
    await observerPage.keyboard.press('Escape')
    await expect(observerPage.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(observerPage.getByTestId('code-agent-chat-view')).toHaveCount(0)
    await expect(observerPage.getByTestId('code-composer-input')).toHaveValue(observerDraft)
  })

  test('preserves explicit navigation and Terminal view across a resumable restart', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'resumable-permission-switch')
    fs.mkdirSync(workspace, { recursive: true })
    const sessionId = '019f0000-0000-7000-8000-00000000a11e'
    const codexAgentId = await createControlAgent(page, `codex resume ${sessionId}`, workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)

    let restartedAgentId = ''
    let releaseResponse = () => {}
    let markBackendFinished = () => {}
    const backendFinished = new Promise<void>(resolve => { markBackendFinished = resolve })
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const payload = await response.json() as { restartedAgentId?: string }
      restartedAgentId = payload.restartedAgentId ?? ''
      markBackendFinished()
      await responseGate
      await route.fulfill({ response })
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    await expect(
      page.getByTestId('code-terminal-mode-toggle').getByRole('button', { name: 'Terminal' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-agent-chat-view')).toHaveCount(0)
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    await backendFinished
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await agentRow(page, bashAgentId).click()
    await expect(agentRow(page, bashAgentId)).toHaveClass(/active/)
    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    releaseResponse()

    await expect.poll(() => restartedAgentId).not.toBe('')
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expect(agentRow(page, bashAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, restartedAgentId)).not.toHaveClass(/active/)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await agentRow(page, restartedAgentId).click()
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-agent-chat-view')).toHaveCount(0)
  })
})
