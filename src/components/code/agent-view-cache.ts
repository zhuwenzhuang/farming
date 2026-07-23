export const MAX_RETAINED_AGENT_VIEWS = 6

// The active view plus five recent views keeps the measured mixed working set
// bounded while covering normal back-and-forth supervision. The large-cache
// browser test exercises two >1.5 MiB Chats and real pooled Terminals.
export function normalizeAgentViewCache(
  agentIds: readonly string[],
  limit = MAX_RETAINED_AGENT_VIEWS,
) {
  const normalized: string[] = []
  for (const agentId of agentIds) {
    if (!agentId) continue
    const previousIndex = normalized.indexOf(agentId)
    if (previousIndex >= 0) normalized.splice(previousIndex, 1)
    normalized.push(agentId)
  }
  const capacity = Math.max(0, Math.floor(limit))
  return capacity === 0 ? [] : normalized.slice(-capacity)
}

export function reconcileAgentViewCache(
  currentAgentIds: string[],
  nextAgentIds: readonly string[],
  limit = MAX_RETAINED_AGENT_VIEWS,
) {
  const next = normalizeAgentViewCache(nextAgentIds, limit)
  return next.length === currentAgentIds.length
    && next.every((agentId, index) => agentId === currentAgentIds[index])
    ? currentAgentIds
    : next
}

export function touchAgentViewCache(
  agentIds: string[],
  agentId: string,
  limit = MAX_RETAINED_AGENT_VIEWS,
) {
  return reconcileAgentViewCache(agentIds, [...agentIds, agentId], limit)
}
