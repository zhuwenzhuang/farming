import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgentSessionInventoryState,
  reduceAgentSessionInventory,
  type AgentSessionPage,
} from '../src/components/code/agent-session-inventory'
import type { AgentSessionHistoryItem } from '../src/components/code/types'

function session(
  id: string,
  overrides: Partial<AgentSessionHistoryItem> = {},
): AgentSessionHistoryItem {
  return {
    provider: 'codex',
    id,
    title: id,
    cwd: '/workspace',
    updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides,
  }
}

function page(
  sessions: AgentSessionHistoryItem[],
  overrides: Partial<Omit<AgentSessionPage, 'sessions'>> = {},
): AgentSessionPage {
  return {
    sessions,
    nextCursor: '',
    hasMore: false,
    total: sessions.length,
    ...overrides,
  }
}

test('replaces the first page and resets the loaded count to the current inventory', () => {
  const initial = createAgentSessionInventoryState(2)
  const expanded = reduceAgentSessionInventory(initial, {
    type: 'first-page-replaced',
    page: page([
      session('one'),
      session('two'),
      session('three'),
    ], { nextCursor: 'cursor-3', hasMore: true, total: 5 }),
  })
  const refreshed = reduceAgentSessionInventory(expanded, {
    type: 'first-page-replaced',
    page: page([session('new-one')], { nextCursor: 'cursor-new', hasMore: true, total: 4 }),
  })

  assert.deepEqual(refreshed.sessions.map(item => item.id), ['new-one'])
  assert.equal(refreshed.nextCursor, 'cursor-new')
  assert.equal(refreshed.hasMore, true)
  assert.equal(refreshed.total, 4)
  assert.equal(refreshed.loadedCount, 2)
})

test('appends unique exact session identities in cursor order', () => {
  const firstPage = reduceAgentSessionInventory(createAgentSessionInventoryState(2), {
    type: 'first-page-replaced',
    page: page([
      session('same'),
      session('home-session', { providerHomeId: 'one' }),
    ], { nextCursor: 'cursor-2', hasMore: true, total: 4 }),
  })
  const appended = reduceAgentSessionInventory(firstPage, {
    type: 'page-appended',
    page: page([
      session('same'),
      session('home-session', { providerHomeId: 'two' }),
      session('last'),
    ], { nextCursor: '', hasMore: false, total: 4 }),
  })

  assert.deepEqual(
    appended.sessions.map(item => `${item.providerHomeId || 'default'}:${item.id}`),
    ['default:same', 'one:home-session', 'two:home-session', 'default:last'],
  )
  assert.equal(appended.loadedCount, 4)
  assert.equal(appended.total, 4)
})

test('does not mutate the previous inventory while appending', () => {
  const originalSessions = [session('one')]
  const original = reduceAgentSessionInventory(createAgentSessionInventoryState(2), {
    type: 'first-page-replaced',
    page: page(originalSessions, { nextCursor: 'cursor-1', hasMore: true }),
  })
  const appended = reduceAgentSessionInventory(original, {
    type: 'page-appended',
    page: page([session('two')]),
  })

  assert.deepEqual(original.sessions.map(item => item.id), ['one'])
  assert.deepEqual(originalSessions.map(item => item.id), ['one'])
  assert.deepEqual(appended.sessions.map(item => item.id), ['one', 'two'])
})

test('preserves total and loaded-count metadata when a visible page is refreshed after pinning', () => {
  const state = reduceAgentSessionInventory(createAgentSessionInventoryState(2), {
    type: 'first-page-replaced',
    page: page([session('one'), session('two'), session('three')], {
      nextCursor: 'cursor-3',
      hasMore: true,
      total: 9,
    }),
  })
  const replaced = reduceAgentSessionInventory(state, {
    type: 'visible-page-replaced',
    page: page([session('two', { pinned: true }), session('one')], {
      nextCursor: 'cursor-2',
      hasMore: true,
      total: 8,
    }),
  })

  assert.deepEqual(replaced.sessions.map(item => item.id), ['two', 'one'])
  assert.equal(replaced.nextCursor, 'cursor-2')
  assert.equal(replaced.hasMore, true)
  assert.equal(replaced.total, 9)
  assert.equal(replaced.loadedCount, 3)
})

test('marks only the exact provider-home session as resumed', () => {
  const state = reduceAgentSessionInventory(createAgentSessionInventoryState(60), {
    type: 'first-page-replaced',
    page: page([
      session('same', { providerHomeId: 'one', archived: true }),
      session('same', { providerHomeId: 'two', archived: true }),
      session('same', { provider: 'claude', providerHomeId: 'one', archived: true }),
    ]),
  })
  const resumed = reduceAgentSessionInventory(state, {
    type: 'session-resumed',
    provider: 'codex',
    providerHomeId: 'one',
    sessionId: 'same',
  })

  assert.deepEqual(resumed.sessions.map(item => item.archived), [false, true, true])
})
