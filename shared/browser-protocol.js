// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECT_ATTENTION_SCORE_MAX = exports.MIN_PROTOCOL_VERSION = exports.PROTOCOL_VERSION = void 0;
exports.sanitizeAgentUpdatePatch = sanitizeAgentUpdatePatch;
exports.validateClientMessage = validateClientMessage;
exports.validateServerMessage = validateServerMessage;
exports.protocolCompatible = protocolCompatible;
const agent_state_semantics_js_1 = require("./agent-state-semantics.js");
exports.PROTOCOL_VERSION = 10;
exports.MIN_PROTOCOL_VERSION = 10;
exports.PROJECT_ATTENTION_SCORE_MAX = agent_state_semantics_js_1.PROJECT_ATTENTION_SCORE_MAX;
const CLIENT_MESSAGE_TYPES = new Set([
    'protocol-hello',
    'business-health-probe',
    'terminal-checkpoint-request',
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
]);
const SERVER_MESSAGE_TYPES = new Set([
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
    'language-server-refresh',
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
function finiteNullableField(value, name) {
    return value[name] === null || finiteField(value, name);
}
function optionalField(value, name, validate) {
    return value[name] === undefined || validate();
}
function stateSnapshotPage(value, agentCount) {
    if (!objectMessage(value.snapshot))
        return false;
    const snapshot = value.snapshot;
    const nextOffset = Number(snapshot.offset) + agentCount;
    return stringField(snapshot, 'id')
        && revisionField(snapshot, 'offset')
        && revisionField(snapshot, 'total')
        && typeof snapshot.complete === 'boolean'
        && nextOffset <= Number(snapshot.total)
        && snapshot.complete === (nextOffset === Number(snapshot.total));
}
function projectAgentSummaries(value) {
    const summaries = value.projectAgentSummaries;
    if (!Array.isArray(summaries))
        return false;
    const workspaces = new Set();
    for (const summary of summaries) {
        if (!objectMessage(summary)
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
            || Number(summary.maxAttentionScore) > exports.PROJECT_ATTENTION_SCORE_MAX
            || workspaces.has(String(summary.workspace)))
            return false;
        workspaces.add(String(summary.workspace));
    }
    return true;
}
function agentInventoryMetadata(value) {
    const fields = [
        'agentInventoryScope',
        'agentInventoryRunning',
        'agentInventoryTotal',
    ];
    const present = fields.filter(field => Object.prototype.hasOwnProperty.call(value, field));
    if (present.length === 0)
        return true;
    return present.length === fields.length
        && (value.agentInventoryScope === 'all' || value.agentInventoryScope === 'focused')
        && revisionField(value, 'agentInventoryRunning')
        && revisionField(value, 'agentInventoryTotal')
        && Number(value.agentInventoryRunning) <= Number(value.agentInventoryTotal);
}
function stateMessage(value) {
    const state = value.state;
    const agents = objectMessage(state) ? state.agents : null;
    const snapshot = objectMessage(value.snapshot) ? value.snapshot : null;
    if (!stringField(value, 'generation')
        || !revisionField(value, 'sequence')
        || !objectMessage(state)
        || !Array.isArray(agents)
        || !agents.every(agent => objectMessage(agent) && stringField(agent, 'id'))
        || new Set(agents.map(agent => agent.id)).size !== agents.length
        || !agentInventoryMetadata(state)
        || !optionalField(state, 'projectAgentSummaries', () => projectAgentSummaries(state))
        || (Object.prototype.hasOwnProperty.call(state, 'agentInventoryScope') && Number(snapshot?.offset) !== 0)
        || (state.projectAgentSummaries !== undefined && Number(snapshot?.offset) !== 0))
        return false;
    return optionalField(value, 'snapshot', () => stateSnapshotPage(value, agents.length));
}
function agentReadState(value) {
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
        && finiteNullableField(value, 'readOutputSeq');
}
function codexTerminalProfileState(value) {
    return value === null || (objectMessage(value)
        && stringField(value, 'model')
        && stringField(value, 'reasoningEffort')
        && stringField(value, 'serviceTier')
        && stringField(value, 'source'));
}
const AGENT_UPDATE_PATCH_VALIDATORS = {
    adaptiveTitle: (value) => typeof value === 'string',
    codexTerminalProfile: codexTerminalProfileState,
    sessionTitle: (value) => typeof value === 'string',
    runtimeBinding: (value) => (objectMessage(value)
        && (value.kind === 'terminal'
            || (value.kind === 'acp'
                && typeof value.state === 'string'
                && typeof value.error === 'string'
                && typeof value.stopReason === 'string'
                && typeof value.supportsSteer === 'boolean'
                && typeof value.supportsFork === 'boolean'
                && Array.isArray(value.pendingPermissions)
                && Array.isArray(value.pendingElicitations)
                && Array.isArray(value.activeElicitations)
                && typeof value.sessionUpdatedAt === 'string'
                && revisionField(value, 'sessionRevision')))),
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
            valid = Number.isInteger(value.protocolVersion)
                && (!Object.prototype.hasOwnProperty.call(value, 'initialStateScope')
                    || value.initialStateScope === 'all'
                    || (value.initialStateScope === 'focused'
                        && stringField(value, 'initialFocusedAgentId')
                        && String(value.initialFocusedAgentId).length > 0))
                && (!Object.prototype.hasOwnProperty.call(value, 'initialFocusedAgentId')
                    || value.initialStateScope === 'focused');
            break;
        case 'business-health-probe':
            valid = stringField(value, 'requestId');
            break;
        case 'terminal-checkpoint-request':
            valid = stringField(value, 'requestId') && stringField(value, 'agentId');
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
                        && value.agentId.length > 0));
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
        case 'state-resync':
            valid = stringField(value, 'generation', true)
                && optionalField(value, 'afterSequence', () => revisionField(value, 'afterSequence'));
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
        case 'terminal-checkpoint-result':
            valid = stringField(value, 'requestId')
                && stringField(value, 'agentId')
                && typeof value.ok === 'boolean'
                && (value.ok === true
                    ? objectMessage(value.session) && value.error === undefined
                    : stringField(value, 'error') && value.session === undefined);
            break;
        case 'protocol-error':
        case 'error':
            valid = stringField(value, 'message');
            break;
        case 'command-ack':
            valid = stringField(value, 'requestId') && stringField(value, 'command');
            break;
        case 'state':
            valid = stateMessage(value);
            break;
        case 'state-delta':
            valid = stringField(value, 'generation')
                && revisionField(value, 'sequence')
                && Array.isArray(value.upserts)
                && value.upserts.every(agent => objectMessage(agent) && stringField(agent, 'id'))
                && Array.isArray(value.removedAgentIds)
                && value.removedAgentIds.every(agentId => typeof agentId === 'string')
                && optionalField(value, 'state', () => (objectMessage(value.state)
                    && !Object.prototype.hasOwnProperty.call(value.state, 'agents')
                    && agentInventoryMetadata(value.state)));
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
        case 'agent-activity-snapshot':
            valid = Array.isArray(value.activities) && value.activities.every(activity => objectMessage(activity) && stringField(activity, 'agentId'));
            break;
        case 'agent-update':
            valid = objectMessage(value.update) && stringField(value.update, 'agentId') && sanitizeAgentUpdatePatch(value.update.patch) !== null;
            break;
        case 'acp-session-revision':
            valid = objectMessage(value.session) && stringField(value.session, 'agentId') && Number.isInteger(value.session.revision) && typeof value.session.revision === 'number' && value.session.revision >= 0 && stringField(value.session, 'updatedAt');
            break;
        case 'agent-read':
            valid = agentReadState(value.read);
            break;
        case 'workspace-file-watch':
            valid = stringField(value, 'agentId') && typeof value.watching === 'boolean';
            break;
        case 'workspace-file-event':
            valid = objectMessage(value.event) && stringField(value.event, 'agentId');
            break;
        case 'language-server-refresh':
            valid = stringField(value, 'serverEpoch')
                && String(value.serverEpoch).length > 0
                && stringField(value, 'rootId')
                && String(value.rootId).length > 0
                && stringField(value, 'workspace')
                && String(value.workspace).length > 0
                && (value.kind === 'semanticTokens' || value.kind === 'inlayHints')
                && revisionField(value, 'revision')
                && Number(value.revision) > 0;
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
