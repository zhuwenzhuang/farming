import {
  projectAcpTranscript,
  type AgentTranscript,
  type AgentTranscriptTurn,
} from './acp-entry-projection'

type DataRecord = Record<string, unknown>

function record(value: unknown): DataRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as DataRecord
    : {}
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
      revision: Math.max(Number(current.revision), Number(next.revision)),
      turns: [...turns.values()].slice(-turnLimit),
    })!
  }

  const entries = new Map(next.entrySnapshot.entries.map(entry => [String(entry.id), entry]))
  current.entrySnapshot.entries.forEach(entry => entries.set(String(entry.id), entry))
  const order = [...new Set([
    ...next.entrySnapshot.order,
    ...current.entrySnapshot.order,
  ])]
  const ordered = order.map(id => entries.get(id)).filter((entry): entry is DataRecord => Boolean(entry))
  const nextSession = next.entrySnapshot.session
  const currentSession = current.entrySnapshot.session
  const revision = Math.max(Number(current.revision), Number(next.revision))
  const session = {
    ...nextSession,
    ...currentSession,
    revision,
    entries: ordered,
    nextCursor: nextSession.nextCursor,
    hasMoreBefore: nextSession.hasMoreBefore,
    entryPatch: {
      ...record(nextSession.entryPatch),
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
): AcpTranscriptMergeResult {
  if (next?.envelopeVersion !== 1) {
    return {
      transcript: legacyMergeAcpTranscript(current, next),
      accepted: true,
      needsCheckpoint: false,
    }
  }

  if (next.replace) {
    if (
      next.historyPage
      && current?.envelopeVersion === 1
      && current.agentId === next.agentId
      && current.sessionId === next.sessionId
      && current.runtimeEpoch === next.runtimeEpoch
    ) {
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
    const entries = new Map(current.entrySnapshot.entries.map(entry => [String(entry.id), entry]))
    next.entrySnapshot.entries.forEach(entry => entries.set(String(entry.id), entry))
    if (next.entrySnapshot.order.some(id => !entries.has(id))) return { transcript: current, accepted: false, needsCheckpoint: true }
    const ordered = next.entrySnapshot.order.map(id => entries.get(id)!)
    const session = { ...next.entrySnapshot.session, entries: ordered }
    const projected = projectAcpTranscript(session, { maxTurns: next.turnLimit })
    return {
      transcript: preserveCompletedTranscriptTurns(current, { ...next, ...projected,
        entrySnapshot: { ...next.entrySnapshot, session, entries: ordered } }),
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
