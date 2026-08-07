const AGENT_DISPLAY_NAMES: Record<string, string> = {
  qwen: 'Qwen Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  qoder: 'Qoder',
  qodercli: 'Qoder',
  aider: 'Aider',
  'github-copilot-cli': 'GitHub Copilot CLI',
  claude: 'Claude Code',
  'amazon-q': 'Amazon Q',
  bash: 'bash',
  zsh: 'zsh',
}

const TITLE_STATUS_PREFIX_PATTERN = /^[\s*＊✳✱✲✶·•◇✋✦⏲\u2800-\u28FF]+/u
const QODER_RUNTIME_TITLE_PATTERN = /^[◇✋✦⏲]/u

function commandProgram(command: string) {
  return command.split(' ')[0] ?? command
}

function truncateTitle(title: string, maxLength = 28) {
  if (title.length <= maxLength) return title
  return `${title.slice(0, Math.max(0, maxLength - 1))}…`
}

function stripTitleStatusPrefix(title: string) {
  return title.replace(TITLE_STATUS_PREFIX_PATTERN, '').trim()
}

function titleComparisonKey(title: string) {
  return title
    .trim()
    .replace(/^[\s*＊✳✱✲✶·•:.◇✋✦⏲\u2800-\u28FF]+/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function formatRelativeAge(timestamp?: number | null, now = Date.now()): string {
  if (!timestamp || !Number.isFinite(timestamp)) return ''

  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return 'now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  if (days < 56) return `${Math.floor(days / 7)}w`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`

  return `${Math.floor(days / 365)}y`
}

/** Get the short display name from a command string */
export function agentDisplayName(command: string): string {
  const program = commandProgram(command)
  return AGENT_DISPLAY_NAMES[program] ?? program
}

function workspaceBasenames(agent: { cwd?: string; projectWorkspace?: string }) {
  return [agent.cwd, agent.projectWorkspace]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop() || '')
    .filter(Boolean)
    .map(value => value.toLowerCase())
}

function meaningfulSessionTitle(
  sessionTitle: string | undefined,
  agent: { command: string; cwd?: string; projectWorkspace?: string },
) {
  const title = typeof sessionTitle === 'string' ? sessionTitle.trim() : ''
  if (!title) return ''
  if (title.toLowerCase().startsWith('<farming-agent-context>')) return ''

  const normalizedTitle = titleComparisonKey(title)
  const program = commandProgram(agent.command).toLowerCase()
  const displayName = agentDisplayName(agent.command).toLowerCase()
  if ((program === 'qoder' || program === 'qodercli') && QODER_RUNTIME_TITLE_PATTERN.test(title)) return ''
  const genericTitles = new Set([
    program,
    displayName,
    `${program} session`,
    `${displayName} session`,
    'main agent',
    'farming',
  ].filter(Boolean))

  if (genericTitles.has(normalizedTitle)) return ''
  if (workspaceBasenames(agent).includes(normalizedTitle)) return ''

  return stripTitleStatusPrefix(title) || title
}

interface AgentTitleSource {
  command: string
  cwd?: string
  projectWorkspace?: string
  customTitle?: string
  adaptiveTitle?: string
  providerSessionTitle?: string
  sessionTitle?: string
  task?: string
  source?: string
  isMain?: boolean
  runtimeBinding?: { kind?: string }
}

function resolveAgentTitle(agent: AgentTitleSource) {
  const customTitle = typeof agent.customTitle === 'string' ? agent.customTitle.trim() : ''
  if (customTitle) return customTitle

  if (agent.isMain) return 'Main Agent'

  const adaptiveTitle = meaningfulSessionTitle(agent.adaptiveTitle, agent)
  if (adaptiveTitle) return adaptiveTitle

  if (/^[a-z]+-history(?:-fork)?:/.test(agent.source || '')) {
    const providerSessionTitle = meaningfulSessionTitle(agent.providerSessionTitle, agent)
    if (providerSessionTitle) return providerSessionTitle

    const sessionTitle = meaningfulSessionTitle(agent.sessionTitle, agent)
    if (sessionTitle) return sessionTitle

    const taskTitle = meaningfulSessionTitle(agent.task, agent)
    if (taskTitle) return taskTitle
  } else if (agent.runtimeBinding?.kind !== 'acp') {
    const providerSessionTitle = meaningfulSessionTitle(agent.providerSessionTitle, agent)
    if (providerSessionTitle) return providerSessionTitle

    const sessionTitle = meaningfulSessionTitle(agent.sessionTitle, agent)
    if (sessionTitle) return sessionTitle
  }

  return agentDisplayName(agent.command)
}

/** Prefer a user rename, then an Agent-managed title, history metadata, and finally its kind. */
export function agentTitle(agent: AgentTitleSource) {
  return truncateTitle(resolveAgentTitle(agent))
}

/**
 * Keep enough source text for width-responsive Agent rows. CSS owns the visible
 * truncation, while this generous bound prevents unbounded provider text from
 * entering labels and accessibility attributes.
 */
export function agentRowTitle(agent: AgentTitleSource) {
  return truncateTitle(resolveAgentTitle(agent), 160)
}
