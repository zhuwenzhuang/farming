import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composerSubmissionOwnsDraft,
  composerStateAliasKeysForAgent,
  composerStateKeyForAgent,
  createDefaultAgentComposerState,
  mergeAgentComposerStates,
} from '../src/components/code/composer-state'
import type { Agent } from '../src/types/agent'

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
  assert.equal(composerStateKeyForAgent(original), 'agent-session:codex:thread-1')
  assert.deepEqual(
    composerStateAliasKeysForAgent(original).sort(),
    ['agent-before', 'agent-original', 'agent-session:codex:thread-1'].sort(),
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
    ['agent-final', 'agent-intermediate', 'agent-original', 'agent-session:codex:tmp_uuid_final'].sort(),
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

test('matches a retry to the exact draft and Unicode attachment ids it owns', () => {
  const state = createDefaultAgentComposerState()
  state.draft = 'retry this exact draft'
  state.attachments = [{
    id: '附件 截图 1.png',
    kind: 'image',
    name: '截图 1.png',
    type: 'image/png',
    size: 12,
    status: 'ready',
    path: '/tmp/截图 1.png',
  }]
  const submission = {
    id: 'request-retry',
    text: state.draft,
    editableText: state.draft,
    createdAt: 1,
    status: 'failed' as const,
    delivery: 'prompt' as const,
    origin: 'draft' as const,
    draftAttachmentIds: ['附件 截图 1.png'],
  }

  assert.equal(composerSubmissionOwnsDraft(state, submission), true)
  assert.equal(composerSubmissionOwnsDraft({ ...state, draft: 'newer draft' }, submission), false)
  assert.equal(composerSubmissionOwnsDraft({ ...state, attachments: [] }, submission), false)
})
