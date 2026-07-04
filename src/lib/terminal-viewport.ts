export interface TerminalFollowState {
  following: boolean
  hasUnreadOutput: boolean
}

interface TerminalViewportHost {
  viewportY?: number
  rows?: number
  getScrollbackLength?: () => number
  getVisibleBufferBase?: () => number
}

interface TerminalFollowRecord {
  terminal: TerminalViewportHost
  followOutput: boolean
  hasUnreadOutput: boolean
  preserveUnreadOutputUntilJump: boolean
  followOutputHandler: ((state: TerminalFollowState) => void) | null
}

export function getTerminalScrollbackLength(terminal: TerminalViewportHost) {
  const length = terminal.getScrollbackLength?.()
  return Number.isFinite(length) ? Math.max(0, Number(length)) : 0
}

export function getTerminalViewportY(terminal: TerminalViewportHost) {
  const viewportY = Number(terminal.viewportY || 0)
  return Number.isFinite(viewportY) ? Math.max(0, viewportY) : 0
}

export function getTerminalVisibleBufferBase(terminal: TerminalViewportHost) {
  const base = terminal.getVisibleBufferBase?.()
  return Number.isFinite(base) ? Math.max(0, Number(base)) : getTerminalViewportY(terminal)
}

export function isTerminalAtBottom(record: Pick<TerminalFollowRecord, 'terminal'>) {
  return getTerminalViewportY(record.terminal) <= 0
}

export function emitFollowOutputState(record: TerminalFollowRecord) {
  record.followOutputHandler?.({
    following: record.followOutput,
    hasUnreadOutput: record.hasUnreadOutput,
  })
}

export function setFollowOutputState(
  record: TerminalFollowRecord,
  following: boolean,
  hasUnreadOutput: boolean,
  options: { allowClearUnread?: boolean } = {},
) {
  if (record.preserveUnreadOutputUntilJump && !hasUnreadOutput && options.allowClearUnread !== true) {
    hasUnreadOutput = true
  }
  if (!hasUnreadOutput && options.allowClearUnread === true) {
    record.preserveUnreadOutputUntilJump = false
  }
  if (record.followOutput === following && record.hasUnreadOutput === hasUnreadOutput) return
  record.followOutput = following
  record.hasUnreadOutput = hasUnreadOutput
  emitFollowOutputState(record)
}

export function markTerminalOutputUnreadUntilJump(record: TerminalFollowRecord) {
  record.preserveUnreadOutputUntilJump = true
  setFollowOutputState(record, false, true)
}

export function terminalPageScrollTarget(
  terminal: TerminalViewportHost,
  key: 'PageUp' | 'PageDown',
  fallbackRows: number,
) {
  const scrollbackLength = getTerminalScrollbackLength(terminal)
  const currentViewportY = getTerminalViewportY(terminal)
  const pageRows = Math.max(1, Math.floor((terminal.rows || fallbackRows) * 0.9))
  return key === 'PageUp'
    ? Math.min(scrollbackLength, currentViewportY + pageRows)
    : Math.max(0, currentViewportY - pageRows)
}

export function restoredTerminalViewportY(
  terminal: TerminalViewportHost,
  previousViewportY: number,
  previousScrollbackLength: number,
) {
  const currentScrollbackLength = getTerminalScrollbackLength(terminal)
  const scrollbackDelta = currentScrollbackLength - previousScrollbackLength
  return Math.max(0, previousViewportY + scrollbackDelta)
}
