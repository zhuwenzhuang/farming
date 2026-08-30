import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createQrCodeFactoryLoader,
  type QrCodeFactory,
  type QrCodeModule,
} from '../src/components/code/ShareQrButton'

const fakeFactory = (() => undefined) as unknown as QrCodeFactory

test('coalesces concurrent QR renderer loads and caches a successful factory', async () => {
  let resolveModule: ((module: QrCodeModule) => void) | undefined
  let calls = 0
  const modulePromise = new Promise<QrCodeModule>(resolve => { resolveModule = resolve })
  const load = createQrCodeFactoryLoader(() => {
    calls += 1
    return modulePromise
  })

  const first = load()
  const concurrent = load()
  assert.strictEqual(concurrent, first)
  assert.equal(calls, 0)

  resolveModule?.({ default: fakeFactory })
  assert.strictEqual(await first, fakeFactory)
  assert.strictEqual(await load(), fakeFactory)
  assert.equal(calls, 1)
})

test('allows an explicit retry after a network failure', async () => {
  let calls = 0
  const load = createQrCodeFactoryLoader(async () => {
    calls += 1
    if (calls === 1) throw new Error('chunk request failed')
    return { default: fakeFactory }
  })

  await assert.rejects(load(), /chunk request failed/)
  assert.strictEqual(await load(), fakeFactory)
  assert.equal(calls, 2)
})

test('allows an explicit retry after an invalid renderer module', async () => {
  let calls = 0
  const load = createQrCodeFactoryLoader(async () => {
    calls += 1
    return calls === 1 ? {} : { qrcode: fakeFactory }
  })

  await assert.rejects(load(), /QR renderer failed to load/)
  assert.strictEqual(await load(), fakeFactory)
  assert.equal(calls, 2)
})
