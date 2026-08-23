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

function completedTranscriptTurnUnchanged(
  current: AgentTranscriptTurn,
  next: AgentTranscriptTurn,
) {
  const currentLastItem = current.processItems[current.processItems.length - 1]
  const nextLastItem = next.processItems[next.processItems.length - 1]
  return current.status !== 'inProgress'
    && next.status !== 'inProgress'
    && current.status === next.status
    && current.userMessage === next.userMessage
    && current.finalMessage === next.finalMessage
    && current.startedAt === next.startedAt
    && current.completedAt === next.completedAt
    && current.durationMs === next.durationMs
    && current.userImages?.length === next.userImages?.length
    && current.userAudios?.length === next.userAudios?.length
    && current.userFiles?.length === next.userFiles?.length
    && current.resultImages?.length === next.resultImages?.length
    && current.resultAudios?.length === next.resultAudios?.length
    && current.resultFiles?.length === next.resultFiles?.length
    && current.processItems.length === next.processItems.length
    && currentLastItem?.id === nextLastItem?.id
    && currentLastItem?.status === nextLastItem?.status
    && currentLastItem?.title === nextLastItem?.title
    && currentLastItem?.detail === nextLastItem?.detail
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
      hasMoreBefore: current.hasMoreBefore || next.hasMoreBefore || boundedTurns.length < mergedTurns.length,
      turns: boundedTurns,
    })
  }
  return preserveCompletedTranscriptTurns(current, {
    ...next,
    available: current.available || next.available,
    hasMoreBefore: current.hasMoreBefore || next.hasMoreBefore,
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

  return {
    ...projectAcpTranscript(transcriptValue, options),
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
        hasMoreBefore: current.hasMoreBefore || next.hasMoreBefore || boundedTurns.length < mergedTurns.length,
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
      hasMoreBefore: current.hasMoreBefore || next.hasMoreBefore,
      turns: [...current.turns.slice(0, replaceIndex), ...next.turns],
    }),
    accepted: true,
    needsCheckpoint: false,
  }
}
