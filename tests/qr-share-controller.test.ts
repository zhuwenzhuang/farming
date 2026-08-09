import assert from 'node:assert/strict'
import test from 'node:test'
import {
  QrShareLifecycle,
  requestQrShareTicket,
  type QrSharePorts,
} from '../src/components/code/useQrShareController'
import type { WorkspaceShareTarget } from '../src/lib/workspace-share-target'

const FAILURE_MESSAGE = 'Could not create a share link'

const fileTarget: WorkspaceShareTarget = {
  kind: 'file',
  filePath: 'src/index.ts',
  view: 'editor',
}

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
  const requests: Array<{
    target: WorkspaceShareTarget | null | undefined
    deferred: ReturnType<typeof deferred<string>>
  }> = []
  const published: string[] = []
  const errors: string[] = []
  const ports: QrSharePorts = {
    createTicket: target => {
      const pending = deferred<string>()
      requests.push({ target, deferred: pending })
      return pending.promise
    },
    publishUrl: url => published.push(url),
    failureMessage: () => FAILURE_MESSAGE,
    reportError: message => errors.push(message),
  }
  return { lifecycle: new QrShareLifecycle(ports), requests, published, errors }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('a ticket request posts JSON to the share ticket route', async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []
  await requestQrShareTicket(fileTarget, FAILURE_MESSAGE, async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    return { ok: true, status: 200, async json() { return { longUrl: 'https://host/s/long' } } }
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, '/api/share/qr-ticket')
  assert.equal(calls[0]!.method, 'POST')
  assert.deepEqual(calls[0]!.headers, { 'Content-Type': 'application/json' })
})

test('a ticket request sends the exact target body and omits an absent target', async () => {
  const bodies: string[] = []
  const request = async (_url: string, init: { body: string }) => {
    bodies.push(init.body)
    return { ok: true, status: 200, async json() { return { longUrl: 'https://host/s/long' } } }
  }

  await requestQrShareTicket(fileTarget, FAILURE_MESSAGE, request)
  await requestQrShareTicket(null, FAILURE_MESSAGE, request)
  await requestQrShareTicket(undefined, FAILURE_MESSAGE, request)

  assert.deepEqual(bodies, [JSON.stringify({ target: fileTarget }), '{}', '{}'])
})

test('a ticket prefers the long URL and falls back to the short URL', async () => {
  const both = await requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
    ok: true,
    status: 200,
    async json() { return { longUrl: 'https://host/long', shortUrl: 'https://host/s' } },
  }))
  const shortOnly = await requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
    ok: true,
    status: 200,
    async json() { return { shortUrl: 'https://host/s' } },
  }))

  assert.equal(both, 'https://host/long')
  assert.equal(shortOnly, 'https://host/s')
})

test('a ticket ignores malformed response fields at the transport boundary', async () => {
  const validFallback = await requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
    ok: true,
    status: 200,
    async json() { return { longUrl: 123, shortUrl: 'https://host/s' } },
  }))
  assert.equal(validFallback, 'https://host/s')

  await assert.rejects(
    requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
      ok: true,
      status: 200,
      async json() { return { longUrl: 123, shortUrl: {}, error: { message: 'unsafe' } } },
    })),
    new RegExp(FAILURE_MESSAGE),
  )
})

test('a rejected or URL-less ticket response reports the server error or the view fallback', async () => {
  await assert.rejects(
    requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
      ok: false,
      status: 409,
      async json() { return { error: 'Read-only sharing requires token authentication.' } },
    })),
    /Read-only sharing requires token authentication\./,
  )
  await assert.rejects(
    requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
      ok: true,
      status: 200,
      async json() { return {} },
    })),
    new RegExp(FAILURE_MESSAGE),
  )
  await assert.rejects(
    requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
      ok: false,
      status: 500,
      async json() { throw new Error('not json') },
    })),
    new RegExp(FAILURE_MESSAGE),
  )
})

test('only the newest ticket request may publish its URL', async () => {
  const harness = createHarness()
  harness.lifecycle.create(fileTarget)
  harness.lifecycle.create(null)
  assert.deepEqual(harness.requests.map(request => request.target), [fileTarget, null])

  harness.requests[1]!.deferred.resolve('https://host/fresh')
  harness.requests[0]!.deferred.resolve('https://host/stale')
  await settle()

  assert.deepEqual(harness.published, ['https://host/fresh'])
  assert.deepEqual(harness.errors, [])
})

test('a stale ticket failure cannot overwrite the newest request', async () => {
  const harness = createHarness()
  harness.lifecycle.create(fileTarget)
  harness.lifecycle.create(null)

  harness.requests[0]!.deferred.reject(new Error('stale transport failure'))
  harness.requests[1]!.deferred.resolve('https://host/fresh')
  await settle()

  assert.deepEqual(harness.errors, [])
  assert.deepEqual(harness.published, ['https://host/fresh'])
})

test('clearing revokes in-flight requests so no late success or failure is admitted', async () => {
  const harness = createHarness()
  harness.lifecycle.create(fileTarget)
  harness.lifecycle.clear()
  harness.requests[0]!.deferred.resolve('https://host/too-late')
  await settle()

  harness.lifecycle.create(fileTarget)
  harness.lifecycle.clear()
  harness.requests[1]!.deferred.reject(new Error('too late'))
  await settle()

  assert.deepEqual(harness.published, ['', ''])
  assert.deepEqual(harness.errors, [])
})

test('reopening after a clear admits only the reopened request', async () => {
  const harness = createHarness()
  harness.lifecycle.create(fileTarget)
  harness.lifecycle.clear()
  harness.lifecycle.create(null)
  harness.requests[0]!.deferred.resolve('https://host/closed')
  harness.requests[1]!.deferred.resolve('https://host/reopened')
  await settle()

  assert.deepEqual(harness.published, ['', 'https://host/reopened'])
  assert.deepEqual(harness.errors, [])
})

test('a failed ticket reports the exact message once and is never replayed', async () => {
  const harness = createHarness()
  harness.lifecycle.create(null)
  harness.requests[0]!.deferred.reject(new Error('share ticket transport failed'))
  await settle()

  assert.deepEqual(harness.errors, ['share ticket transport failed'])
  assert.deepEqual(harness.published, [])
  assert.equal(harness.requests.length, 1)
})

test('a non-error rejection reports the view failure message', async () => {
  const harness = createHarness()
  harness.lifecycle.create(null)
  harness.requests[0]!.deferred.reject('opaque')
  await settle()

  assert.deepEqual(harness.errors, [FAILURE_MESSAGE])
  assert.deepEqual(harness.published, [])
})

test('an aborted ticket request stays silent', async () => {
  const harness = createHarness()
  harness.lifecycle.create(null)
  harness.requests[0]!.deferred.reject(new DOMException('aborted', 'AbortError'))
  await settle()

  assert.deepEqual(harness.errors, [])
  assert.deepEqual(harness.published, [])
})

test('dispose revokes an in-flight ticket without publishing or reporting', async () => {
  const resolved = createHarness()
  resolved.lifecycle.create(null)
  resolved.lifecycle.dispose()
  resolved.requests[0]!.deferred.resolve('https://host/unmounted')
  await settle()

  const rejected = createHarness()
  rejected.lifecycle.create(null)
  rejected.lifecycle.dispose()
  rejected.requests[0]!.deferred.reject(new Error('unmounted failure'))
  await settle()

  assert.deepEqual(resolved.published, [])
  assert.deepEqual(resolved.errors, [])
  assert.deepEqual(rejected.published, [])
  assert.deepEqual(rejected.errors, [])
})
