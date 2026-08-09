import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initialProjectMembershipState,
  projectMembershipReducer,
  projectMountResult,
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
  const result = await requestProjectMount(' /repo/// ', async (_url, init) => {
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
    requestProjectMount('/repo', async () => ({
      ok: false,
      status: 409,
      async json() { return { error: 'mount conflict' } },
    })),
    /mount conflict/,
  )
})
