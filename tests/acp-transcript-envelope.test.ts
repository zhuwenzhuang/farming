import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeAcpTranscript,
  projectAcpTranscriptResponse,
} from '../src/components/code/acp/acp-transcript-envelope'

function response(options: {
  agentId?: string
  runtimeEpoch?: string
  fromRevision?: number | null
  toRevision: number
  replace: boolean
  settled?: boolean
  empty?: boolean
  hasMoreBefore?: boolean
  state?: string
  stopReason?: string
  entries?: unknown[]
  label: string
}) {
  const agentId = options.agentId || 'agent-a'
  const runtimeEpoch = options.runtimeEpoch || 'epoch-a'
  return {
    version: 1,
    agentId,
    sessionId: 'session-a',
    runtimeEpoch,
    fromRevision: options.fromRevision ?? null,
    toRevision: options.toRevision,
    replace: options.replace,
    settled: options.settled ?? true,
    hasMoreBefore: options.hasMoreBefore ?? false,
    transcript: {
      sessionId: 'session-a',
      state: options.state || 'idle',
      stopReason: options.stopReason || '',
      revision: options.toRevision,
      entries: options.entries ?? (options.empty ? [] : [
        {
          id: `${options.label}-user`,
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: `${options.label} question` }],
        },
        {
          id: `${options.label}-answer`,
          type: 'message',
          role: 'assistant',
          _meta: { codex: { phase: 'final_answer' } },
          content: [{ type: 'text', text: `${options.label} answer` }],
        },
      ]),
    },
  }
}

test('accepts only a continuous ACP checkpoint and delta chain', () => {
  const checkpoint = projectAcpTranscriptResponse(response({
    toRevision: 10,
    replace: true,
    label: 'checkpoint',
  }), 'agent-a')
  const installed = mergeAcpTranscript(null, checkpoint)
  assert.equal(installed.accepted, true)
  assert.equal(installed.transcript?.revision, 10)

  const delta = projectAcpTranscriptResponse(response({
    fromRevision: 10,
    toRevision: 11,
    replace: false,
    label: 'checkpoint',
  }), 'agent-a')
  const advanced = mergeAcpTranscript(installed.transcript, delta)
  assert.equal(advanced.accepted, true)
  assert.equal(advanced.transcript?.revision, 11)

  const gap = projectAcpTranscriptResponse(response({
    fromRevision: 9,
    toRevision: 12,
    replace: false,
    label: 'gap',
  }), 'agent-a')
  const rejectedGap = mergeAcpTranscript(advanced.transcript, gap)
  assert.equal(rejectedGap.accepted, false)
  assert.equal(rejectedGap.needsCheckpoint, true)
  assert.equal(rejectedGap.transcript?.revision, 11)
})

test('appends the first Turn on an exact delta from an empty checkpoint', () => {
  const checkpoint = projectAcpTranscriptResponse(response({
    toRevision: 0,
    replace: true,
    empty: true,
    label: 'empty',
  }), 'agent-a')
  const installed = mergeAcpTranscript(null, checkpoint)
  assert.equal(installed.accepted, true)
  assert.equal(installed.transcript?.turns.length, 0)

  const firstTurn = projectAcpTranscriptResponse(response({
    fromRevision: 0,
    toRevision: 2,
    replace: false,
    label: 'first',
  }), 'agent-a')
  const advanced = mergeAcpTranscript(installed.transcript, firstTurn)
  assert.equal(advanced.accepted, true)
  assert.equal(advanced.needsCheckpoint, false)
  assert.equal(advanced.transcript?.revision, 2)
  assert.equal(advanced.transcript?.turns.length, 1)
  assert.equal(advanced.transcript?.turns[0]?.finalMessage, 'first answer')

  const emptyDelta = projectAcpTranscriptResponse(response({
    fromRevision: 2,
    toRevision: 2,
    replace: false,
    empty: true,
    hasMoreBefore: true,
    label: 'empty-delta',
  }), 'agent-a')
  const stable = mergeAcpTranscript(advanced.transcript, emptyDelta)
  assert.equal(stable.accepted, true)
  assert.equal(stable.needsCheckpoint, false)
  assert.equal(stable.transcript?.turns.length, 1)
  assert.equal(stable.transcript?.turns[0]?.finalMessage, 'first answer')
})

test('rejects stale epochs and wrong-Agent transcript responses', () => {
  const checkpoint = projectAcpTranscriptResponse(response({
    toRevision: 4,
    replace: true,
    label: 'current',
  }), 'agent-a')
  assert.throws(() => projectAcpTranscriptResponse(response({
    agentId: 'agent-b',
    toRevision: 5,
    replace: true,
    label: 'wrong-agent',
  }), 'agent-a'), /Invalid ACP transcript checkpoint/)

  const staleEpochDelta = projectAcpTranscriptResponse(response({
    runtimeEpoch: 'epoch-b',
    fromRevision: 4,
    toRevision: 5,
    replace: false,
    label: 'wrong-epoch',
  }), 'agent-a')
  const rejected = mergeAcpTranscript(checkpoint, staleEpochDelta)
  assert.equal(rejected.accepted, false)
  assert.equal(rejected.needsCheckpoint, true)
  assert.equal(rejected.transcript?.runtimeEpoch, 'epoch-a')
})

test('a bounded entry patch keeps loaded history before its covered window', () => {
  const prompt = { id: 'long-user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Long turn' }] }
  const tool = (index: number, detail = `detail-${index}`) => ({
    id: `tool-${index}`, type: 'tool', kind: 'execute', title: `Tool ${index}`,
    status: 'completed', transcriptDetail: detail,
  })
  const patched = (revision: number, entries: unknown[], order: string[], options: {
    replace?: boolean; fromRevision?: number; pageCursor?: string; nextCursor?: string | null; hasMoreBefore?: boolean,
  } = {}) => projectAcpTranscriptResponse({
    version: 1, agentId: 'agent-a', sessionId: 'session-a', runtimeEpoch: 'epoch-a',
    fromRevision: options.replace === false ? options.fromRevision : null,
    toRevision: revision, replace: options.replace !== false, settled: true,
    hasMoreBefore: options.hasMoreBefore ?? false,
    transcript: {
      sessionId: 'session-a', state: 'idle', revision, entries,
      entryPatch: { version: 1, order, pageCursor: options.pageCursor ?? null },
      nextCursor: options.nextCursor ?? null,
      hasMoreBefore: options.hasMoreBefore ?? false,
    },
  }, 'agent-a', { maxTurns: 5 })

  const latestOrder = [prompt.id, ...Array.from({ length: 256 }, (_, index) => `tool-${index + 45}`)]
  const latest = patched(1, [prompt, ...Array.from({ length: 256 }, (_, index) => tool(index + 45))], latestOrder, {
    nextCursor: 'tool-45', hasMoreBefore: true,
  })
  const olderOrder = [prompt.id, ...Array.from({ length: 44 }, (_, index) => `tool-${index + 1}`)]
  const older = patched(1, [prompt, ...Array.from({ length: 44 }, (_, index) => tool(index + 1))], olderOrder, {
    pageCursor: 'tool-45', nextCursor: null,
  })
  const loaded = mergeAcpTranscript(latest, older)
  assert.equal(loaded.transcript?.entrySnapshot?.order.length, 301)
  assert.equal(loaded.transcript?.hasMoreBefore, false)

  const changedOrder = [prompt.id, ...Array.from({ length: 257 }, (_, index) => `tool-${index + 44}`)
    .filter(id => id !== 'tool-299')]
  const delta = patched(2, [tool(300, 'corrected')], changedOrder, {
    replace: false, fromRevision: 1, nextCursor: 'tool-44', hasMoreBefore: true,
  })
  const advanced = mergeAcpTranscript(loaded.transcript, delta)
  assert.equal(advanced.needsCheckpoint, false)
  assert.equal(advanced.transcript?.entrySnapshot?.order.length, 300)
  assert.ok(advanced.transcript?.entrySnapshot?.order.includes('tool-1'))
  assert.equal(advanced.transcript?.entrySnapshot?.order.includes('tool-299'), false)
  assert.equal(advanced.transcript?.hasMoreBefore, false)
  assert.equal(advanced.transcript?.nextCursor, null)
  assert.equal(advanced.transcript?.entrySnapshot?.entries.find(entry => entry.id === 'tool-300')?.transcriptDetail, 'corrected')
})

test('continuous entry patches retain only the requested Turn window and a usable older cursor', () => {
  const response = (revision: number, fromRevision: number | null, start: number, end: number) => {
    const entries = Array.from({ length: end - start + 1 }, (_, offset) => {
      const index = start + offset
      return [
        { id: `user-${index}`, type: 'message', role: 'user', content: [{ type: 'text', text: `question-${index}` }] },
        { id: `answer-${index}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: `answer-${index}` }],
          _meta: { codex: { phase: 'final_answer' } } },
      ]
    }).flat()
    return projectAcpTranscriptResponse({
      version: 1, agentId: 'agent-a', sessionId: 'session-a', runtimeEpoch: 'epoch-a',
      fromRevision, toRevision: revision, replace: fromRevision === null, settled: true,
      hasMoreBefore: start > 1,
      transcript: {
        sessionId: 'session-a', state: 'idle', revision, entries: fromRevision === null ? entries : entries.slice(-2),
        entryPatch: { version: 1, order: entries.map(entry => entry.id), pageCursor: null },
        nextCursor: start > 1 ? `user-${start}` : null, hasMoreBefore: start > 1,
      },
    }, 'agent-a', { maxTurns: 5 })
  }
  let current = response(5, null, 1, 5)
  for (let revision = 6; revision <= 100; revision += 1) {
    const result = mergeAcpTranscript(current, response(revision, revision - 1, revision - 4, revision))
    assert.equal(result.needsCheckpoint, false)
    current = result.transcript!
    assert.equal(current.entrySnapshot?.order.length, 10)
    assert.equal(current.turns.length, 5)
    assert.equal(current.nextCursor, `user-${revision - 4}`)
    assert.equal(current.hasMoreBefore, true)
  }
})

test('rebuilds the missing-final-reply status from a refreshed transcript projection', () => {
  const processOnlyEntries = [
    {
      id: 'refresh-user',
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: 'Inspect recovery' }],
    },
    {
      id: 'refresh-tool',
      type: 'tool',
      title: 'Inspect runtime',
      kind: 'execute',
      status: 'completed',
    },
  ]
  const interrupted = projectAcpTranscriptResponse(response({
    toRevision: 20,
    replace: true,
    stopReason: 'error',
    entries: processOnlyEntries,
    label: 'refresh',
  }), 'agent-a')
  assert.equal(interrupted.turns[0]?.status, 'interrupted')

  const recovered = projectAcpTranscriptResponse(response({
    toRevision: 21,
    replace: true,
    entries: processOnlyEntries,
    label: 'refresh',
  }), 'agent-a')
  const refreshed = mergeAcpTranscript(interrupted, recovered)

  assert.equal(refreshed.accepted, true)
  assert.equal(refreshed.transcript?.turns[0]?.status, 'missingFinalReply')
})

test('applies an authoritative correction inside a completed Turn', () => {
  const correctedEntries = (detail: string) => [
    {
      id: 'corrected-user',
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: 'Inspect the result' }],
    },
    {
      id: 'corrected-tool',
      type: 'tool',
      title: 'Inspect result',
      status: 'completed',
      transcriptDetail: detail,
    },
    {
      id: 'stable-tool',
      type: 'tool',
      title: 'Verify result',
      status: 'completed',
      transcriptDetail: 'stable detail',
    },
    {
      id: 'corrected-answer',
      type: 'message',
      role: 'assistant',
      _meta: { codex: { phase: 'final_answer' } },
      content: [{ type: 'text', text: 'Done' }],
    },
  ]
  const original = projectAcpTranscriptResponse(response({
    toRevision: 30,
    replace: true,
    entries: correctedEntries('stale detail'),
    label: 'corrected',
  }), 'agent-a')
  const corrected = projectAcpTranscriptResponse(response({
    toRevision: 31,
    replace: true,
    entries: correctedEntries('authoritative detail'),
    label: 'corrected',
  }), 'agent-a')
  const refreshed = mergeAcpTranscript(original, corrected)

  assert.equal(refreshed.accepted, true)
  assert.equal(refreshed.transcript?.turns[0]?.processItems[0]?.detail, 'authoritative detail')
  assert.notStrictEqual(refreshed.transcript?.turns[0], original.turns[0])

  const unchanged = projectAcpTranscriptResponse(response({
    toRevision: 32,
    replace: true,
    entries: correctedEntries('authoritative detail'),
    label: 'corrected',
  }), 'agent-a')
  const stable = mergeAcpTranscript(refreshed.transcript, unchanged)
  assert.strictEqual(stable.transcript?.turns[0], refreshed.transcript?.turns[0])
})

for (const legacy of [false, true]) {
  test(`delta prefix omission does not reopen exhausted history (${legacy ? 'legacy' : 'versioned'})`, () => {
    const project = (options: Parameters<typeof response>[0], maxTurns = 3) => {
      const projected = projectAcpTranscriptResponse(response(options), 'agent-a', { maxTurns })
      if (legacy) {
        delete projected.envelopeVersion
        projected.delta = !options.replace
        projected.replaceFromTurnId = projected.turns[0]?.id
      }
      return projected
    }
    const first = project({ toRevision: 1, replace: true, label: 'first' })
    const second = project({ fromRevision: 1, toRevision: 2, replace: false, label: 'second', hasMoreBefore: true })
    const appended = mergeAcpTranscript(first, second).transcript!
    assert.equal(appended.turns.length, 2)
    assert.equal(appended.hasMoreBefore, false, 'the omitted prefix is already loaded')
    const updated = mergeAcpTranscript(appended, project({
      fromRevision: 2, toRevision: 3, replace: false, label: 'second', hasMoreBefore: true,
    })).transcript!
    assert.equal(updated.hasMoreBefore, false, 'updating the last Turn cannot invent older history')
    const bounded = { ...updated, turnLimit: 2 }
    const evicted = mergeAcpTranscript(bounded, project({
      fromRevision: 3, toRevision: 4, replace: false, label: 'third', hasMoreBefore: true,
    }, 2)).transcript!
    assert.equal(evicted.turns.length, 2)
    assert.equal(evicted.hasMoreBefore, true, 'eviction really does make older history unavailable')
    const partial = { ...updated, hasMoreBefore: true }
    assert.equal(mergeAcpTranscript(partial, project({
      fromRevision: 3, toRevision: 4, replace: false, label: 'second', hasMoreBefore: false,
    })).transcript?.hasMoreBefore, true, 'a delta cannot declare an unseen prefix loaded')
  })
}
