import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY,
  LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY,
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

class TrackingStorage extends MemoryStorage {
  reads: string[] = []

  getItem(key: string) {
    this.reads.push(key)
    return super.getItem(key)
  }
}

function submission(id: string, text = id) {
  return {
    id,
    text,
    editableText: text,
    createdAt: 1,
    status: 'submitting' as const,
    delivery: 'prompt' as const,
    origin: 'draft' as const,
    draftAttachmentIds: [],
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

  const persisted = JSON.parse(storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY) || '{}')
  assert.equal(
    persisted.states['acp:agent-session:codex:thread-1'].submissions,
    undefined,
    'v2 stores unresolved requests only in the top-level admission ledger',
  )
  assert.ok(persisted.admissions['pending-message-2'])

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

test('loads v1 only when no v2 checkpoint exists and migrates it on the next save', () => {
  const storage = new MemoryStorage()
  const legacySubmission = submission('request-from-v1', 'legacy unresolved request')
  const legacyRaw = JSON.stringify({
    version: 1,
    savedAt: 100,
    states: {
      legacy: {
        updatedAt: 100,
        draft: 'legacy draft',
        submissions: [legacySubmission],
      },
    },
  })
  storage.setItem(LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, legacyRaw)

  const loaded = loadAgentComposerCheckpoint(storage, 101)
  assert.equal(loaded.states.legacy?.draft, 'legacy draft')
  assert.equal(loaded.states.legacy?.submissions?.[0]?.id, legacySubmission.id)
  assert.equal(loaded.states.legacy?.submissions?.[0]?.status, 'failed')
  assert.equal(storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY), null, 'load remains read-only')

  assert.equal(saveAgentComposerCheckpoint(
    loaded.states,
    loaded.updatedAtByKey,
    new Map(),
    storage,
    102,
    {
      admissions: loaded.admissions,
      updatedAtById: loaded.admissionUpdatedAtById,
      deletedAtById: loaded.admissionDeletedAtById,
    },
  ), true)
  assert.equal(JSON.parse(storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY) || '{}').version, 2)
  assert.equal(storage.getItem(LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY), legacyRaw)
})

test('ignores a stale v1 tab after the v2 checkpoint has been written', () => {
  const storage = new MemoryStorage()
  const current = createDefaultAgentComposerState()
  current.draft = 'v2 draft'
  current.submissions = [submission('request-v2')]
  assert.equal(saveAgentComposerCheckpoint(
    { shared: current },
    new Map([['shared', 200]]),
    new Map(),
    storage,
    200,
  ), true)

  storage.setItem(LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 1,
    savedAt: 300,
    states: {
      shared: {
        updatedAt: 300,
        draft: 'stale v1 overwrite',
        submissions: [submission('request-from-stale-v1')],
      },
    },
  }))

  const restored = loadAgentComposerCheckpoint(storage, 301).states.shared
  assert.equal(restored?.draft, 'v2 draft')
  assert.deepEqual(restored?.submissions?.map(candidate => candidate.id), ['request-v2'])
})

test('fails closed on a corrupt v2 checkpoint instead of falling back to stale v1 state', () => {
  const storage = new MemoryStorage()
  storage.setItem(LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 1,
    savedAt: 100,
    states: { legacy: { updatedAt: 100, draft: 'must not resurrect' } },
  }))
  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, '{broken')

  assert.deepEqual(loadAgentComposerCheckpoint(storage, 101).states, {})
})

test('replaces an expired v2 checkpoint with fresh state without reading stale v1', () => {
  const storage = new TrackingStorage()
  const now = 40 * 24 * 60 * 60 * 1000
  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 2,
    savedAt: 1,
    states: { expired: { updatedAt: 1, draft: 'expired v2 draft' } },
  }))
  storage.setItem(LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 1,
    savedAt: now - 1,
    states: { legacy: { updatedAt: now - 1, draft: 'stale v1 draft' } },
  }))

  storage.reads = []
  assert.deepEqual(loadAgentComposerCheckpoint(storage, now).states, {})
  assert.deepEqual(storage.reads, [AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY])

  const fresh = createDefaultAgentComposerState()
  fresh.draft = 'fresh v2 draft'
  fresh.submissions = [submission('request-after-expiry')]
  storage.reads = []
  assert.equal(saveAgentComposerCheckpoint(
    { fresh },
    new Map([['fresh', now]]),
    new Map(),
    storage,
    now,
  ), true)
  assert.deepEqual(storage.reads, [AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY])
  const restored = loadAgentComposerCheckpoint(storage, now + 1).states
  assert.equal(restored.fresh?.draft, 'fresh v2 draft')
  assert.equal(restored.fresh?.submissions?.[0]?.id, 'request-after-expiry')
  assert.equal(restored.legacy, undefined)
})

test('drops far-future record clocks and clamps fresh writes to the current clock', () => {
  const storage = new MemoryStorage()
  const now = 1_000_000
  const farFuture = now + 365 * 24 * 60 * 60 * 1000
  const poisoned = submission('request-future-clock')
  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 2,
    savedAt: now,
    states: { poisoned: { updatedAt: farFuture, draft: 'future state' } },
    tombstones: { deleted: farFuture },
    admissions: {
      [poisoned.id]: { ...poisoned, composerKey: 'poisoned', updatedAt: farFuture },
    },
    admissionTombstones: { 'request-future-delete': farFuture },
  }))

  const loaded = loadAgentComposerCheckpoint(storage, now)
  assert.deepEqual(loaded.states, {})
  assert.equal(loaded.admissions.size, 0)
  assert.equal(loaded.admissionDeletedAtById.size, 0)

  const fresh = createDefaultAgentComposerState()
  fresh.draft = 'current state'
  fresh.submissions = [submission('request-current-clock')]
  assert.equal(saveAgentComposerCheckpoint(
    { fresh },
    new Map([['fresh', farFuture]]),
    new Map(),
    storage,
    now,
  ), true)
  const persisted = JSON.parse(storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY) || '{}')
  assert.equal(persisted.savedAt, now)
  assert.equal(persisted.states.fresh.updatedAt, now)
  assert.equal(persisted.admissions['request-current-clock'].updatedAt, now)

  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 2,
    savedAt: farFuture,
    states: { poisoned: { updatedAt: farFuture, draft: 'future root' } },
  }))
  assert.equal(saveAgentComposerCheckpoint(
    { fresh },
    new Map([['fresh', now]]),
    new Map(),
    storage,
    now,
  ), true)
  assert.equal(
    JSON.parse(storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY) || '{}').savedAt,
    now,
  )
})

test('ignores corrupt, expired, and oversized checkpoints without throwing', () => {
  const storage = new MemoryStorage()
  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, '{broken')
  assert.deepEqual(loadAgentComposerCheckpoint(storage).states, {})

  const blocked = createDefaultAgentComposerState()
  blocked.draft = 'must not overwrite a corrupt v2 ledger'
  assert.equal(saveAgentComposerCheckpoint(
    { blocked },
    new Map([['blocked', 1]]),
    new Map(),
    storage,
    1,
  ), false)
  assert.equal(storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY), '{broken')

  const expiredStorage = new MemoryStorage()
  expiredStorage.setItem(LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 1,
    savedAt: 1,
    states: { stale: { updatedAt: 1, draft: 'stale' } },
  }))
  assert.deepEqual(loadAgentComposerCheckpoint(expiredStorage, 40 * 24 * 60 * 60 * 1000).states, {})

  const boundedStorage = new MemoryStorage()
  const oversized = createDefaultAgentComposerState()
  oversized.draft = 'x'.repeat(250_001)
  const valid = createDefaultAgentComposerState()
  valid.draft = 'still persists'
  assert.equal(saveAgentComposerCheckpoint(
    { oversized, valid },
    new Map([['oversized', 1], ['valid', 2]]),
    new Map(),
    boundedStorage,
    3,
  ), true)
  const restored = loadAgentComposerCheckpoint(boundedStorage, 4).states
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
  assert.equal(nextAgentComposerCheckpointTimestamp(
    'shared',
    new Map([['shared', 10_000_000]]),
    new Map(),
    200,
  ), 200, 'an anomalous far-future record must not pin the logical clock')
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

test('merges unresolved admissions by request id across tabs sharing one Composer key', () => {
  const storage = new MemoryStorage()
  const first = createDefaultAgentComposerState()
  first.submissions = [submission('request-one')]
  assert.equal(saveAgentComposerCheckpoint(
    { shared: first },
    new Map([['shared', 100]]),
    new Map(),
    storage,
    100,
  ), true)

  const second = createDefaultAgentComposerState()
  second.submissions = [submission('request-two')]
  assert.equal(saveAgentComposerCheckpoint(
    { shared: second },
    new Map([['shared', 200]]),
    new Map(),
    storage,
    200,
  ), true)

  const persisted = JSON.parse(storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY) || '{}')
  assert.equal(persisted.admissions['request-one'].status, 'submitting')
  assert.equal(persisted.admissions['request-two'].status, 'submitting')

  const restored = loadAgentComposerCheckpoint(storage, 201)
  assert.deepEqual(
    restored.states.shared?.submissions?.map(candidate => candidate.id).sort(),
    ['request-one', 'request-two'],
  )
  assert.equal(restored.states.shared?.submissions?.every(candidate => candidate.status === 'failed'), true)
})

test('keeps admission tombstones so a stale tab cannot resurrect a settled request', () => {
  const storage = new MemoryStorage()
  const admitted = submission('request-settled')
  const state = createDefaultAgentComposerState()
  state.submissions = [admitted]
  saveAgentComposerCheckpoint(
    { shared: state },
    new Map([['shared', 100]]),
    new Map(),
    storage,
    100,
    {
      admissions: new Map([['request-settled', { ...admitted, composerKey: 'shared' }]]),
      updatedAtById: new Map([['request-settled', 100]]),
      deletedAtById: new Map(),
    },
  )
  saveAgentComposerCheckpoint(
    { shared: createDefaultAgentComposerState() },
    new Map([['shared', 200]]),
    new Map(),
    storage,
    200,
    {
      admissions: new Map(),
      updatedAtById: new Map(),
      deletedAtById: new Map([['request-settled', 200]]),
    },
  )
  saveAgentComposerCheckpoint(
    { shared: state },
    new Map([['shared', 150]]),
    new Map(),
    storage,
    210,
    {
      admissions: new Map([['request-settled', { ...admitted, composerKey: 'shared' }]]),
      updatedAtById: new Map([['request-settled', 150]]),
      deletedAtById: new Map(),
    },
  )
  assert.equal(loadAgentComposerCheckpoint(storage, 211).states.shared?.submissions, undefined)

  storage.setItem(LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 1,
    savedAt: 300,
    states: {
      shared: {
        updatedAt: 300,
        submissions: [admitted],
      },
    },
  }))
  assert.equal(
    loadAgentComposerCheckpoint(storage, 301).states.shared?.submissions,
    undefined,
    'a stale v1 writer cannot bypass a v2 admission tombstone',
  )
})

test('lets an equal-timestamp admission tombstone win for the same request id', () => {
  const storage = new MemoryStorage()
  const admitted = submission('request-equal-timestamp')
  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 2,
    savedAt: 200,
    states: {},
    admissions: {
      [admitted.id]: {
        ...admitted,
        composerKey: 'shared',
        updatedAt: 200,
      },
    },
    admissionTombstones: { [admitted.id]: 200 },
  }))

  const restored = loadAgentComposerCheckpoint(storage, 201)
  assert.equal(restored.admissions.has(admitted.id), false)
  assert.equal(restored.states.shared?.submissions, undefined)
  assert.equal(restored.admissionDeletedAtById.get(admitted.id), 200)
})

test('does not promote a stale per-state v2 submission past its top-level tombstone', () => {
  const storage = new MemoryStorage()
  const stale = submission('request-stale-state', 'stale request')
  storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, JSON.stringify({
    version: 2,
    savedAt: 300,
    states: {
      shared: {
        updatedAt: 300,
        draft: 'unrelated newer draft',
        submissions: [stale],
      },
    },
    admissionTombstones: { [stale.id]: 200 },
  }))

  const restored = loadAgentComposerCheckpoint(storage, 301)
  assert.equal(restored.states.shared?.draft, 'unrelated newer draft')
  assert.equal(restored.states.shared?.submissions, undefined)
  assert.equal(restored.admissions.has(stale.id), false)

  assert.equal(saveAgentComposerCheckpoint(
    restored.states,
    restored.updatedAtByKey,
    new Map(),
    storage,
    302,
    {
      admissions: restored.admissions,
      updatedAtById: restored.admissionUpdatedAtById,
      deletedAtById: restored.admissionDeletedAtById,
    },
  ), true)
  const rewritten = JSON.parse(storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY) || '{}')
  assert.equal(rewritten.states.shared.submissions, undefined)
  assert.equal(rewritten.admissions?.[stale.id], undefined)
})

test('round-trips Unicode attachment ids and restores in-flight requests as explicit failures', () => {
  const storage = new MemoryStorage()
  const attachmentId = '附件 截图 1.png'
  const admitted = {
    ...submission('request-unicode-attachment', 'retry with attachment'),
    draftAttachmentIds: [attachmentId],
  }
  const state = createDefaultAgentComposerState()
  state.draft = admitted.editableText
  state.attachments = [{
    id: attachmentId,
    kind: 'image',
    name: '截图 1.png',
    type: 'image/png',
    size: 12,
    status: 'ready',
    path: '/tmp/截图 1.png',
  }]
  state.submissions = [admitted]

  assert.equal(saveAgentComposerCheckpoint(
    { shared: state },
    new Map([['shared', 100]]),
    new Map(),
    storage,
    100,
  ), true)
  const restored = loadAgentComposerCheckpoint(storage, 101).states.shared
  assert.deepEqual(restored?.submissions?.[0]?.draftAttachmentIds, [attachmentId])
  assert.equal(restored?.submissions?.[0]?.status, 'failed')
  assert.equal(restored?.pendingFollowUp, undefined, 'reload must not turn an ambiguous request into an auto-flush queue item')
})

test('fails closed instead of evicting an unresolved admission when capacity is exhausted', () => {
  const storage = new MemoryStorage()
  const admissions = new Map(Array.from({ length: 65 }, (_, index) => {
    const value = submission(`request-${index}`)
    return [value.id, { ...value, composerKey: `acp:session-${index}` }] as const
  }))
  assert.equal(saveAgentComposerCheckpoint(
    {},
    new Map(),
    new Map(),
    storage,
    100,
    {
      admissions,
      updatedAtById: new Map(Array.from(admissions.keys(), id => [id, 100])),
      deletedAtById: new Map(),
    },
  ), false)
  assert.equal(storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY), null)
})

test('reports a synchronous storage failure without publishing a partial checkpoint', () => {
  const state = createDefaultAgentComposerState()
  state.submissions = [submission('request-quota')]
  const storage = {
    getItem: () => null,
    setItem: () => { throw new DOMException('quota exceeded', 'QuotaExceededError') },
  }
  assert.equal(saveAgentComposerCheckpoint(
    { shared: state },
    new Map([['shared', 100]]),
    new Map(),
    storage,
    100,
  ), false)
})
