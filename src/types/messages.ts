import type { Agent, AgentTerminalStatus, AppState, CodexTerminalProfile, RuntimeObservation, SystemStats, TerminalPreviewSnapshot } from './agent'
import type {
  LanguageServerRequestMessage,
  LanguageServerResultMessage,
  StateDeltaMessage as AgentStateDeltaMessage,
  StateMessage as AgentStateMessage,
  WorkspaceCancelMessage,
  WorkspaceRequestMessage,
  WorkspaceResultMessage,
} from '../../shared/browser-protocol'
export type {
  LanguageServerRequestMessage,
  LanguageServerResultMessage,
  WorkspaceCancelMessage,
  WorkspaceRequest,
  WorkspaceRequestMessage,
  WorkspaceResultMessage,
} from '../../shared/browser-protocol'
import type {
  BrowserResource,
  BrowserResourceCollection,
  BrowserResourceDeletion,
} from '../../extensions/browser/frontend/types'
import type {
  ComputerResource,
  ComputerResourceCollection,
  ComputerResourceDeletion,
} from '../../extensions/computer/frontend/types'

// ---- Client → Server messages ----

export interface ProtocolClientHelloMessage {
  type: 'protocol-hello'
  protocolVersion: number
  initialFocusedAgentId?: string
  initialStateScope?: 'all' | 'focused'
}

export interface BusinessHealthProbeMessage {
  type: 'business-health-probe'
  requestId: string
}

export interface StartAgentMessage {
  type: 'start-agent'
  requestId?: string
  command: string
  workspace?: string
  projectWorkspace?: string
  asMain?: boolean
  codexApprovalMode?: string
  agentRuntimeMode?: 'terminal' | 'chat' | 'acp'
  providerHomeId?: string
  additionalDirectories?: string[]
  mcpServers?: Array<Record<string, unknown>>
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
  requestId?: string
  delivery?: 'prompt' | 'steer'
  attachments?: ComposerInputAttachment[]
}

export interface ComposerInputAttachment {
  kind: 'image' | 'audio'
  path: string
  name: string
  type: string
  size: number
}

export interface PasteInputPart {
  type: 'paste'
  text: string
}

export type TerminalInputPart = string | PasteInputPart

export interface FocusAgentMessage {
  type: 'focus-agent'
  agentId: string | null
  activityScope?: 'all' | 'focused' | 'none'
  previewScope?: 'all' | 'focused' | 'none'
  stateScope?: 'all' | 'focused'
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

export interface TerminalCheckpointRequestMessage {
  type: 'terminal-checkpoint-request'
  requestId: string
  agentId: string
}

export type TerminalSessionClientMessage =
  | InputMessage
  | ClearTerminalMessage
  | ResizeAgentMessage
  | TerminalCheckpointRequestMessage

export interface ArchiveAgentMessage {
  type: 'archive-agent'
  agentId: string
}

export interface InterruptAgentMessage {
  type: 'interrupt-agent'
  agentId: string
}

export interface RestartMainAgentMessage {
  type: 'restart-main-agent'
  command: string
}

export interface StateResyncMessage {
  type: 'state-resync'
  generation?: string
  afterSequence?: number
}

export interface WatchWorkspaceFilesMessage {
  type: 'watch-workspace-files'
  rootId: string
  paths: string[]
}

export interface UnwatchWorkspaceFilesMessage {
  type: 'unwatch-workspace-files'
  rootId?: string
}

export type ClientMessage =
  | ProtocolClientHelloMessage
  | BusinessHealthProbeMessage
  | StartAgentMessage
  | InputMessage
  | ComposerInputMessage
  | FocusAgentMessage
  | TerminalSessionClientMessage
  | ArchiveAgentMessage
  | InterruptAgentMessage
  | RestartMainAgentMessage
  | WatchWorkspaceFilesMessage
  | UnwatchWorkspaceFilesMessage
  | WorkspaceRequestMessage
  | WorkspaceCancelMessage
  | LanguageServerRequestMessage
  | StateResyncMessage

// ---- Server → Client messages ----

export interface ProtocolServerHelloMessage {
  type: 'protocol-hello'
  protocolVersion: number
  minProtocolVersion: number
  accessMode?: 'owner' | 'read-only'
  maxInlineWorkspaceMessageBytes?: number
}

export interface ProtocolErrorMessage {
  type: 'protocol-error'
  protocolVersion: number
  requestId?: string
  message: string
}

export interface BusinessHealthResultMessage {
  type: 'business-health-result'
  requestId: string
  serverEpoch: string
  protocolVersion: number
  status: 'ready' | 'recovering' | 'failed' | 'stopping'
  agentCount: number
  mainAgentId: string | null
}

export interface TerminalCheckpointResultMessage {
  type: 'terminal-checkpoint-result'
  requestId: string
  agentId: string
  ok: boolean
  session?: Record<string, unknown>
  error?: string
}

export interface CommandAckMessage {
  type: 'command-ack'
  requestId: string
  command: string
}

export type StateMessage = AgentStateMessage<Agent, Partial<Omit<AppState, 'agents'>>>

export type StateDeltaMessage = AgentStateDeltaMessage<Agent, Partial<Omit<AppState, 'agents'>>>

export interface ErrorMessage {
  type: 'error'
  message: string
}

export interface ComposerInputResultMessage {
  type: 'composer-input-result'
  requestId: string
  agentId: string
  accepted: boolean
  message?: string
  uncertain?: boolean
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

export interface AgentActivitySnapshotMessage {
  type: 'agent-activity-snapshot'
  activities: AgentActivityMessage['activity'][]
}

export interface AgentReadMessage {
  type: 'agent-read'
  read: Pick<
    Agent,
    'unread' | 'attentionSeq' | 'readAttentionSeq' |
    'attentionUpdatedAt' | 'readAttentionAt' | 'attentionReason' | 'attentionSummary' |
    'attentionOutputEpoch' | 'attentionOutputSeq' | 'readOutputEpoch' | 'readOutputSeq'
  > & {
    agentId: string
  }
}

export interface AgentUpdateMessage {
  type: 'agent-update'
  update: {
    agentId: string
    patch: {
      adaptiveTitle?: string
      codexTerminalProfile?: CodexTerminalProfile | null
      sessionTitle?: string
      runtimeBinding?: Agent['runtimeBinding']
      terminalInputReceived?: boolean
      terminalBusy?: boolean | null
      shellCwd?: string
      shellLastExitCode?: number | null
      shellLastEvent?: string
      shellCommand?: string
      shellLastCommand?: string
      shellCommandStartedAt?: number | null
      shellLastCommandStartedAt?: number | null
      shellLastCommandFinishedAt?: number | null
      shellLastCommandDurationMs?: number | null
      terminalStatus?: AgentTerminalStatus | null
      runtimeObservation?: RuntimeObservation
    }
  }
}

export interface AcpSessionRevisionMessage {
  type: 'acp-session-revision'
  session: {
    agentId: string
    revision: number
    updatedAt: string
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
  rootId: string
  paths: string[]
  watching: boolean
}

export interface WorkspaceFileEventMessage {
  type: 'workspace-file-event'
  event: {
    rootId: string
    type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'error'
    path?: string
    message?: string
  }
}

export interface LanguageServerRefreshMessage {
  type: 'language-server-refresh'
  serverEpoch: string
  rootId: string
  workspace: string
  kind: 'semanticTokens' | 'inlayHints'
  revision: number
}

export interface BrowserResourceSnapshotMessage {
  type: 'browser-resource-snapshot'
  snapshot: BrowserResourceCollection
}

export interface BrowserResourceUpdateMessage {
  type: 'browser-resource-updated'
  resource: BrowserResource
}

export interface BrowserResourceDeletedMessage {
  type: 'browser-resource-deleted'
  deletion: BrowserResourceDeletion
}

export interface ComputerResourceSnapshotMessage {
  type: 'computer-resource-snapshot'
  snapshot: ComputerResourceCollection
}

export interface ComputerResourceUpdateMessage {
  type: 'computer-resource-updated'
  resource: ComputerResource
}

export interface ComputerResourceDeletedMessage {
  type: 'computer-resource-deleted'
  deletion: ComputerResourceDeletion
}

export type ServerMessage =
  | ProtocolServerHelloMessage
  | ProtocolErrorMessage
  | BusinessHealthResultMessage
  | TerminalCheckpointResultMessage
  | CommandAckMessage
  | StateMessage
  | StateDeltaMessage
  | ErrorMessage
  | ComposerInputResultMessage
  | AgentStartedMessage
  | SessionOutputMessage
  | SessionPreviewMessage
  | SystemStatsMessage
  | AgentActivityMessage
  | AgentActivitySnapshotMessage
  | AgentUpdateMessage
  | AcpSessionRevisionMessage
  | AgentReadMessage
  | WorkspaceFileWatchMessage
  | WorkspaceFileEventMessage
  | WorkspaceResultMessage
  | LanguageServerResultMessage
  | LanguageServerRefreshMessage
  | BrowserResourceSnapshotMessage
  | BrowserResourceUpdateMessage
  | BrowserResourceDeletedMessage
  | ComputerResourceSnapshotMessage
  | ComputerResourceUpdateMessage
  | ComputerResourceDeletedMessage
