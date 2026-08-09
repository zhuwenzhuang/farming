import assert from 'node:assert/strict'
import test from 'node:test'
import type { TerminalAttachmentOperation } from '../src/lib/terminal-attachment-coordinator'
import {
  TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS,
  TERMINAL_RESIZE_REDRAW_MAX_MS,
  TERMINAL_RESIZE_REDRAW_QUIET_MS,
  TERMINAL_RESIZE_SETTLE_MS,
  TerminalResizeEffectController,
} from '../src/lib/terminal-resize-effect-controller'
import type { TerminalResizeDimensions } from '../src/lib/terminal-resize'

function createHarness() {
  let now = 0
  let nextTimer = 0
  let nextFrame = 0
  let attachment: TerminalAttachmentOperation = { generation: 1, revision: 1 }
  let stateRevision: number | null = 10
  let canMutate = true
  let dimensions = { cols: 80, rows: 24 }
  let proposed: TerminalResizeDimensions | null = null
  let proposalError: Error | null = null
  let observerCallback: ResizeObserverCallback = () => {}
  let observed = 0
  let disconnected = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const frames = new Map<number, FrameRequestCallback>()
  const delivered: TerminalResizeDimensions[] = []
  const applied: TerminalResizeDimensions[] = []
  let recoveries = 0
  let flushes = 0
  let deliveryAccepted = true
  let deliveryError: Error | null = null
  let controller!: TerminalResizeEffectController

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

  controller = new TerminalResizeEffectController({
    attachmentOperation: () => attachment,
    isCurrentAttachmentOperation: operation => (
      operation.generation === attachment.generation
      && operation.revision === attachment.revision
    ),
    stateRevision: () => stateRevision,
    canMutate: () => canMutate,
    currentDimensions: () => dimensions,
    proposeDimensions: () => {
      if (proposalError) throw proposalError
      return proposed
    },
    applyLocalDimensions: next => {
      dimensions = next
      applied.push(next)
      // xterm emits onResize synchronously. The production listener uses this
      // exact guard, so a committed remote resize cannot echo back to the PTY.
      if (!controller.applyingLocalResize) controller.notify(next.cols, next.rows)
    },
    deliver: next => {
      delivered.push(next)
      if (deliveryError) throw deliveryError
      return deliveryAccepted
    },
    requestRecovery: () => { recoveries += 1 },
    flushOutput: () => { flushes += 1 },
  }, {
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = ++nextTimer
      timers.set(timer, { at: now + delay, callback })
      return timer
    },
    clearTimeout: timer => { timers.delete(timer) },
    requestAnimationFrame: callback => {
      const frame = ++nextFrame
      frames.set(frame, callback)
      return frame
    },
    cancelAnimationFrame: frame => { frames.delete(frame) },
    createResizeObserver: callback => {
      observerCallback = callback
      return {
        observe: () => { observed += 1 },
        disconnect: () => { disconnected += 1 },
        unobserve: () => {},
      } as unknown as ResizeObserver
    },
  })

  return {
    controller,
    delivered,
    applied,
    advance: (ms: number) => runUntil(now + ms),
    runFrames: () => {
      const current = [...frames.entries()]
      frames.clear()
      for (const [, callback] of current) callback(now)
    },
    triggerObserver: () => observerCallback([], {} as ResizeObserver),
    get attachment() { return attachment },
    set attachment(value: TerminalAttachmentOperation) { attachment = value },
    set stateRevision(value: number | null) { stateRevision = value },
    set canMutate(value: boolean) { canMutate = value },
    get dimensions() { return dimensions },
    set dimensions(value: TerminalResizeDimensions) { dimensions = value },
    set proposed(value: TerminalResizeDimensions | null) { proposed = value },
    set proposalError(value: Error | null) { proposalError = value },
    set deliveryAccepted(value: boolean) { deliveryAccepted = value },
    set deliveryError(value: Error | null) { deliveryError = value },
    get recoveries() { return recoveries },
    get flushes() { return flushes },
    get observed() { return observed },
    get disconnected() { return disconnected },
  }
}

test('keeps one resize in flight and sends only the latest pending geometry', () => {
  const harness = createHarness()
  assert.equal(harness.controller.notify(120, 35), true)
  assert.equal(harness.controller.notify(112, 34), true)
  assert.equal(harness.controller.notify(104, 32), true)
  assert.deepEqual(harness.delivered, [{ cols: 120, rows: 35 }])
  assert.deepEqual(harness.controller.diagnostics().pendingResizeRequest, { cols: 104, rows: 32 })

  harness.controller.applyCommittedRemoteResize(120, 35, {
    attachment: harness.attachment,
    stateRevision: 10,
  })
  assert.deepEqual(
    harness.controller.diagnostics().resizeRequestInFlight,
    { cols: 120, rows: 35 },
    'an equal state revision is not evidence that this delivery committed',
  )

  assert.equal(harness.controller.applyCommittedRemoteResize(120, 35, {
    attachment: harness.attachment,
    stateRevision: 11,
  }), true)
  assert.deepEqual(harness.dimensions, { cols: 104, rows: 32 })
  assert.deepEqual(harness.delivered, [
    { cols: 120, rows: 35 },
    { cols: 104, rows: 32 },
  ])

  harness.controller.applyCommittedRemoteResize(104, 32, {
    attachment: harness.attachment,
    stateRevision: 12,
  })
  assert.equal(harness.controller.diagnostics().resizeRequestInFlight, null)
  assert.equal(harness.controller.diagnostics().pendingResizeRequest, null)
})

test('does not let unrelated remote geometry acknowledge or overwrite a newer local resize', () => {
  const harness = createHarness()
  harness.controller.notify(120, 35)
  harness.controller.notify(100, 30)
  harness.controller.applyCommittedRemoteResize(90, 28, {
    attachment: harness.attachment,
    stateRevision: 11,
  })
  assert.deepEqual(harness.dimensions, { cols: 100, rows: 30 })
  assert.deepEqual(harness.controller.diagnostics().resizeRequestInFlight, { cols: 120, rows: 35 })
  assert.deepEqual(harness.controller.diagnostics().pendingResizeRequest, { cols: 100, rows: 30 })
})

test('treats delivery timeout as uncertain and fences late ABA acknowledgements', () => {
  const harness = createHarness()
  const oldAttachment = harness.attachment
  harness.controller.notify(120, 35)
  harness.controller.notify(96, 28)
  harness.advance(TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS)

  assert.equal(harness.recoveries, 1)
  assert.deepEqual(harness.delivered, [{ cols: 120, rows: 35 }], 'timeout must not replay a mutation')
  assert.equal(harness.controller.diagnostics().resizeRequestInFlight, null)
  assert.equal(harness.controller.recoveryFitRequired(), true)

  harness.attachment = { generation: oldAttachment.generation, revision: oldAttachment.revision + 1 }
  harness.stateRevision = 20
  harness.controller.notify(96, 28, { force: true })
  assert.equal(harness.controller.applyCommittedRemoteResize(120, 35, {
    attachment: oldAttachment,
    stateRevision: 21,
  }), false, 'the old operation cannot complete a new same-agent delivery')
  assert.deepEqual(harness.controller.diagnostics().resizeRequestInFlight, { cols: 96, rows: 28 })
  harness.controller.applyCommittedRemoteResize(96, 28, {
    attachment: harness.attachment,
    stateRevision: 21,
  })
  assert.equal(harness.controller.diagnostics().resizeRequestInFlight, null)
})

test('protocol recovery cancels an old delivery token before attachment revision advances', () => {
  const harness = createHarness()
  harness.controller.notify(120, 35)
  harness.controller.notify(100, 30)
  harness.controller.beginRecovery()
  harness.attachment = { generation: 1, revision: 2 }
  harness.advance(TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS)

  assert.equal(harness.recoveries, 0, 'the cancelled delivery timer cannot start a second recovery')
  assert.equal(harness.controller.diagnostics().resizeRequestInFlight, null)
  assert.equal(harness.controller.recoveryFitRequired(), true)
})

test('stale delivery timeout clears its exact fence and recovers the current attachment', () => {
  const harness = createHarness()
  harness.controller.notify(120, 35)
  harness.controller.notify(100, 30)
  // Reproduce a host advancing the attachment owner without first invalidating
  // resize effects. The controller must remain live even across that misuse.
  harness.attachment = { generation: 1, revision: 2 }
  harness.advance(TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS)

  assert.equal(harness.recoveries, 1)
  assert.deepEqual(harness.delivered, [{ cols: 120, rows: 35 }])
  assert.equal(harness.controller.diagnostics().resizeRequestInFlight, null)
  assert.equal(harness.controller.diagnostics().pendingResizeRequest, null)
  assert.equal(harness.controller.recoveryFitRequired(), true)
})

test('observer and settle timers require the exact effect and attachment token', () => {
  const harness = createHarness()
  harness.proposed = { cols: 80, rows: 24 }
  harness.controller.syncFit()
  harness.controller.observe({} as Element)
  harness.proposed = { cols: 100, rows: 30 }
  harness.triggerObserver()
  harness.triggerObserver()
  harness.runFrames()
  assert.equal(harness.controller.diagnostics().fitResizeTimerPending, true)

  harness.attachment = { generation: 1, revision: 2 }
  harness.advance(TERMINAL_RESIZE_SETTLE_MS)
  assert.deepEqual(harness.delivered, [])

  harness.triggerObserver()
  harness.runFrames()
  harness.advance(TERMINAL_RESIZE_SETTLE_MS)
  assert.deepEqual(harness.delivered, [{ cols: 100, rows: 30 }])
  assert.equal(harness.observed, 1)

  harness.controller.pause()
  assert.equal(harness.disconnected, 1)
})

test('recovery force survives null and throwing proposals until an exact resize is admitted', () => {
  const harness = createHarness()
  harness.proposed = { cols: 80, rows: 24 }
  assert.equal(harness.controller.syncFit(), false, 'equal initial geometry clears initial recovery force')

  harness.controller.notify(120, 35)
  harness.controller.applyCommittedRemoteResize(120, 35, {
    attachment: harness.attachment,
    stateRevision: 11,
  })
  harness.controller.applyAuthoritativeDimensions(100, 30)
  harness.controller.beginRecovery({ forceAfterRecovery: true })

  harness.proposed = null
  assert.equal(harness.controller.syncFit({
    force: harness.controller.recoveryFitRequired(),
  }), false)
  assert.equal(harness.controller.recoveryFitRequired(), true)

  harness.proposalError = new Error('renderer is being reparented')
  assert.equal(harness.controller.syncFit(), false)
  assert.equal(harness.controller.recoveryFitRequired(), true)

  harness.proposalError = null
  harness.proposed = { cols: 120, rows: 35 }
  harness.controller.observe({} as Element)
  harness.triggerObserver()
  harness.runFrames()
  assert.deepEqual(harness.delivered, [
    { cols: 120, rows: 35 },
    { cols: 120, rows: 35 },
  ])
  assert.equal(harness.controller.diagnostics().fitResizeTimerPending, false)
  assert.equal(harness.controller.recoveryFitRequired(), false)
})

test('committed remote resize suppresses local echo and sustained churn keeps the first redraw deadline', () => {
  const harness = createHarness()
  harness.controller.applyCommittedRemoteResize(100, 30, {
    attachment: harness.attachment,
    stateRevision: 11,
  })
  assert.deepEqual(harness.applied, [{ cols: 100, rows: 30 }])
  assert.deepEqual(harness.delivered, [], 'xterm local onResize must not echo remote state')

  for (let index = 0; index < 6; index += 1) {
    harness.advance(TERMINAL_RESIZE_REDRAW_QUIET_MS - 1)
    harness.controller.applyCommittedRemoteResize(101 + index, 31, {
      attachment: harness.attachment,
      stateRevision: 12 + index,
    })
  }
  harness.advance(TERMINAL_RESIZE_REDRAW_MAX_MS - 6 * (TERMINAL_RESIZE_REDRAW_QUIET_MS - 1))
  assert.equal(harness.flushes, 1)
})

test('definitive delivery rejection recovers without retaining an in-flight request', () => {
  const harness = createHarness()
  harness.deliveryAccepted = false
  assert.equal(harness.controller.notify(120, 35), false)
  assert.equal(harness.recoveries, 1)
  assert.equal(harness.controller.diagnostics().resizeRequestInFlight, null)
  assert.equal(harness.controller.recoveryFitRequired(), true)
})

test('thrown delivery outcome is uncertain and never replayed directly', () => {
  const harness = createHarness()
  harness.deliveryError = new Error('transport outcome unknown')
  assert.equal(harness.controller.notify(120, 35), false)
  assert.deepEqual(harness.delivered, [{ cols: 120, rows: 35 }])
  assert.equal(harness.recoveries, 1)
  assert.equal(harness.controller.diagnostics().resizeRequestInFlight, null)
})

test('authoritative geometry accepts sub-minimum positive cuts while local proposals keep PTY minimums', () => {
  const harness = createHarness()
  assert.equal(harness.controller.notify(20, 5), false)
  assert.equal(harness.controller.applyCommittedRemoteResize(18, 4, {
    attachment: harness.attachment,
    stateRevision: 11,
  }), true)
  assert.deepEqual(harness.dimensions, { cols: 18, rows: 4 })
  assert.equal(harness.controller.applyAuthoritativeDimensions(20, 5), true)
  assert.deepEqual(harness.dimensions, { cols: 20, rows: 5 })
  assert.equal(harness.controller.applyAuthoritativeDimensions(0, 2), false)
})
