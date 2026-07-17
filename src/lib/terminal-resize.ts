export const MIN_TERMINAL_RESIZE_COLS = 40
export const MIN_TERMINAL_RESIZE_ROWS = 10

export interface TerminalResizeDimensions {
  cols: number
  rows: number
}

export interface TerminalResizeFitAddon {
  proposeDimensions: () => TerminalResizeDimensions | undefined
}

export interface TerminalResizeTracker {
  lastNotifiedResize: TerminalResizeDimensions | null
  resizeNotificationCount: number
}

export interface TerminalResizeDeliveryTracker {
  resizeRequestInFlight: TerminalResizeDimensions | null
  pendingResizeRequest: TerminalResizeDimensions | null
}

export interface TerminalResizeDeliveryDecision {
  matched: boolean
  preserveLocalGeometry: boolean
  next: TerminalResizeDimensions | null
}

export type TerminalResizeHandler = (cols: number, rows: number) => boolean | void

export function normalizeTerminalResizeDimensions(cols: number, rows: number): TerminalResizeDimensions | null {
  const nextCols = Math.floor(Number(cols))
  const nextRows = Math.floor(Number(rows))
  if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) return null
  if (nextCols < MIN_TERMINAL_RESIZE_COLS || nextRows < MIN_TERMINAL_RESIZE_ROWS) return null
  return { cols: nextCols, rows: nextRows }
}

export function proposeTerminalResizeDimensions(
  hostEl: HTMLElement,
  fitAddon: TerminalResizeFitAddon,
): TerminalResizeDimensions | null {
  const hostRect = hostEl.getBoundingClientRect()
  if (hostRect.width <= 0 || hostRect.height <= 0) return null

  const dimensions = fitAddon.proposeDimensions()
  if (!dimensions) return null
  return normalizeTerminalResizeDimensions(dimensions.cols, dimensions.rows)
}

export function notifyTerminalResizeTracker(
  tracker: TerminalResizeTracker,
  cols: number,
  rows: number,
  onResize: TerminalResizeHandler,
  options: { force?: boolean } = {},
) {
  const next = normalizeTerminalResizeDimensions(cols, rows)
  if (!next) return false
  if (
    !options.force &&
    tracker.lastNotifiedResize &&
    tracker.lastNotifiedResize.cols === next.cols &&
    tracker.lastNotifiedResize.rows === next.rows
  ) {
    return false
  }

  const delivered = onResize(next.cols, next.rows)
  if (delivered === false) return false
  tracker.lastNotifiedResize = next
  tracker.resizeNotificationCount += 1
  return true
}

export function resetTerminalResizeTracker(tracker: TerminalResizeTracker) {
  tracker.lastNotifiedResize = null
}

export function shouldDebounceTerminalResize(
  current: TerminalResizeDimensions,
  next: TerminalResizeDimensions,
  options: { force?: boolean } = {},
) {
  return (
    options.force !== true &&
    (current.cols !== next.cols || current.rows !== next.rows)
  )
}

function terminalResizeDimensionsMatch(
  left: TerminalResizeDimensions | null,
  right: TerminalResizeDimensions | null,
) {
  return Boolean(
    left &&
    right &&
    left.cols === right.cols &&
    left.rows === right.rows
  )
}

export function queueTerminalResizeDelivery(
  tracker: TerminalResizeDeliveryTracker,
  cols: number,
  rows: number,
  onResize: TerminalResizeHandler,
) {
  const next = normalizeTerminalResizeDimensions(cols, rows)
  if (!next) return false

  if (tracker.resizeRequestInFlight) {
    tracker.pendingResizeRequest = next
    return true
  }

  const delivered = onResize(next.cols, next.rows)
  if (delivered === false) return false
  tracker.resizeRequestInFlight = next
  return true
}

export function acknowledgeTerminalResizeDelivery(
  tracker: TerminalResizeDeliveryTracker,
  cols: number,
  rows: number,
): TerminalResizeDeliveryDecision {
  const committed = normalizeTerminalResizeDimensions(cols, rows)
  if (!terminalResizeDimensionsMatch(tracker.resizeRequestInFlight, committed)) {
    return {
      matched: false,
      preserveLocalGeometry: tracker.resizeRequestInFlight !== null,
      next: null,
    }
  }

  const pending = tracker.pendingResizeRequest
  tracker.resizeRequestInFlight = null
  tracker.pendingResizeRequest = null

  if (!pending || terminalResizeDimensionsMatch(pending, committed)) {
    return { matched: true, preserveLocalGeometry: false, next: null }
  }

  return {
    matched: true,
    preserveLocalGeometry: true,
    next: pending,
  }
}

export function resetTerminalResizeDeliveryTracker(tracker: TerminalResizeDeliveryTracker) {
  tracker.resizeRequestInFlight = null
  tracker.pendingResizeRequest = null
}

export function expireTerminalResizeDelivery(tracker: TerminalResizeDeliveryTracker) {
  const next = tracker.pendingResizeRequest
  resetTerminalResizeDeliveryTracker(tracker)
  return next
}
