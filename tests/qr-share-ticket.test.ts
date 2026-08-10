import assert from 'node:assert/strict'
import test from 'node:test'
import { requestQrShareTicket } from '../src/lib/qr-share-ticket'
import type { WorkspaceShareTarget } from '../src/lib/workspace-share-target'

const FAILURE_MESSAGE = 'Could not create a share link'

const fileTarget: WorkspaceShareTarget = {
  kind: 'file',
  filePath: 'src/index.ts',
  view: 'editor',
}

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
