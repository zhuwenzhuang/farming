import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '../src/types/agent'
import type { ProjectGroup } from '../src/components/code/types'
import { unreadAgentTargets, unreadSwipeThreshold } from '../src/components/code/mobile-unread-navigation'

const agent = (id: string, overrides: Partial<Agent> = {}) => ({
  id, status: 'running', unread: true, customTitle: id, ...overrides,
} as Agent)
const project = (name: string, agents: Agent[]): ProjectGroup => ({
  id: name, name, workspace: `/${name}`, agents, agentSessions: [],
  hasMain: false, hasProjectAgent: true, hasAgentSession: false,
})

test('continues in Project order, wraps once and excludes read, current, archived and hidden Agents', () => {
  const projects = [project('one', [agent('earlier'), agent('current'), agent('read', { unread: false })]),
    project('two', [agent('next'), agent('archived', { archived: true }), agent('main', { isMain: true })])]
  assert.deepEqual(unreadAgentTargets(projects, 'current').map(target => target.key), ['agent:next', 'agent:earlier'])
  projects[1].agents[0].unread = false
  assert.deepEqual(unreadAgentTargets(projects, 'current').map(target => target.key), ['agent:earlier'])
  projects[0].agents[0].unread = false
  assert.deepEqual(unreadAgentTargets(projects, 'current'), [])
})

test('includes cold unread Sessions with exact provider Home identity and excludes archived sessions', () => {
  const group = project('one', [agent('current')])
  group.agentSessions = ['home-a', 'home-b'].map(providerHomeId => ({
    provider: 'codex', providerHomeId, id: 'same-id', title: providerHomeId, cwd: '/one', updatedAt: '', unread: true,
  }))
  const targets = unreadAgentTargets([group], 'current')
  assert.equal(targets.length, 2)
  assert.notEqual(targets[0].key, targets[1].key)
  group.agentSessions[0].archived = true
  assert.deepEqual(unreadAgentTargets([group], 'current').map(target => target.title), ['home-b'])
})

test('uses a bounded quarter-width gesture threshold', () => {
  assert.equal(unreadSwipeThreshold(320), 80)
  assert.equal(unreadSwipeThreshold(390), 97.5)
  assert.equal(unreadSwipeThreshold(980), 120)
})
