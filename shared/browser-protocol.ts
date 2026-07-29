export const PROTOCOL_VERSION = 3
export const MIN_PROTOCOL_VERSION = 3

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
}

export interface FocusAgentMessage extends ExtensibleMessage {
  type: 'focus-agent'
  agentId: string | null
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
  | 'kill-agent'

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
  | AgentScopedClientMessage<'kill-agent'>
  | UnwatchWorkspaceFilesMessage
  | RestartMainAgentMessage

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
  state: ObjectMessage & { agents: unknown[] }
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

export interface AgentUpdatePatch {
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
  read: ObjectMessage & { agentId: string }
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

export type ServerMessage =
  | ProtocolServerHelloMessage
  | BusinessHealthResultMessage
  | ErrorServerMessage<'protocol-error'>
  | ErrorServerMessage<'error'>
  | CommandAckMessage
  | StateMessage
  | ComposerInputResultMessage
  | AgentStartedMessage
  | SessionOutputMessage
  | SessionPreviewMessage
  | SystemStatsMessage
  | AgentActivityMessage
  | AgentUpdateMessage
  | AcpSessionRevisionMessage
  | AgentReadMessage
  | WorkspaceFileWatchMessage
  | WorkspaceFileEventMessage

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
  'kill-agent',
  'restart-main-agent',
])

const SERVER_MESSAGE_TYPES: ReadonlySet<ServerMessage['type']> = new Set([
  'protocol-hello',
  'protocol-error',
  'business-health-result',
  'command-ack',
  'state',
  'error',
  'composer-input-result',
  'agent-started',
  'session-output',
  'session-preview',
  'system-stats',
  'agent-activity',
  'agent-update',
  'acp-session-revision',
  'agent-read',
  'workspace-file-watch',
  'workspace-file-event',
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

const AGENT_UPDATE_PATCH_VALIDATORS = {
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
    case 'acp-permission-response': valid = stringField(value, 'agentId') && stringField(value, 'requestId'); break
    case 'focus-agent': valid = value.agentId === null || stringField(value, 'agentId'); break
    case 'resize-agent': valid = stringField(value, 'agentId') && finiteField(value, 'cols') && finiteField(value, 'rows'); break
    case 'unwatch-workspace-files': valid = stringField(value, 'agentId', true); break
    case 'restart-main-agent': valid = stringField(value, 'command'); break
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
    case 'state': valid = objectMessage(value.state) && Array.isArray(value.state.agents); break
    case 'composer-input-result': valid = stringField(value, 'requestId') && stringField(value, 'agentId') && typeof value.accepted === 'boolean' && stringField(value, 'message', true) && (!Object.prototype.hasOwnProperty.call(value, 'uncertain') || typeof value.uncertain === 'boolean'); break
    case 'agent-started': valid = stringField(value, 'agentId'); break
    case 'session-output': valid = objectMessage(value.stream) && stringField(value.stream, 'agentId'); break
    case 'session-preview': valid = objectMessage(value.preview) && stringField(value.preview, 'agentId'); break
    case 'system-stats': valid = objectMessage(value.stats); break
    case 'agent-activity': valid = objectMessage(value.activity) && stringField(value.activity, 'agentId'); break
    case 'agent-update': valid = objectMessage(value.update) && stringField(value.update, 'agentId') && sanitizeAgentUpdatePatch(value.update.patch) !== null; break
    case 'acp-session-revision': valid = objectMessage(value.session) && stringField(value.session, 'agentId') && Number.isInteger(value.session.revision) && typeof value.session.revision === 'number' && value.session.revision >= 0 && stringField(value.session, 'updatedAt'); break
    case 'agent-read': valid = objectMessage(value.read) && stringField(value.read, 'agentId'); break
    case 'workspace-file-watch': valid = stringField(value, 'agentId') && typeof value.watching === 'boolean'; break
    case 'workspace-file-event': valid = objectMessage(value.event) && stringField(value.event, 'agentId'); break
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
