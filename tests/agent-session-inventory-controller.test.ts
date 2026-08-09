import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentSessionInventoryRequestLifecycle,
  type AgentSessionInventoryRequestLifecyclePorts,
} from '../src/components/code/useAgentSessionInventoryController'
import type { AgentSessionPage } from '../src/components/code/agent-session-inventory'

const page = (id: string): AgentSessionPage => ({
  sessions: [{
    provider: 'codex',
    id,
    title: id,
    cwd: '/workspace',
    updatedAt: '2026-08-09T00:00:00.000Z',
  }],
  nextCursor: '',
  hasMore: false,
  total: 1,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function createHarness() {
  const requests: Array<{ options: object; deferred: ReturnType<typeof deferred<AgentSessionPage>> }> = []
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let nextTimer = 1
  let paging = { hasMore: true, nextCursor: 'next' }
  const replaced: AgentSessionPage[] = []
  const visibleReplaced: AgentSessionPage[] = []
  const appended: AgentSessionPage[] = []
  const ports: AgentSessionInventoryRequestLifecyclePorts = {
    fetchPage: options => {
      const pending = deferred<AgentSessionPage>()
      requests.push({ options: options ?? {}, deferred: pending })
      return pending.promise
    },
    replaceFirstPage: result => replaced.push(result),
    replaceVisiblePage: result => visibleReplaced.push(result),
    appendPage: result => appended.push(result),
    getPaging: () => paging,
    setFreshLoading: () => {},
    setFreshError: () => {},
    freshErrorMessage: () => 'failed',
    setTimer: (callback, delay) => {
      const id = nextTimer++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer: timer => { timers.delete(timer) },
    createAbortController: () => new AbortController(),
  }
  return {
    lifecycle: new AgentSessionInventoryRequestLifecycle(ports),
    requests,
    timers,
    replaced,
    visibleReplaced,
    appended,
    setPaging: (next: typeof paging) => { paging = next },
  }
}

test('deduplicates matching first-page requests', async () => {
  const harness = createHarness()
  const first = harness.lifecycle.fetchFirstPage()
  const second = harness.lifecycle.fetchFirstPage()
  assert.strictEqual(first, second)
  assert.equal(harness.requests.length, 1)
  harness.requests[0]!.deferred.resolve(page('one'))
  await first
})

test('fresh load aborts the old request and rejects its late result', async () => {
  const harness = createHarness()
  harness.lifecycle.load()
  harness.lifecycle.load(true)
  assert.equal(harness.requests.length, 2)
  assert.equal((harness.requests[0]!.options as { signal: AbortSignal }).signal.aborted, true)
  harness.requests[0]!.deferred.resolve(page('old'))
  harness.requests[1]!.deferred.resolve(page('new'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(harness.replaced.map(result => result.sessions[0]!.id), ['new'])
})

test('fresh background scheduling replaces the quiet timer', () => {
  const harness = createHarness()
  harness.lifecycle.scheduleBackgroundLoad()
  harness.lifecycle.scheduleBackgroundLoad(true)
  assert.equal(harness.timers.size, 1)
  const timer = [...harness.timers.values()][0]!
  assert.equal(timer.delay, 30_000)
  timer.callback()
  assert.equal(harness.requests.length, 1)
  assert.equal((harness.requests[0]!.options as { fresh?: boolean }).fresh, true)
})

test('loads one cursor page for concurrent load-more requests', async () => {
  const harness = createHarness()
  const first = harness.lifecycle.loadMore()
  const second = harness.lifecycle.loadMore()
  assert.equal(harness.requests.length, 1)
  assert.equal(await second, false)
  harness.requests[0]!.deferred.resolve(page('next'))
  assert.equal(await first, true)
  assert.deepEqual(harness.appended.map(result => result.sessions[0]!.id), ['next'])
})

test('dispose cancels active work and prevents late replacement', async () => {
  const harness = createHarness()
  harness.lifecycle.load()
  const pending = harness.requests[0]!
  harness.lifecycle.scheduleBackgroundLoad()
  harness.lifecycle.dispose()
  assert.equal((pending.options as { signal: AbortSignal }).signal.aborted, true)
  assert.equal(harness.timers.size, 0)
  pending.deferred.resolve(page('late'))
  await Promise.resolve()
  assert.deepEqual(harness.replaced, [])
})

test('a newer first-page generation rejects a late load-more page', async () => {
  const harness = createHarness()
  const loadMore = harness.lifecycle.loadMore()
  harness.lifecycle.load(true)
  harness.requests[0]!.deferred.resolve(page('stale-cursor'))
  assert.equal(await loadMore, false)
  assert.deepEqual(harness.appended, [])
  harness.requests[1]!.deferred.resolve(page('fresh'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(harness.replaced.map(result => result.sessions[0]!.id), ['fresh'])
})

test('only the newest visible-page refresh may replace the inventory', async () => {
  const harness = createHarness()
  const older = harness.lifecycle.refreshVisiblePage(60)
  const newer = harness.lifecycle.refreshVisiblePage(60)
  harness.requests[0]!.deferred.resolve(page('older'))
  assert.equal(await older, false)
  harness.requests[1]!.deferred.resolve(page('newer'))
  assert.equal(await newer, true)
  assert.deepEqual(harness.visibleReplaced.map(result => result.sessions[0]!.id), ['newer'])
})
