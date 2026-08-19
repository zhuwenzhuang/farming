import { appPath } from '@/lib/base-path'
import {
  ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH,
  acpTranscriptFetchRetryDelayMs,
  acpTranscriptRefreshCoalesceDelayMs,
  acpTranscriptUnsettledRetryDelayMs,
} from '@/lib/transcript-fetch-policy'
import type { AcpSessionRevisionMessage } from '@/types/messages'
import type { AgentTranscript } from './acp-entry-projection'
import {
  mergeAcpTranscript,
  projectAcpTranscriptResponse,
} from './acp-transcript-envelope'

export const INITIAL_ACP_TRANSCRIPT_TURN_LIMIT = 5
export const ACP_TRANSCRIPT_TURN_PAGE_SIZE = 10
export const MAX_ACP_TRANSCRIPT_TURN_LIMIT = 1000

const MAX_CONCURRENT_TRANSCRIPT_READS = 3
const BACKGROUND_TRANSCRIPT_REFRESH_MS = 500

export interface AcpTranscriptSessionSnapshot {
  transcript: AgentTranscript | null
  loading: boolean
  loadingOlder: boolean
  error: 'transport' | 'response' | null
  turnLimit: number
}

interface AcpTranscriptSessionRecord {
  agentId: string
  snapshot: AcpTranscriptSessionSnapshot
  subscribers: Set<() => void>
  retained: boolean
  attachments: number
  controller: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
  timerDueAt: number
  requestGeneration: number
  inFlight: boolean
  queued: boolean
  refreshRequested: boolean
  requestedDelayMs: number
  forceCheckpoint: boolean
  latestSessionId: string
  latestRuntimeEpoch: string
  latestRevision: number
  lastLoadStartedAt: number
  retryAttempt: number
  unsettledRetryAttempt: number
}

const records = new Map<string, AcpTranscriptSessionRecord>()
const readQueue = new Set<AcpTranscriptSessionRecord>()
let activeReads = 0

function createRecord(agentId: string): AcpTranscriptSessionRecord {
  return {
    agentId,
    snapshot: {
      transcript: null,
      loading: true,
      loadingOlder: false,
      error: null,
      turnLimit: INITIAL_ACP_TRANSCRIPT_TURN_LIMIT,
    },
    subscribers: new Set(),
    retained: false,
    attachments: 0,
    controller: null,
    timer: null,
    timerDueAt: 0,
    requestGeneration: 0,
    inFlight: false,
    queued: false,
    refreshRequested: false,
    requestedDelayMs: Number.POSITIVE_INFINITY,
    forceCheckpoint: false,
    latestSessionId: '',
    latestRuntimeEpoch: '',
    latestRevision: -1,
    lastLoadStartedAt: Number.NEGATIVE_INFINITY,
    retryAttempt: 0,
    unsettledRetryAttempt: 0,
  }
}

function recordFor(agentId: string) {
  let record = records.get(agentId)
  if (!record) {
    record = createRecord(agentId)
    records.set(agentId, record)
  }
  return record
}

function updateSnapshot(
  record: AcpTranscriptSessionRecord,
  patch: Partial<AcpTranscriptSessionSnapshot>,
) {
  const next = { ...record.snapshot, ...patch }
  if (
    next.transcript === record.snapshot.transcript
    && next.loading === record.snapshot.loading
    && next.loadingOlder === record.snapshot.loadingOlder
    && next.error === record.snapshot.error
    && next.turnLimit === record.snapshot.turnLimit
  ) return
  record.snapshot = next
  record.subscribers.forEach(listener => listener())
}

function attachmentCheckpointPending(
  record: AcpTranscriptSessionRecord,
  transcript = record.snapshot.transcript,
) {
  const observedIdentityPending = Boolean(
    record.latestSessionId
    && record.latestRuntimeEpoch
    && (
      transcript?.envelopeVersion !== 1
      || transcript.sessionId !== record.latestSessionId
      || transcript.runtimeEpoch !== record.latestRuntimeEpoch
    )
  )
  return record.attachments > 0 && (record.forceCheckpoint || observedIdentityPending)
}

function clearRecordTimer(record: AcpTranscriptSessionRecord) {
  if (record.timer === null) return
  clearTimeout(record.timer)
  record.timer = null
  record.timerDueAt = 0
}

function disposeRecord(record: AcpTranscriptSessionRecord) {
  clearRecordTimer(record)
  readQueue.delete(record)
  record.queued = false
  record.requestGeneration += 1
  record.controller?.abort()
  record.controller = null
  records.delete(record.agentId)
}

function nextQueuedRecord() {
  let background: AcpTranscriptSessionRecord | null = null
  for (const record of readQueue) {
    if (record.attachments > 0) return record
    background ??= record
  }
  return background
}

function pumpReadQueue() {
  while (activeReads < MAX_CONCURRENT_TRANSCRIPT_READS) {
    const record = nextQueuedRecord()
    if (!record) return
    readQueue.delete(record)
    record.queued = false
    if ((!record.retained && record.attachments === 0) || record.inFlight) continue
    activeReads += 1
    void loadRecord(record).finally(() => {
      activeReads -= 1
      pumpReadQueue()
    })
  }
}

function queueRecord(record: AcpTranscriptSessionRecord) {
  if (record.inFlight) {
    record.refreshRequested = true
    return
  }
  if (record.queued) return
  record.queued = true
  readQueue.add(record)
  pumpReadQueue()
}

function scheduleRecord(
  record: AcpTranscriptSessionRecord,
  options: { immediate?: boolean; delayMs?: number } = {},
) {
  if (!record.retained && record.attachments === 0) return
  if (record.inFlight) {
    record.refreshRequested = true
    if (options.immediate || options.delayMs !== undefined) {
      const requestedDelay = options.immediate ? 0 : Number(options.delayMs)
      record.requestedDelayMs = Math.min(record.requestedDelayMs, requestedDelay)
    }
    return
  }
  if (options.immediate) {
    clearRecordTimer(record)
    queueRecord(record)
    return
  }
  const elapsed = performance.now() - record.lastLoadStartedAt
  const minimumDelay = record.attachments > 0
    ? acpTranscriptRefreshCoalesceDelayMs(elapsed)
    : Math.max(0, BACKGROUND_TRANSCRIPT_REFRESH_MS - elapsed)
  const delay = options.delayMs === undefined
    ? minimumDelay
    : Math.max(minimumDelay, options.delayMs)
  if (delay === 0) {
    queueRecord(record)
    return
  }
  const dueAt = performance.now() + delay
  if (record.timer !== null && record.timerDueAt <= dueAt) return
  clearRecordTimer(record)
  record.timerDueAt = dueAt
  record.timer = setTimeout(() => {
    record.timer = null
    record.timerDueAt = 0
    queueRecord(record)
  }, delay)
}

async function loadRecord(record: AcpTranscriptSessionRecord) {
  record.inFlight = true
  record.refreshRequested = false
  record.requestedDelayMs = Number.POSITIVE_INFINITY
  record.lastLoadStartedAt = performance.now()
  const generation = ++record.requestGeneration
  const controller = new AbortController()
  record.controller = controller
  const checkpointRequested = record.forceCheckpoint
  record.forceCheckpoint = false
  const current = record.snapshot.transcript
  const params = new URLSearchParams({
    maxTurns: String(record.snapshot.turnLimit),
    media: 'external-v1',
  })
  if (
    !checkpointRequested
    && current?.sessionId
    && current.turnLimit === record.snapshot.turnLimit
    && Number.isFinite(current.revision)
  ) {
    params.set('sinceRevision', String(current.revision))
  }
  let responseReceived = false
  try {
    const response = await fetch(appPath(
      `/api/agents/${encodeURIComponent(record.agentId)}/acp-transcript?${params.toString()}`,
    ), { signal: controller.signal })
    responseReceived = true
    if (!response.ok) throw new Error('Transcript unavailable')
    const payload = await response.json()
    if (generation !== record.requestGeneration) return
    record.retryAttempt = 0
    const nextTranscript = projectAcpTranscriptResponse(
      payload,
      record.agentId,
      { maxTurns: record.snapshot.turnLimit },
    )
    if (
      nextTranscript.envelopeVersion === 1
      && record.latestSessionId
      && record.latestRuntimeEpoch
      && (
        nextTranscript.sessionId !== record.latestSessionId
        || nextTranscript.runtimeEpoch !== record.latestRuntimeEpoch
      )
    ) {
      record.forceCheckpoint = true
      record.refreshRequested = true
      if (record.attachments > 0) {
        updateSnapshot(record, { loading: true, loadingOlder: false, error: null })
      }
      return
    }
    if (nextTranscript.envelopeVersion === 1) {
      record.latestSessionId = nextTranscript.sessionId
      record.latestRuntimeEpoch = nextTranscript.runtimeEpoch || ''
      record.latestRevision = Math.max(record.latestRevision, Number(nextTranscript.revision))
    }
    const mergeResult = mergeAcpTranscript(record.snapshot.transcript, nextTranscript)
    if (mergeResult.needsCheckpoint) {
      record.forceCheckpoint = true
      record.refreshRequested = true
      return
    }
    const merged = mergeResult.transcript
    if (nextTranscript?.envelopeVersion === 1 && !nextTranscript.settled) {
      const hasAuthoritativeTurns = Boolean(merged?.available && merged.turns.length > 0)
      if (hasAuthoritativeTurns) {
        updateSnapshot(record, {
          transcript: merged,
          loading: attachmentCheckpointPending(record, merged),
          loadingOlder: false,
          error: null,
        })
      } else {
        updateSnapshot(record, { loading: true, loadingOlder: false, error: null })
      }
      const retryDelay = acpTranscriptUnsettledRetryDelayMs(
        record.unsettledRetryAttempt,
        hasAuthoritativeTurns,
      )
      if (retryDelay !== undefined) {
        record.unsettledRetryAttempt = Math.min(
          record.unsettledRetryAttempt + 1,
          ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH,
        )
        scheduleRecord(record, { delayMs: retryDelay })
      } else {
        record.unsettledRetryAttempt = 0
        const checkpointPending = attachmentCheckpointPending(record)
        updateSnapshot(record, {
          loading: checkpointPending,
          loadingOlder: false,
          error: checkpointPending || hasAuthoritativeTurns ? null : 'response',
        })
      }
      return
    }
    record.unsettledRetryAttempt = 0
    updateSnapshot(record, {
      transcript: merged,
      loading: attachmentCheckpointPending(record, merged),
      loadingOlder: false,
      error: null,
    })
  } catch (reason) {
    if (generation !== record.requestGeneration || (reason as { name?: string })?.name === 'AbortError') return
    const retryDelay = !responseReceived && reason instanceof TypeError
      ? acpTranscriptFetchRetryDelayMs(record.retryAttempt)
      : undefined
    if (retryDelay !== undefined) {
      record.retryAttempt += 1
      scheduleRecord(record, { delayMs: retryDelay })
      return
    }
    record.retryAttempt = 0
    const checkpointPending = attachmentCheckpointPending(record)
    updateSnapshot(record, {
      loading: checkpointPending,
      loadingOlder: false,
      error: checkpointPending || record.snapshot.transcript?.available
        ? null
        : (responseReceived ? 'response' : 'transport'),
    })
  } finally {
    if (generation === record.requestGeneration) {
      record.inFlight = false
      record.controller = null
      const revision = Number(record.snapshot.transcript?.revision)
      const transcriptIdentityIsCurrent = Boolean(
        record.snapshot.transcript?.envelopeVersion === 1
        && record.snapshot.transcript.sessionId === record.latestSessionId
        && record.snapshot.transcript.runtimeEpoch === record.latestRuntimeEpoch
      )
      if (
        record.refreshRequested
        || record.forceCheckpoint
        || (
          transcriptIdentityIsCurrent
          && Number.isInteger(record.latestRevision)
          && record.latestRevision > revision
        )
      ) {
        const requestedDelay = record.requestedDelayMs
        record.requestedDelayMs = Number.POSITIVE_INFINITY
        scheduleRecord(record, {
          immediate: record.forceCheckpoint || requestedDelay === 0,
          ...(Number.isFinite(requestedDelay) && requestedDelay > 0
            ? { delayMs: requestedDelay }
            : {}),
        })
      }
    }
  }
}

export function retainAcpTranscriptSessions(agentIds: readonly string[]) {
  const retained = new Set(agentIds)
  for (const agentId of retained) recordFor(agentId).retained = true
  for (const record of records.values()) record.retained = retained.has(record.agentId)
  for (const record of [...records.values()]) {
    if (!record.retained && record.attachments === 0) disposeRecord(record)
  }
}

export function observeAcpTranscriptRevision(
  session: AcpSessionRevisionMessage['session'],
) {
  const record = records.get(session.agentId)
  if (!record || (!record.retained && record.attachments === 0)) return
  const current = record.snapshot.transcript
  const previousSessionId = record.latestSessionId
    || (current?.envelopeVersion === 1 ? current.sessionId : '')
  const previousRuntimeEpoch = record.latestRuntimeEpoch
    || (current?.envelopeVersion === 1 ? current.runtimeEpoch || '' : '')
  const identityChanged = Boolean(
    previousSessionId
    && previousRuntimeEpoch
    && (
      previousSessionId !== session.sessionId
      || previousRuntimeEpoch !== session.runtimeEpoch
    )
  )
  record.latestSessionId = session.sessionId
  record.latestRuntimeEpoch = session.runtimeEpoch
  record.latestRevision = identityChanged
    ? session.revision
    : Math.max(record.latestRevision, session.revision)
  const currentIdentityMatches = Boolean(
    current?.envelopeVersion === 1
    && current.sessionId === session.sessionId
    && current.runtimeEpoch === session.runtimeEpoch
  )
  const initialCheckpointInFlight = record.inFlight && current === null
  if (identityChanged || (!currentIdentityMatches && !initialCheckpointInFlight)) {
    record.forceCheckpoint = true
    if (record.attachments > 0) {
      updateSnapshot(record, { loading: true, loadingOlder: false, error: null })
    }
    scheduleRecord(record, { immediate: true })
    return
  }
  const currentRevision = Number(record.snapshot.transcript?.revision)
  if (!Number.isInteger(currentRevision) || session.revision > currentRevision) {
    scheduleRecord(record)
  }
}

export function attachAcpTranscriptSession(agentId: string) {
  const record = recordFor(agentId)
  const current = record.snapshot.transcript
  const canReuseRetainedTranscript = Boolean(
    record.retained
    && !record.forceCheckpoint
    && current?.envelopeVersion === 1
    && current.sessionId === record.latestSessionId
    && current.runtimeEpoch === record.latestRuntimeEpoch
  )
  record.attachments += 1
  if (canReuseRetainedTranscript) {
    updateSnapshot(record, { loading: false, loadingOlder: false, error: null })
    if (
      !record.inFlight
      && Number.isInteger(record.latestRevision)
      && record.latestRevision > Number(current?.revision)
    ) {
      scheduleRecord(record, { immediate: true })
    }
  } else {
    record.forceCheckpoint = true
    updateSnapshot(record, { loading: true, loadingOlder: false, error: null })
    scheduleRecord(record, { immediate: true })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    record.attachments = Math.max(0, record.attachments - 1)
    if (!record.retained && record.attachments === 0) disposeRecord(record)
  }
}

export function subscribeAcpTranscriptSession(agentId: string, listener: () => void) {
  const record = recordFor(agentId)
  record.subscribers.add(listener)
  return () => { record.subscribers.delete(listener) }
}

export function getAcpTranscriptSessionSnapshot(agentId: string) {
  return recordFor(agentId).snapshot
}

export function refreshAcpTranscriptSession(agentId: string, checkpoint = false) {
  const record = recordFor(agentId)
  record.forceCheckpoint ||= checkpoint
  scheduleRecord(record, { immediate: checkpoint })
}

export function reconnectAcpTranscriptSessions() {
  for (const record of records.values()) {
    if (!record.retained && record.attachments === 0) continue
    record.latestSessionId = ''
    record.latestRuntimeEpoch = ''
    record.latestRevision = -1
    record.forceCheckpoint = true
    if (record.attachments > 0) {
      updateSnapshot(record, { loading: true, loadingOlder: false, error: null })
    }
    scheduleRecord(record, { immediate: true })
  }
}

export function setAcpTranscriptTurnLimit(agentId: string, turnLimit: number) {
  const record = recordFor(agentId)
  const normalized = Math.max(
    INITIAL_ACP_TRANSCRIPT_TURN_LIMIT,
    Math.min(MAX_ACP_TRANSCRIPT_TURN_LIMIT, Math.floor(turnLimit)),
  )
  if (normalized === record.snapshot.turnLimit) return
  record.forceCheckpoint = true
  updateSnapshot(record, { turnLimit: normalized, loadingOlder: true, error: null })
  scheduleRecord(record, { immediate: true })
}

export function resetAcpTranscriptSessionPoolForTests() {
  for (const record of [...records.values()]) disposeRecord(record)
  readQueue.clear()
}
