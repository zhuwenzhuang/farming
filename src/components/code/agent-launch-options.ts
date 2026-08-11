export interface AgentLaunchOption {
  name: string
  command?: string
  description?: string
  category?: string
  supported?: boolean
  interactive?: boolean
  launchOrder?: number
  capabilities?: {
    supportsChat?: boolean
  }
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
      const leftRank = left.option.launchOrder ?? Number.MAX_SAFE_INTEGER
      const rightRank = right.option.launchOrder ?? Number.MAX_SAFE_INTEGER
      if (leftRank !== rightRank) return leftRank - rightRank
      return left.sourceOrder - right.sourceOrder
    })
    .map(({ option }) => option)
}
