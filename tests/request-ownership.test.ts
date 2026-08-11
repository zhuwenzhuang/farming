import assert from 'node:assert/strict'
import { RequestOwnershipFence } from '@/lib/request-ownership'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(nextResolve => { resolve = nextResolve })
  return { promise, resolve }
}

async function run() {
  const fence = new RequestOwnershipFence('agent-a')
  const firstResponse = deferred<string>()
  const secondResponse = deferred<string>()
  const committed: string[] = []

  const firstLease = fence.begin()
  const first = firstResponse.promise.then(value => {
    if (firstLease.isCurrent()) committed.push(value)
  })
  const secondLease = fence.begin()
  const second = secondResponse.promise.then(value => {
    if (secondLease.isCurrent()) committed.push(value)
  })
  secondResponse.resolve('new response')
  await second
  firstResponse.resolve('stale response')
  await first
  assert.deepEqual(committed, ['new response'], 'a newer request owns the result even when the old request resolves last')

  const ownerLease = fence.begin()
  fence.setScope('agent-b')
  assert.equal(ownerLease.isCurrent(), false, 'switching Agent scope must revoke an old Agent request')

  const mountedLease = fence.begin()
  fence.setMounted(false)
  assert.equal(mountedLease.isCurrent(), false, 'unmounting must revoke an in-flight request')
  assert.equal(fence.available, false, 'unmounted resources must reject new requests before they start')
  fence.setMounted(true)

  const activeLease = fence.begin()
  fence.setActive(false)
  assert.equal(activeLease.isCurrent(), false, 'disabling a resource must revoke an in-flight request')
  assert.equal(fence.available, false, 'disabled resources must reject new requests before they start')
  fence.setActive(true)
  assert.equal(fence.begin().isCurrent(), true, 'a request in the restored scope can commit')

  console.log('request ownership fence tests passed')
}

void run()
