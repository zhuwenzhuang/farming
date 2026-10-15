export interface AgentLaunchOption {
  name: string
  command?: string
  description?: string
  category?: string
  supported?: boolean
  interactive?: boolean
  launchOrder?: number
  launchDefaults?: {
    homeId: string
    runtimeMode: 'terminal' | 'chat'
  }
  capabilities?: {
    supportsChat?: boolean
  }
}

const DEFAULT_AGENT_LAUNCH_ORDER: Record<string, number> = {
  codex: 0,
  claude: 1,
  pi: 2,
  opencode: 3,
  qoder: 4,
  qwen: 5,
  agy: 6,
  bash: 7,
  zsh: 8,
}

export function normalizeAgentLaunchOptions(rawOptions: AgentLaunchOption[]) {
  const seen = new Set<string>()
  return rawOptions
    .map((option, sourceOrder) => ({ option, sourceOrder }))
    .filter(({ option }) => (
      option
      && typeof option.name === 'string'
      && option.name.trim().length > 0
      && option.supported !== false
      && option.interactive !== false
    ))
    .filter(({ option }) => {
      if (seen.has(option.name)) return false
      seen.add(option.name)
      return true
    })
    .sort((left, right) => {
      const leftRank = left.option.launchOrder ?? DEFAULT_AGENT_LAUNCH_ORDER[left.option.name] ?? Number.MAX_SAFE_INTEGER
      const rightRank = right.option.launchOrder ?? DEFAULT_AGENT_LAUNCH_ORDER[right.option.name] ?? Number.MAX_SAFE_INTEGER
      if (leftRank !== rightRank) return leftRank - rightRank
      return left.sourceOrder - right.sourceOrder
    })
    .map(({ option }) => option)
}
