import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexRealtimeBackendError } from '../src/components/code/codex-realtime-controller'
import { createCodexRealtimeHttpClient } from '../src/components/code/codex-realtime-http'

function createHarness(fetchImplementation: typeof fetch) {
  const timers = new Map<number, () => void>()
  let timerId = 0
  const client = createCodexRealtimeHttpClient({
    fetch: fetchImplementation,
    buildPath: path => path,
    scheduleTimeout: callback => {
      const id = ++timerId
      timers.set(id, callback)
      return id
    },
    clearScheduledTimeout: id => timers.delete(id),
  })
  return { client, timers }
}

const startRequest = {
  agentId: 'agent-a',
  operationId: 'voice-op-1',
  sdp: 'v=0\r\nfake-offer',
}

test('HTTP 200 without a verified start result is uncertain', async () => {
  const responses = [
    new Response('', { status: 200 }),
    new Response('{not-json', { status: 200 }),
    Response.json({ started: false }, { status: 200 }),
  ]
  for (const response of responses) {
    const { client } = createHarness(async () => response)
    await assert.rejects(
      client.startBackend(startRequest),
      error => error instanceof CodexRealtimeBackendError && error.outcome === 'uncertain',
    )
  }
})

test('only exact accepted and cancelled start shapes are trusted', async () => {
  {
    const { client } = createHarness(async () => Response.json({
      started: true,
      operationId: 'voice-op-1',
    }))
    assert.deepStrictEqual(await client.startBackend(startRequest), { accepted: true })
  }
  {
    const { client } = createHarness(async () => Response.json({
      started: false,
      cancelled: true,
      operationId: 'voice-op-1',
    }))
    assert.deepStrictEqual(await client.startBackend(startRequest), { accepted: false })
  }
})

test('an HTTP 409 saturated-fence response is a definitive browser rejection', async () => {
  const { client } = createHarness(async () => Response.json({
    error: 'Realtime operation safety history is full. Restart Codex Chat before starting voice again.',
    outcome: 'rejected',
  }, { status: 409 }))
  await assert.rejects(
    client.startBackend(startRequest),
    error => error instanceof CodexRealtimeBackendError
      && error.outcome === 'rejected'
      && /Restart Codex Chat/.test(error.message),
  )
})

test('a pending start request is aborted and becomes uncertain when its timer fires', async () => {
  const observed: { signal: AbortSignal | null } = { signal: null }
  const { client, timers } = createHarness((_input, init) => {
    observed.signal = init?.signal as AbortSignal
    return new Promise<Response>(() => {})
  })
  const starting = client.startBackend(startRequest)
  const timeout = timers.values().next().value
  assert.equal(typeof timeout, 'function')
  timeout?.()
  await assert.rejects(
    starting,
    error => error instanceof CodexRealtimeBackendError
      && error.outcome === 'uncertain'
      && /timed out/i.test(error.message),
  )
  assert.equal(observed.signal?.aborted, true)
})

test('a pending stop request is aborted and fails its fence when its timer fires', async () => {
  const observed: { signal: AbortSignal | null } = { signal: null }
  const { client, timers } = createHarness((_input, init) => {
    observed.signal = init?.signal as AbortSignal
    return new Promise<Response>(() => {})
  })
  const stopping = client.stopBackend({
    agentId: 'agent-a',
    operationId: 'voice-op-1',
    keepalive: false,
  })
  const timeout = timers.values().next().value
  assert.equal(typeof timeout, 'function')
  timeout?.()
  await assert.rejects(stopping, /stop request timed out/i)
  assert.equal(observed.signal?.aborted, true)
})

test('the start deadline also covers a response body that never finishes', async () => {
  const stalledResponse = {
    ok: true,
    status: 200,
    json: () => new Promise<Record<string, unknown>>(() => {}),
  } as Response
  const { client, timers } = createHarness(async () => stalledResponse)
  const starting = client.startBackend(startRequest)
  const timeout = timers.values().next().value
  assert.equal(typeof timeout, 'function')
  timeout?.()
  await assert.rejects(
    starting,
    error => error instanceof CodexRealtimeBackendError
      && error.outcome === 'uncertain'
      && /timed out/i.test(error.message),
  )
})

test('the stop deadline also covers a response body that never finishes', async () => {
  const stalledResponse = {
    ok: true,
    status: 200,
    json: () => new Promise<Record<string, unknown>>(() => {}),
  } as Response
  const { client, timers } = createHarness(async () => stalledResponse)
  const stopping = client.stopBackend({
    agentId: 'agent-a',
    operationId: 'voice-op-1',
    keepalive: false,
  })
  const timeout = timers.values().next().value
  assert.equal(typeof timeout, 'function')
  timeout?.()
  await assert.rejects(stopping, /stop request timed out/i)
})
