import {
  projectAcpTranscript,
  type AgentTranscript,
  type AgentTranscriptTurn,
} from './acp-entry-projection'

export const MAX_LOADED_ACP_ENTRIES = 2048

type DataRecord = Record<string, unknown>

function record(value: unknown): DataRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as DataRecord
    : {}
}

function transcriptTurnStart(entry: DataRecord): boolean {
  if (entry.type !== 'message' || entry.role !== 'user' || entry.internalScope === 'entry') return false
  const meta = record(entry._meta)
  return record(meta.farming).steer !== true && record(meta.codex).steer !== true
}

function boundedEntryOrder(
  order: string[],
  entries: Map<string, DataRecord>,
  turnLimit: number,
) {
  let remaining = Math.max(1, Math.floor(turnLimit))
  for (let index = order.length - 1; index > 0; index -= 1) {
    if (!transcriptTurnStart(entries.get(order[index]!) || {})) continue
    remaining -= 1
    if (remaining === 0) {
      order = order.slice(index)
      break
    }
  }
  if (order.length <= MAX_LOADED_ACP_ENTRIES) return order
  const suffix = order.slice(-(MAX_LOADED_ACP_ENTRIES - 1))
  const anchor = order.slice(0, order.length - suffix.length).reverse()
    .find(id => transcriptTurnStart(entries.get(id) || {}))
  return anchor ? [anchor, ...suffix] : order.slice(-MAX_LOADED_ACP_ENTRIES)
}

function coveredStart(transcript: AgentTranscript): string | null {
  const patch = record(transcript.entrySnapshot?.session.entryPatch)
  return typeof patch.startId === 'string' ? patch.startId
    : transcript.nextCursor || transcript.entrySnapshot?.order[0] || null
}

function projectedValueUnchanged(current: unknown, next: unknown): boolean {
  if (Object.is(current, next)) return true
  if (!current || !next || typeof current !== 'object' || typeof next !== 'object') return false
  if (Array.isArray(current) || Array.isArray(next)) {
    return Array.isArray(current)
      && Array.isArray(next)
      && current.length === next.length
      && current.every((value, index) => projectedValueUnchanged(value, next[index]))
  }
  const currentRecord = current as Record<string, unknown>
  const nextRecord = next as Record<string, unknown>
  const currentKeys = Object.keys(currentRecord)
  const nextKeys = Object.keys(nextRecord)
  return currentKeys.length === nextKeys.length
    && currentKeys.every(key => (
      Object.prototype.hasOwnProperty.call(nextRecord, key)
      && projectedValueUnchanged(currentRecord[key], nextRecord[key])
    ))
}

function completedTranscriptTurnUnchanged(
  current: AgentTranscriptTurn,
  next: AgentTranscriptTurn,
) {
  return current.status !== 'inProgress'
    && next.status !== 'inProgress'
    && projectedValueUnchanged(current, next)
}

export function preserveCompletedTranscriptTurns(
  current: AgentTranscript | null,
  next: AgentTranscript | null,
) {
  if (!current || !next || current.sessionId !== next.sessionId) return next
  const completedTurns = new Map(
    current.turns
      .filter(turn => turn.status !== 'inProgress')
      .map(turn => [turn.id, turn]),
  )
  return {
    ...next,
    turns: next.turns.map(turn => {
      const completedTurn = completedTurns.get(turn.id)
      return completedTurn && completedTranscriptTurnUnchanged(completedTurn, turn)
        ? completedTurn
        : turn
    }),
  }
}

// A delta's leading omission is relative to its update window, not the loaded
// conversation. Only replacing a checkpoint or evicting loaded Turns changes
// whether the browser still has older history to request.
function legacyMergeAcpTranscript(
  current: AgentTranscript | null,
  next: AgentTranscript | null,
) {
  if (
    current
    && next
    && current.sessionId === next.sessionId
    && typeof current.revision === 'number'
    && typeof next.revision === 'number'
    && next.revision < current.revision
  ) return current
  if (!next?.delta) return preserveCompletedTranscriptTurns(current, next)
  if (!current || current.sessionId !== next.sessionId) return next
  if (!next.replaceFromTurnId || next.turns.length === 0) {
    return {
      ...current,
      ...next,
      available: current.available,
      hasMoreBefore: current.hasMoreBefore,
      turns: current.turns,
    }
  }
  const replaceIndex = current.turns.findIndex(turn => turn.id === next.replaceFromTurnId)
  if (replaceIndex < 0) {
    const currentIds = new Set(current.turns.map(turn => turn.id))
    const appended = next.turns.filter(turn => !currentIds.has(turn.id))
    const mergedTurns = [...current.turns, ...appended]
    const boundedTurns = current.turnLimit && mergedTurns.length > current.turnLimit
      ? mergedTurns.slice(-current.turnLimit)
      : mergedTurns
    return preserveCompletedTranscriptTurns(current, {
      ...current,
      ...next,
      available: current.available || next.available,
      hasMoreBefore: current.hasMoreBefore || boundedTurns.length < mergedTurns.length,
      turns: boundedTurns,
    })
  }
  return preserveCompletedTranscriptTurns(current, {
    ...next,
    available: current.available || next.available,
    hasMoreBefore: current.hasMoreBefore,
    turns: [...current.turns.slice(0, replaceIndex), ...next.turns],
  })
}

export function projectAcpTranscriptResponse(
  payloadValue: unknown,
  expectedAgentId: string,
  options: { maxTurns?: number } = {},
) {
  const payload = record(payloadValue)
  if (payload.version !== 1) {
    return projectAcpTranscript(payload.transcript, options)
  }

  const transcriptValue = record(payload.transcript)
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const runtimeEpoch = typeof payload.runtimeEpoch === 'string' ? payload.runtimeEpoch : ''
  const toRevision = Number(payload.toRevision)
  const fromRevision = payload.fromRevision === null ? null : Number(payload.fromRevision)
  const replace = payload.replace === true
  const settled = payload.settled === true
  const validFromRevision = replace
    ? fromRevision === null
    : Number.isInteger(fromRevision) && Number(fromRevision) >= 0
  if (
    !agentId
    || agentId !== expectedAgentId
    || !sessionId
    || !runtimeEpoch
    || !Number.isInteger(toRevision)
    || toRevision < 0
    || !validFromRevision
    || (!replace && Number(fromRevision) > toRevision)
    || typeof payload.replace !== 'boolean'
    || typeof payload.settled !== 'boolean'
    || String(transcriptValue.sessionId || '') !== sessionId
    || Number(transcriptValue.revision) !== toRevision
  ) {
    throw new Error('Invalid ACP transcript checkpoint')
  }

  const patch = record(transcriptValue.entryPatch)
  const entrySnapshot = patch.version === 1 && Array.isArray(patch.order) && patch.order.length <= 257
    && patch.order.every(id => typeof id === 'string') && new Set(patch.order).size === patch.order.length
    ? { session: transcriptValue, entries: (Array.isArray(transcriptValue.entries) ? transcriptValue.entries : []).map(record), order: patch.order as string[] }
    : undefined
  if (transcriptValue.entryPatch && !entrySnapshot) throw new Error('Invalid ACP entry patch')
  if (entrySnapshot) {
    const ids = entrySnapshot.entries.map(entry => String(entry.id || ''))
    const order = new Set(entrySnapshot.order)
    if (new Set(ids).size !== ids.length || ids.some(id => !id || !order.has(id))
      || (replace && ids.length !== order.size)
      || (typeof patch.startId === 'string' && !order.has(patch.startId))) {
      throw new Error('Invalid ACP entry coverage')
    }
  }
  return {
    ...projectAcpTranscript(transcriptValue, options),
    ...(entrySnapshot ? { entrySnapshot, historyPage: typeof patch.pageCursor === 'string' } : {}),
    agentId,
    runtimeEpoch,
    fromRevision,
    revision: toRevision,
    delta: !replace,
    replace,
    settled,
    envelopeVersion: 1,
    hasMoreBefore: payload.hasMoreBefore === true,
  } satisfies AgentTranscript
}

export interface AcpTranscriptMergeResult {
  transcript: AgentTranscript | null
  accepted: boolean
  needsCheckpoint: boolean
}

function mergeAcpTranscriptHistoryPage(
  current: AgentTranscript,
  next: AgentTranscript,
): AgentTranscript {
  const turnLimit = next.turnLimit || current.turnLimit || 80
  if (!current.entrySnapshot || !next.entrySnapshot) {
    const turns = new Map(next.turns.map(turn => [turn.id, turn]))
    current.turns.forEach(turn => turns.set(turn.id, turn))
    return preserveCompletedTranscriptTurns(current, {
      ...current,
      ...next,
      // An older page does not contain the latest Turn, even if the backend
      // reached a newer revision before producing this page.
      revision: current.revision,
      turns: [...turns.values()].slice(-turnLimit),
    })!
  }

  const entries = new Map(next.entrySnapshot.entries.map(entry => [String(entry.id), entry]))
  current.entrySnapshot.entries.forEach(entry => entries.set(String(entry.id), entry))
  const mergedOrder = [...new Set([
    ...next.entrySnapshot.order,
    ...current.entrySnapshot.order,
  ])]
  // Older reads grow towards the past. At capacity evict the newest content
  // and stop claiming that this contiguous window contains the live tail.
  const order = mergedOrder.slice(0, MAX_LOADED_ACP_ENTRIES)
  const includesLatest = current.includesLatest !== false && order.length === mergedOrder.length
  const ordered = order.map(id => entries.get(id)).filter((entry): entry is DataRecord => Boolean(entry))
  const nextSession = next.entrySnapshot.session
  const currentSession = current.entrySnapshot.session
  const revision = Number(current.revision)
  const session = {
    ...nextSession,
    ...currentSession,
    revision,
    includesLatest,
    entries: ordered,
    nextCursor: nextSession.nextCursor,
    hasMoreBefore: nextSession.hasMoreBefore,
    entryPatch: {
      ...record(nextSession.entryPatch),
      pageCursor: null,
      order,
    },
  }
  const projected = projectAcpTranscript(session, { maxTurns: turnLimit })
  return preserveCompletedTranscriptTurns(current, {
    ...current,
    ...next,
    ...projected,
    revision,
    entrySnapshot: { session, entries: ordered, order },
    historyPage: true,
  })!
}

export function mergeAcpTranscript(
  current: AgentTranscript | null,
  next: AgentTranscript | null,
  options: { replaceHistory?: boolean } = {},
): AcpTranscriptMergeResult {
  if (next?.envelopeVersion !== 1) {
    return {
      transcript: legacyMergeAcpTranscript(current, next),
      accepted: true,
      needsCheckpoint: false,
    }
  }

  if (current?.includesLatest === false && !next.historyPage && !options.replaceHistory) {
    return { transcript: current, accepted: false, needsCheckpoint: false }
  }

  if (next.replace) {
    if (
      next.historyPage
      && current?.envelopeVersion === 1
      && current.agentId === next.agentId
      && current.sessionId === next.sessionId
      && current.runtimeEpoch === next.runtimeEpoch
    ) {
      const cursor = record(next.entrySnapshot?.session.entryPatch).pageCursor
      if (cursor !== current.nextCursor || Number(next.revision) < Number(current.revision)) {
        return { transcript: current, accepted: false, needsCheckpoint: true }
      }
      return {
        transcript: mergeAcpTranscriptHistoryPage(current, next),
        accepted: true,
        needsCheckpoint: false,
      }
    }
    if (
      current?.envelopeVersion === 1
      && current.agentId === next.agentId
      && current.sessionId === next.sessionId
      && current.runtimeEpoch === next.runtimeEpoch
      && Number(next.revision) < Number(current.revision)
    ) {
      return { transcript: current, accepted: false, needsCheckpoint: false }
    }
    return {
      transcript: preserveCompletedTranscriptTurns(current, next),
      accepted: true,
      needsCheckpoint: false,
    }
  }

  if (
    current?.envelopeVersion !== 1
    || current.agentId !== next.agentId
    || current.sessionId !== next.sessionId
    || current.runtimeEpoch !== next.runtimeEpoch
    || next.fromRevision !== current.revision
  ) {
    return { transcript: current, accepted: false, needsCheckpoint: true }
  }

  if (next.entrySnapshot) {
    if (!current.entrySnapshot) return { transcript: current, accepted: false, needsCheckpoint: true }
    const currentOrder = current.entrySnapshot.order
    const windowOrder = next.entrySnapshot.order
    const windowStartId = coveredStart(next)
    let retainedPrefix: string[] = []
    if (windowStartId && next.hasMoreBefore) {
      const currentStart = currentOrder.indexOf(windowStartId)
      const windowStart = windowOrder.indexOf(windowStartId)
      if (currentStart < 0 || windowStart < 0) {
        return { transcript: current, accepted: false, needsCheckpoint: true }
      }
      retainedPrefix = currentOrder.slice(0, currentStart)
      const prefixIds = new Set(retainedPrefix)
      // The backend may include the owning prompt before its bounded window.
      // It must already be part of the loaded prefix to preserve its position.
      if (windowOrder.slice(0, windowStart).some(id => !prefixIds.has(id))) {
        return { transcript: current, accepted: false, needsCheckpoint: true }
      }
    }
    const entries = new Map(current.entrySnapshot.entries.map(entry => [String(entry.id), entry]))
    next.entrySnapshot.entries.forEach(entry => entries.set(String(entry.id), entry))
    const retainedIds = new Set(retainedPrefix)
    const order = [...retainedPrefix, ...windowOrder.filter(id => !retainedIds.has(id))]
    if (order.some(id => !entries.has(id))) return { transcript: current, accepted: false, needsCheckpoint: true }
    const boundedOrder = boundedEntryOrder(order, entries, next.turnLimit || current.turnLimit || 80)
    const trimmed = boundedOrder.length < order.length
    const contiguousStart = trimmed && boundedOrder.length > 1
      && order.indexOf(boundedOrder[1]!) > order.indexOf(boundedOrder[0]!) + 1
      ? boundedOrder[1] : boundedOrder[0]
    const ordered = boundedOrder.map(id => entries.get(id)!)
    const session = {
      ...next.entrySnapshot.session,
      entries: ordered,
      nextCursor: trimmed ? contiguousStart : retainedPrefix.length > 0 ? current.nextCursor : next.nextCursor,
      hasMoreBefore: trimmed || (retainedPrefix.length > 0 ? current.hasMoreBefore : next.hasMoreBefore),
      entryPatch: { ...record(next.entrySnapshot.session.entryPatch), order: boundedOrder,
        startId: trimmed ? contiguousStart : retainedPrefix.length > 0 ? coveredStart(current) : coveredStart(next) },
    }
    const projected = projectAcpTranscript(session, { maxTurns: next.turnLimit })
    return {
      transcript: preserveCompletedTranscriptTurns(current, { ...next, ...projected,
        entrySnapshot: { session, entries: ordered, order: boundedOrder } }),
      accepted: true, needsCheckpoint: false,
    }
  }

  if (next.turns.length === 0) {
    return {
      transcript: {
        ...current,
        ...next,
        available: current.available,
        hasMoreBefore: current.hasMoreBefore,
        turns: current.turns,
      },
      accepted: true,
      needsCheckpoint: false,
    }
  }

  const replaceFromTurnId = next.replaceFromTurnId || next.turns[0]?.id || ''
  const replaceIndex = current.turns.findIndex(turn => turn.id === replaceFromTurnId)
  if (replaceIndex < 0) {
    const currentTurnIds = new Set(current.turns.map(turn => turn.id))
    if (next.turns.some(turn => currentTurnIds.has(turn.id))) {
      return { transcript: current, accepted: false, needsCheckpoint: true }
    }
    const mergedTurns = [...current.turns, ...next.turns]
    const boundedTurns = current.turnLimit && mergedTurns.length > current.turnLimit
      ? mergedTurns.slice(-current.turnLimit)
      : mergedTurns
    return {
      transcript: preserveCompletedTranscriptTurns(current, {
        ...next,
        available: current.available || next.available,
        hasMoreBefore: current.hasMoreBefore || boundedTurns.length < mergedTurns.length,
        turns: boundedTurns,
      }),
      accepted: true,
      needsCheckpoint: false,
    }
  }
  return {
    transcript: preserveCompletedTranscriptTurns(current, {
      ...next,
      available: current.available || next.available,
      hasMoreBefore: current.hasMoreBefore,
      turns: [...current.turns.slice(0, replaceIndex), ...next.turns],
    }),
    accepted: true,
    needsCheckpoint: false,
  }
}
