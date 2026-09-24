import assert from 'node:assert/strict'
import test from 'node:test'
import { ACP_TRANSCRIPT_FETCH_RETRY_DELAYS_MS, ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH } from '../src/lib/transcript-fetch-policy'
import {
  ACP_TRANSCRIPT_READ_TIMEOUT_MS,
  attachAcpTranscriptSession,
  getAcpTranscriptSessionSnapshot,
  observeAcpTranscriptRevision,
  refreshAcpTranscriptSession,
  reconnectAcpTranscriptSessions,
  resetAcpTranscriptSessionPoolForTests,
  retainAcpTranscriptSessions,
  setAcpTranscriptTurnLimit,
} from '../src/components/code/acp/acp-transcript-session-pool'

function envelope(
  agentId: string,
  revision: number,
  options: {
    fromRevision?: number
    answer?: string
    runtimeEpoch?: string
    sessionId?: string
    state?: string
  } = {},
) {
  const replace = options.fromRevision === undefined
  const sessionId = options.sessionId ?? `session-${agentId}`
  const runtimeEpoch = options.runtimeEpoch ?? `epoch-${agentId}`
  return {
    version: 1,
    agentId,
    sessionId,
    runtimeEpoch,
    fromRevision: replace ? null : options.fromRevision,
    toRevision: revision,
    replace,
    settled: true,
    hasMoreBefore: false,
    transcript: {
      sessionId,
      revision,
      state: options.state ?? 'idle',
      updatedAt: `2026-08-19T00:00:0${revision}.000Z`,
      entries: [
        { id: 'user-1', type: 'message', role: 'user', content: [{ type: 'text', text: 'question' }] },
        {
          id: `answer-${revision}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: options.answer ?? `answer-${revision}` }],
          _meta: { codex: { phase: 'final_answer' } },
        },
      ],
    },
  }
}

function pagedEnvelope(
  agentId: string,
  turns: number[],
  options: { pageCursor?: string; nextCursor: string | null; hasMoreBefore: boolean; state?: string; revision?: number },
) {
  const entries = turns.flatMap(turn => [
    { id: `user-${turn}`, type: 'message', role: 'user', content: [{ type: 'text', text: `question-${turn}` }] },
    {
      id: `answer-${turn}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: `answer-${turn}` }],
      _meta: { codex: { phase: 'final_answer' } },
    },
  ])
  const sessionId = `session-${agentId}`
  return {
    version: 1,
    agentId,
    sessionId,
    runtimeEpoch: `epoch-${agentId}`,
    fromRevision: null,
    toRevision: options.revision ?? 1,
    replace: true,
    settled: true,
    hasMoreBefore: options.hasMoreBefore,
    transcript: {
      sessionId,
      revision: options.revision ?? 1,
      state: options.state ?? 'idle',
      updatedAt: '2026-08-19T00:00:01.000Z',
      entries,
      entryPatch: {
        version: 1,
        order: entries.map(entry => entry.id),
        pageCursor: options.pageCursor ?? null,
      },
      nextCursor: options.nextCursor,
      hasMoreBefore: options.hasMoreBefore,
    },
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for Transcript pool state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('retained ACP Transcript continues merging revisions after its Pane detaches', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    return jsonResponse(url.includes('sinceRevision=1')
      ? envelope('agent-a', 2, { fromRevision: 1 })
      : envelope('agent-a', 1))
  }
  try {
    retainAcpTranscriptSessions(['agent-a'])
    const release = attachAcpTranscriptSession('agent-a')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-a').transcript?.revision === 1)
    release()

    observeAcpTranscriptRevision({
      agentId: 'agent-a',
      sessionId: 'session-agent-a',
      runtimeEpoch: 'epoch-agent-a',
      revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
    })
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-a').transcript?.revision === 2)

    assert.equal(getAcpTranscriptSessionSnapshot('agent-a').transcript?.turns[0]?.finalMessage, 'answer-2')
    assert.equal(urls.filter(url => url.includes('sinceRevision=1')).length, 1)
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('reattach reuses a current retained Transcript without another read', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async input => {
    urls.push(String(input))
    return jsonResponse(envelope('agent-e', 1))
  }
  try {
    retainAcpTranscriptSessions(['agent-e'])
    const firstRelease = attachAcpTranscriptSession('agent-e')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-e').transcript?.revision === 1)
    firstRelease()

    const secondRelease = attachAcpTranscriptSession('agent-e')
    assert.equal(getAcpTranscriptSessionSnapshot('agent-e').loading, false)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-e').transcript?.revision, 1)
    assert.equal(urls.length, 1)
    secondRelease()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('reattach revalidates an unfinished retained Turn after a missed completion revision', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async input => {
    urls.push(String(input))
    return jsonResponse(envelope('agent-missed-completion', urls.length === 1 ? 1 : 2, {
      fromRevision: urls.length === 1 ? undefined : 1,
      state: urls.length === 1 ? 'working' : 'idle',
    }))
  }
  try {
    retainAcpTranscriptSessions(['agent-missed-completion'])
    const firstRelease = attachAcpTranscriptSession('agent-missed-completion')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-missed-completion').transcript?.turns[0]?.status === 'inProgress')
    firstRelease()

    const secondRelease = attachAcpTranscriptSession('agent-missed-completion')
    assert.equal(getAcpTranscriptSessionSnapshot('agent-missed-completion').loading, false)
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-missed-completion').transcript?.turns[0]?.status === 'completed')
    assert.equal(urls.length, 2)
    assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('sinceRevision'), '1')
    secondRelease()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('an exhausted recovery checkpoint exposes a transport error and can reconnect', async () => {
  const previousFetch = globalThis.fetch
  let attempts = 0
  let releaseFirstFailure!: () => void
  const firstFailureGate = new Promise<void>(resolve => { releaseFirstFailure = resolve })
  globalThis.fetch = async () => {
    attempts += 1
    if (attempts === 1) await firstFailureGate
    if (attempts <= 3) throw new TypeError('Failed to fetch')
    return jsonResponse(envelope('agent-recovery', 1))
  }
  try {
    retainAcpTranscriptSessions(['agent-recovery'])
    const release = attachAcpTranscriptSession('agent-recovery')
    observeAcpTranscriptRevision({
      agentId: 'agent-recovery',
      sessionId: 'session-agent-recovery',
      runtimeEpoch: 'epoch-agent-recovery',
      revision: 1,
      updatedAt: '2026-08-19T00:00:01.000Z',
    })
    releaseFirstFailure()
    await waitFor(() => attempts === 3, 2_500)
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-recovery').error === 'transport')

    assert.equal(getAcpTranscriptSessionSnapshot('agent-recovery').loading, false)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-recovery').transcript, null)

    reconnectAcpTranscriptSessions()
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-recovery').transcript?.revision === 1)
    assert.equal(attempts, 4)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-recovery').error, null)
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('reconnect discards an in-flight delta from the previous runtime epoch', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  let releaseOldDelta!: () => void
  const oldDeltaGate = new Promise<void>(resolve => { releaseOldDelta = resolve })
  globalThis.fetch = async input => {
    urls.push(String(input))
    if (urls.length === 1) return jsonResponse(envelope('agent-reconnect-epoch', 1, {
      sessionId: 'session-old', runtimeEpoch: 'epoch-old',
    }))
    if (urls.length === 2) {
      await oldDeltaGate
      return jsonResponse(envelope('agent-reconnect-epoch', 2, {
        fromRevision: 1, sessionId: 'session-old', runtimeEpoch: 'epoch-old',
      }))
    }
    return jsonResponse(envelope('agent-reconnect-epoch', 1, {
      sessionId: 'session-new', runtimeEpoch: 'epoch-new',
    }))
  }
  try {
    retainAcpTranscriptSessions(['agent-reconnect-epoch'])
    const release = attachAcpTranscriptSession('agent-reconnect-epoch')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-reconnect-epoch').transcript?.runtimeEpoch === 'epoch-old')
    observeAcpTranscriptRevision({
      agentId: 'agent-reconnect-epoch', sessionId: 'session-old',
      runtimeEpoch: 'epoch-old', revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
    })
    await waitFor(() => urls.length === 2)
    reconnectAcpTranscriptSessions()
    releaseOldDelta()
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-reconnect-epoch').transcript?.runtimeEpoch === 'epoch-new')
    assert.equal(urls.length, 3)
    assert.doesNotMatch(urls[2] ?? '', /sinceRevision=|cursor=/)
    release()
  } finally {
    releaseOldDelta()
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('an explicit retry clears a terminal read error and starts a fresh checkpoint', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    if (urls.length === 1) return new Response('unavailable', { status: 503 })
    return jsonResponse(envelope('agent-manual-retry', 1))
  }
  try {
    retainAcpTranscriptSessions(['agent-manual-retry'])
    const release = attachAcpTranscriptSession('agent-manual-retry')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-manual-retry').error === 'response')

    refreshAcpTranscriptSession('agent-manual-retry', true)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-manual-retry').loading, true)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-manual-retry').error, null)
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-manual-retry').transcript?.revision === 1)

    assert.equal(urls.length, 2)
    assert.doesNotMatch(urls[1] ?? '', /sinceRevision=/)
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('a failed live delta stops retrying and exposes stale running content', async () => {
  const previousFetch = globalThis.fetch
  let reads = 0
  globalThis.fetch = async () => {
    reads += 1
    return reads === 1
      ? jsonResponse(envelope('agent-delta-failed', 1, { state: 'working' }))
      : new Response('Unavailable', { status: 503 })
  }
  try {
    retainAcpTranscriptSessions(['agent-delta-failed'])
    const release = attachAcpTranscriptSession('agent-delta-failed')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-delta-failed').transcript?.revision === 1)
    observeAcpTranscriptRevision({
      agentId: 'agent-delta-failed', sessionId: 'session-agent-delta-failed',
      runtimeEpoch: 'epoch-agent-delta-failed', revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
    })
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-delta-failed').error === 'response')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(reads, 2)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-delta-failed').transcript?.turns[0]?.status, 'inProgress')
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('revision bursts keep one request in flight and collapse to the latest high-water', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  let releaseCheckpoint!: () => void
  const checkpointGate = new Promise<void>(resolve => { releaseCheckpoint = resolve })
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    if (urls.length === 1) {
      await checkpointGate
      return jsonResponse(envelope('agent-b', 1))
    }
    return jsonResponse(envelope('agent-b', 3, { fromRevision: 1 }))
  }
  try {
    retainAcpTranscriptSessions(['agent-b'])
    const release = attachAcpTranscriptSession('agent-b')
    await waitFor(() => urls.length === 1)
    observeAcpTranscriptRevision({
      agentId: 'agent-b',
      sessionId: 'session-agent-b',
      runtimeEpoch: 'epoch-agent-b',
      revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
    })
    observeAcpTranscriptRevision({
      agentId: 'agent-b',
      sessionId: 'session-agent-b',
      runtimeEpoch: 'epoch-agent-b',
      revision: 3,
      updatedAt: '2026-08-19T00:00:03.000Z',
    })
    assert.equal(urls.length, 1)
    releaseCheckpoint()
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-b').transcript?.revision === 3)

    assert.equal(urls.length, 2)
    assert.match(urls[1] ?? '', /sinceRevision=1/)
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('loading older ACP history prepends a fixed page without replacing the latest turns', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    return jsonResponse(urls.length === 1
      ? pagedEnvelope('agent-history', [16, 17, 18, 19, 20], {
          nextCursor: 'user-16',
          hasMoreBefore: true,
        })
      : pagedEnvelope('agent-history', [6, 7, 8, 9, 10, 11, 12, 13, 14, 15], {
          pageCursor: 'user-16',
          nextCursor: 'user-6',
          hasMoreBefore: true,
        }))
  }
  try {
    retainAcpTranscriptSessions(['agent-history'])
    const release = attachAcpTranscriptSession('agent-history')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history').transcript?.turns.length === 5)

    setAcpTranscriptTurnLimit('agent-history', 15)
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history').transcript?.turns.length === 15)

    const snapshot = getAcpTranscriptSessionSnapshot('agent-history')
    assert.match(urls[0] ?? '', /maxTurns=5/)
    assert.match(urls[1] ?? '', /maxTurns=10/)
    assert.match(urls[1] ?? '', /cursor=user-16/)
    assert.equal(snapshot.transcript?.turns[0]?.finalMessage, 'answer-6')
    assert.equal(snapshot.transcript?.turns.at(-1)?.finalMessage, 'answer-20')
    assert.equal(snapshot.transcript?.nextCursor, 'user-6')
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('a completed Turn updates live after loading an older history page', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    if (urls.length === 1) {
      return jsonResponse(pagedEnvelope('agent-history-live', [1], {
        nextCursor: 'user-1', hasMoreBefore: true, state: 'working',
      }))
    }
    if (urls.length === 2) {
      return jsonResponse(pagedEnvelope('agent-history-live', [0], {
        pageCursor: 'user-1', nextCursor: null, hasMoreBefore: false, state: 'working',
      }))
    }
    return jsonResponse(envelope('agent-history-live', 2, { fromRevision: 1 }))
  }
  try {
    retainAcpTranscriptSessions(['agent-history-live'])
    const release = attachAcpTranscriptSession('agent-history-live')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history-live').transcript?.turns[0]?.status === 'inProgress')
    setAcpTranscriptTurnLimit('agent-history-live', 15)
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history-live').transcript?.turns.length === 2)

    observeAcpTranscriptRevision({
      agentId: 'agent-history-live',
      sessionId: 'session-agent-history-live',
      runtimeEpoch: 'epoch-agent-history-live',
      revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
    })
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history-live').transcript?.revision === 2)
    const transcript = getAcpTranscriptSessionSnapshot('agent-history-live').transcript
    assert.equal(transcript?.state, 'idle')
    assert.equal(transcript?.turns[transcript.turns.length - 1]?.status, 'completed')
    assert.equal(urls.length, 3)
    assert.match(urls[2] ?? '', /sinceRevision=1/)
    assert.doesNotMatch(urls[2] ?? '', /cursor=/)
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('an older page at a newer revision still fetches the latest completed Turn', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async input => {
    urls.push(String(input))
    if (urls.length === 1) {
      return jsonResponse(pagedEnvelope('agent-history-newer', [1], {
        nextCursor: 'user-1', hasMoreBefore: true, state: 'working',
      }))
    }
    if (urls.length === 2) {
      return jsonResponse(pagedEnvelope('agent-history-newer', [0], {
        pageCursor: 'user-1', nextCursor: null, hasMoreBefore: false,
        state: 'working', revision: 2,
      }))
    }
    return jsonResponse(envelope('agent-history-newer', 2, { fromRevision: 1 }))
  }
  try {
    retainAcpTranscriptSessions(['agent-history-newer'])
    const release = attachAcpTranscriptSession('agent-history-newer')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history-newer').transcript?.turns[0]?.status === 'inProgress')
    setAcpTranscriptTurnLimit('agent-history-newer', 15)
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history-newer').transcript?.revision === 2)
    const transcript = getAcpTranscriptSessionSnapshot('agent-history-newer').transcript
    assert.equal(transcript?.state, 'idle')
    assert.equal(transcript?.turns[transcript.turns.length - 1]?.status, 'completed')
    assert.equal(urls.length, 3)
    assert.match(urls[2] ?? '', /sinceRevision=1/)
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('a completion revision received during an older page read resumes live updates', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  let releaseOlderPage!: () => void
  const olderPageGate = new Promise<void>(resolve => { releaseOlderPage = resolve })
  globalThis.fetch = async input => {
    urls.push(String(input))
    if (urls.length === 1) {
      return jsonResponse(pagedEnvelope('agent-history-race', [1], {
        nextCursor: 'user-1', hasMoreBefore: true, state: 'working',
      }))
    }
    if (urls.length === 2) {
      await olderPageGate
      return jsonResponse(pagedEnvelope('agent-history-race', [0], {
        pageCursor: 'user-1', nextCursor: null, hasMoreBefore: false, state: 'working',
      }))
    }
    return jsonResponse(envelope('agent-history-race', 2, { fromRevision: 1 }))
  }
  try {
    retainAcpTranscriptSessions(['agent-history-race'])
    const release = attachAcpTranscriptSession('agent-history-race')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history-race').transcript?.turns[0]?.status === 'inProgress')
    setAcpTranscriptTurnLimit('agent-history-race', 15)
    await waitFor(() => urls.length === 2)
    observeAcpTranscriptRevision({
      agentId: 'agent-history-race',
      sessionId: 'session-agent-history-race',
      runtimeEpoch: 'epoch-agent-history-race',
      revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
    })
    releaseOlderPage()
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history-race').transcript?.revision === 2)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-history-race').transcript?.state, 'idle')
    assert.equal(urls.length, 3)
    assert.match(urls[2] ?? '', /sinceRevision=1/)
    release()
  } finally {
    releaseOlderPage()
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('a failed older page read does not block an already observed completion', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  let releaseOlderPage!: () => void
  const olderPageGate = new Promise<void>(resolve => { releaseOlderPage = resolve })
  globalThis.fetch = async input => {
    urls.push(String(input))
    if (urls.length === 1) {
      return jsonResponse(pagedEnvelope('agent-history-failed', [1], {
        nextCursor: 'user-1', hasMoreBefore: true, state: 'working',
      }))
    }
    if (urls.length === 2) {
      await olderPageGate
      return new Response('Older page unavailable', { status: 503 })
    }
    return jsonResponse(envelope('agent-history-failed', 2))
  }
  try {
    retainAcpTranscriptSessions(['agent-history-failed'])
    const release = attachAcpTranscriptSession('agent-history-failed')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history-failed').transcript?.turns[0]?.status === 'inProgress')
    setAcpTranscriptTurnLimit('agent-history-failed', 15)
    await waitFor(() => urls.length === 2)
    observeAcpTranscriptRevision({
      agentId: 'agent-history-failed',
      sessionId: 'session-agent-history-failed',
      runtimeEpoch: 'epoch-agent-history-failed',
      revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
    })
    releaseOlderPage()
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-history-failed').transcript?.revision === 2)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-history-failed').transcript?.state, 'idle')
    assert.equal(urls.length, 3)
    assert.doesNotMatch(urls[2] ?? '', /cursor=|sinceRevision=/)
    release()
  } finally {
    releaseOlderPage()
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('reattach shows a retained Transcript while its background delta finishes', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  let releaseBackgroundDelta!: () => void
  const backgroundDeltaGate = new Promise<void>(resolve => { releaseBackgroundDelta = resolve })
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    if (urls.length === 1) return jsonResponse(envelope('agent-f', 1))
    await backgroundDeltaGate
    return jsonResponse(envelope('agent-f', 2, { fromRevision: 1 }))
  }
  try {
    retainAcpTranscriptSessions(['agent-f'])
    const firstRelease = attachAcpTranscriptSession('agent-f')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-f').transcript?.revision === 1)
    firstRelease()
    observeAcpTranscriptRevision({
      agentId: 'agent-f',
      sessionId: 'session-agent-f',
      runtimeEpoch: 'epoch-agent-f',
      revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
    })
    await waitFor(() => urls.length === 2)

    const secondRelease = attachAcpTranscriptSession('agent-f')
    assert.equal(getAcpTranscriptSessionSnapshot('agent-f').loading, false)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-f').transcript?.revision, 1)
    releaseBackgroundDelta()
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-f').transcript?.revision === 2)
    assert.equal(urls.length, 2)
    assert.match(urls[1] ?? '', /sinceRevision=1/)
    secondRelease()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('eviction aborts only the evicted browser Transcript read', async () => {
  const previousFetch = globalThis.fetch
  const aborted = new Set<string>()
  globalThis.fetch = async (input, init) => new Promise<Response>((_resolve, reject) => {
    const agentId = String(input).includes('agent-c') ? 'agent-c' : 'agent-d'
    init?.signal?.addEventListener('abort', () => {
      aborted.add(agentId)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
  try {
    retainAcpTranscriptSessions(['agent-c', 'agent-d'])
    const releaseC = attachAcpTranscriptSession('agent-c')
    const releaseD = attachAcpTranscriptSession('agent-d')
    releaseC()
    retainAcpTranscriptSessions(['agent-d'])
    await waitFor(() => aborted.has('agent-c'))

    assert.equal(aborted.has('agent-d'), false)
    releaseD()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('a retained ACP Transcript checkpoints a replacement Session even when its revision is lower', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    return jsonResponse(urls.length === 1
      ? envelope('agent-g', 8, { sessionId: 'session-old', runtimeEpoch: 'epoch-old' })
      : envelope('agent-g', 1, { sessionId: 'session-new', runtimeEpoch: 'epoch-new' }))
  }
  try {
    retainAcpTranscriptSessions(['agent-g'])
    const release = attachAcpTranscriptSession('agent-g')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-g').transcript?.revision === 8)
    release()

    observeAcpTranscriptRevision({
      agentId: 'agent-g',
      sessionId: 'session-new',
      runtimeEpoch: 'epoch-new',
      revision: 1,
      updatedAt: '2026-08-19T00:00:09.000Z',
    })
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-g').transcript?.sessionId === 'session-new')

    assert.equal(urls.length, 2)
    assert.doesNotMatch(urls[1] ?? '', /sinceRevision=/)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-g').transcript?.runtimeEpoch, 'epoch-new')
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('a late delta from the previous identity cannot replace the observed Session', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  let releaseOldDelta!: () => void
  let releaseNewCheckpoint!: () => void
  const oldDeltaGate = new Promise<void>(resolve => { releaseOldDelta = resolve })
  const newCheckpointGate = new Promise<void>(resolve => { releaseNewCheckpoint = resolve })
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    if (urls.length === 1) {
      return jsonResponse(envelope('agent-h', 1, {
        sessionId: 'session-old',
        runtimeEpoch: 'epoch-old',
      }))
    }
    if (urls.length === 2) {
      await oldDeltaGate
      return jsonResponse(envelope('agent-h', 2, {
        fromRevision: 1,
        sessionId: 'session-old',
        runtimeEpoch: 'epoch-old',
      }))
    }
    await newCheckpointGate
    return jsonResponse(envelope('agent-h', 1, {
      sessionId: 'session-new',
      runtimeEpoch: 'epoch-new',
    }))
  }
  try {
    retainAcpTranscriptSessions(['agent-h'])
    const release = attachAcpTranscriptSession('agent-h')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-h').transcript?.revision === 1)
    release()
    observeAcpTranscriptRevision({
      agentId: 'agent-h',
      sessionId: 'session-old',
      runtimeEpoch: 'epoch-old',
      revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
    })
    await waitFor(() => urls.length === 2)
    observeAcpTranscriptRevision({
      agentId: 'agent-h',
      sessionId: 'session-new',
      runtimeEpoch: 'epoch-new',
      revision: 1,
      updatedAt: '2026-08-19T00:00:03.000Z',
    })
    releaseOldDelta()
    await waitFor(() => urls.length === 3)

    assert.equal(getAcpTranscriptSessionSnapshot('agent-h').transcript, null)
    assert.equal(getAcpTranscriptSessionSnapshot('agent-h').loading, true)
    assert.doesNotMatch(urls[2] ?? '', /sinceRevision=/)

    releaseNewCheckpoint()
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-h').transcript?.sessionId === 'session-new')
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

test('a replacement Session returning 202 fails closed after bounded checkpoint retries', async () => {
  const previousFetch = globalThis.fetch
  const previousSetTimeout = globalThis.setTimeout
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) {
      return jsonResponse(envelope('agent-202-replacement', 8, {
        answer: 'OLD SECRET HISTORY',
        sessionId: 'session-old',
        runtimeEpoch: 'epoch-old',
      }))
    }
    return new Response(null, { status: 202 })
  }
  try {
    retainAcpTranscriptSessions(['agent-202-replacement'])
    const release = attachAcpTranscriptSession('agent-202-replacement')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-202-replacement').transcript?.revision === 8)
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
      previousSetTimeout(handler, Math.min(Number(timeout) || 0, 1), ...args)
    )) as typeof setTimeout

    observeAcpTranscriptRevision({
      agentId: 'agent-202-replacement',
      sessionId: 'session-new',
      runtimeEpoch: 'epoch-new',
      revision: 1,
      updatedAt: '2026-08-19T00:00:09.000Z',
    })
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-202-replacement').error === 'response')

    const snapshot = getAcpTranscriptSessionSnapshot('agent-202-replacement')
    assert.equal(snapshot.loading, false)
    assert.equal(snapshot.transcript, null)
    assert.equal(calls, ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH + 2)
    await new Promise(resolve => previousSetTimeout(resolve, 25))
    assert.equal(calls, ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH + 2)
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
    globalThis.setTimeout = previousSetTimeout
  }
})

test('a replacement Session rejects repeated stale checkpoints with a bounded terminal error', async () => {
  const previousFetch = globalThis.fetch
  const previousSetTimeout = globalThis.setTimeout
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return jsonResponse(envelope('agent-stale-checkpoint', 8, {
      answer: 'OLD SECRET HISTORY',
      sessionId: 'session-old',
      runtimeEpoch: 'epoch-old',
    }))
  }
  try {
    retainAcpTranscriptSessions(['agent-stale-checkpoint'])
    const release = attachAcpTranscriptSession('agent-stale-checkpoint')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-stale-checkpoint').transcript?.revision === 8)
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
      previousSetTimeout(handler, Math.min(Number(timeout) || 0, 1), ...args)
    )) as typeof setTimeout

    observeAcpTranscriptRevision({
      agentId: 'agent-stale-checkpoint',
      sessionId: 'session-new',
      runtimeEpoch: 'epoch-new',
      revision: 1,
      updatedAt: '2026-08-19T00:00:09.000Z',
    })
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-stale-checkpoint').error === 'response')

    const snapshot = getAcpTranscriptSessionSnapshot('agent-stale-checkpoint')
    assert.equal(snapshot.loading, false)
    assert.equal(snapshot.transcript, null)
    assert.equal(calls, ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH + 2)
    await new Promise(resolve => previousSetTimeout(resolve, 25))
    assert.equal(calls, ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH + 2)
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
    globalThis.setTimeout = previousSetTimeout
  }
})

test('a repeated delta gap stops retrying and exposes a retryable terminal error', async () => {
  const previousFetch = globalThis.fetch
  const previousSetTimeout = globalThis.setTimeout
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) return jsonResponse(envelope('agent-gap', 1))
    return jsonResponse(envelope('agent-gap', 3, { fromRevision: 2 }))
  }
  try {
    retainAcpTranscriptSessions(['agent-gap'])
    const release = attachAcpTranscriptSession('agent-gap')
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-gap').transcript?.revision === 1)
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
      previousSetTimeout(handler, Math.min(Number(timeout) || 0, 1), ...args)
    )) as typeof setTimeout

    observeAcpTranscriptRevision({
      agentId: 'agent-gap',
      sessionId: 'session-agent-gap',
      runtimeEpoch: 'epoch-agent-gap',
      revision: 3,
      updatedAt: '2026-08-19T00:00:03.000Z',
    })
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-gap').error === 'response')

    const snapshot = getAcpTranscriptSessionSnapshot('agent-gap')
    assert.equal(snapshot.loading, false)
    assert.equal(snapshot.transcript?.revision, 1)
    assert.equal(calls, ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH + 2)
    await new Promise(resolve => previousSetTimeout(resolve, 25))
    assert.equal(calls, ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH + 2)
    release()
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
    globalThis.setTimeout = previousSetTimeout
  }
})


test('hung transcript reads expire and release foreground capacity', async context => {
  const previousFetch = globalThis.fetch
  const requests: string[] = []
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = (input, options) => {
    requests.push(String(input))
    return new Promise<Response>((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  }
  try {
    for (const id of ['hung-a', 'hung-b', 'hung-c', 'foreground']) {
      attachAcpTranscriptSession(id)
    }
    assert.equal(requests.length, 3)
    context.mock.timers.tick(ACP_TRANSCRIPT_READ_TIMEOUT_MS)
    for (let iteration = 0; iteration < 20; iteration++) await Promise.resolve()
    assert.equal(getAcpTranscriptSessionSnapshot('hung-a').error, null)
    assert(requests.some(url => url.includes('foreground')), 'expired reads must release their slots before retrying')
    context.mock.timers.tick(ACP_TRANSCRIPT_FETCH_RETRY_DELAYS_MS[0])
    for (let iteration = 0; iteration < 20; iteration++) await Promise.resolve()
    assert.equal(requests.filter(url => url.includes('hung-a')).length, 2)
    context.mock.timers.tick(ACP_TRANSCRIPT_READ_TIMEOUT_MS)
    for (let iteration = 0; iteration < 20; iteration++) await Promise.resolve()
    assert.equal(getAcpTranscriptSessionSnapshot('hung-a').error, 'transport')
    assert.equal(getAcpTranscriptSessionSnapshot('hung-a').loading, false)
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    for (let iteration = 0; iteration < 20; iteration++) await Promise.resolve()
    globalThis.fetch = previousFetch
    context.mock.timers.reset()
  }
})

for (const withNewRevision of [false, true]) {
  test(`older-page failure terminates even when latest read also fails (new revision: ${withNewRevision})`, async () => {
    const previousFetch = globalThis.fetch
    const urls: string[] = []
    let releasePage!: () => void
    const gate = new Promise<void>(resolve => { releasePage = resolve })
    globalThis.fetch = async input => {
      urls.push(String(input))
      if (urls.length === 1) return jsonResponse(pagedEnvelope('finite-history', [1], {
        nextCursor: 'user-1', hasMoreBefore: true, state: 'working',
      }))
      if (urls.length === 2) await gate
      return new Response('Unavailable', { status: 503 })
    }
    try {
      const release = attachAcpTranscriptSession('finite-history')
      await waitFor(() => getAcpTranscriptSessionSnapshot('finite-history').transcript !== null)
      setAcpTranscriptTurnLimit('finite-history', 15)
      await waitFor(() => urls.length === 2)
      if (withNewRevision) observeAcpTranscriptRevision({
        agentId: 'finite-history', sessionId: 'session-finite-history', runtimeEpoch: 'epoch-finite-history',
        revision: 2, updatedAt: '',
      })
      releasePage()
      await waitFor(() => getAcpTranscriptSessionSnapshot('finite-history').error === 'response')
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(urls.length, withNewRevision ? 3 : 2)
      assert.equal(getAcpTranscriptSessionSnapshot('finite-history').loading, false)
      assert.equal(getAcpTranscriptSessionSnapshot('finite-history').loadingOlder, false)
      release()
    } finally {
      releasePage()
      resetAcpTranscriptSessionPoolForTests()
      globalThis.fetch = previousFetch
    }
  })
}

test('a live response cannot erase a newer historical navigation request', async () => {
  const previousFetch = globalThis.fetch
  const urls: string[] = []
  let releaseDelta!: () => void
  const gate = new Promise<void>(resolve => { releaseDelta = resolve })
  globalThis.fetch = async input => {
    urls.push(String(input))
    if (urls.length === 1) return jsonResponse(pagedEnvelope('navigation', [1], {
      nextCursor: 'user-1', hasMoreBefore: true,
    }))
    if (urls.length === 2) {
      await gate
      return jsonResponse(envelope('navigation', 2, { fromRevision: 1 }))
    }
    return jsonResponse(pagedEnvelope('navigation', [0], {
      pageCursor: 'user-1', nextCursor: null, hasMoreBefore: false,
    }))
  }
  try {
    const release = attachAcpTranscriptSession('navigation')
    await waitFor(() => getAcpTranscriptSessionSnapshot('navigation').transcript !== null)
    refreshAcpTranscriptSession('navigation')
    await waitFor(() => urls.length === 2)
    setAcpTranscriptTurnLimit('navigation', 15)
    releaseDelta()
    await waitFor(() => getAcpTranscriptSessionSnapshot('navigation').transcript?.turns.length === 2)
    assert.match(urls[2]!, /cursor=user-1/)
    assert.equal(getAcpTranscriptSessionSnapshot('navigation').transcript?.revision, 1)
    release()
  } finally {
    releaseDelta()
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})

for (const mode of ['unsettled-content', 'stalled-watermark'] as const) {
  test(`${mode} reaches a visible bounded failure while retaining its last content`, async () => {
    const previousFetch = globalThis.fetch
    const previousSetTimeout = globalThis.setTimeout
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      const payload = envelope(mode, 1)
      if (mode === 'unsettled-content' && calls > 1) payload.settled = false
      return jsonResponse(payload)
    }
    try {
      const release = attachAcpTranscriptSession(mode)
      await waitFor(() => getAcpTranscriptSessionSnapshot(mode).transcript?.revision === 1)
      globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
        previousSetTimeout(handler, Math.min(Number(timeout) || 0, 1), ...args)
      )) as typeof setTimeout
      observeAcpTranscriptRevision({ agentId: mode, sessionId: `session-${mode}`,
        runtimeEpoch: `epoch-${mode}`, revision: 2, updatedAt: '' })
      await waitFor(() => getAcpTranscriptSessionSnapshot(mode).error === 'response')
      assert.equal(getAcpTranscriptSessionSnapshot(mode).loading, false)
      assert.equal(getAcpTranscriptSessionSnapshot(mode).transcript?.revision, 1)
      const stoppedAt = calls
      assert.equal(stoppedAt, ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH + 2)
      await new Promise(resolve => previousSetTimeout(resolve, 50))
      assert.equal(calls, stoppedAt)
      release()
    } finally {
      resetAcpTranscriptSessionPoolForTests()
      globalThis.fetch = previousFetch
      globalThis.setTimeout = previousSetTimeout
    }
  })
}
