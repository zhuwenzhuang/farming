import type { FarmingTerminal } from '@/lib/terminal-engine'
import {
  getTerminalScrollbackLength,
  getTerminalViewportY,
  markTerminalOutputUnreadUntilJump,
  restoredTerminalViewportY,
  setFollowOutputState,
} from '@/lib/terminal-viewport'

const QUIET_TERMINAL_WRITE_THRESHOLD = 512

export interface TerminalOutputRecord {
  terminal: FarmingTerminal
  hostEl: HTMLElement
  disposed: boolean
  replication: {
    terminalWriteQueue: Promise<void>
    terminalWriteResolvers: Set<(cancelled?: boolean) => boolean>
    terminalWriteBatchCount: number
  }
  followOutput: boolean
  hasUnreadOutput: boolean
  preserveUnreadOutputUntilJump: boolean
  followOutputHandler: ((state: { following: boolean; hasUnreadOutput: boolean }) => void) | null
}

export function forceTerminalRender(record: TerminalOutputRecord) {
  record.terminal.refresh?.(0, Math.max(0, (record.terminal.rows || 1) - 1))
}

export function scheduleTerminalRepaint(record: TerminalOutputRecord) {
  forceTerminalRender(record)

  requestAnimationFrame(() => {
    if (record.disposed) return
    forceTerminalRender(record)
  })
}

export function scrollRecordToViewportY(record: TerminalOutputRecord, viewportY: number) {
  const scrollbackLength = getTerminalScrollbackLength(record.terminal)
  const targetLine = Math.max(0, Math.min(scrollbackLength, viewportY))
  if (typeof record.terminal.scrollToLine === 'function') {
    record.terminal.scrollToLine(targetLine)
  } else {
    record.terminal.viewportY = targetLine
  }
  forceTerminalRender(record)
}

export function scrollRecordToLine(record: TerminalOutputRecord, line: number) {
  const scrollbackLength = getTerminalScrollbackLength(record.terminal)
  const targetLineFromTop = Math.max(0, Math.min(scrollbackLength, line))
  scrollRecordToViewportY(record, scrollbackLength - targetLineFromTop)
}

export function scrollRecordToBottom(record: TerminalOutputRecord, options: { allowClearUnread?: boolean } = {}) {
  if (record.disposed) return
  if (getTerminalScrollbackLength(record.terminal) <= 0) {
    forceTerminalRender(record)
    setFollowOutputState(record, true, false, options)
    return
  }
  if (typeof record.terminal.scrollToBottom === 'function') {
    record.terminal.scrollToBottom()
    forceTerminalRender(record)
  } else {
    scrollRecordToViewportY(record, 0)
  }
  setFollowOutputState(record, true, false, options)
}

function restoreTerminalViewport(
  record: TerminalOutputRecord,
  previousViewportY: number,
  previousScrollbackLength: number,
  hasUnreadOutput: boolean,
) {
  if (record.disposed) return
  const targetLine = restoredTerminalViewportY(record.terminal, previousViewportY, previousScrollbackLength)
  scrollRecordToViewportY(record, targetLine)
  setFollowOutputState(record, false, hasUnreadOutput)
}

function restoreUserScrollAfterWrite(
  record: TerminalOutputRecord,
  previousViewportY: number,
  previousScrollbackLength: number,
) {
  restoreTerminalViewport(record, previousViewportY, previousScrollbackLength, true)
  markTerminalOutputUnreadUntilJump(record)
}

export function restoreViewportAfterLayout(
  record: TerminalOutputRecord,
  previousViewportY: number,
  previousScrollbackLength: number,
  wasFollowing: boolean,
  hadUnreadOutput: boolean,
) {
  if (record.disposed) return
  if (wasFollowing) {
    scrollRecordToBottom(record, {
      allowClearUnread: !record.preserveUnreadOutputUntilJump,
    })
    return
  }
  restoreTerminalViewport(record, previousViewportY, previousScrollbackLength, hadUnreadOutput)
}

function writeTerminalData(record: TerminalOutputRecord, data: string, callback?: () => void) {
  record.replication.terminalWriteBatchCount += 1
  record.terminal.write(data, callback)
}

function enqueueTerminalWrite(
  record: TerminalOutputRecord,
  operation: (done: (cancelled?: boolean) => boolean) => void,
  onCancel?: () => void,
) {
  record.replication.terminalWriteQueue = record.replication.terminalWriteQueue
    .catch(() => {})
    .then(() => new Promise<void>(resolve => {
      let settled = false
      const done = (cancelled = false) => {
        if (settled) return false
        settled = true
        record.replication.terminalWriteResolvers.delete(done)
        if (cancelled) {
          onCancel?.()
        }
        resolve()
        return true
      }
      record.replication.terminalWriteResolvers.add(done)
      operation(done)
    }))
  return record.replication.terminalWriteQueue
}

export function flushPendingTerminalWrites(record: TerminalOutputRecord) {
  const resolvers = Array.from(record.replication.terminalWriteResolvers)
  record.replication.terminalWriteResolvers.clear()
  resolvers.forEach(resolve => resolve(true))
}

function completeTerminalWrite(done: () => boolean, callback?: () => void) {
  if (done()) {
    callback?.()
  }
}

export function writeTerminalOutput(
  record: TerminalOutputRecord,
  data: string,
  callback?: () => void,
  options: {
    quiet?: boolean
    isOutputObserved?: () => boolean
  } = {},
) {
  if (!data) {
    callback?.()
    return
  }

  void enqueueTerminalWrite(record, done => {
    if (record.disposed) {
      completeTerminalWrite(done, callback)
      return
    }

    const previousViewportY = getTerminalViewportY(record.terminal)
    const previousScrollbackLength = getTerminalScrollbackLength(record.terminal)
    const shouldFollowOutput = record.followOutput
    const quiet = options.quiet === true || data.length >= QUIET_TERMINAL_WRITE_THRESHOLD
    const outputObserved = options.isOutputObserved?.() ?? true

    writeTerminalData(record, data, () => {
      if (record.disposed) {
        completeTerminalWrite(done, callback)
        return
      }
      if (shouldFollowOutput) {
        if (!outputObserved) {
          markTerminalOutputUnreadUntilJump(record)
        } else if (quiet) {
          scrollRecordToBottom(record, {
            allowClearUnread: !record.preserveUnreadOutputUntilJump,
          })
        } else {
          setFollowOutputState(record, true, false, {
            allowClearUnread: !record.preserveUnreadOutputUntilJump,
          })
        }
      } else if (!outputObserved) {
        markTerminalOutputUnreadUntilJump(record)
      } else {
        restoreUserScrollAfterWrite(record, previousViewportY, previousScrollbackLength)
        requestAnimationFrame(() => {
          if (record.disposed) return
          restoreUserScrollAfterWrite(record, previousViewportY, previousScrollbackLength)
          forceTerminalRender(record)
        })
      }
      completeTerminalWrite(done, callback)
    })
  }, () => {
    callback?.()
  })
}

export function replaceTerminalOutput(
  record: TerminalOutputRecord,
  data: string,
  callback?: () => void,
  options: { beforeReplace?: () => boolean } = {},
) {
  void enqueueTerminalWrite(record, done => {
    if (record.disposed) {
      completeTerminalWrite(done, callback)
      return
    }
    if (options.beforeReplace && !options.beforeReplace()) {
      completeTerminalWrite(done, callback)
      return
    }

    const previousViewportY = getTerminalViewportY(record.terminal)
    const previousScrollbackLength = getTerminalScrollbackLength(record.terminal)
    const shouldFollowOutput = record.followOutput

    record.terminal.reset()
    if (!data) {
      forceTerminalRender(record)
      completeTerminalWrite(done, callback)
      return
    }

    writeTerminalData(record, data, () => {
      if (record.disposed) {
        completeTerminalWrite(done, callback)
        return
      }
      if (shouldFollowOutput) {
        scrollRecordToBottom(record, {
          allowClearUnread: !record.preserveUnreadOutputUntilJump,
        })
      } else {
        restoreUserScrollAfterWrite(record, previousViewportY, previousScrollbackLength)
      }
      if (!shouldFollowOutput && previousScrollbackLength === getTerminalScrollbackLength(record.terminal)) {
        forceTerminalRender(record)
      }
      forceTerminalRender(record)
      completeTerminalWrite(done, callback)
    })
  }, () => {
    callback?.()
  })
}
