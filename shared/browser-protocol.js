const PROTOCOL_VERSION = 2;
const MIN_PROTOCOL_VERSION = 2;

const CLIENT_MESSAGE_TYPES = new Set([
  'protocol-hello',
  'start-agent',
  'input',
  'composer-input',
  'app-server-request-response',
  'acp-permission-response',
  'interrupt-agent',
  'focus-agent',
  'resize-agent',
  'clear-terminal',
  'watch-workspace-files',
  'unwatch-workspace-files',
  'kill-agent',
  'restart-main-agent',
]);

const SERVER_MESSAGE_TYPES = new Set([
  'protocol-hello',
  'protocol-error',
  'command-ack',
  'state',
  'error',
  'agent-started',
  'session-output',
  'session-preview',
  'system-stats',
  'agent-activity',
  'agent-update',
  'agent-read',
  'workspace-file-watch',
  'workspace-file-event',
]);

function objectMessage(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringField(value, name, optional = false) {
  return optional && value[name] === undefined ? true : typeof value[name] === 'string';
}

function finiteField(value, name) {
  return typeof value[name] === 'number' && Number.isFinite(value[name]);
}

const AGENT_UPDATE_PATCH_VALIDATORS = {
  terminalInputReceived: value => typeof value === 'boolean',
  terminalBusy: value => value === null || typeof value === 'boolean',
  shellCwd: value => typeof value === 'string',
  shellLastExitCode: value => value === null || Number.isFinite(value),
  shellLastEvent: value => typeof value === 'string',
  shellCommand: value => typeof value === 'string',
  shellLastCommand: value => typeof value === 'string',
  shellCommandStartedAt: value => value === null || Number.isFinite(value),
  shellLastCommandStartedAt: value => value === null || Number.isFinite(value),
  shellLastCommandFinishedAt: value => value === null || Number.isFinite(value),
  shellLastCommandDurationMs: value => value === null || Number.isFinite(value),
  terminalStatus: value => value === null || objectMessage(value),
  runtimeObservation: objectMessage,
};

function sanitizeAgentUpdatePatch(value) {
  if (!objectMessage(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([name, field]) => (
    !AGENT_UPDATE_PATCH_VALIDATORS[name] || !AGENT_UPDATE_PATCH_VALIDATORS[name](field)
  ))) return null;
  return Object.fromEntries(entries);
}

function validateClientMessage(value) {
  if (!objectMessage(value) || typeof value.type !== 'string') return { ok: false, error: 'message must be an object with a type' };
  if (!CLIENT_MESSAGE_TYPES.has(value.type)) return { ok: false, error: `unsupported client message: ${value.type}` };
  let valid = true;
  switch (value.type) {
    case 'protocol-hello': valid = Number.isInteger(value.protocolVersion); break;
    case 'start-agent': valid = stringField(value, 'command'); break;
    case 'input': valid = stringField(value, 'agentId', true) && (typeof value.input === 'string' || Array.isArray(value.inputParts)); break;
    case 'composer-input': valid = stringField(value, 'message') && stringField(value, 'agentId', true); break;
    case 'app-server-request-response':
    case 'acp-permission-response': valid = stringField(value, 'agentId') && stringField(value, 'requestId'); break;
    case 'focus-agent': valid = value.agentId === null || stringField(value, 'agentId'); break;
    case 'resize-agent': valid = stringField(value, 'agentId') && finiteField(value, 'cols') && finiteField(value, 'rows'); break;
    case 'unwatch-workspace-files': valid = stringField(value, 'agentId', true); break;
    case 'restart-main-agent': valid = stringField(value, 'command'); break;
    default: valid = stringField(value, 'agentId'); break;
  }
  return valid ? { ok: true, value } : { ok: false, error: `invalid ${value.type} message` };
}

function validateServerMessage(value) {
  if (!objectMessage(value) || typeof value.type !== 'string') return { ok: false, error: 'message must be an object with a type' };
  if (!SERVER_MESSAGE_TYPES.has(value.type)) return { ok: false, error: `unsupported server message: ${value.type}` };
  let valid = true;
  switch (value.type) {
    case 'protocol-hello': valid = Number.isInteger(value.protocolVersion) && Number.isInteger(value.minProtocolVersion); break;
    case 'protocol-error':
    case 'error': valid = stringField(value, 'message'); break;
    case 'command-ack': valid = stringField(value, 'requestId') && stringField(value, 'command'); break;
    case 'state': valid = objectMessage(value.state) && Array.isArray(value.state.agents); break;
    case 'agent-started': valid = stringField(value, 'agentId'); break;
    case 'session-output': valid = objectMessage(value.stream) && stringField(value.stream, 'agentId'); break;
    case 'session-preview': valid = objectMessage(value.preview) && stringField(value.preview, 'agentId'); break;
    case 'system-stats': valid = objectMessage(value.stats); break;
    case 'agent-activity': valid = objectMessage(value.activity) && stringField(value.activity, 'agentId'); break;
    case 'agent-update': valid = objectMessage(value.update) && stringField(value.update, 'agentId') && Boolean(sanitizeAgentUpdatePatch(value.update.patch)); break;
    case 'agent-read': valid = objectMessage(value.read) && stringField(value.read, 'agentId'); break;
    case 'workspace-file-watch': valid = stringField(value, 'agentId') && typeof value.watching === 'boolean'; break;
    case 'workspace-file-event': valid = objectMessage(value.event) && stringField(value.event, 'agentId'); break;
    default: break;
  }
  return valid ? { ok: true, value } : { ok: false, error: `invalid ${value.type} message` };
}

function protocolCompatible(version) {
  return Number.isInteger(version) && version >= MIN_PROTOCOL_VERSION && version <= PROTOCOL_VERSION;
}

module.exports = {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  protocolCompatible,
  sanitizeAgentUpdatePatch,
  validateClientMessage,
  validateServerMessage,
};
