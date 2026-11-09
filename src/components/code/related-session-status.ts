import type { AgentStatusDisplayState } from './agent-row-state'
import type { CodeCopy } from './copy'

/** One display mapping for native child inventory, cards and transcript details. */
function relatedSessionStatusKey(state: string, stopReason = '', error = '') {
  if (error || ['error', 'errored', 'failed', 'systemError'].includes(state)) return 'agentTranscriptCollaborationFailed'
  if (stopReason === 'cancelled' || ['interrupted', 'cancelled', 'interrupting', 'paused'].includes(state)) return 'agentTranscriptCollaborationInterrupted'
  if (['working', 'running', 'active'].includes(state)) return 'agentTranscriptCollaborationInProgress'
  if (state === 'waiting-for-permission') return 'relatedWaitingPermission'
  if (state === 'waiting-for-input' || state === 'requires_action') return 'relatedWaitingInput'
  if (['pendingInit', 'pending', 'connecting'].includes(state)) return 'agentTranscriptCollaborationPending'
  if (['closed', 'shutdown'].includes(state)) return 'agentTranscriptCollaborationClosed'
  if (['idle', 'completed'].includes(state)) return 'agentTranscriptCollaborationCompleted'
  return 'relatedStatusUnavailable'
}

export function relatedSessionHasStatus(state: string, stopReason = '', error = ''): boolean {
  return relatedSessionStatusKey(state, stopReason, error) !== 'relatedStatusUnavailable'
}

export function relatedSessionStatusLabel(state: string, copy: CodeCopy, stopReason = '', error = ''): string {
  return copy[relatedSessionStatusKey(state, stopReason, error)]
}

export function relatedSessionFinished(state: string) {
  return ['idle', 'completed', 'closed', 'shutdown'].includes(state)
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
    turnActive: active, statusIndicatorVisible: relatedSessionHasStatus(state, stopReason) && (failed || !finished || ['closed', 'shutdown'].includes(state)),
  }
}
