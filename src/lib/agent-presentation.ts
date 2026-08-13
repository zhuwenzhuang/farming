export type AgentIconName = 'codex' | 'claude' | 'pi' | 'opencode' | 'qoder' | 'qwen' | 'bash' | 'zsh'

const AGENT_ICON_NAMES = new Set<AgentIconName>([
  'codex',
  'claude',
  'pi',
  'opencode',
  'qoder',
  'qwen',
  'bash',
  'zsh',
])

const AGENT_ICON_ALIASES: Record<string, AgentIconName> = {
  'claude-code': 'claude',
  qodercli: 'qoder',
}

export function agentIconName(value?: string): AgentIconName | undefined {
  const normalized = String(value || '').trim().toLowerCase()
  return AGENT_ICON_ALIASES[normalized]
    ?? (AGENT_ICON_NAMES.has(normalized as AgentIconName) ? normalized as AgentIconName : undefined)
}

export function agentIconNameFromCommand(command?: string): AgentIconName | undefined {
  const executable = String(command || '').trim().split(/\s+/).find(token => (
    token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
  ))
  return agentIconName(executable?.split(/[/\\]/).pop())
}
