import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalTouchInteractionController } from '../src/lib/terminal-touch-interaction-controller'

interface TestPointerEvent {
  type: string
  pointerType: string
  pointerId: number
  clientX: number
  clientY: number
  timeStamp: number
  prevented: boolean
  stopped: boolean
  preventDefault: () => void
  stopPropagation: () => void
}

function pointerEvent(type: string, overrides: Partial<TestPointerEvent> = {}) {
  const event: TestPointerEvent = {
    type,
    pointerType: 'touch',
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    timeStamp: 1,
    prevented: false,
    stopped: false,
    preventDefault() { event.prevented = true },
    stopPropagation() { event.stopped = true },
    ...overrides,
  }
  return event as unknown as PointerEvent
}

function createHarness() {
  const listeners = new Map<string, Set<EventListener>>()
  const timers = new Map<number, () => void>()
  const frames = new Map<number, FrameRequestCallback>()
  const surface = { style: { transition: '', transform: '' } }
  let nextTimer = 0
  let nextFrame = 0
  let viewportY = 10
  let disposed = false
  let viewportChanges = 0
  let hiddenMenus = 0
  let shownMenus = 0
  let captured = 0
  let released = 0

  const host = {
    addEventListener(type: string, listener: EventListener) {
      const entries = listeners.get(type) ?? new Set<EventListener>()
      entries.add(listener)
      listeners.set(type, entries)
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener)
    },
    querySelector: () => surface,
    setPointerCapture: () => { captured += 1 },
    releasePointerCapture: () => { released += 1 },
  } as unknown as HTMLElement

  const controller = new TerminalTouchInteractionController({
    hostEl: host,
    isDisposed: () => disposed,
    copyTextAtEvent: () => 'selected output',
    showContextMenu: () => { shownMenus += 1 },
    lineHeight: () => 10,
    viewportY: () => viewportY,
    scrollToViewportY: next => { viewportY = next },
    onViewportChanged: () => { viewportChanges += 1 },
    hideContextMenu: () => { hiddenMenus += 1 },
  }, {
    now: () => 1,
    setTimeout: callback => {
      const id = ++nextTimer
      timers.set(id, callback)
      return id
    },
    clearTimeout: timer => { timers.delete(timer) },
    requestAnimationFrame: callback => {
      const id = ++nextFrame
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame: frame => { frames.delete(frame) },
  })

  const dispatch = (type: string, event: PointerEvent) => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  const runNextTimer = () => {
    const next = timers.entries().next().value as [number, () => void] | undefined
    if (!next) return false
    timers.delete(next[0])
    next[1]()
    return true
  }

  return {
    controller,
    dispatch,
    runNextTimer,
    timers,
    frames,
    surface,
    listeners,
    get viewportY() { return viewportY },
    get viewportChanges() { return viewportChanges },
    get hiddenMenus() { return hiddenMenus },
    get shownMenus() { return shownMenus },
    get captured() { return captured },
    get released() { return released },
    set disposed(value: boolean) { disposed = value },
  }
}

test('touch drag owns scrolling, momentum, and exact listener cleanup', () => {
  const harness = createHarness()
  assert.equal(harness.controller.install(), true)
  assert.equal(harness.controller.install(), false)

  harness.dispatch('pointerdown', pointerEvent('pointerdown', { clientY: 100, timeStamp: 10 }))
  const move = pointerEvent('pointermove', { clientY: 120, timeStamp: 20 })
  harness.dispatch('pointermove', move)
  assert.equal(harness.viewportY, 12)
  assert.equal(harness.viewportChanges, 1)
  assert.equal(harness.hiddenMenus, 1)
  assert.equal((move as unknown as TestPointerEvent).prevented, true)

  const up = pointerEvent('pointerup', { clientY: 120, timeStamp: 21 })
  harness.dispatch('pointerup', up)
  assert.equal(harness.captured, 1)
  assert.equal(harness.released, 1)
  assert.equal(harness.frames.size, 1, 'a moving pointer starts one momentum owner')

  assert.equal(harness.controller.dispose(), true)
  assert.equal(harness.controller.dispose(), false)
  assert.equal(harness.frames.size, 0)
  assert.equal([...harness.listeners.values()].every(entries => entries.size === 0), true)
})

test('long press opens copy menu only while the owner is live and stationary', () => {
  const harness = createHarness()
  harness.controller.install()
  harness.dispatch('pointerdown', pointerEvent('pointerdown'))
  assert.equal(harness.timers.size, 1)
  assert.equal(harness.runNextTimer(), true)
  assert.equal(harness.shownMenus, 1)

  harness.dispatch('pointerdown', pointerEvent('pointerdown', { pointerId: 2 }))
  harness.disposed = true
  assert.equal(harness.runNextTimer(), true)
  assert.equal(harness.shownMenus, 1, 'a disposed record cannot open a late menu')
  harness.controller.dispose()
})
