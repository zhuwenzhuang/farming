/** Chat outcome is independent of connection/lifecycle and unread state. */
export interface ChatTurnState {
  turnId: string
  status: 'active' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  message: string
  updatedAt: number
}

export function isChatTurnState(value: unknown): value is ChatTurnState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const turn = value as Record<string, unknown>
  return typeof turn.turnId === 'string' && turn.turnId.length > 0
    && typeof turn.status === 'string'
    && ['active', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted'].includes(turn.status)
    && typeof turn.message === 'string'
    && typeof turn.updatedAt === 'number' && Number.isFinite(turn.updatedAt)
}

/** Only proven loss of a running binding interrupts a turn, not transport loss. */
export function interruptChatTurn(value: unknown, message: string): ChatTurnState | null {
  if (!isChatTurnState(value)) return null
  if (value.status === 'cancelling') {
    return { ...value, status: 'cancelled', message: '', updatedAt: Date.now() }
  }
  if (value.status !== 'active') return value
  return { ...value, status: 'interrupted', message, updatedAt: Date.now() }
}
