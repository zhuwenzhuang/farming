import { PROJECT_ATTENTION_SCORE_MAX as projectAttentionScoreMax } from './agent-state-semantics.js'

export const PROTOCOL_VERSION = 8
export const MIN_PROTOCOL_VERSION = 8
export const PROJECT_ATTENTION_SCORE_MAX = projectAttentionScoreMax

type ObjectMessage = Record<string, unknown>

interface ExtensibleMessage extends ObjectMessage {
  type: string
}

export interface ProtocolClientHelloMessage extends ExtensibleMessage {
  type: 'protocol-hello'
  protocolVersion: number
}

export interface BusinessHealthProbeMessage extends ExtensibleMessage {
  type: 'business-health-probe'
  requestId: string
}

export interface StartAgentMessage extends ExtensibleMessage {
  type: 'start-agent'
  command: string
}

export interface InputMessage extends ExtensibleMessage {
  type: 'input'
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
  stateScope?: 'all' | 'focused'
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
  | 'watch-workspace-files'
  | 'archive-agent'

export interface AgentScopedClientMessage<Type extends AgentScopedClientMessageType> extends ExtensibleMessage {
  type: Type
  agentId: string
}

export interface UnwatchWorkspaceFilesMessage extends ExtensibleMessage {
  type: 'unwatch-workspace-files'
  agentId?: string
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

export type ClientMessage =
  | ProtocolClientHelloMessage
  | BusinessHealthProbeMessage
  | StartAgentMessage
  | InputMessage
  | ComposerInputMessage
  | AcpPermissionResponseMessage
  | FocusAgentMessage
  | ResizeAgentMessage
  | AgentScopedClientMessage<'interrupt-agent'>
  | AgentScopedClientMessage<'clear-terminal'>
  | AgentScopedClientMessage<'watch-workspace-files'>
  | AgentScopedClientMessage<'archive-agent'>
  | UnwatchWorkspaceFilesMessage
  | RestartMainAgentMessage
  | StateResyncMessage

export interface ProtocolServerHelloMessage extends ExtensibleMessage {
  type: 'protocol-hello'
  protocolVersion: number
  minProtocolVersion: number
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

export interface ErrorServerMessage<Type extends 'protocol-error' | 'error'> extends ExtensibleMessage {
  type: Type
  message: string
}

export interface CommandAckMessage extends ExtensibleMessage {
  type: 'command-ack'
  requestId: string
  command: string
}

export interface StateMessage extends ExtensibleMessage {
  type: 'state'
  generation: string
  sequence: number
  snapshot?: {
    complete: boolean
    id: string
    offset: number
    total: number
  }
  state: ObjectMessage & { agents: unknown[] }
}

export interface StateDeltaMessage extends ExtensibleMessage {
  type: 'state-delta'
  generation: string
  sequence: number
  upserts: Array<ObjectMessage & { id: string }>
  removedAgentIds: string[]
  state?: ObjectMessage
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
  agentId: string
  watching: boolean
}

export interface WorkspaceFileEventMessage extends ExtensibleMessage {
  type: 'workspace-file-event'
  event: ObjectMessage & { agentId: string }
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

export type ServerMessage =
  | ProtocolServerHelloMessage
  | BusinessHealthResultMessage
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
  | BrowserResourceSnapshotMessage
  | BrowserResourceUpdateMessage
  | BrowserResourceDeletedMessage
  | ComputerResourceSnapshotMessage
  | ComputerResourceUpdateMessage
  | ComputerResourceDeletedMessage

export type ValidationResult<Message> =
  | { ok: true; value: Message }
  | { ok: false; error: string }

const CLIENT_MESSAGE_TYPES: ReadonlySet<ClientMessage['type']> = new Set([
  'protocol-hello',
  'business-health-probe',
  'start-agent',
  'input',
  'composer-input',
  'acp-permission-response',
  'interrupt-agent',
  'focus-agent',
  'resize-agent',
  'clear-terminal',
  'watch-workspace-files',
  'unwatch-workspace-files',
  'archive-agent',
  'restart-main-agent',
  'state-resync',
])

const SERVER_MESSAGE_TYPES: ReadonlySet<ServerMessage['type']> = new Set([
  'protocol-hello',
  'protocol-error',
  'business-health-result',
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
  'browser-resource-snapshot',
  'browser-resource-updated',
  'browser-resource-deleted',
  'computer-resource-snapshot',
  'computer-resource-updated',
  'computer-resource-deleted',
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
      || !revisionField(summary, 'unreadCount')
      || !revisionField(summary, 'zombieCount')
      || !revisionField(summary, 'maxAttentionScore')
      || Number(summary.activeCount) > Number(summary.agentCount)
      || Number(summary.unreadCount) > Number(summary.agentCount)
      || Number(summary.zombieCount) > Number(summary.agentCount)
      || Number(summary.maxAttentionScore) > PROJECT_ATTENTION_SCORE_MAX
      || workspaces.has(String(summary.workspace))
    ) return false
    workspaces.add(String(summary.workspace))
  }
  return true
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
    || !agents.every(agent => objectMessage(agent) && stringField(agent, 'id'))
    || new Set(agents.map(agent => agent.id)).size !== agents.length
    || !optionalField(state, 'projectAgentSummaries', () => projectAgentSummaries(state))
    || (state.projectAgentSummaries !== undefined && Number(snapshot?.offset) !== 0)
  ) return false
  return optionalField(value, 'snapshot', () => stateSnapshotPage(value, agents.length))
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

const AGENT_UPDATE_PATCH_VALIDATORS = {
  adaptiveTitle: (value: unknown) => typeof value === 'string',
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
  if (!CLIENT_MESSAGE_TYPES.has(value.type as ClientMessage['type'])) {
    return { ok: false, error: `unsupported client message: ${value.type}` }
  }
  let valid = true
  switch (value.type) {
    case 'protocol-hello': valid = Number.isInteger(value.protocolVersion); break
    case 'business-health-probe': valid = stringField(value, 'requestId'); break
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
        && (!Object.prototype.hasOwnProperty.call(value, 'stateScope')
          || value.stateScope === 'all'
          || (value.stateScope === 'focused'
            && typeof value.agentId === 'string'
            && value.agentId.length > 0))
      break
    case 'resize-agent': valid = stringField(value, 'agentId') && finiteField(value, 'cols') && finiteField(value, 'rows'); break
    case 'unwatch-workspace-files': valid = stringField(value, 'agentId', true); break
    case 'restart-main-agent': valid = stringField(value, 'command'); break
    case 'state-resync':
      valid = stringField(value, 'generation', true)
        && optionalField(value, 'afterSequence', () => revisionField(value, 'afterSequence'))
      break
    default: valid = stringField(value, 'agentId'); break
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
    case 'protocol-hello': valid = Number.isInteger(value.protocolVersion) && Number.isInteger(value.minProtocolVersion); break
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
    case 'protocol-error':
    case 'error': valid = stringField(value, 'message'); break
    case 'command-ack': valid = stringField(value, 'requestId') && stringField(value, 'command'); break
    case 'state': valid = stateMessage(value); break
    case 'state-delta':
      valid = stringField(value, 'generation')
        && revisionField(value, 'sequence')
        && Array.isArray(value.upserts)
        && value.upserts.every(agent => objectMessage(agent) && stringField(agent, 'id'))
        && Array.isArray(value.removedAgentIds)
        && value.removedAgentIds.every(agentId => typeof agentId === 'string')
        && optionalField(value, 'state', () => (
          objectMessage(value.state)
          && !Object.prototype.hasOwnProperty.call(value.state, 'agents')
        ))
      break
    case 'composer-input-result': valid = stringField(value, 'requestId') && stringField(value, 'agentId') && typeof value.accepted === 'boolean' && stringField(value, 'message', true) && (!Object.prototype.hasOwnProperty.call(value, 'uncertain') || typeof value.uncertain === 'boolean'); break
    case 'agent-started': valid = stringField(value, 'agentId'); break
    case 'session-output': valid = objectMessage(value.stream) && stringField(value.stream, 'agentId'); break
    case 'session-preview': valid = objectMessage(value.preview) && stringField(value.preview, 'agentId'); break
    case 'system-stats': valid = objectMessage(value.stats); break
    case 'agent-activity': valid = objectMessage(value.activity) && stringField(value.activity, 'agentId'); break
    case 'agent-activity-snapshot': valid = Array.isArray(value.activities) && value.activities.every(activity => objectMessage(activity) && stringField(activity, 'agentId')); break
    case 'agent-update': valid = objectMessage(value.update) && stringField(value.update, 'agentId') && sanitizeAgentUpdatePatch(value.update.patch) !== null; break
    case 'acp-session-revision': valid = objectMessage(value.session) && stringField(value.session, 'agentId') && Number.isInteger(value.session.revision) && typeof value.session.revision === 'number' && value.session.revision >= 0 && stringField(value.session, 'updatedAt'); break
    case 'agent-read': valid = agentReadState(value.read); break
    case 'workspace-file-watch': valid = stringField(value, 'agentId') && typeof value.watching === 'boolean'; break
    case 'workspace-file-event': valid = objectMessage(value.event) && stringField(value.event, 'agentId'); break
    case 'browser-resource-snapshot': valid = resourceSnapshot(value.snapshot); break
    case 'browser-resource-updated': valid = resourceUpdate(value.resource); break
    case 'browser-resource-deleted': valid = resourceDeletion(value.deletion); break
    case 'computer-resource-snapshot': valid = resourceSnapshot(value.snapshot); break
    case 'computer-resource-updated': valid = resourceUpdate(value.resource); break
    case 'computer-resource-deleted': valid = resourceDeletion(value.deletion); break
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
