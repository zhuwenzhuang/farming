import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initialProjectMembershipState,
  projectMembershipReducer,
  projectMountResult,
  ProjectNamesController,
  requestProjectMount,
} from '../src/components/code/useProjectMembershipController'

test('authoritative project workspace updates mark membership loaded and normalize paths', () => {
  const state = projectMembershipReducer(initialProjectMembershipState, {
    projectWorkspaces: ['/repo/', '/repo', ' /other/ '],
  })

  assert.deepEqual(state, {
    projectWorkspaces: ['/repo', '/other'],
    projectWorkspacesLoaded: true,
    pinnedProjectWorkspaces: [],
  })
})

test('partial authoritative updates retain the other membership field', () => {
  const projects = projectMembershipReducer(initialProjectMembershipState, {
    projectWorkspaces: ['/one'],
  })
  const pinned = projectMembershipReducer(projects, {
    pinnedProjectWorkspaces: ['/one', '/two/'],
  })
  const nextProjects = projectMembershipReducer(pinned, {
    projectWorkspaces: ['/three'],
  })

  assert.deepEqual(pinned.projectWorkspaces, ['/one'])
  assert.deepEqual(nextProjects.pinnedProjectWorkspaces, ['/one', '/two'])
  assert.equal(nextProjects.projectWorkspacesLoaded, true)
})

test('mount results update only membership fields returned by the server', () => {
  const current = {
    projectWorkspaces: ['/one'],
    projectWorkspacesLoaded: true,
    pinnedProjectWorkspaces: ['/one'],
  }
  const result = projectMountResult('/two', {
    workspace: '/two',
    projectWorkspaces: ['/one', '/two/'],
  })
  const next = projectMembershipReducer(current, result.membership)

  assert.equal(result.workspace, '/two')
  assert.deepEqual(next.projectWorkspaces, ['/one', '/two'])
  assert.deepEqual(next.pinnedProjectWorkspaces, ['/one'])
})

test('mount result keeps authoritative state when a successful response omits membership', () => {
  const current = {
    projectWorkspaces: ['/one'],
    projectWorkspacesLoaded: true,
    pinnedProjectWorkspaces: ['/one'],
  }
  const result = projectMountResult('/two', { workspace: '/two' })
  const next = projectMembershipReducer(current, result.membership)

  assert.equal(result.workspace, '/two')
  assert.deepEqual(next, current)
})

test('mount request preserves normalization and only returns accepted membership', async () => {
  let capturedBody = ''
  const result = await requestProjectMount(' /repo/// ', undefined, async (_url, init) => {
    capturedBody = init.body
    return {
      ok: true,
      status: 200,
      async json() {
        return { workspace: '/repo', projectWorkspaces: ['/repo'] }
      },
    }
  })

  assert.equal(capturedBody, JSON.stringify({ workspace: '/repo' }))
  assert.equal(result.workspace, '/repo')
  assert.ok(result.membership)
  assert.deepEqual(result.membership.projectWorkspaces, ['/repo'])
})

test('mount rejection exposes the server error without returning membership to apply', async () => {
  await assert.rejects(
    requestProjectMount('/repo', undefined, async () => ({
      ok: false,
      status: 409,
      async json() { return { error: 'mount conflict' } },
    })),
    /mount conflict/,
  )
})

test('an aborted late body cannot return membership for application', async () => {
  let resolveBody!: (value: unknown) => void
  const body = new Promise<unknown>(resolve => { resolveBody = resolve })
  const abortController = new AbortController()
  const pending = requestProjectMount('/repo', abortController.signal, async (_url, init) => {
    assert.equal(init.signal, abortController.signal)
    return {
      ok: true,
      status: 200,
      json: () => body,
    }
  })

  abortController.abort()
  resolveBody({ workspace: '/repo', projectWorkspaces: ['/repo'] })
  await assert.rejects(pending, error => (
    error instanceof DOMException && error.name === 'AbortError'
  ))
})

test('initial project names apply only for the guarded request', () => {
  const controller = new ProjectNamesController()
  const guard = controller.captureInitialSettingsGuard()
  controller.receiveInitialSettings({ '/repo': ' Repo ' }, guard)
  assert.deepEqual(controller.getSnapshot().names, { '/repo': 'Repo' })
})

test('a superseded settings request cannot apply stale project names', () => {
  const controller = new ProjectNamesController()
  const staleGuard = controller.captureInitialSettingsGuard()
  const latestGuard = controller.captureInitialSettingsGuard()
  controller.receiveInitialSettings({ '/repo': 'Latest' }, latestGuard)
  controller.receiveInitialSettings({ '/repo': 'Stale' }, staleGuard)
  assert.deepEqual(controller.getSnapshot().names, { '/repo': 'Latest' })
})

test('an initial settings read cannot overwrite a rename that landed after it started', () => {
  const controller = new ProjectNamesController()
  const guard = controller.captureInitialSettingsGuard()
  // A rename lands while the settings response is still in flight.
  controller.replaceProjectName('/repo', 'Renamed')
  controller.receiveInitialSettings({ '/repo': 'Old name' }, guard)
  assert.deepEqual(controller.getSnapshot().names, { '/repo': 'Renamed' })
})

test('rename rollback uses compare-and-swap against the optimistic name', () => {
  const controller = new ProjectNamesController()
  controller.replaceProjectName('/repo', 'Optimistic')
  // A newer rename replaced the optimistic value; the stale rollback loses.
  controller.replaceProjectName('/repo', 'Newer')
  controller.replaceProjectName('/repo', 'Original', 'Optimistic')
  assert.deepEqual(controller.getSnapshot().names, { '/repo': 'Newer' })
  // A matching expectation still applies, including deletion.
  controller.replaceProjectName('/repo', null, 'Newer')
  assert.deepEqual(controller.getSnapshot().names, {})
})

test('project name subscribers observe published changes exactly once per change', () => {
  const controller = new ProjectNamesController()
  let notifications = 0
  const unsubscribe = controller.subscribe(() => { notifications += 1 })
  controller.replaceProjectName('/repo', 'Repo')
  controller.replaceProjectName('/repo', 'Repo')
  assert.equal(notifications, 1)
  unsubscribe()
  controller.replaceProjectName('/repo', 'Changed')
  assert.equal(notifications, 1)
})
