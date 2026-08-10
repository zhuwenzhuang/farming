import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalCheckpointRequestScheduler } from '../src/lib/terminal-checkpoint-request-scheduler'

test('checkpoint admission is bounded and releases exactly once', async () => {
  const scheduler = new TerminalCheckpointRequestScheduler(2)
  const first = await scheduler.acquire(new AbortController().signal)
  const second = await scheduler.acquire(new AbortController().signal)
  let thirdAdmitted = false
  const thirdPromise = scheduler.acquire(new AbortController().signal).then(release => {
    thirdAdmitted = true
    return release
  })

  await Promise.resolve()
  assert.equal(thirdAdmitted, false)

  first()
  const third = await thirdPromise
  assert.equal(thirdAdmitted, true)

  first()
  const fourthPromise = scheduler.acquire(new AbortController().signal)
  let fourthAdmitted = false
  void fourthPromise.then(() => { fourthAdmitted = true })
  await Promise.resolve()
  assert.equal(fourthAdmitted, false, 'releasing one lease twice cannot free another slot')

  second()
  const fourth = await fourthPromise
  third()
  fourth()
})

test('aborting a queued checkpoint removes only that waiter', async () => {
  const scheduler = new TerminalCheckpointRequestScheduler(1)
  const active = await scheduler.acquire(new AbortController().signal)
  const cancelledController = new AbortController()
  const cancelled = scheduler.acquire(cancelledController.signal)
  const successor = scheduler.acquire(new AbortController().signal)

  cancelledController.abort()
  await assert.rejects(cancelled, error => (
    error instanceof DOMException && error.name === 'AbortError'
  ))

  active()
  const releaseSuccessor = await successor
  releaseSuccessor()
})

test('an already aborted checkpoint never enters admission', async () => {
  const scheduler = new TerminalCheckpointRequestScheduler(1)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(scheduler.acquire(controller.signal), error => (
    error instanceof DOMException && error.name === 'AbortError'
  ))

  const release = await scheduler.acquire(new AbortController().signal)
  release()
})
