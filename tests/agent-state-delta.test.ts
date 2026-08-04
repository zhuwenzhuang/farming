import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceAgentStateSnapshot,
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

test('Agent state snapshot pages replace once, append contiguously, and finish exactly', () => {
  const first = advanceAgentStateSnapshot(null, 'server-1', 7, {
    complete: false,
    id: 'snapshot-1',
    offset: 0,
    total: 5,
  }, 2)
  assert.equal(first.disposition, 'replace')
  assert.deepEqual(first.cursor, {
    generation: 'server-1',
    sequence: 7,
    id: 'snapshot-1',
    nextOffset: 2,
    total: 5,
  })

  const middle = advanceAgentStateSnapshot(first.cursor, 'server-1', 7, {
    complete: false,
    id: 'snapshot-1',
    offset: 2,
    total: 5,
  }, 2)
  assert.equal(middle.disposition, 'append')
  assert.equal(middle.cursor?.nextOffset, 4)

  const last = advanceAgentStateSnapshot(middle.cursor, 'server-1', 7, {
    complete: true,
    id: 'snapshot-1',
    offset: 4,
    total: 5,
  }, 1)
  assert.equal(last.disposition, 'append')
  assert.equal(last.cursor, null)

  const replacement = advanceAgentStateSnapshot(middle.cursor, 'server-1', 8, {
    complete: false,
    id: 'snapshot-2',
    offset: 0,
    total: 3,
  }, 1)
  assert.equal(replacement.disposition, 'replace')
  assert.equal(replacement.cursor?.id, 'snapshot-2')
  assert.equal(replacement.cursor?.sequence, 8)
})

test('Agent state snapshot pages resync on gaps, identity changes, or false completion', () => {
  const cursor = {
    generation: 'server-1',
    sequence: 7,
    id: 'snapshot-1',
    nextOffset: 2,
    total: 5,
  }
  assert.equal(advanceAgentStateSnapshot(cursor, 'server-1', 7, {
    complete: false,
    id: 'snapshot-1',
    offset: 3,
    total: 5,
  }, 1).disposition, 'resync')
  assert.equal(advanceAgentStateSnapshot(cursor, 'server-1', 7, {
    complete: false,
    id: 'snapshot-2',
    offset: 2,
    total: 5,
  }, 1).disposition, 'resync')
  assert.equal(advanceAgentStateSnapshot(null, 'server-1', 7, {
    complete: true,
    id: 'snapshot-1',
    offset: 0,
    total: 5,
  }, 2).disposition, 'resync')
  assert.equal(advanceAgentStateSnapshot(null, 'server-1', 7, {
    complete: false,
    id: 'snapshot-1',
    offset: 6,
    total: 5,
  }, 0).disposition, 'resync')
  assert.equal(advanceAgentStateSnapshot(null, 'server-1', 7, {
    complete: true,
    id: 'snapshot-1',
    offset: 4,
    total: 5,
  }, 2).disposition, 'resync')
})
