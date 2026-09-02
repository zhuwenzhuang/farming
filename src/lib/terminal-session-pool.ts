import '../../frontend/terminal-replay.js'
import { beginTerminalInputPerformance, observeTerminalPerformanceOutput, navigationPerformanceReady } from './interaction-performance'
import {
  DEFAULT_THEME,
  createTerminalInstance,
} from '@/lib/terminal-engine'
import type { FarmingFitAddon, FarmingTerminal } from '@/lib/terminal-engine'
import {
  TerminalLinkInteractionController,
  createTerminalLinkHandlersCommitLatch,
} from '@/lib/terminal-link-interaction'
import type { TerminalLinkHandlersRevision } from '@/lib/terminal-link-interaction'
import type { TerminalPathOpenTarget } from '@/lib/terminal-links'
import {
  isZeroWidthCell,
  readCellText,
  TerminalSelectionController,
  type TerminalLogicalLine,
} from '@/lib/terminal-selection'
import {
  emitFollowOutputState,
  getTerminalScrollbackLength,
  getTerminalVisibleBufferBase,
  getTerminalViewportY,
  isTerminalAtBottom,
  setFollowOutputState,
  terminalPageScrollTarget,
} from '@/lib/terminal-viewport'
import type { TerminalFollowState } from '@/lib/terminal-viewport'
import {
  MIN_TERMINAL_RESIZE_ROWS,
  proposeTerminalResizeDimensions,
} from '@/lib/terminal-resize'
import { TerminalResizeEffectController } from '@/lib/terminal-resize-effect-controller'
import { TerminalSessionInteractionController } from '@/lib/terminal-session-interaction'
import {
  applyTerminalOutputEvent,
  beginTerminalAttachmentReplication,
  canUpdateTerminalBootstrapState,
  clearPendingTerminalReplication as clearPendingTerminalOutput,
  createTerminalReplicationState,
  expandTerminalCheckpointHistory,
  finishTerminalAttachmentReplication,
  flushQueuedTerminalOutput,
  hasPendingTerminalSnapshot,
  handleTerminalStreamOutput,
  invalidateTerminalReplication as invalidateTerminalCheckpointRequest,
  markTerminalReplicationInput,
  replayPendingSnapshot,
  requestTerminalResizeReplicationRecovery,
  resyncTerminalReplication,
  resumeLiveTerminalReplication,
  retryTerminalReplication,
  seedTerminalCheckpoint,
  setTerminalCheckpointInstallHeld,
  setTerminalReplicationPageSuspended,
  terminalReplicationBlocksResizeNotification,
  terminalReplicationBootstrapSettled,
  terminalReplicationCanFocus,
  terminalReplicationCanMutateResize,
  terminalReplicationReady,
  writeTerminalReplicationFixture,
  type TerminalReplicationPorts,
  type TerminalReplicationState,
} from '@/lib/terminal-session-replication'
import {
  flushPendingTerminalWrites,
  forceTerminalRender,
  restoreViewportAfterLayout,
  scheduleTerminalRepaint,
  scrollRecordToBottom,
  scrollRecordToLine,
  scrollRecordToViewportY,
  writeTerminalOutput,
} from '@/lib/terminal-output'
import {
  attachTerminalHost,
  canDetachTerminalHost,
  getTerminalSessionParkingLot,
  isTerminalHostAttached,
  parkTerminalHost,
} from '@/lib/terminal-attachment'
import {
  transitionTerminalRecoveryStatus,
} from '@/lib/terminal-recovery-status'
import type {
  TerminalRecoveryPhase,
  TerminalRecoveryStatus,
} from '@/lib/terminal-recovery-status'
import {
  sessionBootstrapStateFromPayload,
} from '@/lib/terminal-bootstrap'
import type { SessionBootstrapState } from '@/lib/terminal-bootstrap'
import { openExternalUrl } from '@/lib/url-open-menu'
import {
  clearReadingAnchor,
  readingAnchorAgentKey,
  readReadingAnchor,
  saveReadingAnchor,
  terminalReadingAnchorFingerprint,
  type ReadingAnchor,
} from '@/lib/reading-anchor'
import {
  isCompactViewport,
  isTouchInputViewport as isMobileViewport,
} from '@/lib/responsive-mode'
import type { TerminalSearchOptions } from '@/lib/terminal-search'
import {
  requestTerminalSessionCheckpoint,
  sendTerminalSessionMessage,
} from '@/lib/terminal-session-client'
import { TerminalSessionRegistry } from '@/lib/terminal-session-registry'
import { TerminalCheckpointRequestScheduler } from '@/lib/terminal-checkpoint-request-scheduler'
import { TerminalAttachmentCoordinator } from '@/lib/terminal-attachment-coordinator'
import {
  TerminalSessionDiagnosticsProjection,
  type TerminalHostDiagnostics,
  type TerminalSessionDiagnostics,
  type TerminalSessionDiagnosticsSource,
} from '@/lib/terminal-session-diagnostics'
import type { TerminalInputPart } from '@/types/messages'
import {
  codeTerminalFontSize,
  readCodeContentFontSize,
} from '@/lib/content-font-size'

export type { TerminalPathOpenTarget } from '@/lib/terminal-links'
export { normalizeTerminalSelection } from '@/lib/terminal-selection'

type TerminalOutputHandler = (
  data: string,
  replace?: boolean,
  outputSeq?: number | null,
  runtimeEpoch?: string,
  stateRevision?: number | null,
  cols?: number,
  rows?: number,
  kind?: TerminalTransitionKind,
) => void

type TerminalTransitionKind = 'output' | 'resize' | 'clear'

const TERMINAL_REPLAY = FarmingTerminalReplay
type TerminalViewportRestoreState = {
  viewportY: number
  scrollbackLength: number
  following: boolean
  hasUnreadOutput: boolean
  preserveUnreadOutputUntilJump: boolean
  readingAnchor: Extract<ReadingAnchor, { surface: 'terminal' }> | null
}

interface AttachOptions {
  mountEl: HTMLElement
  onSessionOutput: (agentId: string, handler: TerminalOutputHandler) => () => void
  autoFocus?: boolean
  inputDisabled?: boolean
  manageReadingAnchor?: boolean
  onFollowOutputChange?: (state: TerminalFollowState) => void
  onPathOpen?: (agentId: string, target: TerminalPathOpenTarget) => void
  onPathResolve?: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onSearchOpen?: (agentId: string, query: string) => void
  linkHandlersRevision?: TerminalLinkHandlersRevision
  onOpenUrlInFarming?: (agentId: string, url: string) => void
  onRecoveryStatusChange?: (status: TerminalRecoveryStatus) => void
  onReady?: () => void
  onError?: (error: Error) => void
  bootstrapState?: SessionBootstrapState
  signal?: AbortSignal
}

/**
 * The exact three link-handler wrappers one owner installs on a record. They are
 * compared by reference, so only the owner that actually holds the record can
 * commit a revision against it.
 */
export type TerminalLinkHandlerWrappers = Pick<AttachOptions, 'onPathOpen' | 'onPathResolve' | 'onSearchOpen'>

export interface TerminalSessionLiveOptions {
  inputDisabled: boolean
  manageReadingAnchor: boolean
  onOpenUrlInFarming?: (agentId: string, url: string) => void
}

export type { TerminalRecoveryPhase, TerminalRecoveryStatus } from '@/lib/terminal-recovery-status'

export type TerminalSearchDirection = 'next' | 'previous'

export interface TerminalSearchResult {
  found: boolean
  resultIndex?: number
  resultCount?: number
}

interface SessionRecord extends TerminalSessionDiagnosticsSource {
  agentId: string
  hostEl: HTMLDivElement
  attachedMount: HTMLElement | null
  attachReadyHandler: (() => void) | null
  attachReadyGeneration: number | null
  attachReadyNotified: boolean
  terminal: FarmingTerminal
  fitAddon: FarmingFitAddon
  unsubscribeOutput: (() => void) | null
  selection: TerminalSelectionController
  interaction: TerminalSessionInteractionController
  replication: TerminalReplicationState
  replicationPorts: TerminalReplicationPorts
  resizeEffects: TerminalResizeEffectController
  parkedViewportState: TerminalViewportRestoreState | null
  inputDisabled: boolean
  manageReadingAnchor: boolean
  errorHandler: ((error: Error) => void) | null
  recoveryStatusHandler: ((status: TerminalRecoveryStatus) => void) | null
  recoveryStatus: TerminalRecoveryStatus
  rendererFailureDisposable: (() => void) | null
  scrollChangeDisposable: (() => void) | null
  backendConnectedHandler: (() => void) | null
  followOutputHandler: ((state: TerminalFollowState) => void) | null
  pathOpenHandler: ((agentId: string, target: TerminalPathOpenTarget) => void) | null
  pathResolveHandler: ((agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null) | null
  searchOpenHandler: ((agentId: string, query: string) => void) | null
  farmingUrlOpenHandler: ((agentId: string, url: string) => void) | null
  attachment: TerminalAttachmentCoordinator
  pageLifecycleHandler: ((event: Event) => void) | null
  inputCount: number
  followOutput: boolean
  hasUnreadOutput: boolean
  preserveUnreadOutputUntilJump: boolean
  followCheckFrame: number | null
  disposed: boolean
  bootstrapped: boolean
}

const sessions = new TerminalSessionRegistry<string, SessionRecord>()
const linkHandlersCommitLatch = createTerminalLinkHandlersCommitLatch()
const terminalSessionDiagnostics = new TerminalSessionDiagnosticsProjection({
  get: agentId => sessions.get(agentId),
  values: () => sessions.values(),
})
let terminalFocusRevision = 0
const terminalCheckpointRequestScheduler = new TerminalCheckpointRequestScheduler()

declare global {
  interface Window {
    __FARMING_E2E__?: boolean
    __farmingTerminalTest?: {
      requestCheckpoint: (agentId: string) => Promise<SessionBootstrapState>
      writeFixture: (agentId: string, text: string) => Promise<void>
      resumeLive: (agentId: string) => Promise<void>
      isReady: (agentId: string) => boolean
      getSelection: (agentId: string) => string
      getCellCenter: (agentId: string, col: number, row: number) => { x: number; y: number } | null
      getRows: (agentId: string, rowCount?: number) => string[]
      doubleClickCell: (agentId: string, col: number, row: number) => string
      getUrlAtCell: (agentId: string, col: number, row: number) => string | null
      getPathAtCell: (agentId: string, col: number, row: number) => TerminalPathOpenTarget | null
      openPathAtCell: (agentId: string, col: number, row: number) => boolean
      getCursor: (agentId: string) => { x: number; y: number; visible?: boolean } | null
      getCursorVisible: (agentId: string) => boolean | undefined
      getCursorCellPixel: (agentId: string) => { r: number; g: number; b: number; a: number } | null
      getCanvasInkPixelCount: (agentId: string) => number
      writeRaw: (agentId: string, text: string) => Promise<void>
      writeSequenced: (agentId: string, text: string, outputSeq: number, runtimeEpoch?: string, stateRevision?: number) => Promise<void>
      streamSequenced: (
        agentId: string,
        text: string,
        outputSeq: number,
        runtimeEpoch?: string,
        stateRevision?: number,
        kind?: TerminalTransitionKind,
        cols?: number,
        rows?: number,
      ) => Promise<void>
      writeRawAndSampleViewport: (agentId: string, text: string) => Promise<{
        before: number
        during: number
        after: number
        beforeScrollbackLength: number
        afterScrollbackLength: number
        following: boolean
        hasUnreadOutput: boolean
      }>
      getViewport: (agentId: string) => {
        viewportY: number
        scrollbackLength: number
        following: boolean
        hasUnreadOutput: boolean
      } | null
      getInputCount: (agentId: string) => number
      getLastNotifiedResize: (agentId: string) => { cols: number; rows: number } | null
      getResizeNotificationCount: (agentId: string) => number
      notifyResizeForTest: (agentId: string, cols: number, rows: number) => number
      getLastOutputSeq: (agentId: string) => number | null
      getRuntimeEpoch: (agentId: string) => string
      getStateRevision: (agentId: string) => number | null
      setCheckpointAckSuppressed: (agentId: string, suppressed: boolean) => boolean
      setCheckpointInstallCompletionHeld: (agentId: string, held: boolean) => boolean
      getBufferDiagnostics: (agentId: string) => TerminalSessionDiagnostics | null
      getHostDiagnostics: () => TerminalHostDiagnostics[]
      scrollToLine: (agentId: string, line: number) => Promise<void>
      scrollToBottom: (agentId: string) => Promise<void>
      search: (agentId: string, term: string, direction?: TerminalSearchDirection, options?: TerminalSearchOptions) => Promise<TerminalSearchResult>
      clearSearch: (agentId: string) => Promise<void>
      dispatchPasteToTextarea: (agentId: string, text: string) => { prevented: boolean }
      dispatchCopyFromTextarea: (agentId: string) => { prevented: boolean; text: string }
    }
  }
}

function appendHost(record: SessionRecord, mountEl: HTMLElement) {
  attachTerminalHost(record, mountEl, () => isolateSinglePaneTerminalMount(record.hostEl, mountEl))
  observeTerminalResize(record)
}

function findSessionRecordForHost(hostEl: HTMLDivElement) {
  for (const current of sessions.values()) {
    if (current instanceof Promise) continue
    if (current.hostEl === hostEl) return current
  }
  return null
}

function parkTerminalSessionRecord(record: SessionRecord) {
  if (record.disposed) return
  record.parkedViewportState = {
    viewportY: getTerminalViewportY(record.terminal),
    scrollbackLength: getTerminalScrollbackLength(record.terminal),
    following: record.followOutput,
    hasUnreadOutput: record.hasUnreadOutput,
    preserveUnreadOutputUntilJump: record.preserveUnreadOutputUntilJump,
    readingAnchor: captureTerminalReadingAnchor(record),
  }
  invalidateTerminalCheckpointRequest(record)
  record.followOutputHandler = null
  record.recoveryStatusHandler = null
  record.pathOpenHandler = null
  record.pathResolveHandler = null
  record.searchOpenHandler = null
  pauseTerminalResizeObserver(record)
  record.interaction.reset()
  record.attachment.detach()
  parkTerminalHost(record)
}

function observeTerminalResize(record: SessionRecord) {
  if (record.disposed) return
  record.resizeEffects.observe(record.hostEl)
}

function pauseTerminalResizeObserver(record: SessionRecord) {
  record.resizeEffects.pause()
}

function isolateSinglePaneTerminalMount(hostEl: HTMLDivElement, mountEl: HTMLElement) {
  const terminalGrid = mountEl.closest('.code-terminal-grid.panes-1')
  if (!terminalGrid) return

  terminalGrid.querySelectorAll('.terminal-session-host').forEach(candidate => {
    if (candidate === hostEl) return
    if (!(candidate instanceof HTMLDivElement)) return
    const record = findSessionRecordForHost(candidate)
    if (record) {
      parkTerminalSessionRecord(record)
    } else {
      getTerminalSessionParkingLot().appendChild(candidate)
    }
  })
}

function publishTerminalRecoveryStatus(
  record: SessionRecord,
  phase: TerminalRecoveryPhase,
  options: { attempt?: number; retryDelayMs?: number | null; restart?: boolean } = {},
) {
  const next = transitionTerminalRecoveryStatus(record.recoveryStatus, {
    phase,
    ...options,
  })
  const previous = record.recoveryStatus
  if (
    previous.phase === next.phase
    && previous.attempt === next.attempt
    && previous.startedAt === next.startedAt
    && previous.retryDelayMs === next.retryDelayMs
  ) return
  record.recoveryStatus = next
  record.recoveryStatusHandler?.(next)
}

function focusTerminalInput(hostEl: HTMLDivElement, terminal: FarmingTerminal) {
  // xterm owns its helper textarea and composition lifecycle. Go through its
  // public focus API so a focus change from the composer does not bypass the
  // same IME path it uses for ordinary terminal input.
  void hostEl
  terminal.focus()
  return true
}

function focusAttachedTerminalInput(record: SessionRecord) {
  if (record.disposed || record.attachedMount === null) return false
  terminalFocusRevision += 1
  return focusTerminalInput(record.hostEl, record.terminal)
}

function shouldAllowTerminalAutoFocus(hostEl: HTMLDivElement) {
  const activeElement = document.activeElement
  if (document.querySelector('.code-composer.menu-open, .code-composer-menu')) return false
  if (!(activeElement instanceof Element)) return true
  if (activeElement === document.body || hostEl.contains(activeElement)) return true
  return !activeElement.closest([
    '.code-composer',
    '.code-composer-menu',
    '.code-context-menu',
    '.input-dialog-overlay',
    '.code-overlay-dialog',
    '.code-file-editor',
    '.code-files-section',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[role="dialog"]',
    '[role="menu"]',
  ].join(','))
}

function isTerminalSessionAttached(record: SessionRecord) {
  return isTerminalHostAttached(record)
}

function isCurrentAttachment(record: SessionRecord, generation: number) {
  return record.attachment.isCurrentGeneration(generation) && isTerminalHostAttached(record)
}

function terminalViewportStateForRestore(record: SessionRecord): TerminalViewportRestoreState {
  if (record.parkedViewportState) {
    return {
      ...record.parkedViewportState,
      readingAnchor: record.manageReadingAnchor ? record.parkedViewportState.readingAnchor : null,
      hasUnreadOutput: record.parkedViewportState.hasUnreadOutput || record.hasUnreadOutput,
      preserveUnreadOutputUntilJump:
        record.parkedViewportState.preserveUnreadOutputUntilJump
        || record.preserveUnreadOutputUntilJump,
    }
  }
  const persistedAnchor = record.manageReadingAnchor
    ? readReadingAnchor(readingAnchorAgentKey(record.agentId, 'terminal'))
    : null
  const readingAnchor = persistedAnchor?.surface === 'terminal'
    ? persistedAnchor
    : captureTerminalReadingAnchor(record)
  return {
    viewportY: getTerminalViewportY(record.terminal),
    scrollbackLength: getTerminalScrollbackLength(record.terminal),
    following: readingAnchor ? false : record.followOutput,
    hasUnreadOutput: record.hasUnreadOutput,
    preserveUnreadOutputUntilJump: record.preserveUnreadOutputUntilJump,
    readingAnchor,
  }
}

function restoreTerminalViewportFromAnchor(
  record: SessionRecord,
  viewportState: TerminalViewportRestoreState,
  options: { sameCutHistoryExpansion?: boolean } = {},
) {
  record.followOutput = viewportState.following
  record.hasUnreadOutput = viewportState.hasUnreadOutput
  record.preserveUnreadOutputUntilJump = viewportState.preserveUnreadOutputUntilJump
  if (viewportState.following) {
    restoreViewportAfterLayout(
      record,
      viewportState.viewportY,
      viewportState.scrollbackLength,
      true,
      viewportState.hasUnreadOutput,
    )
    return
  }
  if (options.sameCutHistoryExpansion) {
    scrollRecordToViewportY(record, viewportState.viewportY)
    setFollowOutputState(record, false, viewportState.hasUnreadOutput)
    return
  }
  if (
    record.manageReadingAnchor
    && viewportState.readingAnchor
    && restoreTerminalReadingAnchor(record, viewportState.readingAnchor)
  ) {
    return
  }
  // A terminal screen is bounded. Once the logical-line fingerprint has been
  // evicted or rewritten, an old absolute scrollback row is misleading; read
  // the current tail instead.
  clearReadingAnchor(readingAnchorAgentKey(record.agentId, 'terminal'))
  scrollRecordToBottom(record, { allowClearUnread: true })
}

function getTerminalCellMetrics(record: SessionRecord) {
  return record.terminal.getCellMetrics()
}

function getTerminalScreenRect(record: SessionRecord) {
  const screen = record.terminal.getScreenElement?.()
  if (screen instanceof HTMLElement) {
    return screen.getBoundingClientRect()
  }

  return null
}

function updateFollowStateFromViewport(
  record: SessionRecord,
  options: { allowClearUnread?: boolean } = {},
) {
  const atBottom = isTerminalAtBottom(record)
  setFollowOutputState(record, atBottom, atBottom ? false : record.hasUnreadOutput, {
    allowClearUnread: atBottom && options.allowClearUnread === true,
  })
}

function scheduleFollowStateFromViewport(
  record: SessionRecord,
  options: { allowClearUnread?: boolean } = {},
) {
  if (record.followCheckFrame !== null) {
    cancelAnimationFrame(record.followCheckFrame)
  }

  record.followCheckFrame = requestAnimationFrame(() => {
    record.followCheckFrame = null
    if (record.disposed || !isTerminalSessionAttached(record)) return
    const atBottom = isTerminalAtBottom(record)
    setFollowOutputState(record, atBottom, atBottom ? false : record.hasUnreadOutput, {
      allowClearUnread: atBottom && options.allowClearUnread === true,
    })
  })
}

function focusTerminalInputWhenReady(
  record: SessionRecord,
  generation: number,
  attemptsRemaining = 12,
) {
  if (!isCurrentAttachment(record, generation)) return
  if (!shouldAllowTerminalAutoFocus(record.hostEl)) return
  if (!terminalReplicationCanFocus(record)) {
    if (attemptsRemaining <= 0) return
    requestAnimationFrame(() => {
      focusTerminalInputWhenReady(record, generation, attemptsRemaining - 1)
    })
    return
  }
  const focusedTextarea = focusAttachedTerminalInput(record)
  if (focusedTextarea || attemptsRemaining <= 0) {
    return
  }

  requestAnimationFrame(() => {
    focusTerminalInputWhenReady(record, generation, attemptsRemaining - 1)
  })
}

function reportTerminalSyncError(record: SessionRecord, message: string) {
  record.errorHandler?.(new Error(message))
}

function queueTerminalInput(record: SessionRecord, input: string | TerminalInputPart[]) {
  if (record.disposed || record.attachedMount === null || record.inputDisabled) return false
  const trace = beginTerminalInputPerformance(record.agentId, record.hostEl,
    record.attachment.runtimeEpoch || '', record.attachment.outputSeq, typeof input === 'string' ? input.length : 0)
  const delivered = sendTerminalSessionMessage({
    type: 'input',
    agentId: record.agentId,
    performanceId: trace.id,
    ...(Array.isArray(input) ? { inputParts: input } : { input }),
  })
  if (!delivered) { trace.end('failed'); return false }
  trace.mark('sent')
  markTerminalReplicationInput(record)
  record.inputCount += 1
  record.interaction.clearAfterInput()
  return true
}

function resyncTerminalSizeAfterBackendReconnect(record: SessionRecord) {
  resyncTerminalReplication(record)
}

const TERMINAL_READING_ANCHOR_LINE_COUNT = 3

function captureTerminalReadingAnchor(record: SessionRecord): Extract<ReadingAnchor, { surface: 'terminal' }> | null {
  const key = readingAnchorAgentKey(record.agentId, 'terminal')
  if (!record.manageReadingAnchor || record.followOutput) {
    clearReadingAnchor(key)
    return null
  }
  const visibleBufferRow = getTerminalVisibleBufferBase(record.terminal)
  const firstLine = record.selection.logicalLineAtBufferRow(visibleBufferRow)
  if (!firstLine) return null

  const lines: string[] = []
  let nextRow = firstLine.startRow
  for (let index = 0; index < TERMINAL_READING_ANCHOR_LINE_COUNT; index += 1) {
    const line = record.selection.logicalLineAtBufferRow(nextRow)
    if (!line) break
    lines.push(line.text)
    nextRow = line.endRow + 1
  }
  if (lines.length === 0) return null

  const anchor: Extract<ReadingAnchor, { surface: 'terminal' }> = {
    version: 1,
    surface: 'terminal',
    resource: { kind: 'agent', id: record.agentId },
    locator: {
      kind: 'terminal-lines',
      id: terminalReadingAnchorFingerprint(lines),
      lineCount: lines.length,
    },
    position: {
      unit: 'row',
      value: Math.max(0, visibleBufferRow - firstLine.startRow),
    },
  }
  saveReadingAnchor(anchor)
  return anchor
}

function restoreTerminalReadingAnchor(
  record: SessionRecord,
  anchor: Extract<ReadingAnchor, { surface: 'terminal' }>,
) {
  if (!record.manageReadingAnchor) return false
  const buffer = record.terminal.buffer?.active
  if (!buffer || typeof buffer.getLine !== 'function') return false

  const lastBufferRow = Math.max(
    0,
    getTerminalScrollbackLength(record.terminal) + Math.max(1, record.terminal.rows || 1),
  )
  const lineCount = Math.max(1, anchor.locator.lineCount || 1)
  let closestMatch: TerminalLogicalLine | null = null
  let closestDistance = Number.POSITIVE_INFINITY
  for (let bufferRow = 0; bufferRow <= lastBufferRow;) {
    const firstLine = record.selection.logicalLineAtBufferRow(bufferRow)
    if (!firstLine) {
      bufferRow += 1
      continue
    }
    const lines = [firstLine.text]
    let nextRow = firstLine.endRow + 1
    for (let index = 1; index < lineCount; index += 1) {
      const line = record.selection.logicalLineAtBufferRow(nextRow)
      if (!line) break
      lines.push(line.text)
      nextRow = line.endRow + 1
    }
    if (
      lines.length === lineCount
      && terminalReadingAnchorFingerprint(lines) === anchor.locator.id
    ) {
      const distance = Math.abs(firstLine.startRow - getTerminalVisibleBufferBase(record.terminal))
      if (distance < closestDistance) {
        closestMatch = firstLine
        closestDistance = distance
      }
    }
    bufferRow = Math.max(bufferRow + 1, firstLine.endRow + 1)
  }
  if (!closestMatch) return false

  const targetRow = Math.min(
    closestMatch.endRow,
    closestMatch.startRow + Math.max(0, anchor.position.value),
  )
  scrollRecordToLine(record, targetRow)
  setFollowOutputState(record, false, record.hasUnreadOutput)
  return true
}

function repairTerminalAfterAttach(record: SessionRecord) {
  record.interaction.reset()
  record.terminal.reattach()
  record.terminal.syncAppearanceTheme()
  record.terminal.forceRedraw()

  scheduleTerminalRepaint(record)
  requestAnimationFrame(() => {
    if (record.disposed || record.attachedMount === null) return
    record.terminal.forceRedraw()
    forceTerminalRender(record)
  })
}

function installTerminalTestApi() {
  if (typeof window === 'undefined' || !window.__FARMING_E2E__ || window.__farmingTerminalTest) return

  window.__farmingTerminalTest = {
    ...terminalSessionDiagnostics.testBridge(),
    async requestCheckpoint(agentId: string) {
      const controller = new AbortController()
      const release = await terminalCheckpointRequestScheduler.acquire(controller.signal)
      try {
        return sessionBootstrapStateFromPayload(
          await requestTerminalSessionCheckpoint(agentId, controller.signal),
        )
      } finally {
        release()
      }
    },
    async writeFixture(agentId: string, text: string) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      await writeTerminalReplicationFixture(record, text)
      // The fixture is the authoritative synthetic cut for this E2E record.
      // If the host was reattached from the parking lot, complete the same
      // visual readiness boundary as a committed checkpoint so the recovery
      // overlay cannot keep intercepting interaction with the injected frame.
      if (isTerminalSessionAttached(record)) {
        record.hostEl.classList.remove('terminal-checkpoint-installing')
        publishTerminalRecoveryStatus(record, 'ready')
        if (!record.attachReadyNotified) {
          record.attachReadyNotified = true
          record.attachReadyHandler?.()
        }
      }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    },
    async resumeLive(agentId: string) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      resumeLiveTerminalReplication(record)
    },
    getSelection(agentId: string) {
      return getTerminalSelectionNow(agentId)
    },
    getCellCenter(agentId: string, col: number, row: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      const metrics = getTerminalCellMetrics(current)
      const rect = getTerminalScreenRect(current)
      if (!metrics || !rect) return null
      return {
        x: rect.left + (col + 0.5) * metrics.width,
        y: rect.top + (row + 0.5) * metrics.height,
      }
    },
    getRows(agentId: string, rowCount = 6) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return []
      const buffer = current.terminal.buffer?.active
      if (!buffer || typeof buffer.getLine !== 'function') return []
      const rows: string[] = []
      const baseRow = getTerminalVisibleBufferBase(current.terminal)
      for (let row = 0; row < rowCount; row += 1) {
        const line = buffer.getLine(baseRow + row)
        const cells: string[] = []
        const cols = current.terminal.cols || line?.length || 0
        for (let col = 0; col < cols; col += 1) {
          const cell = line?.getCell?.(col)
          if (isZeroWidthCell(cell)) continue
          cells.push(readCellText(cell) || ' ')
        }
        rows.push(cells.join('').trimEnd())
      }
      return rows
    },
    doubleClickCell(agentId: string, col: number, row: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return ''
      return current.selection.selectContinuousTextAtCell(col, row)
    },
    getUrlAtCell(agentId: string, col: number, row: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      return current.interaction.link.urlAtCell({ col, row })
    },
    isReady(agentId: string) {
      const current = sessions.get(agentId)
      return Boolean(current && !(current instanceof Promise) && !current.disposed && terminalReplicationBootstrapSettled(current))
    },
    getPathAtCell(agentId: string, col: number, row: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      return current.interaction.link.pathLinkAtCell({ col, row })?.pathTarget ?? null
    },
    openPathAtCell(agentId: string, col: number, row: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed || !current.pathOpenHandler) return false
      const pathTarget = current.interaction.link.pathLinkAtCell({ col, row })?.pathTarget ?? null
      if (!pathTarget) return false
      current.pathOpenHandler(agentId, pathTarget)
      return true
    },
    getCursor(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      return current.terminal.getCursor()
    },
    getCursorVisible(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return undefined
      const visible = current.terminal.getCursor().visible
      return visible === undefined ? undefined : Boolean(visible)
    },
    getCursorCellPixel(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      const canvas = current.hostEl.querySelector('canvas')
      const metrics = getTerminalCellMetrics(current)
      const cursor = current.terminal.getCursor()
      if (!(canvas instanceof HTMLCanvasElement) || !metrics || !cursor) {
        const cursorElement = current.hostEl.querySelector('.xterm-cursor')
        if (!(cursorElement instanceof HTMLElement)) return null

        const color = getComputedStyle(cursorElement).backgroundColor || DEFAULT_THEME.cursor
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/)
        if (!match) return { r: 36, g: 41, b: 47, a: 255 }
        return {
          r: Number(match[1] ?? 36),
          g: Number(match[2] ?? 41),
          b: Number(match[3] ?? 47),
          a: Math.round(Number(match[4] ?? 1) * 255),
        }
      }

      const scaleX = canvas.width / Math.max(1, canvas.getBoundingClientRect().width)
      const scaleY = canvas.height / Math.max(1, canvas.getBoundingClientRect().height)
      const x = Math.min(canvas.width - 1, Math.max(0, Math.floor((cursor.x + 0.5) * metrics.width * scaleX)))
      const y = Math.min(canvas.height - 1, Math.max(0, Math.floor((cursor.y + 0.5) * metrics.height * scaleY)))
      const data = canvas.getContext('2d')?.getImageData(x, y, 1, 1).data
      if (!data) return null
      return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0, a: data[3] ?? 0 }
    },
    getCanvasInkPixelCount(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return 0
      const canvases = [...current.hostEl.querySelectorAll<HTMLCanvasElement>('canvas')]
      if (canvases.length === 0) {
        const visibleText = current.hostEl.querySelector('.xterm-rows')?.textContent?.trim() ?? ''
        return visibleText.length * 8
      }
      let inkPixels = 0
      for (const canvas of canvases) {
        let data: Uint8Array | Uint8ClampedArray | null = null
        const context = canvas.getContext('2d')
        if (context) {
          data = context.getImageData(0, 0, canvas.width, canvas.height).data
        } else {
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
          if (gl) {
            data = new Uint8Array(canvas.width * canvas.height * 4)
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
          }
        }
        if (!data) continue
        for (let index = 0; index < data.length; index += 4) {
          const red = data[index] ?? 255
          const green = data[index + 1] ?? 255
          const blue = data[index + 2] ?? 255
          const alpha = data[index + 3] ?? 0
          if (alpha > 0 && !(red > 248 && green > 248 && blue > 245)) {
            inkPixels += 1
          }
        }
      }
      return inkPixels
    },
    async writeRaw(agentId: string, text: string) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      await new Promise<void>(resolve => writeTerminalOutput(record, text, resolve, {
        isOutputObserved: () => isTerminalSessionAttached(record),
      }))
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    },
    async writeSequenced(
      agentId: string,
      text: string,
      outputSeq: number,
      runtimeEpoch = '',
      stateRevision?: number,
    ) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      applyTerminalOutputEvent(
        record,
        text,
        false,
        outputSeq,
        runtimeEpoch,
        stateRevision ?? ((record.attachment.stateRevision ?? 0) + 1),
      )
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    },
    async streamSequenced(
      agentId: string,
      text: string,
      outputSeq: number,
      runtimeEpoch = '',
      stateRevision?: number,
      kind: TerminalTransitionKind = 'output',
      cols?: number,
      rows?: number,
    ) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      handleTerminalStreamOutput(
        record,
        text,
        false,
        outputSeq,
        runtimeEpoch,
        stateRevision ?? ((record.attachment.stateRevision ?? 0) + 1),
        cols,
        rows,
        kind,
      )
    },
    async writeRawAndSampleViewport(agentId: string, text: string) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      const before = getTerminalViewportY(record.terminal)
      const beforeScrollbackLength = getTerminalScrollbackLength(record.terminal)
      let during = before
      await new Promise<void>(resolve => {
        writeTerminalOutput(record, text, resolve, {
          isOutputObserved: () => isTerminalSessionAttached(record),
        })
        during = getTerminalViewportY(record.terminal)
      })
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return {
        before,
        during,
        after: getTerminalViewportY(record.terminal),
        beforeScrollbackLength,
        afterScrollbackLength: getTerminalScrollbackLength(record.terminal),
        following: record.followOutput,
        hasUnreadOutput: record.hasUnreadOutput,
      }
    },
    getViewport(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      return {
        viewportY: getTerminalViewportY(current.terminal),
        scrollbackLength: getTerminalScrollbackLength(current.terminal),
        following: current.followOutput,
        hasUnreadOutput: current.hasUnreadOutput,
      }
    },
    getInputCount(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return 0
      return current.inputCount
    },
    getLastNotifiedResize(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      return current.resizeEffects.diagnostics().lastNotifiedResize
    },
    getResizeNotificationCount(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return 0
      return current.resizeEffects.diagnostics().resizeNotificationCount
    },
    notifyResizeForTest(agentId: string, cols: number, rows: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return 0
      current.resizeEffects.notify(cols, rows)
      return current.resizeEffects.diagnostics().resizeNotificationCount
    },
    getLastOutputSeq(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      return current.attachment.outputSeq
    },
    getRuntimeEpoch(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return ''
      return current.attachment.runtimeEpoch
    },
    getStateRevision(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      return current.attachment.stateRevision
    },
    setCheckpointAckSuppressed(agentId: string) {
      const current = sessions.get(agentId)
      return Boolean(current && !(current instanceof Promise) && !current.disposed)
    },
    setCheckpointInstallCompletionHeld(agentId: string, held: boolean) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return false
      setTerminalCheckpointInstallHeld(current, held)
      return true
    },
    async scrollToLine(agentId: string, line: number) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      record.interaction.stopTouchMomentum()
      scrollRecordToLine(record, line)
      const atBottom = isTerminalAtBottom(record)
      setFollowOutputState(record, atBottom, atBottom ? false : record.hasUnreadOutput, {
        allowClearUnread: atBottom,
      })
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    },
    async scrollToBottom(agentId: string) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      record.interaction.stopTouchMomentum()
      scrollRecordToBottom(record, { allowClearUnread: true })
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    },
    async search(agentId: string, term: string, direction: TerminalSearchDirection = 'next', options: TerminalSearchOptions = {}) {
      return searchTerminalSession(agentId, term, direction, options)
    },
    async clearSearch(agentId: string) {
      await clearTerminalSearch(agentId)
    },
    dispatchPasteToTextarea(agentId: string, text: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return { prevented: false }
      const textarea = current.hostEl.querySelector('textarea')
      if (!(textarea instanceof HTMLTextAreaElement)) return { prevented: false }
      const clipboardData = new window.DataTransfer()
      clipboardData.setData('text/plain', text)
      const event = new window.ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      })
      textarea.dispatchEvent(event)
      return { prevented: event.defaultPrevented }
    },
    dispatchCopyFromTextarea(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return { prevented: false, text: '' }
      const textarea = current.hostEl.querySelector('textarea')
      if (!(textarea instanceof HTMLTextAreaElement)) return { prevented: false, text: '' }
      const clipboardData = new window.DataTransfer()
      const event = new window.ClipboardEvent('copy', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      })
      textarea.dispatchEvent(event)
      return {
        prevented: event.defaultPrevented,
        text: clipboardData.getData('text/plain'),
      }
    },
  }
}

async function bootstrapSession(agentId: string, options: AttachOptions) {
  const terminalFontSize = codeTerminalFontSize(readCodeContentFontSize(), isCompactViewport())

  const result = await createTerminalInstance({ fontSize: terminalFontSize })
  if (!result) {
    throw new Error(`Failed to create terminal for ${agentId}`)
  }

  const hostEl = document.createElement('div')
  hostEl.className = 'terminal-session-host'
  hostEl.dataset.agentId = agentId
  hostEl.dataset.terminalFontSize = String(terminalFontSize)
  hostEl.style.width = '100%'
  hostEl.style.height = '100%'
  hostEl.style.position = 'relative'
  hostEl.style.overflow = 'hidden'
  const { terminal, fitAddon } = result
  terminal.loadAddon(fitAddon)

  const selection = new TerminalSelectionController({
    terminal,
    hostEl,
    cellMetrics: () => terminal.getCellMetrics() ?? null,
    screenRect: () => {
      const screen = terminal.getScreenElement()
      if (screen instanceof HTMLElement) return screen.getBoundingClientRect()
      return null
    },
  })

  let record: SessionRecord
  const linkInteraction = new TerminalLinkInteractionController({
    agentId,
    hostEl,
    windowTarget: window,
    registerLinkProvider: provider => terminal.registerLinkProvider(provider),
    now: () => Date.now(),
    isMacPlatform: () => navigator.platform.toLowerCase().includes('mac'),
    language: () => document.documentElement.lang || navigator.language || '',
    isMobileViewport: () => isMobileViewport(),
    isAttached: () => isTerminalSessionAttached(record),
    attachmentOperation: () => record.attachment.currentOperation(),
    isCurrentAttachmentOperation: operation => (
      isTerminalSessionAttached(record) && record.attachment.isCurrentOperation(operation)
    ),
    cellFromEvent: event => selection.cellFromEvent(event),
    cellMetrics: () => terminal.getCellMetrics() ?? null,
    elementFromPoint: (x, y) => document.elementFromPoint(x, y),
    logicalLineAtCell: cell => selection.logicalLineAtCell(cell),
    logicalLineAtBufferRow: bufferRow => selection.logicalLineAtBufferRow(bufferRow),
    previousLogicalLines: beforeBufferRow => selection.previousLogicalLines(beforeBufferRow),
    pathOpenHandler: () => record.pathOpenHandler,
    pathResolveHandler: () => record.pathResolveHandler,
    searchOpenHandler: () => record.searchOpenHandler,
    openUrl: url => openExternalUrl(url),
    clearSelection: () => selection.clear(),
    focusInput: () => { focusAttachedTerminalInput(record) },
  })
  const interaction = new TerminalSessionInteractionController({
    agentId,
    hostEl,
    terminal,
    selection,
    link: {
      controller: linkInteraction,
      pathOpenHandler: () => record.pathOpenHandler,
      farmingUrlOpenHandler: () => record.farmingUrlOpenHandler,
    },
    viewport: {
      pageScroll: direction => {
        const nextViewportY = terminalPageScrollTarget(terminal, direction, MIN_TERMINAL_RESIZE_ROWS)
        scrollRecordToViewportY(record, nextViewportY)
        setFollowOutputState(record, nextViewportY <= 0, nextViewportY <= 0 ? false : record.hasUnreadOutput, {
          allowClearUnread: nextViewportY <= 0,
        })
        emitFollowOutputState(record)
      },
      onScrollIntent: event => {
        if (event instanceof WheelEvent && event.deltaY < 0) {
          setFollowOutputState(record, false, record.hasUnreadOutput)
        }
        captureTerminalReadingAnchor(record)
        scheduleFollowStateFromViewport(record, { allowClearUnread: true })
        window.setTimeout(() => scheduleFollowStateFromViewport(record, { allowClearUnread: true }), 80)
      },
      lineHeight: () => getTerminalCellMetrics(record)?.height || 16,
      viewportY: () => getTerminalViewportY(terminal),
      scrollToViewportY: viewportY => scrollRecordToViewportY(record, viewportY),
      onTouchViewportChanged: () => updateFollowStateFromViewport(record, { allowClearUnread: true }),
    },
    input: {
      disabled: () => record.inputDisabled,
      send: input => {
        scrollRecordToBottom(record, { allowClearUnread: true })
        return queueTerminalInput(record, input)
      },
      clear: () => {
        if (record.disposed || record.attachedMount === null) return
        selection.clear()
        terminal.clearSearch?.()
        setFollowOutputState(record, true, false, { allowClearUnread: true })
        sendTerminalSessionMessage({ type: 'clear-terminal', agentId })
      },
    },
    isDisposed: () => record.disposed,
    isAttached: () => isTerminalSessionAttached(record),
    focusInput: () => focusAttachedTerminalInput(record),
    focusRevision: () => terminalFocusRevision,
    mayRestoreFocus: (menu, focusRevision) => {
      if (record.disposed || record.attachedMount === null || terminalFocusRevision !== focusRevision) return false
      const activeElement = document.activeElement
      return activeElement === document.body || menu.contains(activeElement) || hostEl.contains(activeElement)
    },
    attachmentOperation: () => record.attachment.currentOperation(),
    isCurrentAttachmentOperation: operation => (
      isTerminalSessionAttached(record) && record.attachment.isCurrentOperation(operation)
    ),
  })
  const resizeEffects = new TerminalResizeEffectController({
    attachmentOperation: () => record.attachment.currentOperation(),
    isCurrentAttachmentOperation: operation => record.attachment.isCurrentOperation(operation),
    stateRevision: () => record.attachment.stateRevision,
    canMutate: () => terminalReplicationCanMutateResize(record),
    currentDimensions: () => ({ cols: terminal.cols || 0, rows: terminal.rows || 0 }),
    proposeDimensions: () => proposeTerminalResizeDimensions(hostEl, fitAddon),
    applyLocalDimensions: dimensions => terminal.resize?.(dimensions.cols, dimensions.rows),
    deliver: dimensions => sendTerminalSessionMessage({
      type: 'resize-agent',
      agentId,
      cols: dimensions.cols,
      rows: dimensions.rows,
    }),
    requestRecovery: () => requestTerminalResizeReplicationRecovery(record),
    flushOutput: () => { if (!record.disposed) flushQueuedTerminalOutput(record) },
  })
  const replication = createTerminalReplicationState({
    pageOutputSuspended: document.visibilityState === 'hidden',
  })
  record = {
    agentId,
    hostEl,
    attachedMount: null,
    attachReadyHandler: null,
    attachReadyGeneration: null,
    attachReadyNotified: false,
    terminal,
    fitAddon,
    unsubscribeOutput: null,
    selection,
    replication,
    replicationPorts: {
      isAttached: () => isTerminalSessionAttached(record),
      publishStatus: (phase, statusOptions) => publishTerminalRecoveryStatus(record, phase, statusOptions),
      reportError: message => reportTerminalSyncError(record, message),
      notifyReady: generation => notifyTerminalAttachReady(record, generation),
      captureViewportState: () => terminalViewportStateForRestore(record),
      restoreViewportState: (state, restoreOptions) => restoreTerminalViewportFromAnchor(
        record,
        state as TerminalViewportRestoreState,
        restoreOptions,
      ),
    },
    parkedViewportState: null,
    inputDisabled: Boolean(options.inputDisabled),
    manageReadingAnchor: options.manageReadingAnchor !== false,
    errorHandler: options.onError ?? null,
    recoveryStatusHandler: options.onRecoveryStatusChange ?? null,
    recoveryStatus: {
      phase: 'requesting',
      attempt: 1,
      startedAt: Date.now(),
      retryDelayMs: null,
    },
    rendererFailureDisposable: null,
    scrollChangeDisposable: null,
    backendConnectedHandler: null,
    interaction,
    resizeEffects,
    followOutputHandler: options.onFollowOutputChange ?? null,
    pathOpenHandler: options.onPathOpen ?? null,
    pathResolveHandler: options.onPathResolve ?? null,
    searchOpenHandler: options.onSearchOpen ?? null,
    farmingUrlOpenHandler: options.onOpenUrlInFarming ?? null,
    attachment: new TerminalAttachmentCoordinator(TERMINAL_REPLAY),
    pageLifecycleHandler: null,
    inputCount: 0,
    followOutput: true,
    hasUnreadOutput: false,
    preserveUnreadOutputUntilJump: false,
    followCheckFrame: null,
    disposed: false,
    bootstrapped: true,
  }
  seedTerminalCheckpoint(record, options.bootstrapState)

  terminal.onData((data: string) => {
    if (!record.inputDisabled) queueTerminalInput(record, data)
  })

  terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
    if (record.resizeEffects.applyingLocalResize) return
    if (terminalReplicationBlocksResizeNotification(record)) return
    record.resizeEffects.notify(cols, rows)
  })

  const rendererFailureSubscription = terminal.onRendererFailure?.((error) => {
    if (record.disposed) return
    record.inputDisabled = true
    record.resizeEffects.beginRecovery()
    publishTerminalRecoveryStatus(record, 'failed')
    record.errorHandler?.(error)
    void destroyTerminalSession(record.agentId).catch((destroyError) => {
      console.error('Failed to dispose terminal after renderer failure:', destroyError)
    })
  })
  record.rendererFailureDisposable = rendererFailureSubscription
    ? () => rendererFailureSubscription.dispose()
    : null
  terminal.open(hostEl)
  terminal.syncAppearanceTheme?.()
  requestAnimationFrame(() => {
    if (!record.disposed) terminal.syncAppearanceTheme?.()
  })

  record.interaction.install()
  const scrollSubscription = terminal.onScroll?.(() => {
    scheduleFollowStateFromViewport(record)
    captureTerminalReadingAnchor(record)
    expandTerminalCheckpointHistory(record)
  })
  const renderSubscription = terminal.onRender?.(() => {
    scheduleFollowStateFromViewport(record)
  })
  record.scrollChangeDisposable = scrollSubscription || renderSubscription
    ? () => {
        scrollSubscription?.dispose()
        renderSubscription?.dispose()
      }
    : null
  const backendConnectedHandler = () => resyncTerminalSizeAfterBackendReconnect(record)
  window.addEventListener('farming:backend-connected', backendConnectedHandler)
  record.backendConnectedHandler = backendConnectedHandler
  const pageLifecycleHandler = (event: Event) => {
    const suspended = event.type === 'pagehide' || document.visibilityState === 'hidden'
    setTerminalReplicationPageSuspended(record, suspended)
  }
  document.addEventListener('visibilitychange', pageLifecycleHandler)
  window.addEventListener('pagehide', pageLifecycleHandler)
  window.addEventListener('pageshow', pageLifecycleHandler)
  record.pageLifecycleHandler = pageLifecycleHandler


  const unsubscribeOutput = options.onSessionOutput(agentId, (
    data,
    replace,
    outputSeq,
    runtimeEpoch,
    stateRevision,
    cols,
    rows,
    kind,
  ) => {
    if (record.disposed) return
    if (!replace && (!kind || kind === 'output') && data) observeTerminalPerformanceOutput(agentId, runtimeEpoch, outputSeq)
    handleTerminalStreamOutput(
      record,
      data,
      replace,
      outputSeq,
      runtimeEpoch,
      stateRevision,
      cols,
      rows,
      kind,
    )
  })
  record.unsubscribeOutput = unsubscribeOutput
  installTerminalTestApi()

  return record
}

async function getOrCreateSession(agentId: string, options: AttachOptions) {
  return sessions.getOrCreate(
    agentId,
    () => bootstrapSession(agentId, options),
    options.onError,
  )
}

function notifyTerminalAttachReady(record: SessionRecord, generation: number) {
  if (
    record.attachReadyGeneration !== generation ||
    !isCurrentAttachment(record, generation) ||
    !terminalReplicationReady(record)
  ) return false
  // A ready record may have been detached and reattached before the previous
  // install-completion animation frame ran. That frame is generation-fenced,
  // so it intentionally stops after detach; clear its visual latch here at
  // the authoritative ready boundary or the reattached xterm stays hidden.
  record.hostEl.classList.remove('terminal-checkpoint-installing')
  publishTerminalRecoveryStatus(record, 'ready')
  navigationPerformanceReady('agent.switch', record.agentId, record.hostEl)
  if (record.attachReadyNotified) return true
  record.attachReadyNotified = true
  const revealedLatestParkedOutput = Boolean(
    record.parkedViewportState?.following
    && isTerminalAtBottom(record),
  )
  record.parkedViewportState = null
  if (revealedLatestParkedOutput) {
    // The attachment is ready only after its authoritative cut has committed
    // to xterm. If the user left this terminal following and the resumed view
    // now shows the bottom, the previously parked output has actually become
    // visible and no longer needs a synthetic "jump to latest" gesture.
    setFollowOutputState(record, true, false, { allowClearUnread: true })
  }
  record.attachReadyHandler?.()
  return true
}

function fitAndFocus(record: SessionRecord, options: Pick<AttachOptions, 'autoFocus' | 'onReady'>, generation: number) {
  const wasFollowing = record.followOutput
  const previousViewportY = getTerminalViewportY(record.terminal)
  const previousScrollbackLength = getTerminalScrollbackLength(record.terminal)
  const hadUnreadOutput = record.hasUnreadOutput

  requestAnimationFrame(() => {
    if (!isCurrentAttachment(record, generation)) return
    record.resizeEffects.syncFit({ force: true })
    restoreViewportAfterLayout(record, previousViewportY, previousScrollbackLength, wasFollowing, hadUnreadOutput)
    scheduleTerminalRepaint(record)
    if (options.autoFocus && !isMobileViewport() && shouldAllowTerminalAutoFocus(record.hostEl)) {
      focusTerminalInputWhenReady(record, generation)
    }
    requestAnimationFrame(() => {
      if (!isCurrentAttachment(record, generation)) return
      record.resizeEffects.syncFit({ force: true })
      restoreViewportAfterLayout(record, previousViewportY, previousScrollbackLength, wasFollowing, hadUnreadOutput)
      scheduleTerminalRepaint(record)
      finishTerminalAttachmentReplication(record, generation)
    })
  })
}

function applyTerminalAttachmentOptions(record: SessionRecord, options: AttachOptions) {
  record.errorHandler = options.onError ?? null
  record.inputDisabled = Boolean(options.inputDisabled)
  record.manageReadingAnchor = options.manageReadingAnchor !== false
  if (!record.manageReadingAnchor) {
    clearReadingAnchor(readingAnchorAgentKey(record.agentId, 'terminal'))
    if (record.parkedViewportState) record.parkedViewportState.readingAnchor = null
  }
  record.followOutputHandler = options.onFollowOutputChange ?? null
  const nextPathOpenHandler = options.onPathOpen ?? null
  const nextPathResolveHandler = options.onPathResolve ?? null
  const nextSearchOpenHandler = options.onSearchOpen ?? null
  // A same-mount refresh keeps the attachment generation, so the interaction
  // revision is the only fence between a resolution the previous resolver
  // produced and the workspace the new opener owns. An owner that passes stable
  // wrappers never changes those references, so the revision token - not
  // handler identity - is the authoritative evidence of a replacement.
  const linkHandlersReplaced = record.pathOpenHandler !== nextPathOpenHandler
    || record.pathResolveHandler !== nextPathResolveHandler
    || record.searchOpenHandler !== nextSearchOpenHandler
  record.pathOpenHandler = nextPathOpenHandler
  record.pathResolveHandler = nextPathResolveHandler
  record.searchOpenHandler = nextSearchOpenHandler
  record.farmingUrlOpenHandler = options.onOpenUrlInFarming ?? null
  record.recoveryStatusHandler = options.onRecoveryStatusChange ?? null
  // An attach can resolve after the owner already committed a newer revision, so
  // the latch - not the revision this attach captured - is the authoritative
  // identity of the handlers behind those wrappers.
  const committedRevision = linkHandlersCommitLatch.committedRevision(
    record.agentId,
    options.linkHandlersRevision,
  )
  const revisionInvalidated = record.interaction.link.adoptHandlersRevision(committedRevision)
  if (!revisionInvalidated && linkHandlersReplaced) record.interaction.link.notifyHandlersChanged()
}

/**
 * Atomically adopts the link handler revision one owner just committed. The
 * owner's stable wrappers must not reach a new resolver or opener before this
 * returns, so the adoption is synchronous while this owner already holds the live
 * record and latched otherwise. Returns true when a live record adopted it and
 * therefore already invalidated the previous owner's cache and pending
 * resolutions.
 *
 * A record still routing through another owner's wrappers may not adopt here: it
 * would resolve through those foreign handlers under this revision's fence, and
 * the attach that later installs the new wrappers would find the revision
 * unchanged and keep that foreign resolution. Latching alone is enough, because
 * `applyTerminalAttachmentOptions` installs the wrappers before adopting the
 * latched revision.
 */
export function commitTerminalSessionLinkHandlers(
  agentId: string,
  revision: TerminalLinkHandlersRevision,
  handlers: TerminalLinkHandlerWrappers,
) {
  linkHandlersCommitLatch.commit(agentId, revision)
  const current = sessions.get(agentId)
  if (!current || current instanceof Promise || current.disposed) return false
  if (!sessions.isCurrent(agentId, current)) return false
  if (!ownsTerminalLinkHandlers(current, handlers)) return false
  current.interaction.link.adoptHandlersRevision(revision)
  return true
}

function ownsTerminalLinkHandlers(record: SessionRecord, handlers: TerminalLinkHandlerWrappers) {
  return record.pathOpenHandler === (handlers.onPathOpen ?? null)
    && record.pathResolveHandler === (handlers.onPathResolve ?? null)
    && record.searchOpenHandler === (handlers.onSearchOpen ?? null)
}

/**
 * Drops the commit this owner is giving up. Only the exact latched revision is
 * released, so a cleanup that runs after a newer commit - a replacement owner
 * that already committed, or StrictMode's double invoke - leaves that newer
 * token in place. Without this release, a commit for an agent whose record never
 * appeared (empty container, unmount before the attach, failed bootstrap) would
 * stay latched until a destroy that never runs.
 */
export function releaseTerminalSessionLinkHandlers(
  agentId: string,
  revision: TerminalLinkHandlersRevision,
) {
  return linkHandlersCommitLatch.release(agentId, revision)
}

export async function attachTerminalSession(agentId: string, options: AttachOptions) {
  if (options.signal?.aborted) return

  const record = await getOrCreateSession(agentId, options)
  if (record.disposed || options.signal?.aborted) return
  if (!sessions.isCurrent(agentId, record)) return

  if (record.attachedMount === options.mountEl && isTerminalSessionAttached(record)) {
    // Repeating the same ownership claim is a live-options refresh, not an
    // attachment transition. In particular it must not start recovery.
    applyTerminalAttachmentOptions(record, options)
    return
  }

  record.resizeEffects.beginRecovery({ forceAfterRecovery: true })
  const generation = record.attachment.beginAttachment().generation
  record.attachReadyHandler = options.onReady ?? null
  record.attachReadyGeneration = generation
  record.attachReadyNotified = false
  record.recoveryStatusHandler = options.onRecoveryStatusChange ?? null
  publishTerminalRecoveryStatus(record, 'requesting', { attempt: 1, restart: true })
  beginTerminalAttachmentReplication(record)
  // A parked xterm still contains its previous visible buffer. Hide it before
  // moving the host back into the live mount so the browser cannot paint that
  // stale frame while the authoritative checkpoint request is in flight.
  record.hostEl.classList.add('terminal-checkpoint-installing')
  appendHost(record, options.mountEl)
  if (record.parkedViewportState) {
    record.followOutput = record.parkedViewportState.following
    record.hasUnreadOutput = record.hasUnreadOutput || record.parkedViewportState.hasUnreadOutput
    record.preserveUnreadOutputUntilJump = record.preserveUnreadOutputUntilJump
      || record.parkedViewportState.preserveUnreadOutputUntilJump
  }
  repairTerminalAfterAttach(record)
  applyTerminalAttachmentOptions(record, options)
  seedTerminalCheckpoint(record, options.bootstrapState)
  emitFollowOutputState(record)
  fitAndFocus(record, options, generation)
}

export function retryTerminalSession(agentId: string) {
  const current = sessions.get(agentId)
  if (
    !current
    || current instanceof Promise
    || current.disposed
    || !isTerminalSessionAttached(current)
  ) return false

  retryTerminalReplication(current)
  current.hostEl.classList.add('terminal-checkpoint-installing')
  publishTerminalRecoveryStatus(current, 'requesting', { attempt: 1, restart: true })
  return true
}

export async function updateTerminalSessionBootstrapState(
  agentId: string,
  state: SessionBootstrapState,
) {
  const current = sessions.get(agentId)
  const record = current instanceof Promise ? await current : current
  if (
    !record
    || record.disposed
    || !canUpdateTerminalBootstrapState(record)
  ) {
    return false
  }
  invalidateTerminalCheckpointRequest(record)
  const seeded = seedTerminalCheckpoint(record, state)
  if (!seeded && !hasPendingTerminalSnapshot(record)) return false
  if (isTerminalSessionAttached(record)) {
    requestAnimationFrame(() => {
      if (!record.disposed) replayPendingSnapshot(record, record.attachment.generation)
    })
  }
  return seeded
}

export async function updateTerminalSessionLiveOptions(
  agentId: string,
  options: TerminalSessionLiveOptions,
) {
  const current = sessions.get(agentId)
  if (!current) return false
  const record = current instanceof Promise ? await current : current
  if (record.disposed || !sessions.isCurrent(agentId, record)) return false

  record.inputDisabled = options.inputDisabled
  record.manageReadingAnchor = options.manageReadingAnchor
  if (!record.manageReadingAnchor) {
    clearReadingAnchor(readingAnchorAgentKey(record.agentId, 'terminal'))
    if (record.parkedViewportState) record.parkedViewportState.readingAnchor = null
  }
  record.farmingUrlOpenHandler = options.onOpenUrlInFarming ?? null
  return true
}

export async function detachTerminalSession(agentId: string, expectedMount?: HTMLElement) {
  const current = sessions.get(agentId)
  if (!current) return
  const record = await current
  if (record.disposed) return
  if (!sessions.isCurrent(agentId, record)) return
  if (!canDetachTerminalHost(record, expectedMount)) return

  parkTerminalSessionRecord(record)
}

export function sendTerminalSessionInput(agentId: string, input: string | TerminalInputPart[]) {
  const current = sessions.get(agentId)
  if (!current) return false
  if (current instanceof Promise) {
    return false
  }
  return queueTerminalInput(current, input)
}

export async function getTerminalSelection(agentId: string) {
  const current = sessions.get(agentId)
  if (!current) return ''

  const record = await current
  if (record.disposed) return ''
  return record.selection.sync()
}

export function getTerminalSelectionNow(agentId: string) {
  const current = sessions.get(agentId)
  if (!current || current instanceof Promise || current.disposed) return ''

  return current.selection.sync()
}

export function getTerminalSessionReadCut(agentId: string) {
  const current = sessions.get(agentId)
  const attachment = current && !(current instanceof Promise) ? current.attachment : null
  if (
    !current
    || current instanceof Promise
    || current.disposed
    || !attachment?.runtimeEpoch
    || attachment.outputSeq === null
  ) {
    return null
  }
  return {
    runtimeEpoch: attachment.runtimeEpoch,
    outputSeq: attachment.outputSeq,
  }
}

export async function destroyTerminalSession(agentId: string) {
  const current = sessions.take(agentId)
  if (!current) return

  // `take` is the moment this destroy owns the entry, so the latched commit it
  // may release is the one visible right now. Awaiting the bootstrap below lets
  // a new owner commit its own revisions and create a replacement session;
  // releasing that owner's token would send its late attach back to the revision
  // it captured before those commits.
  const takenLinkHandlersRevision = linkHandlersCommitLatch.committedRevision(agentId)
  const releaseTakenLinkHandlers = () => {
    linkHandlersCommitLatch.release(agentId, takenLinkHandlersRevision)
  }

  let record: SessionRecord
  try {
    record = await current
  } catch (error) {
    releaseTakenLinkHandlers()
    throw error
  }
  if (record.disposed) {
    releaseTakenLinkHandlers()
    return
  }
  record.disposed = true
  invalidateTerminalCheckpointRequest(record)
  record.resizeEffects.dispose()
  clearPendingTerminalOutput(record)
  flushPendingTerminalWrites(record)

  record.unsubscribeOutput?.()
  record.rendererFailureDisposable?.()
  record.scrollChangeDisposable?.()
  if (record.backendConnectedHandler) {
    window.removeEventListener('farming:backend-connected', record.backendConnectedHandler)
  }
  if (record.pageLifecycleHandler) {
    document.removeEventListener('visibilitychange', record.pageLifecycleHandler)
    window.removeEventListener('pagehide', record.pageLifecycleHandler)
    window.removeEventListener('pageshow', record.pageLifecycleHandler)
  }
  if (record.followCheckFrame !== null) cancelAnimationFrame(record.followCheckFrame)
  record.interaction.dispose()
  releaseTakenLinkHandlers()
  record.terminal.dispose()
  record.hostEl.remove()
}

export async function pruneTerminalSessions(activeAgentIds: string[]) {
  const activeSet = new Set(activeAgentIds)
  const staleIds = [...sessions.keys()].filter(agentId => !activeSet.has(agentId))

  await Promise.all(staleIds.map(agentId => destroyTerminalSession(agentId)))
}

export function focusTerminalSession(agentId: string) {
  const current = sessions.get(agentId)
  if (!current) return Promise.resolve(false)
  if (typeof (current as Promise<SessionRecord>).then !== 'function') {
    const record = current as SessionRecord
    return Promise.resolve(focusAttachedTerminalInput(record))
  }

  return (current as Promise<SessionRecord>).then(record => {
    return focusAttachedTerminalInput(record)
  })
}

export async function refreshTerminalSessionLayout(agentId: string, options: { autoFocus?: boolean } = {}) {
  const current = sessions.get(agentId)
  if (!current) return false
  const record = await current
  if (record.disposed) return false
  if (!isTerminalSessionAttached(record)) return false

  const wasFollowing = record.followOutput
  const previousViewportY = getTerminalViewportY(record.terminal)
  const previousScrollbackLength = getTerminalScrollbackLength(record.terminal)
  const hadUnreadOutput = record.hasUnreadOutput

  const refresh = () => {
    if (record.disposed || !isTerminalSessionAttached(record)) return
    record.resizeEffects.syncFit({ force: true })
    restoreViewportAfterLayout(record, previousViewportY, previousScrollbackLength, wasFollowing, hadUnreadOutput)
    scheduleTerminalRepaint(record)
    if (options.autoFocus && !isMobileViewport() && shouldAllowTerminalAutoFocus(record.hostEl)) {
      focusTerminalInputWhenReady(record, record.attachment.generation)
    }
  }

  requestAnimationFrame(() => {
    refresh()
    requestAnimationFrame(refresh)
  })
  return true
}

export function updateTerminalSessionContentFontSize(contentFontSize: unknown) {
  const fontSize = codeTerminalFontSize(contentFontSize, isCompactViewport())
  sessions.forEach(current => {
    if (current instanceof Promise || current.disposed) return
    if (current.hostEl.dataset.terminalFontSize === String(fontSize)) return
    current.hostEl.dataset.terminalFontSize = String(fontSize)
    if (current.terminal.options) current.terminal.options.fontSize = fontSize
    if (!isTerminalSessionAttached(current)) return
    requestAnimationFrame(() => {
      if (current.disposed || !isTerminalSessionAttached(current)) return
      current.resizeEffects.syncFit({ force: true })
      scheduleTerminalRepaint(current)
      requestAnimationFrame(() => {
        if (current.disposed || !isTerminalSessionAttached(current)) return
        current.resizeEffects.syncFit({ force: true })
        scheduleTerminalRepaint(current)
      })
    })
  })
}

export async function scrollTerminalSessionToBottom(agentId: string) {
  const current = sessions.get(agentId)
  if (!current) return
  const record = await current
  if (record.disposed) return
  record.interaction.stopTouchMomentum()
  scrollRecordToBottom(record, { allowClearUnread: true })
}

export async function searchTerminalSession(
  agentId: string,
  term: string,
  direction: TerminalSearchDirection = 'next',
  options: TerminalSearchOptions = {},
): Promise<TerminalSearchResult> {
  const current = sessions.get(agentId)
  if (!current) return { found: false, resultIndex: 0, resultCount: 0 }

  const record = await current
  if (record.disposed || typeof record.terminal.search !== 'function') {
    return { found: false, resultIndex: 0, resultCount: 0 }
  }
  return record.terminal.search(term, direction, options)
}

export async function clearTerminalSearch(agentId: string) {
  const current = sessions.get(agentId)
  if (!current) return

  const record = await current
  if (record.disposed) return
  record.terminal.clearSearch?.()
}
