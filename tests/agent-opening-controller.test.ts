import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentOpeningController, type AgentOpeningState, type AgentOpeningTarget } from '../src/components/code/useAgentOpeningController'
import type { ResumeAgentCandidate, ResumeAgentSessionOutcome } from '../src/components/code/useResumeAgentSessionController'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const target = (id: string, home = 'default'): AgentOpeningTarget => ({ title: id, workspace: '/repo', identity: { provider: 'codex', providerHomeId: home, sessionId: id }, source: 'search' })
const live = (id: string, status = 'running'): ResumeAgentCandidate => ({ id, status, workspace: '/repo' })
async function flush() { await Promise.resolve(); await Promise.resolve() }
function fixture() {
  let state: AgentOpeningState | null = null
  let agents: ResumeAgentCandidate[] = []
  const calls: Array<{ target: string; check: boolean; gate: ReturnType<typeof deferred<ResumeAgentSessionOutcome>> }> = []
  const opened: string[] = []
  const timers = new Map<object, () => void>()
  const request = (id: string, check: boolean) => {
    const gate = deferred<ResumeAgentSessionOutcome>()
    calls.push({ target: id, check, gate })
    return gate.promise
  }
  const controller = new AgentOpeningController({
    resume: identity => request(identity.sessionId, false),
    reconcile: identity => request(identity.sessionId, true),
    getAgents: () => agents,
    changed: next => { state = next },
    activate: id => opened.push(id),
    setTimer: callback => { const id = {}; timers.set(id, callback); return id },
    clearTimer: id => { timers.delete(id as object) },
  })
  return { controller, calls, opened, timers, state: () => state, agents: (value: ResumeAgentCandidate[]) => { agents = value; controller.observeAgents() }, timeout: () => { for (const callback of [...timers.values()]) callback() } }
}

test('target is visible immediately; HTTP then state opens only the exact Agent', async () => {
  const s = fixture()
  s.controller.open(target('a'))
  assert.equal(s.state()?.target.title, 'a')
  assert.equal(s.state()?.phase, 'resuming')
  s.calls[0].gate.resolve({ status: 'succeeded', agentId: 'agent-a', reused: false })
  await flush()
  assert.equal(s.state()?.phase, 'waiting')
  s.agents([live('unrelated')])
  assert.deepEqual(s.opened, [])
  s.agents([live('agent-a')])
  assert.deepEqual(s.opened, ['agent-a'])
  assert.equal(s.state()?.phase, 'ready')
  assert.equal(s.timers.size, 0)
})

test('state before HTTP is safe; opening an existing Agent performs no resume', async () => {
  const s = fixture()
  s.controller.open(target('a'))
  s.agents([live('agent-a')])
  assert.deepEqual(s.opened, [])
  s.calls[0].gate.resolve({ status: 'succeeded', agentId: 'agent-a', reused: true })
  await flush()
  assert.deepEqual(s.opened, ['agent-a'])
  s.controller.open({ ...target('b'), identity: undefined, agentId: 'agent-a' })
  assert.equal(s.calls.length, 1)
  assert.deepEqual(s.opened, ['agent-a', 'agent-a'])
})

for (const order of [[0, 1], [1, 0]]) {
  test(`A then B, completions ${order.join('/')}: only B may activate`, async () => {
    const s = fixture()
    s.agents([live('agent-a'), live('agent-b')])
    s.controller.open(target('same-id', 'work'))
    s.controller.open(target('same-id', 'other'))
    for (const index of order) {
      s.calls[index].gate.resolve({ status: 'succeeded', agentId: index ? 'agent-b' : 'agent-a', reused: false })
      await flush()
    }
    assert.deepEqual(s.opened, ['agent-b'])
    assert.equal(s.state()?.target.identity?.providerHomeId, 'other')
  })
}

for (const phase of ['resuming', 'waiting'] as const) {
  test(`leaving during ${phase} revokes navigation, including late state and errors`, async () => {
    const s = fixture()
    s.controller.open(target('a'))
    if (phase === 'waiting') {
      s.calls[0].gate.resolve({ status: 'succeeded', agentId: 'a', reused: false })
      await flush()
    }
    s.controller.leave()
    s.agents([live('a')])
    s.calls[0].gate.resolve({ status: 'succeeded', agentId: 'a', reused: false })
    await flush()
    assert.equal(s.state(), null)
    assert.deepEqual(s.opened, [])
    assert.equal(s.timers.size, 0)
  })
}

test('superseding a state wait cancels its timer; old state cannot steal a running target', async () => {
  const s = fixture()
  s.controller.open(target('a'))
  s.calls[0].gate.resolve({ status: 'succeeded', agentId: 'a', reused: false })
  await flush()
  s.agents([live('b')])
  s.controller.open({ ...target('b'), identity: undefined, agentId: 'b' })
  s.agents([live('a'), live('b')])
  s.timeout()
  assert.equal(s.state()?.phase, 'ready')
  assert.deepEqual(s.opened, ['b'])
})

test('known failure is persistent; only explicit retry starts another attempt', async () => {
  const s = fixture()
  s.controller.open(target('a'))
  s.calls[0].gate.resolve({ status: 'failed', uncertain: false, message: 'not found' })
  await flush()
  s.controller.check()
  assert.equal(s.calls.length, 1)
  assert.equal(s.state()?.message, 'not found')
  s.controller.retry()
  s.controller.retry()
  assert.equal(s.calls.length, 2)
  assert.equal(s.state()?.phase, 'resuming')
  s.controller.leave()
})

for (const cause of ['transport', 'state-timeout']) {
  test(`${cause} offers read-only checking and never mutation retry`, async () => {
    const s = fixture()
    s.controller.open(target('a'))
    s.calls[0].gate.resolve(cause === 'transport' ? { status: 'failed', uncertain: true, message: 'lost' } : { status: 'succeeded', agentId: 'a', reused: false })
    await flush()
    if (cause === 'state-timeout') s.timeout()
    assert.equal(s.state()?.phase, 'failed')
    assert.equal(s.state()?.uncertain, true)
    s.controller.retry()
    assert.equal(s.calls.length, 1)
    s.controller.check()
    s.controller.check()
    assert.equal(s.calls.length, 2)
    assert.equal(s.calls[1].check, true)
    s.agents([live('a')])
    s.calls[1].gate.resolve({ status: 'succeeded', agentId: 'a', reused: true })
    await flush()
    assert.deepEqual(s.opened, ['a'])
    assert.equal(s.timers.size, 0)
  })
}

for (const status of ['stopped', 'dead', 'archived']) {
  test(`${status} before display fails visibly rather than waiting forever`, async () => {
    const s = fixture()
    s.controller.open(target('a'))
    s.agents([{ ...live('a', status), archived: status === 'archived' }])
    s.calls[0].gate.resolve({ status: 'succeeded', agentId: 'a', reused: false })
    await flush()
    assert.equal(s.state()?.phase, 'failed')
    assert.equal(s.timers.size, 0)
    assert.deepEqual(s.opened, [])
  })
}

test('late rejection and read result cannot replace a newer page', async () => {
  const s = fixture()
  s.controller.open(target('a'))
  s.controller.open(target('b'))
  s.calls[0].gate.reject(new Error('late'))
  await flush()
  assert.equal(s.state()?.target.title, 'b')
  s.calls[1].gate.resolve({ status: 'failed', uncertain: true, message: 'lost' })
  await flush()
  s.controller.check()
  s.controller.leave()
  s.calls[2].gate.resolve({ status: 'succeeded', agentId: 'b', reused: true })
  await flush()
  assert.equal(s.state(), null)
  assert.deepEqual(s.opened, [])
})

test('a live Agent that stops before display retries its durable session instead of the obsolete Agent id', async () => {
  const s = fixture()
  s.agents([live('a', 'stopped')])
  s.controller.open({ ...target('session-a'), agentId: 'a' })
  assert.equal(s.state()?.phase, 'failed')
  s.controller.retry()
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].target, 'session-a')
  s.agents([live('replacement')])
  s.calls[0].gate.resolve({ status: 'succeeded', agentId: 'replacement', reused: false })
  await flush()
  assert.deepEqual(s.opened, ['replacement'])
})

test('an invalid target fails explicitly without an unbounded loading state', () => {
  const s = fixture()
  s.controller.open({ ...target('missing'), identity: undefined })
  assert.equal(s.state()?.phase, 'failed')
  assert.equal(s.calls.length, 0)
  assert.equal(s.timers.size, 0)
})
