/** Activity level from time since last session activity (see `docs/products/crt/base_layout.md` §4.2) */
export type ActivityLevel = 'hot' | 'warm' | 'cool' | 'cold'

export interface TerminalPreviewCell {
  char: string
  width: number
  fg?: number
  bg?: number
  attributes?: number
}

export interface TerminalPreviewSnapshot {
  cols: number
  rows: number
  viewportY: number
  cursorX: number
  cursorY: number
  cells: TerminalPreviewCell[][]
}

/** Agent lifecycle status */
export type AgentStatus = 'pending' | 'running' | 'stopped' | 'dead'

export interface AgentUsageRate {
  windowMs: number
  outputBytes: number
  estimatedOutputTokens: number
  estimatedTokensPerMinute: number
  eventCount: number
  sampledAt: number
  source: 'terminal-output-estimate'
}

export interface AgentContextWindowUsage {
  agentId: string
  available: true
  provider: 'codex'
  sessionId: string
  usedTokens: number
  limitTokens: number
  percentUsed: number
  percentLeft: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
  updatedAt?: string
  source: string
  confidence: 'exact'
}

export interface AgentTerminalStatus {
  kind: 'codex' | 'claude' | 'shell' | 'process' | 'unknown'
  activity: 'busy' | 'idle' | 'exited' | 'unknown'
  busy: boolean
  cwd: string
  title: string
  lastExitCode?: number | null
  runningCommand?: string
  lastCommand?: string
  runningCommandStartedAt?: number | null
  lastCommandStartedAt?: number | null
  lastCommandFinishedAt?: number | null
  lastCommandDurationMs?: number | null
  source: 'terminal-text' | 'shell-busy-marker' | 'shell-status-marker' | 'shell-prompt-fallback'
}

/** A single CLI agent instance */
export interface Agent {
  id: string
  command: string
  engineName?: string
  cwd: string
  projectWorkspace?: string
  launchPermissionMode?: string
  output: string
  previewText?: string
  previewSnapshot?: TerminalPreviewSnapshot | null
  previewCols?: number
  previewRows?: number
  sessionTitle?: string
  customTitle?: string
  parentAgentId?: string
  task?: string
  /** Workflow preset id from New Agent dialog (e.g. ralph); informational */
  workflowTemplate?: string
  source?: string
  providerSessionProvider?: 'codex' | 'claude' | string
  providerSessionId?: string
  providerSessionKey?: string
  providerSessionTemporary?: boolean
  providerSessionSource?: string
  providerSessionResolvedAt?: number | null
  forkedFromProviderSessionId?: string
  pinned?: boolean
  unread?: boolean
  archived?: boolean
  archivedAt?: number | null
  canForkNewWorktree?: boolean
  startedAt?: number | null
  exitedAt?: number | null
  terminalBusy?: boolean | null
  shellCommand?: string
  shellLastCommand?: string
  shellCommandStartedAt?: number | null
  shellLastCommandStartedAt?: number | null
  shellLastCommandFinishedAt?: number | null
  shellLastCommandDurationMs?: number | null
  terminalStatus?: AgentTerminalStatus | null
  status: AgentStatus
  isMain: boolean
  activityLevel: ActivityLevel
  lastActivity: number
  attentionScore: number
  isZombie: boolean
  usageRate?: AgentUsageRate
}

export type TaskHistoryReason = 'manual-archive' | 'manual-kill' | 'zombie-cleanup' | 'process-exit'

/** Prefill for New Agent dialog (e.g. History relaunch) */
export interface AgentLaunchPrefill {
  command: string
  workspace: string
  task?: string
  workflowTemplate?: string
}

export interface TaskHistoryEntry {
  id: string
  agentId: string
  command: string
  cwd: string
  projectWorkspace?: string
  title?: string
  task: string
  workflowTemplate?: string
  source: string
  reason: TaskHistoryReason | string
  status: string
  startedAt: number | null
  lastActivity: number | null
  archivedAt: number
}

/** System resource stats (matches backend system-monitor.js format) */
export interface SystemStats {
  cpu: number
  memory: {
    used: number
    total: number
    percentage: number
  }
}

export interface ProviderQuotaLimit {
  usedPercent: number | null
  windowMinutes: number | null
  resetsAt: number | null
}

export interface ProviderQuota {
  available: boolean
  source: string
  reason?: string
  planType?: string
  primary?: ProviderQuotaLimit | null
  secondary?: ProviderQuotaLimit | null
}

export interface ProviderAuthStatus {
  available: boolean
  status: string
  source: string
  loggedIn?: boolean
  authMethod?: string
  apiProvider?: string
}

export interface ProviderTokenUsage {
  windowMs: number
  source: string
  totalTokens: number
  tokensPerMinute: number
  eventCount: number
  sampledAt: number
}

export interface UsageProviderSummary {
  provider: 'codex' | 'claude'
  providerName: string
  auth: ProviderAuthStatus
  quota: ProviderQuota
  tokenUsage: ProviderTokenUsage
}

export interface AgentUsageSummary {
  windowMs: number
  sampledAt: number
  source: 'terminal-output-estimate'
  totalOutputBytes: number
  estimatedOutputTokens: number
  estimatedTokensPerMinute: number
  agents: Array<{
    agentId: string
    command: string
    cwd: string
    isMain: boolean
    status: AgentStatus
    usageRate: AgentUsageRate
  }>
}

export interface UsageSummary {
  sampledAt: number
  windowMs: number
  providers: UsageProviderSummary[]
  agentUsage: AgentUsageSummary | null
  systemStats: SystemStats | null
}

/** Full application state received from backend */
export interface AppState {
  mainAgentId: string | null
  agents: Agent[]
  taskHistory: TaskHistoryEntry[]
  mainPageSessionKeys?: string[]
  systemStats: SystemStats
}
