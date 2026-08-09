import '../../frontend/terminal-replay.js'
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  createTerminalInstance,
  isXtermTerminal,
} from '@/lib/terminal-engine'
import type { FarmingFitAddon, FarmingTerminal } from '@/lib/terminal-engine'
import type { TerminalLinkProvider } from '@/lib/terminal-engine'
import {
  collectTerminalLinkMatches,
  collectTerminalMultiLinePathLinkMatches,
  collectTerminalPathLinkMatches,
  parseExplicitTerminalUrlAtColumn,
  parseTerminalSearchAtColumn,
  parseTerminalUrlAtColumn,
  terminalTextColumnAtPixelOffset,
  terminalLinkMatchRange,
} from '@/lib/terminal-links'
import type { TerminalLinkHoverTarget, TerminalLinkMatch, TerminalPathOpenTarget } from '@/lib/terminal-links'
import { terminalImeOverlayStyle } from '@/lib/terminal-ime'
import {
  isContinuousSelectionText,
  isZeroWidthCell,
  normalizeTerminalSelection,
  normalizeTerminalSelectionForCopy,
  orderedSelection,
  readCellText,
  selectionLength,
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
  acknowledgeTerminalResizeDelivery,
  expireTerminalResizeDelivery,
  notifyTerminalResizeTracker,
  proposeTerminalResizeDimensions,
  queueTerminalResizeDelivery,
  resetTerminalResizeDeliveryTracker,
  resetTerminalResizeTracker,
  shouldDebounceTerminalResize,
} from '@/lib/terminal-resize'
import { createTerminalResizeScheduler } from '@/lib/terminal-resize-scheduler'
import type { TerminalResizeScheduler } from '@/lib/terminal-resize-scheduler'
import {
  appendTerminalTouchVelocitySample,
  blendTerminalTouchVelocity,
  consumeTerminalTouchScrollDelta,
  nextTerminalTouchEdgeOffset,
  readTerminalTouchGestureVelocity,
  shouldStartTerminalTouchMomentum,
  stepTerminalTouchMomentum,
} from '@/lib/terminal-touch-scroll'
import type { TerminalTouchVelocitySample } from '@/lib/terminal-touch-scroll'
import {
  flushPendingTerminalWrites,
  forceTerminalRender,
  replaceTerminalOutput,
  restoreViewportAfterLayout,
  scheduleTerminalRepaint,
  scrollRecordToBottom,
  scrollRecordToLine,
  scrollRecordToViewportY,
  stableTerminalScrollbarOpacity,
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
import { readClipboardText, writeClipboardText } from '@/lib/clipboard'
import {
  shouldBlockDetachedTerminalPaste,
  shouldHandleTerminalPasteEvent,
} from '@/lib/terminal-input'
import {
  sessionBootstrapStateFromPayload,
} from '@/lib/terminal-bootstrap'
import type { SessionBootstrapState } from '@/lib/terminal-bootstrap'
import { openExternalUrl, showUrlOpenMenu } from '@/lib/url-open-menu'
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

const TERMINAL_CHECKPOINT_REQUEST_TIMEOUT_MS = 5000
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
  suppressRendererCursor?: boolean
  inputDisabled?: boolean
  onFollowOutputChange?: (state: TerminalFollowState) => void
  onPathOpen?: (agentId: string, target: TerminalPathOpenTarget) => void
  onPathResolve?: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onSearchOpen?: (agentId: string, query: string) => void
  onOpenUrlInFarming?: (agentId: string, url: string) => void
  onRecoveryStatusChange?: (status: TerminalRecoveryStatus) => void
  onReady?: () => void
  onError?: (error: Error) => void
  bootstrapState?: SessionBootstrapState
  signal?: AbortSignal
}

export interface TerminalSessionLiveOptions {
  inputDisabled: boolean
  suppressRendererCursor: boolean
  onOpenUrlInFarming?: (agentId: string, url: string) => void
}

export type { TerminalRecoveryPhase, TerminalRecoveryStatus } from '@/lib/terminal-recovery-status'

export type TerminalSearchDirection = 'next' | 'previous'

export interface TerminalSearchResult {
  found: boolean
  resultIndex?: number
  resultCount?: number
}

interface TerminalLogicalLine {
  text: string
  col: number
  startRow: number
  endRow: number
  bufferRow: number
  cols: number
  buffer: TerminalBuffer
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
  selectionChangeDisposable: (() => void) | null
  imeOverlayDisposables: Array<() => void>
  resizeObserver: ResizeObserver | null
  applyingLocalResize: boolean
  parkedViewportState: TerminalViewportRestoreState | null
  inputDisabled: boolean
  errorHandler: ((error: Error) => void) | null
  recoveryStatusHandler: ((status: TerminalRecoveryStatus) => void) | null
  recoveryStatus: TerminalRecoveryStatus
  rendererFailureDisposable: (() => void) | null
  scrollChangeDisposable: (() => void) | null
  backendConnectedHandler: (() => void) | null
  clickHandler: ((event: MouseEvent) => void) | null
  pointerDownSelectionHandler: ((event: PointerEvent) => void) | null
  pointerMoveSelectionHandler: ((event: PointerEvent) => void) | null
  pointerUpSelectionHandler: ((event: PointerEvent) => void) | null
  mouseDownOpenTargetHandler: ((event: MouseEvent) => void) | null
  mouseDownSelectionHandler: ((event: MouseEvent) => void) | null
  mouseMoveSelectionHandler: ((event: MouseEvent) => void) | null
  mouseUpSelectionHandler: ((event: MouseEvent) => void) | null
  mouseUpOpenTargetHandler: ((event: MouseEvent) => void) | null
  doubleClickHandler: ((event: MouseEvent) => void) | null
  copyHandler: ((event: ClipboardEvent) => void) | null
  copyKeyHandler: ((event: KeyboardEvent) => void) | null
  clearKeyHandler: ((event: KeyboardEvent) => void) | null
  pasteHandler: ((event: ClipboardEvent) => void) | null
  lastLinkHoverEvent: MouseEvent | null
  openModifierActive: boolean
  linkHoverHandler: ((event: MouseEvent) => void) | null
  linkHoverLeaveHandler: ((event: MouseEvent) => void) | null
  linkHoverKeyHandler: ((event: KeyboardEvent) => void) | null
  linkHoverBlurHandler: (() => void) | null
  linkProviderDisposable: (() => void) | null
  linkProviderHoverTarget: TerminalLinkHoverTarget | null
  contextMenuHandler: ((event: MouseEvent) => void) | null
  contextMenuMouseDownHandler: ((event: MouseEvent) => void) | null
  contextMenuEl: HTMLDivElement | null
  contextMenuCleanup: (() => void) | null
  contextMenuSelection: string
  imeKeydownHandler: ((event: KeyboardEvent) => void) | null
  scrollIntentHandler: ((event: Event) => void) | null
  scrollKeyHandler: ((event: KeyboardEvent) => void) | null
  touchInteraction: TerminalTouchInteraction | null
  lastNotifiedResize: { cols: number; rows: number } | null
  resizeNotificationCount: number
  resizeRequestInFlight: { cols: number; rows: number } | null
  pendingResizeRequest: { cols: number; rows: number } | null
  resizeScheduler: TerminalResizeScheduler
  resizeAfterReplayRequired: boolean
  followOutputHandler: ((state: TerminalFollowState) => void) | null
  pathOpenHandler: ((agentId: string, target: TerminalPathOpenTarget) => void) | null
  pathResolveHandler: ((agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null) | null
  searchOpenHandler: ((agentId: string, query: string) => void) | null
  farmingUrlOpenHandler: ((agentId: string, url: string) => void) | null
  pathResolveCache: Map<string, { resolvedAt: number; target: TerminalPathOpenTarget | null; promise?: Promise<TerminalPathOpenTarget | null> }>
  originalRender: NonNullable<NonNullable<FarmingTerminal['renderer']>['render']> | null
  snapshotOutput: string
  snapshotRuntimeEpoch: string
  snapshotOutputSeq: number | null
  snapshotStateRevision: number | null
  snapshotCols: number | null
  snapshotRows: number | null
  attachment: TerminalAttachmentCoordinator
  replayInProgress: boolean
  liveWriteInProgress: boolean
  liveTransitionFlushScheduled: boolean
  terminalWriteQueue: Promise<void>
  terminalWriteResolvers: Set<(cancelled?: boolean) => boolean>
  terminalWriteBatchCount: number
  holdCheckpointInstallCompletionForTest: boolean
  heldCheckpointInstallCompletionForTest: (() => void) | null
  bootstrapRefreshSeq: number
  checkpointRequestCount: number
  checkpointRequestInFlight: boolean
  checkpointRetryTimer: number | null
  bootstrapRequestControllers: Set<AbortController>
  needsReconnectOutputSync: boolean
  pageOutputSuspended: boolean
  pageLifecycleHandler: ((event: Event) => void) | null
  pendingSnapshotReplay: boolean
  bootstrappingSnapshot: boolean
  fixtureOverrideActive: boolean
  suspendRendering: boolean
  cachedSelection: string
  lastNonEmptySelection: string
  openTargetMouseDown: { x: number; y: number; pathTargets: TerminalPathOpenTarget[] } | null
  dragSelection: {
    start: { col: number; row: number }
    active: boolean
    moved: boolean
    pointerId?: number
  } | null
  suppressClickUntil: number
  suppressOutputUntil: number
  imeComposing: boolean
  suppressRendererCursor: boolean
  rendererCursorWasVisible: boolean | undefined
  inputCount: number
  followOutput: boolean
  hasUnreadOutput: boolean
  preserveUnreadOutputUntilJump: boolean
  followCheckFrame: number | null
  disposed: boolean
  bootstrapped: boolean
}

const sessions = new TerminalSessionRegistry<string, SessionRecord>()
const terminalSessionDiagnostics = new TerminalSessionDiagnosticsProjection({
  get: agentId => sessions.get(agentId),
  values: () => sessions.values(),
})
let terminalFocusRevision = 0
const TERMINAL_CHECKPOINT_MAX_CONCURRENT_REQUESTS = 3
let terminalCheckpointActiveRequests = 0
const terminalCheckpointRequestQueue: Array<{
  signal: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: DOMException) => void
  onAbort: () => void
}> = []
const TOUCH_SCROLL_ACTIVATION_PX = 6
const TOUCH_LONG_PRESS_MS = 520
const TOUCH_EDGE_SPRING_MS = 240
const TERMINAL_PATH_RESOLVE_CACHE_TTL_MS = 30_000

function drainTerminalCheckpointRequestQueue() {
  while (
    terminalCheckpointActiveRequests < TERMINAL_CHECKPOINT_MAX_CONCURRENT_REQUESTS
    && terminalCheckpointRequestQueue.length > 0
  ) {
    const request = terminalCheckpointRequestQueue.shift()
    if (!request) return
    request.signal.removeEventListener('abort', request.onAbort)
    if (request.signal.aborted) {
      request.reject(new DOMException('Terminal checkpoint request was cancelled', 'AbortError'))
      continue
    }
    terminalCheckpointActiveRequests += 1
    let released = false
    request.resolve(() => {
      if (released) return
      released = true
      terminalCheckpointActiveRequests = Math.max(0, terminalCheckpointActiveRequests - 1)
      drainTerminalCheckpointRequestQueue()
    })
  }
}

function acquireTerminalCheckpointRequestSlot(signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Terminal checkpoint request was cancelled', 'AbortError'))
  }
  return new Promise<() => void>((resolve, reject) => {
    const request = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = terminalCheckpointRequestQueue.indexOf(request)
        if (index >= 0) terminalCheckpointRequestQueue.splice(index, 1)
        reject(new DOMException('Terminal checkpoint request was cancelled', 'AbortError'))
      },
    }
    signal.addEventListener('abort', request.onAbort, { once: true })
    terminalCheckpointRequestQueue.push(request)
    drainTerminalCheckpointRequestQueue()
  })
}

interface TerminalTouchInteraction {
  pointerDownHandler: (event: PointerEvent) => void
  pointerMoveHandler: (event: PointerEvent) => void
  pointerUpHandler: (event: PointerEvent) => void
  stopTouchMomentum: () => void
}

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
      getRendererCursorVisible: (agentId: string) => boolean | undefined
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

function invalidateTerminalCheckpointRequest(record: SessionRecord) {
  record.attachment.invalidateOperation()
  // A checkpoint may already be inside xterm's ordered write queue. Its
  // completion is fenced by the coordinator operation token, but the replacement
  // recovery must not inherit the old install latch or it can never start.
  record.replayInProgress = false
  clearTerminalCheckpointRetry(record)
  record.bootstrapRequestControllers.forEach(controller => controller.abort())
  record.bootstrapRequestControllers.clear()
  record.checkpointRequestInFlight = false
}

function resetTerminalResizeDelivery(record: SessionRecord) {
  record.resizeScheduler.reset()
  resetTerminalResizeDeliveryTracker(record)
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
  resetTerminalResizeDelivery(record)
  record.followOutputHandler = null
  record.recoveryStatusHandler = null
  record.pathOpenHandler = null
  record.pathResolveHandler = null
  record.searchOpenHandler = null
  pauseTerminalResizeObserver(record)
  resetTransientTerminalUi(record)
  record.attachment.detach()
  parkTerminalHost(record)
}

function observeTerminalResize(record: SessionRecord) {
  if (record.disposed || !record.resizeObserver) return
  record.resizeObserver.observe(record.hostEl)
}

function pauseTerminalResizeObserver(record: SessionRecord) {
  record.resizeObserver?.disconnect()
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

function readTerminalFontSize(hostEl: HTMLElement): number {
  const raw = hostEl.dataset.terminalFontSize
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FONT_SIZE
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

async function fetchSessionBootstrapState(
  agentId: string,
  signal: AbortSignal,
): Promise<SessionBootstrapState> {
  const data = await requestTerminalSessionCheckpoint(agentId, signal)
  return sessionBootstrapStateFromPayload(data)
}

async function fetchSessionBootstrapStateForCurrentTerminal(record: SessionRecord) {
  record.checkpointRequestCount += 1
  const controller = new AbortController()
  record.bootstrapRequestControllers.add(controller)
  let release: (() => void) | null = null
  let timeout: number | null = null
  try {
    release = await acquireTerminalCheckpointRequestSlot(controller.signal)
    timeout = window.setTimeout(
      () => controller.abort(new DOMException('Terminal checkpoint request timed out', 'TimeoutError')),
      TERMINAL_CHECKPOINT_REQUEST_TIMEOUT_MS,
    )
    // The reducer's checkpoint dimensions are part of the authoritative cut.
    // Install that cut first; the visible browser submits its latest geometry
    // only after the checkpoint barrier has completed.
    return await fetchSessionBootstrapState(record.agentId, controller.signal)
  } finally {
    if (timeout !== null) window.clearTimeout(timeout)
    release?.()
    record.bootstrapRequestControllers.delete(controller)
  }
}

function focusTerminalInput(hostEl: HTMLDivElement, terminal: FarmingTerminal) {
  // xterm owns its helper textarea and composition lifecycle. Go through its
  // public focus API so a focus change from the composer does not bypass the
  // same IME path it uses for ordinary terminal input.
  if (isXtermTerminal(terminal)) {
    terminal.focus()
    return true
  }

  const input = hostEl.querySelector('textarea')
  if (input instanceof HTMLTextAreaElement) {
    updateTerminalImeOverlay(hostEl, terminal)
    input.focus()
    return true
  }

  terminal.focus()
  return false
}

function focusAttachedTerminalInput(record: SessionRecord) {
  if (record.disposed || record.attachedMount === null) return false
  terminalFocusRevision += 1
  return focusTerminalInput(record.hostEl, record.terminal)
}

function mayRestoreTerminalFocusAfterAsyncMenu(
  record: SessionRecord,
  menu: HTMLElement,
  focusRevision: number,
) {
  if (record.disposed || record.attachedMount === null || terminalFocusRevision !== focusRevision) return false
  const activeElement = document.activeElement
  return activeElement === document.body
    || menu.contains(activeElement)
    || record.hostEl.contains(activeElement)
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

function isTextEditingCopyTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest([
    '.code-composer',
    '.code-terminal-search',
    '.code-file-editor',
    '.monaco-editor',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[role="dialog"]',
    '[role="menu"]',
  ].join(',')))
}

function shouldHandleTerminalCopyEvent(record: SessionRecord, event: ClipboardEvent) {
  if (record.disposed || record.attachedMount === null) return false

  const target = event.target
  if (target instanceof Node && record.hostEl.contains(target)) return true
  if (isTextEditingCopyTarget(target)) return false

  const selection = window.getSelection?.()
  if (!selection || selection.isCollapsed) return true

  const anchorNode = selection.anchorNode
  const focusNode = selection.focusNode
  return Boolean(
    (anchorNode && record.hostEl.contains(anchorNode)) ||
    (focusNode && record.hostEl.contains(focusNode))
  )
}

function isTerminalCopyShortcut(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'c' || event.altKey || event.shiftKey) return false
  if (event.metaKey && !event.ctrlKey) return true

  const isMac = navigator.platform.toLowerCase().includes('mac')
  return !isMac && event.ctrlKey && !event.metaKey
}

function shouldHandleTerminalCopyKeyEvent(record: SessionRecord, event: KeyboardEvent) {
  if (!isTerminalCopyShortcut(event)) return false
  if (record.disposed || record.attachedMount === null) return false

  const target = event.target
  if (target instanceof Node && record.hostEl.contains(target)) return true
  if (isTextEditingCopyTarget(target)) return false

  const selection = window.getSelection?.()
  if (!selection || selection.isCollapsed) return true

  const anchorNode = selection.anchorNode
  const focusNode = selection.focusNode
  return Boolean(
    (anchorNode && record.hostEl.contains(anchorNode)) ||
    (focusNode && record.hostEl.contains(focusNode))
  )
}

function isTerminalClearShortcut(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey || event.ctrlKey) return false
  const isMac = navigator.platform.toLowerCase().includes('mac')
  return isMac && event.metaKey
}

function shouldHandleTerminalClearKeyEvent(record: SessionRecord, event: KeyboardEvent) {
  if (!isTerminalClearShortcut(event)) return false
  if (record.disposed || record.attachedMount === null) return false

  const target = event.target
  return target instanceof Node && record.hostEl.contains(target)
}

function handleTerminalClearKeyEvent(record: SessionRecord, event: KeyboardEvent) {
  if (!shouldHandleTerminalClearKeyEvent(record, event)) return false

  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  clearTerminalBuffer(record)
  return true
}

function isTerminalSessionAttached(record: SessionRecord) {
  return isTerminalHostAttached(record)
}

function shouldHandleTerminalHoverEvent(record: SessionRecord) {
  return isTerminalSessionAttached(record)
}

function shouldHandleTerminalScrollKeyEvent(record: SessionRecord, event: KeyboardEvent) {
  if (event.type !== 'keydown') return false
  if (!['PageUp', 'PageDown'].includes(event.key)) return false
  if (record.disposed || record.attachedMount === null) return false
  const target = event.target
  return target instanceof Node && record.hostEl.contains(target)
}

function handleTerminalScrollKeyEvent(record: SessionRecord, event: KeyboardEvent) {
  if (!shouldHandleTerminalScrollKeyEvent(record, event)) return false

  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()

  const nextViewportY = terminalPageScrollTarget(
    record.terminal,
    event.key === 'PageUp' ? 'PageUp' : 'PageDown',
    MIN_TERMINAL_RESIZE_ROWS,
  )
  scrollRecordToViewportY(record, nextViewportY)
  setFollowOutputState(record, nextViewportY <= 0, nextViewportY <= 0 ? false : record.hasUnreadOutput, {
    allowClearUnread: nextViewportY <= 0,
  })
  emitFollowOutputState(record)
  return true
}

function updateTerminalImeOverlay(hostEl: HTMLDivElement, terminal: FarmingTerminal) {
  const input = hostEl.querySelector('textarea')
  const metrics = terminal.renderer?.getMetrics?.()
  const cursor = terminal.wasmTerm?.getCursor?.()
  if (!(input instanceof HTMLTextAreaElement) || !metrics || !cursor) return

  const fontSize = readTerminalFontSize(hostEl)
  const style = terminalImeOverlayStyle(
    cursor,
    metrics,
    fontSize,
    DEFAULT_FONT_FAMILY,
  )
  if (!style) return

  input.classList.add('terminal-ime-input')
  Object.assign(input.style, style)
}

function isCurrentAttachment(record: SessionRecord, generation: number) {
  return record.attachment.isCurrentGeneration(generation) && isTerminalHostAttached(record)
}

function replayPendingSnapshot(record: SessionRecord, generation = record.attachment.generation) {
  if (
    record.fixtureOverrideActive ||
    record.disposed ||
    !record.pendingSnapshotReplay ||
    !isCurrentAttachment(record, generation)
  ) return

  record.pendingSnapshotReplay = false
  if (
    !record.snapshotRuntimeEpoch ||
    record.snapshotOutputSeq === null ||
    record.snapshotStateRevision === null ||
    record.snapshotCols === null ||
    record.snapshotRows === null
  ) {
    requestTerminalReplay(record, generation)
    return
  }
  installTerminalCheckpoint(record, {
    runtimeEpoch: record.snapshotRuntimeEpoch,
    output: record.snapshotOutput,
    outputSeq: record.snapshotOutputSeq,
    stateRevision: record.snapshotStateRevision,
    cols: record.snapshotCols,
    rows: record.snapshotRows,
  }, generation)
}

function seedTerminalCheckpoint(record: SessionRecord, state?: SessionBootstrapState) {
  if (!state || record.fixtureOverrideActive) return false
  const checkpoint = terminalReplayCheckpoint(state)
  if (record.attachment.evaluateCheckpoint(checkpoint).action === 'reject') return false

  record.snapshotOutput = state.output
  record.snapshotRuntimeEpoch = state.runtimeEpoch
  record.snapshotOutputSeq = state.outputSeq
  record.snapshotStateRevision = state.stateRevision
  record.snapshotCols = state.cols
  record.snapshotRows = state.rows
  record.pendingSnapshotReplay = true
  record.bootstrappingSnapshot = true
  record.needsReconnectOutputSync = true
  return true
}

function terminalReplayCheckpoint(state: SessionBootstrapState): TerminalReplayCheckpoint {
  return {
    runtimeEpoch: state.runtimeEpoch,
    outputSeq: state.outputSeq!,
    stateRevision: state.stateRevision!,
    cols: state.cols!,
    rows: state.rows!,
  }
}

function queueTerminalTransition(
  record: SessionRecord,
  event: TerminalReplayTransition,
) {
  const result = record.attachment.queueTransition(event)
  if (!result.queued) {
    record.needsReconnectOutputSync = true
    record.bootstrappingSnapshot = true
    requestTerminalReplay(record, record.attachment.generation)
  }
}

function clearTerminalCheckpointRetry(record: SessionRecord) {
  if (record.checkpointRetryTimer === null) return
  window.clearTimeout(record.checkpointRetryTimer)
  record.checkpointRetryTimer = null
}

function scheduleTerminalCheckpointRetry(
  record: SessionRecord,
  delay: number,
  generation = record.attachment.generation,
) {
  if (record.disposed || record.attachment.halted || record.checkpointRetryTimer !== null) return
  record.checkpointRetryTimer = window.setTimeout(() => {
    record.checkpointRetryTimer = null
    if (record.disposed || !isCurrentAttachment(record, generation)) return
    requestTerminalReplay(record, generation)
  }, delay)
}

function retryTerminalReplayAfterFailure(
  record: SessionRecord,
  failure: TerminalReplayFailure,
  generation: number,
) {
  record.checkpointRequestInFlight = false
  record.needsReconnectOutputSync = true
  record.bootstrappingSnapshot = true
  if (failure.halted) {
    stopTerminalReplay(record, failure.message)
    return
  }
  publishTerminalRecoveryStatus(record, 'retrying', {
    attempt: record.attachment.failureCount + 1,
    retryDelayMs: failure.delay,
  })
  scheduleTerminalCheckpointRetry(record, failure.delay, generation)
}

function stopTerminalReplay(record: SessionRecord, message: string) {
  clearTerminalCheckpointRetry(record)
  record.checkpointRequestInFlight = false
  record.replayInProgress = false
  record.bootstrappingSnapshot = false
  record.pendingSnapshotReplay = false
  record.attachment.clearQueuedTransitions()
  record.hostEl.classList.add('terminal-checkpoint-installing')
  publishTerminalRecoveryStatus(record, 'failed')
  reportTerminalSyncError(record, message)
}

function finishTerminalReplay(record: SessionRecord, generation: number) {
  if (
    record.disposed ||
    !isCurrentAttachment(record, generation) ||
    record.replayInProgress ||
    record.checkpointRequestInFlight ||
    record.pendingSnapshotReplay ||
    record.liveWriteInProgress
  ) return

  if (record.attachment.queuedTransitionCount > 0) {
    flushQueuedTerminalOutput(record)
    if (
      record.attachment.queuedTransitionCount > 0 ||
      record.liveWriteInProgress ||
      record.checkpointRequestInFlight
    ) return
  }

  if (record.needsReconnectOutputSync || record.attachment.isReplayTargetPending()) {
    requestTerminalReplay(record, generation)
    return
  }

  record.bootstrappingSnapshot = false
  resetTerminalResizeDelivery(record)
  const forceResize = record.resizeAfterReplayRequired || record.lastNotifiedResize === null
  record.resizeAfterReplayRequired = false
  requestAnimationFrame(() => {
    if (!isCurrentAttachment(record, generation) || record.disposed) return
    record.hostEl.classList.remove('terminal-checkpoint-installing')
    syncTerminalSize(record, { force: forceResize })
    notifyTerminalAttachReady(record, generation)
  })
}

function terminalViewportStateForRestore(record: SessionRecord): TerminalViewportRestoreState {
  if (record.parkedViewportState) {
    return {
      ...record.parkedViewportState,
      hasUnreadOutput: record.parkedViewportState.hasUnreadOutput || record.hasUnreadOutput,
      preserveUnreadOutputUntilJump:
        record.parkedViewportState.preserveUnreadOutputUntilJump
        || record.preserveUnreadOutputUntilJump,
    }
  }
  const persistedAnchor = readReadingAnchor(readingAnchorAgentKey(record.agentId, 'terminal'))
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

function restoreTerminalViewportFromAnchor(record: SessionRecord, viewportState: TerminalViewportRestoreState) {
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
  if (viewportState.readingAnchor && restoreTerminalReadingAnchor(record, viewportState.readingAnchor)) {
    return
  }
  // A terminal screen is bounded. Once the logical-line fingerprint has been
  // evicted or rewritten, an old absolute scrollback row is misleading; read
  // the current tail instead.
  clearReadingAnchor(readingAnchorAgentKey(record.agentId, 'terminal'))
  scrollRecordToBottom(record, { allowClearUnread: true })
}

function installTerminalCheckpoint(
  record: SessionRecord,
  state: SessionBootstrapState,
  generation: number,
) {
  if (
    record.disposed ||
    !isCurrentAttachment(record, generation)
  ) return false

  const operation = record.attachment.beginCheckpointOperation(generation)
  if (!operation) return false
  publishTerminalRecoveryStatus(record, 'installing', {
    attempt: record.attachment.failureCount + 1,
  })
  record.checkpointRequestInFlight = false
  const checkpoint = terminalReplayCheckpoint(state)
  const decision = record.attachment.evaluateCheckpoint(checkpoint)
  if (decision.action === 'reject') {
    retryTerminalReplayAfterFailure(
      record,
      record.attachment.recordInvariantFailure(
        decision.signature || 'invalid-checkpoint',
        decision.message || 'Terminal replay returned an invalid screen state',
      ),
      generation,
    )
    return false
  }
  if (
    decision.action === 'current' &&
    record.terminal.cols === state.cols &&
    record.terminal.rows === state.rows
  ) {
    const viewportState = terminalViewportStateForRestore(record)
    record.attachment.commitCheckpoint(operation, checkpoint)
    record.needsReconnectOutputSync = false
    record.bootstrappingSnapshot = false
    restoreTerminalViewportFromAnchor(record, viewportState)
    flushQueuedTerminalOutput(record)
    finishTerminalReplay(record, generation)
    return true
  }

  const viewportState = terminalViewportStateForRestore(record)

  record.replayInProgress = true
  record.bootstrappingSnapshot = true
  record.hostEl.classList.add('terminal-checkpoint-installing')

  let checkpointEffectAdmitted = false
  replaceTerminalOutput(record, state.output, () => {
    const completeInstall = () => {
      if (
        record.disposed ||
        !isCurrentAttachment(record, generation) ||
        !record.attachment.isCurrentOperation(operation)
      ) return

      if (!checkpointEffectAdmitted) {
        record.replayInProgress = false
        if (
          record.attachment.isReplayTargetPending()
          || record.attachment.queuedTransitionCount > 0
        ) {
          record.needsReconnectOutputSync = true
          record.bootstrappingSnapshot = true
          requestTerminalReplay(record, generation)
        } else {
          record.needsReconnectOutputSync = false
          record.bootstrappingSnapshot = false
          flushQueuedTerminalOutput(record)
          finishTerminalReplay(record, generation)
        }
        return
      }
      if (!record.attachment.commitCheckpoint(operation, checkpoint)) {
        record.replayInProgress = false
        record.needsReconnectOutputSync = true
        record.bootstrappingSnapshot = true
        requestTerminalReplay(record, generation)
        return
      }
      record.followOutput = viewportState.following
      record.hasUnreadOutput = viewportState.hasUnreadOutput
      record.preserveUnreadOutputUntilJump = viewportState.preserveUnreadOutputUntilJump
      restoreTerminalViewportFromAnchor(record, viewportState)
      record.replayInProgress = false
      record.needsReconnectOutputSync = false
      record.bootstrappingSnapshot = false
      scheduleImeOverlayUpdateIfActive(record)
      flushQueuedTerminalOutput(record)
      finishTerminalReplay(record, generation)
    }
    if (record.holdCheckpointInstallCompletionForTest) {
      record.heldCheckpointInstallCompletionForTest = completeInstall
      return
    }
    completeInstall()
  }, {
    beforeReplace: () => {
      if (
        record.disposed
        || !isCurrentAttachment(record, generation)
        || !record.attachment.admitCheckpointInstall(operation, checkpoint)
      ) return false

      if (
        record.terminal.cols !== state.cols
        || record.terminal.rows !== state.rows
      ) {
        record.applyingLocalResize = true
        try {
          record.terminal.resize?.(state.cols!, state.rows!)
        } finally {
          record.applyingLocalResize = false
        }
      }
      checkpointEffectAdmitted = true
      return true
    },
  })
  return true
}

function requestTerminalReplay(record: SessionRecord, generation = record.attachment.generation) {
  if (
    record.disposed ||
    record.fixtureOverrideActive ||
    record.pageOutputSuspended ||
    record.checkpointRequestInFlight ||
    record.checkpointRetryTimer !== null ||
    record.replayInProgress ||
    record.attachment.halted ||
    !isCurrentAttachment(record, generation)
  ) return

  publishTerminalRecoveryStatus(record, 'requesting', {
    attempt: record.attachment.failureCount + 1,
  })
  record.attachment.beginRecovery()
  const requestOperation = record.attachment.beginCheckpointOperation(generation)
  if (!requestOperation) return
  record.checkpointRequestInFlight = true
  record.bootstrappingSnapshot = true
  record.needsReconnectOutputSync = true
  fetchSessionBootstrapStateForCurrentTerminal(record)
    .then((state) => {
      if (
        record.disposed ||
        !record.attachment.isCurrentOperation(requestOperation) ||
        record.pageOutputSuspended ||
        !isCurrentAttachment(record, generation)
      ) return
      record.checkpointRequestInFlight = false
      installTerminalCheckpoint(record, state, generation)
    })
    .catch((error) => {
      if (record.disposed || !record.attachment.isCurrentOperation(requestOperation)) return
      retryTerminalReplayAfterFailure(
        record,
        record.attachment.recordTransportFailure(),
        generation,
      )
      if (error instanceof Error && error.name !== 'AbortError') {
        console.warn('Terminal replay request failed; retrying:', error)
      }
    })
}

function applyTerminalOutputEvent(
  record: SessionRecord,
  data: string,
  replace?: boolean,
  outputSeq?: number | null,
  runtimeEpoch = '',
  stateRevision?: number | null,
  cols?: number,
  rows?: number,
  kind: TerminalTransitionKind = 'output',
) {
  if (replace) {
    if (record.fixtureOverrideActive || record.pageOutputSuspended) return
    invalidateTerminalCheckpointRequest(record)
    installTerminalCheckpoint(record, {
      runtimeEpoch,
      output: data,
      outputSeq: Number.isFinite(outputSeq) ? outputSeq! : null,
      stateRevision: Number.isFinite(stateRevision) ? stateRevision! : null,
      cols: Number.isFinite(cols) ? cols! : null,
      rows: Number.isFinite(rows) ? rows! : null,
    }, record.attachment.generation)
    return
  }

  const event: TerminalReplayTransition = {
    kind,
    data,
    outputSeq,
    runtimeEpoch,
    stateRevision,
    cols,
    rows,
  }
  const decision = record.attachment.classifyTransition(event)
  if (decision.action === 'drop') return
  if (decision.action === 'recover') {
    queueTerminalTransition(record, event)
    record.needsReconnectOutputSync = true
    record.bootstrappingSnapshot = true
    requestTerminalReplay(record)
    return
  }

  if (kind === 'resize') {
    const nextCols = Math.floor(cols!)
    const nextRows = Math.floor(rows!)
    const delivery = acknowledgeTerminalResizeDelivery(record, nextCols, nextRows)
    if (delivery.matched) record.resizeScheduler.clearDeliveryTimeout()
    // Commit every ordered resize, but do not repaint an older echoed size over
    // a newer geometry that this browser has already fitted locally.
    if (
      !delivery.preserveLocalGeometry &&
      (record.terminal.cols !== nextCols || record.terminal.rows !== nextRows)
    ) {
      record.applyingLocalResize = true
      try {
        record.terminal.resize?.(nextCols, nextRows)
      } finally {
        record.applyingLocalResize = false
      }
    }
    record.attachment.commitTransition(event)
    record.resizeScheduler.scheduleRedraw(true)
    if (delivery.next) {
      deliverTerminalResize(record, delivery.next.cols, delivery.next.rows)
    }
    scheduleImeOverlayUpdateIfActive(record)
    flushQueuedTerminalOutput(record)
    notifyTerminalAttachReady(record, record.attachment.generation)
    return
  }

  const transitionData = kind === 'clear' ? '\x1b[2J\x1b[3J\x1b[H' : data
  if (!transitionData) {
    record.attachment.commitTransition(event)
    flushQueuedTerminalOutput(record)
    return
  }

  record.liveWriteInProgress = true
  writeTerminalOutput(record, transitionData, () => {
    if (record.disposed) return
    record.attachment.commitTransition(event)
    if (kind === 'clear') record.terminal.clearTerminalSelection?.()
    record.liveWriteInProgress = false
    if (record.followOutput && !record.hasUnreadOutput) {
      emitFollowOutputState(record)
    }
    scheduleImeOverlayUpdateIfActive(record)
    flushQueuedTerminalOutput(record)
    if (record.hostEl.classList.contains('terminal-checkpoint-installing')) {
      finishTerminalReplay(record, record.attachment.generation)
    } else {
      notifyTerminalAttachReady(record, record.attachment.generation)
    }
  }, { isOutputObserved: () => isTerminalSessionAttached(record) })
}

function handleTerminalStreamOutput(
  record: SessionRecord,
  data: string,
  replace?: boolean,
  outputSeq?: number | null,
  runtimeEpoch = '',
  stateRevision?: number | null,
  cols?: number,
  rows?: number,
  kind: TerminalTransitionKind = 'output',
) {
  if (record.disposed || Date.now() < record.suppressOutputUntil) return

  if (record.pageOutputSuspended || document.visibilityState === 'hidden') {
    record.attachment.clearQueuedTransitions()
    record.attachment.beginRecovery({
      kind,
      data,
      outputSeq,
      runtimeEpoch,
      stateRevision,
      cols,
      rows,
    })
    record.needsReconnectOutputSync = true
    return
  }

  const recoveryActive = record.needsReconnectOutputSync
    || record.bootstrappingSnapshot
    || record.pendingSnapshotReplay
    || record.replayInProgress
    || record.checkpointRequestInFlight
    || record.attachment.recovering

  if (record.liveWriteInProgress && !recoveryActive) {
    queueTerminalTransition(record, {
      kind,
      data,
      outputSeq,
      runtimeEpoch,
      stateRevision,
      cols,
      rows,
    })
    return
  }

  if (recoveryActive) {
    if (replace) {
      applyTerminalOutputEvent(
        record,
        data,
        true,
        outputSeq,
        runtimeEpoch,
        stateRevision,
        cols,
        rows,
        kind,
      )
      return
    }
    queueTerminalTransition(record, {
      kind,
      data,
      outputSeq,
      runtimeEpoch,
      stateRevision,
      cols,
      rows,
    })
    record.bootstrappingSnapshot = true
    requestTerminalReplay(record)
    return
  }

  if (replace) {
    applyTerminalOutputEvent(
      record,
      data,
      true,
      outputSeq,
      runtimeEpoch,
      stateRevision,
      cols,
      rows,
      kind,
    )
    return
  }

  queueTerminalTransition(record, {
    kind,
    data,
    outputSeq,
    runtimeEpoch,
    stateRevision,
    cols,
    rows,
  })
  scheduleLiveTerminalTransitionFlush(record)
}

function scheduleLiveTerminalTransitionFlush(record: SessionRecord) {
  if (record.resizeScheduler.isRedrawPending()) {
    record.resizeScheduler.scheduleRedraw()
    return
  }
  if (record.liveTransitionFlushScheduled) return
  record.liveTransitionFlushScheduled = true
  queueMicrotask(() => {
    record.liveTransitionFlushScheduled = false
    if (!record.disposed) flushQueuedTerminalOutput(record)
  })
}

function queuedTerminalOutputBatch(record: SessionRecord) {
  return record.attachment.queuedOutputBatch()
}

function applyQueuedTerminalOutputBatch(
  record: SessionRecord,
  events: TerminalReplayTransition[],
) {
  for (let index = 0; index < events.length; index += 1) {
    record.attachment.takeQueuedTransition()
  }
  const transitionData = events.map(event => (
    event.kind === 'clear' ? '\x1b[2J\x1b[3J\x1b[H' : event.data
  )).join('')
  record.liveWriteInProgress = true
  writeTerminalOutput(record, transitionData, () => {
    if (record.disposed) return
    events.forEach(event => record.attachment.commitTransition(event))
    if (events.some(event => event.kind === 'clear')) {
      record.terminal.clearTerminalSelection?.()
    }
    record.liveWriteInProgress = false
    if (record.followOutput && !record.hasUnreadOutput) {
      emitFollowOutputState(record)
    }
    scheduleImeOverlayUpdateIfActive(record)
    flushQueuedTerminalOutput(record)
    notifyTerminalAttachReady(record, record.attachment.generation)
  }, { isOutputObserved: () => isTerminalSessionAttached(record) })
}

function flushQueuedTerminalOutput(record: SessionRecord) {
  if (
    record.disposed ||
    record.bootstrappingSnapshot ||
    record.pendingSnapshotReplay ||
    record.replayInProgress ||
    record.checkpointRequestInFlight ||
    record.liveWriteInProgress ||
    record.resizeScheduler.isRedrawPending()
  ) return

  while (
    !record.bootstrappingSnapshot &&
    !record.replayInProgress &&
    !record.checkpointRequestInFlight &&
    !record.liveWriteInProgress &&
    !record.resizeScheduler.isRedrawPending()
  ) {
    const outputBatch = queuedTerminalOutputBatch(record)
    if (outputBatch) {
      applyQueuedTerminalOutputBatch(record, outputBatch)
      continue
    }
    const event = record.attachment.takeQueuedTransition()
    if (!event) break
    applyTerminalOutputEvent(
      record,
      event.data || '',
      false,
      event.outputSeq,
      event.runtimeEpoch,
      event.stateRevision,
      event.cols,
      event.rows,
      event.kind,
    )
  }
}
function getTerminalCellMetrics(record: SessionRecord) {
  return record.terminal.getCellMetrics?.() ?? record.terminal.renderer?.getMetrics?.()
}

function getTerminalScreenRect(record: SessionRecord) {
  const screen = record.terminal.getScreenElement?.()
  if (screen instanceof HTMLElement) {
    return screen.getBoundingClientRect()
  }

  const canvas = record.terminal.renderer?.getCanvas?.() || record.hostEl.querySelector('canvas')
  return canvas instanceof HTMLCanvasElement ? canvas.getBoundingClientRect() : null
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

function clearPendingTerminalOutput(record: SessionRecord) {
  record.attachment.clearQueuedTransitions()
  record.bootstrappingSnapshot = false
  record.pendingSnapshotReplay = false
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

function scheduleImeOverlayUpdateIfActive(record: SessionRecord) {
  if (!record.imeComposing) return
  requestAnimationFrame(() => {
    if (!record.disposed && record.imeComposing) {
      updateTerminalImeOverlay(record.hostEl, record.terminal)
    }
  })
}

function shouldSuppressRendererCursor(record: SessionRecord) {
  if (isXtermTerminal(record.terminal)) return false
  return record.imeComposing || record.suppressRendererCursor
}

function applyRendererCursorPolicy(record: SessionRecord, forceFullRedraw = true) {
  const renderer = record.terminal.renderer
  if (record.disposed) return

  record.hostEl.classList.toggle('terminal-renderer-cursor-suppressed', shouldSuppressRendererCursor(record))

  if (!renderer) {
    if (forceFullRedraw) {
      forceTerminalRender(record)
    }
    return
  }

  if (shouldSuppressRendererCursor(record)) {
    renderer.cursorVisible = false
  } else if (!record.imeComposing && record.rendererCursorWasVisible !== undefined) {
    renderer.cursorVisible = record.rendererCursorWasVisible
    record.rendererCursorWasVisible = undefined
  }

  if (forceFullRedraw) {
    forceTerminalRender(record)
  }
}

function updateRendererCursorSuppression(record: SessionRecord, suppressed: boolean) {
  if (record.suppressRendererCursor === suppressed) {
    record.hostEl.classList.toggle('terminal-renderer-cursor-suppressed', shouldSuppressRendererCursor(record))
    return
  }
  record.suppressRendererCursor = suppressed
  applyRendererCursorPolicy(record)
}

function setRendererCursorSuppressedForIme(record: SessionRecord, suppressed: boolean) {
  const renderer = record.terminal.renderer
  if (record.disposed || !renderer) return

  if (suppressed) {
    if (!record.imeComposing) {
      record.rendererCursorWasVisible = renderer.cursorVisible === undefined
        ? undefined
        : Boolean(renderer.cursorVisible)
    }
    record.imeComposing = true
    applyRendererCursorPolicy(record)
    return
  }

  if (!record.imeComposing) return
  record.imeComposing = false
  if (record.suppressRendererCursor) {
    renderer.cursorVisible = false
    forceTerminalRender(record)
    return
  }
  renderer.cursorVisible = record.rendererCursorWasVisible ?? true
  record.rendererCursorWasVisible = undefined
  forceTerminalRender(record)
}

function installImeAwareRenderer(record: SessionRecord) {
  const renderer = record.terminal.renderer
  if (!renderer?.render || record.originalRender) return

  const originalRender = renderer.render.bind(renderer)
  record.originalRender = originalRender
  renderer.render = (wasmTerm, forceFullRedraw, viewportY, terminal, scrollbarOpacity) => {
    const stableScrollbarOpacity = stableTerminalScrollbarOpacity(scrollbarOpacity)
    if (record.suspendRendering) {
      return
    }

    if (!shouldSuppressRendererCursor(record)) {
      originalRender(wasmTerm, forceFullRedraw, viewportY, terminal, stableScrollbarOpacity)
      return
    }

    renderer.cursorVisible = false
    originalRender(wasmTerm, true, viewportY, terminal, stableScrollbarOpacity)
    renderer.cursorVisible = false
  }
}

function setupTerminalImeOverlay(record: SessionRecord) {
  if (isXtermTerminal(record.terminal)) return

  const input = record.hostEl.querySelector('textarea')
  if (!(input instanceof HTMLTextAreaElement)) return

  const sync = () => {
    if (!record.disposed) {
      updateTerminalImeOverlay(record.hostEl, record.terminal)
    }
  }
  const rafSync = () => requestAnimationFrame(sync)
  const rafSyncIfComposing = () => {
    if (record.imeComposing) rafSync()
  }
  const activateComposition = () => {
    sync()
    record.hostEl.classList.add('terminal-ime-active')
    input.classList.add('terminal-ime-composing')
    setRendererCursorSuppressedForIme(record, true)
  }
  const finishComposition = () => {
    setRendererCursorSuppressedForIme(record, false)
    requestAnimationFrame(() => {
      record.hostEl.classList.remove('terminal-ime-active')
      input.classList.remove('terminal-ime-composing')
      input.value = ''
      sync()
    })
  }
  const cancelComposition = () => {
    setRendererCursorSuppressedForIme(record, false)
    record.hostEl.classList.remove('terminal-ime-active')
    input.classList.remove('terminal-ime-composing')
  }

  const handleImeKeydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) {
      activateComposition()
    }
  }

  input.addEventListener('focus', sync)
  record.hostEl.addEventListener('keydown', handleImeKeydown, true)
  record.hostEl.addEventListener('compositionstart', activateComposition, true)
  record.hostEl.addEventListener('compositionupdate', sync, true)
  record.hostEl.addEventListener('compositionend', finishComposition, true)
  input.addEventListener('input', rafSyncIfComposing)
  input.addEventListener('blur', cancelComposition)
  record.imeKeydownHandler = handleImeKeydown

  const cursorMoveSubscription = record.terminal.onCursorMove?.(rafSyncIfComposing)
  const keySubscription = record.terminal.onKey?.(rafSyncIfComposing)

  record.imeOverlayDisposables.push(
    () => input.removeEventListener('focus', sync),
    () => record.hostEl.removeEventListener('keydown', handleImeKeydown, true),
    () => record.hostEl.removeEventListener('compositionstart', activateComposition, true),
    () => record.hostEl.removeEventListener('compositionupdate', sync, true),
    () => record.hostEl.removeEventListener('compositionend', finishComposition, true),
    () => input.removeEventListener('input', rafSyncIfComposing),
    () => input.removeEventListener('blur', cancelComposition),
    cancelComposition,
  )
  if (cursorMoveSubscription) {
    record.imeOverlayDisposables.push(() => cursorMoveSubscription.dispose())
  }
  if (keySubscription) {
    record.imeOverlayDisposables.push(() => keySubscription.dispose())
  }

  sync()
}

function focusTerminalInputWhenReady(
  record: SessionRecord,
  generation: number,
  attemptsRemaining = 12,
) {
  if (!isCurrentAttachment(record, generation)) return
  if (!shouldAllowTerminalAutoFocus(record.hostEl)) return
  if (record.replayInProgress || record.bootstrappingSnapshot || record.pendingSnapshotReplay) {
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
  const delivered = sendTerminalSessionMessage({
    type: 'input',
    agentId: record.agentId,
    ...(Array.isArray(input) ? { inputParts: input } : { input }),
  })
  if (!delivered) return false
  record.fixtureOverrideActive = false
  record.inputCount += 1
  record.contextMenuSelection = ''
  record.lastNonEmptySelection = ''
  return true
}

function syncTerminalSize(
  record: SessionRecord,
  options: { force?: boolean } = {},
) {
  try {
    const dimensions = proposeTerminalResizeDimensions(record.hostEl, record.fitAddon)
    if (!dimensions) return
    const current = {
      cols: record.terminal.cols || dimensions.cols,
      rows: record.terminal.rows || dimensions.rows,
    }
    if (
      current.cols === dimensions.cols &&
      current.rows === dimensions.rows
    ) {
      record.resizeScheduler.clearFit()
      return
    }
    if (
      !options.force &&
      record.lastNotifiedResize?.cols === dimensions.cols &&
      record.lastNotifiedResize.rows === dimensions.rows
    ) {
      // The authoritative PTY geometry may have been changed by another
      // viewer. Do not interpret that remote transition as a new change in
      // this browser's unchanged layout and echo the old local size back.
      record.resizeScheduler.clearFit()
      return
    }

    if (record.replayInProgress || record.bootstrappingSnapshot) {
      // A genuine attach/layout change that occurs behind the checkpoint
      // barrier still needs one immediate resize after the exact cut lands.
      record.resizeAfterReplayRequired = true
      record.resizeScheduler.clearFit()
      return
    }

    if (shouldDebounceTerminalResize(
      current,
      dimensions,
      options,
    )) {
      record.resizeScheduler.scheduleFit(dimensions)
      return
    }

    record.resizeScheduler.clearFit()
    notifyTerminalResize(record, dimensions.cols, dimensions.rows, options)
  } catch {
    // ignore transient hidden / zero-size states
  }
}

function deliverTerminalResize(record: SessionRecord, cols: number, rows: number) {
  if (
    !isTerminalSessionAttached(record) ||
    record.replayInProgress ||
    record.bootstrappingSnapshot ||
    record.pageOutputSuspended
  ) return false

  const hadInFlightResize = record.resizeRequestInFlight !== null
  const delivered = queueTerminalResizeDelivery(record, cols, rows, (nextCols, nextRows) => (
    sendTerminalSessionMessage({
      type: 'resize-agent',
      agentId: record.agentId,
      cols: nextCols,
      rows: nextRows,
    })
  ))
  if (delivered && !hadInFlightResize && record.resizeRequestInFlight) {
    record.resizeScheduler.scheduleDeliveryTimeout()
  }
  return delivered
}

function notifyTerminalResize(
  record: SessionRecord,
  cols: number,
  rows: number,
  options: { force?: boolean } = {},
) {
  if (
    !isTerminalSessionAttached(record) ||
    record.replayInProgress ||
    record.bootstrappingSnapshot
  ) return
  notifyTerminalResizeTracker(record, cols, rows, (nextCols, nextRows) => {
    if (typeof record.terminal.resize !== 'function') return false
    if (record.terminal.cols !== nextCols || record.terminal.rows !== nextRows) {
      record.applyingLocalResize = true
      try {
        record.terminal.resize(nextCols, nextRows)
      } finally {
        record.applyingLocalResize = false
      }
    }
    return deliverTerminalResize(record, nextCols, nextRows)
  }, options)
}

function resyncTerminalSizeAfterBackendReconnect(record: SessionRecord) {
  if (record.resizeRequestInFlight || record.pendingResizeRequest) {
    record.resizeAfterReplayRequired = true
  }
  resetTerminalResizeDelivery(record)
  record.attachment.resetRecovery()
  record.attachment.beginRecovery()
  record.needsReconnectOutputSync = true
  if (record.disposed || record.pageOutputSuspended) return
  if (!record.attachedMount || record.hostEl.parentElement !== record.attachedMount) return
  invalidateTerminalCheckpointRequest(record)
  requestTerminalReplay(record, record.attachment.generation)
}

function resyncTerminalAfterPageResume(record: SessionRecord) {
  resetTerminalResizeTracker(record)
  record.resizeAfterReplayRequired = true
  resetTerminalResizeDelivery(record)
  record.attachment.resetRecovery()
  record.attachment.beginRecovery()
  record.needsReconnectOutputSync = true
  if (record.disposed || record.pageOutputSuspended) return
  if (!record.attachedMount || record.hostEl.parentElement !== record.attachedMount) return
  invalidateTerminalCheckpointRequest(record)
  requestTerminalReplay(record, record.attachment.generation)
}

type TerminalBuffer = NonNullable<NonNullable<FarmingTerminal['buffer']>['active']>

function getLineLastColumn(line: ReturnType<TerminalBuffer['getLine']>, fallbackCols: number) {
  return Math.max(0, (typeof line?.length === 'number' ? line.length : fallbackCols) - 1)
}

function getCellTextAt(buffer: TerminalBuffer, row: number, col: number) {
  const line = buffer.getLine(row)
  return readCellText(line?.getCell?.(col))
}

function moveLeft(buffer: TerminalBuffer, row: number, col: number, cols: number) {
  if (col > 0) {
    return { row, col: col - 1 }
  }

  const line = buffer.getLine(row)
  if (row <= 0 || !line?.isWrapped) return null

  const previousLine = buffer.getLine(row - 1)
  return { row: row - 1, col: getLineLastColumn(previousLine, cols) }
}

function moveRight(buffer: TerminalBuffer, row: number, col: number, cols: number) {
  const line = buffer.getLine(row)
  const lastCol = getLineLastColumn(line, cols)
  if (col < lastCol) {
    return { row, col: col + 1 }
  }

  const nextRow = row + 1
  const nextLine = buffer.getLine(nextRow)
  if (!nextLine?.isWrapped) return null

  return { row: nextRow, col: 0 }
}

function selectContinuousTextAtCell(record: SessionRecord, col: number, row: number) {
  const buffer = record.terminal.buffer?.active
  const cols = record.terminal.cols || 80
  if (!buffer || typeof buffer.getLine !== 'function' || typeof record.terminal.select !== 'function') {
    return ''
  }

  const bufferRow = getTerminalVisibleBufferBase(record.terminal) + row
  const originText = getCellTextAt(buffer, bufferRow, col)
  if (!isContinuousSelectionText(originText)) {
    return ''
  }

  let start = { row: bufferRow, col }
  for (;;) {
    const previous = moveLeft(buffer, start.row, start.col, cols)
    if (!previous) break
    if (!isContinuousSelectionText(getCellTextAt(buffer, previous.row, previous.col))) break
    start = previous
  }

  // A shell prompt marker immediately adjacent to typed text is presentation,
  // not part of the word the user long-pressed.
  if (/^[#$%>]$/u.test(getCellTextAt(buffer, start.row, start.col))) {
    const afterPrompt = moveRight(buffer, start.row, start.col, cols)
    if (afterPrompt) start = afterPrompt
  }

  let end = { row: bufferRow, col }
  for (;;) {
    const next = moveRight(buffer, end.row, end.col, cols)
    if (!next) break
    if (!isContinuousSelectionText(getCellTextAt(buffer, next.row, next.col))) break
    end = next
  }

  record.terminal.select(start.col, start.row, selectionLength(start, end, cols))
  record.cachedSelection = normalizeTerminalSelection(record.terminal)
  return record.cachedSelection
}

function selectTerminalCellRange(record: SessionRecord, startCell: { col: number; row: number }, endCell: { col: number; row: number }) {
  const buffer = record.terminal.buffer?.active
  const cols = record.terminal.cols || 80
  if (!buffer || typeof record.terminal.select !== 'function') return ''

  const visibleBase = getTerminalVisibleBufferBase(record.terminal)
  const start = {
    row: visibleBase + startCell.row,
    col: startCell.col,
  }
  const end = {
    row: visibleBase + endCell.row,
    col: endCell.col,
  }
  const ordered = start.row < end.row || (start.row === end.row && start.col <= end.col)
    ? { start, end }
    : { start: end, end: start }

  record.terminal.select(
    ordered.start.col,
    ordered.start.row,
    selectionLength(ordered.start, ordered.end, cols),
  )
  record.cachedSelection = normalizeTerminalSelection(record.terminal)
  return record.cachedSelection
}

function selectTerminalBuffer(record: SessionRecord) {
  const buffer = record.terminal.buffer?.active
  const cols = record.terminal.cols || 80
  if (!buffer || typeof buffer.getLine !== 'function' || typeof record.terminal.select !== 'function') {
    return ''
  }
  const rowCount = typeof buffer.length === 'number'
    ? buffer.length
    : getTerminalVisibleBufferBase(record.terminal) + (record.terminal.rows || 1)
  const endRow = Math.max(0, rowCount - 1)
  const endCol = getLineLastColumn(buffer.getLine(endRow), cols)
  record.terminal.select(0, 0, selectionLength({ row: 0, col: 0 }, { row: endRow, col: endCol }, cols))
  record.cachedSelection = normalizeTerminalSelection(record.terminal)
  return record.cachedSelection
}

function cellFromMouseEvent(record: SessionRecord, event: MouseEvent) {
  const metrics = getTerminalCellMetrics(record)
  const rect = getTerminalScreenRect(record)
  if (!metrics || !rect) return null

  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    return null
  }

  const col = Math.max(0, Math.min(
    Math.floor((event.clientX - rect.left) / metrics.width),
    (record.terminal.cols || 1) - 1,
  ))
  const row = Math.max(0, Math.min(
    Math.floor((event.clientY - rect.top) / metrics.height),
    (record.terminal.rows || 1) - 1,
  ))
  return { col, row }
}

function readBufferLineText(buffer: TerminalBuffer, row: number, fallbackCols: number, trimEnd = true) {
  const line = buffer.getLine(row)
  if (!line || typeof line.getCell !== 'function') return ''

  const colCount = Math.max(0, typeof line.length === 'number' ? line.length : fallbackCols)
  let text = ''
  for (let col = 0; col < colCount; col += 1) {
    text += readCellText(line.getCell(col)) || ' '
  }
  return trimEnd ? text.trimEnd() : text
}

function isTerminalPathOpenClick(event: MouseEvent) {
  return event.button === 0 && (event.ctrlKey || event.metaKey)
}

function isTerminalOpenModifierEvent(event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>) {
  return navigator.platform.toLowerCase().includes('mac')
    ? event.metaKey
    : event.ctrlKey
}

function isTerminalOpenModifierActive(record: SessionRecord, event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>) {
  return isTerminalOpenModifierEvent(event) || record.openModifierActive
}

function setTerminalLinkDecorations(
  link: { decorations?: { pointerCursor: boolean; underline: boolean } },
  options: { pointerCursor: boolean; underline: boolean },
) {
  if (!link.decorations) {
    link.decorations = options
    return
  }
  link.decorations.pointerCursor = options.pointerCursor
  link.decorations.underline = options.underline
}

function terminalPathResolveCacheKey(target: TerminalPathOpenTarget) {
  return [
    target.path,
    target.lineNumber ?? '',
    target.column ?? '',
    target.endLineNumber ?? '',
    target.endColumn ?? '',
  ].join('\0')
}

async function resolveTerminalPathTarget(record: SessionRecord, target: TerminalPathOpenTarget) {
  if (!record.pathResolveHandler) return target
  if (target.globalRoot) return target

  const cacheKey = terminalPathResolveCacheKey(target)
  const cached = record.pathResolveCache.get(cacheKey)
  if (cached && Date.now() - cached.resolvedAt <= TERMINAL_PATH_RESOLVE_CACHE_TTL_MS) {
    if (cached.promise) return await cached.promise
    return cached.target
  }

  const promise = Promise.resolve(record.pathResolveHandler(record.agentId, target)).catch(() => null)
  record.pathResolveCache.set(cacheKey, {
    resolvedAt: Date.now(),
    target: null,
    promise,
  })
  const resolved = await promise
  record.pathResolveCache.set(cacheKey, {
    resolvedAt: Date.now(),
    target: resolved,
  })
  return resolved
}

async function resolveTerminalLinkMatches(record: SessionRecord, matches: TerminalLinkMatch[]) {
  if (!record.pathResolveHandler) return matches

  const resolved = await Promise.all(matches.map(async match => {
    if (match.kind !== 'path' || !match.pathTarget) return match
    const resolvedTarget = await resolveTerminalPathTarget(record, match.pathTarget)
    return resolvedTarget ? { ...match, pathTarget: resolvedTarget } : null
  }))
  const available = resolved.filter((match): match is TerminalLinkMatch => Boolean(match))
  const preferred: TerminalLinkMatch[] = []
  for (const match of [...available].sort((a, b) => a.length - b.length || a.startIndex - b.startIndex)) {
    if (
      match.kind === 'path'
      && preferred.some(existing => (
        existing.kind === 'path'
        && match.startIndex < existing.startIndex + existing.length
        && existing.startIndex < match.startIndex + match.length
      ))
    ) continue
    preferred.push(match)
  }
  return preferred.sort((a, b) => a.startIndex - b.startIndex)
}

function cachedTerminalPathLink(record: SessionRecord, match: TerminalLinkMatch) {
  if (!record.pathResolveHandler || match.kind !== 'path' || !match.pathTarget) return match

  const cached = record.pathResolveCache.get(terminalPathResolveCacheKey(match.pathTarget))
  if (!cached || cached.promise || Date.now() - cached.resolvedAt > TERMINAL_PATH_RESOLVE_CACHE_TTL_MS) {
    return null
  }
  return cached.target ? { ...match, pathTarget: cached.target } : null
}

function installTerminalLinkProvider(record: SessionRecord) {
  if (!isXtermTerminal(record.terminal) || typeof record.terminal.registerLinkProvider !== 'function') return

  const provider: TerminalLinkProvider = {
    provideLinks: (bufferLineNumber, callback) => {
      if (record.disposed) {
        callback(undefined)
        return
      }
      const attachmentGeneration = record.attachment.generation

      const logicalLine = readLogicalTerminalLineAtBufferRow(record, bufferLineNumber - 1)
      if (!logicalLine?.text) {
        callback(undefined)
        return
      }

      const matches = collectTerminalLinkMatches(
        logicalLine.text,
        Boolean(record.pathOpenHandler),
        Boolean(record.searchOpenHandler),
      )
      if (record.pathOpenHandler) {
        const previousLogicalLines = readPreviousLogicalTerminalLines(record, logicalLine.startRow)
        for (const multiLineMatch of collectTerminalMultiLinePathLinkMatches(
          logicalLine.text,
          previousLogicalLines,
        )) {
          const overlapsHigherPriority = matches.some(match => (
            match.kind !== 'search'
            &&
            multiLineMatch.startIndex < match.startIndex + match.length
            && match.startIndex < multiLineMatch.startIndex + multiLineMatch.length
          ))
          if (overlapsHigherPriority) continue
          for (let index = matches.length - 1; index >= 0; index -= 1) {
            const match = matches[index]
            if (
              match?.kind === 'search'
              && multiLineMatch.startIndex < match.startIndex + match.length
              && match.startIndex < multiLineMatch.startIndex + multiLineMatch.length
            ) {
              matches.splice(index, 1)
            }
          }
          matches.push(multiLineMatch)
        }
        matches.sort((a, b) => a.startIndex - b.startIndex)
      }
      if (matches.length === 0) {
        callback(undefined)
        return
      }

      void (async () => {
        const resolvedMatches = await resolveTerminalLinkMatches(record, matches)
        if (!isCurrentAttachment(record, attachmentGeneration)) {
          callback(undefined)
          return
        }
        if (resolvedMatches.length === 0) {
          callback(undefined)
          return
        }

        const links = resolvedMatches.map(match => {
          const pathDirectOpen = match.kind === 'path' && Boolean(match.pathTarget && record.pathOpenHandler)
          const link = {
            range: terminalLinkMatchRange(match, logicalLine),
            text: match.text,
            decorations: {
              pointerCursor: pathDirectOpen,
              // xterm snapshots the initial decoration state before invoking
              // link.hover, then installs the live decoration setters. Keep
              // URLs underlined in that initial state so the first hover is
              // visibly recognized; the modifier still gates activation and
              // the pointer cursor.
              underline: pathDirectOpen || match.kind === 'url',
            },
            activate: (event: MouseEvent) => {
              if (event.button !== 0) return
              if (Date.now() < record.suppressClickUntil) return
              if (!isCurrentAttachment(record, attachmentGeneration)) return
              const modifierActive = isTerminalOpenModifierActive(record, event)
              if (match.kind === 'url' && findTerminalUrlAtMouseEvent(record, event) !== match.text) return
              if (
                match.kind === 'path'
                && !readTerminalPathLinksAtMouseEvent(record, event).some(pathLink => pathLink.text === match.text)
              ) return
              if (match.kind === 'search' && findTerminalSearchAtMouseEvent(record, event) !== match.text) return
              if (match.kind === 'url' && !modifierActive) return
              if (match.kind === 'search' && !modifierActive) return
              if (match.kind === 'path' && !pathDirectOpen) return

              event.preventDefault()
              event.stopPropagation()
              event.stopImmediatePropagation()
              if (match.kind === 'url') {
                openTerminalUrl(record, match.text)
              } else if (match.kind === 'search') {
                record.searchOpenHandler?.(record.agentId, match.text)
              } else if (match.pathTarget && record.pathOpenHandler) {
                record.pathOpenHandler(record.agentId, match.pathTarget)
              }
              record.suppressClickUntil = Date.now() + 250
            },
            hover: (event: MouseEvent) => {
              if (!shouldHandleTerminalHoverEvent(record) || isMobileViewport()) return
              record.linkProviderHoverTarget = {
                kind: match.kind,
                text: match.text,
                ...(match.pathTarget ? { pathTarget: match.pathTarget } : {}),
              }
              record.lastLinkHoverEvent = event
              const active = pathDirectOpen || isTerminalOpenModifierActive(record, event)
              setTerminalLinkDecorations(link, {
                pointerCursor: active,
                underline: pathDirectOpen || match.kind === 'url' || active,
              })
              refreshTerminalLinkHoverTarget(record, active)
            },
            leave: () => {
              if (record.linkProviderHoverTarget?.text === match.text) {
                record.linkProviderHoverTarget = null
              }
              setTerminalLinkDecorations(link, {
                pointerCursor: pathDirectOpen,
                underline: pathDirectOpen || match.kind === 'url',
              })
              clearTerminalOpenTargetState(record)
            },
            dispose: () => {
              if (record.linkProviderHoverTarget?.text === match.text) {
                record.linkProviderHoverTarget = null
              }
            },
          }
          return link
        })
        callback(links)
      })()
    },
  }

  const disposable = record.terminal.registerLinkProvider(provider)
  record.linkProviderDisposable = () => disposable.dispose()
}

function readLogicalTerminalLineAtCellWithRows(record: SessionRecord, cell: { col: number; row: number }): TerminalLogicalLine | null {
  const buffer = record.terminal.buffer?.active
  if (!cell || !buffer || typeof buffer.getLine !== 'function') return null

  const bufferRow = getTerminalVisibleBufferBase(record.terminal) + cell.row
  const cols = record.terminal.cols || 80
  let logicalStartRow = bufferRow
  while (logicalStartRow > 0 && buffer.getLine(logicalStartRow)?.isWrapped) {
    logicalStartRow -= 1
  }

  let logicalEndRow = bufferRow
  while (buffer.getLine(logicalEndRow + 1)?.isWrapped) {
    logicalEndRow += 1
  }

  const lineSegments: string[] = []
  for (let row = logicalStartRow; row <= logicalEndRow; row += 1) {
    lineSegments.push(readBufferLineText(buffer, row, cols, row === logicalEndRow))
  }

  const logicalCol = ((bufferRow - logicalStartRow) * cols) + cell.col
  return {
    text: lineSegments.join('').trimEnd(),
    col: logicalCol,
    startRow: logicalStartRow,
    endRow: logicalEndRow,
    bufferRow,
    cols,
    buffer,
  }
}

function readLogicalTerminalLineAtBufferRow(record: SessionRecord, bufferRow: number): TerminalLogicalLine | null {
  const buffer = record.terminal.buffer?.active
  if (!buffer || typeof buffer.getLine !== 'function') return null
  if (!Number.isFinite(bufferRow) || bufferRow < 0) return null

  const cols = record.terminal.cols || 80
  let logicalStartRow = bufferRow
  while (logicalStartRow > 0 && buffer.getLine(logicalStartRow)?.isWrapped) {
    logicalStartRow -= 1
  }

  let logicalEndRow = bufferRow
  while (buffer.getLine(logicalEndRow + 1)?.isWrapped) {
    logicalEndRow += 1
  }

  const lineSegments: string[] = []
  for (let row = logicalStartRow; row <= logicalEndRow; row += 1) {
    lineSegments.push(readBufferLineText(buffer, row, cols, row === logicalEndRow))
  }

  return {
    text: lineSegments.join('').trimEnd(),
    col: 0,
    startRow: logicalStartRow,
    endRow: logicalEndRow,
    bufferRow,
    cols,
    buffer,
  }
}

function readPreviousLogicalTerminalLines(
  record: SessionRecord,
  beforeBufferRow: number,
  limit = 100,
) {
  const lines: string[] = []
  let row = beforeBufferRow - 1
  while (row >= 0 && lines.length < limit) {
    const logicalLine = readLogicalTerminalLineAtBufferRow(record, row)
    if (!logicalLine) break
    lines.push(logicalLine.text)
    row = logicalLine.startRow - 1
  }
  return lines
}

function readTerminalPathLinksAtCell(
  record: SessionRecord,
  cell: { col: number; row: number },
) {
  const logicalLine = readLogicalTerminalLineAtCellWithRows(record, cell)
  if (!logicalLine) return []
  // URL-shaped text is owned by the URL interaction. Treating its path
  // portion as a workspace path makes a plain click start file resolution and
  // briefly suppresses the modifier-click that should open the URL.
  if (parseExplicitTerminalUrlAtColumn(logicalLine.text, logicalLine.col)) return []
  const directLinks = collectTerminalPathLinkMatches(logicalLine.text).filter(match => (
    logicalLine.col >= match.startIndex
    && logicalLine.col < match.startIndex + match.length
  ))
  if (directLinks.length > 0) return directLinks
  return collectTerminalMultiLinePathLinkMatches(
    logicalLine.text,
    readPreviousLogicalTerminalLines(record, logicalLine.startRow),
  ).filter(match => (
    logicalLine.col >= match.startIndex
    && logicalLine.col < match.startIndex + match.length
  ))
}

function readTerminalPathLinkAtCell(
  record: SessionRecord,
  cell: { col: number; row: number },
) {
  return readTerminalPathLinksAtCell(record, cell)[0] ?? null
}

const TERMINAL_READING_ANCHOR_LINE_COUNT = 3

function captureTerminalReadingAnchor(record: SessionRecord): Extract<ReadingAnchor, { surface: 'terminal' }> | null {
  const key = readingAnchorAgentKey(record.agentId, 'terminal')
  if (record.followOutput) {
    clearReadingAnchor(key)
    return null
  }
  const visibleBufferRow = getTerminalVisibleBufferBase(record.terminal)
  const firstLine = readLogicalTerminalLineAtBufferRow(record, visibleBufferRow)
  if (!firstLine) return null

  const lines: string[] = []
  let nextRow = firstLine.startRow
  for (let index = 0; index < TERMINAL_READING_ANCHOR_LINE_COUNT; index += 1) {
    const line = readLogicalTerminalLineAtBufferRow(record, nextRow)
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
    const firstLine = readLogicalTerminalLineAtBufferRow(record, bufferRow)
    if (!firstLine) {
      bufferRow += 1
      continue
    }
    const lines = [firstLine.text]
    let nextRow = firstLine.endRow + 1
    for (let index = 1; index < lineCount; index += 1) {
      const line = readLogicalTerminalLineAtBufferRow(record, nextRow)
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

function readLogicalTerminalLineAtCell(record: SessionRecord, cell: { col: number; row: number }) {
  const logicalLine = readLogicalTerminalLineAtCellWithRows(record, cell)
  return logicalLine
    ? { text: logicalLine.text, col: logicalLine.col }
    : null
}

function readDomTerminalLineAtMouseEvent(record: SessionRecord, event: MouseEvent) {
  const target = document.elementFromPoint(event.clientX, event.clientY)
  if (!(target instanceof HTMLElement)) return null

  const row = target.closest<HTMLElement>('.xterm-rows > div')
  if (!row || !record.hostEl.contains(row)) return null

  const metrics = getTerminalCellMetrics(record)
  const rowRect = row.getBoundingClientRect()
  if (!metrics || metrics.width <= 0 || rowRect.width <= 0) return null

  const text = (row.textContent || '').trimEnd()
  if (!text) return null

  const col = terminalTextColumnAtPixelOffset(event.clientX - rowRect.left, metrics.width, text.length)
  if (col === null) return null
  return { text, col }
}

function readTerminalUrlLineAtCell(record: SessionRecord, cell: { col: number; row: number }) {
  return readLogicalTerminalLineAtCell(record, cell)
}

function readTerminalPathLinksAtMouseEvent(record: SessionRecord, event: MouseEvent | PointerEvent) {
  const cell = cellFromMouseEvent(record, event)
  if (cell) {
    const pathLinks = readTerminalPathLinksAtCell(record, cell)
    if (pathLinks.length > 0) return pathLinks
  }

  const domLine = readDomTerminalLineAtMouseEvent(record, event)
  if (!domLine || parseExplicitTerminalUrlAtColumn(domLine.text, domLine.col)) return []
  return collectTerminalPathLinkMatches(domLine.text).filter(match => (
    domLine.col >= match.startIndex
    && domLine.col < match.startIndex + match.length
  ))
}

function readTerminalPathLinkAtMouseEvent(record: SessionRecord, event: MouseEvent | PointerEvent) {
  return readTerminalPathLinksAtMouseEvent(record, event)[0] ?? null
}

function findTerminalPathLinkAtMouseEvent(record: SessionRecord, event: MouseEvent) {
  for (const pathLink of readTerminalPathLinksAtMouseEvent(record, event)) {
    const cached = cachedTerminalPathLink(record, pathLink)
    if (cached) return cached
  }
  return null
}

function findTerminalPathTargetAtMouseEvent(record: SessionRecord, event: MouseEvent) {
  return findTerminalPathLinkAtMouseEvent(record, event)?.pathTarget ?? null
}

function findTerminalUrlAtMouseEvent(record: SessionRecord, event: MouseEvent) {
  const cell = cellFromMouseEvent(record, event)
  if (cell) {
    const logicalLine = readTerminalUrlLineAtCell(record, cell)
    const url = logicalLine ? parseTerminalUrlAtColumn(logicalLine.text, logicalLine.col) : null
    if (url) return url
  }

  const domLine = readDomTerminalLineAtMouseEvent(record, event)
  return domLine ? parseTerminalUrlAtColumn(domLine.text, domLine.col) : null
}

function findTerminalSearchAtMouseEvent(record: SessionRecord, event: MouseEvent) {
  if (findTerminalUrlAtMouseEvent(record, event)) return null
  if (record.pathOpenHandler && readTerminalPathLinkAtMouseEvent(record, event)) return null
  const cell = cellFromMouseEvent(record, event)
  if (cell) {
    const logicalLine = readLogicalTerminalLineAtCell(record, cell)
    const query = logicalLine ? parseTerminalSearchAtColumn(logicalLine.text, logicalLine.col) : null
    if (query) return query
  }

  const domLine = readDomTerminalLineAtMouseEvent(record, event)
  return domLine ? parseTerminalSearchAtColumn(domLine.text, domLine.col) : null
}

function getXtermSelectionForCopy(record: SessionRecord) {
  const selection = record.terminal.getSelection() || ''
  return normalizeTerminalSelectionForCopy(selection)
}

function getTerminalSelectionForCopy(record: SessionRecord, options?: {
  includeNativeFallback?: boolean
}) {
  const selection = isXtermTerminal(record.terminal)
    ? getXtermSelectionForCopy(record)
    : normalizeTerminalSelectionForCopy(normalizeTerminalSelection(record.terminal))
  if (selection) return selection

  if (!isXtermTerminal(record.terminal) && options?.includeNativeFallback) {
    return normalizeTerminalSelectionForCopy(getNativeTerminalSelection(record.hostEl))
  }

  return ''
}

function isTerminalEventInsideSelection(record: SessionRecord, event: MouseEvent) {
  const position = record.terminal.getSelectionPosition?.()
  if (!position || !record.terminal.getSelection?.()) return false

  const cell = cellFromMouseEvent(record, event)
  if (!cell) return false

  const { start, end } = orderedSelection(position)
  const point = {
    x: cell.col,
    y: getTerminalVisibleBufferBase(record.terminal) + cell.row,
  }
  if (point.y < start.y || point.y > end.y) return false
  if (point.y === start.y && point.x < start.x) return false
  if (point.y === end.y && point.x > end.x) return false
  return true
}

function getNativeTerminalSelection(hostEl: HTMLElement) {
  const selection = window.getSelection?.()
  if (!selection || selection.isCollapsed) return ''

  const anchorNode = selection.anchorNode
  const focusNode = selection.focusNode
  if (
    (anchorNode && !hostEl.contains(anchorNode)) ||
    (focusNode && !hostEl.contains(focusNode))
  ) {
    return ''
  }

  return selection.toString()
}

function openTerminalUrl(_record: SessionRecord, url: string) {
  openExternalUrl(url)
}

function terminalOpenTargetTitle(kind: 'url' | 'path' | 'search') {
  const isMac = navigator.platform.toLowerCase().includes('mac')
  const modifier = isMac ? 'Cmd' : 'Ctrl'
  const lang = document.documentElement.lang || navigator.language || ''
  if (lang.toLowerCase().startsWith('zh')) {
    if (kind === 'url') return `按住 ${modifier} 点击打开链接`
    if (kind === 'search') return `按住 ${modifier} 点击在工作区中搜索`
    return '点击打开文件或文件夹'
  }
  if (kind === 'url') return `${modifier}-click to open link`
  if (kind === 'search') return `${modifier}-click to search the workspace`
  return 'Click to open file or folder'
}

function setTerminalLinkHoverTarget(record: SessionRecord, kind: 'url' | 'path' | 'search' | null) {
  record.hostEl.classList.toggle('terminal-open-target-hover', kind !== null)
  record.hostEl.classList.toggle('terminal-open-target-url', kind === 'url')
  record.hostEl.classList.toggle('terminal-open-target-path', kind === 'path')
  record.hostEl.classList.toggle('terminal-open-target-search', kind === 'search')
  if (kind) {
    record.hostEl.dataset.terminalOpenTarget = kind
    record.hostEl.title = terminalOpenTargetTitle(kind)
  } else {
    delete record.hostEl.dataset.terminalOpenTarget
    record.hostEl.removeAttribute('title')
  }
}

function clearTerminalOpenTargetState(record: SessionRecord) {
  record.openModifierActive = false
  record.lastLinkHoverEvent = null
  record.linkProviderHoverTarget = null
  setTerminalLinkHoverTarget(record, null)
}

function terminalOpenTargetKindAtMouseEvent(
  record: SessionRecord,
  event: MouseEvent | PointerEvent,
  modifierActive = isTerminalOpenModifierActive(record, event),
) {
  if (record.pathOpenHandler && findTerminalPathTargetAtMouseEvent(record, event)) return 'path'
  if (!modifierActive) return null
  if (findTerminalUrlAtMouseEvent(record, event)) return 'url'
  if (record.searchOpenHandler && findTerminalSearchAtMouseEvent(record, event)) return 'search'
  return null
}

async function resolveTerminalPathLinkAtMouseEvent(record: SessionRecord, event: MouseEvent | PointerEvent) {
  if (!record.pathOpenHandler) return null
  for (const pathLink of readTerminalPathLinksAtMouseEvent(record, event)) {
    if (!pathLink.pathTarget) continue
    const resolvedTarget = await resolveTerminalPathTarget(record, pathLink.pathTarget)
    if (resolvedTarget) return { ...pathLink, pathTarget: resolvedTarget }
  }
  return null
}

function refreshTerminalLinkHoverTarget(record: SessionRecord, modifierActive?: boolean) {
  if (!shouldHandleTerminalHoverEvent(record) || isMobileViewport()) {
    setTerminalLinkHoverTarget(record, null)
    return
  }

  const providerTarget = record.linkProviderHoverTarget
  const active = modifierActive ?? record.openModifierActive
  if (providerTarget) {
    setTerminalLinkHoverTarget(record, providerTarget.kind === 'path' || active ? providerTarget.kind : null)
    return
  }

  if (!record.lastLinkHoverEvent) {
    setTerminalLinkHoverTarget(record, null)
    return
  }

  setTerminalLinkHoverTarget(record, terminalOpenTargetKindAtMouseEvent(record, record.lastLinkHoverEvent, active))
}

function hideTerminalContextMenu(record: SessionRecord) {
  record.contextMenuCleanup?.()
  record.contextMenuCleanup = null
  record.contextMenuEl?.remove()
  record.contextMenuEl = null
  record.contextMenuSelection = ''
}

function terminalContextMenuLabel(action: 'copy' | 'paste' | 'selectAll' | 'clear') {
  const lang = document.documentElement.lang || navigator.language || ''
  const zh = lang.toLowerCase().startsWith('zh')
  if (action === 'copy') return zh ? '复制' : 'Copy'
  if (action === 'paste') return zh ? '粘贴' : 'Paste'
  if (action === 'clear') return zh ? '清除' : 'Clear'
  return zh ? '全选' : 'Select All'
}

function clampContextMenuPosition(x: number, y: number, width = 160, height = 148) {
  const margin = 8
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  }
}

function focusTerminalContextMenu(menu: HTMLElement) {
  const firstEnabled = menu.querySelector<HTMLButtonElement>('button:not(:disabled)')
  firstEnabled?.focus()
}

function isKeyboardContextMenuEvent(event: MouseEvent) {
  return event.button === 0 && !('pointerType' in event)
}

function createTerminalContextMenuItem(
  label: string,
  onClick: () => void,
  options: { disabled?: boolean } = {},
) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'terminal-context-menu-item'
  button.setAttribute('role', 'menuitem')
  button.textContent = label
  button.disabled = options.disabled === true
  button.addEventListener('click', () => {
    if (button.disabled) return
    onClick()
  })
  return button
}

function pasteTerminalClipboardText(record: SessionRecord, text: string) {
  if (!text || record.disposed || record.attachedMount === null) return false
  scrollRecordToBottom(record, { allowClearUnread: true })
  if (!queueTerminalInput(record, text)) return false
  return true
}

function clearTerminalBuffer(record: SessionRecord) {
  if (record.disposed || record.attachedMount === null) return
  clearTerminalSelectionState(record)
  record.contextMenuSelection = ''
  record.lastNonEmptySelection = ''
  record.terminal.clearSearch?.()
  setFollowOutputState(record, true, false, { allowClearUnread: true })
  sendTerminalSessionMessage({
    type: 'clear-terminal',
    agentId: record.agentId,
  })
}

function showTerminalContextMenu(record: SessionRecord, event: MouseEvent, selection: string) {
  hideTerminalContextMenu(record)
  const focusFirstItem = isKeyboardContextMenuEvent(event)

  const position = clampContextMenuPosition(event.clientX, event.clientY)
  const menu = document.createElement('div')
  menu.className = 'terminal-context-menu terminal-context-menu-pooled'
  menu.setAttribute('data-testid', 'code-terminal-context-menu')
  menu.setAttribute('role', 'menu')
  menu.style.left = `${position.x}px`
  menu.style.top = `${position.y}px`

  const copyButton = createTerminalContextMenuItem(terminalContextMenuLabel('copy'), () => {
    const focusRevision = terminalFocusRevision
    writeClipboardText(selection).finally(() => {
      const restoreFocus = mayRestoreTerminalFocusAfterAsyncMenu(record, menu, focusRevision)
      hideTerminalContextMenu(record)
      if (!isMobileViewport() && restoreFocus) {
        focusAttachedTerminalInput(record)
      }
    })
  }, { disabled: !selection })

  const pasteButton = createTerminalContextMenuItem(terminalContextMenuLabel('paste'), () => {
    const focusRevision = terminalFocusRevision
    void readClipboardText().then(text => {
      pasteTerminalClipboardText(record, text)
    }).finally(() => {
      const restoreFocus = mayRestoreTerminalFocusAfterAsyncMenu(record, menu, focusRevision)
      hideTerminalContextMenu(record)
      if (!isMobileViewport() && restoreFocus) {
        focusAttachedTerminalInput(record)
      }
    })
  })

  const selectAllButton = createTerminalContextMenuItem(terminalContextMenuLabel('selectAll'), () => {
    hideTerminalContextMenu(record)
    clearTerminalSelectionState(record)
    requestAnimationFrame(() => {
      if (record.disposed) return
      const selection = selectTerminalBuffer(record)
      record.contextMenuSelection = selection
      record.lastNonEmptySelection = selection || record.lastNonEmptySelection
      if (!isMobileViewport()) {
        focusAttachedTerminalInput(record)
      }
    })
  }, { disabled: typeof record.terminal.select !== 'function' || !record.terminal.buffer?.active })

  const clearButton = createTerminalContextMenuItem(terminalContextMenuLabel('clear'), () => {
    hideTerminalContextMenu(record)
    clearTerminalBuffer(record)
    if (!isMobileViewport()) {
      focusAttachedTerminalInput(record)
    }
  })

  menu.addEventListener('mousedown', event => event.stopPropagation())
  menu.addEventListener('pointerdown', event => event.stopPropagation())
  menu.addEventListener('keydown', event => {
    if (!(event.target instanceof HTMLButtonElement)) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const index = items.indexOf(event.target)
    if (index < 0 || items.length === 0) return
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    items[(index + direction + items.length) % items.length]?.focus()
  })
  menu.appendChild(copyButton)
  menu.appendChild(pasteButton)
  menu.appendChild(selectAllButton)
  menu.appendChild(clearButton)
  document.body.appendChild(menu)
  record.contextMenuEl = menu

  const closeOnOutsidePointer = (pointerEvent: MouseEvent | PointerEvent) => {
    const target = pointerEvent.target
    if (target instanceof Node && menu.contains(target)) return
    hideTerminalContextMenu(record)
  }
  const closeOnKeydown = (keyboardEvent: KeyboardEvent) => {
    if (keyboardEvent.key === 'Escape') {
      keyboardEvent.preventDefault()
      hideTerminalContextMenu(record)
      if (!isMobileViewport()) {
        focusAttachedTerminalInput(record)
      }
    }
  }
  const closeOnScrollOrResize = () => hideTerminalContextMenu(record)

  document.addEventListener('mousedown', closeOnOutsidePointer, true)
  document.addEventListener('pointerdown', closeOnOutsidePointer, true)
  document.addEventListener('keydown', closeOnKeydown, true)
  window.addEventListener('resize', closeOnScrollOrResize)
  window.addEventListener('scroll', closeOnScrollOrResize, true)
  record.contextMenuCleanup = () => {
    document.removeEventListener('mousedown', closeOnOutsidePointer, true)
    document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
    document.removeEventListener('keydown', closeOnKeydown, true)
    window.removeEventListener('resize', closeOnScrollOrResize)
    window.removeEventListener('scroll', closeOnScrollOrResize, true)
  }

  if (focusFirstItem) requestAnimationFrame(() => focusTerminalContextMenu(menu))
}

function clearNativeSelectionInside(hostEl: HTMLElement) {
  const selection = window.getSelection?.()
  if (!selection || selection.rangeCount === 0) return

  const anchorNode = selection.anchorNode
  const focusNode = selection.focusNode
  if (
    (anchorNode && !hostEl.contains(anchorNode)) ||
    (focusNode && !hostEl.contains(focusNode))
  ) {
    return
  }

  selection.removeAllRanges()
}

function clearTerminalSelectionState(record: SessionRecord) {
  record.cachedSelection = ''
  record.contextMenuSelection = ''
  record.lastNonEmptySelection = ''
  record.dragSelection = null
  record.terminal.clearTerminalSelection?.()
  clearNativeSelectionInside(record.hostEl)
}

function resetTransientTerminalUi(record: SessionRecord) {
  hideTerminalContextMenu(record)
  clearTerminalOpenTargetState(record)
  clearTerminalSelectionState(record)
}

function repairTerminalAfterAttach(record: SessionRecord) {
  resetTransientTerminalUi(record)

  if (isXtermTerminal(record.terminal)) {
    record.terminal.reattach?.()
    record.terminal.syncAppearanceTheme?.()
    record.terminal.forceRedraw?.()
  }

  scheduleTerminalRepaint(record)
  requestAnimationFrame(() => {
    if (record.disposed || record.attachedMount === null) return
    if (isXtermTerminal(record.terminal)) {
      record.terminal.forceRedraw?.()
    }
    forceTerminalRender(record)
  })
}

function getTerminalCopyTextAtEvent(record: SessionRecord, event: MouseEvent) {
  const selection = getTerminalSelectionForCopy(record) ||
    record.contextMenuSelection ||
    record.lastNonEmptySelection

  const url = findTerminalUrlAtMouseEvent(record, event)
  const pathLink = record.pathOpenHandler ? findTerminalPathLinkAtMouseEvent(record, event) : null
  const selectionAtEvent = Boolean(selection) && isTerminalEventInsideSelection(record, event)
  const compactSelection = selection.replace(/\s+/g, '')
  if (url && (!selectionAtEvent || url.includes(compactSelection))) {
    return url
  }
  if (pathLink?.text && (!selectionAtEvent || pathLink.text.includes(compactSelection))) {
    return pathLink.text
  }
  if (selection) return selection

  const cell = cellFromMouseEvent(record, event)
  if (cell) {
    return selectContinuousTextAtCell(record, cell.col, cell.row)
  }

  return ''
}

function installTerminalContextMenu(record: SessionRecord, agentId: string) {
  const contextMenuHandler = (event: MouseEvent) => {
    if (!(event.target instanceof Node) || !record.hostEl.contains(event.target)) return
    const url = findTerminalUrlAtMouseEvent(record, event)
    if (url) {
      showUrlOpenMenu({
        event,
        url,
        onOpenInFarming: record.farmingUrlOpenHandler
          ? () => record.farmingUrlOpenHandler?.(agentId, url)
          : undefined,
      })
      return
    }
    const rawPathLink = record.pathOpenHandler
      ? findTerminalPathLinkAtMouseEvent(record, event) ?? readTerminalPathLinkAtMouseEvent(record, event)
      : null
    if (rawPathLink?.pathTarget) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      void resolveTerminalPathTarget(record, rawPathLink.pathTarget).then(resolvedTarget => {
        if (record.disposed) return
        if (resolvedTarget) {
          showTerminalContextMenu(record, event, rawPathLink.text)
          return
        }
        const fallbackCopyText = getTerminalCopyTextAtEvent(record, event)
        showTerminalContextMenu(record, event, fallbackCopyText)
      })
      return
    }

    if (record.pathOpenHandler && isTerminalPathOpenClick(event)) {
      const pathTarget = findTerminalPathTargetAtMouseEvent(record, event)
      if (pathTarget) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        record.pathOpenHandler(agentId, pathTarget)
        return
      }
    }

    const copyText = getTerminalCopyTextAtEvent(record, event)

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    showTerminalContextMenu(record, event, copyText)
  }
  const contextMenuMouseDownHandler = (event: MouseEvent) => {
    if (!(event.target instanceof Node) || !record.hostEl.contains(event.target)) return
    if (event.button === 0) {
      record.contextMenuSelection = ''
      record.lastNonEmptySelection = ''
      return
    }
    if (event.button !== 2) return
    record.contextMenuSelection = getTerminalSelectionForCopy(record) ||
      normalizeTerminalSelectionForCopy(record.cachedSelection) ||
      record.lastNonEmptySelection
  }
  window.addEventListener('mousedown', contextMenuMouseDownHandler, true)
  window.addEventListener('contextmenu', contextMenuHandler, true)
  record.hostEl.addEventListener('mousedown', contextMenuMouseDownHandler, true)
  record.hostEl.addEventListener('contextmenu', contextMenuHandler, true)
  record.contextMenuMouseDownHandler = contextMenuMouseDownHandler
  record.contextMenuHandler = contextMenuHandler
}

function installTerminalTouchInteraction(record: SessionRecord) {
  let touchPointerId: number | null = null
  let touchStartX = 0
  let touchStartY = 0
  let touchLastY = 0
  let touchLastMoveAt = 0
  let touchVelocityY = 0
  let touchScrollRemainderPx = 0
  let touchMoved = false
  let momentumFrame: number | null = null
  let momentumLastAt = 0
  let touchVelocitySamples: TerminalTouchVelocitySample[] = []
  let touchEdgeOffsetPx = 0
  let touchEdgeResetTimer: number | null = null
  let longPressTimer: number | null = null
  let longPressEvent: PointerEvent | null = null

  const clearLongPress = () => {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer)
      longPressTimer = null
    }
    longPressEvent = null
  }

  const getTouchSurface = () => record.hostEl.querySelector<HTMLElement>('.xterm-screen')

  const clearTouchEdgeResetTimer = () => {
    if (touchEdgeResetTimer !== null) {
      window.clearTimeout(touchEdgeResetTimer)
      touchEdgeResetTimer = null
    }
  }

  const renderTouchEdgeOffset = (offsetPx: number, animate = false) => {
    const surface = getTouchSurface()
    touchEdgeOffsetPx = offsetPx
    if (!surface) return
    clearTouchEdgeResetTimer()
    surface.style.transition = animate
      ? `transform ${TOUCH_EDGE_SPRING_MS}ms cubic-bezier(0.22, 0.75, 0.28, 1)`
      : 'none'
    surface.style.transform = offsetPx === 0 ? '' : `translate3d(0, ${offsetPx}px, 0)`
    if (animate) {
      touchEdgeResetTimer = window.setTimeout(() => {
        surface.style.transition = ''
        surface.style.transform = ''
        touchEdgeResetTimer = null
      }, TOUCH_EDGE_SPRING_MS)
    }
  }

  const pullTouchEdge = (deltaY: number) => {
    const nextOffset = nextTerminalTouchEdgeOffset(touchEdgeOffsetPx, deltaY)
    renderTouchEdgeOffset(nextOffset)
  }

  const releaseTouchEdge = (animate = true) => {
    if (touchEdgeOffsetPx === 0 && touchEdgeResetTimer === null) return
    renderTouchEdgeOffset(0, animate)
  }

  const pushTouchVelocitySample = (y: number, at: number) => {
    touchVelocitySamples = appendTerminalTouchVelocitySample(touchVelocitySamples, { y, at })
  }

  const readTouchGestureVelocity = () => {
    return readTerminalTouchGestureVelocity(touchVelocitySamples, touchVelocityY)
  }

  const handleLongPress = () => {
    const event = longPressEvent
    clearLongPress()
    if (!event || record.disposed || touchMoved) return

    const copyText = getTerminalCopyTextAtEvent(record, event)
    if (!copyText) return

    showTerminalContextMenu(record, event, copyText)
  }

  const scrollByTouchDelta = (deltaY: number) => {
    const lineHeight = Math.max(8, getTerminalCellMetrics(record)?.height || 16)
    const scrollDelta = consumeTerminalTouchScrollDelta(touchScrollRemainderPx, deltaY, lineHeight)
    touchScrollRemainderPx = scrollDelta.remainderPx
    const { lineDelta } = scrollDelta
    if (lineDelta === 0) return false

    const previousViewportY = getTerminalViewportY(record.terminal)
    scrollRecordToViewportY(record, previousViewportY + lineDelta)
    const moved = getTerminalViewportY(record.terminal) !== previousViewportY
    if (moved) {
      updateFollowStateFromViewport(record, { allowClearUnread: true })
      hideTerminalContextMenu(record)
    }
    return moved
  }

  const stopTouchMomentum = () => {
    if (momentumFrame !== null) {
      window.cancelAnimationFrame(momentumFrame)
      momentumFrame = null
    }
    momentumLastAt = 0
    touchVelocityY = 0
    touchScrollRemainderPx = 0
  }

  const stepTouchMomentum = (timestamp: number) => {
    if (record.disposed) {
      momentumFrame = null
      return
    }
    const momentumStep = stepTerminalTouchMomentum(touchVelocityY, momentumLastAt, timestamp)
    momentumLastAt = timestamp

    const momentumDelta = momentumStep.scrollDeltaPx
    const moved = scrollByTouchDelta(momentumDelta)
    touchVelocityY = momentumStep.nextVelocity
    if (!moved || !momentumStep.shouldContinue) {
      if (!moved) {
        pullTouchEdge(momentumDelta)
      }
      stopTouchMomentum()
      releaseTouchEdge()
      return
    }

    momentumFrame = window.requestAnimationFrame(stepTouchMomentum)
  }

  const startTouchMomentum = () => {
    if (!shouldStartTerminalTouchMomentum(touchVelocityY)) {
      touchVelocityY = 0
      return
    }
    momentumLastAt = 0
    momentumFrame = window.requestAnimationFrame(stepTouchMomentum)
  }

  const pointerDownHandler = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return
    stopTouchMomentum()
    releaseTouchEdge(false)
    touchPointerId = event.pointerId
    touchStartX = event.clientX
    touchStartY = event.clientY
    touchLastY = event.clientY
    touchLastMoveAt = event.timeStamp || performance.now()
    touchVelocitySamples = []
    pushTouchVelocitySample(event.clientY, touchLastMoveAt)
    touchScrollRemainderPx = 0
    touchMoved = false
    longPressEvent = event
    longPressTimer = window.setTimeout(handleLongPress, TOUCH_LONG_PRESS_MS)
    try {
      record.hostEl.setPointerCapture(event.pointerId)
    } catch {
      // Best effort only; touch scrolling still works while the pointer stays inside the terminal.
    }
  }

  const pointerMoveHandler = (event: PointerEvent) => {
    if (touchPointerId === null || event.pointerId !== touchPointerId) return
    const distance = Math.hypot(event.clientX - touchStartX, event.clientY - touchStartY)
    if (distance > TOUCH_SCROLL_ACTIVATION_PX) {
      touchMoved = true
      clearLongPress()
    }

    const deltaY = event.clientY - touchLastY
    const now = event.timeStamp || performance.now()
    const elapsed = Math.max(1, now - touchLastMoveAt)
    touchLastY = event.clientY
    touchLastMoveAt = now
    if (Math.abs(deltaY) < 0.5) return
    pushTouchVelocitySample(event.clientY, now)
    const gestureVelocity = readTouchGestureVelocity()
    touchVelocityY = blendTerminalTouchVelocity(gestureVelocity, deltaY, elapsed)

    const moved = scrollByTouchDelta(deltaY)
    if (!moved && touchMoved) {
      pullTouchEdge(deltaY)
    } else if (moved && touchEdgeOffsetPx !== 0) {
      releaseTouchEdge(false)
    }
    if (touchMoved || moved) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const pointerUpHandler = (event: PointerEvent) => {
    if (touchPointerId === null || event.pointerId !== touchPointerId) return
    const wasMoving = touchMoved
    touchPointerId = null
    clearLongPress()
    if (wasMoving) {
      event.preventDefault()
      event.stopPropagation()
      updateFollowStateFromViewport(record, { allowClearUnread: true })
      touchVelocityY = readTouchGestureVelocity()
      if (event.type === 'pointerup' && touchEdgeOffsetPx === 0) {
        startTouchMomentum()
      } else {
        stopTouchMomentum()
        releaseTouchEdge()
      }
    } else {
      touchVelocityY = 0
      touchScrollRemainderPx = 0
      releaseTouchEdge()
    }
    touchVelocitySamples = []
    try {
      record.hostEl.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }
  }

  record.hostEl.addEventListener('pointerdown', pointerDownHandler, { capture: true, passive: false })
  record.hostEl.addEventListener('pointermove', pointerMoveHandler, { capture: true, passive: false })
  record.hostEl.addEventListener('pointerup', pointerUpHandler, { capture: true, passive: false })
  record.hostEl.addEventListener('pointercancel', pointerUpHandler, { capture: true, passive: false })
  record.hostEl.addEventListener('lostpointercapture', pointerUpHandler, { capture: true, passive: false })
  record.touchInteraction = {
    pointerDownHandler,
    pointerMoveHandler,
    pointerUpHandler,
    stopTouchMomentum,
  }
}

function installTerminalTestApi() {
  if (typeof window === 'undefined' || !window.__FARMING_E2E__ || window.__farmingTerminalTest) return

  window.__farmingTerminalTest = {
    ...terminalSessionDiagnostics.testBridge(),
    async requestCheckpoint(agentId: string) {
      const controller = new AbortController()
      const release = await acquireTerminalCheckpointRequestSlot(controller.signal)
      try {
        return await fetchSessionBootstrapState(agentId, controller.signal)
      } finally {
        release()
      }
    },
    async writeFixture(agentId: string, text: string) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      record.bootstrapRefreshSeq += 1
      invalidateTerminalCheckpointRequest(record)
      record.snapshotOutput = ''
      record.snapshotRuntimeEpoch = ''
      record.snapshotOutputSeq = null
      record.snapshotStateRevision = null
      record.snapshotCols = null
      record.snapshotRows = null
      record.attachment.resetRecovery({ keepCursor: false })
      record.replayInProgress = false
      record.liveWriteInProgress = false
      record.pendingSnapshotReplay = false
      record.bootstrappingSnapshot = false
      record.needsReconnectOutputSync = false
      record.fixtureOverrideActive = true
      record.suppressOutputUntil = Date.now() + 1500
      resetTransientTerminalUi(record)
      record.openTargetMouseDown = null
      record.suppressClickUntil = 0
      record.terminal.reset()
      record.terminal.viewportY = 0
      record.terminal.scrollToLine?.(0)
      await new Promise<void>(resolve => record.terminal.write(text, resolve))
      record.terminal.viewportY = 0
      record.terminal.scrollToLine?.(0)
      setFollowOutputState(record, isTerminalAtBottom(record), false, { allowClearUnread: true })
      forceTerminalRender(record)
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
      record.fixtureOverrideActive = false
      record.suppressOutputUntil = 0
      invalidateTerminalCheckpointRequest(record)
      record.attachment.resetRecovery()
      record.attachment.beginRecovery()
      record.needsReconnectOutputSync = true
      requestTerminalReplay(record, record.attachment.generation)
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
      return selectContinuousTextAtCell(current, col, row)
    },
    getUrlAtCell(agentId: string, col: number, row: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      const logicalLine = readTerminalUrlLineAtCell(current, { col, row })
      return logicalLine ? parseTerminalUrlAtColumn(logicalLine.text, logicalLine.col) : null
    },
    isReady(agentId: string) {
      const current = sessions.get(agentId)
      return Boolean(current && !(current instanceof Promise) && !current.disposed && !current.bootstrappingSnapshot && !current.pendingSnapshotReplay)
    },
    getPathAtCell(agentId: string, col: number, row: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      return readTerminalPathLinkAtCell(current, { col, row })?.pathTarget ?? null
    },
    openPathAtCell(agentId: string, col: number, row: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed || !current.pathOpenHandler) return false
      const pathTarget = readTerminalPathLinkAtCell(current, { col, row })?.pathTarget ?? null
      if (!pathTarget) return false
      current.pathOpenHandler(agentId, pathTarget)
      return true
    },
    getCursor(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      return current.terminal.wasmTerm?.getCursor?.() ?? null
    },
    getCursorVisible(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return undefined
      const visible = current.terminal.wasmTerm?.getCursor?.().visible
      return visible === undefined ? undefined : Boolean(visible)
    },
    getRendererCursorVisible(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return undefined
      const visible = current.terminal.renderer?.cursorVisible
      return visible === undefined ? undefined : Boolean(visible)
    },
    getCursorCellPixel(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return null
      const canvas = current.terminal.renderer?.getCanvas?.() || current.hostEl.querySelector('canvas')
      const metrics = getTerminalCellMetrics(current)
      const cursor = current.terminal.wasmTerm?.getCursor?.()
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
      const rendererCanvas = current.terminal.renderer?.getCanvas?.()
      const canvases = [...new Set([
        ...(rendererCanvas instanceof HTMLCanvasElement ? [rendererCanvas] : []),
        ...current.hostEl.querySelectorAll<HTMLCanvasElement>('canvas'),
      ])]
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
      return current.lastNotifiedResize
    },
    getResizeNotificationCount(agentId: string) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return 0
      return current.resizeNotificationCount
    },
    notifyResizeForTest(agentId: string, cols: number, rows: number) {
      const current = sessions.get(agentId)
      if (!current || current instanceof Promise || current.disposed) return 0
      notifyTerminalResize(current, cols, rows)
      return current.resizeNotificationCount
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
      current.holdCheckpointInstallCompletionForTest = held
      if (!held) {
        const completeInstall = current.heldCheckpointInstallCompletionForTest
        current.heldCheckpointInstallCompletionForTest = null
        completeInstall?.()
      }
      return true
    },
    async scrollToLine(agentId: string, line: number) {
      const current = sessions.get(agentId)
      const record = current instanceof Promise ? await current : current
      if (!record || record.disposed) throw new Error(`Terminal session not found: ${agentId}`)
      record.touchInteraction?.stopTouchMomentum()
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
      record.touchInteraction?.stopTouchMomentum()
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

  let record: SessionRecord
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
    selectionChangeDisposable: null,
    imeOverlayDisposables: [],
    resizeObserver: null,
    applyingLocalResize: false,
    parkedViewportState: null,
    inputDisabled: Boolean(options.inputDisabled),
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
    clickHandler: null,
    pointerDownSelectionHandler: null,
    pointerMoveSelectionHandler: null,
    pointerUpSelectionHandler: null,
    mouseDownOpenTargetHandler: null,
    mouseDownSelectionHandler: null,
    mouseMoveSelectionHandler: null,
    mouseUpSelectionHandler: null,
    mouseUpOpenTargetHandler: null,
    doubleClickHandler: null,
    copyHandler: null,
    copyKeyHandler: null,
    clearKeyHandler: null,
    pasteHandler: null,
    lastLinkHoverEvent: null,
    openModifierActive: false,
    linkHoverHandler: null,
    linkHoverLeaveHandler: null,
    linkHoverKeyHandler: null,
    linkHoverBlurHandler: null,
    linkProviderDisposable: null,
    linkProviderHoverTarget: null,
    contextMenuHandler: null,
    contextMenuMouseDownHandler: null,
    contextMenuEl: null,
    contextMenuCleanup: null,
    contextMenuSelection: '',
    imeKeydownHandler: null,
    scrollIntentHandler: null,
    scrollKeyHandler: null,
    touchInteraction: null,
    lastNotifiedResize: null,
    resizeNotificationCount: 0,
    resizeRequestInFlight: null,
    pendingResizeRequest: null,
    resizeScheduler: createTerminalResizeScheduler({
      onFitSettled: dimensions => {
        if (!record.disposed) notifyTerminalResize(record, dimensions.cols, dimensions.rows)
      },
      onRedrawFlush: () => {
        if (!record.disposed) flushQueuedTerminalOutput(record)
      },
      onDeliveryTimeout: () => {
        const next = expireTerminalResizeDelivery(record)
        if (next && !record.disposed) deliverTerminalResize(record, next.cols, next.rows)
      },
    }),
    resizeAfterReplayRequired: false,
    followOutputHandler: options.onFollowOutputChange ?? null,
    pathOpenHandler: options.onPathOpen ?? null,
    pathResolveHandler: options.onPathResolve ?? null,
    searchOpenHandler: options.onSearchOpen ?? null,
    farmingUrlOpenHandler: options.onOpenUrlInFarming ?? null,
    pathResolveCache: new Map(),
    originalRender: null,
    snapshotOutput: '',
    snapshotRuntimeEpoch: '',
    snapshotOutputSeq: null,
    snapshotStateRevision: null,
    snapshotCols: null,
    snapshotRows: null,
    attachment: new TerminalAttachmentCoordinator(TERMINAL_REPLAY),
    replayInProgress: false,
    liveWriteInProgress: false,
    liveTransitionFlushScheduled: false,
    terminalWriteQueue: Promise.resolve(),
    terminalWriteResolvers: new Set(),
    terminalWriteBatchCount: 0,
    holdCheckpointInstallCompletionForTest: false,
    heldCheckpointInstallCompletionForTest: null,
    bootstrapRefreshSeq: 0,
    checkpointRequestCount: 0,
    checkpointRequestInFlight: false,
    checkpointRetryTimer: null,
    bootstrapRequestControllers: new Set(),
    needsReconnectOutputSync: false,
    pageOutputSuspended: document.visibilityState === 'hidden',
    pageLifecycleHandler: null,
    pendingSnapshotReplay: false,
    bootstrappingSnapshot: true,
    fixtureOverrideActive: false,
    suspendRendering: false,
    cachedSelection: '',
    lastNonEmptySelection: '',
    openTargetMouseDown: null,
    dragSelection: null,
    suppressClickUntil: 0,
    suppressOutputUntil: 0,
    imeComposing: false,
    suppressRendererCursor: Boolean(options.suppressRendererCursor),
    rendererCursorWasVisible: undefined,
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
    if (record.applyingLocalResize) return
    if (record.replayInProgress || record.bootstrappingSnapshot) return
    notifyTerminalResize(record, cols, rows)
  })

  installTerminalContextMenu(record, agentId)
  const rendererFailureSubscription = terminal.onRendererFailure?.((error) => {
    if (record.disposed) return
    record.inputDisabled = true
    resetTerminalResizeDelivery(record)
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
  installTerminalLinkProvider(record)
  terminal.syncAppearanceTheme?.()
  requestAnimationFrame(() => {
    if (!record.disposed) terminal.syncAppearanceTheme?.()
  })

  installImeAwareRenderer(record)
  applyRendererCursorPolicy(record, false)

  const syncCachedSelection = () => {
    record.cachedSelection = normalizeTerminalSelection(terminal)
    if (record.cachedSelection) {
      record.lastNonEmptySelection = normalizeTerminalSelectionForCopy(record.cachedSelection)
    }
  }
  const selectionSubscription = terminal.onSelectionChange?.(syncCachedSelection)
  record.selectionChangeDisposable = selectionSubscription
    ? () => selectionSubscription.dispose()
    : null
  const scrollSubscription = terminal.onScroll?.(() => {
    scheduleFollowStateFromViewport(record)
    captureTerminalReadingAnchor(record)
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
    record.pageOutputSuspended = suspended
    if (suspended) {
      resetTerminalResizeDelivery(record)
      record.needsReconnectOutputSync = true
      return
    }
    resyncTerminalAfterPageResume(record)
  }
  document.addEventListener('visibilitychange', pageLifecycleHandler)
  window.addEventListener('pagehide', pageLifecycleHandler)
  window.addEventListener('pageshow', pageLifecycleHandler)
  record.pageLifecycleHandler = pageLifecycleHandler
  setupTerminalImeOverlay(record)

  const openTerminalClickTarget = (event: MouseEvent | PointerEvent) => {
    const modifierActive = isTerminalOpenModifierActive(record, event)
    const url = event.button === 0 && modifierActive ? findTerminalUrlAtMouseEvent(record, event) : null
    if (url) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      openTerminalUrl(record, url)
      record.suppressClickUntil = Date.now() + 250
      return true
    }

    const searchQuery = event.button === 0 && modifierActive && record.searchOpenHandler
      ? findTerminalSearchAtMouseEvent(record, event)
      : null
    if (searchQuery) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      clearTerminalSelectionState(record)
      record.searchOpenHandler?.(agentId, searchQuery)
      record.suppressClickUntil = Date.now() + 250
      return true
    }

    if (record.pathOpenHandler && event.button === 0) {
      const pathTarget = findTerminalPathTargetAtMouseEvent(record, event)
      if (pathTarget) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        clearTerminalSelectionState(record)
        const attachmentGeneration = record.attachment.generation
        void resolveTerminalPathTarget(record, pathTarget).then(resolvedTarget => {
          if (!isCurrentAttachment(record, attachmentGeneration)) return
          if (!resolvedTarget) {
            focusAttachedTerminalInput(record)
            return
          }
          record.pathOpenHandler?.(agentId, resolvedTarget)
        })
        record.suppressClickUntil = Date.now() + 250
        return true
      }
    }

    return false
  }

  const startDragSelection = (event: MouseEvent | PointerEvent, pointerId?: number) => {
    if (isMobileViewport() || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return false
    const cell = cellFromMouseEvent(record, event)
    if (!cell) return false

    record.dragSelection = {
      start: cell,
      active: true,
      moved: false,
      pointerId,
    }
    return true
  }

  const updateDragSelection = (event: MouseEvent | PointerEvent) => {
    const dragSelection = record.dragSelection
    if (!dragSelection?.active) return false
    if ('pointerId' in event && dragSelection.pointerId !== undefined && event.pointerId !== dragSelection.pointerId) {
      return false
    }
    const cell = cellFromMouseEvent(record, event)
    if (!cell) return false
    if (cell.col === dragSelection.start.col && cell.row === dragSelection.start.row && !dragSelection.moved) return false

    dragSelection.moved = true
    selectTerminalCellRange(record, dragSelection.start, cell)
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  const finishDragSelection = (event: MouseEvent | PointerEvent) => {
    const dragSelection = record.dragSelection
    if (!dragSelection?.active) return false
    if ('pointerId' in event && dragSelection.pointerId !== undefined && event.pointerId !== dragSelection.pointerId) {
      return false
    }

    record.dragSelection = null
    if (!dragSelection.moved) return false

    record.suppressClickUntil = Date.now() + 250
    record.cachedSelection = normalizeTerminalSelection(terminal)
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  const mouseDownOpenTargetHandler = (event: MouseEvent) => {
    record.openTargetMouseDown = null
    if (isMobileViewport() || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return
    const pathTargets = record.pathOpenHandler
      ? readTerminalPathLinksAtMouseEvent(record, event).flatMap(link => link.pathTarget ? [link.pathTarget] : [])
      : []
    if (pathTargets.length === 0) return
    // Do not intercept mousedown: xterm needs it to start text selection when
    // the user drags across a path. The later mouseup/click path decides
    // whether this was a small click that should open the file.
    record.openTargetMouseDown = {
      x: event.clientX,
      y: event.clientY,
      pathTargets,
    }
  }
  hostEl.addEventListener('mousedown', mouseDownOpenTargetHandler, true)
  record.mouseDownOpenTargetHandler = mouseDownOpenTargetHandler

  const mouseUpOpenTargetHandler = (event: MouseEvent) => {
    if (isMobileViewport() || event.button !== 0) return
    if (Date.now() < record.suppressClickUntil) {
      record.openTargetMouseDown = null
      return
    }
    const modifierActive = isTerminalOpenModifierActive(record, event)
    if (modifierActive) {
      const url = findTerminalUrlAtMouseEvent(record, event)
      if (url) {
        // xterm owns a document-level mouseup listener that terminates its
        // selection gesture. Let this mouseup bubble to it; the following
        // click is still suppressed so the target opens only once.
        event.preventDefault()
        if (!isXtermTerminal(terminal)) {
          event.stopPropagation()
          event.stopImmediatePropagation()
        }
        openTerminalUrl(record, url)
        record.suppressClickUntil = Date.now() + 250
        return
      }
      const searchQuery = record.searchOpenHandler
        ? findTerminalSearchAtMouseEvent(record, event)
        : null
      if (searchQuery) {
        event.preventDefault()
        if (!isXtermTerminal(terminal)) {
          event.stopPropagation()
          event.stopImmediatePropagation()
        }
        clearTerminalSelectionState(record)
        record.searchOpenHandler?.(agentId, searchQuery)
        record.suppressClickUntil = Date.now() + 250
        return
      }
    }

    const mouseDown = record.openTargetMouseDown
    record.openTargetMouseDown = null
    if (!mouseDown) return
    if (Math.hypot(event.clientX - mouseDown.x, event.clientY - mouseDown.y) > 4) {
      record.suppressClickUntil = Date.now() + 250
      return
    }
    if (openTerminalClickTarget(event)) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    clearTerminalSelectionState(record)
    record.suppressClickUntil = Date.now() + 250
    const attachmentGeneration = record.attachment.generation
    void (async () => {
      for (const pathTarget of mouseDown.pathTargets) {
        const resolvedTarget = await resolveTerminalPathTarget(record, pathTarget)
        if (!isCurrentAttachment(record, attachmentGeneration)) return
        if (!resolvedTarget) continue
        record.pathOpenHandler?.(agentId, resolvedTarget)
        record.suppressClickUntil = Date.now() + 250
        return
      }
      focusAttachedTerminalInput(record)
    })()
  }
  hostEl.addEventListener('mouseup', mouseUpOpenTargetHandler, true)
  record.mouseUpOpenTargetHandler = mouseUpOpenTargetHandler

  const pointerDownSelectionHandler = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return
    if (startDragSelection(event, event.pointerId)) {
      try {
        record.hostEl.setPointerCapture(event.pointerId)
      } catch {
        // Best effort. Window-level move/up listeners still handle normal mouse drags.
      }
    }
  }
  if (!isXtermTerminal(terminal)) {
    hostEl.addEventListener('pointerdown', pointerDownSelectionHandler, true)
    record.pointerDownSelectionHandler = pointerDownSelectionHandler

    const pointerMoveSelectionHandler = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      updateDragSelection(event)
    }
    window.addEventListener('pointermove', pointerMoveSelectionHandler, true)
    record.pointerMoveSelectionHandler = pointerMoveSelectionHandler

    const pointerUpSelectionHandler = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const finished = finishDragSelection(event)
      if (!finished) {
        openTerminalClickTarget(event)
      }
      if (finished || Date.now() < record.suppressClickUntil) {
        try {
          record.hostEl.releasePointerCapture(event.pointerId)
        } catch {
          // ignore
        }
      }
    }
    window.addEventListener('pointerup', pointerUpSelectionHandler, true)
    window.addEventListener('pointercancel', pointerUpSelectionHandler, true)
    record.pointerUpSelectionHandler = pointerUpSelectionHandler

    const mouseDownSelectionHandler = (event: MouseEvent) => {
      if (record.dragSelection) return
      startDragSelection(event)
    }
    hostEl.addEventListener('mousedown', mouseDownSelectionHandler, true)
    record.mouseDownSelectionHandler = mouseDownSelectionHandler

    const mouseMoveSelectionHandler = (event: MouseEvent) => {
      updateDragSelection(event)
    }
    window.addEventListener('mousemove', mouseMoveSelectionHandler, true)
    record.mouseMoveSelectionHandler = mouseMoveSelectionHandler

    const mouseUpSelectionHandler = (event: MouseEvent) => {
      finishDragSelection(event)
    }
    window.addEventListener('mouseup', mouseUpSelectionHandler, true)
    record.mouseUpSelectionHandler = mouseUpSelectionHandler
  }

  const clickHandler = (event: MouseEvent) => {
    if (isMobileViewport()) {
      return
    }

    if (Date.now() < record.suppressClickUntil) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      return
    }

    if (openTerminalClickTarget(event)) return

    focusAttachedTerminalInput(record)
  }
  hostEl.addEventListener('click', clickHandler, true)
  record.clickHandler = clickHandler

  const doubleClickHandler = (event: MouseEvent) => {
    if (isXtermTerminal(terminal)) return
    if (isMobileViewport()) return
    const cell = cellFromMouseEvent(record, event)
    if (!cell) return
    const selection = selectContinuousTextAtCell(record, cell.col, cell.row)
    if (!selection) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }
  hostEl.addEventListener('dblclick', doubleClickHandler, true)
  record.doubleClickHandler = doubleClickHandler

  const copyHandler = (event: ClipboardEvent) => {
    if (!shouldHandleTerminalCopyEvent(record, event)) return
    const selection = getTerminalSelectionForCopy(record, { includeNativeFallback: true })
    if (!selection) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    event.clipboardData?.setData('text/plain', selection)
  }
  hostEl.addEventListener('copy', copyHandler, true)
  document.addEventListener('copy', copyHandler, true)
  record.copyHandler = copyHandler

  const copyKeyHandler = (event: KeyboardEvent) => {
    if (!shouldHandleTerminalCopyKeyEvent(record, event)) return
    const selection = getTerminalSelectionForCopy(record, { includeNativeFallback: true })
    if (!selection) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    void writeClipboardText(selection)
  }
  document.addEventListener('keydown', copyKeyHandler, true)
  record.copyKeyHandler = copyKeyHandler

  const clearKeyHandler = (event: KeyboardEvent) => {
    handleTerminalClearKeyEvent(record, event)
  }
  if (!terminal.attachCustomKeyEventHandler) {
    document.addEventListener('keydown', clearKeyHandler, true)
    record.clearKeyHandler = clearKeyHandler
  }

  const pasteHandler = (event: ClipboardEvent) => {
    const isAttached = isTerminalSessionAttached(record)
    if (shouldBlockDetachedTerminalPaste(record.hostEl, event, isAttached)) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      return
    }
    if (!shouldHandleTerminalPasteEvent(record.hostEl, event, isAttached)) return
    if (isXtermTerminal(record.terminal)) {
      return
    }
    const text = event.clipboardData?.getData('text/plain') || ''
    if (!pasteTerminalClipboardText(record, text)) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }
  window.addEventListener('paste', pasteHandler, true)
  hostEl.addEventListener('paste', pasteHandler, true)
  record.pasteHandler = pasteHandler

  const linkHoverHandler = (event: MouseEvent) => {
    if (!shouldHandleTerminalHoverEvent(record)) {
      clearTerminalOpenTargetState(record)
      return
    }
    record.lastLinkHoverEvent = event
    if (!terminalOpenTargetKindAtMouseEvent(record, event)) {
      record.linkProviderHoverTarget = null
      setTerminalLinkHoverTarget(record, null)
    }
    refreshTerminalLinkHoverTarget(record)
    void resolveTerminalPathLinkAtMouseEvent(record, event).then(pathLink => {
      if (!pathLink || record.disposed || record.lastLinkHoverEvent !== event) return
      record.linkProviderHoverTarget = {
        kind: 'path',
        text: pathLink.text,
        ...(pathLink.pathTarget ? { pathTarget: pathLink.pathTarget } : {}),
      }
      setTerminalLinkHoverTarget(record, 'path')
    })
  }
  hostEl.addEventListener('mousemove', linkHoverHandler, true)
  record.linkHoverHandler = linkHoverHandler

  const linkHoverLeaveHandler = () => {
    clearTerminalOpenTargetState(record)
  }
  hostEl.addEventListener('mouseleave', linkHoverLeaveHandler, true)
  record.linkHoverLeaveHandler = linkHoverLeaveHandler

  const linkHoverKeyHandler = (event: KeyboardEvent) => {
    if (!shouldHandleTerminalHoverEvent(record)) {
      clearTerminalOpenTargetState(record)
      return
    }
    if (event.type === 'keydown' && ['Control', 'Meta'].includes(event.key)) {
      record.openModifierActive = true
    } else {
      record.openModifierActive = isTerminalOpenModifierEvent(event)
    }
    if (!record.lastLinkHoverEvent) return
    if (!['Control', 'Meta'].includes(event.key) && !record.openModifierActive) return
    refreshTerminalLinkHoverTarget(record, record.openModifierActive)
  }
  window.addEventListener('keydown', linkHoverKeyHandler, true)
  window.addEventListener('keyup', linkHoverKeyHandler, true)
  record.linkHoverKeyHandler = linkHoverKeyHandler

  const linkHoverBlurHandler = () => {
    clearTerminalOpenTargetState(record)
  }
  window.addEventListener('blur', linkHoverBlurHandler)
  record.linkHoverBlurHandler = linkHoverBlurHandler

  const scrollIntentHandler = (event: Event) => {
    if (event instanceof WheelEvent && event.deltaY < 0) {
      setFollowOutputState(record, false, record.hasUnreadOutput)
    }
    captureTerminalReadingAnchor(record)
    scheduleFollowStateFromViewport(record, { allowClearUnread: true })
    window.setTimeout(() => scheduleFollowStateFromViewport(record, { allowClearUnread: true }), 80)
  }
  hostEl.addEventListener('wheel', scrollIntentHandler, true)
  hostEl.addEventListener('pointerup', scrollIntentHandler, true)
  record.scrollIntentHandler = scrollIntentHandler

  const scrollKeyHandler = (event: KeyboardEvent) => {
    handleTerminalScrollKeyEvent(record, event)
  }
  if (terminal.attachCustomKeyEventHandler) {
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => (
      handleTerminalClearKeyEvent(record, event) || handleTerminalScrollKeyEvent(record, event) ? false : true
    ))
  } else {
    document.addEventListener('keydown', scrollKeyHandler, true)
    hostEl.addEventListener('keydown', scrollKeyHandler, true)
    record.scrollKeyHandler = scrollKeyHandler
  }
  installTerminalTouchInteraction(record)

  const resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      if (record.disposed) return
      try {
        syncTerminalSize(record)
      } catch {
        // ignore transient zero-size states while hidden
      }
    })
  })
  record.resizeObserver = resizeObserver

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
    record.bootstrappingSnapshot ||
    record.pendingSnapshotReplay ||
    record.needsReconnectOutputSync ||
    record.replayInProgress ||
    record.liveWriteInProgress ||
    record.attachment.queuedTransitionCount > 0 ||
    !record.attachment.runtimeEpoch ||
    record.attachment.outputSeq === null ||
    record.attachment.stateRevision === null
  ) return false
  // A ready record may have been detached and reattached before the previous
  // install-completion animation frame ran. That frame is generation-fenced,
  // so it intentionally stops after detach; clear its visual latch here at
  // the authoritative ready boundary or the reattached xterm stays hidden.
  record.hostEl.classList.remove('terminal-checkpoint-installing')
  publishTerminalRecoveryStatus(record, 'ready')
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

function finishTerminalAttachBootstrap(record: SessionRecord, generation: number) {
  if (!isCurrentAttachment(record, generation)) return
  if (
    record.pendingSnapshotReplay
    && record.snapshotRuntimeEpoch
    && record.snapshotOutputSeq !== null
    && record.snapshotStateRevision !== null
    && record.snapshotCols !== null
    && record.snapshotRows !== null
    && Date.now() >= record.suppressOutputUntil
  ) {
    replayPendingSnapshot(record, generation)
    return
  }
  if (notifyTerminalAttachReady(record, generation)) return
  if (record.replayInProgress || record.checkpointRequestInFlight) return
  record.needsReconnectOutputSync = true
  requestTerminalReplay(record, generation)
}

function fitAndFocus(record: SessionRecord, options: Pick<AttachOptions, 'autoFocus' | 'onReady'>, generation: number) {
  const wasFollowing = record.followOutput
  const previousViewportY = getTerminalViewportY(record.terminal)
  const previousScrollbackLength = getTerminalScrollbackLength(record.terminal)
  const hadUnreadOutput = record.hasUnreadOutput

  requestAnimationFrame(() => {
    if (!isCurrentAttachment(record, generation)) return
    syncTerminalSize(record, { force: true })
    restoreViewportAfterLayout(record, previousViewportY, previousScrollbackLength, wasFollowing, hadUnreadOutput)
    scheduleTerminalRepaint(record)
    if (options.autoFocus && !isMobileViewport() && shouldAllowTerminalAutoFocus(record.hostEl)) {
      focusTerminalInputWhenReady(record, generation)
    }
    requestAnimationFrame(() => {
      if (!isCurrentAttachment(record, generation)) return
      syncTerminalSize(record, { force: true })
      restoreViewportAfterLayout(record, previousViewportY, previousScrollbackLength, wasFollowing, hadUnreadOutput)
      scheduleTerminalRepaint(record)
      finishTerminalAttachBootstrap(record, generation)
    })
  })
}

function applyTerminalAttachmentOptions(record: SessionRecord, options: AttachOptions) {
  record.errorHandler = options.onError ?? null
  record.inputDisabled = Boolean(options.inputDisabled)
  record.followOutputHandler = options.onFollowOutputChange ?? null
  record.pathOpenHandler = options.onPathOpen ?? null
  record.pathResolveHandler = options.onPathResolve ?? null
  record.searchOpenHandler = options.onSearchOpen ?? null
  record.farmingUrlOpenHandler = options.onOpenUrlInFarming ?? null
  record.recoveryStatusHandler = options.onRecoveryStatusChange ?? null
  updateRendererCursorSuppression(record, Boolean(options.suppressRendererCursor))
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

  const generation = record.attachment.beginAttachment().generation
  record.attachReadyHandler = options.onReady ?? null
  record.attachReadyGeneration = generation
  record.attachReadyNotified = false
  record.recoveryStatusHandler = options.onRecoveryStatusChange ?? null
  publishTerminalRecoveryStatus(record, 'requesting', { attempt: 1, restart: true })
  invalidateTerminalCheckpointRequest(record)
  record.attachment.resetRecovery()
  record.attachment.beginRecovery()
  record.needsReconnectOutputSync = true
  record.bootstrappingSnapshot = true
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

  invalidateTerminalCheckpointRequest(current)
  current.pendingSnapshotReplay = false
  current.attachment.resetRecovery()
  current.attachment.beginRecovery()
  current.needsReconnectOutputSync = true
  current.bootstrappingSnapshot = true
  current.hostEl.classList.add('terminal-checkpoint-installing')
  publishTerminalRecoveryStatus(current, 'requesting', { attempt: 1, restart: true })
  requestTerminalReplay(current, current.attachment.generation)
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
    || (!record.bootstrappingSnapshot && !record.needsReconnectOutputSync)
  ) {
    return false
  }
  invalidateTerminalCheckpointRequest(record)
  const seeded = seedTerminalCheckpoint(record, state)
  if (!seeded && !record.pendingSnapshotReplay) return false
  if (isTerminalSessionAttached(record)) {
    requestAnimationFrame(() => {
      if (!record.disposed && record.pendingSnapshotReplay) {
        replayPendingSnapshot(record, record.attachment.generation)
      }
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
  record.farmingUrlOpenHandler = options.onOpenUrlInFarming ?? null
  updateRendererCursorSuppression(record, options.suppressRendererCursor)
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
  record.cachedSelection = normalizeTerminalSelection(record.terminal)
  if (record.cachedSelection) {
    record.lastNonEmptySelection = normalizeTerminalSelectionForCopy(record.cachedSelection)
  }
  return record.cachedSelection
}

export function getTerminalSelectionNow(agentId: string) {
  const current = sessions.get(agentId)
  if (!current || current instanceof Promise || current.disposed) return ''

  current.cachedSelection = normalizeTerminalSelection(current.terminal)
  if (current.cachedSelection) {
    current.lastNonEmptySelection = normalizeTerminalSelectionForCopy(current.cachedSelection)
  }
  return current.cachedSelection
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

  const record = await current
  if (record.disposed) return
  record.disposed = true
  invalidateTerminalCheckpointRequest(record)
  resetTerminalResizeDelivery(record)
  clearPendingTerminalOutput(record)
  flushPendingTerminalWrites(record)

  record.unsubscribeOutput?.()
  record.rendererFailureDisposable?.()
  record.selectionChangeDisposable?.()
  record.scrollChangeDisposable?.()
  if (record.backendConnectedHandler) {
    window.removeEventListener('farming:backend-connected', record.backendConnectedHandler)
  }
  if (record.pageLifecycleHandler) {
    document.removeEventListener('visibilitychange', record.pageLifecycleHandler)
    window.removeEventListener('pagehide', record.pageLifecycleHandler)
    window.removeEventListener('pageshow', record.pageLifecycleHandler)
  }
  record.imeOverlayDisposables.forEach(dispose => dispose())
  record.resizeObserver?.disconnect()
  if (record.followCheckFrame !== null) {
    cancelAnimationFrame(record.followCheckFrame)
  }
  if (record.clickHandler) {
    record.hostEl.removeEventListener('click', record.clickHandler, true)
  }
  if (record.pointerDownSelectionHandler) {
    record.hostEl.removeEventListener('pointerdown', record.pointerDownSelectionHandler, true)
  }
  if (record.pointerMoveSelectionHandler) {
    window.removeEventListener('pointermove', record.pointerMoveSelectionHandler, true)
  }
  if (record.pointerUpSelectionHandler) {
    window.removeEventListener('pointerup', record.pointerUpSelectionHandler, true)
    window.removeEventListener('pointercancel', record.pointerUpSelectionHandler, true)
  }
  if (record.mouseDownOpenTargetHandler) {
    record.hostEl.removeEventListener('mousedown', record.mouseDownOpenTargetHandler, true)
  }
  if (record.mouseDownSelectionHandler) {
    record.hostEl.removeEventListener('mousedown', record.mouseDownSelectionHandler, true)
  }
  if (record.mouseMoveSelectionHandler) {
    window.removeEventListener('mousemove', record.mouseMoveSelectionHandler, true)
  }
  if (record.mouseUpSelectionHandler) {
    window.removeEventListener('mouseup', record.mouseUpSelectionHandler, true)
  }
  if (record.mouseUpOpenTargetHandler) {
    record.hostEl.removeEventListener('mouseup', record.mouseUpOpenTargetHandler, true)
  }
  if (record.doubleClickHandler) {
    record.hostEl.removeEventListener('dblclick', record.doubleClickHandler, true)
  }
  if (record.copyHandler) {
    record.hostEl.removeEventListener('copy', record.copyHandler, true)
    document.removeEventListener('copy', record.copyHandler, true)
  }
  if (record.copyKeyHandler) {
    document.removeEventListener('keydown', record.copyKeyHandler, true)
  }
  if (record.clearKeyHandler) {
    document.removeEventListener('keydown', record.clearKeyHandler, true)
  }
  if (record.pasteHandler) {
    window.removeEventListener('paste', record.pasteHandler, true)
    record.hostEl.removeEventListener('paste', record.pasteHandler, true)
  }
  if (record.linkHoverHandler) {
    record.hostEl.removeEventListener('mousemove', record.linkHoverHandler, true)
  }
  if (record.linkHoverLeaveHandler) {
    record.hostEl.removeEventListener('mouseleave', record.linkHoverLeaveHandler, true)
  }
  if (record.linkHoverKeyHandler) {
    window.removeEventListener('keydown', record.linkHoverKeyHandler, true)
    window.removeEventListener('keyup', record.linkHoverKeyHandler, true)
  }
  if (record.linkHoverBlurHandler) {
    window.removeEventListener('blur', record.linkHoverBlurHandler)
  }
  record.linkProviderDisposable?.()
  if (record.contextMenuHandler) {
    record.hostEl.removeEventListener('contextmenu', record.contextMenuHandler, true)
    window.removeEventListener('contextmenu', record.contextMenuHandler, true)
  }
  if (record.contextMenuMouseDownHandler) {
    record.hostEl.removeEventListener('mousedown', record.contextMenuMouseDownHandler, true)
    window.removeEventListener('mousedown', record.contextMenuMouseDownHandler, true)
  }
  hideTerminalContextMenu(record)
  if (record.scrollIntentHandler) {
    record.hostEl.removeEventListener('wheel', record.scrollIntentHandler, true)
    record.hostEl.removeEventListener('pointerup', record.scrollIntentHandler, true)
  }
  if (record.scrollKeyHandler) {
    document.removeEventListener('keydown', record.scrollKeyHandler, true)
    record.hostEl.removeEventListener('keydown', record.scrollKeyHandler, true)
  }
  if (record.touchInteraction) {
    record.touchInteraction.stopTouchMomentum()
    record.hostEl.removeEventListener('pointerdown', record.touchInteraction.pointerDownHandler, true)
    record.hostEl.removeEventListener('pointermove', record.touchInteraction.pointerMoveHandler, true)
    record.hostEl.removeEventListener('pointerup', record.touchInteraction.pointerUpHandler, true)
    record.hostEl.removeEventListener('pointercancel', record.touchInteraction.pointerUpHandler, true)
    record.hostEl.removeEventListener('lostpointercapture', record.touchInteraction.pointerUpHandler, true)
  }
  if (record.originalRender && record.terminal.renderer) {
    record.terminal.renderer.render = record.originalRender
  }
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
    syncTerminalSize(record, { force: true })
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
    updateTerminalImeOverlay(current.hostEl, current.terminal)
    if (!isTerminalSessionAttached(current)) return
    requestAnimationFrame(() => {
      if (current.disposed || !isTerminalSessionAttached(current)) return
      syncTerminalSize(current, { force: true })
      scheduleTerminalRepaint(current)
      requestAnimationFrame(() => {
        if (current.disposed || !isTerminalSessionAttached(current)) return
        syncTerminalSize(current, { force: true })
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
  record.touchInteraction?.stopTouchMomentum()
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
