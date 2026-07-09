export interface AgentLaunchOption {
  name: string
  command?: string
  description?: string
  category?: string
  supported?: boolean
  interactive?: boolean
}

const PREFERRED_AGENT_ORDER = ['codex', 'claude', 'opencode', 'qoder', 'bash', 'zsh']
const PREFERRED_AGENT_NAMES = new Set(PREFERRED_AGENT_ORDER)

function agentLaunchRank(agentName: string) {
  const preferredIndex = PREFERRED_AGENT_ORDER.indexOf(agentName)
  return preferredIndex === -1 ? PREFERRED_AGENT_ORDER.length : preferredIndex
}

export function normalizeAgentLaunchOptions(rawOptions: AgentLaunchOption[]) {
  const seen = new Set<string>()
  return rawOptions
    .filter(option => (
      option
      && PREFERRED_AGENT_NAMES.has(option.name)
      && option.supported !== false
      && option.interactive !== false
    ))
    .filter(option => {
      if (seen.has(option.name)) return false
      seen.add(option.name)
      return true
    })
    .sort((left, right) => {
      const leftRank = agentLaunchRank(left.name)
      const rightRank = agentLaunchRank(right.name)
      if (leftRank !== rightRank) return leftRank - rightRank
      return left.name.localeCompare(right.name)
    })
}
