import { PROJECT_ATTENTION_SCORE_MAX as projectAttentionScoreMax } from './agent-state-semantics.js'
import { isAgentStateWire } from './agent-state-wire.js'
import type { AgentStateWire } from './agent-state-wire.js'

export const PROTOCOL_VERSION = 17
export const MIN_PROTOCOL_VERSION = 17
export const MAX_INLINE_WORKSPACE_MESSAGE_BYTES = 1024 * 1024
export const PROJECT_ATTENTION_SCORE_MAX = projectAttentionScoreMax

export interface ProtocolReloadStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

type ObjectMessage = Record<string, unknown>

interface ExtensibleMessage extends ObjectMessage {
  type: string
}

export interface AgentStateRecord extends ObjectMessage {
  id: string
}

export type { AgentStateWire }

export interface AgentStateCursor {
  generation: string
  sequence: number
}

export interface AgentStateSnapshotPage {
  complete: boolean
  id: string
  offset: number
  total: number
}

export type AgentStatePayload<
  AgentRecord extends { id: string } = AgentStateRecord,
  StateMetadata extends object = ObjectMessage,
> = StateMetadata & { agents: AgentRecord[] }

export interface ProtocolClientHelloMessage extends ExtensibleMessage {
  type: 'protocol-hello'
  protocolVersion: number
  initialFocusedAgentId?: string
  initialStateScope?: 'all' | 'focused'
}

export interface BusinessHealthProbeMessage extends ExtensibleMessage {
  type: 'business-health-probe'
  requestId: string
}

export interface TerminalCheckpointRequestMessage extends ExtensibleMessage {
  type: 'terminal-checkpoint-request'
  requestId: string
  agentId: string
}

export interface StartAgentMessage extends ExtensibleMessage {
  type: 'start-agent'
  command: string
}

export interface InputMessage extends ExtensibleMessage {
  type: 'input'
  /** Optional diagnostic correlation, never an acknowledgement or replay token. */
  performanceId?: string
  agentId?: string
  input?: string
  inputParts?: unknown[]
}

export interface ComposerInputMessage extends ExtensibleMessage {
  type: 'composer-input'
  message: string
  agentId?: string
  requestId?: string
  delivery?: 'prompt' | 'steer'
}

export interface AcpPermissionResponseMessage extends ExtensibleMessage {
  type: 'acp-permission-response'
  agentId: string
  requestId: string
  optionId: string
  cancelled?: boolean
}

export interface FocusAgentMessage extends ExtensibleMessage {
  type: 'focus-agent'
  agentId: string | null
  activityScope?: 'all' | 'focused' | 'none'
  previewScope?: 'all' | 'focused' | 'none'
  stateScope?: 'all' | 'focused'
}

export interface WatchAcpTranscriptsMessage extends ExtensibleMessage {
  type: 'watch-acp-transcripts'
  agentIds: string[]
}

export interface ResizeAgentMessage extends ExtensibleMessage {
  type: 'resize-agent'
  agentId: string
  cols: number
  rows: number
}

type AgentScopedClientMessageType =
  | 'interrupt-agent'
  | 'clear-terminal'
  | 'archive-agent'

export interface AgentScopedClientMessage<Type extends AgentScopedClientMessageType> extends ExtensibleMessage {
  type: Type
  agentId: string
}

export interface UnwatchWorkspaceFilesMessage extends ExtensibleMessage {
  type: 'unwatch-workspace-files'
  rootId?: string
}

export interface WatchWorkspaceFilesMessage extends ExtensibleMessage {
  type: 'watch-workspace-files'
  rootId: string
  paths: string[]
}

export type WorkspaceRequest =
  | { operation: 'tree'; rootId: string; path?: string }
  | { operation: 'tree-decorations'; rootId: string; path?: string; entryPaths: string[] }
  | { operation: 'read-file'; rootId: string; path: string; exactExternal?: boolean }
  | { operation: 'create-preview'; rootId: string; path: string; exactExternal?: boolean }
  | { operation: 'delete-preview'; previewId: string }
  | { operation: 'save-file'; rootId: string; path: string; content: string; baseSha1: string; overwrite?: boolean }
  | { operation: 'move-entry'; rootId: string; sourcePath: string; targetDirectory: string; expectedVersion?: string }
  | { operation: 'create-entry'; rootId: string; parentPath: string; name: string; entryType: 'file' | 'directory' }
  | { operation: 'rename-entry'; rootId: string; path: string; name: string; expectedVersion?: string }
  | { operation: 'delete-entry'; rootId: string; path: string; expectedVersion?: string }
  | { operation: 'search'; rootId: string; query: string; path?: string; includeIgnored?: boolean; limit?: number; scope?: 'all' | 'file-path' | 'entries' }
  | { operation: 'blame'; rootId: string; path: string }
  | { operation: 'blame-capability'; rootId: string; path: string }
  | { operation: 'diff'; rootId: string; path: string }
  | { operation: 'changes'; rootId: string; limit?: number }
  | { operation: 'worktrees'; rootId: string }
  | { operation: 'branches'; rootId: string }
  | { operation: 'branch'; rootId: string }
  | { operation: 'switch-branch'; rootId: string; branch: string; expectedBranch: string; expectedHead: string; operationId: string }
  | { operation: 'history'; rootId: string; limit?: number; skip?: number; scope?: 'current' | 'all' }
  | { operation: 'history-changes'; rootId: string; commit: string; parent?: string; limit?: number }
  | { operation: 'line-changes'; rootId: string; path: string; lineNumber: number; mode: 'working' | 'previous' }

export interface WorkspaceRequestMessage extends ExtensibleMessage {
  type: 'workspace-request'
  requestId: string
  request: WorkspaceRequest
}

export interface WorkspaceCancelMessage extends ExtensibleMessage {
  type: 'workspace-cancel'
  requestId: string
}

export interface LanguageServerRequestPayload extends ObjectMessage {
  operation: 'capability' | 'request'
  priority?: 'interactive' | 'background'
  rootId?: string
  method?: string
  filePath?: string
  position?: unknown
  range?: unknown
  query?: string
  itemId?: string
  force?: boolean
}

export interface LanguageServerRequestMessage extends ExtensibleMessage {
  type: 'language-server-request'
  requestId: string
  request: LanguageServerRequestPayload
}

export interface RestartMainAgentMessage extends ExtensibleMessage {
  type: 'restart-main-agent'
  command: string
}

export interface StateResyncMessage extends ExtensibleMessage {
  type: 'state-resync'
  generation?: string
  afterSequence?: number
}

export interface DesktopBrowserAdapterRegisterMessage extends ExtensibleMessage {
  type: 'desktop-browser-adapter-register'
  adapterId: string
}

export interface DesktopBrowserAdapterResponseMessage extends ExtensibleMessage {
  type: 'desktop-browser-adapter-response'
  adapterId: string
  requestId: string
  resourceId: string
  sessionId: string
  generation: number
  ok: boolean
  result?: unknown
  error?: string
  code?: string
  status?: number
  uncertain?: boolean
}

export interface DesktopBrowserAdapterEventMessage extends ExtensibleMessage {
  type: 'desktop-browser-adapter-event'
  adapterId: string
  resourceId: string
  sessionId: string
  generation: number
  kind: string
  payload?: ObjectMessage
}

export type ClientMessage =
  | ProtocolClientHelloMessage
  | BusinessHealthProbeMessage
  | TerminalCheckpointRequestMessage
  | StartAgentMessage
  | InputMessage
  | ComposerInputMessage
  | AcpPermissionResponseMessage
  | FocusAgentMessage
  | WatchAcpTranscriptsMessage
  | ResizeAgentMessage
  | AgentScopedClientMessage<'interrupt-agent'>
  | AgentScopedClientMessage<'clear-terminal'>
  | WatchWorkspaceFilesMessage
  | WorkspaceRequestMessage
  | WorkspaceCancelMessage
  | LanguageServerRequestMessage
  | AgentScopedClientMessage<'archive-agent'>
  | UnwatchWorkspaceFilesMessage
  | RestartMainAgentMessage
  | StateResyncMessage
  | DesktopBrowserAdapterRegisterMessage
  | DesktopBrowserAdapterResponseMessage
  | DesktopBrowserAdapterEventMessage

export interface ProtocolServerHelloMessage extends ExtensibleMessage {
  type: 'protocol-hello'
  protocolVersion: number
  minProtocolVersion: number
  accessMode?: 'owner' | 'read-only'
  maxInlineWorkspaceMessageBytes?: number
}

export interface WorkspaceProtocolError extends ObjectMessage {
  code: string
  message: string
  status?: number
  details?: unknown
  uncertain?: boolean
}

export interface WorkspaceResultMessage extends ExtensibleMessage {
  type: 'workspace-result'
  requestId: string
  ok: boolean
  result?: unknown
  error?: WorkspaceProtocolError
}

export interface LanguageServerResultMessage extends ExtensibleMessage {
  type: 'language-server-result'
  requestId: string
  ok: boolean
  result?: unknown
  supported?: boolean
  error?: WorkspaceProtocolError
}

export interface BusinessHealthResultMessage extends ExtensibleMessage {
  type: 'business-health-result'
  requestId: string
  serverEpoch: string
  protocolVersion: number
  status: 'ready' | 'recovering' | 'failed' | 'stopping'
  agentCount: number
  mainAgentId: string | null
}

export interface TerminalCheckpointResultMessage extends ExtensibleMessage {
  type: 'terminal-checkpoint-result'
  requestId: string
  agentId: string
  ok: boolean
  session?: ObjectMessage
  error?: string
}

export interface ErrorServerMessage<Type extends 'protocol-error' | 'error'> extends ExtensibleMessage {
  type: Type
  message: string
}

export interface CommandAckMessage extends ExtensibleMessage {
  type: 'command-ack'
  requestId: string
  command: string
}

export interface StateMessage<
  AgentRecord extends { id: string } = AgentStateRecord,
  StateMetadata extends object = ObjectMessage,
> extends ExtensibleMessage {
  type: 'state'
  generation: string
  sequence: number
  snapshot?: AgentStateSnapshotPage
  state: AgentStatePayload<AgentRecord, StateMetadata>
}

export interface AgentStateDeltaBody<
  AgentRecord extends { id: string } = AgentStateRecord,
  StateMetadata extends object = ObjectMessage,
> {
  sequence: number
  upserts: AgentRecord[]
  removedAgentIds: string[]
  state?: StateMetadata
}

export interface StateDeltaMessage<
  AgentRecord extends { id: string } = AgentStateRecord,
  StateMetadata extends object = ObjectMessage,
> extends ExtensibleMessage, AgentStateDeltaBody<AgentRecord, StateMetadata> {
  type: 'state-delta'
  generation: string
}

export interface ComposerInputResultMessage extends ExtensibleMessage {
  type: 'composer-input-result'
  requestId: string
  agentId: string
  accepted: boolean
  message?: string
  uncertain?: boolean
}

export interface AgentStartedMessage extends ExtensibleMessage {
  type: 'agent-started'
  agentId: string
}

export interface SessionOutputMessage extends ExtensibleMessage {
  type: 'session-output'
  stream: ObjectMessage & { agentId: string }
}

export interface SessionPreviewMessage extends ExtensibleMessage {
  type: 'session-preview'
  preview: ObjectMessage & { agentId: string }
}

export interface SystemStatsMessage extends ExtensibleMessage {
  type: 'system-stats'
  stats: ObjectMessage
}

export interface AgentActivityMessage extends ExtensibleMessage {
  type: 'agent-activity'
  activity: ObjectMessage & { agentId: string }
}

export interface AgentActivitySnapshotMessage extends ExtensibleMessage {
  type: 'agent-activity-snapshot'
  activities: Array<ObjectMessage & { agentId: string }>
}

export interface AgentUpdatePatch {
  adaptiveTitle?: string
  codexTerminalProfile?: ObjectMessage | null
  sessionTitle?: string
  runtimeBinding?: ObjectMessage
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
  terminalStatus?: ObjectMessage | null
  runtimeObservation?: ObjectMessage
}

export interface AgentUpdateMessage extends ExtensibleMessage {
  type: 'agent-update'
  update: ObjectMessage & {
    agentId: string
    patch: AgentUpdatePatch
  }
}

export interface AcpSessionRevisionMessage extends ExtensibleMessage {
  type: 'acp-session-revision'
  session: ObjectMessage & {
    agentId: string
    sessionId: string
    runtimeEpoch: string
    revision: number
    updatedAt: string
  }
}

export interface AgentReadMessage extends ExtensibleMessage {
  type: 'agent-read'
  read: ObjectMessage & {
    agentId: string
    unread: boolean
    attentionSeq: number
    readAttentionSeq: number
    attentionUpdatedAt?: number | null
    readAttentionAt?: number | null
    attentionReason?: string
    attentionSummary?: string
    attentionOutputEpoch?: string
    attentionOutputSeq?: number | null
    readOutputEpoch: string
    readOutputSeq: number | null
  }
}

export interface WorkspaceFileWatchMessage extends ExtensibleMessage {
  type: 'workspace-file-watch'
  rootId: string
  paths: string[]
  watching: boolean
}

export interface WorkspaceFileEventMessage extends ExtensibleMessage {
  type: 'workspace-file-event'
  event: ObjectMessage & { rootId: string }
}

export interface LanguageServerRefreshMessage extends ExtensibleMessage {
  type: 'language-server-refresh'
  serverEpoch: string
  rootId: string
  workspace: string
  kind: 'semanticTokens' | 'inlayHints'
  revision: number
}

export interface BrowserResourceSnapshotMessage extends ExtensibleMessage {
  type: 'browser-resource-snapshot'
  snapshot: ObjectMessage & { collectionRevision: number; resources: unknown[] }
}

export interface BrowserResourceUpdateMessage extends ExtensibleMessage {
  type: 'browser-resource-updated'
  resource: ObjectMessage & { id: string; revision: number; collectionRevision: number }
}

export interface BrowserResourceDeletedMessage extends ExtensibleMessage {
  type: 'browser-resource-deleted'
  deletion: ObjectMessage & { id: string; collectionRevision: number }
}

export interface ComputerResourceSnapshotMessage extends ExtensibleMessage {
  type: 'computer-resource-snapshot'
  snapshot: ObjectMessage & { collectionRevision: number; resources: unknown[] }
}

export interface ComputerResourceUpdateMessage extends ExtensibleMessage {
  type: 'computer-resource-updated'
  resource: ObjectMessage & { id: string; revision: number; collectionRevision: number }
}

export interface ComputerResourceDeletedMessage extends ExtensibleMessage {
  type: 'computer-resource-deleted'
  deletion: ObjectMessage & { id: string; collectionRevision: number }
}

export interface DesktopBrowserAdapterCommandMessage extends ExtensibleMessage {
  type: 'desktop-browser-command'
  command: ObjectMessage & {
    adapterId: string
    requestId: string
    resourceId: string
    sessionId: string
    generation: number
    operation: string
    input?: ObjectMessage
  }
}

export interface DesktopBrowserAdapterRegisteredMessage extends ExtensibleMessage {
  type: 'desktop-browser-adapter-registered'
  adapterId: string
  serverEpoch: string
}

export type ServerMessage =
  | ProtocolServerHelloMessage
  | BusinessHealthResultMessage
  | TerminalCheckpointResultMessage
  | ErrorServerMessage<'protocol-error'>
  | ErrorServerMessage<'error'>
  | CommandAckMessage
  | StateMessage
  | StateDeltaMessage
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
  | DesktopBrowserAdapterRegisteredMessage
  | DesktopBrowserAdapterCommandMessage

export type ValidationResult<Message> =
  | { ok: true; value: Message }
  | { ok: false; error: string }

const SERVER_MESSAGE_TYPES: ReadonlySet<ServerMessage['type']> = new Set([
  'protocol-hello',
  'protocol-error',
  'business-health-result',
  'terminal-checkpoint-result',
  'command-ack',
  'state',
  'state-delta',
  'error',
  'composer-input-result',
  'agent-started',
  'session-output',
  'session-preview',
  'system-stats',
  'agent-activity',
  'agent-activity-snapshot',
  'agent-update',
  'acp-session-revision',
  'agent-read',
  'workspace-file-watch',
  'workspace-file-event',
  'workspace-result',
  'language-server-result',
  'language-server-refresh',
  'browser-resource-snapshot',
  'browser-resource-updated',
  'browser-resource-deleted',
  'computer-resource-snapshot',
  'computer-resource-updated',
  'computer-resource-deleted',
  'desktop-browser-adapter-registered',
  'desktop-browser-command',
])

function objectMessage(value: unknown): value is ObjectMessage {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringField(value: ObjectMessage, name: string, optional = false): boolean {
  return optional && value[name] === undefined ? true : typeof value[name] === 'string'
}

function finiteField(value: ObjectMessage, name: string): boolean {
  return typeof value[name] === 'number' && Number.isFinite(value[name])
}

function revisionField(value: ObjectMessage, name: string): boolean {
  return Number.isInteger(value[name]) && typeof value[name] === 'number' && value[name] >= 0
}

function resourceSnapshot(value: unknown): boolean {
  return objectMessage(value)
    && revisionField(value, 'collectionRevision')
    && Array.isArray(value.resources)
    && value.resources.every(resourceUpdate)
}

function resourceUpdate(value: unknown): boolean {
  return objectMessage(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && revisionField(value, 'revision')
    && revisionField(value, 'collectionRevision')
}

function resourceDeletion(value: unknown): boolean {
  return objectMessage(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && revisionField(value, 'collectionRevision')
}

function finiteNullableField(value: ObjectMessage, name: string): boolean {
  return value[name] === null || finiteField(value, name)
}

function optionalField(value: ObjectMessage, name: string, validate: () => boolean): boolean {
  return value[name] === undefined || validate()
}

function boundedStringField(value: ObjectMessage, name: string, maxLength: number, optional = false): boolean {
  if (optional && value[name] === undefined) return true
  return typeof value[name] === 'string' && String(value[name]).length <= maxLength
}

function optionalBooleanField(value: ObjectMessage, name: string): boolean {
  return value[name] === undefined || typeof value[name] === 'boolean'
}

function optionalNonNegativeIntegerField(value: ObjectMessage, name: string): boolean {
  return value[name] === undefined || revisionField(value, name)
}

function workspaceRequest(value: unknown): value is WorkspaceRequest {
  if (!objectMessage(value) || typeof value.operation !== 'string') return false
  const rootPath = () => boundedStringField(value, 'rootId', 4096)
    && boundedStringField(value, 'path', 4096)
  const expectedVersion = () => boundedStringField(value, 'expectedVersion', 256, true)
  switch (value.operation) {
    case 'tree':
      return boundedStringField(value, 'rootId', 4096) && boundedStringField(value, 'path', 4096, true)
    case 'tree-decorations':
      return boundedStringField(value, 'rootId', 4096)
        && boundedStringField(value, 'path', 4096, true)
        && Array.isArray(value.entryPaths)
        && value.entryPaths.length <= 4096
        && value.entryPaths.every(entryPath => typeof entryPath === 'string' && entryPath.length <= 4096)
    case 'read-file':
    case 'create-preview':
      return rootPath() && optionalBooleanField(value, 'exactExternal')
    case 'delete-preview':
      return boundedStringField(value, 'previewId', 256)
    case 'save-file':
      return rootPath()
        && boundedStringField(value, 'content', MAX_INLINE_WORKSPACE_MESSAGE_BYTES)
        && boundedStringField(value, 'baseSha1', 256)
        && optionalBooleanField(value, 'overwrite')
    case 'move-entry':
      return boundedStringField(value, 'rootId', 4096)
        && boundedStringField(value, 'sourcePath', 4096)
        && boundedStringField(value, 'targetDirectory', 4096)
        && expectedVersion()
    case 'create-entry':
      return boundedStringField(value, 'rootId', 4096)
        && boundedStringField(value, 'parentPath', 4096)
        && boundedStringField(value, 'name', 1024)
        && (value.entryType === 'file' || value.entryType === 'directory')
    case 'rename-entry':
      return rootPath() && boundedStringField(value, 'name', 1024) && expectedVersion()
    case 'delete-entry':
      return rootPath() && expectedVersion()
    case 'search':
      return boundedStringField(value, 'rootId', 4096)
        && boundedStringField(value, 'query', 4096)
        && boundedStringField(value, 'path', 4096, true)
        && optionalBooleanField(value, 'includeIgnored')
        && optionalNonNegativeIntegerField(value, 'limit')
        && (value.scope === undefined || value.scope === 'all' || value.scope === 'file-path' || value.scope === 'entries')
    case 'blame':
    case 'blame-capability':
    case 'diff':
      return rootPath()
    case 'changes':
      return boundedStringField(value, 'rootId', 4096) && optionalNonNegativeIntegerField(value, 'limit')
    case 'worktrees':
    case 'branches':
    case 'branch':
      return boundedStringField(value, 'rootId', 4096)
    case 'switch-branch':
      return boundedStringField(value, 'rootId', 4096)
        && boundedStringField(value, 'branch', 1024)
        && boundedStringField(value, 'expectedBranch', 1024)
        && boundedStringField(value, 'expectedHead', 64)
        && boundedStringField(value, 'operationId', 160)
    case 'history':
      return boundedStringField(value, 'rootId', 4096)
        && optionalNonNegativeIntegerField(value, 'limit')
        && optionalNonNegativeIntegerField(value, 'skip')
        && (value.scope === undefined || value.scope === 'current' || value.scope === 'all')
    case 'history-changes':
      return boundedStringField(value, 'rootId', 4096)
        && boundedStringField(value, 'commit', 128)
        && boundedStringField(value, 'parent', 128, true)
        && optionalNonNegativeIntegerField(value, 'limit')
    case 'line-changes':
      return rootPath()
        && revisionField(value, 'lineNumber')
        && Number(value.lineNumber) > 0
        && (value.mode === 'working' || value.mode === 'previous')
    default:
      return false
  }
}

const LANGUAGE_SERVER_METHODS = new Set([
  'hover', 'definition', 'references', 'implementation', 'documentHighlights',
  'semanticTokens', 'inlayHints', 'documentSymbols', 'workspaceSymbols',
  'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls', 'prepareTypeHierarchy',
  'supertypes', 'subtypes', 'diagnostics',
])

function languageServerRequest(value: unknown): value is LanguageServerRequestPayload {
  if (!objectMessage(value)) return false
  if (value.operation === 'capability') return optionalBooleanField(value, 'force')
  return value.operation === 'request'
    && boundedStringField(value, 'rootId', 4096)
    && typeof value.method === 'string'
    && LANGUAGE_SERVER_METHODS.has(value.method)
    && (value.priority === undefined || value.priority === 'interactive' || value.priority === 'background')
    && boundedStringField(value, 'filePath', 4096, true)
    && boundedStringField(value, 'query', 4096, true)
    && boundedStringField(value, 'itemId', 4096, true)
    && optionalField(value, 'position', () => objectMessage(value.position))
    && optionalField(value, 'range', () => objectMessage(value.range))
}

function serializedMessageWithinWorkspaceLimit(value: unknown): boolean {
  const serialized = JSON.stringify(value)
  const bytes = encodeURIComponent(serialized).replace(/%[0-9A-F]{2}/gi, 'x').length
  return bytes <= MAX_INLINE_WORKSPACE_MESSAGE_BYTES
}

function workspaceProtocolError(value: unknown): boolean {
  return objectMessage(value)
    && boundedStringField(value, 'code', 128)
    && boundedStringField(value, 'message', 4096)
    && optionalField(value, 'status', () => revisionField(value, 'status'))
    && optionalBooleanField(value, 'uncertain')
}

function stateSnapshotPage(value: ObjectMessage, agentCount: number): boolean {
  if (!objectMessage(value.snapshot)) return false
  const snapshot = value.snapshot
  const nextOffset = Number(snapshot.offset) + agentCount
  return stringField(snapshot, 'id')
    && revisionField(snapshot, 'offset')
    && revisionField(snapshot, 'total')
    && typeof snapshot.complete === 'boolean'
    && nextOffset <= Number(snapshot.total)
    && snapshot.complete === (nextOffset === Number(snapshot.total))
}

function projectAgentSummaries(value: ObjectMessage): boolean {
  const summaries = value.projectAgentSummaries
  if (!Array.isArray(summaries)) return false
  const workspaces = new Set<string>()
  for (const summary of summaries) {
    if (
      !objectMessage(summary)
      || !stringField(summary, 'workspace')
      || String(summary.workspace).length === 0
      || !revisionField(summary, 'agentCount')
      || !revisionField(summary, 'activeCount')
      || !optionalField(summary, 'followUpCount', () => revisionField(summary, 'followUpCount'))
      || !revisionField(summary, 'unreadCount')
      || !revisionField(summary, 'zombieCount')
      || !revisionField(summary, 'maxAttentionScore')
      || Number(summary.activeCount) > Number(summary.agentCount)
      || (summary.followUpCount !== undefined && Number(summary.followUpCount) > Number(summary.agentCount))
      || Number(summary.unreadCount) > Number(summary.agentCount)
      || Number(summary.zombieCount) > Number(summary.agentCount)
      || Number(summary.maxAttentionScore) > PROJECT_ATTENTION_SCORE_MAX
      || workspaces.has(String(summary.workspace))
    ) return false
    workspaces.add(String(summary.workspace))
  }
  return true
}

function agentInventoryMetadata(value: ObjectMessage): boolean {
  const fields = [
    'agentInventoryScope',
    'agentInventoryRunning',
    'agentInventoryTotal',
  ] as const
  const present = fields.filter(field => Object.prototype.hasOwnProperty.call(value, field))
  if (present.length === 0) return true
  return present.length === fields.length
    && (value.agentInventoryScope === 'all' || value.agentInventoryScope === 'focused')
    && revisionField(value, 'agentInventoryRunning')
    && revisionField(value, 'agentInventoryTotal')
    && Number(value.agentInventoryRunning) <= Number(value.agentInventoryTotal)
}

function stateMessage(value: ObjectMessage): boolean {
  const state = value.state
  const agents = objectMessage(state) ? state.agents : null
  const snapshot = objectMessage(value.snapshot) ? value.snapshot : null
  if (
    !stringField(value, 'generation')
    || !revisionField(value, 'sequence')
    || !objectMessage(state)
    || !Array.isArray(agents)
    || !agents.every(isAgentStateWire)
    || new Set(agents.map(agent => agent.id)).size !== agents.length
    || !agentInventoryMetadata(state)
    || !optionalField(state, 'projectAgentSummaries', () => projectAgentSummaries(state))
    || (Object.prototype.hasOwnProperty.call(state, 'agentInventoryScope') && Number(snapshot?.offset) !== 0)
    || (state.projectAgentSummaries !== undefined && Number(snapshot?.offset) !== 0)
  ) return false
  return optionalField(value, 'snapshot', () => stateSnapshotPage(value, agents.length))
}

function stateDeltaMessage(value: ObjectMessage): boolean {
  const upserts = value.upserts
  const removedAgentIds = value.removedAgentIds
  if (
    !Array.isArray(upserts)
    || !upserts.every(isAgentStateWire)
    || !Array.isArray(removedAgentIds)
    || !removedAgentIds.every(agentId => typeof agentId === 'string')
  ) return false
  const upsertIds = upserts.map(agent => agent.id)
  return new Set(upsertIds).size === upsertIds.length
    && new Set(removedAgentIds).size === removedAgentIds.length
    && !upsertIds.some(agentId => removedAgentIds.includes(agentId))
    && stringField(value, 'generation')
    && revisionField(value, 'sequence')
    && optionalField(value, 'state', () => (
      objectMessage(value.state)
      && !Object.prototype.hasOwnProperty.call(value.state, 'agents')
      && agentInventoryMetadata(value.state)
    ))
}

function agentReadState(value: unknown): boolean {
  return objectMessage(value)
    && stringField(value, 'agentId')
    && typeof value.unread === 'boolean'
    && revisionField(value, 'attentionSeq')
    && revisionField(value, 'readAttentionSeq')
    && optionalField(value, 'attentionUpdatedAt', () => finiteNullableField(value, 'attentionUpdatedAt'))
    && optionalField(value, 'readAttentionAt', () => finiteNullableField(value, 'readAttentionAt'))
    && stringField(value, 'attentionReason', true)
    && stringField(value, 'attentionSummary', true)
    && stringField(value, 'attentionOutputEpoch', true)
    && optionalField(value, 'attentionOutputSeq', () => finiteNullableField(value, 'attentionOutputSeq'))
    && stringField(value, 'readOutputEpoch')
    && finiteNullableField(value, 'readOutputSeq')
}

function codexTerminalProfileState(value: unknown): boolean {
  return value === null || (
    objectMessage(value)
    && stringField(value, 'model')
    && stringField(value, 'reasoningEffort')
    && stringField(value, 'serviceTier')
    && stringField(value, 'source')
  )
}

const AGENT_UPDATE_PATCH_VALIDATORS = {
  adaptiveTitle: (value: unknown) => typeof value === 'string',
  codexTerminalProfile: codexTerminalProfileState,
  sessionTitle: (value: unknown) => typeof value === 'string',
  runtimeBinding: (value: unknown) => (
    objectMessage(value)
    && (
      value.kind === 'terminal'
      || (
        value.kind === 'acp'
        && typeof value.state === 'string'
        && typeof value.error === 'string'
        && typeof value.stopReason === 'string'
        && typeof value.supportsSteer === 'boolean'
        && typeof value.supportsFork === 'boolean'
        && Array.isArray(value.pendingPermissions)
        && Array.isArray(value.pendingElicitations)
        && Array.isArray(value.activeElicitations)
        && typeof value.sessionUpdatedAt === 'string'
        && revisionField(value, 'sessionRevision')
      )
    )
  ),
  terminalInputReceived: (value: unknown) => typeof value === 'boolean',
  terminalBusy: (value: unknown) => value === null || typeof value === 'boolean',
  shellCwd: (value: unknown) => typeof value === 'string',
  shellLastExitCode: (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value),
  shellLastEvent: (value: unknown) => typeof value === 'string',
  shellCommand: (value: unknown) => typeof value === 'string',
  shellLastCommand: (value: unknown) => typeof value === 'string',
  shellCommandStartedAt: (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value),
  shellLastCommandStartedAt: (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value),
  shellLastCommandFinishedAt: (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value),
  shellLastCommandDurationMs: (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value),
  terminalStatus: (value: unknown) => value === null || objectMessage(value),
  runtimeObservation: objectMessage,
} satisfies Record<keyof AgentUpdatePatch, (value: unknown) => boolean>

export function sanitizeAgentUpdatePatch(value: unknown): AgentUpdatePatch | null {
  if (!objectMessage(value)) return null
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.some(([name, field]) => {
    const validator = AGENT_UPDATE_PATCH_VALIDATORS[name as keyof AgentUpdatePatch]
    return !validator || !validator(field)
  })) return null
  return Object.fromEntries(entries) as AgentUpdatePatch
}

export function validateClientMessage(value: unknown): ValidationResult<ClientMessage> {
  if (!objectMessage(value) || typeof value.type !== 'string') {
    return { ok: false, error: 'message must be an object with a type' }
  }
  const messageType = value.type as ClientMessage['type']
  let valid = true
  switch (messageType) {
    case 'protocol-hello':
      valid = Number.isInteger(value.protocolVersion)
        && (!Object.prototype.hasOwnProperty.call(value, 'initialStateScope')
          || value.initialStateScope === 'all'
          || (value.initialStateScope === 'focused'
            && stringField(value, 'initialFocusedAgentId')
            && String(value.initialFocusedAgentId).length > 0))
        && (!Object.prototype.hasOwnProperty.call(value, 'initialFocusedAgentId')
          || value.initialStateScope === 'focused')
      break
    case 'business-health-probe': valid = stringField(value, 'requestId'); break
    case 'terminal-checkpoint-request':
      valid = stringField(value, 'requestId') && stringField(value, 'agentId')
      break
    case 'start-agent': valid = stringField(value, 'command'); break
    case 'input': valid = stringField(value, 'agentId', true) && (typeof value.input === 'string' || Array.isArray(value.inputParts)); break
    case 'composer-input':
      valid = stringField(value, 'message')
        && stringField(value, 'agentId', true)
        && stringField(value, 'requestId', true)
        && (!Object.prototype.hasOwnProperty.call(value, 'delivery') || value.delivery === 'prompt' || value.delivery === 'steer')
      break
    case 'acp-permission-response':
      valid = stringField(value, 'agentId')
        && stringField(value, 'requestId')
        && stringField(value, 'optionId')
        && (!Object.prototype.hasOwnProperty.call(value, 'cancelled') || typeof value.cancelled === 'boolean')
      break
    case 'focus-agent':
      valid = (value.agentId === null || stringField(value, 'agentId'))
        && (!Object.prototype.hasOwnProperty.call(value, 'activityScope')
          || value.activityScope === 'all'
          || value.activityScope === 'focused'
          || value.activityScope === 'none')
        && (!Object.prototype.hasOwnProperty.call(value, 'previewScope')
          || value.previewScope === 'all'
          || value.previewScope === 'none'
          || (value.previewScope === 'focused'
            && typeof value.agentId === 'string'
            && value.agentId.length > 0))
        && (!Object.prototype.hasOwnProperty.call(value, 'stateScope')
          || value.stateScope === 'all'
          || (value.stateScope === 'focused'
            && typeof value.agentId === 'string'
            && value.agentId.length > 0))
      break
    case 'watch-acp-transcripts':
      valid = Array.isArray(value.agentIds)
        && value.agentIds.length <= 20
        && value.agentIds.every(agentId => typeof agentId === 'string' && agentId.length > 0 && agentId.length <= 256)
        && new Set(value.agentIds).size === value.agentIds.length
      break
    case 'resize-agent': valid = stringField(value, 'agentId') && finiteField(value, 'cols') && finiteField(value, 'rows'); break
    case 'unwatch-workspace-files': valid = stringField(value, 'rootId', true); break
    case 'restart-main-agent': valid = stringField(value, 'command'); break
    case 'state-resync':
      valid = stringField(value, 'generation', true)
        && optionalField(value, 'afterSequence', () => revisionField(value, 'afterSequence'))
      break
    case 'desktop-browser-adapter-register':
      valid = boundedStringField(value, 'adapterId', 160)
      break
    case 'desktop-browser-adapter-response':
      valid = boundedStringField(value, 'adapterId', 160)
        && boundedStringField(value, 'requestId', 160)
        && boundedStringField(value, 'resourceId', 256)
        && boundedStringField(value, 'sessionId', 256)
        && revisionField(value, 'generation')
        && typeof value.ok === 'boolean'
        && optionalField(value, 'error', () => boundedStringField(value, 'error', 2_000))
        && optionalField(value, 'code', () => boundedStringField(value, 'code', 128))
        && optionalField(value, 'status', () => revisionField(value, 'status'))
        && optionalBooleanField(value, 'uncertain')
      break
    case 'desktop-browser-adapter-event':
      valid = boundedStringField(value, 'adapterId', 160)
        && boundedStringField(value, 'resourceId', 256)
        && boundedStringField(value, 'sessionId', 256)
        && revisionField(value, 'generation')
        && boundedStringField(value, 'kind', 128)
        && optionalField(value, 'payload', () => objectMessage(value.payload))
      break
    case 'watch-workspace-files':
      valid = stringField(value, 'rootId')
        && Array.isArray(value.paths)
        && value.paths.length > 0
        && value.paths.length <= 256
        && value.paths.every(filePath => typeof filePath === 'string' && filePath.length > 0 && filePath.length <= 4096)
        && new Set(value.paths).size === value.paths.length
      break
    case 'workspace-request':
      valid = stringField(value, 'requestId')
        && workspaceRequest(value.request)
        && serializedMessageWithinWorkspaceLimit(value)
      break
    case 'workspace-cancel':
      valid = stringField(value, 'requestId')
      break
    case 'language-server-request':
      valid = stringField(value, 'requestId')
        && languageServerRequest(value.request)
        && serializedMessageWithinWorkspaceLimit(value)
      break
    case 'interrupt-agent':
    case 'clear-terminal':
    case 'archive-agent':
      valid = stringField(value, 'agentId')
      break
    default: {
      const unsupportedMessageType: never = messageType
      return { ok: false, error: `unsupported client message: ${unsupportedMessageType}` }
    }
  }
  return valid
    ? { ok: true, value: value as ClientMessage }
    : { ok: false, error: `invalid ${value.type} message` }
}

export function validateServerMessage(value: unknown): ValidationResult<ServerMessage> {
  if (!objectMessage(value) || typeof value.type !== 'string') {
    return { ok: false, error: 'message must be an object with a type' }
  }
  if (!SERVER_MESSAGE_TYPES.has(value.type as ServerMessage['type'])) {
    return { ok: false, error: `unsupported server message: ${value.type}` }
  }
  let valid = true
  switch (value.type) {
    case 'protocol-hello':
      valid = Number.isInteger(value.protocolVersion)
        && Number.isInteger(value.minProtocolVersion)
        && optionalNonNegativeIntegerField(value, 'maxInlineWorkspaceMessageBytes')
      break
    case 'business-health-result':
      valid = stringField(value, 'requestId')
        && stringField(value, 'serverEpoch')
        && Number.isInteger(value.protocolVersion)
        && (value.status === 'ready' || value.status === 'recovering' || value.status === 'failed' || value.status === 'stopping')
        && Number.isInteger(value.agentCount)
        && typeof value.agentCount === 'number'
        && value.agentCount >= 0
        && (value.mainAgentId === null || stringField(value, 'mainAgentId'))
      break
    case 'terminal-checkpoint-result':
      valid = stringField(value, 'requestId')
        && stringField(value, 'agentId')
        && typeof value.ok === 'boolean'
        && (
          value.ok === true
            ? objectMessage(value.session) && value.error === undefined
            : stringField(value, 'error') && value.session === undefined
        )
      break
    case 'protocol-error':
    case 'error': valid = stringField(value, 'message'); break
    case 'command-ack': valid = stringField(value, 'requestId') && stringField(value, 'command'); break
    case 'state': valid = stateMessage(value); break
    case 'state-delta': valid = stateDeltaMessage(value); break
    case 'composer-input-result': valid = stringField(value, 'requestId') && stringField(value, 'agentId') && typeof value.accepted === 'boolean' && stringField(value, 'message', true) && (!Object.prototype.hasOwnProperty.call(value, 'uncertain') || typeof value.uncertain === 'boolean'); break
    case 'agent-started': valid = stringField(value, 'agentId'); break
    case 'session-output': valid = objectMessage(value.stream) && stringField(value.stream, 'agentId'); break
    case 'session-preview': valid = objectMessage(value.preview) && stringField(value.preview, 'agentId'); break
    case 'system-stats': valid = objectMessage(value.stats); break
    case 'agent-activity': valid = objectMessage(value.activity) && stringField(value.activity, 'agentId'); break
    case 'agent-activity-snapshot': valid = Array.isArray(value.activities) && value.activities.every(activity => objectMessage(activity) && stringField(activity, 'agentId')); break
    case 'agent-update': valid = objectMessage(value.update) && stringField(value.update, 'agentId') && sanitizeAgentUpdatePatch(value.update.patch) !== null; break
    case 'acp-session-revision':
      valid = objectMessage(value.session)
        && stringField(value.session, 'agentId')
        && String(value.session.agentId).length > 0
        && stringField(value.session, 'sessionId')
        && String(value.session.sessionId).length > 0
        && stringField(value.session, 'runtimeEpoch')
        && String(value.session.runtimeEpoch).length > 0
        && Number.isInteger(value.session.revision)
        && typeof value.session.revision === 'number'
        && value.session.revision >= 0
        && stringField(value.session, 'updatedAt')
        && String(value.session.updatedAt).length > 0
      break
    case 'agent-read': valid = agentReadState(value.read); break
    case 'workspace-file-watch':
      valid = stringField(value, 'rootId')
        && Array.isArray(value.paths)
        && value.paths.every(filePath => typeof filePath === 'string')
        && typeof value.watching === 'boolean'
      break
    case 'workspace-file-event': valid = objectMessage(value.event) && stringField(value.event, 'rootId'); break
    case 'workspace-result':
      valid = stringField(value, 'requestId')
        && typeof value.ok === 'boolean'
        && (value.ok
          ? Object.prototype.hasOwnProperty.call(value, 'result') && value.error === undefined
          : workspaceProtocolError(value.error) && value.result === undefined)
        && serializedMessageWithinWorkspaceLimit(value)
      break
    case 'language-server-result':
      valid = stringField(value, 'requestId')
        && typeof value.ok === 'boolean'
        && optionalField(value, 'supported', () => typeof value.supported === 'boolean')
        && (value.ok
          ? Object.prototype.hasOwnProperty.call(value, 'result') && value.error === undefined
          : workspaceProtocolError(value.error) && value.result === undefined)
        && serializedMessageWithinWorkspaceLimit(value)
      break
    case 'language-server-refresh':
      valid = stringField(value, 'serverEpoch')
        && String(value.serverEpoch).length > 0
        && stringField(value, 'rootId')
        && String(value.rootId).length > 0
        && stringField(value, 'workspace')
        && String(value.workspace).length > 0
        && (value.kind === 'semanticTokens' || value.kind === 'inlayHints')
        && revisionField(value, 'revision')
        && Number(value.revision) > 0
      break
    case 'browser-resource-snapshot': valid = resourceSnapshot(value.snapshot); break
    case 'browser-resource-updated': valid = resourceUpdate(value.resource); break
    case 'browser-resource-deleted': valid = resourceDeletion(value.deletion); break
    case 'computer-resource-snapshot': valid = resourceSnapshot(value.snapshot); break
    case 'computer-resource-updated': valid = resourceUpdate(value.resource); break
    case 'computer-resource-deleted': valid = resourceDeletion(value.deletion); break
    case 'desktop-browser-adapter-registered':
      valid = boundedStringField(value, 'adapterId', 160)
        && boundedStringField(value, 'serverEpoch', 256)
      break
    case 'desktop-browser-command': {
      const command = objectMessage(value.command) ? value.command : null
      valid = command !== null
        && boundedStringField(command, 'adapterId', 160)
        && boundedStringField(command, 'requestId', 160)
        && boundedStringField(command, 'resourceId', 256)
        && boundedStringField(command, 'sessionId', 256)
        && revisionField(command, 'generation')
        && boundedStringField(command, 'operation', 128)
        && optionalField(command, 'input', () => objectMessage(command.input))
      break
    }
  }
  return valid
    ? { ok: true, value: value as ServerMessage }
    : { ok: false, error: `invalid ${value.type} message` }
}

export function protocolCompatible(version: unknown): version is number {
  return Number.isInteger(version)
    && typeof version === 'number'
    && version >= MIN_PROTOCOL_VERSION
    && version <= PROTOCOL_VERSION
}

export function claimProtocolUpgradeReload(
  pageProtocolVersion: number,
  backendProtocolVersion: number,
  storage: ProtocolReloadStorage,
  scope: string,
): boolean {
  if (!Number.isInteger(pageProtocolVersion)
    || !Number.isInteger(backendProtocolVersion)
    || backendProtocolVersion <= pageProtocolVersion) {
    return false
  }
  const key = `farming:protocol-upgrade-reload:${scope}:${backendProtocolVersion}`
  try {
    if (storage.getItem(key) === '1') return false
    storage.setItem(key, '1')
    return true
  } catch {
    return false
  }
}
