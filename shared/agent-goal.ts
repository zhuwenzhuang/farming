/** Read-only provider goal metadata. Omission means no update; null means cleared. */
export interface AgentGoal {
  objective: string
  status: string
  tokenBudget?: number
  tokensUsed?: number
  timeUsedSeconds?: number
}

export function normalizeAgentGoal(value: unknown): AgentGoal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.objective !== 'string' || !raw.objective.trim()
    || typeof raw.status !== 'string' || !raw.status.trim()) return null
  const goal: AgentGoal = { objective: raw.objective.trim(), status: raw.status.trim() }
  for (const key of ['tokenBudget', 'tokensUsed', 'timeUsedSeconds'] as const) {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0) goal[key] = raw[key]
  }
  return goal
}
