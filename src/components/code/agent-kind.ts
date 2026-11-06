export type ComposerAgentKind = 'codex' | 'claude' | 'shell' | 'agent' | null

const AGENT_KIND_BY_EXECUTABLE: Readonly<Record<string, Exclude<ComposerAgentKind, null>>> = {
  codex: 'codex',
  claude: 'claude',
  bash: 'shell',
  zsh: 'shell',
  sh: 'shell',
  fish: 'shell',
}

const AGENT_KIND_BY_PROVIDER: Readonly<Record<string, Exclude<ComposerAgentKind, null>>> = {
  codex: 'codex',
  claude: 'claude',
}

const PROVIDER_ID_BY_EXECUTABLE: Readonly<Record<string, string>> = {
  codex: 'codex',
  claude: 'claude',
  pi: 'pi',
  opencode: 'opencode',
  qoder: 'qoder',
  qodercli: 'qoder',
  qwen: 'qwen',
  agy: 'agy',
  antigravity: 'agy',
}

function executableBasename(command?: string): string {
  const executable = (command || '')
    .trim()
    .split(/\s+/)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
  return executable?.split('/').pop() || ''
}

export function agentKindForCommand(command?: string): ComposerAgentKind {
  const basename = executableBasename(command)
  return AGENT_KIND_BY_EXECUTABLE[basename] || (basename ? 'agent' : null)
}

export function agentKindForProvider(provider?: string): ComposerAgentKind {
  return AGENT_KIND_BY_PROVIDER[(provider || '').trim().toLowerCase()] || null
}

export function providerIdForCommand(command?: string): string {
  const basename = executableBasename(command).toLowerCase()
  return PROVIDER_ID_BY_EXECUTABLE[basename] || ''
}

export function providerIdForAgent(
  agent: { command?: string; providerSessionProvider?: string } | null | undefined,
  kind?: ComposerAgentKind,
): string {
  if (!agent || kind === 'shell') return ''
  const sessionProvider = (agent.providerSessionProvider || '').trim().toLowerCase()
  if (sessionProvider) return sessionProvider
  const commandProvider = providerIdForCommand(agent.command)
  if (commandProvider) return commandProvider
  if (kind === 'codex' || kind === 'claude') return kind
  return ''
}
