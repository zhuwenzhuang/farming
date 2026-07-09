import { agentKindForCommand } from './agent-kind'

export type MainPageSessionProvider = 'codex' | 'claude' | 'opencode' | 'qoder'

export function mainPageSessionProviderForCommand(command?: string): MainPageSessionProvider | null {
  const kind = agentKindForCommand(command)
  if (kind === 'codex' || kind === 'claude') return kind
  const executable = (command || '')
    .trim()
    .split(/\s+/)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
  const basename = executable?.split('/').pop() || ''
  if (basename === 'opencode') return 'opencode'
  return basename === 'qodercli' || basename === 'qoder' ? 'qoder' : null
}
