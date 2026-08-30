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
