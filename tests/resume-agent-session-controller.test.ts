import assert from 'node:assert/strict'
import test from 'node:test'
import { ResumeAgentSessionController, type ResumeAgentCandidate, type ResumeAgentSessionPorts, type ResumeAgentSessionOutcome } from '../src/components/code/useResumeAgentSessionController'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function response(body: unknown, ok = true, status = ok ? 201 : 500) {
  return { ok, status, json: async () => body }
}
const identity = { provider: 'codex', sessionId: 'session-1', providerHomeId: 'work', customTitle: 'Keep title' }
function fixture(overrides: Partial<ResumeAgentSessionPorts> = {}) {
  const events: string[] = []
  let activeAgents: ResumeAgentCandidate[] = []
  let requests = 0
  const timers = new Map<object, () => void>()
  const controller = new ResumeAgentSessionController({
    getActiveAgents: () => activeAgents,
    mountProject: async workspace => { events.push(`mount:${workspace}`); return workspace },
    applyProjectMembership: () => events.push('project-membership'),
    commitSessionMembership: id => events.push(`session:${id.providerHomeId}:${id.sessionId}`),
    request: async () => { requests++; return response({ agentId: 'created', projectWorkspaces: ['/repo'] }) },
    setTimer: callback => { const id = {}; timers.set(id, callback); return id },
    clearTimer: id => { timers.delete(id as object) },
    ...overrides,
  })
  return { controller, events, timers, requests: () => requests, setAgents: (agents: ResumeAgentCandidate[]) => { activeAgents = agents }, timeout: () => { for (const callback of [...timers.values()]) callback() } }
}
function failed(outcome: ResumeAgentSessionOutcome, uncertain: boolean, message?: RegExp) {
  assert.equal(outcome.status, 'failed')
  if (outcome.status !== 'failed') return
  assert.equal(outcome.uncertain, uncertain)
  if (message) assert.match(outcome.message, message)
}

test('one exact tuple joins, title conflicts reject, and completion only reconciles membership', async () => {
  const gate = deferred<ReturnType<typeof response>>()
  let requests = 0
  const subject = fixture({ request: async () => { requests++; return gate.promise } })
  const first = subject.controller.resume(identity)
  assert.equal(first, subject.controller.resume(identity))
  failed(await subject.controller.resume({ ...identity, customTitle: 'Other' }), false, /different title/)
  assert.equal(requests, 1)
  gate.resolve(response({ agentId: 'created', projectWorkspaces: ['/repo'] }))
  assert.deepEqual(await first, { status: 'succeeded', agentId: 'created', reused: false })
  assert.deepEqual(subject.events, ['project-membership', 'session:work:session-1'])
  assert.equal(subject.timers.size, 0)
})

test('Home identities are independent and default aliases join', async () => {
  const gates = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()]
  let requests = 0
  const subject = fixture({ request: async () => gates[requests++].promise })
  const first = subject.controller.resume({ ...identity, providerHomeId: '' })
  assert.equal(first, subject.controller.resume({ ...identity, providerHomeId: 'default' }))
  const other = subject.controller.resume(identity)
  gates[1].resolve(response({ agentId: 'other' }))
  await other
  gates[0].resolve(response({ agentId: 'default' }))
  await first
  assert.equal(requests, 2)
  assert.equal(subject.events.filter(value => value.startsWith('session:')).length, 2)
})

test('reuses only the live exact claim and waits for mount before membership', async () => {
  const mount = deferred<string>()
  const subject = fixture({ mountProject: async () => mount.promise })
  subject.setAgents([
    { id: 'wrong-home', status: 'running', providerSessionKey: 'agent-session:codex:home:other:session-1', workspace: '/other' },
    { id: 'exact', status: 'running', providerSessionKey: 'agent-session:codex:home:work:session-1', workspace: '/repo' },
  ])
  const pending = subject.controller.resume(identity)
  assert.deepEqual(subject.events, [])
  mount.resolve('/repo')
  assert.deepEqual(await pending, { status: 'succeeded', agentId: 'exact', reused: true })
  assert.equal(subject.requests(), 0)
})

for (const status of ['stopped', 'dead', 'archived']) {
  test(`does not reuse ${status} claims`, async () => {
    const subject = fixture()
    subject.setAgents([{ id: status, status: status === 'archived' ? 'running' : status, archived: status === 'archived', providerSessionKey: 'agent-session:codex:home:work:session-1', workspace: '/repo' }])
    await subject.controller.resume(identity)
    assert.equal(subject.requests(), 1)
  })
}

test('mount failure and timeout cannot commit membership; timeout prevents mutation replay', async () => {
  const subject = fixture({ mountProject: async () => { throw new Error('mount failed') } })
  subject.setAgents([{ id: 'live', status: 'running', providerSessionKey: 'agent-session:codex:home:work:session-1', workspace: '/repo' }])
  failed(await subject.controller.resume(identity), true, /mount failed/)
  assert.deepEqual(subject.events, [])
})

test('preserves Chat history, exact Home and custom title at the mutation boundary', async () => {
  const subject = fixture({ request: async (url, init) => {
    assert.match(url, /codex\/session-1\/resume$/)
    assert.deepEqual(JSON.parse(init.body), { unarchiveArchived: true, providerHomeId: 'work', agentRuntimeMode: 'chat', acpHistoryMode: 'load', customTitle: 'Keep title' })
    return response({ agentId: 'created' })
  } })
  await subject.controller.resume(identity)
})

for (const kind of ['transport', 'malformed', 'server', 'conflict'] as const) {
  test(`${kind} failure stays uncertain and cannot replay even on another activation`, async () => {
    let requests = 0
    const subject = fixture({ request: async () => {
      requests++
      if (kind === 'transport') throw new Error('connection lost')
      if (kind === 'malformed') return response({ agentId: 42 })
      return response({ error: 'Could not confirm resume' }, false, kind === 'conflict' ? 409 : 500)
    } })
    failed(await subject.controller.resume(identity), true)
    failed(await subject.controller.resume(identity), true)
    assert.equal(requests, 1)
    assert.deepEqual(subject.events, [])
    assert.equal(subject.timers.size, 0)
  })
}

test('known rejection permits an explicit later attempt', async () => {
  let requests = 0
  const subject = fixture({ request: async () => ++requests === 1 ? response({ error: 'Session unavailable' }, false, 404) : response({ agentId: 'created' }) })
  failed(await subject.controller.resume(identity), false)
  assert.equal((await subject.controller.resume(identity)).status, 'succeeded')
  assert.equal(requests, 2)
})

for (const operation of ['request', 'mount'] as const) {
  for (const terminal of ['timeout', 'dispose'] as const) {
    test(`${terminal} releases a stuck ${operation}, aborts and fences late completion`, async () => {
      const gate = deferred<ReturnType<typeof response>>()
      let signal: AbortSignal | undefined
      const subject = fixture(operation === 'request' ? { request: async (_url, init) => { signal = init.signal; return gate.promise } } : { mountProject: async (_root, value) => { signal = value; await gate.promise; return '/repo' } })
      if (operation === 'mount') subject.setAgents([{ id: 'live', status: 'running', providerSessionKey: 'agent-session:codex:home:work:session-1', workspace: '/repo' }])
      const pending = subject.controller.resume(identity)
      if (terminal === 'timeout') subject.timeout()
      else subject.controller.dispose()
      const outcome = await pending
      if (terminal === 'timeout') {
        failed(outcome, true, /timed out/)
        failed(await subject.controller.resume(identity), true)
      } else assert.equal(outcome.status, 'stale')
      assert.equal(signal?.aborted, true)
      gate.resolve(response({ agentId: 'late' }))
      await Promise.resolve(); await Promise.resolve()
      assert.deepEqual(subject.events, [])
      assert.equal(subject.timers.size, 0)
    })
  }
}

for (const state of ['pending', 'absent', 'ready', 'malformed'] as const) {
  test(`fresh ${state} status reconciles without a second POST`, async () => {
    let posts = 0
    const subject = fixture({ request: async () => { posts++; throw new Error('lost reply') }, readStatus: async (url, init) => {
      assert.match(url, /resume-status\?providerHomeId=work$/)
      assert.equal(init.signal.aborted, false)
      return response({ state, agentId: state === 'ready' ? 'recovered' : null, projectWorkspaces: ['/repo'] })
    } })
    await subject.controller.resume(identity)
    const outcome = await subject.controller.reconcile(identity)
    assert.equal(posts, 1)
    if (state === 'ready') {
      assert.equal(outcome.status, 'succeeded')
      assert.deepEqual(subject.events, ['project-membership', 'session:work:session-1'])
    } else {
      failed(outcome, true)
      failed(await subject.controller.resume(identity), true)
      assert.equal(posts, 1)
    }
    assert.equal(subject.timers.size, 0)
  })
}

test('read-only reconciliation is bounded and disposal suppresses late membership', async () => {
  for (const terminal of ['timeout', 'dispose']) {
    const gate = deferred<ReturnType<typeof response>>()
    const subject = fixture({ readStatus: async () => gate.promise })
    const pending = subject.controller.reconcile(identity)
    if (terminal === 'timeout') subject.timeout()
    else subject.controller.dispose()
    assert.equal((await pending).status, terminal === 'timeout' ? 'failed' : 'stale')
    gate.resolve(response({ state: 'ready', agentId: 'late' }))
    await Promise.resolve(); await Promise.resolve()
    assert.deepEqual(subject.events, [])
    assert.equal(subject.timers.size, 0)
  }
})

test('preserves authoritative HTTP reuse and read-only reconciliation reports an existing Agent', async () => {
  const subject = fixture({
    request: async () => response({ agentId: 'existing', reused: true }, true, 200),
    readStatus: async () => response({ state: 'ready', agentId: 'existing' }),
  })
  assert.deepEqual(await subject.controller.resume(identity), { status: 'succeeded', agentId: 'existing', reused: true })
  assert.deepEqual(await subject.controller.reconcile(identity), { status: 'succeeded', agentId: 'existing', reused: true })
})
