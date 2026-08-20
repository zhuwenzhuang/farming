import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '../src/types/agent'
import {
  agentWithCurrentLiveState,
  projectAgentLiveSummary,
  reconcileAgentLiveStateDelta,
  reconcileAgentLiveStates,
  resetAgentLiveStates,
  updateAgentAcpSessionRevision,
  updateAgentLiveState,
} from '../src/lib/agent-live-state'

function agent(id: string, workspace: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    cwd: workspace,
    projectWorkspace: workspace,
    runtimeBinding: { kind: 'acp', state: 'ready' },
    runtimeObservation: { phase: 'idle' },
    attentionScore: 0,
    unread: false,
    isZombie: false,
    ...patch,
  } as Agent
}

test('Project live summaries update incrementally from authoritative Agent state', () => {
  resetAgentLiveStates()
  reconcileAgentLiveStates([
    agent('main', '/alpha', { isMain: true }),
    agent('a', '/alpha', {
      attentionScore: 20,
      followUp: true,
      runtimeObservation: { phase: 'working' } as Agent['runtimeObservation'],
      unread: true,
    }),
    agent('b', '/alpha', {
      attentionScore: 90,
      isZombie: true,
    }),
    agent('archived', '/alpha', { archived: true, unread: true }),
  ])

  assert.deepEqual(projectAgentLiveSummary('/alpha'), {
    activeCount: 1,
    agentCount: 2,
    followUpCount: 1,
    maxAttentionScore: 90,
    unreadCount: 1,
    workspace: '/alpha',
    zombieCount: 1,
  })

  const stableSummary = projectAgentLiveSummary('/alpha')
  updateAgentLiveState('a', { previewText: 'irrelevant preview change' })
  assert.equal(projectAgentLiveSummary('/alpha'), stableSummary)

  updateAgentLiveState('b', { attentionScore: 10, followUp: true })
  assert.equal(projectAgentLiveSummary('/alpha')?.maxAttentionScore, 20)
  assert.equal(projectAgentLiveSummary('/alpha')?.followUpCount, 2)
  updateAgentLiveState('a', {
    attentionScore: 5,
    followUp: false,
    isZombie: true,
    runtimeObservation: { phase: 'idle' } as Agent['runtimeObservation'],
    unread: false,
  })
  assert.deepEqual(projectAgentLiveSummary('/alpha'), {
    activeCount: 0,
    agentCount: 2,
    followUpCount: 1,
    maxAttentionScore: 10,
    unreadCount: 0,
    workspace: '/alpha',
    zombieCount: 2,
  })
})

test('Project live summaries follow workspace moves and removals', () => {
  resetAgentLiveStates()
  const alpha = agent('a', '/alpha', { attentionScore: 30 })
  const moving = agent('b', '/alpha', { attentionScore: 40, followUp: true, unread: true })
  reconcileAgentLiveStates([alpha, moving])

  const moved = agent('b', '/beta', { attentionScore: 40, followUp: true, unread: true })
  reconcileAgentLiveStateDelta([moved], [])
  assert.deepEqual(projectAgentLiveSummary('/alpha'), {
    activeCount: 0,
    agentCount: 1,
    followUpCount: 0,
    maxAttentionScore: 30,
    unreadCount: 0,
    workspace: '/alpha',
    zombieCount: 0,
  })
  assert.deepEqual(projectAgentLiveSummary('/beta'), {
    activeCount: 0,
    agentCount: 1,
    followUpCount: 1,
    maxAttentionScore: 40,
    unreadCount: 1,
    workspace: '/beta',
    zombieCount: 0,
  })

  reconcileAgentLiveStateDelta([], ['a'])
  assert.equal(projectAgentLiveSummary('/alpha'), null)
})

test('Project live summaries normalize attention and clear excluded or reset Agents', () => {
  resetAgentLiveStates()
  reconcileAgentLiveStates([
    agent('low', '/scale', { attentionScore: -30 }),
    agent('high', '/scale', { attentionScore: 99.6 }),
  ])
  assert.equal(projectAgentLiveSummary('/scale')?.maxAttentionScore, 100)

  reconcileAgentLiveStateDelta([
    agent('high', '/scale', { archived: true, attentionScore: 100 }),
  ], [])
  assert.deepEqual(projectAgentLiveSummary('/scale'), {
    activeCount: 0,
    agentCount: 1,
    followUpCount: 0,
    maxAttentionScore: 0,
    unreadCount: 0,
    workspace: '/scale',
    zombieCount: 0,
  })

  resetAgentLiveStates()
  assert.equal(projectAgentLiveSummary('/scale'), null)
})

test('Project summary reads remain stable with a 10,000-Agent inventory', () => {
  resetAgentLiveStates()
  reconcileAgentLiveStates(Array.from({ length: 10_000 }, (_, index) => (
    agent(`scale-${index}`, '/scale', { attentionScore: index % 101, followUp: index % 2 === 0 })
  )))
  const summary = projectAgentLiveSummary('/scale')
  assert.equal(summary?.agentCount, 10_000)
  assert.equal(summary?.followUpCount, 5_000)
  assert.equal(summary?.maxAttentionScore, 100)
  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(projectAgentLiveSummary('/scale'), summary)
  }
})

test('ACP live revision state accepts a lower revision from a replacement identity', () => {
  resetAgentLiveStates()
  const current = agent('a', '/alpha', {
    runtimeBinding: {
      kind: 'acp',
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
      sessionRevision: 8,
      sessionUpdatedAt: '2026-08-19T00:00:08.000Z',
    },
  })
  reconcileAgentLiveStates([current])
  updateAgentAcpSessionRevision({
    agentId: 'a',
    sessionId: 'session-old',
    runtimeEpoch: 'epoch-old',
    revision: 8,
    updatedAt: '2026-08-19T00:00:08.000Z',
  })
  updateAgentAcpSessionRevision({
    agentId: 'a',
    sessionId: 'session-new',
    runtimeEpoch: 'epoch-new',
    revision: 1,
    updatedAt: '2026-08-19T00:00:09.000Z',
  })

  const runtimeBinding = agentWithCurrentLiveState(current).runtimeBinding
  assert.equal(runtimeBinding.kind === 'acp' ? runtimeBinding.sessionRevision : -1, 1)
})
