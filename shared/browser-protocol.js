// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_PROTOCOL_VERSION = exports.PROTOCOL_VERSION = void 0;
exports.sanitizeAgentUpdatePatch = sanitizeAgentUpdatePatch;
exports.validateClientMessage = validateClientMessage;
exports.validateServerMessage = validateServerMessage;
exports.protocolCompatible = protocolCompatible;
exports.PROTOCOL_VERSION = 4;
exports.MIN_PROTOCOL_VERSION = 4;
const CLIENT_MESSAGE_TYPES = new Set([
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
]);
const SERVER_MESSAGE_TYPES = new Set([
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
    'browser-resource-snapshot',
    'browser-resource-updated',
    'browser-resource-deleted',
    'computer-resource-snapshot',
    'computer-resource-updated',
    'computer-resource-deleted',
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
function revisionField(value, name) {
    return Number.isInteger(value[name]) && typeof value[name] === 'number' && value[name] >= 0;
}
function resourceSnapshot(value) {
    return objectMessage(value)
        && revisionField(value, 'collectionRevision')
        && Array.isArray(value.resources)
        && value.resources.every(resourceUpdate);
}
function resourceUpdate(value) {
    return objectMessage(value)
        && typeof value.id === 'string'
        && value.id.length > 0
        && revisionField(value, 'revision')
        && revisionField(value, 'collectionRevision');
}
function resourceDeletion(value) {
    return objectMessage(value)
        && typeof value.id === 'string'
        && value.id.length > 0
        && revisionField(value, 'collectionRevision');
}
const AGENT_UPDATE_PATCH_VALIDATORS = {
    terminalInputReceived: (value) => typeof value === 'boolean',
    terminalBusy: (value) => value === null || typeof value === 'boolean',
    shellCwd: (value) => typeof value === 'string',
    shellLastExitCode: (value) => value === null || typeof value === 'number' && Number.isFinite(value),
    shellLastEvent: (value) => typeof value === 'string',
    shellCommand: (value) => typeof value === 'string',
    shellLastCommand: (value) => typeof value === 'string',
    shellCommandStartedAt: (value) => value === null || typeof value === 'number' && Number.isFinite(value),
    shellLastCommandStartedAt: (value) => value === null || typeof value === 'number' && Number.isFinite(value),
    shellLastCommandFinishedAt: (value) => value === null || typeof value === 'number' && Number.isFinite(value),
    shellLastCommandDurationMs: (value) => value === null || typeof value === 'number' && Number.isFinite(value),
    terminalStatus: (value) => value === null || objectMessage(value),
    runtimeObservation: objectMessage,
};
function sanitizeAgentUpdatePatch(value) {
    if (!objectMessage(value))
        return null;
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.some(([name, field]) => {
        const validator = AGENT_UPDATE_PATCH_VALIDATORS[name];
        return !validator || !validator(field);
    }))
        return null;
    return Object.fromEntries(entries);
}
function validateClientMessage(value) {
    if (!objectMessage(value) || typeof value.type !== 'string') {
        return { ok: false, error: 'message must be an object with a type' };
    }
    if (!CLIENT_MESSAGE_TYPES.has(value.type)) {
        return { ok: false, error: `unsupported client message: ${value.type}` };
    }
    let valid = true;
    switch (value.type) {
        case 'protocol-hello':
            valid = Number.isInteger(value.protocolVersion);
            break;
        case 'business-health-probe':
            valid = stringField(value, 'requestId');
            break;
        case 'start-agent':
            valid = stringField(value, 'command');
            break;
        case 'input':
            valid = stringField(value, 'agentId', true) && (typeof value.input === 'string' || Array.isArray(value.inputParts));
            break;
        case 'composer-input':
            valid = stringField(value, 'message')
                && stringField(value, 'agentId', true)
                && stringField(value, 'requestId', true)
                && (!Object.prototype.hasOwnProperty.call(value, 'delivery') || value.delivery === 'prompt' || value.delivery === 'steer');
            break;
        case 'acp-permission-response':
            valid = stringField(value, 'agentId')
                && stringField(value, 'requestId')
                && stringField(value, 'optionId')
                && (!Object.prototype.hasOwnProperty.call(value, 'cancelled') || typeof value.cancelled === 'boolean');
            break;
        case 'focus-agent':
            valid = value.agentId === null || stringField(value, 'agentId');
            break;
        case 'resize-agent':
            valid = stringField(value, 'agentId') && finiteField(value, 'cols') && finiteField(value, 'rows');
            break;
        case 'unwatch-workspace-files':
            valid = stringField(value, 'agentId', true);
            break;
        case 'restart-main-agent':
            valid = stringField(value, 'command');
            break;
        default:
            valid = stringField(value, 'agentId');
            break;
    }
    return valid
        ? { ok: true, value: value }
        : { ok: false, error: `invalid ${value.type} message` };
}
function validateServerMessage(value) {
    if (!objectMessage(value) || typeof value.type !== 'string') {
        return { ok: false, error: 'message must be an object with a type' };
    }
    if (!SERVER_MESSAGE_TYPES.has(value.type)) {
        return { ok: false, error: `unsupported server message: ${value.type}` };
    }
    let valid = true;
    switch (value.type) {
        case 'protocol-hello':
            valid = Number.isInteger(value.protocolVersion) && Number.isInteger(value.minProtocolVersion);
            break;
        case 'business-health-result':
            valid = stringField(value, 'requestId')
                && stringField(value, 'serverEpoch')
                && Number.isInteger(value.protocolVersion)
                && (value.status === 'ready' || value.status === 'recovering' || value.status === 'failed' || value.status === 'stopping')
                && Number.isInteger(value.agentCount)
                && typeof value.agentCount === 'number'
                && value.agentCount >= 0
                && (value.mainAgentId === null || stringField(value, 'mainAgentId'));
            break;
        case 'protocol-error':
        case 'error':
            valid = stringField(value, 'message');
            break;
        case 'command-ack':
            valid = stringField(value, 'requestId') && stringField(value, 'command');
            break;
        case 'state':
            valid = objectMessage(value.state) && Array.isArray(value.state.agents);
            break;
        case 'composer-input-result':
            valid = stringField(value, 'requestId') && stringField(value, 'agentId') && typeof value.accepted === 'boolean' && stringField(value, 'message', true) && (!Object.prototype.hasOwnProperty.call(value, 'uncertain') || typeof value.uncertain === 'boolean');
            break;
        case 'agent-started':
            valid = stringField(value, 'agentId');
            break;
        case 'session-output':
            valid = objectMessage(value.stream) && stringField(value.stream, 'agentId');
            break;
        case 'session-preview':
            valid = objectMessage(value.preview) && stringField(value.preview, 'agentId');
            break;
        case 'system-stats':
            valid = objectMessage(value.stats);
            break;
        case 'agent-activity':
            valid = objectMessage(value.activity) && stringField(value.activity, 'agentId');
            break;
        case 'agent-update':
            valid = objectMessage(value.update) && stringField(value.update, 'agentId') && sanitizeAgentUpdatePatch(value.update.patch) !== null;
            break;
        case 'acp-session-revision':
            valid = objectMessage(value.session) && stringField(value.session, 'agentId') && Number.isInteger(value.session.revision) && typeof value.session.revision === 'number' && value.session.revision >= 0 && stringField(value.session, 'updatedAt');
            break;
        case 'agent-read':
            valid = objectMessage(value.read) && stringField(value.read, 'agentId');
            break;
        case 'workspace-file-watch':
            valid = stringField(value, 'agentId') && typeof value.watching === 'boolean';
            break;
        case 'workspace-file-event':
            valid = objectMessage(value.event) && stringField(value.event, 'agentId');
            break;
        case 'browser-resource-snapshot':
            valid = resourceSnapshot(value.snapshot);
            break;
        case 'browser-resource-updated':
            valid = resourceUpdate(value.resource);
            break;
        case 'browser-resource-deleted':
            valid = resourceDeletion(value.deletion);
            break;
        case 'computer-resource-snapshot':
            valid = resourceSnapshot(value.snapshot);
            break;
        case 'computer-resource-updated':
            valid = resourceUpdate(value.resource);
            break;
        case 'computer-resource-deleted':
            valid = resourceDeletion(value.deletion);
            break;
    }
    return valid
        ? { ok: true, value: value }
        : { ok: false, error: `invalid ${value.type} message` };
}
function protocolCompatible(version) {
    return Number.isInteger(version)
        && typeof version === 'number'
        && version >= exports.MIN_PROTOCOL_VERSION
        && version <= exports.PROTOCOL_VERSION;
}
