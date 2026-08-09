import type { TerminalAttachmentOperation } from '@/lib/terminal-attachment-coordinator'
import {
  normalizeTerminalResizeDimensions,
  type TerminalResizeDimensions,
} from '@/lib/terminal-resize'

export const TERMINAL_RESIZE_SETTLE_MS = 250
export const TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS = 1500
export const TERMINAL_RESIZE_REDRAW_QUIET_MS = 50
export const TERMINAL_RESIZE_REDRAW_MAX_MS = 300

interface TerminalResizeDeliveryOperation {
  id: number
  attachment: TerminalAttachmentOperation
  baselineStateRevision: number | null
  dimensions: TerminalResizeDimensions
}

interface TerminalResizeEffectToken {
  revision: number
  attachment: TerminalAttachmentOperation
}

export interface TerminalResizeEffectPorts {
  attachmentOperation: () => TerminalAttachmentOperation
  isCurrentAttachmentOperation: (operation: TerminalAttachmentOperation) => boolean
  stateRevision: () => number | null
  canMutate: () => boolean
  currentDimensions: () => TerminalResizeDimensions
  proposeDimensions: () => TerminalResizeDimensions | null
  applyLocalDimensions: (dimensions: TerminalResizeDimensions) => void
  deliver: (dimensions: TerminalResizeDimensions) => boolean
  requestRecovery: () => void
  flushOutput: () => void
}

export interface TerminalResizeEffectRuntime {
  now?: () => number
  setTimeout?: (callback: () => void, delay: number) => number
  clearTimeout?: (timer: number) => void
  requestAnimationFrame?: (callback: FrameRequestCallback) => number
  cancelAnimationFrame?: (frame: number) => void
  createResizeObserver?: (callback: ResizeObserverCallback) => ResizeObserver
}

export interface TerminalResizeEffectDiagnostics {
  lastNotifiedResize: TerminalResizeDimensions | null
  resizeNotificationCount: number
  resizeRequestInFlight: TerminalResizeDimensions | null
  pendingResizeRequest: TerminalResizeDimensions | null
  pendingFitResize: TerminalResizeDimensions | null
  fitResizeTimerPending: boolean
  resizeRedrawTimerPending: boolean
  resizeDeliveryTimeoutPending: boolean
}

function dimensionsMatch(
  left: TerminalResizeDimensions | null,
  right: TerminalResizeDimensions | null,
) {
  return Boolean(
    left
    && right
    && left.cols === right.cols
    && left.rows === right.rows,
  )
}

function normalizeAuthoritativeTerminalDimensions(
  cols: number,
  rows: number,
): TerminalResizeDimensions | null {
  const nextCols = Math.floor(Number(cols))
  const nextRows = Math.floor(Number(rows))
  if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) return null
  if (nextCols <= 0 || nextRows <= 0) return null
  return { cols: nextCols, rows: nextRows }
}

function sameAttachmentOperation(
  left: TerminalAttachmentOperation,
  right: TerminalAttachmentOperation,
) {
  return left.generation === right.generation && left.revision === right.revision
}

/**
 * Owns browser resize effects without owning terminal protocol ordering.
 * Attachment identity and state revision are captured from the protocol owner;
 * this controller only fences observer, timer, renderer, and delivery effects.
 */
export class TerminalResizeEffectController {
  readonly #ports: TerminalResizeEffectPorts
  readonly #now: () => number
  readonly #setTimeout: (callback: () => void, delay: number) => number
  readonly #clearTimeout: (timer: number) => void
  readonly #requestAnimationFrame: (callback: FrameRequestCallback) => number
  readonly #cancelAnimationFrame: (frame: number) => void
  readonly #observer: ResizeObserver

  #revision = 0
  #disposed = false
  #applyingLocalResize = false
  #forceAfterRecovery = true
  #lastNotifiedResize: TerminalResizeDimensions | null = null
  #resizeNotificationCount = 0
  #deliverySequence = 0
  #resizeRequestInFlight: TerminalResizeDeliveryOperation | null = null
  #pendingResizeRequest: TerminalResizeDimensions | null = null
  #observerFrame: number | null = null
  #pendingFitResize: TerminalResizeDimensions | null = null
  #fitResizeTimer: number | null = null
  #resizeRedrawStartedAt: number | null = null
  #resizeRedrawTimer: number | null = null
  #resizeDeliveryTimeout: number | null = null

  constructor(ports: TerminalResizeEffectPorts, runtime: TerminalResizeEffectRuntime = {}) {
    this.#ports = ports
    this.#now = runtime.now ?? Date.now
    this.#setTimeout = runtime.setTimeout ?? ((callback, delay) => window.setTimeout(callback, delay))
    this.#clearTimeout = runtime.clearTimeout ?? (timer => window.clearTimeout(timer))
    this.#requestAnimationFrame = runtime.requestAnimationFrame
      ?? (callback => window.requestAnimationFrame(callback))
    this.#cancelAnimationFrame = runtime.cancelAnimationFrame
      ?? (frame => window.cancelAnimationFrame(frame))
    const createResizeObserver = runtime.createResizeObserver
      ?? (callback => new ResizeObserver(callback))
    this.#observer = createResizeObserver(() => this.#scheduleObservedFit())
  }

  get applyingLocalResize() {
    return this.#applyingLocalResize
  }

  observe(host: Element) {
    if (this.#disposed) return
    this.#observer.observe(host)
  }

  pause() {
    if (this.#disposed) return
    this.#observer.disconnect()
    this.#invalidateTransientEffects()
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#observer.disconnect()
    this.#invalidateTransientEffects()
  }

  beginRecovery(options: { forceAfterRecovery?: boolean; resetLastNotified?: boolean } = {}) {
    if (this.#disposed) return
    this.#forceAfterRecovery = this.#forceAfterRecovery
      || options.forceAfterRecovery === true
      || this.#resizeRequestInFlight !== null
      || this.#pendingResizeRequest !== null
    if (options.resetLastNotified === true) this.#lastNotifiedResize = null
    this.#invalidateTransientEffects()
  }

  recoveryFitRequired() {
    return this.#forceAfterRecovery
  }

  syncFit(options: { force?: boolean } = {}) {
    if (this.#disposed) return false
    if (options.force === true) this.#forceAfterRecovery = true
    const force = this.#forceAfterRecovery
    let dimensions: TerminalResizeDimensions | null
    try {
      dimensions = this.#ports.proposeDimensions()
    } catch {
      // Hidden and reparenting renderer states may not expose measurable cell
      // geometry yet. A later observer/layout effect owns the next attempt.
      return false
    }
    if (!dimensions) return false
    const current = this.#ports.currentDimensions()
    if (dimensionsMatch(current, dimensions)) {
      if (force) this.#forceAfterRecovery = false
      this.#clearFit()
      return false
    }
    if (!force && dimensionsMatch(this.#lastNotifiedResize, dimensions)) {
      // Another viewer may have changed the PTY after this unchanged local
      // geometry was delivered. Do not echo the older local size back.
      this.#clearFit()
      return false
    }
    if (!this.#ports.canMutate()) {
      this.#forceAfterRecovery = true
      this.#clearFit()
      return false
    }
    if (!force) {
      this.#scheduleFit(dimensions)
      return true
    }
    this.#clearFit()
    const admitted = this.notify(dimensions.cols, dimensions.rows, { force: true })
    if (admitted) this.#forceAfterRecovery = false
    return admitted
  }

  notify(
    cols: number,
    rows: number,
    options: { force?: boolean } = {},
  ) {
    if (this.#disposed || !this.#ports.canMutate()) return false
    const dimensions = normalizeTerminalResizeDimensions(cols, rows)
    if (!dimensions) return false
    if (!options.force && dimensionsMatch(this.#lastNotifiedResize, dimensions)) return false

    this.#applyDimensions(dimensions)
    if (this.#resizeRequestInFlight) {
      this.#pendingResizeRequest = dimensions
      this.#recordNotification(dimensions)
      return true
    }
    if (!this.#startDelivery(dimensions)) {
      this.#enterRecovery()
      return false
    }
    this.#recordNotification(dimensions)
    return true
  }

  applyCommittedRemoteResize(
    cols: number,
    rows: number,
    transition: {
      attachment: TerminalAttachmentOperation
      stateRevision: number
    },
  ) {
    if (this.#disposed || !this.#ports.isCurrentAttachmentOperation(transition.attachment)) {
      return false
    }
    const dimensions = normalizeAuthoritativeTerminalDimensions(cols, rows)
    if (!dimensions) return false

    const inFlight = this.#resizeRequestInFlight
    const matched = Boolean(
      inFlight
      && sameAttachmentOperation(inFlight.attachment, transition.attachment)
      && dimensionsMatch(inFlight.dimensions, dimensions)
      && Number.isFinite(transition.stateRevision)
      && (
        inFlight.baselineStateRevision === null
        || transition.stateRevision > inFlight.baselineStateRevision
      )
    )
    const preserveLocalGeometry = inFlight !== null
      && (!matched || (
        this.#pendingResizeRequest !== null
        && !dimensionsMatch(this.#pendingResizeRequest, dimensions)
      ))
    let pending: TerminalResizeDimensions | null = null
    if (matched) {
      pending = this.#pendingResizeRequest
      this.#resizeRequestInFlight = null
      this.#pendingResizeRequest = null
      this.#clearDeliveryTimeout()
    }

    if (!preserveLocalGeometry) this.#applyDimensions(dimensions)
    this.#scheduleRedraw()

    if (matched && pending && !dimensionsMatch(pending, dimensions)) {
      if (!this.#startDelivery(pending)) this.#enterRecovery()
    }
    return true
  }

  applyAuthoritativeDimensions(cols: number, rows: number) {
    if (this.#disposed) return false
    const dimensions = normalizeAuthoritativeTerminalDimensions(cols, rows)
    if (!dimensions) return false
    this.#applyDimensions(dimensions)
    return true
  }

  deferOutputFlush() {
    if (this.#resizeRedrawTimer === null) return false
    this.#scheduleRedraw()
    return true
  }

  isRedrawPending() {
    return this.#resizeRedrawTimer !== null
  }

  diagnostics(): TerminalResizeEffectDiagnostics {
    return {
      lastNotifiedResize: this.#lastNotifiedResize,
      resizeNotificationCount: this.#resizeNotificationCount,
      resizeRequestInFlight: this.#resizeRequestInFlight?.dimensions ?? null,
      pendingResizeRequest: this.#pendingResizeRequest,
      pendingFitResize: this.#pendingFitResize,
      fitResizeTimerPending: this.#fitResizeTimer !== null,
      resizeRedrawTimerPending: this.#resizeRedrawTimer !== null,
      resizeDeliveryTimeoutPending: this.#resizeDeliveryTimeout !== null,
    }
  }

  #recordNotification(dimensions: TerminalResizeDimensions) {
    this.#lastNotifiedResize = dimensions
    this.#resizeNotificationCount += 1
  }

  #captureEffectToken(): TerminalResizeEffectToken {
    return {
      revision: this.#revision,
      attachment: this.#ports.attachmentOperation(),
    }
  }

  #isCurrentEffectToken(token: TerminalResizeEffectToken) {
    return !this.#disposed
      && token.revision === this.#revision
      && this.#ports.isCurrentAttachmentOperation(token.attachment)
  }

  #scheduleObservedFit() {
    if (this.#disposed) return
    if (this.#observerFrame !== null) this.#cancelAnimationFrame(this.#observerFrame)
    const token = this.#captureEffectToken()
    let frame = 0
    frame = this.#requestAnimationFrame(() => {
      if (this.#observerFrame !== frame) return
      this.#observerFrame = null
      if (this.#isCurrentEffectToken(token)) this.syncFit()
    })
    this.#observerFrame = frame
  }

  #scheduleFit(dimensions: TerminalResizeDimensions) {
    this.#clearFit()
    this.#pendingFitResize = dimensions
    const token = this.#captureEffectToken()
    let timer = 0
    timer = this.#setTimeout(() => {
      if (this.#fitResizeTimer !== timer) return
      this.#fitResizeTimer = null
      const pending = this.#pendingFitResize
      this.#pendingFitResize = null
      if (pending && this.#isCurrentEffectToken(token)) {
        this.notify(pending.cols, pending.rows)
      }
    }, TERMINAL_RESIZE_SETTLE_MS)
    this.#fitResizeTimer = timer
  }

  #startDelivery(dimensions: TerminalResizeDimensions) {
    const operation: TerminalResizeDeliveryOperation = {
      id: ++this.#deliverySequence,
      attachment: this.#ports.attachmentOperation(),
      baselineStateRevision: this.#ports.stateRevision(),
      dimensions,
    }
    this.#resizeRequestInFlight = operation
    let delivered = false
    try {
      delivered = this.#ports.deliver(dimensions)
    } catch {
      // A thrown transport boundary does not prove whether the mutation left
      // the browser. Reconcile through the same checkpoint recovery as timeout.
    }
    if (!delivered) {
      if (this.#resizeRequestInFlight?.id === operation.id) {
        this.#resizeRequestInFlight = null
      }
      return false
    }
    if (this.#resizeRequestInFlight?.id !== operation.id) return true
    this.#scheduleDeliveryTimeout(operation)
    return true
  }

  #scheduleDeliveryTimeout(operation: TerminalResizeDeliveryOperation) {
    this.#clearDeliveryTimeout()
    const token = this.#captureEffectToken()
    let timer = 0
    timer = this.#setTimeout(() => {
      if (
        this.#resizeDeliveryTimeout !== timer
        || this.#resizeRequestInFlight?.id !== operation.id
      ) return
      this.#resizeDeliveryTimeout = null
      // The exact delivery timed out even when its attachment token was
      // superseded without first notifying this controller. Never strand its
      // mutation fence: clear it, retain force-recovery intent, and reconcile
      // the current attachment cut without replaying the timed-out geometry.
      this.#resizeRequestInFlight = null
      this.#pendingResizeRequest = null
      if (!this.#isCurrentEffectToken(token)) this.#forceAfterRecovery = true
      this.#enterRecovery()
    }, TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS)
    this.#resizeDeliveryTimeout = timer
  }

  #enterRecovery() {
    if (this.#disposed) return
    this.beginRecovery({ forceAfterRecovery: true })
    this.#ports.requestRecovery()
  }

  #applyDimensions(dimensions: TerminalResizeDimensions) {
    if (dimensionsMatch(this.#ports.currentDimensions(), dimensions)) return
    this.#applyingLocalResize = true
    try {
      this.#ports.applyLocalDimensions(dimensions)
    } finally {
      this.#applyingLocalResize = false
    }
  }

  #scheduleRedraw() {
    const now = this.#now()
    if (this.#resizeRedrawStartedAt === null) this.#resizeRedrawStartedAt = now
    if (this.#resizeRedrawTimer !== null) this.#clearTimeout(this.#resizeRedrawTimer)
    const deadline = this.#resizeRedrawStartedAt + TERMINAL_RESIZE_REDRAW_MAX_MS
    const delay = Math.max(0, Math.min(TERMINAL_RESIZE_REDRAW_QUIET_MS, deadline - now))
    const token = this.#captureEffectToken()
    let timer = 0
    timer = this.#setTimeout(() => {
      if (this.#resizeRedrawTimer !== timer) return
      this.#resizeRedrawTimer = null
      this.#resizeRedrawStartedAt = null
      if (this.#isCurrentEffectToken(token)) this.#ports.flushOutput()
    }, delay)
    this.#resizeRedrawTimer = timer
  }

  #clearFit() {
    if (this.#fitResizeTimer !== null) this.#clearTimeout(this.#fitResizeTimer)
    this.#fitResizeTimer = null
    this.#pendingFitResize = null
  }

  #clearRedraw() {
    if (this.#resizeRedrawTimer !== null) this.#clearTimeout(this.#resizeRedrawTimer)
    this.#resizeRedrawTimer = null
    this.#resizeRedrawStartedAt = null
  }

  #clearDeliveryTimeout() {
    if (this.#resizeDeliveryTimeout !== null) this.#clearTimeout(this.#resizeDeliveryTimeout)
    this.#resizeDeliveryTimeout = null
  }

  #invalidateTransientEffects() {
    this.#revision += 1
    if (this.#observerFrame !== null) this.#cancelAnimationFrame(this.#observerFrame)
    this.#observerFrame = null
    this.#clearFit()
    this.#clearRedraw()
    this.#clearDeliveryTimeout()
    this.#resizeRequestInFlight = null
    this.#pendingResizeRequest = null
  }
}
