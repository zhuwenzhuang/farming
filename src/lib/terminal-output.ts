import { DEFAULT_THEME, isXtermTerminal } from '@/lib/terminal-engine'
import type { FarmingTerminal } from '@/lib/terminal-engine'
import type { TerminalRendererEffectController, TerminalRenderSuspensionLease } from '@/lib/terminal-renderer-effects'
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
  rendererEffects: Pick<TerminalRendererEffectController, 'acquireRenderSuspension'>
  terminalWriteQueue: Promise<void>
  terminalWriteResolvers: Set<(cancelled?: boolean) => boolean>
  terminalWriteBatchCount: number
  followOutput: boolean
  hasUnreadOutput: boolean
  preserveUnreadOutputUntilJump: boolean
  followOutputHandler: ((state: { following: boolean; hasUnreadOutput: boolean }) => void) | null
}

export function forceTerminalRender(record: TerminalOutputRecord) {
  if (isXtermTerminal(record.terminal)) {
    record.terminal.refresh?.(0, Math.max(0, (record.terminal.rows || 1) - 1))
    return
  }

  const { renderer, wasmTerm } = record.terminal
  if (!renderer?.render || !wasmTerm) return

  clearTerminalCanvas(record)
  renderer.render(wasmTerm, true, record.terminal.viewportY || 0, record.terminal)
}

function clearTerminalCanvas(record: TerminalOutputRecord) {
  const canvas = record.terminal.renderer?.getCanvas?.() || record.hostEl.querySelector('canvas')
  if (!(canvas instanceof HTMLCanvasElement)) return

  const context = canvas.getContext('2d')
  if (!context) return

  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.fillStyle = DEFAULT_THEME.background
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.restore()
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
  record.terminalWriteBatchCount += 1
  record.terminal.write(data, callback)
}

function renderLiveTerminalOutput(record: TerminalOutputRecord) {
  // xterm's WebGL renderer batches writes into animation frames. Refreshing
  // every PTY chunk defeats that batching and makes high-frequency TUIs look
  // as though the whole screen is flashing. The Ghostty debug renderer still
  // needs an explicit paint here.
  if (!isXtermTerminal(record.terminal)) {
    forceTerminalRender(record)
  }
}

function enqueueTerminalWrite(
  record: TerminalOutputRecord,
  operation: (done: (cancelled?: boolean) => boolean) => void,
  onCancel?: () => void,
) {
  record.terminalWriteQueue = record.terminalWriteQueue
    .catch(() => {})
    .then(() => new Promise<void>(resolve => {
      let settled = false
      const done = (cancelled = false) => {
        if (settled) return false
        settled = true
        record.terminalWriteResolvers.delete(done)
        if (cancelled) {
          onCancel?.()
        }
        resolve()
        return true
      }
      record.terminalWriteResolvers.add(done)
      operation(done)
    }))
  return record.terminalWriteQueue
}

export function flushPendingTerminalWrites(record: TerminalOutputRecord) {
  const resolvers = Array.from(record.terminalWriteResolvers)
  record.terminalWriteResolvers.clear()
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

  let renderSuspension: TerminalRenderSuspensionLease | null = null
  const releaseRenderSuspension = () => {
    renderSuspension?.release()
    renderSuspension = null
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

    if (quiet) {
      renderSuspension = record.rendererEffects.acquireRenderSuspension()
    }
    writeTerminalData(record, data, () => {
      releaseRenderSuspension()
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
      if (outputObserved) {
        renderLiveTerminalOutput(record)
      }
      completeTerminalWrite(done, callback)
    })
  }, () => {
    releaseRenderSuspension()
    callback?.()
  })
}

export function replaceTerminalOutput(
  record: TerminalOutputRecord,
  data: string,
  callback?: () => void,
  options: { beforeReplace?: () => boolean } = {},
) {
  let renderSuspension: TerminalRenderSuspensionLease | null = null
  const releaseRenderSuspension = () => {
    renderSuspension?.release()
    renderSuspension = null
  }
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

    renderSuspension = record.rendererEffects.acquireRenderSuspension()
    record.terminal.reset()
    if (!data) {
      releaseRenderSuspension()
      forceTerminalRender(record)
      completeTerminalWrite(done, callback)
      return
    }

    writeTerminalData(record, data, () => {
      releaseRenderSuspension()
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
    releaseRenderSuspension()
    callback?.()
  })
}
