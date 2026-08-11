import type { WebSocketRoute } from '@playwright/test'
import {
  PROTOCOL_VERSION,
  type ProtocolServerHelloMessage,
  type StateDeltaMessage,
  type StateMessage,
  type StateResyncMessage,
} from '../../shared/browser-protocol'
import { expect, test } from './fixtures'

type CrtTestAgent = {
  id: string
  command: string
  cwd: string
  output: string
  status: 'running'
  isMain: false
  activityLevel: 'cold'
  lastActivity: number
  runtimeBinding: { kind: 'terminal' }
  runtimeObservation: {
    kind: 'shell'
    phase: 'idle'
    confidence: 'high'
    source: 'shell-marker'
    observerVersion: string
    observedAt: number
  }
  providerCapabilities: {
    supportedRuntimes: ['terminal']
    runtimeSwitch: false
    terminalProfile: false
    terminalSessionFork: false
    sessionFork: false
    chatRuntime: ''
    supportsChat: false
    supportsSteer: false
  }
  customTitle: string
  projectWorkspace: string
}

type CrtTestStateMetadata = {
  agentInventoryRunning?: number
  agentInventoryScope?: 'all'
  agentInventoryTotal?: number
  mainAgentId?: null
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
  socket.send(JSON.stringify(message))
}

test('CRT reduces paged Agent state and resyncs sequence and generation gaps', async ({ page }) => {
  let socket: WebSocketRoute | null = null
  const clientMessages: Array<Record<string, unknown>> = []
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

  const updatedAlpha = testAgent('agent-alpha', 'Alpha updated')
  send(socket, {
    type: 'state-delta',
    generation: 'crt-generation-1',
    sequence: 2,
    upserts: [updatedAlpha],
    removedAgentIds: [],
  })
  await expect(page.locator('[data-agent-id="agent-alpha"] .agent-header')).toHaveText('Alpha updated')

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
  await expect.poll(() => clientMessages.filter(message => message.type === 'state-resync').length).toBe(1)
  expect(clientMessages.filter(message => message.type === 'state-resync')[0] as StateResyncMessage).toMatchObject({
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
  await expect.poll(() => clientMessages.filter(message => message.type === 'state-resync').length).toBe(2)
  expect(clientMessages.filter(message => message.type === 'state-resync')[1] as StateResyncMessage).toMatchObject({
    type: 'state-resync',
    generation: 'crt-generation-1',
    afterSequence: 4,
  })
  await expect(page.locator('[data-agent-id="agent-alpha"] .agent-header')).toHaveText('Alpha recovered')
})
