export type TerminalRecoveryPhase = 'requesting' | 'installing' | 'retrying' | 'ready' | 'failed'

export interface TerminalRecoveryStatus {
  phase: TerminalRecoveryPhase
  attempt: number
  startedAt: number | null
  retryDelayMs: number | null
}

export interface TerminalRecoveryTransition {
  phase: TerminalRecoveryPhase
  attempt?: number
  retryDelayMs?: number | null
  restart?: boolean
}

/**
 * Owns the user-visible recovery lifecycle.  Effects such as checkpoint I/O
 * and attachment generation fencing remain with the terminal session pool.
 */
export function transitionTerminalRecoveryStatus(
  previous: TerminalRecoveryStatus,
  transition: TerminalRecoveryTransition,
  now?: number,
): TerminalRecoveryStatus {
  const active = transition.phase !== 'ready' && transition.phase !== 'failed'
  return {
    phase: transition.phase,
    attempt: active ? Math.max(1, transition.attempt ?? previous.attempt) : 0,
    startedAt: active
      ? (transition.restart || previous.startedAt === null ? now ?? Date.now() : previous.startedAt)
      : null,
    retryDelayMs: transition.phase === 'retrying' ? transition.retryDelayMs ?? null : null,
  }
}
