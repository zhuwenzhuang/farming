import { agentKindForCommand } from './agent-kind'

export type MainPageSessionProvider = 'codex' | 'claude'

export function mainPageSessionProviderForCommand(command?: string): MainPageSessionProvider | null {
  const kind = agentKindForCommand(command)
  return kind === 'codex' || kind === 'claude' ? kind : null
}
