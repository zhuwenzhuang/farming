import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ownerUrlWithRotatedToken,
  requestOwnerTokenRotation,
  requestQrShareTicket,
  revokeQrShareTicket,
} from '../src/lib/qr-share-ticket'
import type { WorkspaceShareTarget } from '../src/lib/workspace-share-target'

const FAILURE_MESSAGE = 'Could not create a share link'
const completeTicket = (overrides: Record<string, unknown> = {}) => ({
  code: 'SHARE1',
  expiresAt: Date.now() + 300_000,
  ttlMs: 300_000,
  shortPath: '/j/SHARE1',
  shortUrl: 'https://host/j/SHARE1',
  longUrl: 'https://host/long',
  fullAccessUrl: 'https://host/full',
  shortUrlAccessMode: 'owner',
  longUrlAccessMode: 'read-only',
  tokenLabel: 'owner-token',
  ...overrides,
})

const fileTarget: WorkspaceShareTarget = {
  kind: 'file',
  filePath: 'src/index.ts',
  view: 'editor',
}

test('a ticket request posts JSON to the share ticket route', async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []
  await requestQrShareTicket(fileTarget, FAILURE_MESSAGE, async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    return { ok: true, status: 200, async json() { return completeTicket({ longUrl: 'https://host/s/long' }) } }
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
    return { ok: true, status: 200, async json() { return completeTicket({ longUrl: 'https://host/s/long' }) } }
  }

  await requestQrShareTicket(fileTarget, FAILURE_MESSAGE, request)
  await requestQrShareTicket(null, FAILURE_MESSAGE, request)
  await requestQrShareTicket(undefined, FAILURE_MESSAGE, request)

  assert.deepEqual(bodies, [JSON.stringify({ target: fileTarget }), '{}', '{}'])
})

test('a ticket preserves owner and delegated access modes', async () => {
  const owner = await requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
    ok: true,
    status: 200,
    async json() { return completeTicket() },
  }))
  const delegated = await requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
    ok: true,
    status: 200,
    async json() {
      return completeTicket({
        shortUrlAccessMode: 'read-only',
        fullAccessUrl: undefined,
        tokenLabel: '',
      })
    },
  }))

  assert.equal(owner.longUrl, 'https://host/long')
  assert.equal(owner.shortUrlAccessMode, 'owner')
  assert.equal(owner.fullAccessUrl, 'https://host/full')
  assert.equal(delegated.shortUrlAccessMode, 'read-only')
  assert.equal(delegated.fullAccessUrl, undefined)
  assert.equal(delegated.tokenLabel, '')
})

test('a ticket ignores malformed response fields at the transport boundary', async () => {
  await assert.rejects(
    requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
      ok: true,
      status: 200,
      async json() { return completeTicket({ longUrl: 123, error: { message: 'unsafe' } }) },
    })),
    new RegExp(FAILURE_MESSAGE),
  )
  await assert.rejects(
    requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
      ok: true,
      status: 200,
      async json() { return completeTicket({ fullAccessUrl: undefined }) },
    })),
    new RegExp(FAILURE_MESSAGE),
  )
  await assert.rejects(
    requestQrShareTicket(null, FAILURE_MESSAGE, async () => ({
      ok: true,
      status: 200,
      async json() { return completeTicket({ shortUrlAccessMode: 'read-only' }) },
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

test('ticket revocation targets only the encoded short code', async () => {
  const calls: Array<{ url: string; method: string }> = []
  await revokeQrShareTicket({ code: 'owner/code with spaces' }, async (url, init) => {
    calls.push({ url, method: init.method })
  })

  assert.deepEqual(calls, [{
    url: '/api/share/qr-ticket/owner%2Fcode%20with%20spaces',
    method: 'DELETE',
  }])
})

test('owner token rotation posts the share target and validates the replacement credential', async () => {
  const calls: Array<{ url: string; body: string }> = []
  const credential = await requestOwnerTokenRotation(fileTarget, FAILURE_MESSAGE, async (url, init) => {
    calls.push({ url, body: init.body })
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          tokenLabel: 'new-owner-token',
          fullAccessUrl: 'https://host/?token=new-owner-token',
        }
      },
    }
  })

  assert.deepEqual(calls, [{
    url: '/api/share/qr-ticket/rotate',
    body: JSON.stringify({ target: fileTarget }),
  }])
  assert.deepEqual(credential, {
    tokenLabel: 'new-owner-token',
    fullAccessUrl: 'https://host/?token=new-owner-token',
  })

  await assert.rejects(
    requestOwnerTokenRotation(null, FAILURE_MESSAGE, async () => ({
      ok: true,
      status: 200,
      async json() { return { tokenLabel: 'new-owner-token' } },
    })),
    new RegExp(FAILURE_MESSAGE),
  )
})

test('owner token URL replacement preserves the current location and changes only token', () => {
  assert.equal(
    ownerUrlWithRotatedToken('https://host/farming/?agent=one&token=old#turn-2', 'new token'),
    'https://host/farming/?agent=one&token=new+token#turn-2',
  )
  assert.equal(
    ownerUrlWithRotatedToken('https://host/farming/', 'new-token'),
    'https://host/farming/?token=new-token',
  )
})
