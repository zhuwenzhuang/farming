import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '../src/types/agent'
import {
  agentAfterRemoval,
  mostRecentlyUpdatedAgent,
  resolveActiveAgentId,
} from '../src/components/code/agent-selection'

function agent(
  id: string,
  lastActivity: number,
  overrides: Partial<Agent> = {},
) {
  return {
    id,
    archived: false,
    status: 'idle',
    isMain: false,
    lastActivity,
    startedAt: lastActivity,
    ...overrides,
  } as Agent
}

test('keeps the remembered Agent when it is still available', () => {
  const agents = [agent('remembered', 10), agent('newer', 20)]

  assert.equal(resolveActiveAgentId(agents, 'remembered'), 'remembered')
})

test('falls back to the most recently updated Agent when the remembered Agent is unavailable', () => {
  const agents = [agent('older', 10), agent('latest', 30), agent('middle', 20)]

  assert.equal(resolveActiveAgentId(agents, 'missing'), 'latest')
  assert.equal(mostRecentlyUpdatedAgent(agents)?.id, 'latest')
})

test('does not fall back to Main, archived, stopped, or dead Agents', () => {
  const agents = [
    agent('available', 10),
    agent('main', 50, { isMain: true }),
    agent('archived', 40, { archived: true }),
    agent('stopped', 30, { status: 'stopped' }),
    agent('dead', 20, { status: 'dead' }),
  ]

  assert.equal(resolveActiveAgentId(agents, 'missing'), 'available')
})

test('returns no selection when no Agent can be opened', () => {
  assert.equal(resolveActiveAgentId([agent('stopped', 10, { status: 'stopped' })], 'missing'), null)
})

test('removal follows Project order, choosing next then previous without crossing Projects', () => {
  const rows = [
    agent('other-project', 100, { cwd: '/other' }),
    agent('first', 1, { cwd: '/project', projectOrder: 30 }),
    agent('middle', 90, { cwd: '/project', projectOrder: 20 }),
    agent('last', 3, { cwd: '/project', projectOrder: 10 }),
  ]
  assert.equal(agentAfterRemoval(rows, rows[2], new Set(['middle'])), 'last')
  assert.equal(agentAfterRemoval(rows, rows[3], new Set(['last'])), 'middle')
  assert.equal(agentAfterRemoval(rows, rows[1], new Set(['first', 'middle', 'last'])), null)
})

test('removal skips stopped, archived and Main rows, even if they are newer', () => {
  const current = agent('current', 1, { cwd: '/project' })
  const rows = [
    current,
    agent('stopped', 2, { cwd: '/project', status: 'stopped' }),
    agent('archived', 3, { cwd: '/project', archived: true }),
    agent('main', 4, { cwd: '/project', isMain: true }),
    agent('other', 5, { cwd: '/other' }),
  ]
  assert.equal(agentAfterRemoval(rows, current, new Set(['current'])), null)
  assert.equal(agentAfterRemoval(rows, null, new Set()), null)
})

test('removed inventory identity retains its Project and position; worktree cwd does not define Project ownership', () => {
  const current = agent('removed', 2, { cwd: '/worktree', projectWorkspace: '/project' })
  const rows = [
    agent('previous', 3, { cwd: '/project' }),
    agent('next', 1, { cwd: '/another-worktree', projectWorkspace: '/project' }),
    agent('unrelated', 4, { cwd: '/other' }),
  ]
  assert.equal(agentAfterRemoval(rows, current, new Set(['removed'])), 'next')
  assert.equal(agentAfterRemoval(rows, current, new Set(['removed', 'next'])), 'previous')
})
