const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g
const NOISE_LINE_PATTERNS = [
  /^[\s\-_=~─━│┃┌┐└┘┼╭╮╰╯═║╠╣╬▪•·<>]+$/,
  /^\? for shortcuts$/i,
  /^esc to interrupt$/i,
  /^recent activity$/i,
  /^note:/i,
  /^press esc to cancel$/i,
  /^0;.*code$/i,
  /^✳\s*.*code$/i,
  /auto-updating/i,
  /auto-update failed/i,
  /shift\+tab.*cycle/i,
  /\/effort$/i,
]

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

/** Strip ANSI escape codes from text */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\r/g, '\n')
    .replace(CONTROL_CHARS_PATTERN, '')
}

function normalizePreviewLine(line: string) {
  return line
    .replace(/^[0-9;?]+[A-Za-z]\s*/, '')
    .replace(/[│┃┌┐└┘┼╭╮╰╯═║╠╣╬▘▝▖▗▚▞▌▐▀▄▁▔]/g, ' ')
    .replace(/·/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

function isNoisePreviewLine(line: string) {
  const squashed = line.toLowerCase().replace(/\s+/g, '')
  if (squashed.includes('claudecodev')) return true
  if (squashed.includes('recentactivity')) return true
  if (squashed.includes('norecentactivity')) return true
  if (squashed.includes('apiusagebilling')) return true
  if (/^\/(?:[^/\s]+\/){3,}/.test(line)) return true

  return NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

function truncatePreviewLine(line: string) {
  if (line.length <= 140) return line
  return `${line.slice(0, 139)}…`
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

export function extractMeaningfulPreview(text: string, maxLines = 6): string {
  const cleaned = stripAnsi(text)
  const lines = cleaned
    .split('\n')
    .map(normalizePreviewLine)
    .filter(Boolean)

  if (!lines.length) return ''

  const meaningfulLines = lines.filter((line) => !isNoisePreviewLine(line))
  const previewLines = (meaningfulLines.length ? meaningfulLines : lines)
    .slice(-maxLines)
    .map(truncatePreviewLine)

  return previewLines.join('\n')
}

export function extractTerminalSnapshotPreview(text: string, maxLines = 10): string {
  const cleaned = stripAnsi(text)
    .replace(/\t/g, '  ')
    .split('\n')
    .map(line => line.replace(/\s+$/g, ''))

  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') {
    cleaned.pop()
  }

  if (cleaned.length === 0) return ''

  const previewLines = cleaned.slice(-maxLines)

  while (previewLines.length > 1 && previewLines[0] === '') {
    previewLines.shift()
  }

  return previewLines.join('\n')
}

/** Format seconds into human-readable uptime string */
export function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
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
  providerSessionTitle?: string
  sessionTitle?: string
  task?: string
  source?: string
  isMain?: boolean
}

function resolveAgentTitle(agent: AgentTitleSource) {
  const customTitle = typeof agent.customTitle === 'string' ? agent.customTitle.trim() : ''
  if (customTitle) return customTitle

  if (agent.isMain) return 'Main Agent'

  const providerSessionTitle = meaningfulSessionTitle(agent.providerSessionTitle, agent)
  if (providerSessionTitle) return providerSessionTitle

  const sessionTitle = meaningfulSessionTitle(agent.sessionTitle, agent)
  if (sessionTitle) return sessionTitle

  if (/^[a-z]+-history(?:-fork)?:/.test(agent.source || '')) {
    const taskTitle = meaningfulSessionTitle(agent.task, agent)
    if (taskTitle) return taskTitle
  }

  return agentDisplayName(agent.command)
}

/** Prefer a user rename, then the agent-updated session title, then a simple agent kind. */
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

/** Get preview text for an agent, stripping ANSI codes */
export function agentPreviewText(agent: { previewText?: string; output?: string }): string {
  const raw = (agent as { previewText?: string }).previewText || agent.output || ''
  return extractMeaningfulPreview(raw)
}

export function agentTerminalPreviewText(
  agent: { previewText?: string; output?: string },
  maxLines = 10,
) {
  const raw = (agent as { previewText?: string }).previewText || agent.output || ''
  return extractTerminalSnapshotPreview(raw, maxLines)
}
