import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composerStateAliasKeysForAgent,
  composerStateKeyForAgent,
  createDefaultAgentComposerState,
  mergeAgentComposerStates,
} from '../src/components/code/composer-state'
import type { Agent } from '../src/types/agent'

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    command: 'codex',
    cwd: '/workspace',
    output: '',
    previewText: '',
    status: 'running',
    isMain: false,
    activityLevel: 'idle',
    lastActivity: 0,
    attentionScore: 0,
    isZombie: false,
    providerSessionProvider: 'codex',
    providerSessionId: 'thread-1',
    providerHomeId: 'default',
    ...overrides,
  }
}

test('keeps composer state attached to a stable provider session across agent replacement', () => {
  const original = agent({ id: 'agent-original', restartedFromAgentIds: ['agent-before'] })
  assert.equal(composerStateKeyForAgent(original), 'agent-session:codex:thread-1')
  assert.deepEqual(
    composerStateAliasKeysForAgent(original).sort(),
    ['agent-before', 'agent-original', 'agent-session:codex:thread-1'].sort(),
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
  assert.deepEqual(merged.pendingFollowUp?.messages.map(message => message.id), ['new', 'old'])
  assert.equal(merged.pendingFollowUp?.createdAt, 10)
})
