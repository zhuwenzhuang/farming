export type ComposerAgentKind = 'codex' | 'claude' | 'shell' | 'agent' | null

export function agentKindForCommand(command?: string): ComposerAgentKind {
  const executable = (command || '')
    .trim()
    .split(/\s+/)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
  const basename = executable?.split('/').pop() || ''
  if (basename === 'codex') return 'codex'
  if (basename === 'claude') return 'claude'
  if (['bash', 'zsh', 'sh', 'fish'].includes(basename)) return 'shell'
  return executable ? 'agent' : null
}
