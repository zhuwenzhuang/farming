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

export interface CodexAppServerPendingRequest {
  id: string
  method: string
  params: Record<string, unknown>
  receivedAt: string
}

export interface CodexAppServerNotice {
  id: string
  kind: 'approval-rejected' | string
  method: string
  message: string
  receivedAt: string
}

export type CodexGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'

export interface CodexAppServerGoal {
  threadId: string
  objective: string
  status: CodexGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
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
  providerHomeId?: string
  providerHomePath?: string
  providerSessionId?: string
  providerSessionKey?: string
  providerSessionTemporary?: boolean
  providerSessionSource?: string
  providerSessionResolvedAt?: number | null
  providerSessionTitle?: string
  codexRuntimeMode?: 'app-server' | 'cli' | string
  agentRuntimeMode?: 'terminal' | 'json' | string
  jsonCliState?: string
  jsonCliError?: string
  jsonCliTranscriptUpdatedAt?: string
  codexAppServerState?: string
  codexAppServerEndpoint?: string
  codexAppServerThreadId?: string
  codexAppServerTurnId?: string
  codexAppServerError?: string
  codexAppServerPendingRequestId?: string
  codexAppServerPendingRequestMethod?: string
  codexAppServerPendingRequest?: CodexAppServerPendingRequest | null
  codexAppServerNotice?: CodexAppServerNotice | null
  codexAppServerGoal?: CodexAppServerGoal | null
  codexCliObserverDeferred?: boolean
  forkedFromProviderSessionId?: string
  restartedFromAgentId?: string
  restartedFromAgentIds?: string[]
  pinned?: boolean
  projectOrder?: number | null
  pinnedOrder?: number | null
  unread?: boolean
  attentionSeq?: number
  readAttentionSeq?: number
  attentionUpdatedAt?: number | null
  readAttentionAt?: number | null
  attentionReason?: string
  attentionOutputSeq?: number | null
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
  customTitle?: string
}

export interface TaskHistoryEntry {
  id: string
  agentId: string
  command: string
  cwd: string
  projectWorkspace?: string
  title?: string
  customTitle?: string
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
  totalTokens?: number | null
  forecast?: ProviderQuotaForecast | null
}

export interface ProviderQuotaForecast {
  source: string
  usedPercent: number
  remainingPercent: number
  burnRatePercentPerMinute: number
  etaMs: number | null
  projectedExhaustedAt: number | null
  projectedEndPercent: number | null
  resetInMs: number | null
  windowElapsedMs: number
  totalTokens: number | null
  usedTokens: number | null
  remainingTokens: number | null
}

export interface ProviderQuota {
  available: boolean
  source: string
  reason?: string
  limitId?: string
  limitName?: string | null
  planType?: string
  resetCreditsAvailable?: number | null
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
