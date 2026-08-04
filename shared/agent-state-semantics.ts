export const PROJECT_ATTENTION_SCORE_MAX = 100

type AgentStateLike = Record<string, unknown>

function agentStateLike(value: unknown): value is AgentStateLike {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function projectWorkspaceFromAgentState(value: unknown): string {
  if (!agentStateLike(value)) return ''
  const gitWorktree = agentStateLike(value.gitWorktree) ? value.gitWorktree : null
  return String(gitWorktree?.workspace || value.projectWorkspace || value.cwd || '')
}

export function agentTurnActiveFromState(value: unknown): boolean {
  if (!agentStateLike(value)) return false
  const observation = agentStateLike(value.runtimeObservation) ? value.runtimeObservation : null
  const binding = agentStateLike(value.runtimeBinding) ? value.runtimeBinding : null
  const phase = String(observation?.phase || '')
  return phase === 'working'
    || phase === 'waiting'
    || (phase === 'starting' && binding?.kind === 'terminal')
}
