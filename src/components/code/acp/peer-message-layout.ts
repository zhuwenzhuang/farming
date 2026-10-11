import type { AgentTranscriptTurn } from './acp-entry-projection'

/** Presentation only: callers pass adjacent turns from the same recipient. */
export function continuesPeerMessageGroup(previous: AgentTranscriptTurn | undefined, current: AgentTranscriptTurn | undefined): boolean {
  const before = previous?.userSource
  const after = current?.userSource
  if (!previous || !before || !after) return false
  if (previous.status !== 'completed' || previous.stopReason || previous.finalMessage
    || previous.processItems.length || previous.completedGoals?.length
    || previous.resultImages?.length || previous.resultFiles?.length || previous.resultAudios?.length) return false
  // Preserve every receive-time name, including a new name on the same identity.
  if ((before.senderName || before.senderAddress) !== (after.senderName || after.senderAddress)) return false
  if (before.senderSessionId || after.senderSessionId) {
    return Boolean(before.senderSessionId && before.senderSessionId === after.senderSessionId)
  }
  if (before.senderTaskId || after.senderTaskId) {
    return Boolean(before.senderTaskId && before.senderTaskId === after.senderTaskId
      && before.senderAddress === after.senderAddress)
  }
  return before.senderAddress === after.senderAddress
}

export function peerMessageTimestamp(turn: AgentTranscriptTurn): number | null {
  const timestamp = turn.userSource?.timestamp ? Date.parse(turn.userSource.timestamp) : NaN
  return Number.isFinite(timestamp) ? timestamp : turn.startedAt
}
