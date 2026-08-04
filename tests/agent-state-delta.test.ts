import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentStateDeltaDisposition,
  applyAgentStateDelta,
} from '../src/lib/agent-state-delta'

test('Agent state deltas require one continuous generation sequence', () => {
  const cursor = { generation: 'server-1', sequence: 7 }
  assert.equal(agentStateDeltaDisposition(cursor, 'server-1', 8), 'apply')
  assert.equal(agentStateDeltaDisposition(cursor, 'server-1', 7), 'ignore')
  assert.equal(agentStateDeltaDisposition(cursor, 'server-1', 10), 'resync')
  assert.equal(agentStateDeltaDisposition(cursor, 'server-2', 8), 'resync')
  assert.equal(agentStateDeltaDisposition(null, 'server-1', 1), 'resync')
})

test('Agent state deltas replace only changed Agents and preserve stable entries', () => {
  const first = { id: 'a', status: 'running' }
  const stable = { id: 'b', status: 'waiting' }
  const added = { id: 'c', status: 'running' }
  const result = applyAgentStateDelta(
    [first, stable],
    [{ id: 'a', status: 'waiting' }, added],
    [],
  )
  assert.deepEqual(result.map(agent => agent.id), ['a', 'b', 'c'])
  assert.equal(result[1], stable)
  assert.equal(result[0].status, 'waiting')
})

test('Agent removals win over same-batch upserts', () => {
  const result = applyAgentStateDelta(
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'a' }, { id: 'c' }],
    ['a'],
  )
  assert.deepEqual(result.map(agent => agent.id), ['b', 'c'])
})
