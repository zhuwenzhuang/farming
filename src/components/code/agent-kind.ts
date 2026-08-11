export type ComposerAgentKind = 'codex' | 'claude' | 'shell' | 'agent' | null

const AGENT_KIND_BY_EXECUTABLE: Readonly<Record<string, Exclude<ComposerAgentKind, null>>> = {
  codex: 'codex',
  claude: 'claude',
  bash: 'shell',
  zsh: 'shell',
  sh: 'shell',
  fish: 'shell',
}

export function agentKindForCommand(command?: string): ComposerAgentKind {
  const executable = (command || '')
    .trim()
    .split(/\s+/)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
  const basename = executable?.split('/').pop() || ''
  return AGENT_KIND_BY_EXECUTABLE[basename] || (executable ? 'agent' : null)
}
