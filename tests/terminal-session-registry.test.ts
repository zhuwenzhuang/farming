import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalSessionRegistry } from '../src/lib/terminal-session-registry'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

test('single-flights a key and returns the same pending promise', async () => {
  const registry = new TerminalSessionRegistry<string, { id: string }>()
  const pending = deferred<{ id: string }>()
  let creates = 0

  const first = registry.getOrCreate('one', () => {
    creates += 1
    return pending.promise
  })
  const second = registry.getOrCreate('one', () => {
    creates += 1
    return { id: 'unexpected' }
  })

  assert.equal(first, second)
  assert.equal(creates, 1)
  pending.resolve({ id: 'one' })
  const record = await first
  await Promise.resolve()
  assert.equal(registry.get('one'), record)
  assert.equal(registry.isCurrent('one', record), true)
})

test('admits different keys independently', async () => {
  const registry = new TerminalSessionRegistry<string, string>()
  const [one, two] = await Promise.all([
    registry.getOrCreate('one', () => 'first'),
    registry.getOrCreate('two', () => 'second'),
  ])
  await Promise.resolve()
  assert.equal(one, 'first')
  assert.equal(two, 'second')
  assert.deepEqual([...registry.keys()], ['one', 'two'])
})

test('take fences a pending bootstrap from its late resolution', async () => {
  const registry = new TerminalSessionRegistry<string, string>()
  const pending = deferred<string>()
  const created = registry.getOrCreate('one', () => pending.promise)
  assert.equal(registry.take('one'), created)
  pending.resolve('late')
  await created
  await Promise.resolve()
  assert.equal(registry.get('one'), undefined)
})

test('an old resolution cannot replace a newer entry for the same key', async () => {
  const registry = new TerminalSessionRegistry<string, string>()
  const old = deferred<string>()
  const first = registry.getOrCreate('one', () => old.promise)
  assert.equal(registry.take('one'), first)
  const second = registry.getOrCreate('one', () => 'new')
  await second
  old.resolve('old')
  await first
  await Promise.resolve()
  assert.equal(registry.get('one'), 'new')
})

test('an old rejection cannot delete a newer entry for the same key', async () => {
  const registry = new TerminalSessionRegistry<string, string>()
  const old = deferred<string>()
  const first = registry.getOrCreate('one', () => old.promise)
  assert.equal(registry.take('one'), first)
  const second = registry.getOrCreate('one', () => 'new')
  await second
  old.reject(new Error('old failure'))
  await assert.rejects(first, /old failure/)
  await Promise.resolve()
  assert.equal(registry.get('one'), 'new')
})

test('creation error is reported once for callers sharing one rejected pending entry', async () => {
  const registry = new TerminalSessionRegistry<string, string>()
  const pending = deferred<string>()
  let errors = 0
  const first = registry.getOrCreate('one', () => pending.promise, () => { errors += 1 })
  const second = registry.getOrCreate('one', () => 'unexpected', () => { errors += 1 })
  pending.reject(new Error('failed'))
  await assert.rejects(first, /failed/)
  await assert.rejects(second, /failed/)
  await Promise.resolve()
  assert.equal(errors, 1)
  assert.equal(registry.get('one'), undefined)
})

test('synchronous non-Error creation failures are normalized for reporting', async () => {
  const registry = new TerminalSessionRegistry<string, string>()
  const reported: Error[] = []
  const created = registry.getOrCreate('one', () => {
    throw 'sync failure'
  }, error => { reported.push(error) })

  await assert.rejects(created, reason => reason === 'sync failure')
  await Promise.resolve()
  assert.equal(reported.length, 1)
  assert.equal(reported[0]?.message, 'sync failure')
  assert.equal(registry.get('one'), undefined)
})

test('values and forEach expose the current entries without changing ownership', async () => {
  const registry = new TerminalSessionRegistry<string, string>()
  await registry.getOrCreate('one', () => 'first')
  await registry.getOrCreate('two', () => 'second')
  await Promise.resolve()
  assert.deepEqual([...registry.values()], ['first', 'second'])
  const visited: string[] = []
  registry.forEach((value, key) => visited.push(`${key}:${value}`))
  assert.deepEqual(visited, ['one:first', 'two:second'])
})
