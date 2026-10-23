import assert from 'node:assert/strict'
import test from 'node:test'
import { FileLinkAccess, type FileLinkAccessRequest } from '../src/lib/file-link-access'

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

test('deduplicates locations, batches by root, and keeps validation off the rendering path', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const calls: Array<{ root: string; paths: string[] }> = []
  const resolve: Array<(result: { items: Array<{ path: string; accessible: boolean }> }) => void> = []
  const access = new FileLinkAccess((root, paths) => {
    calls.push({ root, paths })
    return new Promise(done => resolve.push(done))
  })
  context.after(() => access.clear())
  const values: boolean[] = []
  access.subscribe('a', 'source.cpp', value => values.push(value))
  access.subscribe('a', 'source.cpp', () => {})
  access.subscribe('a', 'missing.cpp', () => {})
  access.subscribe('b', 'source.cpp', () => {})
  assert.deepEqual(values, [false])
  assert.equal(calls.length, 0)
  context.mock.timers.tick(16)
  assert.deepEqual(calls, [{ root: 'a', paths: ['source.cpp', 'missing.cpp'] }])
  resolve[0]({ items: [{ path: 'source.cpp', accessible: true }] })
  await settle()
  assert.equal(values.at(-1), true)
  context.mock.timers.tick(16)
  assert.equal(calls[1].root, 'b')
  resolve[1]({ items: [] })
  await settle()
  const cached: boolean[] = []
  access.subscribe('a', 'source.cpp', value => cached.push(value))
  access.subscribe('a', 'missing.cpp', value => cached.push(value))
  assert.deepEqual(cached, [true, false])
})

test('bounds batches and retains confirmed references without polling or demotion', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const calls: string[][] = []
  const access = new FileLinkAccess(async (_root, paths) => {
    calls.push(paths)
    return { items: paths.map(path => ({ path, accessible: true })) }
  })
  context.after(() => access.clear())
  for (let i = 0; i < 130; i++) access.subscribe('a', `${i}.ts`, () => {})
  for (let i = 0; i < 3; i++) { context.mock.timers.tick(16); await settle() }
  assert.deepEqual(calls.map(paths => paths.length), [64, 64, 2])
  context.mock.timers.tick(10_000)
  await settle()
  assert.equal(calls.length, 3)
  assert.equal(access.isConfirmed('a', '0.ts'), true)
  context.mock.timers.tick(60_000)
  assert.equal(calls.length, 3)
})

test('unmount and owner replacement reject late results and abort pending work', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let finish!: (result: { items: Array<{ path: string; accessible: boolean }> }) => void
  let signal!: AbortSignal
  const access = new FileLinkAccess((_root, _paths, requestSignal) => {
    signal = requestSignal
    return new Promise(done => { finish = done })
  })
  context.after(() => access.clear())
  const values: boolean[] = []
  const unsubscribe = access.subscribe('a', 'source.cpp', value => values.push(value))
  context.mock.timers.tick(16)
  unsubscribe()
  access.clear()
  assert.equal(signal.aborted, true)
  finish({ items: [{ path: 'source.cpp', accessible: true }] })
  await settle()
  assert.equal(values.includes(true), false)
})

test('timeout and access failure remain non-clickable', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const request: FileLinkAccessRequest = (_root, _paths, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
  })
  const access = new FileLinkAccess(request)
  context.after(() => access.clear())
  const values: boolean[] = []
  access.subscribe('a', 'source.cpp', value => values.push(value))
  context.mock.timers.tick(16)
  context.mock.timers.tick(2500)
  await settle()
  assert.equal(values.includes(true), false)
})

test('inactive views retain confirmation and only retry unconfirmed candidates on return', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const calls: string[][] = []
  const access = new FileLinkAccess(async (_root, paths) => {
    calls.push(paths)
    return { items: paths.map(path => ({ path, accessible: path === 'exists.ts' || calls.length > 1 })) }
  })
  context.after(() => access.clear())
  const leaveConfirmed = access.subscribe('a', 'exists.ts', () => {})
  const leaveUnconfirmed = access.subscribe('a', 'created-later.ts', () => {})
  context.mock.timers.tick(16)
  await settle()
  leaveConfirmed()
  leaveUnconfirmed()
  context.mock.timers.tick(60_000)
  const values: boolean[] = []
  access.subscribe('a', 'exists.ts', value => values.push(value))
  access.subscribe('a', 'created-later.ts', () => {})
  assert.deepEqual(values, [true], 'returning subscribers synchronously see confirmation')
  context.mock.timers.tick(16)
  await settle()
  assert.deepEqual(calls, [['exists.ts', 'created-later.ts'], ['created-later.ts']])
  assert.equal(access.isConfirmed('a', 'created-later.ts'), true)
  assert.equal(access.isConfirmed('b', 'exists.ts'), false, 'roots cannot share evidence')
  access.clear()
  assert.equal(access.isConfirmed('a', 'exists.ts'), false)
})

test('a stalled request cannot block later batches and its late result cannot confirm a reference', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let finish!: (result: Awaited<ReturnType<FileLinkAccessRequest>>) => void
  const roots: string[] = []
  const access = new FileLinkAccess(async (root, paths) => {
    roots.push(root)
    if (root === 'stalled') return new Promise(resolve => { finish = resolve })
    return { items: paths.map(path => ({ path, accessible: true })) }
  })
  context.after(() => access.clear())
  access.subscribe('stalled', 'a.ts', () => {})
  access.subscribe('ready', 'b.ts', () => {})
  context.mock.timers.tick(16)
  context.mock.timers.tick(2500)
  await settle()
  context.mock.timers.tick(16)
  await settle()
  assert.deepEqual(roots, ['stalled', 'ready'])
  assert.equal(access.isConfirmed('ready', 'b.ts'), true)
  finish({ items: [{ path: 'a.ts', accessible: true }] })
  await settle()
  assert.equal(access.isConfirmed('stalled', 'a.ts'), false)
})

test('cancelling and resubscribing the same path rejects the old request', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const resolve: Array<(result: Awaited<ReturnType<FileLinkAccessRequest>>) => void> = []
  const access = new FileLinkAccess(() => new Promise(done => resolve.push(done)))
  context.after(() => access.clear())
  const leave = access.subscribe('a', 'source.ts', () => {})
  context.mock.timers.tick(16)
  leave()
  const values: boolean[] = []
  access.subscribe('a', 'source.ts', value => values.push(value))
  context.mock.timers.tick(16)
  resolve[0]({ items: [{ path: 'source.ts', accessible: true }] })
  await settle()
  assert.equal(values.includes(true), false)
  resolve[1]({ items: [{ path: 'source.ts', accessible: true }] })
  await settle()
  assert.equal(values.at(-1), true)
})
