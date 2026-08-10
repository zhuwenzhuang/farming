import {
  appendTerminalTouchVelocitySample,
  blendTerminalTouchVelocity,
  consumeTerminalTouchScrollDelta,
  nextTerminalTouchEdgeOffset,
  readTerminalTouchGestureVelocity,
  shouldStartTerminalTouchMomentum,
  stepTerminalTouchMomentum,
  type TerminalTouchVelocitySample,
} from '@/lib/terminal-touch-scroll'

const TOUCH_SCROLL_ACTIVATION_PX = 6
const TOUCH_LONG_PRESS_MS = 520
const TOUCH_EDGE_SPRING_MS = 240

export interface TerminalTouchInteractionPorts {
  hostEl: HTMLElement
  isDisposed: () => boolean
  copyTextAtEvent: (event: PointerEvent) => string
  showContextMenu: (event: PointerEvent, copyText: string) => void
  lineHeight: () => number
  viewportY: () => number
  scrollToViewportY: (viewportY: number) => void
  onViewportChanged: () => void
  hideContextMenu: () => void
}

export interface TerminalTouchInteractionRuntime {
  now?: () => number
  setTimeout?: (callback: () => void, delay: number) => number
  clearTimeout?: (timer: number) => void
  requestAnimationFrame?: (callback: FrameRequestCallback) => number
  cancelAnimationFrame?: (frame: number) => void
}

/** Owns one Terminal host's touch gesture, long-press, edge, and momentum state. */
export class TerminalTouchInteractionController {
  readonly #ports: TerminalTouchInteractionPorts
  readonly #now: () => number
  readonly #setTimeout: (callback: () => void, delay: number) => number
  readonly #clearTimeout: (timer: number) => void
  readonly #requestAnimationFrame: (callback: FrameRequestCallback) => number
  readonly #cancelAnimationFrame: (frame: number) => void

  #pointerId: number | null = null
  #startX = 0
  #startY = 0
  #lastY = 0
  #lastMoveAt = 0
  #velocityY = 0
  #scrollRemainderPx = 0
  #moved = false
  #momentumFrame: number | null = null
  #momentumLastAt = 0
  #velocitySamples: TerminalTouchVelocitySample[] = []
  #edgeOffsetPx = 0
  #edgeResetTimer: number | null = null
  #longPressTimer: number | null = null
  #longPressEvent: PointerEvent | null = null
  #installed = false
  #disposed = false

  constructor(
    ports: TerminalTouchInteractionPorts,
    runtime: TerminalTouchInteractionRuntime = {},
  ) {
    this.#ports = ports
    this.#now = runtime.now ?? (() => performance.now())
    this.#setTimeout = runtime.setTimeout ?? ((callback, delay) => window.setTimeout(callback, delay))
    this.#clearTimeout = runtime.clearTimeout ?? (timer => window.clearTimeout(timer))
    this.#requestAnimationFrame = runtime.requestAnimationFrame
      ?? (callback => window.requestAnimationFrame(callback))
    this.#cancelAnimationFrame = runtime.cancelAnimationFrame
      ?? (frame => window.cancelAnimationFrame(frame))
  }

  install() {
    if (this.#disposed || this.#installed) return false
    this.#installed = true
    const host = this.#ports.hostEl
    host.addEventListener('pointerdown', this.#pointerDown, { capture: true, passive: false })
    host.addEventListener('pointermove', this.#pointerMove, { capture: true, passive: false })
    host.addEventListener('pointerup', this.#pointerUp, { capture: true, passive: false })
    host.addEventListener('pointercancel', this.#pointerUp, { capture: true, passive: false })
    host.addEventListener('lostpointercapture', this.#pointerUp, { capture: true, passive: false })
    return true
  }

  stopTouchMomentum() {
    if (this.#momentumFrame !== null) {
      this.#cancelAnimationFrame(this.#momentumFrame)
      this.#momentumFrame = null
    }
    this.#momentumLastAt = 0
    this.#velocityY = 0
    this.#scrollRemainderPx = 0
  }

  dispose() {
    if (this.#disposed) return false
    this.#disposed = true
    this.stopTouchMomentum()
    this.#clearLongPress()
    this.#pointerId = null
    this.#velocitySamples = []
    this.#releaseEdge(false)
    if (this.#installed) {
      const host = this.#ports.hostEl
      host.removeEventListener('pointerdown', this.#pointerDown, true)
      host.removeEventListener('pointermove', this.#pointerMove, true)
      host.removeEventListener('pointerup', this.#pointerUp, true)
      host.removeEventListener('pointercancel', this.#pointerUp, true)
      host.removeEventListener('lostpointercapture', this.#pointerUp, true)
      this.#installed = false
    }
    return true
  }

  #clearLongPress() {
    if (this.#longPressTimer !== null) {
      this.#clearTimeout(this.#longPressTimer)
      this.#longPressTimer = null
    }
    this.#longPressEvent = null
  }

  #touchSurface() {
    return this.#ports.hostEl.querySelector<HTMLElement>('.xterm-screen')
  }

  #clearEdgeResetTimer() {
    if (this.#edgeResetTimer === null) return
    this.#clearTimeout(this.#edgeResetTimer)
    this.#edgeResetTimer = null
  }

  #renderEdgeOffset(offsetPx: number, animate = false) {
    const surface = this.#touchSurface()
    this.#edgeOffsetPx = offsetPx
    if (!surface) return
    this.#clearEdgeResetTimer()
    surface.style.transition = animate
      ? `transform ${TOUCH_EDGE_SPRING_MS}ms cubic-bezier(0.22, 0.75, 0.28, 1)`
      : 'none'
    surface.style.transform = offsetPx === 0 ? '' : `translate3d(0, ${offsetPx}px, 0)`
    if (animate) {
      this.#edgeResetTimer = this.#setTimeout(() => {
        surface.style.transition = ''
        surface.style.transform = ''
        this.#edgeResetTimer = null
      }, TOUCH_EDGE_SPRING_MS)
    }
  }

  #pullEdge(deltaY: number) {
    this.#renderEdgeOffset(nextTerminalTouchEdgeOffset(this.#edgeOffsetPx, deltaY))
  }

  #releaseEdge(animate = true) {
    if (this.#edgeOffsetPx === 0 && this.#edgeResetTimer === null) return
    this.#renderEdgeOffset(0, animate)
  }

  #pushVelocitySample(y: number, at: number) {
    this.#velocitySamples = appendTerminalTouchVelocitySample(this.#velocitySamples, { y, at })
  }

  #gestureVelocity() {
    return readTerminalTouchGestureVelocity(this.#velocitySamples, this.#velocityY)
  }

  #handleLongPress = () => {
    const event = this.#longPressEvent
    this.#clearLongPress()
    if (!event || this.#disposed || this.#ports.isDisposed() || this.#moved) return
    const copyText = this.#ports.copyTextAtEvent(event)
    if (copyText) this.#ports.showContextMenu(event, copyText)
  }

  #scrollByTouchDelta(deltaY: number) {
    const scrollDelta = consumeTerminalTouchScrollDelta(
      this.#scrollRemainderPx,
      deltaY,
      Math.max(8, this.#ports.lineHeight() || 16),
    )
    this.#scrollRemainderPx = scrollDelta.remainderPx
    if (scrollDelta.lineDelta === 0) return false

    const previousViewportY = this.#ports.viewportY()
    this.#ports.scrollToViewportY(previousViewportY + scrollDelta.lineDelta)
    const moved = this.#ports.viewportY() !== previousViewportY
    if (moved) {
      this.#ports.onViewportChanged()
      this.#ports.hideContextMenu()
    }
    return moved
  }

  #stepMomentum = (timestamp: number) => {
    if (this.#disposed || this.#ports.isDisposed()) {
      this.#momentumFrame = null
      return
    }
    const step = stepTerminalTouchMomentum(this.#velocityY, this.#momentumLastAt, timestamp)
    this.#momentumLastAt = timestamp
    const moved = this.#scrollByTouchDelta(step.scrollDeltaPx)
    this.#velocityY = step.nextVelocity
    if (!moved || !step.shouldContinue) {
      if (!moved) this.#pullEdge(step.scrollDeltaPx)
      this.stopTouchMomentum()
      this.#releaseEdge()
      return
    }
    this.#momentumFrame = this.#requestAnimationFrame(this.#stepMomentum)
  }

  #startMomentum() {
    if (!shouldStartTerminalTouchMomentum(this.#velocityY)) {
      this.#velocityY = 0
      return
    }
    this.#momentumLastAt = 0
    this.#momentumFrame = this.#requestAnimationFrame(this.#stepMomentum)
  }

  #pointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || this.#disposed || this.#ports.isDisposed()) return
    this.stopTouchMomentum()
    this.#releaseEdge(false)
    this.#pointerId = event.pointerId
    this.#startX = event.clientX
    this.#startY = event.clientY
    this.#lastY = event.clientY
    this.#lastMoveAt = event.timeStamp || this.#now()
    this.#velocitySamples = []
    this.#pushVelocitySample(event.clientY, this.#lastMoveAt)
    this.#scrollRemainderPx = 0
    this.#moved = false
    this.#longPressEvent = event
    this.#longPressTimer = this.#setTimeout(this.#handleLongPress, TOUCH_LONG_PRESS_MS)
    try {
      this.#ports.hostEl.setPointerCapture(event.pointerId)
    } catch {
      // Touch scrolling still works while the pointer remains inside the host.
    }
  }

  #pointerMove = (event: PointerEvent) => {
    if (this.#pointerId === null || event.pointerId !== this.#pointerId) return
    const distance = Math.hypot(event.clientX - this.#startX, event.clientY - this.#startY)
    if (distance > TOUCH_SCROLL_ACTIVATION_PX) {
      this.#moved = true
      this.#clearLongPress()
    }

    const deltaY = event.clientY - this.#lastY
    const now = event.timeStamp || this.#now()
    const elapsed = Math.max(1, now - this.#lastMoveAt)
    this.#lastY = event.clientY
    this.#lastMoveAt = now
    if (Math.abs(deltaY) < 0.5) return
    this.#pushVelocitySample(event.clientY, now)
    this.#velocityY = blendTerminalTouchVelocity(this.#gestureVelocity(), deltaY, elapsed)

    const moved = this.#scrollByTouchDelta(deltaY)
    if (!moved && this.#moved) this.#pullEdge(deltaY)
    else if (moved && this.#edgeOffsetPx !== 0) this.#releaseEdge(false)
    if (this.#moved || moved) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  #pointerUp = (event: PointerEvent) => {
    if (this.#pointerId === null || event.pointerId !== this.#pointerId) return
    const wasMoving = this.#moved
    this.#pointerId = null
    this.#clearLongPress()
    if (wasMoving) {
      event.preventDefault()
      event.stopPropagation()
      this.#ports.onViewportChanged()
      this.#velocityY = this.#gestureVelocity()
      if (event.type === 'pointerup' && this.#edgeOffsetPx === 0) this.#startMomentum()
      else {
        this.stopTouchMomentum()
        this.#releaseEdge()
      }
    } else {
      this.#velocityY = 0
      this.#scrollRemainderPx = 0
      this.#releaseEdge()
    }
    this.#velocitySamples = []
    try {
      this.#ports.hostEl.releasePointerCapture(event.pointerId)
    } catch {
      // The browser may already have released capture.
    }
  }
}
