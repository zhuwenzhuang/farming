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
  preserveCompletedTranscriptTurns,
} from './acp-transcript-envelope'

export const INITIAL_ACP_TRANSCRIPT_TURN_LIMIT = 5
export const ACP_TRANSCRIPT_TURN_PAGE_SIZE = 10
export const MAX_ACP_TRANSCRIPT_TURN_LIMIT = 1000

const MAX_CONCURRENT_TRANSCRIPT_READS = 3
export const ACP_TRANSCRIPT_READ_TIMEOUT_MS = 15_000
export const ACP_TRANSCRIPT_QUEUE_TIMEOUT_MS = 30_000
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
  pendingPageCursor: string
  snapshot: AcpTranscriptSessionSnapshot
  subscribers: Set<() => void>
  retained: boolean
  attachments: number
  controller: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
  timerDueAt: number
  queueDeadline: ReturnType<typeof setTimeout> | null
  requestGeneration: number
  readEpoch: number
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
    pendingPageCursor: '',
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
    queueDeadline: null,
    requestGeneration: 0,
    readEpoch: 0,
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

function transcriptIdentityIsCurrent(
  record: AcpTranscriptSessionRecord,
  transcript = record.snapshot.transcript,
) {
  if (!transcript) return false
  if (!record.latestSessionId || !record.latestRuntimeEpoch) return true
  return Boolean(
    transcript.envelopeVersion === 1
    && transcript.sessionId === record.latestSessionId
    && transcript.runtimeEpoch === record.latestRuntimeEpoch
  )
}

function currentTranscriptIsDisplayable(record: AcpTranscriptSessionRecord) {
  return Boolean(
    record.snapshot.transcript?.available
    && transcriptIdentityIsCurrent(record)
  )
}

function clearRecordTimer(record: AcpTranscriptSessionRecord) {
  if (record.timer === null) return
  clearTimeout(record.timer)
  record.timer = null
  record.timerDueAt = 0
}

function clearQueueDeadline(record: AcpTranscriptSessionRecord) {
  if (record.queueDeadline !== null) clearTimeout(record.queueDeadline)
  record.queueDeadline = null
}

function invalidateRead(record: AcpTranscriptSessionRecord) {
  record.readEpoch += 1
  record.controller?.abort()
}

function disposeRecord(record: AcpTranscriptSessionRecord) {
  clearRecordTimer(record)
  clearQueueDeadline(record)
  readQueue.delete(record)
  record.queued = false
  record.requestGeneration += 1
  record.controller?.abort()
  record.controller = null
  records.delete(record.agentId)
}

function nextQueuedRecord() {
  // FIFO prevents a stream of foreground refreshes starving retained sessions.
  return readQueue.values().next().value as AcpTranscriptSessionRecord | undefined
}

function pumpReadQueue() {
  while (activeReads < MAX_CONCURRENT_TRANSCRIPT_READS) {
    const record = nextQueuedRecord()
    if (!record) return
    readQueue.delete(record)
    clearQueueDeadline(record)
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
  record.queueDeadline = setTimeout(() => {
    readQueue.delete(record)
    record.queued = false
    record.queueDeadline = null
    record.pendingPageCursor = ''
    record.forceCheckpoint = false
    record.refreshRequested = false
    updateSnapshot(record, { loading: false, loadingOlder: false, error: 'transport' })
  }, ACP_TRANSCRIPT_QUEUE_TIMEOUT_MS)
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

function retryRequiredCheckpoint(record: AcpTranscriptSessionRecord) {
  record.pendingPageCursor = ''
  if (record.snapshot.transcript?.historyPage) {
    record.forceCheckpoint = false
    record.refreshRequested = false
    updateSnapshot(record, { loading: false, loadingOlder: false, error: 'response' })
    return
  }
  const retryDelay = acpTranscriptUnsettledRetryDelayMs(record.unsettledRetryAttempt, false)
  if (retryDelay !== undefined) {
    record.unsettledRetryAttempt = Math.min(
      record.unsettledRetryAttempt + 1,
      ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH,
    )
    record.forceCheckpoint = true
    updateSnapshot(record, {
      transcript: transcriptIdentityIsCurrent(record) ? record.snapshot.transcript : null,
      loading: !currentTranscriptIsDisplayable(record),
      loadingOlder: false,
      error: null,
    })
    scheduleRecord(record, { delayMs: retryDelay })
    return
  }

  record.unsettledRetryAttempt = 0
  record.forceCheckpoint = false
  record.refreshRequested = false
  updateSnapshot(record, {
    transcript: transcriptIdentityIsCurrent(record) ? record.snapshot.transcript : null,
    loading: false,
    loadingOlder: false,
    error: 'response',
  })
}

async function loadRecord(record: AcpTranscriptSessionRecord) {
  record.inFlight = true
  record.refreshRequested = false
  record.requestedDelayMs = Number.POSITIVE_INFINITY
  record.lastLoadStartedAt = performance.now()
  const generation = ++record.requestGeneration
  const readEpoch = record.readEpoch
  const controller = new AbortController()
  record.controller = controller
  let timedOut = false
  let expire!: (error: Error) => void
  const expired = new Promise<never>((_, reject) => { expire = reject })
  const deadline = setTimeout(() => {
    timedOut = true
    controller.abort()
    expire(new Error('Transcript read deadline exceeded'))
  }, ACP_TRANSCRIPT_READ_TIMEOUT_MS)
  const pageCursor = record.pendingPageCursor
  record.pendingPageCursor = ''
  const historyPageRequested = Boolean(pageCursor)
  const checkpointRequested = record.forceCheckpoint
  record.forceCheckpoint = false
  const current = record.snapshot.transcript
  const params = new URLSearchParams({
    maxTurns: String(pageCursor ? ACP_TRANSCRIPT_TURN_PAGE_SIZE : record.snapshot.turnLimit),
    media: 'external-v1',
    entryPatches: 'v1',
    ...(pageCursor ? { cursor: pageCursor } : {}),
  })
  if (
    !checkpointRequested
    && !pageCursor
    && current?.sessionId
    && current.turnLimit === record.snapshot.turnLimit
    && Number.isFinite(current.revision)
  ) {
    params.set('sinceRevision', String(current.revision))
  }
  let responseReceived = false
  try {
    const response = await Promise.race([expired, fetch(appPath(
      `/api/agents/${encodeURIComponent(record.agentId)}/acp-transcript?${params.toString()}`,
    ), { signal: controller.signal })])
    if (generation !== record.requestGeneration || readEpoch !== record.readEpoch) return
    responseReceived = true
    if (response.status === 202) {
      updateSnapshot(record, {
        transcript: transcriptIdentityIsCurrent(record) ? record.snapshot.transcript : null,
        loading: !currentTranscriptIsDisplayable(record),
        loadingOlder: false,
        error: null,
      })
      const retryDelay = acpTranscriptUnsettledRetryDelayMs(record.unsettledRetryAttempt, false)
      if (retryDelay !== undefined) {
        record.unsettledRetryAttempt = Math.min(
          record.unsettledRetryAttempt + 1,
          ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH,
        )
        record.forceCheckpoint ||= checkpointRequested
        record.pendingPageCursor ||= pageCursor
        scheduleRecord(record, { delayMs: retryDelay })
      } else {
        // A 202 without any authoritative Turns is a transient state, but it
        // still needs a bounded terminal outcome. Leaving `loading` true after
        // the retry ladder makes the Pane spin forever with no future trigger.
        record.pendingPageCursor = ''
        record.unsettledRetryAttempt = 0
        record.forceCheckpoint = false
        record.refreshRequested = false
        updateSnapshot(record, {
          transcript: transcriptIdentityIsCurrent(record) ? record.snapshot.transcript : null,
          loading: false,
          loadingOlder: false,
          error: 'response',
        })
      }
      return
    }
    if (!response.ok) throw new Error('Transcript unavailable')
    const payload = await Promise.race([expired, response.json()])
    if (generation !== record.requestGeneration || readEpoch !== record.readEpoch) return
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
      retryRequiredCheckpoint(record)
      return
    }
    if (nextTranscript.envelopeVersion === 1) {
      record.latestSessionId = nextTranscript.sessionId
      record.latestRuntimeEpoch = nextTranscript.runtimeEpoch || ''
      record.latestRevision = Math.max(record.latestRevision, Number(nextTranscript.revision))
    }
    if (checkpointRequested && !historyPageRequested && nextTranscript.envelopeVersion === 1 && !nextTranscript.replace) {
      retryRequiredCheckpoint(record)
      return
    }
    const mergeResult = mergeAcpTranscript(record.snapshot.transcript, nextTranscript, {
      replaceHistory: checkpointRequested && !historyPageRequested,
    })
    if (mergeResult.needsCheckpoint || (
      checkpointRequested && !historyPageRequested && !mergeResult.accepted
      && record.snapshot.transcript?.includesLatest === false
    )) {
      retryRequiredCheckpoint(record)
      return
    }
    const merged = preserveCompletedTranscriptTurns(record.snapshot.transcript, mergeResult.transcript)
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
        false,
      )
      if (retryDelay !== undefined) {
        record.unsettledRetryAttempt = Math.min(
          record.unsettledRetryAttempt + 1,
          ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH,
        )
        scheduleRecord(record, { delayMs: retryDelay })
      } else {
        record.unsettledRetryAttempt = 0
        record.refreshRequested = false
        updateSnapshot(record, {
          loading: false,
          loadingOlder: false,
          error: 'response',
        })
      }
      return
    }
    if (!historyPageRequested && merged?.includesLatest !== false
      && Number(merged?.revision) <= Number(current?.revision)
      && record.latestRevision > Number(merged?.revision)) {
      retryRequiredCheckpoint(record)
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
    if (generation !== record.requestGeneration
      || readEpoch !== record.readEpoch
      || (!timedOut && (reason as { name?: string })?.name === 'AbortError')) return
    // Transcript reads are read-only. One timed-out checkpoint may be retried
    // after a brief delay while the Host finishes recovery or a large projection.
    const retryDelay = timedOut && record.retryAttempt === 0
      ? acpTranscriptFetchRetryDelayMs(0)
      : !responseReceived && reason instanceof TypeError
        ? acpTranscriptFetchRetryDelayMs(record.retryAttempt)
        : undefined
    if (retryDelay !== undefined) {
      record.retryAttempt += 1
      record.forceCheckpoint ||= checkpointRequested
      record.pendingPageCursor ||= pageCursor
      scheduleRecord(record, { delayMs: retryDelay })
      return
    }
    record.retryAttempt = 0
    record.pendingPageCursor = ''
    const hasDisplayableTranscript = currentTranscriptIsDisplayable(record)
    updateSnapshot(record, {
      transcript: hasDisplayableTranscript ? record.snapshot.transcript : null,
      loading: false,
      loadingOlder: false,
      error: responseReceived && !timedOut ? 'response' : 'transport',
    })
  } finally {
    clearTimeout(deadline)
    if (generation === record.requestGeneration) {
      record.inFlight = false
      record.controller = null
      const revision = Number(record.snapshot.transcript?.revision)
      const currentTranscriptMatchesIdentity = transcriptIdentityIsCurrent(record)
      if (
        historyPageRequested
        && record.snapshot.transcript?.includesLatest !== false
        && record.snapshot.error !== null
        && currentTranscriptMatchesIdentity
        && Number.isInteger(record.latestRevision)
        && record.latestRevision > revision
      ) {
        // The page failed after a newer live revision was observed. Retry the
        // latest view once; another failure remains terminal and visible.
        record.forceCheckpoint = true
      }
      if (record.snapshot.transcript?.includesLatest === false && !record.forceCheckpoint && !record.pendingPageCursor) {
        record.refreshRequested = false
      }
      if (
        record.refreshRequested
        || record.forceCheckpoint
        || (
          record.snapshot.error === null
          && record.snapshot.transcript?.includesLatest !== false
          && !record.pendingPageCursor
          && currentTranscriptMatchesIdentity
          && Number.isInteger(record.latestRevision)
          && record.latestRevision > revision
        )
      ) {
        const requestedDelay = record.requestedDelayMs
        record.requestedDelayMs = Number.POSITIVE_INFINITY
        scheduleRecord(record, {
          immediate: requestedDelay === 0 || (
            record.forceCheckpoint && !Number.isFinite(requestedDelay)
          ),
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
    if (identityChanged) {
      record.pendingPageCursor = ''
      updateSnapshot(record, {
        transcript: null,
        loading: record.attachments > 0,
        loadingOlder: false,
        error: null,
      })
    } else if (record.attachments > 0) {
      updateSnapshot(record, { loading: true, loadingOlder: false, error: null })
    }
    scheduleRecord(record, { immediate: true })
    return
  }
  if (current?.includesLatest === false) return
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
    if (current?.includesLatest === false) return releaseAttachment(record)
    if (
      !record.inFlight
      && Number.isInteger(record.latestRevision)
      && record.latestRevision > Number(current?.revision)
    ) {
      scheduleRecord(record, { immediate: true })
    } else if (current?.turns[current.turns.length - 1]?.status === 'inProgress') {
      // A completion revision can be missed while this Chat is detached.
      // Revalidate an unfinished Turn before keeping its running state visible.
      record.forceCheckpoint = true
      scheduleRecord(record, { immediate: true })
    }
  } else {
    record.forceCheckpoint = true
    updateSnapshot(record, { loading: true, loadingOlder: false, error: null })
    scheduleRecord(record, { immediate: true })
  }
  return releaseAttachment(record)
}

function releaseAttachment(record: AcpTranscriptSessionRecord) {
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
  if (!checkpoint && record.snapshot.transcript?.includesLatest === false) return
  record.forceCheckpoint ||= checkpoint
  if (checkpoint) {
    invalidateRead(record)
    record.pendingPageCursor = ''
    // Explicit retry is a new bounded read attempt. Clear the previous
    // terminal presentation immediately, and do not inherit an exhausted
    // retry ladder from the failed attempt.
    record.retryAttempt = 0
    record.unsettledRetryAttempt = 0
    if (record.attachments > 0) {
      updateSnapshot(record, { loading: true, loadingOlder: false, error: null })
    }
  }
  scheduleRecord(record, { immediate: checkpoint })
}

export function returnToLatestAcpTranscript(agentId: string) {
  const record = recordFor(agentId)
  invalidateRead(record)
  record.pendingPageCursor = ''
  record.forceCheckpoint = true
  updateSnapshot(record, { turnLimit: INITIAL_ACP_TRANSCRIPT_TURN_LIMIT, loading: true, loadingOlder: false })
  scheduleRecord(record, { immediate: true })
}

export function discardAcpTranscriptSession(agentId: string) {
  const record = records.get(agentId)
  if (record) disposeRecord(record)
}

export function reconnectAcpTranscriptSessions() {
  for (const record of records.values()) {
    if (!record.retained && record.attachments === 0) continue
    invalidateRead(record)
    record.pendingPageCursor = ''
    if (record.snapshot.transcript?.includesLatest === false) {
      // Keep the historical reading position. Agent control state reconnects
      // independently; explicit Return to latest obtains a fresh body snapshot.
      record.forceCheckpoint = false
      record.refreshRequested = false
      updateSnapshot(record, { loading: false, loadingOlder: false })
      continue
    }
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
  invalidateRead(record)
  if (normalized > record.snapshot.turnLimit && record.snapshot.transcript?.entrySnapshot && record.snapshot.transcript.nextCursor) {
    record.pendingPageCursor = record.snapshot.transcript.nextCursor
  }
  record.forceCheckpoint = true
  updateSnapshot(record, { turnLimit: normalized, loadingOlder: true, error: null })
  scheduleRecord(record, { immediate: true })
}

export function resetAcpTranscriptSessionPoolForTests() {
  for (const record of [...records.values()]) disposeRecord(record)
  readQueue.clear()
}
