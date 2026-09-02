// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECT_ATTENTION_SCORE_MAX = exports.MAX_INLINE_WORKSPACE_MESSAGE_BYTES = exports.MIN_PROTOCOL_VERSION = exports.PROTOCOL_VERSION = void 0;
exports.sanitizeAgentUpdatePatch = sanitizeAgentUpdatePatch;
exports.validateClientMessage = validateClientMessage;
exports.validateServerMessage = validateServerMessage;
exports.protocolCompatible = protocolCompatible;
exports.claimProtocolUpgradeReload = claimProtocolUpgradeReload;
const agent_state_semantics_js_1 = require("./agent-state-semantics.js");
const agent_state_wire_js_1 = require("./agent-state-wire.js");
exports.PROTOCOL_VERSION = 17;
exports.MIN_PROTOCOL_VERSION = 17;
exports.MAX_INLINE_WORKSPACE_MESSAGE_BYTES = 1024 * 1024;
exports.PROJECT_ATTENTION_SCORE_MAX = agent_state_semantics_js_1.PROJECT_ATTENTION_SCORE_MAX;
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
function boundedStringField(value, name, maxLength, optional = false) {
    if (optional && value[name] === undefined)
        return true;
    return typeof value[name] === 'string' && String(value[name]).length <= maxLength;
}
function optionalBooleanField(value, name) {
    return value[name] === undefined || typeof value[name] === 'boolean';
}
function optionalNonNegativeIntegerField(value, name) {
    return value[name] === undefined || revisionField(value, name);
}
function workspaceRequest(value) {
    if (!objectMessage(value) || typeof value.operation !== 'string')
        return false;
    const rootPath = () => boundedStringField(value, 'rootId', 4096)
        && boundedStringField(value, 'path', 4096);
    const expectedVersion = () => boundedStringField(value, 'expectedVersion', 256, true);
    switch (value.operation) {
        case 'tree':
            return boundedStringField(value, 'rootId', 4096) && boundedStringField(value, 'path', 4096, true);
        case 'tree-decorations':
            return boundedStringField(value, 'rootId', 4096)
                && boundedStringField(value, 'path', 4096, true)
                && Array.isArray(value.entryPaths)
                && value.entryPaths.length <= 4096
                && value.entryPaths.every(entryPath => typeof entryPath === 'string' && entryPath.length <= 4096);
        case 'read-file':
        case 'create-preview':
            return rootPath() && optionalBooleanField(value, 'exactExternal');
        case 'delete-preview':
            return boundedStringField(value, 'previewId', 256);
        case 'save-file':
            return rootPath()
                && boundedStringField(value, 'content', exports.MAX_INLINE_WORKSPACE_MESSAGE_BYTES)
                && boundedStringField(value, 'baseSha1', 256)
                && optionalBooleanField(value, 'overwrite');
        case 'move-entry':
            return boundedStringField(value, 'rootId', 4096)
                && boundedStringField(value, 'sourcePath', 4096)
                && boundedStringField(value, 'targetDirectory', 4096)
                && expectedVersion();
        case 'create-entry':
            return boundedStringField(value, 'rootId', 4096)
                && boundedStringField(value, 'parentPath', 4096)
                && boundedStringField(value, 'name', 1024)
                && (value.entryType === 'file' || value.entryType === 'directory');
        case 'rename-entry':
            return rootPath() && boundedStringField(value, 'name', 1024) && expectedVersion();
        case 'delete-entry':
            return rootPath() && expectedVersion();
        case 'search':
            return boundedStringField(value, 'rootId', 4096)
                && boundedStringField(value, 'query', 4096)
                && boundedStringField(value, 'path', 4096, true)
                && optionalBooleanField(value, 'includeIgnored')
                && optionalNonNegativeIntegerField(value, 'limit')
                && (value.scope === undefined || value.scope === 'all' || value.scope === 'file-path' || value.scope === 'entries');
        case 'blame':
        case 'blame-capability':
        case 'diff':
            return rootPath();
        case 'changes':
            return boundedStringField(value, 'rootId', 4096) && optionalNonNegativeIntegerField(value, 'limit');
        case 'worktrees':
        case 'branches':
        case 'branch':
            return boundedStringField(value, 'rootId', 4096);
        case 'switch-branch':
            return boundedStringField(value, 'rootId', 4096)
                && boundedStringField(value, 'branch', 1024)
                && boundedStringField(value, 'expectedBranch', 1024)
                && boundedStringField(value, 'expectedHead', 64)
                && boundedStringField(value, 'operationId', 160);
        case 'history':
            return boundedStringField(value, 'rootId', 4096)
                && optionalNonNegativeIntegerField(value, 'limit')
                && optionalNonNegativeIntegerField(value, 'skip')
                && (value.scope === undefined || value.scope === 'current' || value.scope === 'all');
        case 'history-changes':
            return boundedStringField(value, 'rootId', 4096)
                && boundedStringField(value, 'commit', 128)
                && boundedStringField(value, 'parent', 128, true)
                && optionalNonNegativeIntegerField(value, 'limit');
        case 'line-changes':
            return rootPath()
                && revisionField(value, 'lineNumber')
                && Number(value.lineNumber) > 0
                && (value.mode === 'working' || value.mode === 'previous');
        default:
            return false;
    }
}
const LANGUAGE_SERVER_METHODS = new Set([
    'hover', 'definition', 'references', 'implementation', 'documentHighlights',
    'semanticTokens', 'inlayHints', 'documentSymbols', 'workspaceSymbols',
    'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls', 'prepareTypeHierarchy',
    'supertypes', 'subtypes', 'diagnostics',
]);
function languageServerRequest(value) {
    if (!objectMessage(value))
        return false;
    if (value.operation === 'capability')
        return optionalBooleanField(value, 'force');
    return value.operation === 'request'
        && boundedStringField(value, 'rootId', 4096)
        && typeof value.method === 'string'
        && LANGUAGE_SERVER_METHODS.has(value.method)
        && (value.priority === undefined || value.priority === 'interactive' || value.priority === 'background')
        && boundedStringField(value, 'filePath', 4096, true)
        && boundedStringField(value, 'query', 4096, true)
        && boundedStringField(value, 'itemId', 4096, true)
        && optionalField(value, 'position', () => objectMessage(value.position))
        && optionalField(value, 'range', () => objectMessage(value.range));
}
function serializedMessageWithinWorkspaceLimit(value) {
    const serialized = JSON.stringify(value);
    const bytes = encodeURIComponent(serialized).replace(/%[0-9A-F]{2}/gi, 'x').length;
    return bytes <= exports.MAX_INLINE_WORKSPACE_MESSAGE_BYTES;
}
function workspaceProtocolError(value) {
    return objectMessage(value)
        && boundedStringField(value, 'code', 128)
        && boundedStringField(value, 'message', 4096)
        && optionalField(value, 'status', () => revisionField(value, 'status'))
        && optionalBooleanField(value, 'uncertain');
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
            || !optionalField(summary, 'followUpCount', () => revisionField(summary, 'followUpCount'))
            || !revisionField(summary, 'unreadCount')
            || !revisionField(summary, 'zombieCount')
            || !revisionField(summary, 'maxAttentionScore')
            || Number(summary.activeCount) > Number(summary.agentCount)
            || (summary.followUpCount !== undefined && Number(summary.followUpCount) > Number(summary.agentCount))
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
        || !agents.every(agent_state_wire_js_1.isAgentStateWire)
        || new Set(agents.map(agent => agent.id)).size !== agents.length
        || !agentInventoryMetadata(state)
        || !optionalField(state, 'projectAgentSummaries', () => projectAgentSummaries(state))
        || (Object.prototype.hasOwnProperty.call(state, 'agentInventoryScope') && Number(snapshot?.offset) !== 0)
        || (state.projectAgentSummaries !== undefined && Number(snapshot?.offset) !== 0))
        return false;
    return optionalField(value, 'snapshot', () => stateSnapshotPage(value, agents.length));
}
function stateDeltaMessage(value) {
    const upserts = value.upserts;
    const removedAgentIds = value.removedAgentIds;
    if (!Array.isArray(upserts)
        || !upserts.every(agent_state_wire_js_1.isAgentStateWire)
        || !Array.isArray(removedAgentIds)
        || !removedAgentIds.every(agentId => typeof agentId === 'string'))
        return false;
    const upsertIds = upserts.map(agent => agent.id);
    return new Set(upsertIds).size === upsertIds.length
        && new Set(removedAgentIds).size === removedAgentIds.length
        && !upsertIds.some(agentId => removedAgentIds.includes(agentId))
        && stringField(value, 'generation')
        && revisionField(value, 'sequence')
        && optionalField(value, 'state', () => (objectMessage(value.state)
            && !Object.prototype.hasOwnProperty.call(value.state, 'agents')
            && agentInventoryMetadata(value.state)));
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
    const messageType = value.type;
    let valid = true;
    switch (messageType) {
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
            valid = stringField(value, 'requestId') && stringField(value, 'agentId')
                && optionalNonNegativeIntegerField(value, 'scrollbackLimit')
                && (value.scrollbackLimit === undefined || Number(value.scrollbackLimit) <= 5000);
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
        case 'watch-acp-transcripts':
            valid = Array.isArray(value.agentIds)
                && value.agentIds.length <= 20
                && value.agentIds.every(agentId => typeof agentId === 'string' && agentId.length > 0 && agentId.length <= 256)
                && new Set(value.agentIds).size === value.agentIds.length;
            break;
        case 'resize-agent':
            valid = stringField(value, 'agentId') && finiteField(value, 'cols') && finiteField(value, 'rows');
            break;
        case 'unwatch-workspace-files':
            valid = stringField(value, 'rootId', true);
            break;
        case 'restart-main-agent':
            valid = stringField(value, 'command');
            break;
        case 'state-resync':
            valid = stringField(value, 'generation', true)
                && optionalField(value, 'afterSequence', () => revisionField(value, 'afterSequence'));
            break;
        case 'desktop-browser-adapter-register':
            valid = boundedStringField(value, 'adapterId', 160);
            break;
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
                && optionalBooleanField(value, 'uncertain');
            break;
        case 'desktop-browser-adapter-event':
            valid = boundedStringField(value, 'adapterId', 160)
                && boundedStringField(value, 'resourceId', 256)
                && boundedStringField(value, 'sessionId', 256)
                && revisionField(value, 'generation')
                && boundedStringField(value, 'kind', 128)
                && optionalField(value, 'payload', () => objectMessage(value.payload));
            break;
        case 'watch-workspace-files':
            valid = stringField(value, 'rootId')
                && Array.isArray(value.paths)
                && value.paths.length > 0
                && value.paths.length <= 256
                && value.paths.every(filePath => typeof filePath === 'string' && filePath.length > 0 && filePath.length <= 4096)
                && new Set(value.paths).size === value.paths.length;
            break;
        case 'workspace-request':
            valid = stringField(value, 'requestId')
                && workspaceRequest(value.request)
                && serializedMessageWithinWorkspaceLimit(value);
            break;
        case 'workspace-cancel':
            valid = stringField(value, 'requestId');
            break;
        case 'language-server-request':
            valid = stringField(value, 'requestId')
                && languageServerRequest(value.request)
                && serializedMessageWithinWorkspaceLimit(value);
            break;
        case 'interrupt-agent':
        case 'clear-terminal':
        case 'archive-agent':
            valid = stringField(value, 'agentId');
            break;
        default: {
            const unsupportedMessageType = messageType;
            return { ok: false, error: `unsupported client message: ${unsupportedMessageType}` };
        }
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
            valid = Number.isInteger(value.protocolVersion)
                && Number.isInteger(value.minProtocolVersion)
                && optionalNonNegativeIntegerField(value, 'maxInlineWorkspaceMessageBytes');
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
            valid = stateDeltaMessage(value);
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
                && String(value.session.updatedAt).length > 0;
            break;
        case 'agent-read':
            valid = agentReadState(value.read);
            break;
        case 'workspace-file-watch':
            valid = stringField(value, 'rootId')
                && Array.isArray(value.paths)
                && value.paths.every(filePath => typeof filePath === 'string')
                && typeof value.watching === 'boolean';
            break;
        case 'workspace-file-event':
            valid = objectMessage(value.event) && stringField(value.event, 'rootId');
            break;
        case 'workspace-result':
            valid = stringField(value, 'requestId')
                && typeof value.ok === 'boolean'
                && (value.ok
                    ? Object.prototype.hasOwnProperty.call(value, 'result') && value.error === undefined
                    : workspaceProtocolError(value.error) && value.result === undefined)
                && serializedMessageWithinWorkspaceLimit(value);
            break;
        case 'language-server-result':
            valid = stringField(value, 'requestId')
                && typeof value.ok === 'boolean'
                && optionalField(value, 'supported', () => typeof value.supported === 'boolean')
                && (value.ok
                    ? Object.prototype.hasOwnProperty.call(value, 'result') && value.error === undefined
                    : workspaceProtocolError(value.error) && value.result === undefined)
                && serializedMessageWithinWorkspaceLimit(value);
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
        case 'desktop-browser-adapter-registered':
            valid = boundedStringField(value, 'adapterId', 160)
                && boundedStringField(value, 'serverEpoch', 256);
            break;
        case 'desktop-browser-command': {
            const command = objectMessage(value.command) ? value.command : null;
            valid = command !== null
                && boundedStringField(command, 'adapterId', 160)
                && boundedStringField(command, 'requestId', 160)
                && boundedStringField(command, 'resourceId', 256)
                && boundedStringField(command, 'sessionId', 256)
                && revisionField(command, 'generation')
                && boundedStringField(command, 'operation', 128)
                && optionalField(command, 'input', () => objectMessage(command.input));
            break;
        }
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
function claimProtocolUpgradeReload(pageProtocolVersion, backendProtocolVersion, storage, scope) {
    if (!Number.isInteger(pageProtocolVersion)
        || !Number.isInteger(backendProtocolVersion)
        || backendProtocolVersion <= pageProtocolVersion) {
        return false;
    }
    const key = `farming:protocol-upgrade-reload:${scope}:${backendProtocolVersion}`;
    try {
        if (storage.getItem(key) === '1')
            return false;
        storage.setItem(key, '1');
        return true;
    }
    catch {
        return false;
    }
}
