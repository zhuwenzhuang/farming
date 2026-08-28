import type { WebSocketRoute } from '@playwright/test'
import type { AgentStateWire } from '../../shared/agent-state-wire'
import {
  PROTOCOL_VERSION,
  validateServerMessage,
  type ProtocolServerHelloMessage,
  type StateDeltaMessage,
  type StateMessage,
  type StateResyncMessage,
} from '../../shared/browser-protocol'
import { expect, test } from './fixtures'

type CrtTestAgent = AgentStateWire & {
  customTitle: string
  projectWorkspace: string
}

type CrtTestStateMetadata = {
  agentInventoryRunning?: number
  agentInventoryScope?: 'all'
  agentInventoryTotal?: number
  mainPageSessionKeys?: string[]
  mainAgentId?: null
  projectWorkspaces?: string[]
  taskHistory?: []
}

type CrtTestStateMessage = StateMessage<CrtTestAgent, CrtTestStateMetadata>
type CrtTestDeltaMessage = StateDeltaMessage<CrtTestAgent, CrtTestStateMetadata>

function testAgent(id: string, customTitle: string): CrtTestAgent {
  return {
    id,
    command: 'bash',
    cwd: `/tmp/${id}`,
    output: '',
    status: 'running',
    isMain: false,
    activityLevel: 'cold',
    lastActivity: 1,
    attentionScore: 0,
    isZombie: false,
    runtimeBinding: { kind: 'terminal' },
    runtimeObservation: {
      kind: 'shell',
      phase: 'idle',
      confidence: 'high',
      source: 'shell-marker',
      observerVersion: 'crt-agent-state-test',
      observedAt: 1,
    },
    providerCapabilities: {
      supportedRuntimes: ['terminal'],
      runtimeSwitch: false,
      terminalProfile: false,
      terminalComposerInput: 'bracketed-paste',
      slashCommandDiscovery: false,
      goals: false,
      goalSubmission: null,
      terminalSessionFork: false,
      sessionFork: false,
      chatRuntime: '',
      supportsChat: false,
      supportsSteer: false,
    },
    customTitle,
    projectWorkspace: `/tmp/${id}`,
  }
}

function send(socket: WebSocketRoute, message: ProtocolServerHelloMessage | CrtTestStateMessage | CrtTestDeltaMessage) {
  if (message.type === 'state' || message.type === 'state-delta') {
    expect(validateServerMessage(message)).toMatchObject({ ok: true })
  }
  socket.send(JSON.stringify(message))
}

test('CRT reduces paged Agent state and resyncs sequence and generation gaps', async ({ page }) => {
  let socket: WebSocketRoute | null = null
  const clientMessages: Array<Record<string, unknown>> = []
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, route => {
    socket = route
    route.onMessage(message => {
      const parsed = JSON.parse(String(message)) as Record<string, unknown>
      clientMessages.push(parsed)
    })
  })

  await page.goto('/farming/crt/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => clientMessages.some(message => message.type === 'protocol-hello')).toBe(true)
  if (!socket) throw new Error('CRT WebSocket route was not created')

  send(socket, {
    type: 'protocol-hello',
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: PROTOCOL_VERSION,
  })

  const alpha = testAgent('agent-alpha', 'Alpha')
  const beta = testAgent('agent-beta', 'Beta')
  send(socket, {
    type: 'state',
    generation: 'crt-generation-1',
    sequence: 1,
    snapshot: {
      complete: false,
      id: 'crt-snapshot-1',
      offset: 0,
      total: 2,
    },
    state: {
      agents: [alpha],
      agentInventoryRunning: 2,
      agentInventoryScope: 'all',
      agentInventoryTotal: 2,
      mainAgentId: null,
      taskHistory: [],
    },
  })
  send(socket, {
    type: 'state',
    generation: 'crt-generation-1',
    sequence: 1,
    snapshot: {
      complete: true,
      id: 'crt-snapshot-1',
      offset: 1,
      total: 2,
    },
    state: { agents: [beta] },
  })

  const cards = page.locator('#map-area .agent-block[data-agent-id]')
  await expect(cards).toHaveCount(2)
  await expect(page.locator('#active-agents')).toHaveText('2')
  await expect(page.locator('#total-agents')).toHaveText('2')
  await expect(page.locator('[data-agent-id="agent-alpha"] .agent-header')).toHaveText('Alpha')
  await expect(page.locator('[data-agent-id="agent-beta"] .agent-header')).toHaveText('Beta')

  socket.send('{invalid-json')
  socket.send(JSON.stringify({
    type: 'state-delta',
    generation: 'crt-generation-1',
    sequence: 2,
    upserts: 'invalid',
    removedAgentIds: [],
  }))

  await expect.poll(() => clientMessages.filter(message => message.type === 'state-resync').length).toBe(1)
  expect(clientMessages.filter(message => message.type === 'state-resync')[0]).toEqual({ type: 'state-resync' })

  const updatedAlpha = testAgent('agent-alpha', 'Alpha updated')
  send(socket, {
    type: 'state',
    generation: 'crt-generation-1',
    sequence: 2,
    snapshot: {
      complete: true,
      id: 'crt-snapshot-recovered-after-invalid-delta',
      offset: 0,
      total: 2,
    },
    state: {
      agents: [updatedAlpha, beta],
      agentInventoryRunning: 2,
      agentInventoryScope: 'all',
      agentInventoryTotal: 2,
      mainAgentId: null,
      taskHistory: [],
    },
  })
  await expect(page.locator('[data-agent-id="agent-alpha"] .agent-header')).toHaveText('Alpha updated')
  expect(pageErrors).toEqual([])

  send(socket, {
    type: 'state-delta',
    generation: 'crt-generation-1',
    sequence: 2,
    upserts: [testAgent('agent-alpha', 'Duplicate must not paint')],
    removedAgentIds: [],
  })
  send(socket, {
    type: 'state-delta',
    generation: 'crt-generation-1',
    sequence: 1,
    upserts: [testAgent('agent-alpha', 'Stale must not paint')],
    removedAgentIds: [],
  })
  await expect(page.locator('[data-agent-id="agent-alpha"] .agent-header')).toHaveText('Alpha updated')

  send(socket, {
    type: 'state-delta',
    generation: 'crt-generation-1',
    sequence: 4,
    upserts: [testAgent('agent-alpha', 'Sequence gap must not paint')],
    removedAgentIds: [],
  })
  await expect.poll(() => clientMessages.filter(message => message.type === 'state-resync').length).toBe(2)
  expect(clientMessages.filter(message => message.type === 'state-resync')[1] as StateResyncMessage).toMatchObject({
    type: 'state-resync',
    generation: 'crt-generation-1',
    afterSequence: 2,
  })
  await expect(page.locator('[data-agent-id="agent-alpha"] .agent-header')).toHaveText('Alpha updated')

  send(socket, {
    type: 'state',
    generation: 'crt-generation-1',
    sequence: 4,
    snapshot: {
      complete: true,
      id: 'crt-snapshot-2',
      offset: 0,
      total: 2,
    },
    state: {
      agents: [testAgent('agent-alpha', 'Alpha recovered'), beta],
      agentInventoryRunning: 2,
      agentInventoryScope: 'all',
      agentInventoryTotal: 2,
      mainAgentId: null,
      taskHistory: [],
    },
  })
  await expect(page.locator('[data-agent-id="agent-alpha"] .agent-header')).toHaveText('Alpha recovered')

  send(socket, {
    type: 'state-delta',
    generation: 'crt-generation-2',
    sequence: 1,
    upserts: [testAgent('agent-alpha', 'Generation gap must not paint')],
    removedAgentIds: [],
  })
  await expect.poll(() => clientMessages.filter(message => message.type === 'state-resync').length).toBe(3)
  expect(clientMessages.filter(message => message.type === 'state-resync')[2] as StateResyncMessage).toMatchObject({
    type: 'state-resync',
    generation: 'crt-generation-1',
    afterSequence: 4,
  })
  await expect(page.locator('[data-agent-id="agent-alpha"] .agent-header')).toHaveText('Alpha recovered')
})

test('CRT requests a full resync after a malformed initial Agent snapshot', async ({ page }) => {
  let socket: WebSocketRoute | null = null
  const clientMessages: Array<Record<string, unknown>> = []
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, route => {
    socket = route
    route.onMessage(message => {
      clientMessages.push(JSON.parse(String(message)) as Record<string, unknown>)
    })
  })

  await page.goto('/farming/crt/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => clientMessages.some(message => message.type === 'protocol-hello')).toBe(true)
  if (!socket) throw new Error('CRT WebSocket route was not created')

  send(socket, {
    type: 'protocol-hello',
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: PROTOCOL_VERSION,
  })
  socket.send(JSON.stringify({
    type: 'state',
    generation: 'crt-malformed-generation',
    sequence: 1,
    snapshot: {
      complete: true,
      id: 'crt-malformed-snapshot',
      offset: 0,
      total: 1,
    },
    state: { agents: 'invalid' },
  }))

  await expect.poll(() => clientMessages.filter(message => message.type === 'state-resync').length).toBe(1)
  expect(clientMessages.find(message => message.type === 'state-resync')).toEqual({ type: 'state-resync' })

  const recovered = testAgent('agent-recovered', 'Recovered from malformed snapshot')
  send(socket, {
    type: 'state',
    generation: 'crt-recovered-generation',
    sequence: 1,
    snapshot: {
      complete: true,
      id: 'crt-recovered-snapshot',
      offset: 0,
      total: 1,
    },
    state: {
      agents: [recovered],
      agentInventoryRunning: 1,
      agentInventoryScope: 'all',
      agentInventoryTotal: 1,
      mainAgentId: null,
      taskHistory: [],
    },
  })

  await expect(page.locator('[data-agent-id="agent-recovered"] .agent-header')).toHaveText(
    'Recovered from malformed snapshot',
  )
})

test('CRT keeps a focused Pi session title and read state synchronized', async ({ page }) => {
  let socket: WebSocketRoute | null = null
  const clientMessages: Array<Record<string, unknown>> = []
  const readPatches: Array<Record<string, unknown>> = []
  const agentId = 'agent-pi-title'
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, route => {
    socket = route
    route.onMessage(message => {
      clientMessages.push(JSON.parse(String(message)) as Record<string, unknown>)
    })
  })
  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => (
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ transcript: { updatedAt: 'initial', entries: [] } }),
    })
  ))
  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-session\\?includeEntries=0$`), route => (
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ session: { availableCommands: [], configOptions: [] } }),
    })
  ))
  await page.route(new RegExp(`/farming/api/agents/${agentId}$`), route => {
    if (route.request().method() === 'PATCH') {
      readPatches.push(route.request().postDataJSON() as Record<string, unknown>)
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ changed: true }),
    })
  })

  await page.goto(`/farming/crt/?agent=${agentId}`, { waitUntil: 'domcontentloaded' })
  await expect.poll(() => clientMessages.some(message => message.type === 'protocol-hello')).toBe(true)
  if (!socket) throw new Error('CRT WebSocket route was not created')

  send(socket, {
    type: 'protocol-hello',
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: PROTOCOL_VERSION,
  })
  const pi = {
    ...testAgent(agentId, ''),
    command: 'pi',
    adaptiveTitle: 'Initial Pi title',
    runtimeBinding: {
      kind: 'acp' as const,
      state: 'idle',
      error: '',
      stopReason: '',
      supportsSteer: false,
      supportsFork: false,
      pendingPermission: null,
      pendingPermissions: [],
      pendingElicitation: null,
      pendingElicitations: [],
      activeElicitations: [],
      sessionUpdatedAt: '',
      sessionRevision: 0,
    },
    providerCapabilities: {
      supportedRuntimes: ['terminal', 'acp'] as const,
      runtimeSwitch: true,
      terminalProfile: true,
      terminalComposerInput: 'bracketed-paste' as const,
      slashCommandDiscovery: false,
      goals: false,
      goalSubmission: null,
      terminalSessionFork: false,
      sessionFork: false,
      chatRuntime: 'acp' as const,
      supportsChat: true,
      supportsSteer: false,
    },
  }
  send(socket, {
    type: 'state',
    generation: 'crt-pi-title-generation',
    sequence: 1,
    snapshot: {
      complete: true,
      id: 'crt-pi-title-snapshot',
      offset: 0,
      total: 1,
    },
    state: {
      agents: [pi],
      agentInventoryRunning: 1,
      agentInventoryScope: 'all',
      agentInventoryTotal: 1,
      mainAgentId: null,
      taskHistory: [],
    },
  })

  await expect(page.locator('#session-title')).toHaveText('Initial Pi title')
  socket.send(JSON.stringify({
    type: 'agent-update',
    update: { agentId, patch: { adaptiveTitle: 'Updated Pi title' } },
  }))
  await expect(page.locator('#session-title')).toHaveText('Updated Pi title')

  socket.send(JSON.stringify({
    type: 'agent-read',
    read: {
      agentId,
      unread: true,
      attentionSeq: 1,
      readAttentionSeq: 0,
      readOutputEpoch: '',
      readOutputSeq: null,
    },
  }))
  await expect.poll(() => readPatches).toEqual([{ readAttentionSeq: 1 }])

  await page.locator('#session-modal .close-btn').click()
  await expect(page.locator(`[data-agent-id="${agentId}"]`)).not.toHaveClass(/unread/)
})

test('Code consumes the same paged Agent state and delta sequence contract', async ({ page }) => {
  let socket: WebSocketRoute | null = null
  const clientMessages: Array<Record<string, unknown>> = []
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, route => {
    socket = route
    route.onMessage(message => {
      clientMessages.push(JSON.parse(String(message)) as Record<string, unknown>)
    })
  })

  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => clientMessages.some(message => message.type === 'protocol-hello')).toBe(true)
  if (!socket) throw new Error('Code WebSocket route was not created')

  send(socket, {
    type: 'protocol-hello',
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: PROTOCOL_VERSION,
  })

  const workspace = '/tmp/code-agent-state'
  const alpha = { ...testAgent('code-agent-alpha', 'Code Alpha'), cwd: workspace, projectWorkspace: workspace }
  const beta = { ...testAgent('code-agent-beta', 'Code Beta'), cwd: workspace, projectWorkspace: workspace }
  send(socket, {
    type: 'state',
    generation: 'code-generation-1',
    sequence: 1,
    snapshot: {
      complete: false,
      id: 'code-snapshot-1',
      offset: 0,
      total: 2,
    },
    state: {
      agents: [alpha],
      agentInventoryRunning: 2,
      agentInventoryScope: 'all',
      agentInventoryTotal: 2,
      mainAgentId: null,
      mainPageSessionKeys: [],
      projectWorkspaces: [workspace],
      taskHistory: [],
    },
  })
  send(socket, {
    type: 'state',
    generation: 'code-generation-1',
    sequence: 1,
    snapshot: {
      complete: true,
      id: 'code-snapshot-1',
      offset: 1,
      total: 2,
    },
    state: { agents: [beta] },
  })

  const alphaRow = page.locator('[data-testid="code-agent-row"][data-agent-id="code-agent-alpha"]')
  const betaRow = page.locator('[data-testid="code-agent-row"][data-agent-id="code-agent-beta"]')
  await expect(alphaRow).toContainText('Code Alpha')
  await expect(betaRow).toContainText('Code Beta')

  send(socket, {
    type: 'state-delta',
    generation: 'code-generation-1',
    sequence: 2,
    upserts: [{ ...alpha, customTitle: 'Code Alpha updated' }],
    removedAgentIds: [],
  })
  await expect(alphaRow).toContainText('Code Alpha updated')

  send(socket, {
    type: 'state-delta',
    generation: 'code-generation-1',
    sequence: 4,
    upserts: [{ ...alpha, customTitle: 'Code sequence gap must not paint' }],
    removedAgentIds: [],
  })
  await expect.poll(() => clientMessages.filter(message => message.type === 'state-resync').length).toBe(1)
  expect(clientMessages.find(message => message.type === 'state-resync')).toMatchObject({
    type: 'state-resync',
    generation: 'code-generation-1',
    afterSequence: 2,
  })
  await expect(alphaRow).toContainText('Code Alpha updated')
})
