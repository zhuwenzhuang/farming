import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS,
  TERMINAL_RESIZE_REDRAW_MAX_MS,
  TERMINAL_RESIZE_REDRAW_QUIET_MS,
  TERMINAL_RESIZE_SETTLE_MS,
  createTerminalResizeScheduler,
} from '../src/lib/terminal-resize-scheduler'

function harness() {
  let now = 0
  let nextTimer = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const runUntil = (target: number) => {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, left], [, right]) => left.at - right.at)[0]
      if (!due) break
      const [timer, entry] = due
      timers.delete(timer)
      now = entry.at
      entry.callback()
    }
    now = target
  }
  return {
    clock: {
      now: () => now,
      setTimeout: (callback: () => void, delay: number) => {
        const timer = ++nextTimer
        timers.set(timer, { at: now + delay, callback })
        return timer
      },
      clearTimeout: (timer: number) => { timers.delete(timer) },
    },
    advance: (ms: number) => runUntil(now + ms),
  }
}

test('settles only the latest fit and clear cancels it', () => {
  const { clock, advance } = harness()
  const settled: Array<{ cols: number; rows: number }> = []
  const scheduler = createTerminalResizeScheduler({
    onFitSettled: dimensions => settled.push(dimensions),
    onRedrawFlush: () => {},
    onDeliveryTimeout: () => {},
  }, clock)

  scheduler.scheduleFit({ cols: 80, rows: 24 })
  scheduler.scheduleFit({ cols: 100, rows: 40 })
  assert.deepEqual(scheduler.diagnostics(), {
    pendingFitResize: { cols: 100, rows: 40 },
    fitResizeTimerPending: true,
    resizeRedrawTimerPending: false,
    resizeDeliveryTimeoutPending: false,
  })
  advance(TERMINAL_RESIZE_SETTLE_MS)
  assert.deepEqual(settled, [{ cols: 100, rows: 40 }])

  scheduler.scheduleFit({ cols: 120, rows: 50 })
  scheduler.clearFit()
  advance(TERMINAL_RESIZE_SETTLE_MS)
  assert.deepEqual(settled, [{ cols: 100, rows: 40 }])
})

test('redraw uses a quiet window bounded by its maximum deadline and restart resets it', () => {
  const { clock, advance } = harness()
  let flushes = 0
  const scheduler = createTerminalResizeScheduler({
    onFitSettled: () => {},
    onRedrawFlush: () => { flushes += 1 },
    onDeliveryTimeout: () => {},
  }, clock)

  scheduler.scheduleRedraw()
  for (let index = 0; index < 6; index += 1) {
    advance(TERMINAL_RESIZE_REDRAW_QUIET_MS - 1)
    scheduler.scheduleRedraw()
  }
  advance(TERMINAL_RESIZE_REDRAW_MAX_MS - 6 * (TERMINAL_RESIZE_REDRAW_QUIET_MS - 1))
  assert.equal(flushes, 1)

  scheduler.scheduleRedraw()
  advance(TERMINAL_RESIZE_REDRAW_QUIET_MS - 1)
  scheduler.scheduleRedraw(true)
  advance(TERMINAL_RESIZE_REDRAW_QUIET_MS - 1)
  assert.equal(flushes, 1)
  advance(1)
  assert.equal(flushes, 2)
})

test('delivery timeout replaces, cancels, and resets pending timers', () => {
  const { clock, advance } = harness()
  let timedOut = 0
  const scheduler = createTerminalResizeScheduler({
    onFitSettled: () => {},
    onRedrawFlush: () => {},
    onDeliveryTimeout: () => { timedOut += 1 },
  }, clock)

  scheduler.scheduleDeliveryTimeout()
  advance(100)
  scheduler.scheduleDeliveryTimeout()
  advance(TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS - 100)
  assert.equal(timedOut, 0)
  scheduler.clearDeliveryTimeout()
  advance(100)
  assert.equal(timedOut, 0)

  scheduler.scheduleDeliveryTimeout()
  scheduler.reset()
  advance(TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS)
  assert.equal(timedOut, 0)

  scheduler.scheduleDeliveryTimeout()
  advance(TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS)
  assert.equal(timedOut, 1)
  assert.equal(scheduler.diagnostics().resizeDeliveryTimeoutPending, false)
})

test('commits timer state before callbacks so reentrant scheduling is retained', () => {
  const { clock, advance } = harness()
  const settled: Array<{ cols: number; rows: number }> = []
  const scheduler = createTerminalResizeScheduler({
    onFitSettled: dimensions => {
      settled.push(dimensions)
      if (dimensions.cols === 80) scheduler.scheduleFit({ cols: 90, rows: 30 })
    },
    onRedrawFlush: () => {},
    onDeliveryTimeout: () => {},
  }, clock)

  scheduler.scheduleFit({ cols: 80, rows: 24 })
  advance(TERMINAL_RESIZE_SETTLE_MS)
  assert.equal(scheduler.diagnostics().fitResizeTimerPending, true)
  advance(TERMINAL_RESIZE_SETTLE_MS)
  assert.deepEqual(settled, [{ cols: 80, rows: 24 }, { cols: 90, rows: 30 }])
})
