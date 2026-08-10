import '../../frontend/terminal-replay.js'
import type { FarmingTerminal } from '@/lib/terminal-engine'
import type { TerminalAttachmentCoordinator } from '@/lib/terminal-attachment-coordinator'
import type { TerminalResizeEffectController } from '@/lib/terminal-resize-effect-controller'
import type { TerminalSessionInteractionController } from '@/lib/terminal-session-interaction'
import type { TerminalOutputRecord } from '@/lib/terminal-output'
import {
  forceTerminalRender,
  replaceTerminalOutput,
  writeTerminalOutput,
} from '@/lib/terminal-output'
import { TerminalCheckpointRequestScheduler } from '@/lib/terminal-checkpoint-request-scheduler'
import {
  requestTerminalSessionCheckpoint,
} from '@/lib/terminal-session-client'
import {
  sessionBootstrapStateFromPayload,
  type SessionBootstrapState,
} from '@/lib/terminal-bootstrap'
import {
  emitFollowOutputState,
  isTerminalAtBottom,
  setFollowOutputState,
} from '@/lib/terminal-viewport'
import type { TerminalRecoveryPhase } from '@/lib/terminal-recovery-status'

export type TerminalTransitionKind = 'output' | 'resize' | 'clear'

export interface TerminalViewportRestoreState {
  viewportY: number
  scrollbackLength: number
  following: boolean
  hasUnreadOutput: boolean
  preserveUnreadOutputUntilJump: boolean
  readingAnchor: unknown
}

export interface TerminalReplicationState {
  snapshotOutput: string
  snapshotRuntimeEpoch: string
  snapshotOutputSeq: number | null
  snapshotStateRevision: number | null
  snapshotCols: number | null
  snapshotRows: number | null
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
  pendingSnapshotReplay: boolean
  bootstrappingSnapshot: boolean
  fixtureOverrideActive: boolean
  suppressOutputUntil: number
}

export interface TerminalReplicationPorts {
  isAttached: () => boolean
  publishStatus: (
    phase: TerminalRecoveryPhase,
    options?: { attempt?: number; retryDelayMs?: number | null; restart?: boolean },
  ) => void
  reportError: (message: string) => void
  notifyReady: (generation: number) => boolean
  captureViewportState: () => TerminalViewportRestoreState
  restoreViewportState: (state: TerminalViewportRestoreState) => void
}

export interface TerminalReplicationRecord extends TerminalOutputRecord {
  agentId: string
  terminal: FarmingTerminal
  hostEl: HTMLDivElement
  disposed: boolean
  attachment: TerminalAttachmentCoordinator
  resizeEffects: TerminalResizeEffectController
  interaction: Pick<TerminalSessionInteractionController, 'reset' | 'scheduleImeOverlayUpdateIfActive'>
  replication: TerminalReplicationState
  replicationPorts: TerminalReplicationPorts
}

const TERMINAL_CHECKPOINT_REQUEST_TIMEOUT_MS = 5000
const terminalCheckpointRequestScheduler = new TerminalCheckpointRequestScheduler()

export function createTerminalReplicationState(
  initial: Partial<TerminalReplicationState> = {},
): TerminalReplicationState {
  return {
    snapshotOutput: '',
    snapshotRuntimeEpoch: '',
    snapshotOutputSeq: null,
    snapshotStateRevision: null,
    snapshotCols: null,
    snapshotRows: null,
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
    pageOutputSuspended: false,
    pendingSnapshotReplay: false,
    bootstrappingSnapshot: true,
    fixtureOverrideActive: false,
    suppressOutputUntil: 0,
    ...initial,
  }
}

async function fetchSessionBootstrapStateForCurrentTerminal(record: TerminalReplicationRecord) {
  record.replication.checkpointRequestCount += 1
  const controller = new AbortController()
  record.replication.bootstrapRequestControllers.add(controller)
  let release: (() => void) | null = null
  let timeout: number | null = null
  try {
    release = await terminalCheckpointRequestScheduler.acquire(controller.signal)
    timeout = window.setTimeout(
      () => controller.abort(new DOMException('Terminal checkpoint request timed out', 'TimeoutError')),
      TERMINAL_CHECKPOINT_REQUEST_TIMEOUT_MS,
    )
    const data = await requestTerminalSessionCheckpoint(record.agentId, controller.signal)
    return sessionBootstrapStateFromPayload(data)
  } finally {
    if (timeout !== null) window.clearTimeout(timeout)
    release?.()
    record.replication.bootstrapRequestControllers.delete(controller)
  }
}

function isCurrentReplicationAttachment(record: TerminalReplicationRecord, generation: number) {
  return record.attachment.isCurrentGeneration(generation) && record.replicationPorts.isAttached()
}

export function invalidateTerminalReplication(record: TerminalReplicationRecord) {
  record.resizeEffects.beginRecovery()
  record.attachment.invalidateOperation()
  record.replication.replayInProgress = false
  clearTerminalCheckpointRetry(record)
  record.replication.bootstrapRequestControllers.forEach(controller => controller.abort())
  record.replication.bootstrapRequestControllers.clear()
  record.replication.checkpointRequestInFlight = false
}

export function replayPendingSnapshot(record: TerminalReplicationRecord, generation = record.attachment.generation) {
  if (
    record.replication.fixtureOverrideActive ||
    record.disposed ||
    !record.replication.pendingSnapshotReplay ||
    !isCurrentReplicationAttachment(record, generation)
  ) return

  record.replication.pendingSnapshotReplay = false
  if (
    !record.replication.snapshotRuntimeEpoch ||
    record.replication.snapshotOutputSeq === null ||
    record.replication.snapshotStateRevision === null ||
    record.replication.snapshotCols === null ||
    record.replication.snapshotRows === null
  ) {
    requestTerminalReplay(record, generation)
    return
  }
  installTerminalCheckpoint(record, {
    runtimeEpoch: record.replication.snapshotRuntimeEpoch,
    output: record.replication.snapshotOutput,
    outputSeq: record.replication.snapshotOutputSeq,
    stateRevision: record.replication.snapshotStateRevision,
    cols: record.replication.snapshotCols,
    rows: record.replication.snapshotRows,
  }, generation)
}

export function seedTerminalCheckpoint(record: TerminalReplicationRecord, state?: SessionBootstrapState) {
  if (!state || record.replication.fixtureOverrideActive) return false
  const checkpoint = terminalReplayCheckpoint(state)
  if (record.attachment.evaluateCheckpoint(checkpoint).action === 'reject') return false

  record.replication.snapshotOutput = state.output
  record.replication.snapshotRuntimeEpoch = state.runtimeEpoch
  record.replication.snapshotOutputSeq = state.outputSeq
  record.replication.snapshotStateRevision = state.stateRevision
  record.replication.snapshotCols = state.cols
  record.replication.snapshotRows = state.rows
  record.replication.pendingSnapshotReplay = true
  record.replication.bootstrappingSnapshot = true
  record.replication.needsReconnectOutputSync = true
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
  record: TerminalReplicationRecord,
  event: TerminalReplayTransition,
) {
  const result = record.attachment.queueTransition(event)
  if (!result.queued) {
    record.replication.needsReconnectOutputSync = true
    record.replication.bootstrappingSnapshot = true
    requestTerminalReplay(record, record.attachment.generation)
  }
}

function clearTerminalCheckpointRetry(record: TerminalReplicationRecord) {
  if (record.replication.checkpointRetryTimer === null) return
  window.clearTimeout(record.replication.checkpointRetryTimer)
  record.replication.checkpointRetryTimer = null
}

function scheduleTerminalCheckpointRetry(
  record: TerminalReplicationRecord,
  delay: number,
  generation = record.attachment.generation,
) {
  if (record.disposed || record.attachment.halted || record.replication.checkpointRetryTimer !== null) return
  record.replication.checkpointRetryTimer = window.setTimeout(() => {
    record.replication.checkpointRetryTimer = null
    if (record.disposed || !isCurrentReplicationAttachment(record, generation)) return
    requestTerminalReplay(record, generation)
  }, delay)
}

function retryTerminalReplayAfterFailure(
  record: TerminalReplicationRecord,
  failure: TerminalReplayFailure,
  generation: number,
) {
  record.replication.checkpointRequestInFlight = false
  record.replication.needsReconnectOutputSync = true
  record.replication.bootstrappingSnapshot = true
  if (failure.halted) {
    stopTerminalReplay(record, failure.message)
    return
  }
  record.replicationPorts.publishStatus('retrying', {
    attempt: record.attachment.failureCount + 1,
    retryDelayMs: failure.delay,
  })
  scheduleTerminalCheckpointRetry(record, failure.delay, generation)
}

function stopTerminalReplay(record: TerminalReplicationRecord, message: string) {
  clearTerminalCheckpointRetry(record)
  record.replication.checkpointRequestInFlight = false
  record.replication.replayInProgress = false
  record.replication.bootstrappingSnapshot = false
  record.replication.pendingSnapshotReplay = false
  record.attachment.clearQueuedTransitions()
  record.hostEl.classList.add('terminal-checkpoint-installing')
  record.replicationPorts.publishStatus('failed')
  record.replicationPorts.reportError(message)
}

function finishTerminalReplay(record: TerminalReplicationRecord, generation: number) {
  if (
    record.disposed ||
    !isCurrentReplicationAttachment(record, generation) ||
    record.replication.replayInProgress ||
    record.replication.checkpointRequestInFlight ||
    record.replication.pendingSnapshotReplay ||
    record.replication.liveWriteInProgress
  ) return

  if (record.attachment.queuedTransitionCount > 0) {
    flushQueuedTerminalOutput(record)
    if (
      record.attachment.queuedTransitionCount > 0 ||
      record.replication.liveWriteInProgress ||
      record.replication.checkpointRequestInFlight
    ) return
  }

  if (record.replication.needsReconnectOutputSync || record.attachment.isReplayTargetPending()) {
    requestTerminalReplay(record, generation)
    return
  }

  record.replication.bootstrappingSnapshot = false
  const forceResize = record.resizeEffects.recoveryFitRequired()
  requestAnimationFrame(() => {
    if (!isCurrentReplicationAttachment(record, generation) || record.disposed) return
    record.hostEl.classList.remove('terminal-checkpoint-installing')
    record.resizeEffects.syncFit({ force: forceResize })
    record.replicationPorts.notifyReady(generation)
  })
}

function installTerminalCheckpoint(
  record: TerminalReplicationRecord,
  state: SessionBootstrapState,
  generation: number,
) {
  if (
    record.disposed ||
    !isCurrentReplicationAttachment(record, generation)
  ) return false

  // Installing the fetched cut advances the attachment operation again. The
  // fetch operation's resize effects must be invalid before that revision.
  record.resizeEffects.beginRecovery()
  const operation = record.attachment.beginCheckpointOperation(generation)
  if (!operation) return false
  record.replicationPorts.publishStatus('installing', {
    attempt: record.attachment.failureCount + 1,
  })
  record.replication.checkpointRequestInFlight = false
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
    const viewportState = record.replicationPorts.captureViewportState()
    record.attachment.commitCheckpoint(operation, checkpoint)
    record.replication.needsReconnectOutputSync = false
    record.replication.bootstrappingSnapshot = false
    record.replicationPorts.restoreViewportState(viewportState)
    flushQueuedTerminalOutput(record)
    finishTerminalReplay(record, generation)
    return true
  }

  const viewportState = record.replicationPorts.captureViewportState()

  record.replication.replayInProgress = true
  record.replication.bootstrappingSnapshot = true
  record.hostEl.classList.add('terminal-checkpoint-installing')

  let checkpointEffectAdmitted = false
  replaceTerminalOutput(record, state.output, () => {
    const completeInstall = () => {
      if (
        record.disposed ||
        !isCurrentReplicationAttachment(record, generation) ||
        !record.attachment.isCurrentOperation(operation)
      ) return

      if (!checkpointEffectAdmitted) {
        record.replication.replayInProgress = false
        if (
          record.attachment.isReplayTargetPending()
          || record.attachment.queuedTransitionCount > 0
        ) {
          record.replication.needsReconnectOutputSync = true
          record.replication.bootstrappingSnapshot = true
          requestTerminalReplay(record, generation)
        } else {
          record.replication.needsReconnectOutputSync = false
          record.replication.bootstrappingSnapshot = false
          flushQueuedTerminalOutput(record)
          finishTerminalReplay(record, generation)
        }
        return
      }
      if (!record.attachment.commitCheckpoint(operation, checkpoint)) {
        record.replication.replayInProgress = false
        record.replication.needsReconnectOutputSync = true
        record.replication.bootstrappingSnapshot = true
        requestTerminalReplay(record, generation)
        return
      }
      record.followOutput = viewportState.following
      record.hasUnreadOutput = viewportState.hasUnreadOutput
      record.preserveUnreadOutputUntilJump = viewportState.preserveUnreadOutputUntilJump
      record.replicationPorts.restoreViewportState(viewportState)
      record.replication.replayInProgress = false
      record.replication.needsReconnectOutputSync = false
      record.replication.bootstrappingSnapshot = false
      record.interaction.scheduleImeOverlayUpdateIfActive()
      flushQueuedTerminalOutput(record)
      finishTerminalReplay(record, generation)
    }
    if (record.replication.holdCheckpointInstallCompletionForTest) {
      record.replication.heldCheckpointInstallCompletionForTest = completeInstall
      return
    }
    completeInstall()
  }, {
    beforeReplace: () => {
      if (
        record.disposed
        || !isCurrentReplicationAttachment(record, generation)
        || !record.attachment.admitCheckpointInstall(operation, checkpoint)
      ) return false

      if (
        record.terminal.cols !== state.cols
        || record.terminal.rows !== state.rows
      ) {
        record.resizeEffects.applyAuthoritativeDimensions(state.cols!, state.rows!)
      }
      checkpointEffectAdmitted = true
      return true
    },
  })
  return true
}

export function requestTerminalReplay(record: TerminalReplicationRecord, generation = record.attachment.generation) {
  if (
    record.disposed ||
    record.replication.fixtureOverrideActive ||
    record.replication.pageOutputSuspended ||
    record.replication.checkpointRequestInFlight ||
    record.replication.checkpointRetryTimer !== null ||
    record.replication.replayInProgress ||
    record.attachment.halted ||
    !isCurrentReplicationAttachment(record, generation)
  ) return

  record.replicationPorts.publishStatus('requesting', {
    attempt: record.attachment.failureCount + 1,
  })
  // A checkpoint operation advances the protocol operation revision. Invalidate
  // every resize observer/timer/delivery token before that revision changes so
  // an old delivery cannot become permanently in-flight behind the new cut.
  record.resizeEffects.beginRecovery()
  record.attachment.beginRecovery()
  const requestOperation = record.attachment.beginCheckpointOperation(generation)
  if (!requestOperation) return
  record.replication.checkpointRequestInFlight = true
  record.replication.bootstrappingSnapshot = true
  record.replication.needsReconnectOutputSync = true
  fetchSessionBootstrapStateForCurrentTerminal(record)
    .then((state) => {
      if (
        record.disposed ||
        !record.attachment.isCurrentOperation(requestOperation) ||
        record.replication.pageOutputSuspended ||
        !isCurrentReplicationAttachment(record, generation)
      ) return
      record.replication.checkpointRequestInFlight = false
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

export function applyTerminalOutputEvent(
  record: TerminalReplicationRecord,
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
    if (record.replication.fixtureOverrideActive || record.replication.pageOutputSuspended) return
    invalidateTerminalReplication(record)
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
  const transitionAttachment = record.attachment.currentOperation()
  const decision = record.attachment.classifyTransition(event)
  if (decision.action === 'drop') return
  if (decision.action === 'recover') {
    queueTerminalTransition(record, event)
    record.replication.needsReconnectOutputSync = true
    record.replication.bootstrappingSnapshot = true
    requestTerminalReplay(record)
    return
  }

  if (kind === 'resize') {
    const nextCols = Math.floor(cols!)
    const nextRows = Math.floor(rows!)
    record.attachment.commitTransition(event)
    record.resizeEffects.applyCommittedRemoteResize(nextCols, nextRows, {
      attachment: transitionAttachment,
      stateRevision: record.attachment.stateRevision!,
    })
    record.interaction.scheduleImeOverlayUpdateIfActive()
    flushQueuedTerminalOutput(record)
    record.replicationPorts.notifyReady(record.attachment.generation)
    return
  }

  const transitionData = kind === 'clear' ? '\x1b[2J\x1b[3J\x1b[H' : data
  if (!transitionData) {
    record.attachment.commitTransition(event)
    flushQueuedTerminalOutput(record)
    return
  }

  record.replication.liveWriteInProgress = true
  writeTerminalOutput(record, transitionData, () => {
    if (record.disposed) return
    record.attachment.commitTransition(event)
    if (kind === 'clear') record.terminal.clearTerminalSelection?.()
    record.replication.liveWriteInProgress = false
    if (record.followOutput && !record.hasUnreadOutput) {
      emitFollowOutputState(record)
    }
    record.interaction.scheduleImeOverlayUpdateIfActive()
    flushQueuedTerminalOutput(record)
    if (record.hostEl.classList.contains('terminal-checkpoint-installing')) {
      finishTerminalReplay(record, record.attachment.generation)
    } else {
      record.replicationPorts.notifyReady(record.attachment.generation)
    }
  }, { isOutputObserved: () => record.replicationPorts.isAttached() })
}

export function handleTerminalStreamOutput(
  record: TerminalReplicationRecord,
  data: string,
  replace?: boolean,
  outputSeq?: number | null,
  runtimeEpoch = '',
  stateRevision?: number | null,
  cols?: number,
  rows?: number,
  kind: TerminalTransitionKind = 'output',
) {
  if (record.disposed || Date.now() < record.replication.suppressOutputUntil) return

  if (record.replication.pageOutputSuspended || document.visibilityState === 'hidden') {
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
    record.replication.needsReconnectOutputSync = true
    return
  }

  const recoveryActive = record.replication.needsReconnectOutputSync
    || record.replication.bootstrappingSnapshot
    || record.replication.pendingSnapshotReplay
    || record.replication.replayInProgress
    || record.replication.checkpointRequestInFlight
    || record.attachment.recovering

  if (record.replication.liveWriteInProgress && !recoveryActive) {
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
    record.replication.bootstrappingSnapshot = true
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

function scheduleLiveTerminalTransitionFlush(record: TerminalReplicationRecord) {
  if (record.resizeEffects.deferOutputFlush()) return
  if (record.replication.liveTransitionFlushScheduled) return
  record.replication.liveTransitionFlushScheduled = true
  queueMicrotask(() => {
    record.replication.liveTransitionFlushScheduled = false
    if (!record.disposed) flushQueuedTerminalOutput(record)
  })
}

function queuedTerminalOutputBatch(record: TerminalReplicationRecord) {
  return record.attachment.queuedOutputBatch()
}

function applyQueuedTerminalOutputBatch(
  record: TerminalReplicationRecord,
  events: TerminalReplayTransition[],
) {
  for (let index = 0; index < events.length; index += 1) {
    record.attachment.takeQueuedTransition()
  }
  const transitionData = events.map(event => (
    event.kind === 'clear' ? '\x1b[2J\x1b[3J\x1b[H' : event.data
  )).join('')
  record.replication.liveWriteInProgress = true
  writeTerminalOutput(record, transitionData, () => {
    if (record.disposed) return
    events.forEach(event => record.attachment.commitTransition(event))
    if (events.some(event => event.kind === 'clear')) {
      record.terminal.clearTerminalSelection?.()
    }
    record.replication.liveWriteInProgress = false
    if (record.followOutput && !record.hasUnreadOutput) {
      emitFollowOutputState(record)
    }
    record.interaction.scheduleImeOverlayUpdateIfActive()
    flushQueuedTerminalOutput(record)
    record.replicationPorts.notifyReady(record.attachment.generation)
  }, { isOutputObserved: () => record.replicationPorts.isAttached() })
}

export function flushQueuedTerminalOutput(record: TerminalReplicationRecord) {
  if (
    record.disposed ||
    record.replication.bootstrappingSnapshot ||
    record.replication.pendingSnapshotReplay ||
    record.replication.replayInProgress ||
    record.replication.checkpointRequestInFlight ||
    record.replication.liveWriteInProgress ||
    record.resizeEffects.isRedrawPending()
  ) return

  while (
    !record.replication.bootstrappingSnapshot &&
    !record.replication.replayInProgress &&
    !record.replication.checkpointRequestInFlight &&
    !record.replication.liveWriteInProgress &&
    !record.resizeEffects.isRedrawPending()
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

export function clearPendingTerminalReplication(record: TerminalReplicationRecord) {
  record.attachment.clearQueuedTransitions()
  record.replication.bootstrappingSnapshot = false
  record.replication.pendingSnapshotReplay = false
}

export function disposeTerminalReplication(record: TerminalReplicationRecord) {
  invalidateTerminalReplication(record)
  clearPendingTerminalReplication(record)
}

export function terminalReplicationBusy(record: TerminalReplicationRecord) {
  return record.replication.replayInProgress
    || record.replication.bootstrappingSnapshot
    || record.replication.pendingSnapshotReplay
}

export function terminalReplicationBlocksResizeNotification(record: TerminalReplicationRecord) {
  return record.replication.replayInProgress || record.replication.bootstrappingSnapshot
}

export function terminalReplicationBootstrapSettled(record: TerminalReplicationRecord) {
  return !record.replication.bootstrappingSnapshot && !record.replication.pendingSnapshotReplay
}

export function hasPendingTerminalSnapshot(record: TerminalReplicationRecord) {
  return record.replication.pendingSnapshotReplay
}

export function terminalReplicationDiagnostics(record: TerminalReplicationRecord) {
  return {
    terminalWriteBatchCount: record.replication.terminalWriteBatchCount,
    checkpointRequestInFlight: record.replication.checkpointRequestInFlight,
    checkpointRequestCount: record.replication.checkpointRequestCount,
    bootstrapRefreshSeq: record.replication.bootstrapRefreshSeq,
    replayInProgress: record.replication.replayInProgress,
    bootstrappingSnapshot: record.replication.bootstrappingSnapshot,
    pendingSnapshotReplay: record.replication.pendingSnapshotReplay,
    fixtureOverrideActive: record.replication.fixtureOverrideActive,
    pageOutputSuspended: record.replication.pageOutputSuspended,
    suppressOutputUntil: record.replication.suppressOutputUntil,
    needsReconnectOutputSync: record.replication.needsReconnectOutputSync,
  }
}

export function markTerminalReplicationInput(record: TerminalReplicationRecord) {
  record.replication.fixtureOverrideActive = false
}

export function requestTerminalResizeReplicationRecovery(record: TerminalReplicationRecord) {
  if (record.disposed) return
  invalidateTerminalReplication(record)
  record.attachment.resetRecovery()
  record.attachment.beginRecovery()
  record.replication.needsReconnectOutputSync = true
  record.replication.bootstrappingSnapshot = true
  if (record.replication.pageOutputSuspended || !record.replicationPorts.isAttached()) return
  requestTerminalReplay(record, record.attachment.generation)
}

export function resyncTerminalReplication(
  record: TerminalReplicationRecord,
  options: { forceResizeAfterRecovery?: boolean; resetLastNotifiedResize?: boolean } = {},
) {
  record.resizeEffects.beginRecovery({
    forceAfterRecovery: options.forceResizeAfterRecovery === true,
    resetLastNotified: options.resetLastNotifiedResize === true,
  })
  record.attachment.resetRecovery()
  record.attachment.beginRecovery()
  record.replication.needsReconnectOutputSync = true
  if (record.disposed || record.replication.pageOutputSuspended || !record.replicationPorts.isAttached()) return
  invalidateTerminalReplication(record)
  requestTerminalReplay(record, record.attachment.generation)
}

export function setTerminalReplicationPageSuspended(
  record: TerminalReplicationRecord,
  suspended: boolean,
) {
  record.replication.pageOutputSuspended = suspended
  if (suspended) {
    record.resizeEffects.beginRecovery()
    record.replication.needsReconnectOutputSync = true
    return
  }
  resyncTerminalReplication(record, {
    forceResizeAfterRecovery: true,
    resetLastNotifiedResize: true,
  })
}

export function beginTerminalAttachmentReplication(record: TerminalReplicationRecord) {
  invalidateTerminalReplication(record)
  record.attachment.resetRecovery()
  record.attachment.beginRecovery()
  record.replication.needsReconnectOutputSync = true
  record.replication.bootstrappingSnapshot = true
}

export function retryTerminalReplication(record: TerminalReplicationRecord) {
  invalidateTerminalReplication(record)
  record.resizeEffects.beginRecovery({ forceAfterRecovery: true })
  record.replication.pendingSnapshotReplay = false
  record.attachment.resetRecovery()
  record.attachment.beginRecovery()
  record.replication.needsReconnectOutputSync = true
  record.replication.bootstrappingSnapshot = true
  requestTerminalReplay(record, record.attachment.generation)
}

export function terminalReplicationCanMutateResize(record: TerminalReplicationRecord) {
  return !record.disposed
    && record.replicationPorts.isAttached()
    && !record.replication.replayInProgress
    && !record.replication.bootstrappingSnapshot
    && !record.replication.pageOutputSuspended
}

export function terminalReplicationCanFocus(record: TerminalReplicationRecord) {
  return !terminalReplicationBusy(record)
}

export function terminalReplicationReady(record: TerminalReplicationRecord) {
  return !record.replication.bootstrappingSnapshot
    && !record.replication.pendingSnapshotReplay
    && !record.replication.needsReconnectOutputSync
    && !record.replication.replayInProgress
    && !record.replication.liveWriteInProgress
    && record.attachment.queuedTransitionCount === 0
    && Boolean(record.attachment.runtimeEpoch)
    && record.attachment.outputSeq !== null
    && record.attachment.stateRevision !== null
}

export function finishTerminalAttachmentReplication(
  record: TerminalReplicationRecord,
  generation: number,
) {
  if (!isCurrentReplicationAttachment(record, generation)) return false
  if (
    record.replication.pendingSnapshotReplay
    && record.replication.snapshotRuntimeEpoch
    && record.replication.snapshotOutputSeq !== null
    && record.replication.snapshotStateRevision !== null
    && record.replication.snapshotCols !== null
    && record.replication.snapshotRows !== null
    && Date.now() >= record.replication.suppressOutputUntil
  ) {
    replayPendingSnapshot(record, generation)
    return true
  }
  if (record.replicationPorts.notifyReady(generation)) return true
  if (record.replication.replayInProgress || record.replication.checkpointRequestInFlight) return false
  record.replication.needsReconnectOutputSync = true
  requestTerminalReplay(record, generation)
  return false
}

export function canUpdateTerminalBootstrapState(record: TerminalReplicationRecord) {
  return record.replication.bootstrappingSnapshot || record.replication.needsReconnectOutputSync
}

export function setTerminalCheckpointInstallHeld(record: TerminalReplicationRecord, held: boolean) {
  record.replication.holdCheckpointInstallCompletionForTest = held
  if (!held) {
    const complete = record.replication.heldCheckpointInstallCompletionForTest
    record.replication.heldCheckpointInstallCompletionForTest = null
    complete?.()
  }
}

export async function writeTerminalReplicationFixture(record: TerminalReplicationRecord, text: string) {
  record.replication.bootstrapRefreshSeq += 1
  invalidateTerminalReplication(record)
  record.replication.snapshotOutput = ''
  record.replication.snapshotRuntimeEpoch = ''
  record.replication.snapshotOutputSeq = null
  record.replication.snapshotStateRevision = null
  record.replication.snapshotCols = null
  record.replication.snapshotRows = null
  record.attachment.resetRecovery({ keepCursor: false })
  record.replication.replayInProgress = false
  record.replication.liveWriteInProgress = false
  record.replication.pendingSnapshotReplay = false
  record.replication.bootstrappingSnapshot = false
  record.replication.needsReconnectOutputSync = false
  record.replication.fixtureOverrideActive = true
  record.replication.suppressOutputUntil = Date.now() + 1500
  record.interaction.reset?.()
  record.terminal.reset()
  record.terminal.viewportY = 0
  record.terminal.scrollToLine?.(0)
  await new Promise<void>(resolve => record.terminal.write(text, resolve))
  record.terminal.viewportY = 0
  record.terminal.scrollToLine?.(0)
  setFollowOutputState(record, isTerminalAtBottom(record), false, { allowClearUnread: true })
  forceTerminalRender(record)
}

export function resumeLiveTerminalReplication(record: TerminalReplicationRecord) {
  record.replication.fixtureOverrideActive = false
  record.replication.suppressOutputUntil = 0
  invalidateTerminalReplication(record)
  record.attachment.resetRecovery()
  record.attachment.beginRecovery()
  record.replication.needsReconnectOutputSync = true
  requestTerminalReplay(record, record.attachment.generation)
}
