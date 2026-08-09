import type { TerminalResizeDimensions } from '@/lib/terminal-resize'

export const TERMINAL_RESIZE_SETTLE_MS = 250
export const TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS = 1500
export const TERMINAL_RESIZE_REDRAW_QUIET_MS = 50
export const TERMINAL_RESIZE_REDRAW_MAX_MS = 300

interface TerminalResizeSchedulerCallbacks {
  onFitSettled: (dimensions: TerminalResizeDimensions) => void
  onRedrawFlush: () => void
  onDeliveryTimeout: () => void
}

interface TerminalResizeSchedulerClock {
  now?: () => number
  setTimeout?: (callback: () => void, delay: number) => number
  clearTimeout?: (timer: number) => void
}

export interface TerminalResizeSchedulerDiagnostics {
  pendingFitResize: TerminalResizeDimensions | null
  fitResizeTimerPending: boolean
  resizeRedrawTimerPending: boolean
  resizeDeliveryTimeoutPending: boolean
}

export interface TerminalResizeScheduler {
  scheduleFit: (dimensions: TerminalResizeDimensions) => void
  clearFit: () => void
  scheduleRedraw: (restart?: boolean) => void
  clearRedraw: () => void
  scheduleDeliveryTimeout: () => void
  clearDeliveryTimeout: () => void
  reset: () => void
  isRedrawPending: () => boolean
  diagnostics: () => TerminalResizeSchedulerDiagnostics
}

export function createTerminalResizeScheduler(
  callbacks: TerminalResizeSchedulerCallbacks,
  clock: TerminalResizeSchedulerClock = {},
): TerminalResizeScheduler {
  const now = clock.now ?? Date.now
  const setTimer = clock.setTimeout ?? ((callback, delay) => window.setTimeout(callback, delay))
  const clearTimer = clock.clearTimeout ?? (timer => window.clearTimeout(timer))
  let pendingFitResize: TerminalResizeDimensions | null = null
  let fitResizeTimer: number | null = null
  let resizeRedrawStartedAt: number | null = null
  let resizeRedrawTimer: number | null = null
  let resizeDeliveryTimeout: number | null = null

  const clearFit = () => {
    if (fitResizeTimer !== null) clearTimer(fitResizeTimer)
    fitResizeTimer = null
    pendingFitResize = null
  }
  const clearRedraw = () => {
    if (resizeRedrawTimer !== null) clearTimer(resizeRedrawTimer)
    resizeRedrawTimer = null
    resizeRedrawStartedAt = null
  }
  const clearDeliveryTimeout = () => {
    if (resizeDeliveryTimeout !== null) clearTimer(resizeDeliveryTimeout)
    resizeDeliveryTimeout = null
  }

  return {
    scheduleFit(dimensions) {
      if (fitResizeTimer !== null) clearTimer(fitResizeTimer)
      pendingFitResize = dimensions
      fitResizeTimer = setTimer(() => {
        fitResizeTimer = null
        const next = pendingFitResize
        pendingFitResize = null
        if (next) callbacks.onFitSettled(next)
      }, TERMINAL_RESIZE_SETTLE_MS)
    },
    clearFit,
    scheduleRedraw(restart = false) {
      const startedAt = now()
      if (restart || resizeRedrawStartedAt === null) resizeRedrawStartedAt = startedAt
      if (resizeRedrawTimer !== null) clearTimer(resizeRedrawTimer)
      const deadline = resizeRedrawStartedAt + TERMINAL_RESIZE_REDRAW_MAX_MS
      const delay = Math.max(0, Math.min(TERMINAL_RESIZE_REDRAW_QUIET_MS, deadline - startedAt))
      resizeRedrawTimer = setTimer(() => {
        resizeRedrawTimer = null
        resizeRedrawStartedAt = null
        callbacks.onRedrawFlush()
      }, delay)
    },
    clearRedraw,
    scheduleDeliveryTimeout() {
      clearDeliveryTimeout()
      resizeDeliveryTimeout = setTimer(() => {
        resizeDeliveryTimeout = null
        callbacks.onDeliveryTimeout()
      }, TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS)
    },
    clearDeliveryTimeout,
    reset() {
      clearFit()
      clearRedraw()
      clearDeliveryTimeout()
    },
    isRedrawPending() {
      return resizeRedrawTimer !== null
    },
    diagnostics() {
      return {
        pendingFitResize,
        fitResizeTimerPending: fitResizeTimer !== null,
        resizeRedrawTimerPending: resizeRedrawTimer !== null,
        resizeDeliveryTimeoutPending: resizeDeliveryTimeout !== null,
      }
    },
  }
}
