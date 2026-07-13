import type { AgentTerminalStatus, AppState, SystemStats, TerminalPreviewSnapshot } from './agent'

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
}

export interface ResizeAgentMessage {
  type: 'resize-agent'
  agentId: string
  cols: number
  rows: number
}

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
  | ResizeAgentMessage
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
    data: string
    sessionSource?: string
    replace?: boolean
    outputSeq?: number | null
  }
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
  | SessionPreviewMessage
  | SystemStatsMessage
  | WorkspaceFileWatchMessage
  | WorkspaceFileEventMessage
