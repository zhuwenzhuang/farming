import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '../src/types/agent'
import {
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
