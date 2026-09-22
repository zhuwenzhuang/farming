import type { AgentStatusDisplayState } from './agent-row-state'
import type { CodeCopy } from './copy'

/** One display mapping for native child inventory, cards and transcript details. */
export function relatedSessionStatusLabel(state: string, copy: CodeCopy, stopReason = '', error = ''): string {
  if (error || ['error', 'errored', 'failed', 'systemError'].includes(state)) return copy.agentTranscriptCollaborationFailed
  if (stopReason === 'cancelled' || ['interrupted', 'cancelled', 'interrupting', 'paused'].includes(state)) return copy.agentTranscriptCollaborationInterrupted
  if (['working', 'running', 'active'].includes(state)) return copy.agentTranscriptCollaborationInProgress
  if (state === 'waiting-for-permission') return copy.relatedWaitingPermission
  if (state === 'waiting-for-input') return copy.relatedWaitingInput
  if (['pendingInit', 'pending', 'connecting'].includes(state)) return copy.agentTranscriptCollaborationPending
  if (['closed', 'shutdown'].includes(state)) return copy.agentTranscriptCollaborationClosed
  if (['idle', 'completed'].includes(state)) return copy.agentTranscriptCollaborationCompleted
  return copy.relatedStatusUnavailable
}

export function relatedSessionFinished(state: string) {
  return ['idle', 'completed', 'closed', 'shutdown'].includes(state)
}

export function relatedSessionCounts(states: string[]) {
  let running = 0
  let attention = 0
  let finished = 0
  for (const state of states) {
    if (relatedSessionFinished(state)) finished++
    else if (['running', 'working', 'active', 'pending', 'pendingInit', 'connecting'].includes(state)) running++
    else attention++
  }
  return { running, attention, finished }
}

/** Native children share the main Agent indicator without inventing runtime records. */
export function relatedSessionIndicator(key: string, state: string, copy: CodeCopy, stopReason = ''): AgentStatusDisplayState {
  const label = relatedSessionStatusLabel(state, copy, stopReason)
  const active = ['working', 'running', 'active'].includes(state)
  const failed = ['error', 'errored', 'failed', 'systemError', 'interrupted', 'cancelled', 'paused'].includes(state) || stopReason === 'cancelled'
  const finished = relatedSessionFinished(state)
  return {
    statusIndicatorKey: key, statusIndicatorDelayMs: 0,
    commandTitle: label, failureMessage: failed ? label : '',
    lifecycleStatus: active ? 'running' : finished ? 'stopped' : 'pending',
    turnActive: active, statusIndicatorVisible: failed || !finished || ['closed', 'shutdown'].includes(state),
  }
}
