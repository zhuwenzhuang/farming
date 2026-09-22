import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanupAgents, reportAgentCleanupFailure } from './e2e/agent-cleanup'

function response(status: number, data: unknown = {}) {
  return { ok: () => status >= 200 && status < 300, status: () => status, json: async () => data }
}

function fakeApi(reads: Array<ReturnType<typeof response> | Error>, mutation: ReturnType<typeof response> | Error = response(202)) {
  const calls: string[] = []
  const timeouts: number[] = []
  let index = 0
  const send = async (method: string, url: string, options: { timeout: number }) => {
    calls.push(`${method} ${url}`)
    timeouts.push(options.timeout)
    const result = method === 'GET' ? reads[Math.min(index++, reads.length - 1)] : mutation
    if (result instanceof Error) throw result
    return result
  }
  return {
    calls, timeouts,
    request: {
      get: (url: string, options: { timeout: number }) => send('GET', url, options),
      delete: (url: string, options: { timeout: number }) => send('DELETE', url, options),
      patch: (url: string, options: { timeout: number }) => send('PATCH', url, options),
    },
  }
}

const occupied = response(200, { agents: [{ id: 'one', command: 'codex' }] })
const empty = response(200, { agents: [] })

test('202 requires observed absence, with no repeat mutation for duplicate or still-visible IDs', async () => {
  const api = fakeApi([response(200, { agents: [{ id: 'one' }, { id: 'one' }] }), occupied, empty])
  await cleanupAgents(api.request, { pollIntervalMs: 0 })
  assert.equal(api.calls.filter(call => call.startsWith('DELETE')).length, 1)
  assert.equal(api.calls.filter(call => call.startsWith('GET')).length, 3)
  assert.ok(api.timeouts.every(timeout => timeout > 0 && timeout <= 10_000))
})

for (const failure of [response(500), new Error('connection reset')]) {
  test(`DELETE ${failure instanceof Error ? 'uncertain transport' : 'HTTP error'} fails closed without replay`, async () => {
    const api = fakeApi([occupied, empty], failure)
    await assert.rejects(cleanupAgents(api.request), failure instanceof Error ? /outcome is uncertain; no replay/ : /DELETE Agent one failed: HTTP 500/)
    assert.equal(api.calls.length, 2)
  })

  for (const phase of ['initial', 'polling']) {
    test(`${phase} GET failure is not silently accepted`, async () => {
      const api = fakeApi(phase === 'initial' ? [failure] : [occupied, failure])
      await assert.rejects(cleanupAgents(api.request, { pollIntervalMs: 0 }), /GET Agent inventory failed/)
      assert.equal(api.calls.filter(call => call.startsWith('DELETE')).length, phase === 'initial' ? 0 : 1)
    })
  }

  test(`archive ${failure instanceof Error ? 'uncertain transport' : 'HTTP error'} never falls through to DELETE`, async () => {
    const api = fakeApi([occupied, empty], failure)
    await assert.rejects(cleanupAgents(api.request, { archiveCodex: true }), /PATCH archive Agent one failed/)
    assert.equal(api.calls.filter(call => call.startsWith('PATCH')).length, 1)
    assert.equal(api.calls.filter(call => call.startsWith('DELETE')).length, 0)
  })
}

test('successful archive still observes absence', async () => {
  const api = fakeApi([occupied, occupied, empty])
  await cleanupAgents(api.request, { archiveCodex: true, pollIntervalMs: 0 })
  assert.equal(api.calls.filter(call => call.startsWith('PATCH')).length, 1)
  assert.equal(api.calls.filter(call => call.startsWith('GET')).length, 3)
})

for (const data of [{}, { agents: [{ command: 'codex' }] }, { agents: null }]) {
  test(`invalid inventory fails closed: ${JSON.stringify(data)}`, async () => {
    const api = fakeApi([response(200, data)])
    await assert.rejects(cleanupAgents(api.request), /invalid Agents/)
    assert.equal(api.calls.length, 1)
  })
}

test('cleanup timeout is explicit and does not replay an admitted deletion', async () => {
  const api = fakeApi([occupied])
  await assert.rejects(cleanupAgents(api.request, { timeoutMs: 25, pollIntervalMs: 2 }), /Timed out cleaning up Farming E2E Agents: one/)
  assert.equal(api.calls.filter(call => call.startsWith('DELETE')).length, 1)
})

test('invalid JSON inventory is an explicit failure', async () => {
  const api = fakeApi([empty])
  api.request.get = async () => ({
    ...empty,
    json: async () => { throw new SyntaxError('invalid JSON') },
  })
  await assert.rejects(cleanupAgents(api.request), /invalid JSON; Agent inventory is unknown/)
})

test('teardown failure attaches evidence and throws the same error for Playwright to append', async () => {
  const failure = new Error('cleanup failed')
  const attachments: string[] = []
  await assert.rejects(reportAgentCleanupFailure(async () => { throw failure }, {
    attach: async (name, options) => { attachments.push(`${name}: ${String(options?.body)}`) },
  }), error => error === failure)
  assert.match(attachments[0], /Agent cleanup failure: Error: cleanup failed/)
})

test('attachment failure cannot replace the cleanup error', async context => {
  const failure = new Error('original cleanup error')
  const log = context.mock.method(console, 'error', () => {})
  await assert.rejects(reportAgentCleanupFailure(async () => { throw failure }, {
    attach: async () => { throw new Error('attachment failed') },
  }), error => error === failure)
  assert.equal(log.mock.callCount(), 1)
})
