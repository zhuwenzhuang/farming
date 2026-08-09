import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ResumeAgentSessionController,
  type ResumeAgentCandidate,
  type ResumeAgentSessionPorts,
} from '../src/components/code/useResumeAgentSessionController'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}

function response(body: unknown, ok = true, status = ok ? 201 : 500) {
  return { ok, status, json: async () => body }
}

function fixture(overrides: Partial<ResumeAgentSessionPorts> = {}) {
  const events: string[] = []
  let activeAgents: ResumeAgentCandidate[] = []
  let requestCount = 0
  const ports: ResumeAgentSessionPorts = {
    getActiveAgents: () => activeAgents,
    mountProject: async workspace => {
      events.push(`mount:${workspace}`)
      return workspace
    },
    applyProjectMembership: () => events.push('project-membership'),
    commitSessionMembership: identity => events.push(`session-membership:${identity.provider}:${identity.providerHomeId}:${identity.sessionId}`),
    openAgent: (agentId, whenReady) => events.push(`open:${agentId}:${whenReady}`),
    closeMobileNavigation: () => events.push('close-mobile'),
    showError: message => events.push(`error:${message}`),
    request: async () => {
      requestCount += 1
      return response({ agentId: `created-${requestCount}`, projectWorkspaces: ['/repo'], pinnedProjectWorkspaces: [] })
    },
    ...overrides,
  }
  return {
    controller: new ResumeAgentSessionController(ports),
    events,
    requestCount: () => requestCount,
    setActiveAgents: (agents: ResumeAgentCandidate[]) => { activeAgents = agents },
  }
}

const identity = { provider: 'codex', sessionId: 'session-1', providerHomeId: 'work', customTitle: 'Keep title' }

test('joins concurrent resumes for one exact provider session identity', async () => {
  const gate = deferred<ReturnType<typeof response>>()
  let requests = 0
  const subject = fixture({
    request: async () => {
      requests += 1
      return gate.promise
    },
  })
  const first = subject.controller.resume(identity)
  const second = subject.controller.resume(identity)
  assert.equal(first, second)
  assert.equal(requests, 1)
  gate.resolve(response({ agentId: 'created', projectWorkspaces: ['/repo'] }))
  await first
  assert.deepEqual(subject.events, [
    'project-membership',
    'session-membership:codex:work:session-1',
    'open:created:true',
    'close-mobile',
  ])
})

test('rejects a concurrent title conflict without issuing another mutation', async () => {
  const gate = deferred<ReturnType<typeof response>>()
  let requests = 0
  const subject = fixture({
    request: async () => {
      requests += 1
      return gate.promise
    },
  })
  const first = subject.controller.resume(identity)
  const conflicting = await subject.controller.resume({ ...identity, customTitle: 'Different title' })
  assert.equal(requests, 1)
  assert.deepEqual(conflicting, { status: 'failed', uncertain: false })
  assert.deepEqual(subject.events, ['error:This Agent session is already resuming with a different title'])
  gate.resolve(response({ agentId: 'created' }))
  await first
})

test('admits different provider-home identities independently', async () => {
  const gates = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()]
  let requests = 0
  const subject = fixture({ request: async () => gates[requests++].promise })
  const first = subject.controller.resume(identity)
  const second = subject.controller.resume({ ...identity, providerHomeId: 'other' })
  assert.equal(requests, 2)
  gates[1].resolve(response({ agentId: 'other-agent' }))
  await second
  gates[0].resolve(response({ agentId: 'work-agent' }))
  await first
  assert(subject.events.includes('session-membership:codex:work:session-1'))
  assert(subject.events.includes('session-membership:codex:other:session-1'))
})

test('joins empty and literal default homes through the canonical session identity', async () => {
  const gate = deferred<ReturnType<typeof response>>()
  let requests = 0
  const subject = fixture({
    request: async () => {
      requests += 1
      return gate.promise
    },
  })
  const implicitHome = subject.controller.resume({ ...identity, providerHomeId: '' })
  const literalDefaultHome = subject.controller.resume({ ...identity, providerHomeId: 'default' })
  assert.equal(implicitHome, literalDefaultHome)
  assert.equal(requests, 1)
  gate.resolve(response({ agentId: 'default-home' }))
  await Promise.all([implicitHome, literalDefaultHome])
})

test('reuses only a live exact agent and mounts before local membership', async () => {
  const subject = fixture()
  subject.setActiveAgents([{
    id: 'live-agent',
    status: 'running',
    providerSessionKey: 'agent-session:codex:home:work:session-1',
    workspace: '/live-repo',
  }])
  await subject.controller.resume(identity)
  assert.equal(subject.requestCount(), 0)
  assert.deepEqual(subject.events, [
    'mount:/live-repo',
    'session-membership:codex:work:session-1',
    'open:live-agent:false',
    'close-mobile',
  ])
})

test('does not reuse stopped or dead agents', async () => {
  const subject = fixture()
  subject.setActiveAgents([
    { id: 'stopped', status: 'stopped', providerSessionKey: 'agent-session:codex:home:work:session-1', workspace: '/one' },
    { id: 'dead', status: 'dead', providerSessionKey: 'agent-session:codex:home:work:session-1', workspace: '/two' },
  ])
  await subject.controller.resume(identity)
  assert.equal(subject.requestCount(), 1)
  assert(subject.events.includes('open:created-1:true'))
})

test('mount failure has no local membership, open, or mobile effects', async () => {
  const subject = fixture({ mountProject: async () => { throw new Error('mount failed') } })
  subject.setActiveAgents([{
    id: 'live-agent',
    status: 'running',
    providerSessionKey: 'agent-session:codex:home:work:session-1',
    workspace: '/live-repo',
  }])
  await subject.controller.resume(identity)
  assert.deepEqual(subject.events, ['error:mount failed'])
})

test('live mount timeout aborts, releases admission, and has no late local effects', async () => {
  const mountState: { signal?: AbortSignal } = {}
  const timerState: { callback?: () => void } = {}
  let mountCalls = 0
  const subject = fixture({
    mountProject: async (workspace, signal) => {
      mountCalls += 1
      mountState.signal = signal
      if (mountCalls === 1) return new Promise(() => {})
      return workspace
    },
    setTimer: callback => {
      timerState.callback = callback
      return 'timer'
    },
    clearTimer: () => {},
    timeoutMs: 1,
  })
  subject.setActiveAgents([{
    id: 'live-agent',
    status: 'running',
    providerSessionKey: 'agent-session:codex:home:work:session-1',
    workspace: '/live-repo',
  }])

  const pending = subject.controller.resume(identity)
  assert(timerState.callback)
  timerState.callback()
  assert.deepEqual(await pending, { status: 'failed', uncertain: true })
  assert.equal(mountState.signal?.aborted, true)
  assert.deepEqual(subject.events, ['error:Agent session resume timed out; the outcome is uncertain'])

  assert.deepEqual(await subject.controller.resume(identity), {
    status: 'succeeded',
    agentId: 'live-agent',
    reused: true,
  })
  assert.equal(mountCalls, 2)
})

test('dispose aborts a never-settling live mount without local effects', async () => {
  const mountState: { signal?: AbortSignal } = {}
  const subject = fixture({
    mountProject: async (_workspace, signal) => {
      mountState.signal = signal
      return new Promise(() => {})
    },
  })
  subject.setActiveAgents([{
    id: 'live-agent',
    status: 'running',
    providerSessionKey: 'agent-session:codex:home:work:session-1',
    workspace: '/live-repo',
  }])

  const pending = subject.controller.resume(identity)
  subject.controller.dispose()
  assert.deepEqual(await pending, { status: 'stale' })
  assert.equal(mountState.signal?.aborted, true)
  assert.deepEqual(subject.events, [])
})

test('rejects a malformed successful response at the HTTP boundary', async () => {
  const subject = fixture({ request: async () => response({ agentId: 42, projectWorkspaces: 'wrong' }) })
  await subject.controller.resume(identity)
  assert.deepEqual(subject.events, ['error:Failed to resume agent session (201)'])
})

test('preserves Chat history and custom title in the resume request', async () => {
  let requestBody: Record<string, unknown> | null = null
  const subject = fixture({
    request: async (_url, init) => {
      requestBody = JSON.parse(init.body) as Record<string, unknown>
      return response({ agentId: 'created' })
    },
  })
  await subject.controller.resume(identity)
  assert.deepEqual(requestBody, {
    unarchiveArchived: true,
    providerHomeId: 'work',
    agentRuntimeMode: 'chat',
    acpHistoryMode: 'load',
    customTitle: 'Keep title',
  })
})

test('dispose aborts and fences a request that never settles', async () => {
  const requestState: { signal?: AbortSignal } = {}
  const subject = fixture({
    request: async (_url, init) => {
      requestState.signal = init.signal
      return new Promise(() => {})
    },
  })
  const pending = subject.controller.resume(identity)
  subject.controller.dispose()
  assert.deepEqual(await pending, { status: 'stale' })
  assert.equal(requestState.signal?.aborted, true)
  assert.deepEqual(subject.events, [])
})

test('bounded timeout aborts a never-settling request as uncertain without replay', async () => {
  const requestState: { signal?: AbortSignal } = {}
  const timerState: { callback?: () => void } = {}
  let requests = 0
  const subject = fixture({
    request: async (_url, init) => {
      requests += 1
      requestState.signal = init.signal
      if (requests === 1) return new Promise(() => {})
      return response({ agentId: 'retry-after-timeout' })
    },
    setTimer: callback => {
      timerState.callback = callback
      return 'timer'
    },
    clearTimer: () => {},
    timeoutMs: 1,
  })
  const pending = subject.controller.resume(identity)
  assert(timerState.callback)
  timerState.callback()
  assert.deepEqual(await pending, { status: 'failed', uncertain: true })
  assert.equal(requestState.signal?.aborted, true)
  assert.equal(requests, 1)
  assert.deepEqual(subject.events, ['error:Agent session resume timed out; the outcome is uncertain'])
  assert.deepEqual(await subject.controller.resume(identity), {
    status: 'succeeded',
    agentId: 'retry-after-timeout',
    reused: false,
  })
  assert.equal(requests, 2)
})

test('transport failure terminates without automatic replay', async () => {
  let requests = 0
  const subject = fixture({
    request: async () => {
      requests += 1
      throw new Error('request timed out')
    },
  })
  const outcome = await subject.controller.resume(identity)
  await Promise.resolve()
  assert.equal(requests, 1)
  assert.deepEqual(outcome, { status: 'failed', uncertain: true })
  assert.deepEqual(subject.events, ['error:request timed out'])
})
