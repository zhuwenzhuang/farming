import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BrowserViewerInputScheduler,
  type BrowserViewerInputMessage,
} from '../extensions/browser/frontend/browser-viewer-input-scheduler'

function harness() {
  const sent: BrowserViewerInputMessage[] = []
  const scheduled = new Map<number, () => void>()
  let nextFrame = 0
  const scheduler = new BrowserViewerInputScheduler(
    message => sent.push(message),
    callback => {
      const frame = ++nextFrame
      scheduled.set(frame, callback)
      return frame
    },
    frame => { scheduled.delete(frame) },
  )
  const runFrame = () => {
    const callbacks = [...scheduled.values()]
    scheduled.clear()
    callbacks.forEach(callback => callback())
  }
  return { runFrame, scheduler, sent }
}

test('keeps only the latest pointer move within one frame', () => {
  const { runFrame, scheduler, sent } = harness()
  scheduler.enqueue({ type: 'pointer', action: 'move', x: 1, y: 2 })
  scheduler.enqueue({ type: 'pointer', action: 'move', x: 8, y: 9 })

  runFrame()

  assert.deepEqual(sent, [{ type: 'pointer', action: 'move', x: 8, y: 9 }])
})

test('accumulates wheel distance while keeping the latest pointer position', () => {
  const { runFrame, scheduler, sent } = harness()
  scheduler.enqueue({ type: 'wheel', deltaX: 2, deltaY: 3, x: 10, y: 20 })
  scheduler.enqueue({ type: 'wheel', deltaX: -1, deltaY: 5, x: 30, y: 40 })

  runFrame()

  assert.deepEqual(sent, [{ type: 'wheel', deltaX: 1, deltaY: 8, x: 30, y: 40 }])
})

test('bounds interleaved high-frequency input to one move and one wheel message', () => {
  const { runFrame, scheduler, sent } = harness()
  for (let index = 1; index <= 100; index += 1) {
    scheduler.enqueue({ type: 'pointer', action: 'move', x: index, y: index })
    scheduler.enqueue({ type: 'wheel', deltaX: 0, deltaY: 1, x: index, y: index })
  }

  runFrame()

  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0], { type: 'pointer', action: 'move', x: 100, y: 100 })
  assert.deepEqual(sent[1], { type: 'wheel', deltaX: 0, deltaY: 100, x: 100, y: 100 })
})

test('flushes coalesced input before ordered button and keyboard events', () => {
  const { scheduler, sent } = harness()
  scheduler.enqueue({ type: 'pointer', action: 'move', x: 4, y: 5 })
  scheduler.enqueue({ type: 'pointer', action: 'move', x: 6, y: 7 })
  scheduler.enqueue({ type: 'pointer', action: 'down', button: 'left', x: 6, y: 7 })
  scheduler.enqueue({ type: 'key', key: 'Enter' })

  assert.deepEqual(sent, [
    { type: 'pointer', action: 'move', x: 6, y: 7 },
    { type: 'pointer', action: 'down', button: 'left', x: 6, y: 7 },
    { type: 'key', key: 'Enter' },
  ])
})

test('clear drops pending high-frequency input', () => {
  const { runFrame, scheduler, sent } = harness()
  scheduler.enqueue({ type: 'pointer', action: 'move', x: 1, y: 2 })
  scheduler.enqueue({ type: 'wheel', deltaX: 0, deltaY: 4 })

  scheduler.clear()
  runFrame()

  assert.deepEqual(sent, [])
})
