import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composerStateAliasKeysForAgent,
  composerStateKeyForAgent,
  createDefaultAgentComposerState,
  mergeAgentComposerStates,
} from '../src/components/code/composer-state'
import type { Agent } from '../src/types/agent'
import { encodeProviderSessionKey, encodeResumedProviderSessionSource } from '../shared/provider-session-identity.js'

function agent(overrides: Partial<Agent> = {}): Agent {
  const base = {
    id: 'agent-1',
    command: 'codex',
    cwd: '/workspace',
    output: '',
    previewText: '',
    status: 'running',
    isMain: false,
    activityLevel: 'cold',
    lastActivity: 0,
    attentionScore: 0,
    isZombie: false,
    providerCapabilities: {
      supportedRuntimes: ['terminal', 'acp'],
      runtimeSwitch: true,
      terminalProfile: true,
      goals: true,
      goalSubmission: null,
      terminalSessionFork: true,
      sessionFork: true,
      chatRuntime: 'acp',
      supportsChat: true,
      supportsSteer: true,
    },
    providerSessionProvider: 'codex',
    providerSessionId: 'thread-1',
    providerHomeId: 'default',
    runtimeBinding: { kind: 'terminal' },
    runtimeObservation: {
      kind: 'codex',
      phase: 'idle',
      confidence: 'authoritative',
      source: 'structured-runtime',
      observerVersion: 'test',
      observedAt: 0,
    },
  } satisfies Agent
  return {
    ...base,
    ...overrides,
  }
}

test('keeps composer state attached to a stable provider session across agent replacement', () => {
  const original = agent({ id: 'agent-original', restartedFromAgentIds: ['agent-before'] })
  assert.equal(composerStateKeyForAgent(original), encodeProviderSessionKey('codex', 'thread-1', 'default'))
  assert.deepEqual(
    composerStateAliasKeysForAgent(original).sort(),
    [
      'agent-before',
      'agent-original',
      encodeProviderSessionKey('codex', 'thread-1', 'default'),
      // A draft persisted by an older build is still reachable under the pre-v2 key.
      'agent-session:codex:thread-1',
    ].sort(),
  )
})

test('does not adopt an ambiguous pre-v2 key that belongs to another session', () => {
  // `agent-session:codex:home:work:x` historically meant session `x` under Agent
  // Home `work`, so the default-Home session with that literal id must not reach
  // for the other session's persisted drafts.
  const collidingAgent = agent({
    id: 'agent-colliding',
    providerSessionId: 'home:work:x',
    providerSessionKey: encodeProviderSessionKey('codex', 'home:work:x', 'default'),
  })
  assert.deepEqual(
    composerStateAliasKeysForAgent(collidingAgent).sort(),
    [
      'agent-colliding',
      encodeProviderSessionKey('codex', 'home:work:x', 'default'),
    ].sort(),
  )
})

test('does not adopt the origin session draft while a fork has no provider session of its own', () => {
  // A fork is admitted before its own provider session id exists. Its only
  // identity in that window is the origin it was forked from, and a fork owns a
  // new Provider Session, so it must not key on or alias the origin's state.
  const pendingFork = agent({
    id: 'agent-pending-fork',
    providerSessionProvider: undefined,
    providerSessionId: undefined,
    source: encodeResumedProviderSessionSource('codex', 'origin-thread', 'default', { forked: true }),
  })
  assert.equal(composerStateKeyForAgent(pendingFork), 'agent-pending-fork')
  assert.deepEqual(composerStateAliasKeysForAgent(pendingFork), ['agent-pending-fork'])

  const resumedOrigin = agent({
    id: 'agent-resumed-origin',
    providerSessionProvider: undefined,
    providerSessionId: undefined,
    source: encodeResumedProviderSessionSource('codex', 'origin-thread', 'default'),
  })
  assert.equal(
    composerStateKeyForAgent(resumedOrigin),
    encodeProviderSessionKey('codex', 'origin-thread', 'default'),
    'a non-forked resume still owns the origin session state',
  )
})

test('keeps chained temporary-session replacements on the original composer key', () => {
  const replacement = agent({
    id: 'agent-final',
    providerSessionTemporary: true,
    providerSessionId: 'tmp_uuid_final',
    restartedFromAgentId: 'agent-intermediate',
    restartedFromAgentIds: ['agent-original', 'agent-intermediate'],
  })
  assert.equal(composerStateKeyForAgent(replacement), 'agent-original')
  assert.deepEqual(
    composerStateAliasKeysForAgent(replacement).sort(),
    [
      'agent-final',
      'agent-intermediate',
      'agent-original',
      encodeProviderSessionKey('codex', 'tmp_uuid_final', 'default'),
      'agent-session:codex:tmp_uuid_final',
    ].sort(),
  )
})

test('merges replacement composer state without discarding queued follow-up messages', () => {
  const primary = createDefaultAgentComposerState()
  primary.draft = 'new draft'
  primary.pendingFollowUp = {
    createdAt: 20,
    messages: [{ id: 'new', text: 'new follow-up', createdAt: 20 }],
  }
  const incoming = createDefaultAgentComposerState()
  incoming.pendingFollowUp = {
    createdAt: 10,
    messages: [{ id: 'old', text: 'old follow-up', createdAt: 10 }],
  }

  const merged = mergeAgentComposerStates(primary, incoming)
  assert.equal(merged.draft, 'new draft')
  assert.deepEqual(merged.pendingFollowUp?.messages.map(message => message.id), ['old', 'new'])
  assert.equal(merged.pendingFollowUp?.createdAt, 10)
})

test('deduplicates queued follow-ups by id while preserving deterministic FIFO order', () => {
  const primary = createDefaultAgentComposerState()
  primary.pendingFollowUp = {
    createdAt: 20,
    messages: [
      { id: 'same', text: 'live copy', createdAt: 20 },
      { id: 'later', text: 'later', createdAt: 30 },
    ],
  }
  const incoming = createDefaultAgentComposerState()
  incoming.pendingFollowUp = {
    createdAt: 10,
    messages: [
      { id: 'first', text: 'first', createdAt: 10 },
      { id: 'same', text: 'persisted copy', createdAt: 20 },
    ],
  }

  const merged = mergeAgentComposerStates(primary, incoming)
  assert.deepEqual(merged.pendingFollowUp?.messages.map(message => message.id), ['first', 'same', 'later'])
  assert.equal(merged.pendingFollowUp?.messages[1]?.text, 'live copy')
})
