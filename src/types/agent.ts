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
  cursorVisible?: boolean
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

export interface AgentGitWorktree {
  workspace: string
  commonDir: string
  mainWorkspace: string
  linked: boolean
  branch: string
  head: string
  detached: boolean
  locked: boolean
  lockReason: string
  prunable: boolean
  pruneReason: string
  worktrees: AgentGitWorktreeItem[]
}

export interface AgentGitWorktreeItem {
  workspace: string
  head: string
  branch: string
  bare: boolean
  detached: boolean
  locked: boolean
  lockReason: string
  prunable: boolean
  pruneReason: string
  current: boolean
  main: boolean
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

export interface CodexTerminalProfile {
  model: string
  reasoningEffort: string
  serviceTier: 'default' | 'priority' | string
  source: 'terminal-footer' | string
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
  _meta?: Record<string, unknown> | null
}

export interface AcpPendingPermission {
  requestId: string
  sessionId: string
  origin?: 'agent' | 'subagent' | string
  _meta?: Record<string, unknown> | null
  toolCall: {
    toolCallId: string
    title?: string | null
    kind?: string | null
    status?: string | null
    content?: unknown
    locations?: unknown
    rawInput?: unknown
    rawOutput?: unknown
    _meta?: Record<string, unknown> | null
  }
  options: AcpPermissionOption[]
  securityWarnings?: Array<{
    targetType: 'host' | 'path' | string
    value: string
    displayValue: string
    characters: Array<{
      character: string
      codePoint: string
      kind: 'bidi-control' | 'invisible' | 'confusable' | string
      description: string
    }>
  }>
}

export interface AcpElicitationProperty {
  type: string
  title?: string | null
  description?: string | null
  default?: string | number | boolean | string[] | null
  enum?: string[] | null
  oneOf?: Array<{ const: string; title: string; description?: string | null }> | null
  items?: {
    type?: string
    enum?: string[]
    anyOf?: Array<{ const: string; title: string; description?: string | null }>
  }
  minimum?: number | null
  maximum?: number | null
  minLength?: number | null
  maxLength?: number | null
  minItems?: number | null
  maxItems?: number | null
  pattern?: string | null
  format?: string | null
}

export interface AcpPendingElicitation {
  requestId: string
  sessionId?: string
  origin?: 'agent' | 'subagent' | string
  protocolRequestId?: string | number | null
  toolCallId?: string | null
  mode: 'form' | 'url' | string
  message: string
  elicitationId?: string
  url?: string
  status?: string
  requestedSchema?: {
    title?: string | null
    description?: string | null
    properties?: Record<string, AcpElicitationProperty>
    required?: string[] | null
  }
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

export interface TerminalRuntimeBinding {
  kind: 'terminal'
}

export interface AcpRuntimeBinding {
  kind: 'acp'
  state: string
  error: string
  stopReason: string
  pendingPermission: AcpPendingPermission | null
  pendingPermissions: AcpPendingPermission[]
  pendingElicitation: AcpPendingElicitation | null
  pendingElicitations: AcpPendingElicitation[]
  activeElicitations: AcpPendingElicitation[]
  sessionUpdatedAt: string
  sessionRevision: number
}

export interface JsonRuntimeBinding {
  kind: 'json'
  state: string
  error: string
  transcriptUpdatedAt: string
}

export interface CodexAppServerRuntimeBinding {
  kind: 'app-server'
  state: string
  endpoint: string
  threadId: string
  turnId: string
  error: string
  pendingRequestId: string
  pendingRequestMethod: string
  pendingRequest: CodexAppServerPendingRequest | null
  notice: CodexAppServerNotice | null
  goal: CodexAppServerGoal | null
  observerDeferred: boolean
}

export type AgentRuntimeBinding =
  | TerminalRuntimeBinding
  | AcpRuntimeBinding
  | JsonRuntimeBinding
  | CodexAppServerRuntimeBinding

export interface RuntimeObservation {
  kind: 'codex' | 'claude' | 'shell' | 'process' | 'unknown'
  phase: 'starting' | 'working' | 'waiting' | 'idle' | 'exited' | 'unknown'
  confidence: 'authoritative' | 'high' | 'heuristic'
  source: 'structured-runtime' | 'shell-marker' | 'terminal-observer'
  observerVersion: string
  observedAt: number
}

export interface WorkspaceRoot {
  rootId: string
  kind: 'global' | 'main-worktree' | 'linked-worktree' | 'directory'
  canonicalPath: string
  repositoryId: string
  accessPolicy: {
    readOnly: boolean
    watch: boolean
    externalReads: boolean
  }
}

export interface ProviderCapabilities {
  supportedRuntimes: Array<'terminal' | 'acp' | 'json' | 'app-server'>
  runtimeSwitch: boolean
  terminalProfile: boolean
  goals: boolean
}

/** A single CLI agent instance */
export interface Agent {
  id: string
  command: string
  engineName?: string
  cwd: string
  projectWorkspace?: string
  gitWorktree?: AgentGitWorktree | null
  launchPermissionMode?: string
  output: string
  renderOutput?: string
  runtimeEpoch?: string
  outputSeq?: number | null
  stateRevision?: number | null
  previewText?: string
  previewSnapshot?: TerminalPreviewSnapshot | null
  previewCols?: number
  previewRows?: number
  codexTerminalProfile?: CodexTerminalProfile | null
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
  providerCapabilities: ProviderCapabilities
  terminalInputReceived?: boolean
  runtimeBinding: AgentRuntimeBinding
  runtimeObservation: RuntimeObservation
  workspaceRootId?: string
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
  attentionOutputEpoch?: string
  attentionOutputSeq?: number | null
  readOutputEpoch?: string
  readOutputSeq?: number | null
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
  available: boolean
  windowMs: number
  source: string
  reason?: string
  totalTokens: number | null
  tokensPerMinute: number | null
  eventCount: number
  sampledAt: number
}

export interface UsageProviderSummary {
  provider: 'codex' | 'claude' | 'opencode' | 'qoder'
  providerName: string
  auth: ProviderAuthStatus
  quota: ProviderQuota
  tokenUsage: ProviderTokenUsage
}

export interface UsageTimelinePoint {
  startedAt: number
  endedAt: number
  totalTokens: number
  tokensPerMinute: number
  providers: Record<string, number>
}

export interface UsageTimeline {
  source: string
  sampledAt: number
  startAt: number
  endAt: number
  windowMs: number
  bucketMs: number
  bucketCount: number
  totalTokens: number
  averageTokensPerMinute: number
  peakTokensPerMinute: number
  activeBucketCount: number
  points: UsageTimelinePoint[]
}

export interface UsageDailyTokenBreakdown {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  unattributedTokens: number
}

export interface UsageDailyPoint extends UsageDailyTokenBreakdown {
  date: string
  providers: Record<string, UsageDailyTokenBreakdown>
}

export interface UsageDailyHistory {
  source: string
  sampledAt: number
  timeZone: string
  days: number
  startDate: string
  endDate: string
  partial?: boolean
  summary: {
    todayTokens: number
    sevenDayTokens: number
    thirtyDayTokens: number
    periodTokens: number
    peakDate: string
    peakTokens: number
  }
  points: UsageDailyPoint[]
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
  timeline: UsageTimeline
  daily?: UsageDailyHistory | null
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
  workspaceRoots?: WorkspaceRoot[]
  systemStats: SystemStats
}
