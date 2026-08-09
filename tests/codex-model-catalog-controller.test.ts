import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODEX_MODEL_CATALOG_TTL_MS,
  CodexModelCatalogLifecycle,
  type CodexModelCatalogPorts,
} from '../src/components/code/useCodexModelCatalogController'
import type { CodexModelOption } from '../src/components/code/types'

const option = (value: string): CodexModelOption => ({ value, label: value })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function createHarness() {
  const requests: Array<{ homeId: string; deferred: ReturnType<typeof deferred<CodexModelOption[]>> }> = []
  const published: CodexModelOption[][] = []
  const errors: string[] = []
  let now = 1_000
  let connected = true
  const ports: CodexModelCatalogPorts = {
    fetchCatalog: homeId => {
      const pending = deferred<CodexModelOption[]>()
      requests.push({ homeId, deferred: pending })
      return pending.promise
    },
    publishOptions: options => published.push(options),
    now: () => now,
    isConnected: () => connected,
    reportError: message => errors.push(message),
  }
  return {
    lifecycle: new CodexModelCatalogLifecycle(ports),
    requests,
    published,
    errors,
    advance: (ms: number) => { now += ms },
    setConnected: (next: boolean) => { connected = next },
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('a cached catalog for the same home is reused until the TTL expires', async () => {
  const harness = createHarness()
  harness.lifecycle.load('default')
  harness.requests[0]!.deferred.resolve([option('gpt-5.5')])
  await settle()

  harness.advance(CODEX_MODEL_CATALOG_TTL_MS)
  harness.lifecycle.load('default')
  assert.equal(harness.requests.length, 1)

  harness.advance(1)
  harness.lifecycle.load('default')
  assert.equal(harness.requests.length, 2)
  assert.deepEqual(harness.published, [[], [option('gpt-5.5')], []])
})

test('switching homes clears the visible catalog and rejects the previous response', async () => {
  const harness = createHarness()
  harness.lifecycle.load('home-a')
  harness.lifecycle.syncHome('home-b')
  harness.lifecycle.load('home-b')
  assert.deepEqual(harness.requests.map(request => request.homeId), ['home-a', 'home-b'])

  harness.requests[0]!.deferred.resolve([option('stale')])
  harness.requests[1]!.deferred.resolve([option('fresh')])
  await settle()

  assert.deepEqual(harness.published, [[], [], [], [option('fresh')]])
  assert.deepEqual(harness.errors, [])

  harness.lifecycle.syncHome('home-b')
  assert.equal(harness.published.length, 4)
})

test('switching back to a still-fresh home restores its cached options without a request', async () => {
  const harness = createHarness()
  harness.lifecycle.load('home-a')
  harness.requests[0]!.deferred.resolve([option('cached-a')])
  await settle()

  harness.lifecycle.syncHome('home-b')
  harness.lifecycle.syncHome('home-a')
  harness.lifecycle.load('home-a')

  assert.equal(harness.requests.length, 1)
  assert.deepEqual(harness.published.at(-1), [option('cached-a')])
})

test('a cancelled load cannot publish options or report its failure', async () => {
  const harness = createHarness()
  const cancel = harness.lifecycle.load('default')
  cancel()
  harness.requests[0]!.deferred.resolve([option('late')])
  await settle()
  assert.deepEqual(harness.published, [[]])

  const failing = harness.lifecycle.load('default')
  failing()
  harness.requests[1]!.deferred.reject(new Error('too late'))
  await settle()
  assert.deepEqual(harness.errors, [])
})

test('a disconnected failure stays silent and is retried exactly once after reconnect', async () => {
  const harness = createHarness()
  harness.setConnected(false)
  harness.lifecycle.load('default')
  harness.requests[0]!.deferred.reject(new Error('network down'))
  await settle()
  assert.deepEqual(harness.errors, [])

  harness.setConnected(true)
  harness.lifecycle.retryAfterReconnect('default')
  harness.lifecycle.retryAfterReconnect('default')
  assert.deepEqual(harness.requests.map(request => request.homeId), ['default', 'default'])

  harness.requests[1]!.deferred.resolve([option('gpt-5.5')])
  await settle()
  assert.deepEqual(harness.published.at(-1), [option('gpt-5.5')])
})

test('disabling the catalog fences an in-flight reconnect retry', async () => {
  const harness = createHarness()
  harness.setConnected(false)
  harness.lifecycle.load('default')
  harness.requests[0]!.deferred.reject(new Error('network down'))
  await settle()

  harness.setConnected(true)
  harness.lifecycle.retryAfterReconnect('default')
  harness.lifecycle.stopReconnectRetry()
  harness.requests[1]!.deferred.resolve([option('too-late')])
  await settle()

  assert.notDeepEqual(harness.published.at(-1), [option('too-late')])
})

test('a home switch replaces an old reconnect retry and disable fences the replacement request', async () => {
  const harness = createHarness()
  harness.setConnected(false)
  harness.lifecycle.load('home-a')
  harness.requests[0]!.deferred.reject(new Error('network down'))
  await settle()

  harness.lifecycle.syncHome('home-b')
  harness.setConnected(true)
  harness.lifecycle.load('home-b')
  harness.lifecycle.retryAfterReconnect('home-b')
  assert.deepEqual(harness.requests.map(request => request.homeId), ['home-a', 'home-b'])

  harness.lifecycle.stopReconnectRetry()
  harness.requests[1]!.deferred.resolve([option('too-late')])
  await settle()
  assert.notDeepEqual(harness.published.at(-1), [option('too-late')])
})

test('a connected failure clears the cache and reports the exact error', async () => {
  const harness = createHarness()
  harness.lifecycle.load('default')
  harness.requests[0]!.deferred.reject(new Error('Failed to load Codex model catalog (500)'))
  await settle()
  assert.deepEqual(harness.errors, ['Failed to load Codex model catalog (500)'])

  harness.lifecycle.load('default')
  assert.equal(harness.requests.length, 2)
})

test('an empty catalog is a failure and is not cached', async () => {
  const harness = createHarness()
  harness.lifecycle.load('default')
  harness.requests[0]!.deferred.resolve([])
  await settle()
  assert.deepEqual(harness.errors, ['Codex model catalog did not contain any visible models'])
  assert.deepEqual(harness.published, [[]])

  harness.lifecycle.load('default')
  assert.equal(harness.requests.length, 2)
})

test('dispose rejects an in-flight response and stops reconnect retries', async () => {
  const harness = createHarness()
  harness.setConnected(false)
  harness.lifecycle.load('default')
  harness.lifecycle.dispose()
  harness.requests[0]!.deferred.reject(new Error('network down'))
  await settle()

  harness.setConnected(true)
  harness.lifecycle.retryAfterReconnect('default')
  assert.equal(harness.requests.length, 1)
  assert.deepEqual(harness.errors, [])
})
