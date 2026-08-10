import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProjectMutationController,
  type ProjectMutationPorts,
} from '../src/components/code/useProjectMutationController'
import { normalizeProjectNames } from '../src/components/code/useProjectMembershipController'

test('project name normalization accepts only authoritative strings', () => {
  assert.deepEqual(normalizeProjectNames({
    '/valid': ' Valid ',
    '/number': 42,
    '/object': { label: 'wrong' },
    '': 'empty workspace',
  }), { '/valid': 'Valid' })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function response(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body }
}

const settings = (projectNames: Record<string, string> = {}) => response({
  settings: {
    projectNames,
    projectWorkspaces: ['/one', '/two'],
    pinnedProjectWorkspaces: ['/one'],
  },
})

function fixture(overrides: Partial<ProjectMutationPorts> = {}) {
  const events: string[] = []
  const names: Record<string, string> = { '/one': 'One', '/two': 'Two' }
  let requests = 0
  const ports: ProjectMutationPorts = {
    applyProjectMembership: value => events.push(`membership:${JSON.stringify(value)}`),
    replaceProjectName: (workspace, name, expected) => {
      if (expected !== undefined && names[workspace] !== expected) return
      if (name === null) delete names[workspace]
      else names[workspace] = name
      events.push(`name:${workspace}:${name ?? '<none>'}`)
    },
    showError: message => events.push(`error:${message}`),
    request: async url => {
      requests += 1
      if (url.endsWith('/api/settings')) return settings(names)
      return response({ projectWorkspaces: ['/one', '/two'], pinnedProjectWorkspaces: ['/one'] })
    },
    ...overrides,
  }
  return {
    controller: new ProjectMutationController(ports),
    events,
    names,
    requests: () => requests,
  }
}

test('applies runtime-validated authoritative membership after pin', async () => {
  const subject = fixture()
  const outcome = await subject.controller.mutate({
    kind: 'pin', workspace: '/two', pinned: true, errorMessage: 'pin failed',
  })
  assert.deepEqual(outcome, { status: 'succeeded' })
  assert.deepEqual(subject.events, [
    'membership:{"projectWorkspaces":["/one","/two"],"pinnedProjectWorkspaces":["/one"]}',
  ])
})

test('serializes distinct membership mutations and joins a queued signature', async () => {
  const firstGate = deferred<ReturnType<typeof response>>()
  let mutations = 0
  const subject = fixture({
    request: async url => {
      if (url.endsWith('/api/settings')) return settings()
      mutations += 1
      if (mutations === 1) return firstGate.promise
      return response({ projectWorkspaces: ['/two'], pinnedProjectWorkspaces: [] })
    },
  })
  const first = subject.controller.mutate({ kind: 'pin', workspace: '/one', pinned: false, errorMessage: 'failed' })
  const second = subject.controller.mutate({ kind: 'remove', workspace: '/one', errorMessage: 'failed' })
  const joined = subject.controller.mutate({ kind: 'remove', workspace: '/one', errorMessage: 'different copy' })
  assert.equal(second, joined)
  assert.equal(mutations, 1)
  firstGate.resolve(response({ projectWorkspaces: ['/one', '/two'], pinnedProjectWorkspaces: [] }))
  await first
  assert.deepEqual(await second, { status: 'succeeded' })
  assert.equal(mutations, 2)
})

test('preserves an explicit A-B-A membership sequence while joining adjacent duplicates', async () => {
  const firstGate = deferred<ReturnType<typeof response>>()
  let mutations = 0
  const subject = fixture({
    request: async url => {
      if (url.endsWith('/api/settings')) return settings()
      mutations += 1
      if (mutations === 1) return firstGate.promise
      return response({ projectWorkspaces: ['/one', '/two'], pinnedProjectWorkspaces: [] })
    },
  })
  const input = { kind: 'pin' as const, workspace: '/one', pinned: true, errorMessage: 'failed' }
  const first = subject.controller.mutate(input)
  const second = subject.controller.mutate({ ...input, pinned: false })
  const third = subject.controller.mutate(input)
  const joinedThird = subject.controller.mutate(input)
  assert.equal(third, joinedThird)
  firstGate.resolve(response({ projectWorkspaces: ['/one', '/two'], pinnedProjectWorkspaces: ['/one'] }))
  await Promise.all([first, second, third])
  assert.equal(mutations, 3)
})

test('definitive rename failure conditionally rolls back its optimistic name', async () => {
  const subject = fixture({ request: async () => response({ error: 'rename rejected' }, false, 409) })
  const outcome = await subject.controller.mutate({
    kind: 'rename', workspace: '/one', name: 'Next', previousName: 'One', errorMessage: 'rename failed',
  })
  assert.deepEqual(outcome, { status: 'failed', uncertain: false })
  assert.equal(subject.names['/one'], 'One')
  assert.deepEqual(subject.events, [
    'name:/one:Next',
    'name:/one:One',
    'error:rename rejected',
  ])
})

test('uncertain rename that did not apply restores the authoritative target only', async () => {
  let calls = 0
  const subject = fixture({
    request: async url => {
      calls += 1
      if (url.endsWith('/api/settings')) return settings({ '/one': 'One', '/two': 'Two' })
      throw new Error('network lost')
    },
  })
  const outcome = await subject.controller.mutate({
    kind: 'rename', workspace: '/one', name: 'Next', previousName: 'One', errorMessage: 'rename failed',
  })
  assert.deepEqual(outcome, { status: 'failed', uncertain: true })
  assert.equal(subject.names['/one'], 'One')
  assert.equal(subject.names['/two'], 'Two')
  assert.equal(calls, 2)
})

test('uncertain rename that applied retains the authoritative target', async () => {
  const subject = fixture({
    request: async url => {
      if (url.endsWith('/api/settings')) return settings({ '/one': 'Next', '/two': 'Two' })
      throw new Error('response lost')
    },
  })
  const outcome = await subject.controller.mutate({
    kind: 'rename', workspace: '/one', name: 'Next', previousName: 'One', errorMessage: 'rename failed',
  })
  assert.deepEqual(outcome, { status: 'failed', uncertain: true })
  assert.equal(subject.names['/one'], 'Next')
})

test('rename and membership uncertain reconciliations are isolated', async () => {
  const subject = fixture({
    request: async url => {
      if (url.endsWith('/api/settings')) return settings({ '/one': 'Renamed', '/two': 'Two' })
      throw new Error('transport failed')
    },
  })
  const rename = subject.controller.mutate({
    kind: 'rename', workspace: '/one', name: 'Renamed', previousName: 'One', errorMessage: 'rename failed',
  })
  const pin = subject.controller.mutate({ kind: 'pin', workspace: '/two', pinned: true, errorMessage: 'pin failed' })
  await Promise.all([rename, pin])
  assert.equal(subject.names['/one'], 'Renamed')
  assert(subject.events.some(event => event.startsWith('membership:')))
})

test('two workspace renames reconcile independently', async () => {
  const subject = fixture({
    request: async url => {
      if (url.endsWith('/api/settings')) return settings({ '/one': 'One A', '/two': 'Two B' })
      throw new Error('transport failed')
    },
  })
  const one = subject.controller.mutate({
    kind: 'rename', workspace: '/one', name: 'One A', previousName: 'One', errorMessage: 'failed',
  })
  const two = subject.controller.mutate({
    kind: 'rename', workspace: '/two', name: 'Two B', previousName: 'Two', errorMessage: 'failed',
  })
  await Promise.all([one, two])
  assert.deepEqual(subject.names, { '/one': 'One A', '/two': 'Two B' })
})

test('timeout aborts, reconciles, and never replays the mutation', async () => {
  const timers: Array<() => void> = []
  const mutationSignal: { value?: AbortSignal } = {}
  let mutations = 0
  const subject = fixture({
    request: async (url, init) => {
      if (url.endsWith('/api/settings')) return settings()
      mutations += 1
      mutationSignal.value = init.signal
      return new Promise(() => {})
    },
    setTimer: callback => {
      timers.push(callback)
      return callback
    },
    clearTimer: () => {},
    timeoutMs: 1,
  })
  const pending = subject.controller.mutate({ kind: 'pin', workspace: '/two', pinned: true, errorMessage: 'failed' })
  timers[0]()
  assert.deepEqual(await pending, { status: 'failed', uncertain: true })
  assert.equal(mutationSignal.value?.aborted, true)
  assert.equal(mutations, 1)
})

test('queued membership mutation waits for uncertain predecessor reconciliation', async () => {
  const reconcileGate = deferred<ReturnType<typeof response>>()
  let mutations = 0
  const subject = fixture({
    request: async url => {
      if (url.endsWith('/api/settings')) return reconcileGate.promise
      mutations += 1
      if (mutations === 1) throw new Error('response lost')
      return response({ projectWorkspaces: ['/two'], pinnedProjectWorkspaces: [] })
    },
  })
  const first = subject.controller.mutate({ kind: 'pin', workspace: '/one', pinned: false, errorMessage: 'failed' })
  const queued = subject.controller.mutate({ kind: 'remove', workspace: '/one', errorMessage: 'failed' })
  await Promise.resolve()
  assert.equal(mutations, 1)
  reconcileGate.resolve(settings())
  assert.deepEqual(await first, { status: 'failed', uncertain: true })
  assert.deepEqual(await queued, { status: 'succeeded' })
  assert.equal(mutations, 2)
})

test('reconciliation timeout covers a never-settling response body and terminates its queue', async () => {
  const timers: Array<() => void> = []
  let mutations = 0
  const subject = fixture({
    request: async url => {
      if (url.endsWith('/api/settings')) {
        return { ok: true, status: 200, json: () => new Promise(() => {}) }
      }
      mutations += 1
      throw new Error('response lost')
    },
    setTimer: callback => {
      timers.push(callback)
      return callback
    },
    clearTimer: () => {},
    timeoutMs: 1,
  })
  const first = subject.controller.mutate({ kind: 'pin', workspace: '/one', pinned: false, errorMessage: 'failed' })
  const queued = subject.controller.mutate({ kind: 'remove', workspace: '/one', errorMessage: 'failed' })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(timers.length, 2)
  timers[1]()
  assert.deepEqual(await first, { status: 'failed', uncertain: true })
  assert.deepEqual(await queued, { status: 'failed', uncertain: true })
  assert.equal(mutations, 1)
  assert(subject.events.includes('error:Project state reconciliation timed out'))
})

test('dispose aborts pending and queued mutations without late effects', async () => {
  const signal: { value?: AbortSignal } = {}
  const subject = fixture({
    request: async (_url, init) => {
      signal.value = init.signal
      return new Promise(() => {})
    },
  })
  const first = subject.controller.mutate({ kind: 'pin', workspace: '/one', pinned: true, errorMessage: 'failed' })
  const queued = subject.controller.mutate({ kind: 'remove', workspace: '/two', errorMessage: 'failed' })
  subject.controller.dispose()
  assert.deepEqual(await first, { status: 'stale' })
  assert.deepEqual(await queued, { status: 'stale' })
  assert.equal(signal.value?.aborted, true)
  assert.deepEqual(subject.events, [])
})
