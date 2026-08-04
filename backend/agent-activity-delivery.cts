type AgentActivityScope = 'all' | 'focused' | 'none';

type AgentActivityClientDelivery = 'defer' | 'send' | 'skip';

function normalizeAgentActivityScope(scope: unknown): AgentActivityScope {
  return scope === 'none' || scope === 'focused' || scope === 'all'
    ? scope
    : 'all';
}

function agentActivityClientDelivery(
  scope: unknown,
  focusedAgentId: string | null | undefined,
  allCheckpointPending: boolean,
  bufferedAmount: number,
  maxBufferedAmount: number,
  activityAgentId: string,
): AgentActivityClientDelivery {
  const normalizedScope = normalizeAgentActivityScope(scope);
  if (normalizedScope === 'none') return 'skip';
  if (normalizedScope === 'focused' && focusedAgentId !== activityAgentId) return 'skip';
  if (normalizedScope === 'all' && allCheckpointPending) return 'defer';
  return bufferedAmount > maxBufferedAmount ? 'defer' : 'send';
}

export {
  agentActivityClientDelivery,
  normalizeAgentActivityScope,
};

export type {
  AgentActivityClientDelivery,
  AgentActivityScope,
};
