import type { AgentTerminalStatus, AppState, CodexTerminalProfile, SystemStats, TerminalPreviewSnapshot } from './agent'

// ---- Client → Server messages ----

export interface StartAgentMessage {
  type: 'start-agent'
  command: string
  workspace?: string
  projectWorkspace?: string
  asMain?: boolean
  codexApprovalMode?: string
  codexRuntimeMode?: 'cli' | 'app-server'
  agentRuntimeMode?: 'terminal' | 'acp' | 'json'
  providerHomeId?: string
  dangerouslySkipPermissions?: boolean
  /** Sub-agent task body (may include workflow prefix from mergeTaskWithWorkflow) */
  task?: string
  workflowTemplate?: string
  customTitle?: string
}

export interface InputMessage {
  type: 'input'
  input?: string
  inputParts?: TerminalInputPart[]
  agentId?: string
  attachmentId?: string
  leaseId?: string
  fence?: number
  expectedRuntimeEpoch?: string
}

export interface OwnedTerminalInputMessage extends InputMessage {
  agentId: string
  attachmentId: string
  leaseId: string
  fence: number
  expectedRuntimeEpoch: string
}

export interface ComposerInputMessage {
  type: 'composer-input'
  message: string
  agentId?: string
  attachments?: ComposerInputAttachment[]
}

export interface ComposerInputAttachment {
  kind: 'image'
  path: string
  name: string
  type: string
  size: number
}

export interface AppServerRequestResponseMessage {
  type: 'app-server-request-response'
  agentId: string
  requestId: string
  result?: unknown
  reject?: boolean
  reason?: string
}

export interface PasteInputPart {
  type: 'paste'
  text: string
}

export type TerminalInputPart = string | PasteInputPart

export interface FocusAgentMessage {
  type: 'focus-agent'
  agentId: string
  refreshState?: boolean
}

export interface ResizeAgentMessage {
  type: 'resize-agent'
  agentId: string
  attachmentId: string
  leaseId: string
  fence: number
  requestSeq: number
  expectedRuntimeEpoch: string
  cols: number
  rows: number
}

export interface TerminalControllerClaimMessage {
  type: 'terminal-controller-claim'
  agentId: string
  attachmentId: string
  claimId: string
  mode: 'passive' | 'interactive'
  expectedRuntimeEpoch?: string
}

export interface TerminalControllerRenewMessage {
  type: 'terminal-controller-renew'
  agentId: string
  attachmentId: string
  leaseId: string
  fence: number
}

export interface TerminalControllerReleaseMessage {
  type: 'terminal-controller-release'
  agentId: string
  attachmentId: string
  leaseId: string
  fence: number
}

export interface TerminalRendererReadyMessage {
  type: 'terminal-renderer-ready'
  agentId: string
  attachmentId: string
  leaseId: string
  fence: number
  expectedRuntimeEpoch: string
}

export interface ClearTerminalMessage {
  type: 'clear-terminal'
  agentId: string
  attachmentId: string
  leaseId: string
  fence: number
  expectedRuntimeEpoch: string
}

export interface TerminalOutputAckMessage {
  type: 'terminal-output-ack'
  agentId: string
  attachmentId: string
  leaseId: string
  fence: number
  expectedRuntimeEpoch: string
  charCount: number
}

export type TerminalControllerClientMessage =
  | OwnedTerminalInputMessage
  | ClearTerminalMessage
  | TerminalOutputAckMessage
  | ResizeAgentMessage
  | TerminalControllerClaimMessage
  | TerminalControllerRenewMessage
  | TerminalControllerReleaseMessage
  | TerminalRendererReadyMessage

export interface KillAgentMessage {
  type: 'kill-agent'
  agentId: string
}

export interface InterruptAgentMessage {
  type: 'interrupt-agent'
  agentId: string
}

export interface RestartMainAgentMessage {
  type: 'restart-main-agent'
  command: 'codex' | 'claude' | 'opencode' | 'qoder' | 'bash' | 'zsh'
}

export interface WatchWorkspaceFilesMessage {
  type: 'watch-workspace-files'
  agentId: string
}

export interface UnwatchWorkspaceFilesMessage {
  type: 'unwatch-workspace-files'
  agentId?: string
}

export type ClientMessage =
  | StartAgentMessage
  | InputMessage
  | ComposerInputMessage
  | AppServerRequestResponseMessage
  | FocusAgentMessage
  | TerminalControllerClientMessage
  | KillAgentMessage
  | InterruptAgentMessage
  | RestartMainAgentMessage
  | WatchWorkspaceFilesMessage
  | UnwatchWorkspaceFilesMessage

// ---- Server → Client messages ----

export interface StateMessage {
  type: 'state'
  state: AppState
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export interface AgentStartedMessage {
  type: 'agent-started'
  agentId: string
}

export interface SessionOutputMessage {
  type: 'session-output'
  stream: {
    agentId: string
    kind?: 'output' | 'resize' | 'clear'
    data: string
    sessionSource?: string
    replace?: boolean
    runtimeEpoch?: string
    outputSeq?: number | null
    stateRevision?: number | null
    cols?: number
    rows?: number
    chunks?: Array<{
      kind?: 'output' | 'resize' | 'clear'
      data: string
      runtimeEpoch?: string
      outputSeq: number
      stateRevision: number
      cols?: number
      rows?: number
    }>
  }
}

export interface TerminalControllerMessage {
  type: 'terminal-controller'
  agentId: string
  attachmentId: string
  claimId?: string
  status:
    | 'owner'
    | 'observer'
    | 'revoked'
    | 'expired'
    | 'unowned'
    | 'rejected'
    | 'resize-committed'
    | 'resize-rejected'
  leaseId?: string
  fence?: number
  expiresAt?: number
  requestSeq?: number
  reason?: string
  renewed?: boolean
  unchanged?: boolean
  duplicate?: boolean
}

export interface SystemStatsMessage {
  type: 'system-stats'
  stats: SystemStats
  uptime: number
}

export interface SessionPreviewMessage {
  type: 'session-preview'
  preview: {
    agentId: string
    previewText: string
    cols: number
    rows: number
    previewSnapshot?: TerminalPreviewSnapshot | null
    terminalStatus?: AgentTerminalStatus | null
    codexTerminalProfile?: CodexTerminalProfile | null
  }
}

export interface WorkspaceFileWatchMessage {
  type: 'workspace-file-watch'
  agentId: string
  watching: boolean
}

export interface WorkspaceFileEventMessage {
  type: 'workspace-file-event'
  event: {
    agentId: string
    type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'error'
    path?: string
    message?: string
  }
}

export type ServerMessage =
  | StateMessage
  | ErrorMessage
  | AgentStartedMessage
  | SessionOutputMessage
  | TerminalControllerMessage
  | SessionPreviewMessage
  | SystemStatsMessage
  | WorkspaceFileWatchMessage
  | WorkspaceFileEventMessage
