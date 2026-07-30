import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY,
  loadAgentComposerCheckpoint,
  nextAgentComposerCheckpointTimestamp,
  saveAgentComposerCheckpoint,
} from '../src/components/code/composer-persistence'
import { createDefaultAgentComposerState } from '../src/components/code/composer-state'

class MemoryStorage {
  values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

test('round-trips bounded Composer state without transient browser-only fields', () => {
  const storage = new MemoryStorage()
  const state = createDefaultAgentComposerState()
  state.draft = 'unsent draft'
  state.mode = 'plan'
  state.history = { entries: ['first prompt', 'second prompt'], cursor: 0 }
  state.attachments = [
    {
      id: 'ready-image',
      kind: 'image',
      name: 'ready.png',
      type: 'image/png',
      size: 12,
      status: 'ready',
      path: '/tmp/farming-attachments/ready.png',
      previewUrl: 'blob:must-not-survive',
    },
    {
      id: 'uploading-image',
      kind: 'image',
      name: 'uploading.png',
      type: 'image/png',
      size: 12,
      status: 'uploading',
      previewUrl: 'blob:uploading',
    },
  ]
  state.pendingFollowUp = {
    createdAt: 10,
    messages: [{
      id: 'pending-message-1',
      text: 'formatted queued prompt',
      editableText: 'queued prompt',
      composerMode: 'goal',
      createdAt: 10,
      attachments: [{
        kind: 'image',
        name: 'queued.png',
        type: 'image/png',
        size: 20,
        path: '/tmp/farming-attachments/queued.png',
      }],
    }],
  }
  state.submissions = [{
    id: 'pending-message-2',
    text: 'steer awaiting reconciliation',
    createdAt: 20,
    status: 'submitting',
    historyRecorded: true,
    delivery: 'steer',
  }]
  state.ui.plusMenuOpen = true

  assert.equal(saveAgentComposerCheckpoint(
    { 'acp:agent-session:codex:thread-1': state },
    new Map([['acp:agent-session:codex:thread-1', 100]]),
    new Map(),
    storage,
    200,
  ), true)

  const restored = loadAgentComposerCheckpoint(storage, 300)
    .states['acp:agent-session:codex:thread-1']
  assert.ok(restored)
  assert.equal(restored.draft, 'unsent draft')
  assert.equal(restored.mode, 'plan')
  assert.deepEqual(restored.history, { entries: ['first prompt', 'second prompt'], cursor: null })
  assert.deepEqual(restored.attachments, [{
    id: 'ready-image',
    kind: 'image',
    name: 'ready.png',
    type: 'image/png',
    size: 12,
    status: 'ready',
    path: '/tmp/farming-attachments/ready.png',
  }])
  assert.equal(restored.ui.plusMenuOpen, false)
  assert.equal(restored.pendingFollowUp?.messages[0]?.editableText, 'queued prompt')
  assert.equal(restored.pendingFollowUp?.messages[0]?.composerMode, 'goal')
  assert.equal(restored.pendingFollowUp?.messages[0]?.attachments?.[0]?.path, '/tmp/farming-attachments/queued.png')
  assert.equal(restored.submissions?.[0]?.status, 'failed')
  assert.equal(restored.submissions?.[0]?.delivery, 'steer')
})

test('keeps terminal and ACP Composer namespaces isolated', () => {
  const storage = new MemoryStorage()
  const terminal = createDefaultAgentComposerState()
  terminal.draft = 'terminal draft'
  const acp = createDefaultAgentComposerState()
  acp.draft = 'chat draft'

  saveAgentComposerCheckpoint(
    {
      'agent-session:codex:thread-1': terminal,
      'acp:agent-session:codex:thread-1': acp,
    },
    new Map([
      ['agent-session:codex:thread-1', 100],
      ['acp:agent-session:codex:thread-1', 200],
    ]),
    new Map(),
    storage,
    300,
  )

  const restored = loadAgentComposerCheckpoint(storage, 400).states
  assert.equal(restored['agent-session:codex:thread-1']?.draft, 'terminal draft')
  assert.equal(restored['acp:agent-session:codex:thread-1']?.draft, 'chat draft')
})

test('ignores corrupt, expired, and oversized checkpoints without throwing', () => {
  const storage = new MemoryStorage()
  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, '{broken')
  assert.deepEqual(loadAgentComposerCheckpoint(storage).states, {})

  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 1,
    savedAt: 1,
    states: { stale: { updatedAt: 1, draft: 'stale' } },
  }))
  assert.deepEqual(loadAgentComposerCheckpoint(storage, 40 * 24 * 60 * 60 * 1000).states, {})

  const prior = '{"prior":true}'
  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, prior)
  const oversized = createDefaultAgentComposerState()
  oversized.draft = 'x'.repeat(250_001)
  const valid = createDefaultAgentComposerState()
  valid.draft = 'still persists'
  assert.equal(saveAgentComposerCheckpoint(
    { oversized, valid },
    new Map([['oversized', 1], ['valid', 2]]),
    new Map(),
    storage,
    3,
  ), true)
  const restored = loadAgentComposerCheckpoint(storage, 4).states
  assert.equal(restored.oversized, undefined)
  assert.equal(restored.valid?.draft, 'still persists')
})

test('evicts oldest records when the serialized payload exceeds its global bound', () => {
  const storage = new MemoryStorage()
  const states: Record<string, ReturnType<typeof createDefaultAgentComposerState>> = {}
  const updatedAt = new Map<string, number>()
  for (let index = 0; index < 12; index += 1) {
    const state = createDefaultAgentComposerState()
    state.draft = `${index}:${'x'.repeat(240_000)}`
    states[`agent-${index}`] = state
    updatedAt.set(`agent-${index}`, index)
  }

  assert.equal(saveAgentComposerCheckpoint(states, updatedAt, new Map(), storage, 100), true)
  const restored = loadAgentComposerCheckpoint(storage, 101).states
  assert.ok(Object.keys(restored).length > 0)
  assert.ok(Object.keys(restored).length < Object.keys(states).length)
  assert.equal(restored['agent-11']?.draft.startsWith('11:'), true)
  assert.equal(restored['agent-1'], undefined)
})

test('merges different tabs by key and keeps the newest same-key state', () => {
  const storage = new MemoryStorage()
  const first = createDefaultAgentComposerState()
  first.draft = 'first tab draft'
  assert.equal(saveAgentComposerCheckpoint(
    { first },
    new Map([['first', 100]]),
    new Map(),
    storage,
    100,
  ), true)

  const second = createDefaultAgentComposerState()
  second.draft = 'second tab draft'
  assert.equal(saveAgentComposerCheckpoint(
    { second },
    new Map([['second', 200]]),
    new Map(),
    storage,
    200,
  ), true)
  assert.deepEqual(
    Object.keys(loadAgentComposerCheckpoint(storage, 201).states).sort(),
    ['first', 'second'],
  )

  const staleFirst = createDefaultAgentComposerState()
  staleFirst.draft = 'stale overwrite'
  saveAgentComposerCheckpoint(
    { first: staleFirst },
    new Map([['first', 90]]),
    new Map(),
    storage,
    210,
  )
  assert.equal(loadAgentComposerCheckpoint(storage, 211).states.first?.draft, 'first tab draft')
})

test('persists deletion tombstones so stale tabs cannot resurrect removed state', () => {
  const storage = new MemoryStorage()
  const original = createDefaultAgentComposerState()
  original.draft = 'remove me'
  saveAgentComposerCheckpoint(
    { shared: original },
    new Map([['shared', 100]]),
    new Map(),
    storage,
    100,
  )
  saveAgentComposerCheckpoint(
    {},
    new Map(),
    new Map([['shared', 200]]),
    storage,
    200,
  )
  assert.equal(loadAgentComposerCheckpoint(storage, 201).states.shared, undefined)

  const stale = createDefaultAgentComposerState()
  stale.draft = 'stale resurrection'
  saveAgentComposerCheckpoint(
    { shared: stale },
    new Map([['shared', 150]]),
    new Map(),
    storage,
    210,
  )
  assert.equal(loadAgentComposerCheckpoint(storage, 211).states.shared, undefined)

  const fresh = createDefaultAgentComposerState()
  fresh.draft = 'fresh replacement'
  saveAgentComposerCheckpoint(
    { shared: fresh },
    new Map([['shared', 300]]),
    new Map(),
    storage,
    300,
  )
  assert.equal(loadAgentComposerCheckpoint(storage, 301).states.shared?.draft, 'fresh replacement')
})

test('advances a per-key logical timestamp past same-millisecond updates and deletions', () => {
  assert.equal(nextAgentComposerCheckpointTimestamp(
    'shared',
    new Map([['shared', 200]]),
    new Map([['shared', 200]]),
    200,
  ), 201)
})

test('keeps the latest one hundred history entries', () => {
  const storage = new MemoryStorage()
  const state = createDefaultAgentComposerState()
  state.history.entries = Array.from({ length: 120 }, (_, index) => `prompt-${index}`)
  saveAgentComposerCheckpoint(
    { history: state },
    new Map([['history', 100]]),
    new Map(),
    storage,
    100,
  )
  const entries = loadAgentComposerCheckpoint(storage, 101).states.history?.history.entries
  assert.equal(entries?.length, 100)
  assert.equal(entries?.[0], 'prompt-20')
  assert.equal(entries?.at(-1), 'prompt-119')
})
