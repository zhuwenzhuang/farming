import type { Agent, AgentTerminalStatus, AppState, CodexTerminalProfile, RuntimeObservation, SystemStats, TerminalPreviewSnapshot } from './agent'

// ---- Client → Server messages ----

export interface ProtocolClientHelloMessage {
  type: 'protocol-hello'
  protocolVersion: number
}

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
  cols: number
  rows: number
}

export interface ClearTerminalMessage {
  type: 'clear-terminal'
  agentId: string
}

export type TerminalSessionClientMessage =
  | InputMessage
  | ClearTerminalMessage
  | ResizeAgentMessage

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
  | ProtocolClientHelloMessage
  | StartAgentMessage
  | InputMessage
  | ComposerInputMessage
  | AppServerRequestResponseMessage
  | FocusAgentMessage
  | TerminalSessionClientMessage
  | KillAgentMessage
  | InterruptAgentMessage
  | RestartMainAgentMessage
  | WatchWorkspaceFilesMessage
  | UnwatchWorkspaceFilesMessage

// ---- Server → Client messages ----

export interface ProtocolServerHelloMessage {
  type: 'protocol-hello'
  protocolVersion: number
  minProtocolVersion: number
}

export interface ProtocolErrorMessage {
  type: 'protocol-error'
  protocolVersion: number
  requestId?: string
  message: string
}

export interface CommandAckMessage {
  type: 'command-ack'
  requestId: string
  command: string
}

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

export interface SystemStatsMessage {
  type: 'system-stats'
  stats: SystemStats
  uptime: number
}

export interface AgentActivityMessage {
  type: 'agent-activity'
  activity: Pick<Agent, 'lastActivity' | 'activityLevel' | 'attentionScore' | 'isZombie' | 'usageRate'> & {
    agentId: string
  }
}

export interface AgentReadMessage {
  type: 'agent-read'
  read: Pick<Agent, 'unread' | 'attentionSeq' | 'readAttentionSeq' | 'readOutputEpoch' | 'readOutputSeq'> & {
    agentId: string
  }
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
    runtimeObservation?: RuntimeObservation
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
  | ProtocolServerHelloMessage
  | ProtocolErrorMessage
  | CommandAckMessage
  | StateMessage
  | ErrorMessage
  | AgentStartedMessage
  | SessionOutputMessage
  | SessionPreviewMessage
  | SystemStatsMessage
  | AgentActivityMessage
  | AgentReadMessage
  | WorkspaceFileWatchMessage
  | WorkspaceFileEventMessage
