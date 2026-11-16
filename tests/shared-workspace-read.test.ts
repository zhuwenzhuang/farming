import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SharedWorkspaceRead } from '../backend/shared-workspace-read.cjs'

test('shared reads cancel execution only after the last consumer leaves and wait for actual completion', async () => {
  let finish!: (value: number) => void
  const shared = new SharedWorkspaceRead(() => new Promise<number>(resolve => { finish = resolve }))
  const a = new AbortController()
  const b = new AbortController()
  const first = shared.join(a.signal)
  const second = shared.join(b.signal)
  let settled = false
  const firstRejected = assert.rejects(first, { name: 'AbortError' }).then(() => { settled = true })
  const secondRejected = assert.rejects(second, { name: 'AbortError' })
  a.abort()
  await Promise.resolve()
  assert.equal(shared.controller.signal.aborted, false)
  b.abort()
  assert.equal(shared.controller.signal.aborted, true)
  await Promise.resolve()
  assert.equal(settled, false)
  finish(1)
  await Promise.all([firstRejected, secondRejected])
})
