import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attachAcpTranscriptSession,
  getAcpTranscriptSessionSnapshot,
  observeAcpTranscriptRevision,
  reconnectAcpTranscriptSessions,
  resetAcpTranscriptSessionPoolForTests,
  retainAcpTranscriptSessions,
} from '../src/components/code/acp/acp-transcript-session-pool'

function envelope(
  agentId: string,
  revision: number,
  options: {
    fromRevision?: number
    answer?: string
    runtimeEpoch?: string
    sessionId?: string
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
      state: 'idle',
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

    assert.equal(getAcpTranscriptSessionSnapshot('agent-h').transcript?.sessionId, 'session-old')
    assert.equal(getAcpTranscriptSessionSnapshot('agent-h').transcript?.revision, 1)
    assert.doesNotMatch(urls[2] ?? '', /sinceRevision=/)

    releaseNewCheckpoint()
    await waitFor(() => getAcpTranscriptSessionSnapshot('agent-h').transcript?.sessionId === 'session-new')
  } finally {
    resetAcpTranscriptSessionPoolForTests()
    globalThis.fetch = previousFetch
  }
})
