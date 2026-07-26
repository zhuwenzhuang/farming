const EventEmitter = require('events');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const SystemMonitor = require('./system-monitor');
const SessionEngineBridge = require('./session-engine-bridge');
const { isSupportedHistoryAgent, parseCommand, resolveLaunchCommand } = require('./cli-agents');
const {
  buildAgentSessionResumeCommand,
  findAgentSession,
} = require('./agent-session-history');
const { archiveCodexSession, unarchiveCodexSession } = require('./codex-session-archive');
const { buildAgentProviderSessionPlan, sessionFromExactResumeSource } = require('./agent-provider-session');
const { resolveAgentExecutable, resolveCompatibleCodexExecutable } = require('./executable-discovery');
const { ensureMainAgentSkillFiles, renderMainAgentBootstrap } = require('./main-agent-skills');
const { mainPageAgentSessionKey, resumedAgentSource } = require('./main-page-session');
const { isSafeProviderSessionId, isTemporaryProviderSessionId } = require('./provider-session-id');
const { ProviderSessionService } = require('./provider-session-service');
const {
  legacyRuntimeMetadata,
  publicRuntimeBinding,
  replaceRuntimeBinding,
  RuntimeAgentMap,
  runtimeBindingFor,
  runtimeBindingOf,
  runtimeKind,
} = require('./agent-runtime-binding');
const { deriveRuntimeObservation } = require('./runtime-observation');
const {
  applyProviderHomeEnvironment,
  getProviderAdapter,
  isFreshAcpSessionSource,
  providerAcpForkMode,
  providerCapabilities,
  providerForProgram,
  providerSupportsRuntime,
} = require('./provider-adapters');
const { deriveTerminalStatus } = require('./terminal-status');
const { JsonCliRuntime } = require('./json-cli-runtime');
const {
  AcpRuntime,
  stopPersistedAcpProcessGroup,
} = require('./acp-runtime');
const { chatRuntimeForProvider, isChatMode } = require('./chat-runtime');
const { acpToolChanges, acpToolDetail, acpToolReviewChanges, acpTranscriptToolEntry } = require('./acp-transcript');
const {
  applyCodexTerminalProfile,
  codexTerminalProfileFromOutput,
  codexTerminalProfileFromPreview,
} = require('./codex-terminal-profile');
const {
  ensureAgentOrders,
  finiteOrder,
  nextPinnedOrder,
  reorderedPinnedAgentOrders,
  reorderedProjectAgentOrders,
} = require('./agent-order');
const {
  buildInteractiveAgentBaseEnv,
  normalizeInteractiveTerminalEnv,
  resolveUserShellEnvSync,
} = require('./agent-env');
const { inspectGitWorktree } = require('./git-worktree-info');
const { deserializeTerminalState } = require('./terminal-state-serialization');
const { compareNativePtyRuntimeEpochs } = require('./native-pty-controller-generation');
const { canonicalWorkspacePath } = require('./workspace-root-registry');
const { mergeBrowserMcpServer } = require('../extensions/browser/backend/agent-capability');
const {
  TERMINAL_OPERATION_STATES,
  activeLifecycleOperation,
  beginLifecycleOperation,
  latestLifecycleOperation,
  lifecycleJournal,
  setLifecycleOperationResult,
  transitionLifecycleOperation,
} = require('./agent-lifecycle-journal');

const SESSION_OUTPUT_LIMIT = 10000;
const AGENT_USAGE_RATE_WINDOW_MS = 5 * 60 * 1000;
const AGENT_USAGE_RATE_REFRESH_MS = 5 * 1000;
const ACTIVITY_UPDATE_INTERVAL_MS = 1000;
const ACTIVITY_HOT_SEC = 30 * 60;
const ACTIVITY_WARM_SEC = 3 * 60 * 60;
const MAX_COMPOSER_COMMANDS = 64;
const ACTIVITY_COOL_SEC = 12 * 60 * 60;
const ZOMBIE_IDLE_MS = 72 * 60 * 60 * 1000;
const ZOMBIE_SWEEP_INTERVAL_MS = 60 * 1000;
const MISSING_ENGINE_SESSION_STARTUP_GRACE_MS = 5000;
const MIN_TERMINAL_RESIZE_COLS = 40;
const MIN_TERMINAL_RESIZE_ROWS = 10;
const AGENT_DISCOVERY_CACHE_MAX_AGE_MS = 3_000;
const UNCERTAIN_TERMINAL_STOP_TIMEOUT_MS = 5_000;
const TERMINAL_STOP_STATE_READ_TIMEOUT_MS = 1_000;
const TERMINAL_STOP_POLL_MS = 50;
const CODEX_TERMINAL_START_READY_TIMEOUT_MS = 30_000;
const WORKTREE_DELETE_START_DRAIN_TIMEOUT_MS = 30_000;
const CODEX_TERMINAL_START_READY_POLL_MS = 50;
const CODEX_TERMINAL_START_OUTPUT_LIMIT = 64 * 1024;
const SHELL_PROMPT_ENV_KEYS = [
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'PROMPT',
  'RPROMPT',
  'RPS1',
  'PROMPT_COMMAND',
];
const CREATE_ROLLBACK_FIELDS = [
  'runtimeAgentId',
  'command',
  'forkCommand',
  'cwd',
  'projectWorkspace',
  'mainWorkspace',
  'source',
  'providerHomePath',
  'providerSessionTemporary',
  'providerSessionSource',
  'providerSessionResolvedAt',
  'providerSessionTitle',
  'providerSessionWorkspace',
  'terminalInputReceived',
  'structuredRuntimeProcess',
  'legacyAcpProcessExitAcknowledgedAt',
  'acpAdditionalDirectories',
  'acpMcpServers',
  'agentRuntimeMode',
  'acpState',
  'acpError',
  'acpStopReason',
  'acpPendingPermission',
  'acpPendingPermissions',
  'acpPendingElicitation',
  'acpPendingElicitations',
  'acpActiveElicitations',
  'acpSessionUpdatedAt',
  'acpSessionRevision',
  'jsonCliState',
  'jsonCliError',
  'jsonCliTranscriptUpdatedAt',
  'engine',
  'category',
  'task',
  'workflowTemplate',
  'wantsMain',
  'pinned',
  'projectOrder',
  'pinnedOrder',
  'attentionSeq',
  'readAttentionSeq',
  'attentionUpdatedAt',
  'readAttentionAt',
  'attentionReason',
  'attentionOutputEpoch',
  'attentionOutputSeq',
  'readOutputEpoch',
  'readOutputSeq',
  'archived',
  'archivedAt',
  'visibleOnMainPage',
  'customTitle',
  'title',
  'startedAt',
];
const execFileAsync = promisify(execFile);

function createRollbackState(record) {
  if (!record || typeof record !== 'object') return null;
  const state = {};
  for (const field of CREATE_ROLLBACK_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(record, field)
      ? record[field]
      : null;
    state[field] = value === undefined ? null : JSON.parse(JSON.stringify(value));
  }
  state.runtimeAgentId = String(record.runtimeAgentId || '');
  state.visibleOnMainPage = record.visibleOnMainPage === true;
  state.archived = record.archived === true;
  state.customTitle = typeof record.customTitle === 'string' ? record.customTitle : '';
  return state;
}

function createFailurePatch(operation, fallbackRuntimeAgentId = '') {
  const previousState = operation?.request?.previousState;
  if (previousState && typeof previousState === 'object') {
    return JSON.parse(JSON.stringify(previousState));
  }
  return {
    visibleOnMainPage: Boolean(fallbackRuntimeAgentId),
    runtimeAgentId: String(fallbackRuntimeAgentId || ''),
  };
}

function withBoundedWait(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function canonicalProviderHomePath(value) {
  const resolved = path.resolve(String(value || '').trim() || '.');
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function deletePrecreatedProviderSession(options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  const sessionId = String(options.sessionId || '').trim();
  if (!isSafeProviderSessionId(sessionId)) throw new Error('Invalid pre-created provider session id');
  let args = [];
  if (provider === 'codex') args = ['delete', '--force', sessionId];
  else if (provider === 'opencode') args = ['session', 'delete', sessionId];
  else throw new Error(`${provider || 'Provider'} does not support pre-created session rollback`);
  await execFileAsync(options.executable, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

function trimSessionOutput(output) {
  const text = typeof output === 'string' ? output : '';
  return text.length > SESSION_OUTPUT_LIMIT ? text.slice(-SESSION_OUTPUT_LIMIT) : text;
}

function terminalStateUpdateDisposition(agent, runtimeEpoch, outputSeq, stateRevision) {
  const currentEpoch = typeof agent.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
  const nextEpoch = typeof runtimeEpoch === 'string' ? runtimeEpoch : '';
  if (currentEpoch && nextEpoch && currentEpoch !== nextEpoch) {
    const relation = compareNativePtyRuntimeEpochs(nextEpoch, currentEpoch);
    return relation === 1 ? 'new-epoch' : 'stale';
  }
  if (currentEpoch && !nextEpoch) return 'unversioned';
  if (!currentEpoch || !nextEpoch) return 'current';

  const currentRevision = Number(agent.stateRevision);
  const nextRevision = Number(stateRevision);
  if (Number.isFinite(currentRevision) && Number.isFinite(nextRevision)) {
    if (nextRevision < currentRevision) return 'stale';
    if (nextRevision === currentRevision) {
      const currentOutputSeq = Number(agent.lastOutputSeq);
      const nextOutputSeq = Number(outputSeq);
      return Number.isFinite(nextOutputSeq)
        && Number.isFinite(currentOutputSeq)
        && nextOutputSeq === currentOutputSeq
        ? 'duplicate'
        : 'stale';
    }
  }
  const currentOutputSeq = Number(agent.lastOutputSeq);
  const nextOutputSeq = Number(outputSeq);
  if (Number.isFinite(currentOutputSeq) && Number.isFinite(nextOutputSeq) && nextOutputSeq < currentOutputSeq) {
    return 'stale';
  }
  return 'current';
}

function terminalRuntimeEventMatches(agent, runtimeEpoch) {
  const currentEpoch = typeof agent?.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
  if (!currentEpoch) return true;
  return typeof runtimeEpoch === 'string' && runtimeEpoch === currentEpoch;
}

function setPendingTerminalStartSyncCut(agent, runtimeEpoch, outputSeq, stateRevision) {
  if (
    typeof runtimeEpoch !== 'string' || !runtimeEpoch ||
    !Number.isFinite(outputSeq) ||
    !Number.isFinite(stateRevision)
  ) {
    delete agent.pendingTerminalStartSyncCut;
    return;
  }
  agent.pendingTerminalStartSyncCut = {
    runtimeEpoch,
    outputSeq,
    stateRevision,
  };
}

function consumesPendingTerminalStartSyncCut(agent, runtimeEpoch, outputSeq, stateRevision) {
  const pending = agent?.pendingTerminalStartSyncCut;
  return Boolean(
    pending &&
    pending.runtimeEpoch === runtimeEpoch &&
    pending.outputSeq === outputSeq &&
    pending.stateRevision === stateRevision &&
    agent.runtimeEpoch === runtimeEpoch &&
    agent.lastOutputSeq === outputSeq &&
    agent.stateRevision === stateRevision
  );
}

function clearPendingTerminalStartSyncCut(agent) {
  if (agent) delete agent.pendingTerminalStartSyncCut;
}

function applyTerminalStateCursor(agent, runtimeEpoch, outputSeq, stateRevision, disposition) {
  if (disposition === 'stale' || disposition === 'duplicate' || disposition === 'unversioned') return false;
  if (disposition === 'new-epoch') {
    agent.lastOutputSeq = 0;
    agent.stateRevision = 0;
  }
  if (typeof runtimeEpoch === 'string' && runtimeEpoch) agent.runtimeEpoch = runtimeEpoch;
  if (Number.isFinite(outputSeq)) agent.lastOutputSeq = outputSeq;
  if (Number.isFinite(stateRevision)) agent.stateRevision = stateRevision;
  return true;
}

function codexCommandContinuesSession(command) {
  const parts = parseCommand(command);
  return path.basename(parts[0] || '') === 'codex'
    && parts.slice(1).some(arg => arg === 'resume' || arg === 'fork');
}

function preserveCodexSessionProfileOptions() {
  return {
    preserveProviderSessionProfile: true,
  };
}

function isSameOrDescendantPath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resumedSessionFromSource(source) {
  return sessionFromExactResumeSource(source);
}

function agentProgramName(command) {
  const executable = String(command || '')
    .trim()
    .split(/\s+/)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return path.basename(executable || '');
}

function agentHomeProviderForProgram(command) {
  return providerForProgram(agentProgramName(command));
}

function isJsonCliAgent(agent) {
  return runtimeKind(agent) === 'json';
}

function isAcpAgent(agent) {
  return runtimeKind(agent) === 'acp';
}

function normalizedComposerPrompt(message) {
  const prompt = Array.isArray(message) ? message : [{ type: 'text', text: String(message || '') }];
  const text = prompt
    .filter(content => content?.type === 'text')
    .map(content => String(content.text || ''))
    .join('')
    .trim();
  if (prompt.length === 0 || (!text && !prompt.some(content => content?.type !== 'text'))) {
    throw new Error('Composer message is empty');
  }
  return prompt;
}

function composerCommandHash(prompt) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableJsonValue(prompt)))
    .digest('hex');
}

function composerAdmissionError(message, uncertain = false) {
  const error = new Error(message);
  if (uncertain) error.uncertain = true;
  return error;
}

function normalizedComposerCommands(commands) {
  return (Array.isArray(commands) ? commands : [])
    .filter(command => (
      command
      && typeof command === 'object'
      && /^[A-Za-z0-9._:-]{1,160}$/.test(command.requestId)
      && typeof command.contentHash === 'string'
      && ['intent', 'accepted', 'unknown', 'failed'].includes(command.state)
    ))
    .slice(-MAX_COMPOSER_COMMANDS)
    .map(command => ({
      requestId: command.requestId,
      contentHash: command.contentHash,
      state: command.state,
      result: command.result && typeof command.result === 'object'
        ? JSON.parse(JSON.stringify(command.result))
        : null,
      error: typeof command.error === 'string' ? command.error.slice(0, 2000) : '',
      createdAt: Number(command.createdAt) || 0,
      updatedAt: Number(command.updatedAt) || 0,
    }));
}

function isShellProgram(command) {
  return ['bash', 'zsh', 'sh', 'fish'].includes(agentProgramName(command).toLowerCase());
}

function isEphemeralShellAgent(agent) {
  return agent && isShellProgram(agent.forkCommand || agent.command || '');
}

function hasSubmittedTerminalInput(input) {
  const parts = Array.isArray(input) ? input : [input];
  return parts.some(part => {
    // Composer paste parts carry draft text separately from the trailing Enter.
    // Newlines inside that draft must not independently materialize a session.
    if (part && typeof part === 'object' && part.type === 'paste') return false;
    const text = String(part || '');
    // xterm wraps native paste payloads so embedded newlines remain draft text.
    // Remove complete bracketed-paste spans before looking for a submission.
    const withoutBracketedPaste = text.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, '');
    return /[\r\n]/.test(withoutBracketedPaste);
  });
}

function activeCodexTerminalProfile(agent, previewText) {
  if (!agent) return null;
  const provider = agent.providerSessionProvider
    || agentHomeProviderForProgram(agent.forkCommand || agent.command || '');
  if (
    provider !== 'codex'
    || isJsonCliAgent(agent)
    || isAcpAgent(agent)
    || runtimeKind(agent) !== 'terminal'
  ) {
    return null;
  }

  const outputProfile = codexTerminalProfileFromOutput(agent.output || '');
  const parsed = outputProfile || codexTerminalProfileFromPreview(previewText);
  if (!parsed) return agent.codexTerminalProfile || null;
  const previousServiceTier = agent.codexTerminalProfile?.serviceTier;
  const profile = {
    model: parsed.model,
    reasoningEffort: parsed.effort,
    serviceTier: typeof parsed.fast === 'boolean'
      ? (parsed.fast ? 'priority' : 'default')
      : (previousServiceTier || 'default'),
    source: outputProfile ? 'terminal-output' : 'terminal-footer',
  };
  agent.codexTerminalProfile = profile;
  return profile;
}

function terminalMetadataPatch(agent) {
  const terminalStatus = deriveAgentTerminalStatus(agent);
  return {
    terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
    shellCwd: agent.shellCwd || '',
    shellLastExitCode: agent.shellLastExitCode ?? null,
    shellLastEvent: agent.shellLastEvent || '',
    shellCommand: agent.shellCommand || '',
    shellLastCommand: agent.shellLastCommand || '',
    shellCommandStartedAt: agent.shellCommandStartedAt ?? null,
    shellLastCommandStartedAt: agent.shellLastCommandStartedAt ?? null,
    shellLastCommandFinishedAt: agent.shellLastCommandFinishedAt ?? null,
    shellLastCommandDurationMs: agent.shellLastCommandDurationMs ?? null,
    terminalStatus,
    runtimeObservation: deriveRuntimeObservation({ ...agent, terminalStatus }),
  };
}

function terminalRuntimeStatus(agentStatus) {
  return agentStatus === 'stopped' || agentStatus === 'dead' ? 'exited' : agentStatus;
}

function finiteNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function deriveAgentTerminalStatus(agent, overrides = {}) {
  const terminalBusy = Object.prototype.hasOwnProperty.call(overrides, 'terminalBusy')
    ? overrides.terminalBusy
    : agent.terminalBusy;
  return deriveTerminalStatus({
    command: agent.forkCommand || agent.command,
    cwd: overrides.cwd || agent.shellCwd || agent.cwd,
    status: overrides.status || terminalRuntimeStatus(agent.status),
    title: Object.prototype.hasOwnProperty.call(overrides, 'title')
      ? overrides.title
      : (agent.sessionTitle || ''),
    previewText: Object.prototype.hasOwnProperty.call(overrides, 'previewText')
      ? overrides.previewText
      : (agent.previewText || agent.output || ''),
    terminalBusy: typeof terminalBusy === 'boolean' ? terminalBusy : null,
    shellLastExitCode: typeof agent.shellLastExitCode === 'number' ? agent.shellLastExitCode : null,
    shellLastEvent: agent.shellLastEvent || '',
    shellCommand: Object.prototype.hasOwnProperty.call(overrides, 'shellCommand')
      ? overrides.shellCommand
      : (agent.shellCommand || ''),
    shellLastCommand: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommand')
      ? overrides.shellLastCommand
      : (agent.shellLastCommand || ''),
    shellCommandStartedAt: Object.prototype.hasOwnProperty.call(overrides, 'shellCommandStartedAt')
      ? overrides.shellCommandStartedAt
      : finiteNumberOrNull(agent.shellCommandStartedAt),
    shellLastCommandStartedAt: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommandStartedAt')
      ? overrides.shellLastCommandStartedAt
      : finiteNumberOrNull(agent.shellLastCommandStartedAt),
    shellLastCommandFinishedAt: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommandFinishedAt')
      ? overrides.shellLastCommandFinishedAt
      : finiteNumberOrNull(agent.shellLastCommandFinishedAt),
    shellLastCommandDurationMs: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommandDurationMs')
      ? overrides.shellLastCommandDurationMs
      : finiteNumberOrNull(agent.shellLastCommandDurationMs),
  });
}

function agentAttentionUnread(agent) {
  return finiteNonNegativeInteger(agent && agent.attentionSeq) > finiteNonNegativeInteger(agent && agent.readAttentionSeq);
}

function setAgentRecordId(agent, agentRecordId) {
  if (!agent || typeof agentRecordId !== 'string' || !agentRecordId) return;
  agent.agentRecordId = agentRecordId;
  agent.persistentSessionId = agentRecordId;
}

function hasAgentOutputAfterAttentionBaseline(agent) {
  if (!agent || agent.attentionRequiresNewOutput !== true) return true;
  const baselineSeq = finiteNumberOrNull(agent.attentionBaselineOutputSeq);
  const lastOutputSeq = finiteNumberOrNull(agent.lastOutputSeq);
  if (baselineSeq !== null && lastOutputSeq !== null) {
    return lastOutputSeq > baselineSeq;
  }

  const baselineAt = finiteNumberOrNull(agent.attentionBaselineOutputAt);
  const lastOutputAt = finiteNumberOrNull(agent.lastEngineOutputAt);
  if (baselineAt !== null && lastOutputAt !== null) {
    return lastOutputAt > baselineAt;
  }

  return false;
}

function shouldRestoreAgentFromMetadata(record, mainPageSessionKeys) {
  if (!record || record.archived === true) return false;
  const latestOperation = latestLifecycleOperation(record);
  if (latestOperation?.type === 'delete' && latestOperation.state === 'succeeded') return false;
  if (
    latestOperation?.type === 'create'
    && latestOperation.state === 'succeeded'
    && record.visibleOnMainPage === true
  ) {
    return true;
  }
  if (record.wantsMain === true) return true;
  if (
    record.providerSessionTemporary === true
    || isTemporaryProviderSessionId(record.providerSessionId)
  ) {
    return record.visibleOnMainPage === true;
  }
  const provider = String(record.providerSessionProvider || record.provider || '').trim();
  const sessionKey = record.providerSessionKey || mainPageAgentSessionKey(
    provider,
    record.providerSessionId,
    record.providerHomeId || 'default'
  );
  if (sessionKey) return mainPageSessionKeys.has(sessionKey);
  return record.visibleOnMainPage === true;
}

function lifecycleOperationBlocksRuntimeStart(record) {
  const operation = activeLifecycleOperation(record);
  return operation && ['create', 'delete', 'archive', 'runtime-switch'].includes(operation.type)
    ? operation
    : null;
}

function requiresLegacyAcpExitAcknowledgement(record) {
  if (
    runtimeKind(record) !== 'acp'
    || record?.structuredRuntimeProcess
    || record?.legacyAcpProcessExitAcknowledgedAt
  ) {
    return false;
  }
  if (record?.requiresProcessExitAcknowledgement === true) return true;
  const operation = activeLifecycleOperation(record);
  return Boolean(
    operation
    && ['delete', 'archive'].includes(operation.type)
    && operation.request?.structuredProcessProofRequired === true,
  );
}

function publicActiveLifecycleOperation(agent) {
  const operation = activeLifecycleOperation(agent);
  if (!operation) return null;
  return {
    id: operation.id,
    type: operation.type,
    state: operation.state,
    error: operation.error || '',
    startedAt: operation.startedAt || null,
    updatedAt: operation.updatedAt || null,
  };
}

function recoveredEngineSessionId(entry, metadata = {}) {
  return entry && (entry.sessionId || entry.agentId || metadata.agentId) || '';
}

function agentDisplayName(command) {
  const program = agentProgramName(command).toLowerCase();
  return getProviderAdapter(providerForProgram(program))?.displayName || program;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    const child = value[key];
    if (!['function', 'symbol', 'undefined'].includes(typeof child)) {
      result[key] = stableJsonValue(child);
    }
    return result;
  }, {});
}

function createOperationSignature(command, customWorkspace, options = {}) {
  const semanticOptions = { ...options };
  [
    'createRequestId',
    'lifecycleToken',
    'skipRecoveryWait',
    'startAdmissionToken',
  ].forEach(field => delete semanticOptions[field]);
  return crypto.createHash('sha256').update(JSON.stringify(stableJsonValue({
    command: String(command || '').trim(),
    workspace: String(customWorkspace || ''),
    options: semanticOptions,
  }))).digest('hex');
}

function titleComparisonKey(title) {
  return String(title || '')
    .trim()
    .replace(/^[\s*＊✳✱✲✶·•:.\u2800-\u28FF]+/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function agentWorkspaceTitleKeys(agent) {
  return [agent && agent.cwd, agent && agent.projectWorkspace]
    .filter(value => typeof value === 'string' && value.trim().length > 0)
    .map(value => path.basename(String(value).replace(/[\\/]+$/, '')))
    .filter(Boolean)
    .map(titleComparisonKey);
}

function isGenericSessionTitle(agent, title) {
  const normalizedTitle = titleComparisonKey(title);
  if (!normalizedTitle) return true;

  const program = agentProgramName(agent && agent.command).toLowerCase();
  const displayName = agentDisplayName(agent && agent.command);
  const genericTitles = new Set([
    program,
    displayName,
    `${program} session`,
    `${displayName} session`,
    'main agent',
    'farming',
  ].filter(Boolean));

  if (genericTitles.has(normalizedTitle)) return true;
  return agentWorkspaceTitleKeys(agent).includes(normalizedTitle);
}

function interruptInputForAgent(agent) {
  const provider = agent?.providerSessionProvider || agentHomeProviderForProgram(agent?.command);
  return getProviderAdapter(provider)?.interruptInput || '\x03';
}

function normalizePathValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function effectiveAgentWorkspaceRoot(agent) {
  if (agent && agent.gitWorktree && agent.gitWorktree.workspace) {
    return agent.gitWorktree.workspace;
  }
  return agent && (agent.projectWorkspace || agent.cwd) || '';
}

function publicAgentGitWorktree(agent) {
  const worktree = agent && agent.gitWorktree;
  if (!worktree || !worktree.workspace) return null;
  return {
    workspace: worktree.workspace,
    commonDir: worktree.commonDir || '',
    mainWorkspace: worktree.mainWorkspace || '',
    linked: worktree.linked === true,
    branch: worktree.branch || '',
    head: worktree.head || '',
    detached: worktree.detached === true,
    locked: worktree.locked === true,
    lockReason: worktree.lockReason || '',
    prunable: worktree.prunable === true,
    pruneReason: worktree.pruneReason || '',
    worktrees: Array.isArray(worktree.worktrees)
      ? worktree.worktrees.map(item => ({
        workspace: item.workspace || '',
        head: item.head || '',
        branch: item.branch || '',
        bare: item.bare === true,
        detached: item.detached === true,
        locked: item.locked === true,
        lockReason: item.lockReason || '',
        prunable: item.prunable === true,
        pruneReason: item.pruneReason || '',
        current: item.current === true,
        main: item.main === true,
      }))
      : [],
  };
}

function normalizePositiveInteger(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function isSessionNotAvailableError(error) {
  const message = String(error && (error.message || error));
  return /Session not available/i.test(message) ||
    /Native PTY host (?:failed to start or connect|is not reachable)/i.test(message);
}

function isRunningAgentRuntimeStatus(status) {
  return String(status || '').toLowerCase() === 'running';
}

function isLiveEngineSessionState(sessionState) {
  return Boolean(sessionState && sessionState.status && sessionState.status !== 'exited');
}

function timestampSlug(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function projectOperationSignature(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableJsonValue(value)))
    .digest('hex');
}

function worktreesFromPorcelain(output) {
  const worktrees = [];
  let current = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { workspace: path.resolve(line.slice('worktree '.length)), branch: '' };
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function isFarmingForkWorktreePath(workspace) {
  const basename = path.basename(String(workspace || '').replace(/[\\/]+$/, ''));
  return /-farming-fork-\d{8}-\d{6}(?:-\d+)?$/.test(basename);
}

function statusEntriesFromPorcelain(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);
}

class AgentManager extends EventEmitter {
  constructor(configManager, options = {}) {
    super();
    this.configManager = configManager;
    this.controlUrl = options.controlUrl || '';
    this.tokenFile = options.tokenFile || '';
    this.authDisabled = options.authDisabled === true;
    this.browserMcpEnabled = options.browserMcpEnabled === true;
    this.skipExecutablePreflight = options.skipExecutablePreflight === true;
    this.cliBinDir = options.cliBinDir || path.join(__dirname, '..', 'bin');
    this.agentShellEnvProvider = typeof options.agentShellEnvProvider === 'function'
      ? options.agentShellEnvProvider
      : shell => resolveUserShellEnvSync({ processEnv: process.env, shell });
    this.agentShellEnvCache = new Map();
    this.agentShellEnvCacheMs = normalizePositiveInteger(
      process.env.FARMING_AGENT_SHELL_ENV_CACHE_MS,
      5 * 60 * 1000,
      0,
      60 * 60 * 1000
    );
    this.agents = new RuntimeAgentMap();
    this.mainAgentId = null;
    this.mainAgentStartReservation = null;
    this.lastActivity = new Map();
    this.lastActivityUpdate = new Map();
    this.outputEvents = new Map(); // Map<agentId, Array<{timestamp, bytes}>> for rate tracking
    this.agentUsageRateCache = new Map();
    this.lastResizeByAgent = new Map();
    this.pendingResizeByAgent = new Map();
    this.resizeDrains = new Map();
    this.inputQueues = new Map();
    this.composerAdmissions = new Map();
    this.codexTerminalProfileQueues = new Map();
    this.codexTerminalStartQueues = new Map();
    this.codexTerminalStartOutput = new Map();
    this.agentWorktreeResolveGeneration = new Map();
    this.agentLifecycleOperations = new Map();
    this.agentStartAdmissions = new Map();
    this.createRequestAdmissions = new Map();
    this.projectOperationAdmissions = new Map();
    this.projectWorkspaceDeleteAdmissions = new Map();
    this.activeInputOperations = new Set();
    this.verifiedStoppedAgentIds = new Set();
    this.codexSessionMutationQueues = new Map();
    // Standard ACP session inputs may contain MCP credentials. Keep the live
    // copy outside browser-facing Agent records; crash recovery persists it
    // only through the private Farming session store.
    this.acpSessionOptionsByKey = new Map();
    this.permissionRestartSuppressedAgentIds = new Set();
    this.jsonCliRuntime = options.jsonCliRuntime || new JsonCliRuntime();
    this.acpRuntime = options.acpRuntime || new AcpRuntime({
      ...(this.configManager?.farmingDir ? { configDir: this.configManager.farmingDir } : {}),
      ...(process.env.FARMING_E2E_FAKE_ACP_AGENT === '1'
        ? {
            resolveLaunch: () => ({
              command: process.execPath,
              args: [path.join(__dirname, 'tests', 'fixtures', 'fake-acp-agent.mjs')],
              version: 'e2e',
            }),
          }
        : {}),
    });
    this.createProviderSessionIdentity = typeof options.createProviderSessionIdentity === 'function'
      ? options.createProviderSessionIdentity
      : createOptions => this.acpRuntime.createSessionIdentity(createOptions);
    this.deleteProviderSessionIdentity = typeof options.deleteProviderSessionIdentity === 'function'
      ? options.deleteProviderSessionIdentity
      : deletePrecreatedProviderSession;
    this.archiveCodexSession = options.archiveCodexSession || archiveCodexSession;
    this.unarchiveCodexSession = options.unarchiveCodexSession || unarchiveCodexSession;
    this.stopPersistedAcpProcessGroup = options.stopPersistedAcpProcessGroup
      || stopPersistedAcpProcessGroup;
    // Upgrade compatibility is the product default: records created before
    // ACP process identities existed must still resume their provider Session.
    // Strict callers may opt out explicitly for cleanup-safety diagnostics.
    this.allowUnprovenLegacyAcpRecovery = options.allowUnprovenLegacyAcpRecovery !== false;
    this.heartbeatInterval = null;
    this.disposing = false;
    this.disposeFrozen = false;
    this.disposePromise = null;
    this.disposed = false;
    this.systemMonitor = new SystemMonitor();
    this.startTime = Date.now();
    this.engineBridge = new SessionEngineBridge(configManager);
    this.providerSessionService = new ProviderSessionService({
      agents: this.agents,
      getProviderHomes: () => this.configManager?.getSettings?.()?.agentHomes,
      commit: (agent, change = {}) => {
        if (change.kind === 'session-updated') this.ensurePersistentAgentSession(agent);
        this.updateEngineProviderSessionMetadata(agent);
        this.rememberMainPageProviderSession(agent);
        if (change.event) {
          this.emit('provider-session-updated', change.event);
          this.emit('update');
        }
        if (change.refreshWorkspace) {
          void this.refreshAgentWorktree(agent.id, change.refreshWorkspace);
        }
      },
    });
    this.recoveryPromise = Promise.resolve();
    this.recoveryComplete = !(this.configManager && this.configManager.farmingDir);
    this.recoveryError = null;
    this.taskHistory = (this.configManager && this.configManager.getTaskHistory)
      ? [...this.configManager.getTaskHistory()]
      : [];
    this.lastZombieSweepAt = 0;
    this.startHeartbeat();
    this.bindEngineEvents();
    this.bindJsonCliRuntimeEvents();
    this.bindAcpRuntimeEvents();
    if (this.configManager && this.configManager.farmingDir) {
      this.recoveryPromise = this.recoverEngineSessions()
        .then(() => {
          this.recoveryComplete = true;
        })
        .catch((error) => {
          this.recoveryError = error;
          console.warn('Failed to recover engine sessions:', error && (error.message || error));
        });
    }
  }

  bindJsonCliRuntimeEvents() {
    if (!this.jsonCliRuntime || typeof this.jsonCliRuntime.on !== 'function') return;
    this.jsonCliRuntime.on('agent-runtime', ({ agentId, state, error, sessionId }) => {
      const agent = this.agents.get(agentId);
      const runtime = runtimeBindingOf(agent, 'json');
      if (!runtime) return;
      runtime.state = state || '';
      runtime.error = error || '';
      if (sessionId) {
        this.providerSessionService.bindConfirmed(agentId, agent.providerSessionProvider, sessionId);
        this.ensurePersistentAgentSession(agent);
      }
      this.lastActivity.set(agentId, Date.now());
      this.emit('update');
    });
    this.jsonCliRuntime.on('transcript', ({ agentId }) => {
      const agent = this.agents.get(agentId);
      const runtime = runtimeBindingOf(agent, 'json');
      if (!runtime) return;
      runtime.events = this.jsonCliRuntime.getEvents(agentId);
      runtime.transcriptUpdatedAt = new Date().toISOString();
      this.emit('update');
    });
  }

  bindAcpRuntimeEvents() {
    if (!this.acpRuntime || typeof this.acpRuntime.on !== 'function') return;
    this.acpRuntime.on('agent-runtime', ({ agentId, state, error, sessionId, stopReason, supportsSteer, supportsFork, pendingPermission, pendingPermissions, pendingElicitation, pendingElicitations, activeElicitations, updatedAt }) => {
      const agent = this.agents.get(agentId);
      const runtime = runtimeBindingOf(agent, 'acp');
      if (!runtime) return;
      runtime.state = state || '';
      runtime.error = error || '';
      runtime.stopReason = stopReason || '';
      runtime.supportsSteer = supportsSteer === true;
      runtime.supportsFork = supportsFork === true;
      runtime.pendingPermission = pendingPermission || null;
      runtime.pendingPermissions = Array.isArray(pendingPermissions) ? pendingPermissions : [];
      runtime.pendingElicitation = pendingElicitation || null;
      runtime.pendingElicitations = Array.isArray(pendingElicitations) ? pendingElicitations : [];
      runtime.activeElicitations = Array.isArray(activeElicitations) ? activeElicitations : [];
      runtime.sessionUpdatedAt = updatedAt || '';
      if (sessionId) {
        this.providerSessionService.bindConfirmed(agentId, agent.providerSessionProvider, sessionId);
        this.ensurePersistentAgentSession(agent);
      }
      if (state === 'working' || state === 'waiting-for-permission' || state === 'waiting-for-input') this.lastActivity.set(agentId, Date.now());
      this.emit('update');
    });
    this.acpRuntime.on('session', ({ agentId, revision }) => {
      const agent = this.agents.get(agentId);
      const runtime = runtimeBindingOf(agent, 'acp');
      if (!runtime) return;
      runtime.sessionUpdatedAt = new Date().toISOString();
      runtime.sessionRevision = Number.isFinite(Number(revision)) ? Number(revision) : (Number(runtime.sessionRevision) || 0) + 1;
      this.emit('update');
    });
  }

  bindEngineEvents() {
    this.engineBridge.on('session-started', ({
      sessionId,
      status,
      startedAt,
      runtimeEpoch,
      outputSeq,
      stateRevision,
    }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        const disposition = terminalStateUpdateDisposition(agent, runtimeEpoch, outputSeq, stateRevision);
        if (!applyTerminalStateCursor(agent, runtimeEpoch, outputSeq, stateRevision, disposition)) return;
        setPendingTerminalStartSyncCut(agent, runtimeEpoch, outputSeq, stateRevision);

        agent.engineStarted = true;
        agent.engineStatus = status || 'running';
        agent.startedAt = startedAt || Date.now();
        this.observeAgentAttentionState(sessionId);
        this.providerSessionService.observe(sessionId, { force: true });
        this.emit('update');
      });

    this.engineBridge.on('session-output', ({
      sessionId,
      data,
      engineName,
      runtimeEpoch,
      outputSeq,
      stateRevision,
    }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        const disposition = terminalStateUpdateDisposition(agent, runtimeEpoch, outputSeq, stateRevision);
        if (!applyTerminalStateCursor(agent, runtimeEpoch, outputSeq, stateRevision, disposition)) return;
        clearPendingTerminalStartSyncCut(agent);

        this.reviveAgentRuntime(agent);
        agent.output = trimSessionOutput(agent.output + data);
        if (this.codexTerminalStartOutput.has(sessionId)) {
          const startupOutput = `${this.codexTerminalStartOutput.get(sessionId) || ''}${data}`;
          this.codexTerminalStartOutput.set(
            sessionId,
            startupOutput.slice(-CODEX_TERMINAL_START_OUTPUT_LIMIT),
          );
        }
        if (agent.providerSessionProvider === 'codex' && agent.providerSessionTemporary === true) {
          void this.providerSessionService.resolveTemporaryCodex(sessionId);
        }
        const outputAt = Date.now();
        agent.lastEngineOutputAt = outputAt;
        this.lastActivity.set(sessionId, outputAt);

        // Track output events for rate calculation
        const events = this.outputEvents.get(sessionId) || [];
        events.push({ timestamp: outputAt, bytes: Buffer.byteLength(String(data), 'utf8') });
        this.outputEvents.set(sessionId, events);
        this.getAgentUsageRate(sessionId, { now: outputAt });

        this.observeAgentAttentionState(sessionId);
        const sessionSource = this.getEngineSessionSource(engineName);
        const stream = {
          agentId: sessionId,
          data,
          sessionSource,
        };
        if (Number.isFinite(outputSeq)) {
          stream.outputSeq = outputSeq;
        }
        if (Number.isFinite(stateRevision)) {
          stream.stateRevision = stateRevision;
        }
        if (typeof runtimeEpoch === 'string' && runtimeEpoch) {
          stream.runtimeEpoch = runtimeEpoch;
        }
        this.emit('session-stream', stream);
      });

    this.engineBridge.on('session-transition', ({
      sessionId,
      engineName,
      kind,
      data = '',
      runtimeEpoch,
      outputSeq,
      stateRevision,
      cols,
      rows,
    }) => {
      const agent = this.agents.get(sessionId);
      if (!agent) return;
      const disposition = terminalStateUpdateDisposition(agent, runtimeEpoch, outputSeq, stateRevision);
      if (!applyTerminalStateCursor(agent, runtimeEpoch, outputSeq, stateRevision, disposition)) return;
      clearPendingTerminalStartSyncCut(agent);
      this.reviveAgentRuntime(agent);
      if (kind === 'clear') {
        agent.output = '';
        agent.previewText = '';
        agent.previewSnapshot = null;
        this.outputEvents.delete(sessionId);
        this.agentUsageRateCache.delete(sessionId);
      }
      if (Number.isFinite(cols) && cols > 0) agent.previewCols = cols;
      if (Number.isFinite(rows) && rows > 0) agent.previewRows = rows;
      this.lastActivity.set(sessionId, Date.now());
      this.emit('session-stream', {
        agentId: sessionId,
        sessionSource: this.getEngineSessionSource(engineName),
        kind,
        data,
        runtimeEpoch,
        outputSeq,
        stateRevision,
        cols,
        rows,
      });
      this.observeAgentAttentionState(sessionId);
      this.emit('update');
    });

    this.engineBridge.on('session-sync', ({
      sessionId,
      output,
      engineName,
      replaceLive = true,
      runtimeEpoch,
      outputSeq,
      stateRevision,
      textOutput,
      cols,
      rows,
    }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        const hydratesStartedCut = consumesPendingTerminalStartSyncCut(
          agent,
          runtimeEpoch,
          outputSeq,
          stateRevision,
        );
        const disposition = terminalStateUpdateDisposition(agent, runtimeEpoch, outputSeq, stateRevision);
        if (
          !hydratesStartedCut &&
          !applyTerminalStateCursor(agent, runtimeEpoch, outputSeq, stateRevision, disposition)
        ) return;
        clearPendingTerminalStartSyncCut(agent);

        this.reviveAgentRuntime(agent);
        agent.output = trimSessionOutput(typeof textOutput === 'string' ? textOutput : output);
        agent.previewText = agent.output.slice(-2000);
        this.lastActivity.set(sessionId, Date.now());

        if (replaceLive) {
          const sessionSource = this.getEngineSessionSource(engineName);
          const stream = {
            agentId: sessionId,
            data: output,
            sessionSource,
            replace: true,
          };
          if (Number.isFinite(outputSeq)) {
            stream.outputSeq = outputSeq;
          }
          if (Number.isFinite(stateRevision)) {
            stream.stateRevision = stateRevision;
          }
          if (typeof runtimeEpoch === 'string' && runtimeEpoch) {
            stream.runtimeEpoch = runtimeEpoch;
          }
          if (Number.isFinite(cols) && cols > 0) {
            stream.cols = cols;
          }
          if (Number.isFinite(rows) && rows > 0) {
            stream.rows = rows;
          }
          this.emit('session-stream', stream);
        }
        this.observeAgentAttentionState(sessionId);
        this.emit('update');
      });

    this.engineBridge.on('session-preview', ({ sessionId, previewText, cols, rows, previewSnapshot, title, runtimeEpoch }) => {
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;

        const titleChanged = typeof title === 'string'
          ? this.updateAgentSessionTitle(agent, title)
          : false;
        agent.previewText = previewText || '';
        agent.previewSnapshot = previewSnapshot || null;
        if (Number.isFinite(cols) && cols > 0) {
          agent.previewCols = cols;
        }
        if (Number.isFinite(rows) && rows > 0) {
          agent.previewRows = rows;
        }
        const terminalStatus = deriveAgentTerminalStatus(agent, {
          previewText: agent.previewText,
          title: agent.sessionTitle || '',
          terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
        });
        this.emit('session-preview-update', {
          agentId: sessionId,
          previewText: agent.previewText,
          cols: agent.previewCols || 80,
          rows: agent.previewRows || 30,
          previewSnapshot: agent.previewSnapshot,
          codexTerminalProfile: activeCodexTerminalProfile(agent, agent.previewText),
          terminalStatus,
          runtimeObservation: deriveRuntimeObservation({ ...agent, terminalStatus }),
        });
        this.observeAgentAttentionState(sessionId);
        if (titleChanged) {
          this.emit('update');
        }
      });

    this.engineBridge.on('session-title', ({ sessionId, title, runtimeEpoch }) => {
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;

        if (this.updateAgentSessionTitle(agent, title)) {
          this.observeAgentAttentionState(sessionId);
          this.emit('update');
        }
      });

    this.engineBridge.on('session-activity', ({ sessionId, lastActivityAt, runtimeEpoch }) => {
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;
        this.lastActivity.set(sessionId, lastActivityAt || Date.now());
        this.observeAgentAttentionState(sessionId);
        this.emitActivityUpdate(sessionId, lastActivityAt || Date.now());
      });

    this.engineBridge.on('session-busy-state', (payload = {}) => {
        const {
          sessionId,
          terminalBusy,
          cwd,
          lastExitCode,
          shellEvent,
          shellCommand,
          shellLastCommand,
          shellCommandStartedAt,
          shellLastCommandStartedAt,
          shellLastCommandFinishedAt,
          shellLastCommandDurationMs,
          statusMarkerSeen,
          busyMarkerSeen,
          runtimeEpoch,
        } = payload;
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;
        const previousShellCwd = agent.shellCwd || '';

        const previousState = JSON.stringify({
          terminalBusy: agent.terminalBusy,
          shellCwd: agent.shellCwd || '',
          shellLastExitCode: agent.shellLastExitCode ?? null,
          shellLastEvent: agent.shellLastEvent || '',
          shellCommand: agent.shellCommand || '',
          shellLastCommand: agent.shellLastCommand || '',
          shellCommandStartedAt: agent.shellCommandStartedAt ?? null,
          shellLastCommandStartedAt: agent.shellLastCommandStartedAt ?? null,
          shellLastCommandFinishedAt: agent.shellLastCommandFinishedAt ?? null,
          shellLastCommandDurationMs: agent.shellLastCommandDurationMs ?? null,
          shellStatusMarkerSeen: agent.shellStatusMarkerSeen === true,
          shellBusyMarkerSeen: agent.shellBusyMarkerSeen === true,
        });
        if (typeof terminalBusy === 'boolean') {
          agent.terminalBusy = terminalBusy;
        }
        if (typeof cwd === 'string' && cwd) {
          agent.shellCwd = cwd;
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'lastExitCode')) {
          agent.shellLastExitCode = typeof lastExitCode === 'number' ? lastExitCode : null;
        }
        if (shellEvent === 'start' || shellEvent === 'finish') {
          agent.shellLastEvent = shellEvent;
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellCommand')) {
          agent.shellCommand = typeof shellCommand === 'string' ? shellCommand : '';
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellLastCommand')) {
          agent.shellLastCommand = typeof shellLastCommand === 'string' ? shellLastCommand : '';
        } else if (shellEvent === 'finish' && agent.shellCommand) {
          agent.shellLastCommand = agent.shellCommand;
          agent.shellCommand = '';
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellCommandStartedAt')) {
          agent.shellCommandStartedAt = finiteNumberOrNull(shellCommandStartedAt);
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellLastCommandStartedAt')) {
          agent.shellLastCommandStartedAt = finiteNumberOrNull(shellLastCommandStartedAt);
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellLastCommandFinishedAt')) {
          agent.shellLastCommandFinishedAt = finiteNumberOrNull(shellLastCommandFinishedAt);
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellLastCommandDurationMs')) {
          agent.shellLastCommandDurationMs = finiteNumberOrNull(shellLastCommandDurationMs);
        }
        if (statusMarkerSeen === true) {
          agent.shellStatusMarkerSeen = true;
        }
        if (busyMarkerSeen === true) {
          agent.shellBusyMarkerSeen = true;
        }
        const nextState = JSON.stringify({
          terminalBusy: agent.terminalBusy,
          shellCwd: agent.shellCwd || '',
          shellLastExitCode: agent.shellLastExitCode ?? null,
          shellLastEvent: agent.shellLastEvent || '',
          shellCommand: agent.shellCommand || '',
          shellLastCommand: agent.shellLastCommand || '',
          shellCommandStartedAt: agent.shellCommandStartedAt ?? null,
          shellLastCommandStartedAt: agent.shellLastCommandStartedAt ?? null,
          shellLastCommandFinishedAt: agent.shellLastCommandFinishedAt ?? null,
          shellLastCommandDurationMs: agent.shellLastCommandDurationMs ?? null,
          shellStatusMarkerSeen: agent.shellStatusMarkerSeen === true,
          shellBusyMarkerSeen: agent.shellBusyMarkerSeen === true,
        });
        if (previousState === nextState) return;
        if (agent.shellCwd && agent.shellCwd !== previousShellCwd) {
          void this.refreshAgentWorktree(sessionId, agent.shellCwd);
        }
        this.observeAgentAttentionState(sessionId);
        this.emit('agent-update', { agentId: sessionId, patch: terminalMetadataPatch(agent) });
      });

    this.engineBridge.on('session-exited', ({
      sessionId,
      code,
      exitedAt,
      runtimeEpoch,
      stateProofAvailable,
    }) => {
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;
        clearPendingTerminalStartSyncCut(agent);
        if (this.permissionRestartSuppressedAgentIds.has(sessionId)) return;

        if (stateProofAvailable === false) {
          this.providerSessionService.stop(sessionId);
          agent.status = 'dead';
          agent.engineStatus = 'dead';
          agent.terminalBusy = false;
          agent.exitedAt = exitedAt || Date.now();
          const proofError = 'Terminal exited without an authoritative final checkpoint';
          if (!String(agent.output || '').includes(proofError)) {
            agent.output = trimSessionOutput(`${agent.output || ''}\n${proofError}`);
          }
          this.observeAgentAttentionState(sessionId);
          this.providerSessionService.observe(sessionId, { force: true });
          this.emit('update');
          return;
        }

        if (!agent.validated) {
          this.providerSessionService.stop(sessionId);
          this.agents.delete(sessionId);
          this.lastActivity.delete(sessionId);
          this.lastActivityUpdate.delete(sessionId);
          this.outputEvents.delete(sessionId);
          this.agentUsageRateCache.delete(sessionId);
          this.lastResizeByAgent.delete(sessionId);

          if (this.mainAgentId === sessionId) {
            this.mainAgentId = null;
          }

          this.emit('update');
          return;
        }

        this.providerSessionService.stop(sessionId);
        agent.status = sessionId === this.mainAgentId ? 'dead' : 'stopped';
        agent.exitedAt = exitedAt || Date.now();
        agent.output = trimSessionOutput(`${agent.output}\nProcess exited with code ${code}`);
        this.observeAgentAttentionState(sessionId);
        this.providerSessionService.observe(sessionId, { force: true });
        if (sessionId !== this.mainAgentId) {
          this.recordTaskHistory(agent, {
            reason: 'process-exit',
            archivedAt: Date.now(),
          });
        }
        this.emit('update');
      });

    this.engineBridge.on('session-error', ({ sessionId, error, fatal = true, runtimeEpoch }) => {
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;
        if (this.permissionRestartSuppressedAgentIds.has(sessionId)) return;

        if (fatal === false) {
          return;
        }
        if (isSessionNotAvailableError(error) && this.shouldDeferMissingEngineSession(agent)) {
          return;
        }

        this.markAgentSessionDead(sessionId, error);
      });
  }

  async recoverEngineSessions() {
    if (!this.engineBridge || typeof this.engineBridge.recoverSessions !== 'function') {
      return;
    }

    const recovered = await this.engineBridge.recoverSessions();
    const persistedRecords = this.configManager && typeof this.configManager.listAgentSessionRecords === 'function'
      ? this.configManager.listAgentSessionRecords()
      : [];
    const mainPageSessionKeys = new Set(this.getMainPageSessionKeys());
    const persistedByRuntimeAgentId = new Map(persistedRecords
      .filter(record => record && record.runtimeAgentId)
      .map(record => [record.runtimeAgentId, record]));
    const recoveredRuntimeAgentIds = new Set((recovered || [])
      .map(entry => recoveredEngineSessionId(entry, entry?.metadata || {}))
      .filter(Boolean));
    let changed = false;

    for (const entry of recovered || []) {
      const engineMetadata = entry.metadata || {};
      const state = entry.state || {};
      const agentId = recoveredEngineSessionId(entry, engineMetadata);
      const persisted = persistedByRuntimeAgentId.get(agentId);
      const desiredMetadata = persisted || engineMetadata;
      const persistedLifecycleOperation = activeLifecycleOperation(desiredMetadata);
      const hasRecoverableLifecycleOperation = persistedLifecycleOperation
        && ['create', 'delete', 'archive'].includes(persistedLifecycleOperation.type);
      if (
        !hasRecoverableLifecycleOperation
        && !shouldRestoreAgentFromMetadata(desiredMetadata, mainPageSessionKeys)
      ) {
        await this.killRecoveredEngineSession(entry, engineMetadata, agentId);
        continue;
      }
      // The persisted runtime mode is authoritative. A PTY can outlive the
      // server long enough to appear in native-host recovery after the Agent
      // has already switched to ACP. Recovering that stale PTY first would
      // overwrite the persisted record back to `terminal` before
      // recoverAcpSessions() gets a chance to read it.
      if (runtimeKind(persisted) === 'acp') {
        await this.killRecoveredEngineSession(entry, engineMetadata, agentId);
        continue;
      }
      const persistedProvider = String(persisted?.providerSessionProvider || persisted?.provider || '').trim();
      const metadata = persisted ? {
        ...engineMetadata,
        // The native host owns the live PTY/reducer state, but the Farming
        // session record owns stable product identity. Legacy hosts can omit
        // these fields during recovery; projecting that incomplete metadata
        // even briefly makes Chat/Terminal switching disappear until a later
        // provider resolver update happens to repair it.
        source: persisted.source || engineMetadata.source,
        persistentSessionId: persisted.id || persisted.persistentSessionId || engineMetadata.persistentSessionId,
        projectWorkspace: persisted.projectWorkspace || engineMetadata.projectWorkspace,
        provider: persistedProvider || engineMetadata.provider,
        providerSessionProvider: persistedProvider || engineMetadata.providerSessionProvider,
        providerHomeId: persisted.providerHomeId || engineMetadata.providerHomeId,
        providerHomePath: persisted.providerHomePath || engineMetadata.providerHomePath,
        providerSessionId: persisted.providerSessionId || engineMetadata.providerSessionId,
        providerSessionKey: persisted.providerSessionKey || engineMetadata.providerSessionKey,
        providerSessionTemporary: Object.prototype.hasOwnProperty.call(persisted, 'providerSessionTemporary')
          ? persisted.providerSessionTemporary === true
          : engineMetadata.providerSessionTemporary,
        providerSessionSource: persisted.providerSessionSource || engineMetadata.providerSessionSource,
        providerSessionResolvedAt: persisted.providerSessionResolvedAt || engineMetadata.providerSessionResolvedAt,
        providerSessionTitle: persisted.providerSessionTitle || engineMetadata.providerSessionTitle,
        providerSessionWorkspace: persisted.providerSessionWorkspace || engineMetadata.providerSessionWorkspace,
        terminalInputReceived: Object.prototype.hasOwnProperty.call(persisted, 'terminalInputReceived')
          ? persisted.terminalInputReceived === true
          : engineMetadata.terminalInputReceived,
        customTitle: Object.prototype.hasOwnProperty.call(persisted, 'customTitle')
          ? persisted.customTitle
          : engineMetadata.customTitle,
        lifecycleJournal: lifecycleJournal(persisted),
        ...legacyRuntimeMetadata(persisted),
        pinned: persisted.pinned === true,
        projectOrder: finiteOrder(persisted.projectOrder) ?? finiteOrder(engineMetadata.projectOrder),
        pinnedOrder: finiteOrder(persisted.pinnedOrder) ?? finiteOrder(engineMetadata.pinnedOrder),
      } : engineMetadata;
      if (!agentId || this.agents.has(agentId)) continue;

      const agentRecord = this.recoveredAgentRecord(agentId, entry.engineName || metadata.engineName || 'native', metadata, state);
      ensureAgentOrders(agentRecord, Array.from(this.agents.values()));
      agentRecord.lastObservedTurnActive = this.isAgentAttentionTurnActive(agentRecord);
      this.agents.set(agentId, agentRecord);
      const recoveredLifecycleOperation = activeLifecycleOperation(agentRecord);
      if (
        recoveredLifecycleOperation?.type === 'create'
        && ['pending', 'membership-pending'].includes(recoveredLifecycleOperation.state)
      ) {
        try {
          if (recoveredLifecycleOperation.state === 'membership-pending') {
            this.rememberMainPageProviderSession(agentRecord);
          }
          this.transitionPersistentAgentOperation(
            agentRecord,
            recoveredLifecycleOperation.id,
            'succeeded',
            '',
            { visibleOnMainPage: true, archived: false },
          );
        } catch (error) {
          this.markRecoveredAgentLifecycleBlocked(agentRecord, recoveredLifecycleOperation, error);
        }
      } else if (
        recoveredLifecycleOperation?.type === 'delete'
        || recoveredLifecycleOperation?.type === 'archive'
      ) {
        const result = recoveredLifecycleOperation.type === 'delete'
          ? await this.killAgent(agentId, {
              reason: 'delete-recovery',
              skipRecoveryWait: true,
            })
          : await this.archiveAgent(agentId, {
              reason: 'archive-recovery',
              skipRecoveryWait: true,
            });
        if (result?.error) {
          console.warn(
            `Failed to resume Agent ${recoveredLifecycleOperation.type} ${agentId}: ${result.error}`,
          );
        }
        changed = true;
        continue;
      } else if (recoveredLifecycleOperation) {
        this.markRecoveredAgentLifecycleBlocked(agentRecord, recoveredLifecycleOperation);
      } else {
        this.ensurePersistentAgentSession(agentRecord, {
          visibleOnMainPage: true,
          archived: false,
        });
      }
      const recoveredUpdate = this.reconcilePersistedAgentUpdate(agentRecord);
      if (recoveredUpdate?.error) {
        console.warn(`Failed to reconcile Agent update ${agentId}: ${recoveredUpdate.error}`);
      }
      void this.refreshAgentWorktree(agentId);
      this.lastActivity.set(agentId, state.lastActivityAt || metadata.lastActivityAt || Date.now());
      if (agentRecord.wantsMain && !this.mainAgentId) {
        this.mainAgentId = agentId;
      }
      this.rememberMainPageProviderSession(agentRecord);
      this.providerSessionService.activate(agentId);
      changed = true;
    }

    if (await this.reconcileMissingTerminalLifecycleOperations(
      persistedRecords,
      recoveredRuntimeAgentIds,
    )) {
      changed = true;
    }

    if (changed) {
      this.emit('update');
    }

    const runtimeRotations = this.engineBridge && typeof this.engineBridge.consumeRuntimeRotations === 'function'
      ? this.engineBridge.consumeRuntimeRotations()
      : [];
    if (runtimeRotations.length > 0) {
      await this.restoreTerminalSessionsAfterRuntimeRotation(persistedRecords, runtimeRotations);
    }

    await this.recoverAcpSessions();
    if (this.reconcileDetachedPersistedAgentUpdates()) {
      this.emit('update');
    }
  }

  markRecoveredAgentLifecycleBlocked(agent, operation, cause = null) {
    const reason = cause
      ? `Agent ${operation.type} operation ${operation.id} recovery could not be committed: ${cause.message || cause}`
      : `Agent ${operation.type} operation ${operation.id} must be resolved before restart`;
    agent.status = 'error';
    agent.engineStatus = 'lifecycle-blocked';
    const runtime = runtimeBindingOf(agent);
    if (runtime && Object.prototype.hasOwnProperty.call(runtime, 'state')) {
      runtime.state = 'error';
      runtime.error = reason;
    }
  }

  async reconcileMissingTerminalLifecycleOperations(records, recoveredRuntimeAgentIds) {
    let changed = false;
    for (const record of Array.isArray(records) ? records : []) {
      const agentId = String(record?.runtimeAgentId || '').trim();
      const operation = activeLifecycleOperation(record);
      if (
        !agentId
        || recoveredRuntimeAgentIds.has(agentId)
        || runtimeKind(record) !== 'terminal'
        || !operation
        || !['create', 'delete', 'archive'].includes(operation.type)
      ) {
        continue;
      }

      const recoveredAgent = this.recoveredAgentRecord(
        agentId,
        record.engine || 'native',
        { ...record, persistentSessionId: record.id || record.persistentSessionId || '' },
        { status: 'exited' },
      );
      setAgentRecordId(recoveredAgent, record.id || record.persistentSessionId || '');
      try {
        if (operation.type === 'create') {
          this.transitionPersistentAgentOperation(
            recoveredAgent,
            operation.id,
            'failed',
            'Create runtime was not present in the authoritative native-host recovery set',
            createFailurePatch(
              operation,
              operation.request?.previousRuntimeAgentId,
            ),
          );
        } else if (operation.type === 'delete') {
          this.transitionPersistentAgentOperation(
            recoveredAgent,
            operation.id,
            'succeeded',
            '',
            {
              visibleOnMainPage: false,
              archived: true,
              archivedAt: Date.now(),
              runtimeAgentId: '',
            },
          );
          this.removeMainPageProviderSessionsForAgents([recoveredAgent]);
        } else {
          this.transitionPersistentAgentOperation(
            recoveredAgent,
            operation.id,
            'provider-archive-pending',
            '',
            {
              visibleOnMainPage: false,
              archived: true,
              archivedAt: Date.now(),
              runtimeAgentId: '',
            },
          );
          this.removeMainPageProviderSessionsForAgents([recoveredAgent]);
          const providerArchive = await this.archiveCodexProviderSession(recoveredAgent);
          this.transitionPersistentAgentOperation(
            recoveredAgent,
            operation.id,
            providerArchive?.error ? 'blocked' : 'succeeded',
            providerArchive?.error || '',
          );
        }
        changed = true;
      } catch (error) {
        console.warn(
          `Failed to reconcile missing Terminal Agent ${agentId} ${operation.type}:`,
          error && (error.message || error),
        );
      }
    }
    return changed;
  }

  async restoreTerminalSessionsAfterRuntimeRotation(records, rotations) {
    const mainPageOrder = new Map(this.getMainPageSessionKeys().map((key, index) => [key, index]));
    const mainPageSessionKeys = new Set(mainPageOrder.keys());
    const liveProviderSessions = new Set(
      [...this.agents.values()]
        .filter(agent => agent?.providerSessionProvider && agent?.providerSessionId)
        .map(agent => mainPageAgentSessionKey(
          agent.providerSessionProvider,
          agent.providerSessionId,
          agent.providerHomeId || 'default'
        ))
        .filter(Boolean)
    );
    const recordList = Array.isArray(records) ? records : [];
    const recordByRuntimeAgentId = new Map(recordList
      .filter(record => record && typeof record.runtimeAgentId === 'string' && record.runtimeAgentId)
      .map(record => [record.runtimeAgentId, record]));
    const serializedStates = [];
    for (const rotation of Array.isArray(rotations) ? rotations : []) {
      if (!rotation || typeof rotation.serializedTerminalState !== 'string' || !rotation.serializedTerminalState) continue;
      try {
        serializedStates.push(...deserializeTerminalState(rotation.serializedTerminalState));
      } catch (error) {
        console.warn(
          'Ignoring invalid serialized terminal state after native PTY runtime rotation:',
          error && (error.message || error)
        );
      }
    }
    const serializedByRuntimeAgentId = new Map(serializedStates.map(state => [state.id, state]));
    const candidateKeys = new Set();
    const fallbackCandidates = recordList
      .filter(record => {
        if (!record || record.archived === true) return false;
        if (runtimeKind(record) !== 'terminal') return false;
        const provider = String(record.providerSessionProvider || record.provider || '').trim();
        if (!getProviderAdapter(provider)) return false;
        if (!isSafeProviderSessionId(record.providerSessionId)) return false;
        const sessionKey = record.providerSessionKey || mainPageAgentSessionKey(
          provider,
          record.providerSessionId,
          record.providerHomeId || 'default'
        );
        if (!sessionKey || liveProviderSessions.has(sessionKey)) return false;
        if (record.wantsMain === true) return !this.mainAgentId;
        return mainPageOrder.has(sessionKey);
      })
      .sort((left, right) => {
        if (left.wantsMain === true && right.wantsMain !== true) return -1;
        if (right.wantsMain === true && left.wantsMain !== true) return 1;
        const leftProvider = String(left.providerSessionProvider || left.provider || '').trim();
        const rightProvider = String(right.providerSessionProvider || right.provider || '').trim();
        const leftKey = left.providerSessionKey || mainPageAgentSessionKey(
          leftProvider,
          left.providerSessionId,
          left.providerHomeId || 'default'
        );
        const rightKey = right.providerSessionKey || mainPageAgentSessionKey(
          rightProvider,
          right.providerSessionId,
          right.providerHomeId || 'default'
        );
        const orderDelta = (mainPageOrder.get(leftKey) ?? Number.MAX_SAFE_INTEGER) -
          (mainPageOrder.get(rightKey) ?? Number.MAX_SAFE_INTEGER);
        if (orderDelta !== 0) return orderDelta;
        return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
      })
      .filter(record => {
        const provider = String(record.providerSessionProvider || record.provider || '').trim();
        const sessionKey = record.providerSessionKey || mainPageAgentSessionKey(
          provider,
          record.providerSessionId,
          record.providerHomeId || 'default'
        );
        if (candidateKeys.has(sessionKey)) return false;
        candidateKeys.add(sessionKey);
        return true;
      });
    const candidates = serializedByRuntimeAgentId.size > 0
      ? [...serializedByRuntimeAgentId.values()]
        .map(serializedState => ({
          ...(serializedState.metadata || {}),
          ...(recordByRuntimeAgentId.get(serializedState.id) || {}),
          runtimeAgentId: serializedState.id,
          serializedState,
        }))
        .filter(record => {
          if (!record || record.archived === true) return false;
          return runtimeKind(record) === 'terminal';
        })
        .sort((left, right) => {
          if (left.wantsMain === true && right.wantsMain !== true) return -1;
          if (right.wantsMain === true && left.wantsMain !== true) return 1;
          return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
        })
      : fallbackCandidates;
    const desiredCandidates = candidates.filter(record => shouldRestoreAgentFromMetadata(record, mainPageSessionKeys));

    if (desiredCandidates.length > 0) {
      const rotationSummary = (Array.isArray(rotations) ? rotations : []).map(rotation => {
        const { serializedTerminalState, ...rest } = rotation || {};
        return {
          ...rest,
          serializedTerminalStateBytes: typeof serializedTerminalState === 'string'
            ? Buffer.byteLength(serializedTerminalState, 'utf8')
            : 0,
        };
      });
      console.warn(
        `Restoring ${desiredCandidates.length} Terminal session(s) after native PTY runtime rotation`,
        rotationSummary
      );
    }

    let changed = false;
    for (const record of desiredCandidates) {
      if (record.wantsMain === true && this.mainAgentId) continue;
      const provider = String(record.providerSessionProvider || record.provider || '').trim();
      const sessionId = record.providerSessionId;
      const sessionKey = record.providerSessionKey || mainPageAgentSessionKey(
        provider,
        sessionId,
        record.providerHomeId || 'default'
      );
      if (sessionKey && liveProviderSessions.has(sessionKey)) continue;
      if (
        provider === 'codex'
        && record.terminalInputReceived === true
        && (
          record.providerSessionTemporary === true
          || isTemporaryProviderSessionId(sessionId)
        )
      ) {
        console.warn(
          `Refusing to replace Codex Terminal ${record.runtimeAgentId || sessionId} after native PTY runtime rotation without an exact resume id`
        );
        continue;
      }
      const canResumeProvider = Boolean(getProviderAdapter(provider))
        && isSafeProviderSessionId(sessionId);
      const command = canResumeProvider
        ? buildAgentSessionResumeCommand(provider, sessionId, {
            cwd: record.cwd || record.projectWorkspace || '',
            providerHomePath: record.providerHomePath || '',
          })
        : (
            record.forkCommand ||
            record.command ||
            record.serializedState?.processLaunchConfig?.command ||
            ''
          );
      if (!command) continue;

      const options = {
        wantsMain: record.wantsMain === true,
        skipRecoveryWait: true,
        task: record.task || record.providerSessionTitle || '',
        workflowTemplate: record.workflowTemplate || '',
        projectWorkspace: record.projectWorkspace || record.cwd || '',
        source: canResumeProvider
          ? resumedAgentSource(provider, sessionId, record.providerHomeId || 'default')
          : (record.source || 'terminal-revive'),
        providerHomeId: record.providerHomeId || '',
        providerHomePath: record.providerHomePath || '',
        providerSessionTitle: record.providerSessionTitle || '',
        restartedFromAgentId: record.restartedFromAgentId || '',
        restartedFromAgentIds: Array.isArray(record.restartedFromAgentIds)
          ? record.restartedFromAgentIds
          : [],
        projectOrder: finiteOrder(record.projectOrder),
        pinnedOrder: finiteOrder(record.pinnedOrder),
        customTitle: record.customTitle || '',
        pinned: record.pinned === true,
        attentionSeq: finiteNonNegativeInteger(record.attentionSeq),
        readAttentionSeq: finiteNonNegativeInteger(record.readAttentionSeq),
        attentionUpdatedAt: finiteNumberOrNull(record.attentionUpdatedAt),
        readAttentionAt: finiteNumberOrNull(record.readAttentionAt),
        attentionReason: record.attentionReason || '',
        attentionOutputEpoch: record.attentionOutputEpoch || '',
        attentionOutputSeq: finiteNumberOrNull(record.attentionOutputSeq),
        readOutputEpoch: record.readOutputEpoch || '',
        readOutputSeq: finiteNumberOrNull(record.readOutputSeq),
        persistentSessionId: record.id || '',
        runtimeAgentId: record.runtimeAgentId || '',
        reviveTerminalState: record.serializedState || null,
        ...(provider === 'codex'
          ? {
              codexApprovalMode: record.launchPermissionMode || undefined,
              ...preserveCodexSessionProfileOptions(),
            }
          : {}),
        ...(provider === 'claude'
          ? { claudePermissionMode: record.launchPermissionMode || undefined }
          : {}),
      };

      let restartedAgentId = null;
      try {
        restartedAgentId = await this.startAgent(
          command,
          record.cwd || record.projectWorkspace || null,
          null,
          options
        );
      } catch (error) {
        console.warn(
          `Failed to restore Terminal session ${record.runtimeAgentId || sessionId} after native PTY runtime rotation:`,
          error && (error.message || error)
        );
        continue;
      }
      const replacement = restartedAgentId ? this.agents.get(restartedAgentId) : null;
      if (!replacement) {
        console.warn(
          `Failed to restore Terminal session ${record.runtimeAgentId || sessionId} after native PTY runtime rotation`
        );
        continue;
      }

      replacement.pinned = record.pinned === true;
      replacement.projectOrder = finiteOrder(record.projectOrder);
      replacement.pinnedOrder = finiteOrder(record.pinnedOrder);
      replacement.customTitle = record.customTitle || replacement.customTitle || '';
      replacement.terminalInputReceived = record.terminalInputReceived === true;
      replacement.attentionSeq = finiteNonNegativeInteger(record.attentionSeq);
      replacement.readAttentionSeq = finiteNonNegativeInteger(record.readAttentionSeq);
      replacement.attentionUpdatedAt = finiteNumberOrNull(record.attentionUpdatedAt);
      replacement.readAttentionAt = finiteNumberOrNull(record.readAttentionAt);
      replacement.attentionReason = record.attentionReason || '';
      replacement.attentionOutputEpoch = record.attentionOutputEpoch || '';
      replacement.attentionOutputSeq = finiteNumberOrNull(record.attentionOutputSeq);
      replacement.readOutputEpoch = record.readOutputEpoch || '';
      replacement.readOutputSeq = finiteNumberOrNull(record.readOutputSeq);
      replacement.unread = agentAttentionUnread(replacement);
      this.ensurePersistentAgentSession(replacement);
      if (sessionKey) liveProviderSessions.add(sessionKey);
      changed = true;
    }
    if (changed) this.emit('update');
  }

  async recoverAcpSessions() {
    if (!this.acpRuntime || !this.configManager || typeof this.configManager.listAgentSessionRecords !== 'function') return;
    await this.reconcilePersistedAcpLifecycleOperations(
      this.configManager.listAgentSessionRecords(),
    );
    const mainPageOrder = new Map(this.getMainPageSessionKeys().map((key, index) => [key, index]));
    const mainPageSessionKeys = new Set(mainPageOrder.keys());
    const records = this.configManager.listAgentSessionRecords()
      .filter(record => (
        (
          shouldRestoreAgentFromMetadata(record, mainPageSessionKeys)
          || lifecycleOperationBlocksRuntimeStart(record)
        )
        && runtimeKind(record) === 'acp'
      ))
      .sort((left, right) => {
        const leftOrder = mainPageOrder.get(left.providerSessionKey);
        const rightOrder = mainPageOrder.get(right.providerSessionKey);
        return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
      });

    // Materialize every recoverable row before loading any transcript. Large
    // Codex histories can take tens of seconds each; creating rows one by one
    // after every await temporarily leaves later main-page sessions invisible
    // in both Projects and History.
    for (const record of records) {
      const agentId = String(record.runtimeAgentId || '').trim();
      const provider = String(record.providerSessionProvider || record.provider || '').trim();
      const sessionId = String(record.providerSessionId || record.codexAppServerThreadId || '').trim();
      const blockedOperation = lifecycleOperationBlocksRuntimeStart(record);
      if (
        !agentId
        || !providerSupportsRuntime(provider, 'acp')
        || (!sessionId && !blockedOperation)
      ) {
        continue;
      }
      const agent = this.agents.get(agentId);
      if (!agent) {
        const recoveredAgent = this.recoveredAgentRecord(agentId, record.engine || 'native', record, { status: 'running' });
        ensureAgentOrders(recoveredAgent, Array.from(this.agents.values()));
        setAgentRecordId(recoveredAgent, record.id || '');
        recoveredAgent.engineStarted = false;
        if (blockedOperation) {
          recoveredAgent.status = 'error';
          recoveredAgent.engineStatus = 'lifecycle-blocked';
          const runtime = runtimeBindingOf(recoveredAgent, 'acp');
          runtime.state = 'error';
          runtime.error = `Agent ${blockedOperation.type} operation ${blockedOperation.id} must be resolved before restart`;
        } else {
          runtimeBindingOf(recoveredAgent, 'acp').state = 'connecting';
        }
        this.agents.set(agentId, recoveredAgent);
        void this.refreshAgentWorktree(agentId);
        this.lastActivity.set(agentId, Date.now());
      }
    }
    this.emit('update');

    for (const record of records) {
      const agentId = String(record.runtimeAgentId || '').trim();
      const agent = this.agents.get(agentId);
      if (!agent) continue;
      const recoveredUpdate = this.reconcilePersistedAgentUpdate(agent);
      if (recoveredUpdate?.error) {
        console.warn(`Failed to reconcile Agent update ${agentId}: ${recoveredUpdate.error}`);
      }
    }

    for (const record of records) {
      const agentId = String(record.runtimeAgentId || '').trim();
      const provider = String(record.providerSessionProvider || record.provider || '').trim();
      const sessionId = String(record.providerSessionId || record.codexAppServerThreadId || '').trim();
      const agent = this.agents.get(agentId);
      if (!agent || !sessionId || !providerSupportsRuntime(provider, 'acp')) continue;
      if (lifecycleOperationBlocksRuntimeStart(record)) continue;
      try {
        if (
          !record.structuredRuntimeProcess
          && !this.allowUnprovenLegacyAcpRecovery
          && !record.legacyAcpProcessExitAcknowledgedAt
        ) {
          const cleanupError = new Error(
            'Legacy ACP process exit cannot be proven after restart; automatic recovery is blocked',
          );
          cleanupError.code = 'ACP_PROCESS_CLEANUP_UNCERTAIN';
          throw cleanupError;
        }
        if (record.structuredRuntimeProcess) {
          let cleanup;
          try {
            cleanup = await this.stopPersistedAcpProcessGroup(record.structuredRuntimeProcess);
          } catch (cause) {
            const cleanupError = new Error(
              `Persisted ACP process exit proof failed: ${cause.message || cause}`,
              { cause },
            );
            cleanupError.code = 'ACP_PROCESS_CLEANUP_UNCERTAIN';
            throw cleanupError;
          }
          if (cleanup.stopped !== true) {
            const cleanupError = new Error('Persisted ACP process identity could not be safely stopped');
            cleanupError.code = 'ACP_PROCESS_CLEANUP_UNCERTAIN';
            throw cleanupError;
          }
          agent.structuredRuntimeProcess = null;
          this.ensurePersistentAgentSession(agent);
        }
        const executableName = getProviderAdapter(provider).executable;
        const executable = resolveAgentExecutable(executableName) || executableName;
        const approvalMode = agent.launchPermissionMode || (
          provider === 'codex' && this.configManager.getCodexApprovalMode
            ? this.configManager.getCodexApprovalMode()
            : 'approve'
        );
        const recoveryEnv = this.buildAgentEnv(agentId, agent);
        const recoveryMcpServers = this.projectAcpMcpServers(
          Array.isArray(record.acpMcpServers) ? record.acpMcpServers : [],
          recoveryEnv,
        );
        const prepared = await this.acpRuntime.prepareAgent({
          agentId,
          provider,
          executable,
          env: recoveryEnv,
          cwd: agent.cwd,
          sessionId,
          historyMode: 'checkpoint',
          providerHomeId: agent.providerHomeId || record.providerHomeId || 'default',
          approvalMode,
          // Let Codex resolve its selected Home config and existing session
          // state instead of applying today's Farming launch defaults.
          model: 'config',
          reasoningEffort: 'config',
          serviceTier: 'config',
          additionalDirectories: Array.isArray(record.acpAdditionalDirectories) ? record.acpAdditionalDirectories : [],
          mcpServers: recoveryMcpServers,
          onProcessStarted: async processIdentity => {
            agent.structuredRuntimeProcess = {
              kind: 'acp-process-group',
              ...processIdentity,
            };
            this.ensurePersistentAgentSession(agent);
          },
        });
        agent.providerSessionId = prepared.sessionId;
        agent.providerSessionKey = mainPageAgentSessionKey(
          provider,
          prepared.sessionId,
          agent.providerHomeId || record.providerHomeId || 'default'
        );
        let recoveredSessionOptions = {
          additionalDirectories: Array.isArray(record.acpAdditionalDirectories)
            ? record.acpAdditionalDirectories
            : [],
          mcpServers: recoveryMcpServers,
        };
        try {
          recoveredSessionOptions = this.acpRuntime.getSessionRequestOptions(agentId);
        } catch {
          // The live binding already validated these options. Retain the
          // projected copy for custom runtimes that do not expose it.
        }
        this.acpSessionOptionsByKey.set(agent.providerSessionKey, {
          additionalDirectories: [...recoveredSessionOptions.additionalDirectories],
          mcpServers: JSON.parse(JSON.stringify(recoveredSessionOptions.mcpServers)),
        });
        agent.providerSessionTemporary = false;
        agent.providerSessionSource = `acp-${prepared.historyMode}`;
        const runtime = replaceRuntimeBinding(agent, 'acp', runtimeBindingOf(agent, 'acp'));
        runtime.state = 'idle';
        runtime.error = '';
        agent.status = 'running';
        agent.engineStatus = 'running';
        agent.engineStarted = false;
        agent.requiresProcessExitAcknowledgement = false;
        this.ensurePersistentAgentSession(agent);
        this.rememberMainPageProviderSession(agent);
      } catch (error) {
        const runtime = runtimeBindingOf(agent, 'acp');
        runtime.state = 'error';
        runtime.error = `ACP recovery failed: ${error && (error.message || error)}`;
        const cleanupUncertain = error?.code === 'ACP_PROCESS_CLEANUP_UNCERTAIN';
        agent.status = cleanupUncertain ? 'error' : 'stopped';
        agent.engineStatus = cleanupUncertain ? 'cleanup-uncertain' : 'stopped';
        agent.requiresProcessExitAcknowledgement = cleanupUncertain
          && !record.structuredRuntimeProcess
          && !record.legacyAcpProcessExitAcknowledgedAt;
        agent.engineStarted = false;
        agent.exitedAt = Date.now();
        this.ensurePersistentAgentSession(agent);
      }
    }
    this.emit('update');
  }

  async reconcilePersistedAcpLifecycleOperations(records) {
    for (const record of Array.isArray(records) ? records : []) {
      const operation = activeLifecycleOperation(record);
      if (
        runtimeKind(record) !== 'acp'
        || !operation
        || !['create', 'delete', 'archive'].includes(operation.type)
      ) {
        continue;
      }

      const processProofRequired = operation.request?.structuredProcessProofRequired === true
        || Boolean(record.structuredRuntimeProcess);
      if (processProofRequired && !record.legacyAcpProcessExitAcknowledgedAt) {
        try {
          const cleanup = await this.stopPersistedAcpProcessGroup(record.structuredRuntimeProcess);
          if (
            cleanup.stopped !== true
            && !(
              cleanup.missingProof === true
              && operation.request?.structuredProcessStartGated === true
            )
          ) {
            continue;
          }
        } catch (error) {
          console.warn(
            `Could not prove persisted ACP process exit for ${record.runtimeAgentId || operation.id}:`,
            error && (error.message || error),
          );
          continue;
        }
      }

      const agentId = String(
        operation.type === 'create'
          ? operation.request?.agentId || record.runtimeAgentId || ''
          : record.runtimeAgentId || '',
      ).trim();
      if (!agentId) continue;
      const staged = this.recoveredAgentRecord(
        agentId,
        record.engine || 'native',
        { ...record, persistentSessionId: record.id || '' },
        { status: 'exited' },
      );
      setAgentRecordId(staged, record.id || '');
      staged.structuredRuntimeProcess = null;
      try {
        if (operation.type === 'create' && operation.state === 'membership-pending') {
          this.rememberMainPageProviderSession(staged);
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            'succeeded',
            '',
            { archived: false },
          );
        } else if (operation.type === 'create') {
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            'failed',
            'Create ACP process was stopped during restart recovery',
            createFailurePatch(operation, operation.request?.previousRuntimeAgentId),
          );
        } else if (operation.type === 'delete') {
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            'succeeded',
            '',
            {
              visibleOnMainPage: false,
              archived: true,
              archivedAt: Date.now(),
              runtimeAgentId: '',
              structuredRuntimeProcess: null,
            },
          );
          this.removeMainPageProviderSessionsForAgents([staged]);
        } else {
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            'provider-archive-pending',
            '',
            {
              visibleOnMainPage: false,
              archived: true,
              archivedAt: Date.now(),
              runtimeAgentId: '',
              structuredRuntimeProcess: null,
            },
          );
          this.removeMainPageProviderSessionsForAgents([staged]);
          const providerArchive = await this.archiveCodexProviderSession(staged);
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            providerArchive?.error ? 'blocked' : 'succeeded',
            providerArchive?.error || '',
          );
        }
      } catch (error) {
        console.warn(
          `Failed to reconcile ACP Agent ${agentId} ${operation.type}:`,
          error && (error.message || error),
        );
      }
    }
  }

  reconcileDetachedPersistedAgentUpdates() {
    if (!this.configManager || typeof this.configManager.listAgentSessionRecords !== 'function') {
      return false;
    }
    let changed = false;
    for (const record of this.configManager.listAgentSessionRecords()) {
      const operation = activeLifecycleOperation(record);
      const agentId = String(record?.runtimeAgentId || '').trim();
      if (
        operation?.type !== 'update'
        || !agentId
        || this.agents.has(agentId)
      ) {
        continue;
      }

      const staged = this.recoveredAgentRecord(
        agentId,
        record.engine || 'native',
        record,
        { status: 'stopped' },
      );
      setAgentRecordId(staged, record.id || '');
      const request = operation.request || {};
      if (Object.prototype.hasOwnProperty.call(request, 'customTitle')) {
        staged.customTitle = String(request.customTitle || '').trim().slice(0, 80);
      }
      if (Object.prototype.hasOwnProperty.call(request, 'task')) {
        staged.task = String(request.task || '').trim().slice(0, 240);
      }
      if (typeof request.pinned === 'boolean') {
        staged.pinned = request.pinned;
        if (!staged.pinned) staged.pinnedOrder = null;
      }
      if (request.archived === false) {
        staged.archived = false;
        staged.archivedAt = null;
      }
      if (typeof request.readAttentionSeq === 'number') {
        staged.readAttentionSeq = Math.min(
          finiteNonNegativeInteger(staged.attentionSeq),
          Math.max(
            finiteNonNegativeInteger(staged.readAttentionSeq),
            finiteNonNegativeInteger(request.readAttentionSeq),
          ),
        );
        staged.unread = agentAttentionUnread(staged);
      }
      if (
        typeof request.readOutputEpoch === 'string'
        && typeof request.readOutputSeq === 'number'
      ) {
        staged.readOutputEpoch = request.readOutputEpoch;
        staged.readOutputSeq = finiteNonNegativeInteger(request.readOutputSeq);
      }
      transitionLifecycleOperation(staged, operation.id, 'succeeded');
      try {
        this.ensurePersistentAgentSession(staged);
        changed = true;
      } catch (error) {
        console.warn(
          `Failed to reconcile detached Agent update ${operation.id}:`,
          error && (error.message || error),
        );
      }
    }
    return changed;
  }

  async killRecoveredEngineSession(entry, metadata, agentId) {
    if (!this.engineBridge || typeof this.engineBridge.killSession !== 'function') return;
    const engineName = entry.engineName || metadata.engineName || 'native';
    try {
      await this.engineBridge.killSession(engineName, agentId);
    } catch (error) {
      console.warn('Failed to kill unrecovered engine session:', agentId, error && (error.message || error));
    }
  }

  async whenRecovered() {
    await this.recoveryPromise;
    if (this.recoveryError) {
      throw new Error(
        `Agent lifecycle recovery failed: ${this.recoveryError.message || this.recoveryError}`,
        { cause: this.recoveryError },
      );
    }
  }

  recoveredAgentRecord(agentId, engineName, metadata, state) {
    const wantsMain = metadata.wantsMain === true;
    const providerSessionProvider = metadata.providerSessionProvider || metadata.provider || '';
    const providerSessionId = metadata.providerSessionId || metadata.codexAppServerThreadId || '';
    const runtimeBinding = runtimeBindingFor(runtimeKind(metadata), metadata);
    const agentRecordId = metadata.agentRecordId || metadata.persistentSessionId || metadata.id || '';
    return {
      id: agentId,
      command: metadata.forkCommand || metadata.command || '',
      forkCommand: metadata.forkCommand || metadata.command || '',
      cwd: metadata.cwd || '',
      output: typeof state.output === 'string' ? trimSessionOutput(state.output) : '',
      previewText: typeof state.previewText === 'string' ? state.previewText : '',
      previewSnapshot: state.previewSnapshot || null,
      previewCols: state.previewCols || 80,
      previewRows: state.previewRows || 30,
      sessionTitle: state.title || metadata.sessionTitle || '',
      status: state.status === 'exited' ? 'stopped' : 'running',
      engineName,
      wantsMain,
      mainWorkspace: metadata.mainWorkspace || '',
      projectWorkspace: metadata.projectWorkspace || metadata.cwd || '',
      category: metadata.category || 'coding',
      launchPermissionMode: metadata.launchPermissionMode || '',
      parentAgentId: metadata.parentAgentId || '',
      forkRequestId: metadata.forkRequestId || '',
      task: metadata.task || '',
      workflowTemplate: metadata.workflowTemplate || '',
      source: metadata.source || 'recovered',
      providerSessionProvider,
      providerHomeId: metadata.providerHomeId || '',
      providerHomePath: metadata.providerHomePath || '',
      providerSessionId,
      providerSessionKey: metadata.providerSessionKey || (
        providerSessionProvider && providerSessionId
          ? mainPageAgentSessionKey(providerSessionProvider, providerSessionId, metadata.providerHomeId || '')
          : ''
      ),
      providerSessionTemporary: metadata.providerSessionTemporary === true || isTemporaryProviderSessionId(providerSessionId),
      providerSessionSource: metadata.providerSessionSource || '',
      providerSessionResolvedAt: metadata.providerSessionResolvedAt || null,
      providerSessionTitle: metadata.providerSessionTitle || '',
      providerSessionWorkspace: metadata.providerSessionWorkspace || '',
      terminalInputReceived: metadata.terminalInputReceived === true,
      structuredRuntimeProcess: metadata.structuredRuntimeProcess
        && typeof metadata.structuredRuntimeProcess === 'object'
        ? JSON.parse(JSON.stringify(metadata.structuredRuntimeProcess))
        : null,
      legacyAcpProcessExitAcknowledgedAt:
        typeof metadata.legacyAcpProcessExitAcknowledgedAt === 'number'
          ? metadata.legacyAcpProcessExitAcknowledgedAt
          : null,
      requiresProcessExitAcknowledgement:
        requiresLegacyAcpExitAcknowledgement(metadata),
      // Legacy App Server records normalize to ACP at the runtime-binding
      // boundary. Codex thread ids are valid ACP session ids, so the existing
      // conversation remains recoverable without restarting App Server.
      runtimeBinding,
      forkedFromProviderSessionId: metadata.forkedFromProviderSessionId || '',
      restartedFromAgentId: metadata.restartedFromAgentId || '',
      restartedFromAgentIds: Array.isArray(metadata.restartedFromAgentIds)
        ? metadata.restartedFromAgentIds.filter(id => typeof id === 'string' && id)
        : [],
      agentRecordId,
      persistentSessionId: agentRecordId,
      lifecycleJournal: lifecycleJournal(metadata),
      composerCommands: normalizedComposerCommands(metadata.composerCommands),
      customTitle: metadata.customTitle || '',
      terminalBusy: typeof state.terminalBusy === 'boolean' ? state.terminalBusy : null,
      shellCwd: state.shellCwd || metadata.cwd || '',
      shellLastExitCode: typeof state.shellLastExitCode === 'number' ? state.shellLastExitCode : null,
      shellLastEvent: state.shellLastEvent || '',
      shellCommand: typeof state.shellCommand === 'string' ? state.shellCommand : '',
      shellLastCommand: typeof state.shellLastCommand === 'string' ? state.shellLastCommand : '',
      shellCommandStartedAt: finiteNumberOrNull(state.shellCommandStartedAt),
      shellLastCommandStartedAt: finiteNumberOrNull(state.shellLastCommandStartedAt),
      shellLastCommandFinishedAt: finiteNumberOrNull(state.shellLastCommandFinishedAt),
      shellLastCommandDurationMs: finiteNumberOrNull(state.shellLastCommandDurationMs),
      pinned: metadata.pinned === true,
      projectOrder: finiteOrder(metadata.projectOrder),
      pinnedOrder: finiteOrder(metadata.pinnedOrder),
      attentionSeq: finiteNonNegativeInteger(metadata.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(metadata.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(metadata.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(metadata.readAttentionAt),
      attentionReason: metadata.attentionReason || '',
      attentionOutputEpoch: metadata.attentionOutputEpoch || '',
      attentionOutputSeq: finiteNumberOrNull(metadata.attentionOutputSeq),
      readOutputEpoch: metadata.readOutputEpoch || '',
      readOutputSeq: finiteNumberOrNull(metadata.readOutputSeq),
      unread: finiteNonNegativeInteger(metadata.attentionSeq) > finiteNonNegativeInteger(metadata.readAttentionSeq),
      archived: false,
      archivedAt: null,
      canForkNewWorktree: this.canCreateForkWorktree(metadata.projectWorkspace || metadata.cwd || ''),
      validated: true,
      engineStarted: true,
      engineStatus: state.status || 'running',
      startedAt: state.startedAt || metadata.startedAt || Date.now(),
      runtimeEpoch: typeof state.runtimeEpoch === 'string' ? state.runtimeEpoch : '',
      stateRevision: finiteNumberOrNull(state.stateRevision),
      lastEngineOutputAt: Date.now(),
      lastOutputSeq: finiteNumberOrNull(state.outputSeq),
      attentionRequiresNewOutput: true,
      attentionBaselineOutputSeq: finiteNumberOrNull(state.outputSeq),
      attentionBaselineOutputAt: Date.now(),
      attentionTrackingReady: true,
      lastObservedTurnActive: false,
      attentionSuppressUntil: 0,
    };
  }

  reviveAgentRuntime(agent, sessionState = null) {
    if (!agent) return false;
    if (sessionState && !isLiveEngineSessionState(sessionState)) return false;
    if (!['dead', 'stopped', 'pending'].includes(agent.status)) {
      if (sessionState && sessionState.status) {
        agent.engineStatus = sessionState.status;
      }
      return false;
    }

    agent.status = 'running';
    agent.engineStatus = sessionState && sessionState.status ? sessionState.status : 'running';
    agent.exitedAt = null;
    agent.terminalBusy = typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null;
    return true;
  }

  shouldDeferMissingEngineSession(agent) {
    if (!agent || !isRunningAgentRuntimeStatus(agent.status)) return false;
    if (agent.engineStarted === false) return true;
    const startedAt = Number(agent.startedAt);
    return Number.isFinite(startedAt) && Date.now() - startedAt < MISSING_ENGINE_SESSION_STARTUP_GRACE_MS;
  }

  getMainPageSessionKeys() {
    if (this.configManager && typeof this.configManager.getMainPageSessionKeys === 'function') {
      return this.configManager.getMainPageSessionKeys();
    }
    if (this.configManager && typeof this.configManager.getSettings === 'function') {
      const settings = this.configManager.getSettings();
      return Array.isArray(settings.mainPageSessionKeys) ? settings.mainPageSessionKeys : [];
    }
    return [];
  }

  setMainPageSessionKeys(keys) {
    if (this.configManager && typeof this.configManager.setMainPageSessionKeys === 'function') {
      return this.configManager.setMainPageSessionKeys(keys);
    }
    if (this.configManager && typeof this.configManager.updateSettings === 'function') {
      this.configManager.updateSettings({ mainPageSessionKeys: keys });
      return keys;
    }
    return [];
  }

  ensurePersistentAgentSession(agent, patch = {}) {
    if (!agent || !this.configManager || typeof this.configManager.ensureAgentSessionRecord !== 'function') {
      return '';
    }
    this.assertPersistentAgentRuntimeOwner(agent);
    const previousAgentRecordId = agent.agentRecordId || agent.persistentSessionId || '';
    const sessionOptions = agent.providerSessionKey
      ? this.acpSessionOptionsByKey.get(agent.providerSessionKey)
      : null;
    const agentRecordId = this.configManager.ensureAgentSessionRecord(agent, {
      ...(sessionOptions ? {
        acpAdditionalDirectories: [...sessionOptions.additionalDirectories],
        acpMcpServers: JSON.parse(JSON.stringify(sessionOptions.mcpServers)),
      } : {}),
      ...patch,
    });
    if (agentRecordId) {
      setAgentRecordId(agent, agentRecordId);
    }
    if (
      agentRecordId
      && previousAgentRecordId
      && agentRecordId !== previousAgentRecordId
      && agent.providerSessionKey
      && typeof this.configManager.getAgentSessionRecordForProviderSessionKey === 'function'
    ) {
      const record = this.configManager.getAgentSessionRecordForProviderSessionKey(agent.providerSessionKey);
      if (record) {
        agent.projectWorkspace = record.projectWorkspace || agent.projectWorkspace || '';
        agent.task = typeof record.task === 'string' ? record.task : (agent.task || '');
        agent.workflowTemplate = typeof record.workflowTemplate === 'string'
          ? record.workflowTemplate
          : (agent.workflowTemplate || '');
        agent.customTitle = typeof record.customTitle === 'string' ? record.customTitle : '';
        agent.pinned = record.pinned === true;
        agent.projectOrder = finiteOrder(record.projectOrder);
        agent.pinnedOrder = finiteOrder(record.pinnedOrder);
        agent.attentionSeq = finiteNonNegativeInteger(record.attentionSeq);
        agent.readAttentionSeq = finiteNonNegativeInteger(record.readAttentionSeq);
        agent.attentionUpdatedAt = finiteNumberOrNull(record.attentionUpdatedAt);
        agent.readAttentionAt = finiteNumberOrNull(record.readAttentionAt);
        agent.attentionReason = record.attentionReason || '';
        agent.attentionOutputEpoch = record.attentionOutputEpoch || '';
        agent.attentionOutputSeq = finiteNumberOrNull(record.attentionOutputSeq);
        agent.readOutputEpoch = record.readOutputEpoch || '';
        agent.readOutputSeq = finiteNumberOrNull(record.readOutputSeq);
        agent.unread = agentAttentionUnread(agent);
      }
    }
    return agentRecordId;
  }

  assertPersistentAgentRuntimeOwner(agent) {
    if (
      !agent?.providerSessionKey
      || typeof this.configManager?.getAgentSessionRecordForProviderSessionKey !== 'function'
    ) {
      return;
    }
    const canonical = this.configManager.getAgentSessionRecordForProviderSessionKey(
      agent.providerSessionKey,
    );
    const currentOwner = String(canonical?.runtimeAgentId || '').trim();
    const requestedOwner = String(agent.id || '').trim();
    if (!currentOwner || currentOwner === requestedOwner) return;

    const ownerAgent = this.agents.get(currentOwner);
    if (!ownerAgent && !this.recoveryComplete) {
      throw new Error(
        `Agent session ${agent.providerSessionKey} ownership cannot be changed before recovery completes`,
      );
    }
    const ownerIsStopped = !ownerAgent
      || this.verifiedStoppedAgentIds.has(currentOwner)
      || ['dead', 'stopped'].includes(String(ownerAgent.status || ''))
      || ownerAgent.engineStatus === 'exited';
    if (ownerIsStopped) return;

    throw new Error(
      `Agent session ${agent.providerSessionKey} is owned by Runtime ${currentOwner}, not ${requestedOwner}`,
    );
  }

  beginPersistentAgentOperation(agent, type, requestKey, request = {}) {
    const previousJournal = agent.lifecycleJournal
      ? JSON.parse(JSON.stringify(agent.lifecycleJournal))
      : null;
    const result = beginLifecycleOperation(agent, type, requestKey, request);
    if (result.conflict) {
      return {
        error: `Agent operation ${result.conflict.id} (${result.conflict.type}) has not reached a terminal state`,
        conflict: result.conflict,
      };
    }
    if (result.joined && result.operation.state === 'blocked') {
      transitionLifecycleOperation(agent, result.operation.id, 'pending');
    }
    try {
      const persistentSessionId = this.ensurePersistentAgentSession(agent);
      if (
        typeof this.configManager?.ensureAgentSessionRecord === 'function'
        && !persistentSessionId
      ) {
        throw new Error('Agent session store did not return a persistent id');
      }
    } catch (error) {
      if (previousJournal) agent.lifecycleJournal = previousJournal;
      else delete agent.lifecycleJournal;
      return { error: `Failed to persist Agent ${type} intent: ${error.message || error}` };
    }
    return {
      operation: activeLifecycleOperation(agent) || result.operation,
      joined: result.joined,
    };
  }

  transitionPersistentAgentOperation(agent, operationId, state, error = '', patch = {}) {
    const previousJournal = agent.lifecycleJournal
      ? JSON.parse(JSON.stringify(agent.lifecycleJournal))
      : null;
    const operation = transitionLifecycleOperation(agent, operationId, state, error);
    if (!operation) throw new Error(`Agent operation ${operationId} was not found`);
    try {
      const persistentSessionId = this.ensurePersistentAgentSession(agent, patch);
      if (
        typeof this.configManager?.ensureAgentSessionRecord === 'function'
        && !persistentSessionId
      ) {
        throw new Error('Agent session store did not return a persistent id');
      }
    } catch (persistError) {
      if (previousJournal) agent.lifecycleJournal = previousJournal;
      else delete agent.lifecycleJournal;
      throw persistError;
    }
    return operation;
  }

  completePersistentAgentOperation(agent, operationId, result, patch = {}) {
    const staged = {
      ...agent,
      lifecycleJournal: lifecycleJournal(agent),
    };
    const operation = setLifecycleOperationResult(staged, operationId, result);
    if (!operation) throw new Error(`Agent operation ${operationId} was not found`);
    transitionLifecycleOperation(staged, operationId, 'succeeded');
    const persistentSessionId = this.ensurePersistentAgentSession(staged, patch);
    if (
      typeof this.configManager?.ensureAgentSessionRecord === 'function'
      && !persistentSessionId
    ) {
      throw new Error('Agent session store did not return a persistent id');
    }
    agent.lifecycleJournal = staged.lifecycleJournal;
    setAgentRecordId(agent, staged.agentRecordId || staged.persistentSessionId || '');
    return operation;
  }

  beginPersistentAgentUpdate(agent, requestKey, request) {
    const latest = latestLifecycleOperation(agent);
    if (
      latest?.type === 'update'
      && latest.state === 'succeeded'
      && latest.requestKey === requestKey
    ) {
      return { operation: latest, deduplicated: true };
    }
    return this.beginPersistentAgentOperation(agent, 'update', requestKey, request);
  }

  reconcilePersistedAgentUpdate(agent) {
    const operation = activeLifecycleOperation(agent);
    if (operation?.type !== 'update') return null;
    const request = operation.request || {};
    if (Object.prototype.hasOwnProperty.call(request, 'customTitle')) {
      return this.renameAgent(agent.id, request.customTitle);
    }
    if (Object.prototype.hasOwnProperty.call(request, 'task')) {
      return this.setAgentTask(agent.id, request.task);
    }
    return this.updateAgentFlags(agent.id, request);
  }

  async replayPersistentCreateRequest(createRequestId, requestSignature = '') {
    if (!this.configManager || typeof this.configManager.listAgentSessionRecords !== 'function') {
      return null;
    }
    const requestKey = `create-request:${String(createRequestId || '').trim().slice(0, 160)}`;
    if (requestKey === 'create-request:') return null;
    const matches = this.configManager.listAgentSessionRecords()
      .flatMap(record => {
        const entries = lifecycleJournal(record).entries;
        return entries.map((operation, index) => ({ record, entries, operation, index }));
      })
      .filter(item => item.operation.type === 'create' && item.operation.requestKey === requestKey)
      .sort((left, right) => (
        (Number(right.operation.updatedAt) || 0) - (Number(left.operation.updatedAt) || 0)
      ));
    const match = matches[0];
    if (!match) return null;
    if (
      match.operation.request?.signature
      && match.operation.request.signature !== requestSignature
    ) {
      return {
        error: `Create request ${createRequestId} was already used for different Agent parameters`,
      };
    }

    const agentId = String(
      match.operation.request?.agentId
      || match.record.runtimeAgentId
      || '',
    ).trim();
    const inFlight = agentId ? this.agentLifecycleOperations.get(agentId) : null;
    if (inFlight && !TERMINAL_OPERATION_STATES.has(match.operation.state)) {
      await inFlight.promise.catch(() => {});
      return this.replayPersistentCreateRequest(createRequestId, requestSignature);
    }

    const removedLater = match.entries.slice(match.index + 1).some(operation => (
      ['delete', 'archive'].includes(operation.type)
      && operation.state === 'succeeded'
    ));
    if (removedLater) {
      return {
        error: `Create request ${createRequestId} already completed, but its Agent was later removed`,
      };
    }
    if (match.operation.state === 'succeeded') {
      if (agentId && this.agents.has(agentId)) {
        return {
          agentId,
          deduplicated: true,
          createResult: match.operation.result,
        };
      }
      return {
        error: `Create request ${createRequestId} already succeeded, but its Runtime is not available`,
      };
    }
    if (TERMINAL_OPERATION_STATES.has(match.operation.state)) {
      return {
        error: match.operation.error
          || `Create request ${createRequestId} already finished with state ${match.operation.state}`,
      };
    }
    return {
      agentId,
      error: match.operation.error
        || `Create request ${createRequestId} is awaiting lifecycle recovery`,
    };
  }

  recordCreateRequestResult(agentId, createRequestId, result) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    const requestKey = `create-request:${String(createRequestId || '').trim().slice(0, 160)}`;
    const operation = lifecycleJournal(agent).entries.find(candidate => (
      candidate.type === 'create'
      && candidate.requestKey === requestKey
      && candidate.state === 'succeeded'
    ));
    if (!operation) return { error: 'Create operation was not found' };
    const staged = {
      ...agent,
      lifecycleJournal: lifecycleJournal(agent),
    };
    setLifecycleOperationResult(staged, operation.id, result);
    try {
      this.ensurePersistentAgentSession(staged);
    } catch (error) {
      return { error: `Failed to persist Create result: ${error.message || error}` };
    }
    agent.lifecycleJournal = staged.lifecycleJournal;
    setAgentRecordId(agent, staged.agentRecordId || staged.persistentSessionId || '');
    return { agentId, operationId: operation.id, result };
  }

  rememberMainPageProviderSession(agent) {
    if (!agent || agent.wantsMain) return;
    if (!agent.providerSessionProvider || !agent.providerSessionId || agent.providerSessionTemporary === true) return;
    if (!this.configManager) {
      return;
    }
    this.assertPersistentAgentRuntimeOwner(agent);

    const sessionKey = mainPageAgentSessionKey(agent.providerSessionProvider, agent.providerSessionId, agent.providerHomeId || '');
    if (!sessionKey) return;
    const currentKeys = this.getMainPageSessionKeys();
    if (currentKeys[0] === sessionKey) {
      this.ensurePersistentAgentSession(agent, { visibleOnMainPage: true, archived: false });
      return;
    }
    if (typeof this.configManager.rememberAgentSessionRecord === 'function') {
      const persistentSessionId = this.configManager.rememberAgentSessionRecord(agent);
      setAgentRecordId(agent, persistentSessionId);
      return;
    }
    this.setMainPageSessionKeys([
      sessionKey,
      ...currentKeys.filter(key => key !== sessionKey),
    ]);
  }

  updateEngineProviderSessionMetadata(agent) {
    if (!agent || !agent.engineName || agent.engineStarted !== true) return;
    const engine = this.engineBridge.getEngine(agent.engineName);
    if (!engine || typeof engine.updateSessionMetadata !== 'function') return;
    Promise.resolve(engine.updateSessionMetadata(agent.id, {
      providerSessionProvider: agent.providerSessionProvider || '',
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      providerSessionId: agent.providerSessionId || '',
      providerSessionKey: agent.providerSessionKey || '',
      providerSessionTemporary: agent.providerSessionTemporary === true,
      providerSessionSource: agent.providerSessionSource || '',
      providerSessionResolvedAt: agent.providerSessionResolvedAt || null,
      providerSessionTitle: agent.providerSessionTitle || '',
      terminalInputReceived: agent.terminalInputReceived === true,
      ...legacyRuntimeMetadata(agent),
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
      launchPermissionMode: agent.launchPermissionMode || '',
      attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(agent.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(agent.readAttentionAt),
      attentionReason: agent.attentionReason || '',
      attentionOutputEpoch: agent.attentionOutputEpoch || '',
      attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
      readOutputEpoch: agent.readOutputEpoch || '',
      readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      customTitle: agent.customTitle || '',
    })).catch((error) => {
      console.warn('Failed to update provider session metadata:', error && (error.message || error));
    });
  }

  isAgentAttentionTurnActive(agent) {
    if (!agent) return false;
    if (agent.status === 'pending') return true;
    if (agent.status !== 'running') return false;
    const terminalStatus = deriveAgentTerminalStatus(agent);
    return terminalStatus.activity === 'busy';
  }

  observeAgentAttentionState(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    const turnActive = this.isAgentAttentionTurnActive(agent);
    if (agent.attentionTrackingReady !== true) {
      agent.lastObservedTurnActive = turnActive;
      agent.attentionTrackingReady = true;
      return false;
    }

    const wasTurnActive = agent.lastObservedTurnActive === true;
    agent.lastObservedTurnActive = turnActive;

    if (wasTurnActive && !turnActive) {
      if (!hasAgentOutputAfterAttentionBaseline(agent)) {
        return false;
      }
      agent.attentionRequiresNewOutput = false;
      const reason = agent.status === 'stopped' || agent.status === 'dead'
        ? 'process-exit'
        : 'turn-complete';
      this.recordAgentAttentionEvent(agent, reason);
      return true;
    }

    return false;
  }

  recordAgentAttentionEvent(agent, reason = 'turn-complete') {
    if (!agent || this.isMainAgentRecord(agent.id, agent)) return null;
    const now = Date.now();
    const nextSeq = finiteNonNegativeInteger(agent.attentionSeq) + 1;
    agent.attentionSeq = nextSeq;
    agent.attentionUpdatedAt = now;
    agent.attentionReason = reason;
    agent.attentionOutputEpoch = typeof agent.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
    agent.attentionOutputSeq = Number.isFinite(agent.lastOutputSeq) ? agent.lastOutputSeq : null;
    const attentionOutputAlreadyRead = Boolean(
      agent.attentionOutputEpoch
      && agent.attentionOutputEpoch === agent.readOutputEpoch
      && agent.attentionOutputSeq !== null
      && Number.isFinite(agent.readOutputSeq)
      && agent.attentionOutputSeq <= agent.readOutputSeq
    );
    if (agent.attentionAutoReadNext === true || attentionOutputAlreadyRead) {
      agent.attentionAutoReadNext = false;
      agent.readAttentionSeq = nextSeq;
      agent.readAttentionAt = now;
    }
    agent.unread = agentAttentionUnread(agent);
    this.ensurePersistentAgentSession(agent);
    this.updateEngineProviderSessionMetadata(agent);
    this.emit('update');
    return {
      agentId: agent.id,
      attentionSeq: agent.attentionSeq,
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
      unread: agent.unread,
    };
  }

  markAgentReadCursor(agentId, readAttentionSeq, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const attentionSeq = finiteNonNegativeInteger(agent.attentionSeq);
    const requestedSeq = Number.isFinite(readAttentionSeq)
      ? finiteNonNegativeInteger(readAttentionSeq)
      : attentionSeq;
    const nextReadSeq = Math.min(attentionSeq, Math.max(finiteNonNegativeInteger(agent.readAttentionSeq), requestedSeq));
    const changed = finiteNonNegativeInteger(agent.readAttentionSeq) !== nextReadSeq || agent.unread === true;

    agent.readAttentionSeq = nextReadSeq;
    agent.readAttentionAt = Date.now();
    agent.unread = agentAttentionUnread(agent);
    if (changed) {
      this.ensurePersistentAgentSession(agent);
      this.updateEngineProviderSessionMetadata(agent);
      if (options.emitUpdate !== false) this.emit('update');
    }
    return {
      agentId,
      attentionSeq,
      readAttentionSeq: agent.readAttentionSeq,
      unread: agent.unread,
      changed,
    };
  }

  markAgentReadOutputCut(agentId, runtimeEpoch, outputSeq) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const currentRuntimeEpoch = typeof agent.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
    const requestedRuntimeEpoch = typeof runtimeEpoch === 'string' ? runtimeEpoch : '';
    const currentOutputSeq = finiteNumberOrNull(agent.lastOutputSeq);
    if (
      !currentRuntimeEpoch
      || requestedRuntimeEpoch !== currentRuntimeEpoch
      || currentOutputSeq === null
      || !Number.isFinite(outputSeq)
    ) {
      return {
        agentId,
        readOutputEpoch: typeof agent.readOutputEpoch === 'string' ? agent.readOutputEpoch : '',
        readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
        changed: false,
      };
    }

    const requestedOutputSeq = Math.max(0, Math.floor(outputSeq));
    const nextOutputSeq = Math.min(currentOutputSeq, requestedOutputSeq);
    const previousOutputSeq = agent.readOutputEpoch === currentRuntimeEpoch
      ? finiteNumberOrNull(agent.readOutputSeq)
      : null;
    const readOutputSeq = previousOutputSeq === null
      ? nextOutputSeq
      : Math.max(previousOutputSeq, nextOutputSeq);
    const changed = agent.readOutputEpoch !== currentRuntimeEpoch || previousOutputSeq !== readOutputSeq;
    agent.readOutputEpoch = currentRuntimeEpoch;
    agent.readOutputSeq = readOutputSeq;
    return {
      agentId,
      readOutputEpoch: agent.readOutputEpoch,
      readOutputSeq: agent.readOutputSeq,
      changed,
    };
  }

  markAgentUnreadCursor(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    let changed = false;
    if (finiteNonNegativeInteger(agent.attentionSeq) === 0) {
      this.recordAgentAttentionEvent(agent, 'manual-unread');
      changed = true;
    }
    const attentionSeq = finiteNonNegativeInteger(agent.attentionSeq);
    const nextReadAttentionSeq = Math.max(0, attentionSeq - 1);
    changed = changed ||
      finiteNonNegativeInteger(agent.readAttentionSeq) !== nextReadAttentionSeq ||
      agent.unread !== true;
    if (changed) {
      agent.readAttentionSeq = nextReadAttentionSeq;
      agent.readAttentionAt = Date.now();
      agent.unread = agentAttentionUnread(agent);
      this.ensurePersistentAgentSession(agent);
      this.updateEngineProviderSessionMetadata(agent);
      this.emit('update');
    }
    return {
      agentId,
      attentionSeq: agent.attentionSeq,
      readAttentionSeq: agent.readAttentionSeq,
      unread: agent.unread,
      changed,
    };
  }

  async refreshAgentWorktree(agentId, workspaceCandidate = '') {
    const agent = this.agents.get(agentId);
    if (!agent || agent.isMain || agent.wantsMain) return false;
    const candidate = normalizePathValue(
      workspaceCandidate
      || agent.providerSessionWorkspace
      || agent.shellCwd
      || agent.projectWorkspace
      || agent.cwd
    );
    if (!candidate) return false;

    const generation = (this.agentWorktreeResolveGeneration.get(agentId) || 0) + 1;
    this.agentWorktreeResolveGeneration.set(agentId, generation);
    const baseWorkspace = normalizePathValue(agent.projectWorkspace || agent.cwd);
    const [info, baseInfo] = await Promise.all([
      inspectGitWorktree(candidate),
      inspectGitWorktree(baseWorkspace),
    ]);
    if (this.agentWorktreeResolveGeneration.get(agentId) !== generation) return false;

    const current = this.agents.get(agentId);
    if (!current) return false;
    const nextWorktree = info
      && baseInfo
      && info.commonDir === baseInfo.commonDir
      ? info
      : null;
    const previousProjection = JSON.stringify(publicAgentGitWorktree(current));
    current.gitWorktree = nextWorktree;
    const nextProjection = JSON.stringify(publicAgentGitWorktree(current));
    if (previousProjection === nextProjection) return false;
    this.emit('update');
    return true;
  }

  emitActivityUpdate(sessionId, activityAt) {
    const now = Number.isFinite(activityAt) ? activityAt : Date.now();
    const lastEmittedAt = this.lastActivityUpdate.get(sessionId) || 0;
    if (now - lastEmittedAt < ACTIVITY_UPDATE_INTERVAL_MS) {
      return;
    }

    this.lastActivityUpdate.set(sessionId, now);
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    const isMain = this.isMainAgentRecord(sessionId, agent);
    const lastActivity = this.lastActivity.get(sessionId) || now;
    this.emit('agent-activity', {
      agentId: sessionId,
      lastActivity,
      activityLevel: isMain ? 'warm' : this.calculateActivityLevel(lastActivity, now),
      attentionScore: isMain ? 0 : this.calculateAttentionScore(sessionId, now),
      isZombie: isMain ? false : this.isZombie(sessionId, now),
      usageRate: this.getAgentUsageRate(sessionId, { now }),
    });
  }

  updateAgentSessionTitle(agent, title) {
    const sessionTitle = String(title || '').trim().slice(0, 160);
    if ((agent.task || resumedSessionFromSource(agent.source)) && isGenericSessionTitle(agent, sessionTitle)) {
      if (agent.sessionTitle && isGenericSessionTitle(agent, agent.sessionTitle)) {
        agent.sessionTitle = '';
        return true;
      }
      return false;
    }
    if (agent.sessionTitle === sessionTitle) {
      return false;
    }

    agent.sessionTitle = sessionTitle;
    return true;
  }

  getEngineSessionSource(engineName) {
    const engine = this.engineBridge.getEngine(engineName);
    if (engine && typeof engine.getSessionSource === 'function') {
      return engine.getSessionSource();
    }
    return 'buffer';
  }

  resolveAgentShellEnv(shell = '', options = {}) {
    const now = Date.now();
    const cacheKey = String(shell || '').trim() || '__default__';
    const cached = this.agentShellEnvCache.get(cacheKey);
    const hasMaxAgeOverride = Number.isFinite(options.maxAgeMs);
    const maxAgeMs = hasMaxAgeOverride
      ? Math.max(0, options.maxAgeMs)
      : this.agentShellEnvCacheMs;
    if (
      options.force !== true &&
      cached &&
      ((!hasMaxAgeOverride && maxAgeMs === 0) || now - cached.resolvedAt < maxAgeMs)
    ) {
      return cached.env;
    }

    let shellEnv = null;
    try {
      shellEnv = this.agentShellEnvProvider(shell) || null;
    } catch (error) {
      console.warn('Failed to resolve user shell environment for agent:', error && (error.message || error));
    }

    this.agentShellEnvCache.set(cacheKey, {
      initialized: true,
      resolvedAt: now,
      env: shellEnv,
    });
    return shellEnv;
  }

  buildAgentBaseEnv(agent) {
    const command = agent?.forkCommand || agent?.command || '';
    const shell = agent?.category === 'other' && isShellProgram(command)
      ? (resolveAgentExecutable(command) || command)
      : '';
    return buildInteractiveAgentBaseEnv({
      processEnv: process.env,
      shellEnv: this.resolveAgentShellEnv(shell),
    });
  }

  buildAgentEnv(agentId, agent) {
    const env = this.buildAgentBaseEnv(agent);
    if (agent.category === 'coding') {
      // Prompt policy is meaningful only for shell sessions. Never pass a
      // shell presentation toggle into a directly launched coding CLI.
      delete env.FARMING_ANONYMIZE_SHELL_PROMPT;
      delete env.FARMING_SHELL_CONTROLLED_PROMPT;
      delete env.FARMING_PRESERVE_SHELL_PROMPT;
    }
    if (agent.category === 'other' && isShellProgram(agent.forkCommand || agent.command || '')) {
      // Like VS Code, the launched shell's own startup files own its prompt.
      // Never let a different shell's captured prompt leak into this process.
      for (const key of SHELL_PROMPT_ENV_KEYS) delete env[key];
    }
    const pathEntries = [this.cliBinDir, env.PATH || ''].filter(Boolean);

    env.PATH = pathEntries.join(path.delimiter);
    normalizeInteractiveTerminalEnv(env, {
      stripRuntimeShims: process.env.FARMING_STRIP_AGENT_LD_LIBRARY_PATH !== '0',
      stripNodeOptions: process.env.FARMING_STRIP_AGENT_NODE_OPTIONS !== '0',
    });
    env.FARMING_AGENT_ID = agentId;
    env.FARMING_IS_MAIN_AGENT = agent.wantsMain ? '1' : '0';
    env.FARMING_SKILLS_COMMAND = 'farming skills';
    env.FARMING_MAIN_WORKSPACE = agent.mainWorkspace || '';
    env.FARMING_PROJECT_WORKSPACE = effectiveAgentWorkspaceRoot(agent);

    if (agent.parentAgentId) {
      env.FARMING_PARENT_AGENT_ID = agent.parentAgentId;
    }
    if (this.controlUrl) {
      env.FARMING_CONTROL_URL = this.controlUrl;
    }
    if (this.tokenFile) {
      env.FARMING_TOKEN_FILE = this.tokenFile;
    }
    if (this.authDisabled) {
      env.FARMING_DISABLE_AUTH = '1';
    }
    if (this.configManager && this.configManager.farmingDir) {
      env.FARMING_CONFIG_DIR = this.configManager.farmingDir;
    }
    if (agent.mainWorkspace) {
      env.FARMING_SKILLS_FILE = path.join(agent.mainWorkspace, 'FARMING_MAIN_AGENT_SKILLS.md');
    }
    if (agent.providerHomePath) {
      const provider = agent.providerSessionProvider || agentHomeProviderForProgram(agent.forkCommand || agent.command);
      applyProviderHomeEnvironment(
        env,
        provider,
        agent.providerHomePath
      );
    }

    return env;
  }

  projectAcpMcpServers(mcpServers, agentEnv) {
    if (!this.browserMcpEnabled) return Array.isArray(mcpServers) ? mcpServers : [];
    return mergeBrowserMcpServer(mcpServers, {
      cliBinDir: this.cliBinDir,
      agentEnv,
    });
  }

  expandWorkspacePath(workspace) {
    if (typeof workspace !== 'string') return '';
    const value = workspace.trim();
    if (!value) return '';
    if (value === '~') return process.env.HOME || os.homedir();
    if (value.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), value.slice(2));
    return value;
  }

  canCreateForkWorktree(workspace) {
    const sourceWorkspace = this.expandWorkspacePath(workspace);
    if (!sourceWorkspace) return false;
    let current = path.resolve(sourceWorkspace);
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) return true;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }

  resolveMainAgentWorkspace(requestedWorkspace) {
    const expanded = this.expandWorkspacePath(requestedWorkspace);
    const baseWorkspace = expanded || (this.configManager ? this.configManager.getWorkspace() : process.env.HOME);
    const resolvedBase = path.resolve(baseWorkspace);
    const mainWorkspace = path.basename(resolvedBase) === '.farming'
      ? resolvedBase
      : path.join(resolvedBase, '.farming');
    const projectWorkspace = path.basename(resolvedBase) === '.farming'
      ? (expanded ? path.dirname(resolvedBase) : resolvedBase)
      : resolvedBase;

    return {
      workspace: mainWorkspace,
      projectWorkspace,
      selectedWorkspace: resolvedBase,
    };
  }

  findActiveMainAgentStart() {
    const isActive = (agent) => agent && !['dead', 'stopped'].includes(agent.status);
    const currentMain = this.mainAgentId ? this.agents.get(this.mainAgentId) : null;
    if (isActive(currentMain)) {
      return currentMain;
    }

    for (const agent of this.agents.values()) {
      if (agent.wantsMain && isActive(agent)) {
        return agent;
      }
    }

    return null;
  }

  isMainAgentRecord(agentId, agent) {
    if (agentId === this.mainAgentId) {
      return true;
    }

    if (agent.wantsMain !== true || ['dead', 'stopped'].includes(agent.status)) {
      return false;
    }

    const currentMain = this.mainAgentId ? this.agents.get(this.mainAgentId) : null;
    const hasDifferentActiveMain = currentMain
      && currentMain.id !== agentId
      && !['dead', 'stopped'].includes(currentMain.status);
    return !hasDifferentActiveMain;
  }
  
  startHeartbeat() {
    const interval = this.configManager ? this.configManager.getHeartbeatInterval() : 1000;
    console.log('Starting heartbeat with interval:', interval, 'ms');
    
    this.heartbeatInterval = setInterval(async () => {
      if (this.disposed) return;
      const now = Date.now();
      if (now - this.lastZombieSweepAt >= ZOMBIE_SWEEP_INTERVAL_MS) {
        this.lastZombieSweepAt = now;
        await this.cleanupZombieAgents();
      }

      if (this.mainAgentId) {
        const mainAgent = this.agents.get(this.mainAgentId);
        if (mainAgent && mainAgent.status === 'dead') {
          this.emit('update');
        }
      }
      
      try {
        const systemStats = await this.systemMonitor.getSystemStats();
        this.emit('system-stats', systemStats);
      } catch (error) {
        console.error('Failed to get system stats:', error);
      }
    }, interval);
  }

  dispose(options = {}) {
    if (this.disposed) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;

    this.disposing = true;
    const disposePromise = this.performDispose(options);
    this.disposePromise = disposePromise;
    void disposePromise.finally(() => {
      if (this.disposePromise === disposePromise) this.disposePromise = null;
      if (!this.disposed && !this.disposeFrozen) this.disposing = false;
    }).catch(() => {});
    return disposePromise;
  }

  async performDispose(options = {}) {
    await this.recoveryPromise;
    await this.drainAcceptedAgentOperations();

    const jsonBindingIds = new Set(this.jsonCliRuntime?.bindings?.keys?.() || []);
    const acpBindingIds = new Set(this.acpRuntime?.bindings?.keys?.() || []);
    const runtimeCleanupFailures = [];
    let jsonCleanupFailed = false;
    let acpCleanupFailed = false;
    if (this.jsonCliRuntime && typeof this.jsonCliRuntime.dispose === 'function') {
      try {
        await this.jsonCliRuntime.dispose();
      } catch (error) {
        jsonCleanupFailed = true;
        runtimeCleanupFailures.push(error);
      }
    }
    if (this.acpRuntime && typeof this.acpRuntime.dispose === 'function') {
      try {
        await this.acpRuntime.dispose();
      } catch (error) {
        acpCleanupFailed = true;
        runtimeCleanupFailures.push(error);
      }
    }

    let agentStateChanged = false;
    const forgetStoppedStructuredAgents = (agentIds, runtime, kind) => {
      for (const agentId of agentIds) {
        if (runtime?.bindings?.has?.(agentId)) continue;
        const agent = this.agents.get(agentId);
        if (!agent || runtimeKind(agent) !== kind) continue;
        this.forgetStoppedAgentRecord(agentId, { emitUpdate: false });
        agentStateChanged = true;
      }
    };
    forgetStoppedStructuredAgents(jsonBindingIds, this.jsonCliRuntime, 'json');
    forgetStoppedStructuredAgents(acpBindingIds, this.acpRuntime, 'acp');
    const markUncertainStructuredAgents = (agentIds, runtime, kind, failed) => {
      if (!failed) return;
      for (const agentId of agentIds) {
        if (!runtime?.bindings?.has?.(agentId)) continue;
        if (runtimeKind(this.agents.get(agentId)) !== kind) continue;
        this.markStructuredAgentCleanupUncertain(
          agentId,
          kind,
          `${kind.toUpperCase()} runtime cleanup could not prove process exit`,
          { emitUpdate: false },
        );
        agentStateChanged = true;
      }
    };
    markUncertainStructuredAgents(jsonBindingIds, this.jsonCliRuntime, 'json', jsonCleanupFailed);
    markUncertainStructuredAgents(acpBindingIds, this.acpRuntime, 'acp', acpCleanupFailed);
    if (agentStateChanged) this.emit('update');

    if (runtimeCleanupFailures.length > 0) {
      this.jsonCliRuntime?.resumeAfterDisposeAbort?.();
      this.acpRuntime?.resumeAfterDisposeAbort?.();
      throw new AggregateError(runtimeCleanupFailures, 'Agent runtime cleanup could not be verified');
    }

    this.disposeFrozen = true;
    if (this.engineBridge && typeof this.engineBridge.dispose === 'function') {
      await this.engineBridge.dispose({
        preserveHost: options.preserveTerminalHost === true,
      });
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.providerSessionService.dispose();
    this.agentWorktreeResolveGeneration.clear();
    this.agentLifecycleOperations.clear();
    this.agentStartAdmissions.clear();
    this.activeInputOperations.clear();
    this.verifiedStoppedAgentIds.clear();
    this.permissionRestartSuppressedAgentIds.clear();
    this.pendingResizeByAgent.clear();
    this.resizeDrains.clear();
    this.inputQueues.clear();
    this.codexTerminalProfileQueues.clear();
    this.codexTerminalStartQueues.clear();
    this.codexTerminalStartOutput.clear();
    this.acpSessionOptionsByKey.clear();
    this.disposed = true;
  }

  async drainAcceptedAgentOperations() {
    while (true) {
      const pending = new Set();
      for (const entry of new Set(this.agentLifecycleOperations.values())) {
        if (entry?.promise) pending.add(entry.promise);
      }
      for (const entry of this.agentStartAdmissions.values()) {
        if (entry?.promise) pending.add(entry.promise);
      }
      for (const operation of this.activeInputOperations) pending.add(operation);
      for (const operation of this.resizeDrains.values()) pending.add(operation);
      if (pending.size === 0) return;
      await Promise.allSettled([...pending]);
    }
  }

  async cleanupZombieAgents() {
    const now = Date.now();
    const zombieIds = [];
    for (const [agentId] of this.agents) {
      if (this.isZombie(agentId, now)) {
        zombieIds.push(agentId);
      }
    }
    for (const zombieId of zombieIds) {
      await this.killAgent(zombieId, { reason: 'zombie-cleanup' });
    }
  }

  engineSessionMetadata(agent) {
    return {
      agentId: agent.id,
      command: agent.command,
      forkCommand: agent.forkCommand,
      cwd: agent.cwd,
      projectWorkspace: agent.projectWorkspace || '',
      gitWorktree: publicAgentGitWorktree(agent),
      mainWorkspace: agent.mainWorkspace || '',
      wantsMain: agent.wantsMain === true,
      category: agent.category,
      launchPermissionMode: agent.launchPermissionMode,
      parentAgentId: agent.parentAgentId || '',
      forkRequestId: agent.forkRequestId || '',
      task: agent.task,
      workflowTemplate: agent.workflowTemplate,
      source: agent.source,
      providerSessionProvider: agent.providerSessionProvider,
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      providerSessionId: agent.providerSessionId,
      providerSessionKey: agent.providerSessionKey,
      providerSessionTemporary: agent.providerSessionTemporary,
      providerSessionSource: agent.providerSessionSource,
      providerSessionResolvedAt: agent.providerSessionResolvedAt,
      providerSessionTitle: agent.providerSessionTitle,
      providerSessionWorkspace: agent.providerSessionWorkspace || '',
      terminalInputReceived: agent.terminalInputReceived === true,
      ...legacyRuntimeMetadata(agent),
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId,
      restartedFromAgentId: agent.restartedFromAgentId,
      restartedFromAgentIds: agent.restartedFromAgentIds,
      persistentSessionId: agent.persistentSessionId,
      customTitle: agent.customTitle,
      pinned: agent.pinned,
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      startedAt: agent.startedAt,
      attentionSeq: agent.attentionSeq,
      readAttentionSeq: agent.readAttentionSeq,
      attentionUpdatedAt: agent.attentionUpdatedAt,
      readAttentionAt: agent.readAttentionAt,
      attentionReason: agent.attentionReason,
      attentionOutputEpoch: agent.attentionOutputEpoch,
      attentionOutputSeq: agent.attentionOutputSeq,
      readOutputEpoch: agent.readOutputEpoch,
      readOutputSeq: agent.readOutputSeq,
    };
  }

  async createAgentEngineSession(agent, engine, launch) {
    await engine.createSession({
      agentId: agent.id,
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: this.buildAgentEnv(agent.id, agent),
      category: launch.category,
      metadata: this.engineSessionMetadata(agent),
      reviveState: launch.reviveState || null,
    });
  }

  async stopUncertainTerminalSession(engine, agentId) {
    if (typeof engine?.killSession !== 'function' || typeof engine?.getSessionState !== 'function') {
      throw new Error('Session engine cannot prove an uncertain Terminal start has stopped');
    }
    await withBoundedWait(
      Promise.resolve(engine.killSession(agentId)),
      UNCERTAIN_TERMINAL_STOP_TIMEOUT_MS,
      'Terminal kill request',
    );
    const deadline = Date.now() + UNCERTAIN_TERMINAL_STOP_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const state = await withBoundedWait(
        Promise.resolve(engine.getSessionState(agentId)),
        TERMINAL_STOP_STATE_READ_TIMEOUT_MS,
        'Terminal stop-state read',
      );
      if (!state || ['dead', 'exited', 'stopped'].includes(String(state.status || ''))) return;
      await new Promise(resolve => setTimeout(resolve, TERMINAL_STOP_POLL_MS));
    }
    throw new Error(`Terminal ${agentId} did not reach an exited state after kill`);
  }

  async waitForCodexTerminalStart(agentId) {
    const deadline = Date.now() + CODEX_TERMINAL_START_READY_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const agent = this.agents.get(agentId);
      if (!agent) throw new Error(`Codex Terminal ${agentId} disappeared during startup`);
      if (['dead', 'stopped'].includes(agent.status) || agent.engineStatus === 'exited') {
        const detail = trimSessionOutput(agent.previewText || agent.output || '').trim();
        throw new Error(detail || `Codex Terminal ${agentId} exited during startup`);
      }
      if ((this.codexTerminalStartOutput.get(agentId) || '').includes('\u001b')) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, CODEX_TERMINAL_START_READY_POLL_MS));
    }
    throw new Error(`Codex Terminal ${agentId} did not become ready within ${CODEX_TERMINAL_START_READY_TIMEOUT_MS}ms`);
  }

  async enqueueCodexTerminalStart(providerHomeKey, operation) {
    const key = canonicalProviderHomePath(providerHomeKey || '.');
    const previous = this.codexTerminalStartQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.codexTerminalStartQueues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.codexTerminalStartQueues.get(key) === next) {
        this.codexTerminalStartQueues.delete(key);
      }
    }
  }

  startAgent(command, customWorkspace, callback, options = {}) {
    const lifecycleEntry = options.lifecycleToken
      ? [...new Set(this.agentLifecycleOperations.values())]
          .find(entry => entry.token === options.lifecycleToken)
      : null;
    if (this.disposing && !lifecycleEntry) {
      const error = 'Farming is shutting down; new Agents are not accepted';
      if (callback) callback(null, error);
      return Promise.resolve(null);
    }

    const createRequestId = typeof options.createRequestId === 'string'
      ? options.createRequestId.trim().slice(0, 160)
      : '';
    const createRequestSignature = createOperationSignature(command, customWorkspace, options);
    const existingCreateRequest = createRequestId
      ? this.createRequestAdmissions.get(createRequestId)
      : null;
    if (existingCreateRequest) {
      if (existingCreateRequest.signature !== createRequestSignature) {
        const error = `Create request ${createRequestId} is already in progress with different Agent parameters`;
        if (callback) callback(null, error);
        return Promise.resolve(null);
      }
      return existingCreateRequest.promise.then(outcome => {
        if (callback) {
          callback(
            outcome.agentId || null,
            outcome.error || null,
            {
              ...(outcome.metadata || {}),
              deduplicated: true,
            },
          );
        }
        return outcome.agentId || null;
      });
    }

    let resolveAdmission;
    const token = Symbol('agent-start-admission');
    const promise = new Promise(resolve => {
      resolveAdmission = resolve;
    });
    const requestedProjectWorkspace = options.wantsMain === true
      ? ''
      : (typeof options.projectWorkspace === 'string' && options.projectWorkspace.trim()
        ? options.projectWorkspace
        : customWorkspace);
    const admission = {
      token,
      promise,
      workspaceKey: requestedProjectWorkspace
        ? canonicalWorkspacePath(this.expandWorkspacePath(requestedProjectWorkspace))
        : '',
    };
    this.agentStartAdmissions.set(token, admission);
    let callbackOutcome = null;
    const reportStart = (agentId, error, metadata = {}) => {
      callbackOutcome = {
        agentId: agentId || null,
        error: error || null,
        metadata,
      };
      if (callback) callback(agentId, error, metadata);
    };
    const startPromise = this.startAgentAdmitted(command, customWorkspace, reportStart, {
      ...options,
      startAdmissionToken: token,
    });
    const admittedPromise = Promise.resolve(startPromise).finally(() => {
      if (this.agentStartAdmissions.get(token) === admission) {
        this.agentStartAdmissions.delete(token);
      }
      resolveAdmission();
    });
    if (!createRequestId) return admittedPromise;

    const outcomePromise = admittedPromise.then(agentId => (
      callbackOutcome || {
        agentId: agentId || null,
        error: agentId ? null : 'Failed to start Agent',
      }
    ));
    const requestAdmission = {
      signature: createRequestSignature,
      promise: outcomePromise,
    };
    this.createRequestAdmissions.set(createRequestId, requestAdmission);
    void outcomePromise.finally(() => {
      if (this.createRequestAdmissions.get(createRequestId) === requestAdmission) {
        this.createRequestAdmissions.delete(createRequestId);
      }
    }).catch(() => {});
    return outcomePromise.then(outcome => outcome.agentId || null);
  }

  async startAgentAdmitted(command, customWorkspace, callback, options = {}) {
    const createRequestId = typeof options.createRequestId === 'string'
      ? options.createRequestId.trim().slice(0, 160)
      : '';
    if (options.skipRecoveryWait !== true) {
      try {
        await this.whenRecovered();
      } catch (error) {
        if (callback) callback(null, error.message || String(error));
        return null;
      }
    }
    const createRequestSignature = createOperationSignature(command, customWorkspace, options);
    if (createRequestId) {
      const replay = await this.replayPersistentCreateRequest(
        createRequestId,
        createRequestSignature,
      );
      if (replay) {
        if (callback) {
          callback(
            replay.agentId || null,
            replay.error || null,
            {
              deduplicated: replay.deduplicated === true,
              createResult: replay.createResult || null,
            },
          );
        }
        return replay.agentId || null;
      }
    }

    const wantsMain = options.wantsMain === true || (options.wantsMain !== false && !this.mainAgentId);
    if (!wantsMain) {
      return this.startAgentUnreserved(command, customWorkspace, callback, {
        ...options,
        wantsMain: false,
        skipRecoveryWait: true,
      });
    }

    if (this.mainAgentStartReservation) {
      const outcome = await this.mainAgentStartReservation.promise;
      if (callback) callback(outcome.agentId, outcome.error);
      return outcome.agentId;
    }

    const existingMainStart = this.findActiveMainAgentStart();
    if (existingMainStart) {
      if (this.mainAgentId !== existingMainStart.id) {
        this.mainAgentId = existingMainStart.id;
        this.emit('update');
      }
      console.log('Main Agent already starting or running:', existingMainStart.id);
      if (callback) callback(existingMainStart.id);
      return existingMainStart.id;
    }

    let resolveReservation;
    const reservation = {
      promise: new Promise(resolve => {
        resolveReservation = resolve;
      }),
    };
    this.mainAgentStartReservation = reservation;
    let outcome = null;
    let callbackCalled = false;
    const reservedCallback = (agentId, error) => {
      callbackCalled = true;
      outcome = { agentId: agentId || null, error: error || null };
      if (callback) callback(agentId, error);
    };
    try {
      const agentId = await this.startAgentUnreserved(command, customWorkspace, reservedCallback, {
        ...options,
        wantsMain: true,
        skipRecoveryWait: true,
      });
      if (!callbackCalled) {
        outcome = { agentId: agentId || null, error: null };
        if (callback) callback(agentId);
      }
      return agentId;
    } catch (error) {
      if (!callbackCalled) {
        outcome = { agentId: null, error: error && (error.message || String(error)) };
        if (callback) callback(null, outcome.error);
      }
      throw error;
    } finally {
      resolveReservation(outcome || { agentId: null, error: 'Main Agent failed to start' });
      if (this.mainAgentStartReservation === reservation) {
        this.mainAgentStartReservation = null;
      }
    }
  }

  async startAgentUnreserved(command, customWorkspace, callback, options = {}) {
    if (options.wantsMain !== false && options.skipRecoveryWait !== true) {
      await this.whenRecovered();
    }

    const wantsMain = options.wantsMain === true || (options.wantsMain !== false && !this.mainAgentId);
    if (wantsMain) {
      const existingMainStart = this.findActiveMainAgentStart();
      if (existingMainStart) {
        if (this.mainAgentId !== existingMainStart.id) {
          this.mainAgentId = existingMainStart.id;
          this.emit('update');
        }
        console.log('Main Agent already starting or running:', existingMainStart.id);
        if (callback) callback(existingMainStart.id);
        return existingMainStart.id;
      }
    }

    const dangerouslySkipPermissions = options.dangerouslySkipPermissions === true
      || (
        options.dangerouslySkipPermissions !== false
        && this.configManager
        && this.configManager.getDangerouslySkipAgentPermissionsByDefault()
      );
    const preserveProviderSessionProfile = options.preserveProviderSessionProfile === true
      || codexCommandContinuesSession(command);
    const codexModel = preserveProviderSessionProfile
      ? 'config'
      : (typeof options.codexModel === 'string'
        ? options.codexModel
        : (this.configManager && this.configManager.getCodexModel
          ? this.configManager.getCodexModel()
          : 'gpt-5.5'));
    const codexReasoningEffort = preserveProviderSessionProfile
      ? 'config'
      : (typeof options.codexReasoningEffort === 'string'
        ? options.codexReasoningEffort
        : (this.configManager && this.configManager.getCodexReasoningEffort
          ? this.configManager.getCodexReasoningEffort()
          : 'xhigh'));
    const codexServiceTier = preserveProviderSessionProfile
      ? 'config'
      : (typeof options.codexServiceTier === 'string'
        ? options.codexServiceTier
        : (this.configManager && this.configManager.getCodexServiceTier
          ? this.configManager.getCodexServiceTier()
          : 'default'));
    const launch = resolveLaunchCommand(command, {
      dangerouslySkipPermissions,
      agentLaunchProfiles: this.configManager && this.configManager.getAgentLaunchProfiles
        ? this.configManager.getAgentLaunchProfiles()
        : undefined,
      codexApprovalMode: options.codexApprovalMode || (
        dangerouslySkipPermissions
          ? undefined
          : (this.configManager && this.configManager.getCodexApprovalMode ? this.configManager.getCodexApprovalMode() : 'approve')
      ),
      claudePermissionMode: typeof options.claudePermissionMode === 'string' ? options.claudePermissionMode : undefined,
      codexModelPreset: this.configManager && this.configManager.getCodexModelPreset
        ? this.configManager.getCodexModelPreset()
        : 'gpt-5.5:xhigh',
      codexModel,
      codexReasoningEffort,
      codexServiceTier,
      mainAgentSystemPrompt: wantsMain ? renderMainAgentBootstrap() : '',
    });
    const program = launch.program;
    const resolvedSource = typeof options.source === 'string' ? options.source : 'ui';
    let providerSessionPlan = buildAgentProviderSessionPlan({
      command,
      program,
      args: launch.args,
      source: resolvedSource,
    });

    const hasResumeSource = Boolean(resumedSessionFromSource(resolvedSource));
    const commandProviderSessionPlan = hasResumeSource
      ? buildAgentProviderSessionPlan({
          command,
          program,
          args: launch.args,
          source: 'ui',
        })
      : null;
    const commandContinuesProviderSession = commandProviderSessionPlan
      && commandProviderSessionPlan.temporary !== true
      && commandProviderSessionPlan.provider === providerSessionPlan.provider
      && commandProviderSessionPlan.id === providerSessionPlan.id;
    if (
      providerSessionPlan.source === 'resume-source'
      && hasResumeSource
      && !commandContinuesProviderSession
    ) {
      providerSessionPlan = commandProviderSessionPlan;
    }
    if (providerSessionPlan.error) {
      if (callback) callback(null, providerSessionPlan.error);
      return null;
    }

    let args = providerSessionPlan.args;
    const userShellEnv = this.resolveAgentShellEnv('', { maxAgeMs: AGENT_DISCOVERY_CACHE_MAX_AGE_MS });
    const launchPathEnv = typeof userShellEnv?.PATH === 'string' && userShellEnv.PATH.trim()
      ? userShellEnv.PATH
      : (process.env.PATH || '');
    const resolvedExecutable = resolveAgentExecutable(program, launchPathEnv);
    let spawnProgram = resolvedExecutable || program;
    if (path.basename(program) === 'codex') {
      const codexResolution = resolveCompatibleCodexExecutable(options.requiredCliVersion || '', launchPathEnv);
      if (!codexResolution.compatible) {
        if (callback) callback(null, codexResolution.error || 'Codex CLI is not compatible with this session');
        return null;
      }
      spawnProgram = codexResolution.path || spawnProgram;
    }
    if (
      launch.spec
      && path.basename(program) === program
      && !resolvedExecutable
      && !this.skipExecutablePreflight
      && process.env.FARMING_E2E_FAKE_EXECUTABLES !== '1'
    ) {
      const displayName = launch.spec.name === 'opencode'
        ? 'OpenCode'
        : launch.spec.name.charAt(0).toUpperCase() + launch.spec.name.slice(1);
      if (callback) {
        callback(
          null,
          `${displayName} executable "${program}" was not found in the user shell PATH. Install it or refresh the Agent list, then try again.`
        );
      }
      return null;
    }

    const parentAgentId = typeof options.parentAgentId === 'string' ? options.parentAgentId : '';
    const parentAgent = parentAgentId ? this.agents.get(parentAgentId) : null;
    const defaultWorkspace = wantsMain
      ? (this.configManager ? this.configManager.getWorkspace() : process.env.HOME)
      : ((parentAgent && (parentAgent.projectWorkspace || parentAgent.cwd)) || process.env.PWD || process.cwd() || process.env.HOME);
    let workspace = this.expandWorkspacePath(customWorkspace || defaultWorkspace);
    const explicitProjectWorkspace = !wantsMain && typeof options.projectWorkspace === 'string' && options.projectWorkspace.trim()
      ? this.expandWorkspacePath(options.projectWorkspace)
      : '';
    let projectWorkspace = '';

    if (wantsMain) {
      const resolvedMain = this.resolveMainAgentWorkspace(customWorkspace || '');
      const selectedParent = path.basename(resolvedMain.selectedWorkspace) === '.farming'
        ? path.dirname(resolvedMain.selectedWorkspace)
        : resolvedMain.selectedWorkspace;
      let selectedParentExists = false;
      try {
        selectedParentExists = fs.statSync(selectedParent).isDirectory();
      } catch {
        selectedParentExists = false;
      }
      if (!selectedParentExists) {
        console.log('Workspace does not exist:', selectedParent);
        if (callback) callback(null, `Workspace does not exist: ${selectedParent}`);
        return null;
      }
      workspace = resolvedMain.workspace;
      projectWorkspace = resolvedMain.projectWorkspace;
      fs.mkdirSync(workspace, { recursive: true });
      ensureMainAgentSkillFiles(workspace);
    } else {
      projectWorkspace = workspace;
      if (explicitProjectWorkspace) {
        const resolvedProjectWorkspace = path.resolve(explicitProjectWorkspace);
        const resolvedWorkspace = path.resolve(workspace);
        try {
          if (fs.statSync(resolvedProjectWorkspace).isDirectory() && isSameOrDescendantPath(resolvedProjectWorkspace, resolvedWorkspace)) {
            projectWorkspace = explicitProjectWorkspace;
          }
        } catch {
          projectWorkspace = workspace;
        }
      }
    }

    const projectWorkspaceKey = canonicalWorkspacePath(projectWorkspace);
    const startAdmission = this.agentStartAdmissions.get(options.startAdmissionToken);
    if (startAdmission) startAdmission.workspaceKey = projectWorkspaceKey;
    const deletingProjectWorkspace = projectWorkspaceKey
      ? [...this.projectWorkspaceDeleteAdmissions.keys()]
          .find(candidate => isSameOrDescendantPath(candidate, projectWorkspaceKey))
      : '';
    if (deletingProjectWorkspace) {
      if (callback) callback(null, `Project worktree is being deleted: ${projectWorkspace}`);
      return null;
    }
    
    if (!fs.existsSync(workspace)) {
      console.log('Workspace does not exist:', workspace);
      if (callback) callback(null, `Workspace does not exist: ${workspace}`);
      return null;
    }

    let resolution;
    try {
      resolution = this.engineBridge.resolve(command);
    } catch (error) {
      if (callback) callback(null, error.message);
      return null;
    }
    
    const requestedRuntimeAgentId = typeof options.runtimeAgentId === 'string'
      ? options.runtimeAgentId.trim()
      : '';
    if (requestedRuntimeAgentId && !/^agent-[A-Za-z0-9_-]+$/.test(requestedRuntimeAgentId)) {
      if (callback) callback(null, 'Invalid runtime Agent id');
      return null;
    }
    if (requestedRuntimeAgentId && this.agents.has(requestedRuntimeAgentId)) {
      if (callback) callback(null, `Runtime Agent id is already active: ${requestedRuntimeAgentId}`);
      return null;
    }
    const agentId = requestedRuntimeAgentId ||
      `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const homeProvider = providerSessionPlan.provider || agentHomeProviderForProgram(program);
    const providerHomeId = typeof options.providerHomeId === 'string' && options.providerHomeId.trim()
      ? options.providerHomeId.trim()
      : (providerSessionPlan.providerHomeId || '');
    const providerHome = homeProvider && providerHomeId && this.configManager && this.configManager.getAgentHome
      ? this.configManager.getAgentHome(homeProvider, providerHomeId)
      : null;
    if (
      homeProvider
      && providerHomeId
      && !providerHome
      && !options.providerHomePath
      && this.configManager
      && typeof this.configManager.getAgentHome === 'function'
    ) {
      if (callback) callback(null, `Unknown ${homeProvider} agent home: ${providerHomeId}`);
      return null;
    }
    let providerHomePath = typeof options.providerHomePath === 'string' && options.providerHomePath.trim()
      ? this.expandWorkspacePath(options.providerHomePath)
      : (providerHome ? providerHome.path : '');
    let resolvedProviderHomeId = providerHome ? providerHome.id : (providerHomeId || '');
    if (
      homeProvider === 'codex'
      && !providerHomePath
      && this.configManager
      && typeof this.configManager.getAgentHome === 'function'
    ) {
      const defaultCodexHome = this.configManager.getAgentHome('codex', 'default');
      if (defaultCodexHome) {
        providerHomePath = defaultCodexHome.path;
        resolvedProviderHomeId = defaultCodexHome.id || 'default';
      }
    }
    const requestedAgentRuntimeMode = ['json', 'acp', 'chat'].includes(options.agentRuntimeMode)
      ? options.agentRuntimeMode
      : 'terminal';
    if (
      requestedAgentRuntimeMode === 'json'
      && options.allowLegacyJsonRuntime !== true
    ) {
      if (callback) {
        callback(
          null,
          'JSON CLI Chat is a legacy compatibility reader and cannot create a new Agent. Use Chat (ACP) or Terminal.',
        );
      }
      return null;
    }
    // A fresh structured runtime does not need a provider CLI resume id yet:
    // ACP/JSON creates the provider session and writes the resulting id back
    // after connecting. Fresh Terminal sessions are handled separately below.
    const structuredRuntimeProvider = ['json', 'acp', 'chat'].includes(requestedAgentRuntimeMode)
      ? homeProvider
      : providerSessionPlan.provider;
    // `chat` is the only browser-facing structured-runtime request. Treat the
    // retired Codex ACP launch request as that intent too, so an old client
    // cannot create a second Codex Chat implementation.
    const requestedChatRuntime = isChatMode(requestedAgentRuntimeMode)
      || (requestedAgentRuntimeMode === 'acp' && homeProvider === 'codex');
    const resolvedChatRuntime = requestedChatRuntime
      ? chatRuntimeForProvider(homeProvider)
      : (requestedAgentRuntimeMode === 'acp' ? 'acp' : '');
    const useJsonCli = requestedAgentRuntimeMode === 'json'
      && providerSupportsRuntime(structuredRuntimeProvider, 'json')
      && process.env.FARMING_E2E_FAKE_EXECUTABLES !== '1';
    const useAcp = resolvedChatRuntime === 'acp'
      && providerSupportsRuntime(structuredRuntimeProvider, 'acp')
      && (
        process.env.FARMING_E2E_FAKE_EXECUTABLES !== '1'
        || process.env.FARMING_E2E_FAKE_ACP_AGENT === '1'
      );
    const acpGeneratedFreshSession = useAcp
      && isFreshAcpSessionSource(structuredRuntimeProvider, providerSessionPlan.source);
    const agentRecord = {
      id: agentId,
      command: launch.program,
      forkCommand: String(command || '').trim() || launch.program,
      cwd: workspace,
      output: '',
      previewText: '',
      previewSnapshot: null,
      previewCols: 80,
      previewRows: 30,
      sessionTitle: '',
      status: 'pending',
      engineName: resolution.engineName,
      wantsMain,
      mainWorkspace: wantsMain ? workspace : '',
      projectWorkspace,
      category: resolution.spec ? resolution.spec.category : 'other',
      launchPermissionMode: launch.permissionMode || '',
      parentAgentId,
      forkRequestId: typeof options.forkRequestId === 'string' ? options.forkRequestId : '',
      task: typeof options.task === 'string' ? options.task : '',
      workflowTemplate: typeof options.workflowTemplate === 'string' ? options.workflowTemplate : '',
      source: typeof options.source === 'string' ? options.source : 'ui',
      providerSessionProvider: useAcp || useJsonCli ? structuredRuntimeProvider : (providerSessionPlan.provider || ''),
      providerHomeId: resolvedProviderHomeId,
      providerHomePath,
      providerSessionId: acpGeneratedFreshSession ? '' : (providerSessionPlan.id || ''),
      providerSessionKey: acpGeneratedFreshSession
        ? ''
        : mainPageAgentSessionKey(
          providerSessionPlan.provider,
          providerSessionPlan.id,
          providerHome ? providerHome.id : providerHomeId,
        ),
      providerSessionTemporary: acpGeneratedFreshSession || providerSessionPlan.temporary === true,
      providerSessionSource: providerSessionPlan.source || '',
      providerSessionResolvedAt: acpGeneratedFreshSession || providerSessionPlan.temporary === true
        ? null
        : Date.now(),
      providerSessionTitle: typeof options.providerSessionTitle === 'string' ? options.providerSessionTitle.trim().slice(0, 160) : '',
      providerSessionWorkspace: '',
      terminalInputReceived: false,
      structuredRuntimeProcess: null,
      runtimeBinding: useAcp
        ? runtimeBindingFor('acp', { state: 'connecting' })
        : (useJsonCli
          ? runtimeBindingFor('json', {
            state: 'idle',
            events: Array.isArray(options.jsonCliEvents) ? options.jsonCliEvents : [],
          })
          : runtimeBindingFor('terminal')),
      forkedFromProviderSessionId: typeof options.forkedFromProviderSessionId === 'string'
        ? options.forkedFromProviderSessionId
        : (providerSessionPlan.forkedFromProviderSessionId || ''),
      restartedFromAgentId: typeof options.restartedFromAgentId === 'string' ? options.restartedFromAgentId : '',
      restartedFromAgentIds: Array.isArray(options.restartedFromAgentIds)
        ? Array.from(new Set(options.restartedFromAgentIds.filter(id => typeof id === 'string' && id)))
        : [],
      runtimeSwitchVerifiedSessionId: typeof options.runtimeSwitchVerifiedSessionId === 'string'
        ? options.runtimeSwitchVerifiedSessionId
        : '',
      agentRecordId: typeof options.agentRecordId === 'string'
        ? options.agentRecordId
        : (typeof options.persistentSessionId === 'string' ? options.persistentSessionId : ''),
      persistentSessionId: typeof options.agentRecordId === 'string'
        ? options.agentRecordId
        : (typeof options.persistentSessionId === 'string' ? options.persistentSessionId : ''),
      customTitle: typeof options.customTitle === 'string' ? options.customTitle.trim().slice(0, 80) : '',
      terminalBusy: null,
      shellCwd: '',
      shellLastExitCode: null,
      shellLastEvent: '',
      shellCommand: '',
      shellLastCommand: '',
      shellCommandStartedAt: null,
      shellLastCommandStartedAt: null,
      shellLastCommandFinishedAt: null,
      shellLastCommandDurationMs: null,
      pinned: options.pinned === true,
      projectOrder: finiteOrder(options.projectOrder),
      pinnedOrder: finiteOrder(options.pinnedOrder),
      attentionSeq: finiteNonNegativeInteger(options.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(options.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(options.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(options.readAttentionAt),
      attentionReason: typeof options.attentionReason === 'string' ? options.attentionReason : '',
      attentionOutputEpoch: typeof options.attentionOutputEpoch === 'string' ? options.attentionOutputEpoch : '',
      attentionOutputSeq: finiteNumberOrNull(options.attentionOutputSeq),
      readOutputEpoch: typeof options.readOutputEpoch === 'string' ? options.readOutputEpoch : '',
      readOutputSeq: finiteNumberOrNull(options.readOutputSeq),
      unread: finiteNonNegativeInteger(options.attentionSeq) > finiteNonNegativeInteger(options.readAttentionSeq),
      archived: false,
      archivedAt: null,
      canForkNewWorktree: this.canCreateForkWorktree(projectWorkspace || workspace),
      validated: true,
      engineStarted: false,
      startedAt: Date.now(),
      lastOutputSeq: null,
      attentionAutoReadNext: options.autoReadInitialAttention === true,
      attentionTrackingReady: false,
      lastObservedTurnActive: false,
      attentionSuppressUntil: 0
    };

    let previousPersistentRuntimeAgentId = '';
    let previousPersistentRecord = null;
    if (
      agentRecord.providerSessionKey
      && typeof this.configManager?.getAgentSessionRecordForProviderSessionKey === 'function'
    ) {
      const existingRecord = this.configManager.getAgentSessionRecordForProviderSessionKey(
        agentRecord.providerSessionKey,
      );
      if (existingRecord) {
        previousPersistentRecord = existingRecord;
        agentRecord.lifecycleJournal = lifecycleJournal(existingRecord);
        previousPersistentRuntimeAgentId = String(existingRecord.runtimeAgentId || '').trim();
      }
    }

    let finishStartLifecycle = () => {};
    if (
      options.lifecycleToken
      && !this.adoptAgentLifecycleOperation(agentId, options.lifecycleToken)
    ) {
      if (callback) callback(null, 'Agent lifecycle operation is no longer active');
      return null;
    }
    if (!options.lifecycleToken) {
      finishStartLifecycle = this.beginAgentStartLifecycleOperation(agentId, options.startAdmissionToken);
      if (!finishStartLifecycle) {
        if (callback) callback(null, 'Agent lifecycle operation already in progress');
        return null;
      }
    }

    const createAdmission = this.beginPersistentAgentOperation(
      agentRecord,
      'create',
      options.createRequestId
        ? `create-request:${String(options.createRequestId).trim().slice(0, 160)}`
        : `create:${agentId}`,
      {
        agentId,
        previousRuntimeAgentId: (
          typeof options.restoreRuntimeAgentIdOnFailure === 'string'
          && options.restoreRuntimeAgentIdOnFailure
        )
          ? options.restoreRuntimeAgentIdOnFailure
          : previousPersistentRuntimeAgentId,
        previousState: createRollbackState(previousPersistentRecord),
        signature: createOperationSignature(command, customWorkspace, options),
        command: agentRecord.command,
        cwd: agentRecord.cwd,
        runtimeKind: runtimeKind(agentRecord),
        structuredProcessProofRequired: useAcp,
        structuredProcessStartGated: useAcp && process.platform !== 'win32',
      },
    );
    if (createAdmission.error) {
      finishStartLifecycle();
      if (callback) callback(null, createAdmission.error);
      return null;
    }
    const createOperationId = createAdmission.operation.id;
    const rollbackCreatePatch = () => createFailurePatch(
      createAdmission.operation,
      options.restoreRuntimeAgentIdOnFailure,
    );
    const restoreCreateSessionOptions = () => {
      const previousState = createAdmission.operation.request?.previousState;
      const sessionKey = previousPersistentRecord?.providerSessionKey
        || agentRecord.providerSessionKey;
      if (!sessionKey) return;
      if (
        previousState
        && Array.isArray(previousState.acpAdditionalDirectories)
        && Array.isArray(previousState.acpMcpServers)
      ) {
        this.acpSessionOptionsByKey.set(sessionKey, {
          additionalDirectories: [...previousState.acpAdditionalDirectories],
          mcpServers: JSON.parse(JSON.stringify(previousState.acpMcpServers)),
        });
      } else {
        this.acpSessionOptionsByKey.delete(sessionKey);
      }
    };

    let precreatedProviderSession = null;
    if (
      providerSessionPlan.precreate === true
      && !useAcp
      && !useJsonCli
    ) {
      const adapter = getProviderAdapter(providerSessionPlan.provider);
      if (typeof adapter?.terminalResumeArgs !== 'function') {
        const message = `${providerSessionPlan.provider} cannot resume a pre-created Terminal session`;
        try {
          this.transitionPersistentAgentOperation(
            agentRecord,
            createOperationId,
            'failed',
            message,
            rollbackCreatePatch(),
          );
          restoreCreateSessionOptions();
        } catch (persistError) {
          console.error('Failed to persist Create failure:', persistError);
        }
        finishStartLifecycle();
        if (callback) callback(null, message);
        return null;
      }
      try {
        const requestedIdentityWorkspace = this.expandWorkspacePath(providerSessionPlan.identityWorkspace || '');
        const identityWorkspace = requestedIdentityWorkspace
          ? (path.isAbsolute(requestedIdentityWorkspace)
            ? path.resolve(requestedIdentityWorkspace)
            : path.resolve(workspace, requestedIdentityWorkspace))
          : workspace;
        let identityWorkspaceExists = false;
        try {
          identityWorkspaceExists = fs.statSync(identityWorkspace).isDirectory();
        } catch {
          identityWorkspaceExists = false;
        }
        if (!identityWorkspaceExists) {
          throw new Error(`Workspace does not exist: ${identityWorkspace}`);
        }
        const identityEnv = this.buildAgentEnv(agentId, agentRecord);
        const requestedAdditionalDirectories = Array.isArray(options.additionalDirectories)
          ? options.additionalDirectories
          : [];
        const requestedMcpServers = this.projectAcpMcpServers(
          Array.isArray(options.mcpServers) ? options.mcpServers : [],
          identityEnv,
        );
        const created = await this.createProviderSessionIdentity({
          provider: providerSessionPlan.provider,
          executable: spawnProgram,
          env: identityEnv,
          cwd: identityWorkspace,
          providerHomeId: agentRecord.providerHomeId || 'default',
          approvalMode: agentRecord.launchPermissionMode || 'approve',
          model: codexModel,
          reasoningEffort: codexReasoningEffort,
          serviceTier: codexServiceTier,
          additionalDirectories: requestedAdditionalDirectories,
          mcpServers: requestedMcpServers,
        });
        const providerSessionId = String(created?.sessionId || '').trim();
        if (!isSafeProviderSessionId(providerSessionId)) {
          throw new Error(`${providerSessionPlan.provider} ACP session/new returned an invalid session id`);
        }
        const normalizedSessionOptions = created?.sessionRequestOptions || {
          additionalDirectories: requestedAdditionalDirectories.map(directory => path.resolve(identityWorkspace, directory)),
          mcpServers: JSON.parse(JSON.stringify(requestedMcpServers)),
        };
        args = adapter.terminalResumeArgs(args, providerSessionId, providerSessionPlan);
        providerSessionPlan = {
          ...providerSessionPlan,
          id: providerSessionId,
          precreate: false,
          temporary: false,
          source: 'acp-precreated',
          args,
        };
        agentRecord.providerSessionId = providerSessionId;
        agentRecord.providerSessionKey = mainPageAgentSessionKey(
          providerSessionPlan.provider,
          providerSessionId,
          agentRecord.providerHomeId || 'default'
        );
        agentRecord.providerSessionTemporary = false;
        agentRecord.providerSessionSource = providerSessionPlan.source;
        agentRecord.providerSessionResolvedAt = Date.now();
        this.acpSessionOptionsByKey.set(agentRecord.providerSessionKey, {
          additionalDirectories: Array.isArray(normalizedSessionOptions.additionalDirectories)
            ? [...normalizedSessionOptions.additionalDirectories]
            : [],
          mcpServers: Array.isArray(normalizedSessionOptions.mcpServers)
            ? JSON.parse(JSON.stringify(normalizedSessionOptions.mcpServers))
            : [],
        });
        precreatedProviderSession = {
          provider: providerSessionPlan.provider,
          executable: spawnProgram,
          env: identityEnv,
          cwd: identityWorkspace,
          sessionId: providerSessionId,
          sessionKey: agentRecord.providerSessionKey,
        };
      } catch (error) {
        let identityRollbackError = null;
        let identityRetainedReason = '';
        const orphanedIdentity = error?.providerSessionIdentity;
        if (
          orphanedIdentity
          && orphanedIdentity.producerStopped === true
          && isSafeProviderSessionId(orphanedIdentity.sessionId)
        ) {
          try {
            await this.deleteProviderSessionIdentity(orphanedIdentity);
          } catch (cleanupError) {
            identityRollbackError = cleanupError;
          }
        } else if (orphanedIdentity && !isSafeProviderSessionId(orphanedIdentity.sessionId)) {
          identityRetainedReason = 'provider returned an unsafe session id; it was retained without invoking CLI rollback';
        } else if (orphanedIdentity) {
          identityRetainedReason = 'provider session retained because ACP producer shutdown could not be proven';
        }
        const baseMessage = error && error.message
          ? error.message
          : `Failed to create ${providerSessionPlan.provider} session identity`;
        let message = baseMessage;
        if (identityRollbackError) {
          message = `${baseMessage}; provider session rollback failed: ${identityRollbackError.message || identityRollbackError}`;
        } else if (identityRetainedReason) {
          message = `${baseMessage}; ${identityRetainedReason}`;
        }
        console.error('Failed to create provider session identity:', error);
        try {
          this.transitionPersistentAgentOperation(
            agentRecord,
            createOperationId,
            identityRetainedReason || identityRollbackError ? 'blocked' : 'failed',
            message,
            identityRetainedReason || identityRollbackError
              ? { visibleOnMainPage: true, archived: false }
              : rollbackCreatePatch(),
          );
          if (!(identityRetainedReason || identityRollbackError)) {
            restoreCreateSessionOptions();
          }
        } catch (persistError) {
          message = `${message}; failed to persist Create failure: ${persistError.message || persistError}`;
        }
        finishStartLifecycle();
        if (callback) callback(null, message);
        return null;
      }
    }

    const logArgs = args.map((arg, index) => (
      index > 0 && args[index - 1] === '--append-system-prompt'
        ? '<farming-main-agent-bootstrap>'
        : arg
    ));
    console.log('Starting agent:', program, logArgs, 'workspace:', workspace, spawnProgram !== program ? `resolved: ${spawnProgram}` : '');

    let structuredRuntimeRegistered = false;

    try {
      ensureAgentOrders(agentRecord, Array.from(this.agents.values()));
      this.agents.set(agentId, agentRecord);
      void this.refreshAgentWorktree(agentId);
      this.lastActivity.set(agentId, Date.now());
      this.emit('update');

      if (useJsonCli) {
        const jsonRuntime = runtimeBindingOf(agentRecord, 'json');
        this.jsonCliRuntime.registerAgent({
          agentId,
          provider: structuredRuntimeProvider,
          executable: spawnProgram,
          env: this.buildAgentEnv(agentId, agentRecord),
          cwd: workspace,
          sessionId: agentRecord.providerSessionTemporary ? '' : agentRecord.providerSessionId,
          approvalMode: agentRecord.launchPermissionMode || 'approve',
          autoApprove: options.dangerouslySkipPermissions === true,
          initialEvents: jsonRuntime.events,
        });
        structuredRuntimeRegistered = true;
      }

      if (useAcp) {
        const acpRuntime = runtimeBindingOf(agentRecord, 'acp');
        const sessionOptionsKey = agentRecord.providerSessionId && !agentRecord.providerSessionTemporary
          ? mainPageAgentSessionKey(
              structuredRuntimeProvider,
              agentRecord.providerSessionId,
              agentRecord.providerHomeId || 'default'
            )
          : '';
        const rememberedSessionOptions = sessionOptionsKey
          ? this.acpSessionOptionsByKey.get(sessionOptionsKey) || {}
          : {};
        const additionalDirectories = Array.isArray(options.additionalDirectories)
          ? options.additionalDirectories
          : rememberedSessionOptions.additionalDirectories || [];
        const requestedMcpServers = Array.isArray(options.mcpServers)
          ? options.mcpServers
          : rememberedSessionOptions.mcpServers || [];
        const acpEnv = this.buildAgentEnv(agentId, agentRecord);
        const mcpServers = this.projectAcpMcpServers(requestedMcpServers, acpEnv);
        const prepared = await this.acpRuntime.prepareAgent({
          agentId,
          provider: structuredRuntimeProvider,
          executable: spawnProgram,
          env: acpEnv,
          cwd: workspace,
          sessionId: options.acpStartFresh === true || agentRecord.providerSessionTemporary || acpGeneratedFreshSession
            ? ''
            : agentRecord.providerSessionId,
          historyMode: options.acpHistoryMode === 'resume'
            ? 'resume'
            : (options.acpHistoryMode === 'load' ? 'load' : 'checkpoint'),
          providerHomeId: agentRecord.providerHomeId || 'default',
          approvalMode: agentRecord.launchPermissionMode || 'approve',
          model: codexModel,
          reasoningEffort: codexReasoningEffort,
          serviceTier: codexServiceTier,
          additionalDirectories,
          mcpServers,
          forkSourceSessionId: options.acpForkSourceSessionId || '',
          forkSourceCheckpoint: options.acpForkSourceCheckpoint || null,
          onForkSessionCreated: async sessionId => {
            const exactSessionId = String(sessionId || '').trim();
            if (!isSafeProviderSessionId(exactSessionId)) {
              throw new Error('ACP fork startup returned an unsafe provider session id');
            }
            agentRecord.providerSessionId = exactSessionId;
            agentRecord.providerSessionKey = mainPageAgentSessionKey(
              structuredRuntimeProvider,
              exactSessionId,
              agentRecord.providerHomeId || 'default'
            );
            agentRecord.providerSessionTemporary = false;
            agentRecord.providerSessionSource = 'acp-fork';
            agentRecord.providerSessionResolvedAt = Date.now();
            let normalizedSessionOptions = { additionalDirectories, mcpServers };
            try {
              normalizedSessionOptions = this.acpRuntime.getSessionRequestOptions(agentId);
            } catch {
              // The live binding already validated the scope. Retain the caller
              // copy only for custom runtimes that do not expose it.
            }
            this.acpSessionOptionsByKey.set(agentRecord.providerSessionKey, {
              additionalDirectories: [...normalizedSessionOptions.additionalDirectories],
              mcpServers: JSON.parse(JSON.stringify(normalizedSessionOptions.mcpServers)),
            });
            if (typeof options.onAcpForkSessionCreated === 'function') {
              await options.onAcpForkSessionCreated(exactSessionId);
            }
            this.ensurePersistentAgentSession(agentRecord);
          },
          onProcessStarted: async processIdentity => {
            agentRecord.structuredRuntimeProcess = {
              kind: 'acp-process-group',
              ...processIdentity,
            };
            this.ensurePersistentAgentSession(agentRecord);
          },
        });
        if (typeof options.onAcpSessionPrepared === 'function') {
          await options.onAcpSessionPrepared(prepared);
        }
        structuredRuntimeRegistered = true;
        agentRecord.providerSessionId = prepared.sessionId;
        agentRecord.providerSessionKey = mainPageAgentSessionKey(
          structuredRuntimeProvider,
          prepared.sessionId,
          agentRecord.providerHomeId || 'default'
        );
        agentRecord.providerSessionTemporary = false;
        agentRecord.providerSessionSource = `acp-${prepared.historyMode}`;
        agentRecord.providerSessionResolvedAt = Date.now();
        let normalizedSessionOptions = { additionalDirectories, mcpServers };
        try {
          normalizedSessionOptions = this.acpRuntime.getSessionRequestOptions(agentId);
        } catch {
          // prepareAgent already validated the request; retain the caller copy
          // only for custom runtimes that do not expose the normalized scope.
        }
        this.acpSessionOptionsByKey.set(agentRecord.providerSessionKey, {
          additionalDirectories: [...normalizedSessionOptions.additionalDirectories],
          mcpServers: JSON.parse(JSON.stringify(normalizedSessionOptions.mcpServers)),
        });
        acpRuntime.state = 'idle';
        acpRuntime.error = '';
      }

      if (!useJsonCli && !useAcp) {
        const serializeCodexStartup = agentRecord.providerSessionProvider === 'codex'
          && resolution.engineName === 'native';
        const startTerminal = async () => {
          const engineLaunch = {
            command: spawnProgram,
            args,
            cwd: workspace,
            category: resolution.spec ? resolution.spec.category : 'shell',
            reviveState: options.reviveTerminalState || null,
          };
          if (serializeCodexStartup) this.codexTerminalStartOutput.set(agentId, '');
          try {
            await this.createAgentEngineSession(agentRecord, resolution.engine, engineLaunch);
            if (serializeCodexStartup) {
              await this.waitForCodexTerminalStart(agentId);
            }
          } finally {
            if (serializeCodexStartup) this.codexTerminalStartOutput.delete(agentId);
          }
        };
        if (serializeCodexStartup) {
          await this.enqueueCodexTerminalStart(
            providerHomePath || resolvedProviderHomeId || 'default',
            startTerminal
          );
        } else {
          await startTerminal();
        }
      }
      this.transitionPersistentAgentOperation(agentRecord, createOperationId, 'membership-pending', '', {
        visibleOnMainPage: true,
        archived: false,
        ...(options.customTitleExplicit === true
          ? { customTitle: agentRecord.customTitle }
          : {}),
      });
      this.rememberMainPageProviderSession(agentRecord);
      this.transitionPersistentAgentOperation(agentRecord, createOperationId, 'succeeded', '', {
        visibleOnMainPage: true,
        archived: false,
      });
      if (
        previousPersistentRuntimeAgentId
        && previousPersistentRuntimeAgentId !== agentId
      ) {
        this.forgetStoppedAgentRecord(previousPersistentRuntimeAgentId, { emitUpdate: false });
      }

      const agent = this.agents.get(agentId);
      if (agent && agent.status === 'pending') {
        agent.status = 'running';

        const currentMainAgent = this.mainAgentId ? this.agents.get(this.mainAgentId) : null;
        const canBecomeMain = !this.mainAgentId || !currentMainAgent || currentMainAgent.status === 'dead';
        if (agent.wantsMain && canBecomeMain) {
          this.mainAgentId = agentId;
        }
      }

      this.providerSessionService.activate(agentId);
      finishStartLifecycle();
      if (callback) callback(agentId);
      this.emit('update');
      return agentId;
    } catch (error) {
      console.error('Failed to start agent:', error);
      let runtimeCleanupError = null;
      if (useJsonCli && structuredRuntimeRegistered) {
        try {
          const stopped = await this.jsonCliRuntime.unregisterAgentAndWait(agentId);
          if (stopped !== true) {
            throw new Error('JSON runtime binding disappeared before exit was verified', { cause: error });
          }
        } catch (cleanupError) {
          runtimeCleanupError = cleanupError;
        }
      } else if (
        useAcp
        && error?.runtimeCleanupVerified !== true
        && (structuredRuntimeRegistered || error?.runtimeCleanupAttempted === true)
      ) {
        try {
          const stopped = await this.acpRuntime.unregisterAgentAndWait(agentId);
          if (stopped !== true) {
            throw error?.adapterCleanupError
              || new Error('ACP runtime binding disappeared before exit was verified', { cause: error });
          }
        } catch (cleanupError) {
          runtimeCleanupError = cleanupError;
        }
      } else if (!useJsonCli && !useAcp) {
        try {
          await this.stopUncertainTerminalSession(resolution.engine, agentId);
        } catch (engineCleanupError) {
          runtimeCleanupError = engineCleanupError;
          console.error(
            'Failed to stop partially started Agent runtime:',
            engineCleanupError && (engineCleanupError.message || engineCleanupError)
          );
        }
      }
      if (runtimeCleanupError) {
        console.error(
          'Failed to stop partially started Agent runtime:',
          runtimeCleanupError.message || runtimeCleanupError
        );
      }
      let rollbackError = null;
      if (precreatedProviderSession && !runtimeCleanupError) {
        try {
          await this.deleteProviderSessionIdentity(precreatedProviderSession);
        } catch (cleanupError) {
          rollbackError = cleanupError;
          console.error(
            'Failed to roll back pre-created provider session:',
            cleanupError && (cleanupError.message || cleanupError)
          );
        }
        this.acpSessionOptionsByKey.delete(precreatedProviderSession.sessionKey);
      } else if (precreatedProviderSession) {
        this.acpSessionOptionsByKey.delete(precreatedProviderSession.sessionKey);
      }
      const startupError = error && (error.message || String(error));
      const cleanupSuffix = rollbackError
        ? `; provider session rollback failed: ${rollbackError.message || rollbackError}`
        : '';
      const runtimeCleanupSuffix = runtimeCleanupError
        ? `; runtime cleanup could not be verified and Agent ${agentId} was retained for retry: ${runtimeCleanupError.message || runtimeCleanupError}`
        : '';
      if (runtimeCleanupError) {
        agentRecord.status = 'error';
        agentRecord.engineStatus = 'cleanup-uncertain';
        const runtime = runtimeBindingOf(agentRecord);
        if (runtime && Object.prototype.hasOwnProperty.call(runtime, 'state')) {
          runtime.state = 'error';
          runtime.error = runtimeCleanupError.message || String(runtimeCleanupError);
        }
        try {
          this.transitionPersistentAgentOperation(
            agentRecord,
            createOperationId,
            'blocked',
            runtimeCleanupError.message || String(runtimeCleanupError),
          );
        } catch (persistError) {
          runtimeCleanupError = new Error(
            `${runtimeCleanupError.message || runtimeCleanupError}; failed to persist blocked Create: ${persistError.message || persistError}`,
          );
        }
        finishStartLifecycle();
        this.emit('update');
        if (callback) callback(agentId, `${startupError}${runtimeCleanupSuffix}${cleanupSuffix}`);
        return null;
      }
      try {
        this.transitionPersistentAgentOperation(
          agentRecord,
          createOperationId,
          'failed',
          startupError,
          rollbackCreatePatch(),
        );
        restoreCreateSessionOptions();
      } catch (persistError) {
        agentRecord.status = 'error';
        agentRecord.engineStatus = 'metadata-commit-uncertain';
        const message = `${startupError}; failed to persist Create failure: ${persistError.message || persistError}`;
        finishStartLifecycle();
        this.emit('update');
        if (callback) callback(agentId, message);
        return null;
      }
      this.agents.delete(agentId);
      this.lastActivity.delete(agentId);
      this.lastActivityUpdate.delete(agentId);
      this.outputEvents.delete(agentId);
      this.agentUsageRateCache.delete(agentId);
      this.lastResizeByAgent.delete(agentId);
      this.providerSessionService.stop(agentId);
      if (this.acpRuntime) this.acpRuntime.unregisterAgent(agentId);

      if (this.mainAgentId === agentId) {
        this.mainAgentId = null;
      }

      finishStartLifecycle();
      this.emit('update');
      if (callback) callback(null, `${startupError}${runtimeCleanupSuffix}${cleanupSuffix}`);
      return null;
    }
  }
  
  trackInputOperation(operation) {
    this.activeInputOperations.add(operation);
    void operation.finally(() => {
      this.activeInputOperations.delete(operation);
    }).catch(() => {});
    return operation;
  }

  assertAgentOperationAdmission() {
    if (this.disposing) {
      throw new Error('Farming is shutting down; Agent operations are not accepted');
    }
  }

  async enqueueInputOperation(agentId, operation, options = {}) {
    if (this.disposing && options.admitted !== true) {
      throw new Error('Farming is shutting down; Agent input is not accepted');
    }
    const previous = this.inputQueues.get(agentId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(operation);

    this.inputQueues.set(agentId, next);
    this.trackInputOperation(next);
    try {
      return await next;
    } finally {
      if (this.inputQueues.get(agentId) === next) {
        this.inputQueues.delete(agentId);
      }
    }
  }

  async enqueueInputOperationUntilReleased(agentId, operation) {
    if (this.disposing) {
      throw new Error('Farming is shutting down; Agent input is not accepted');
    }
    const previous = this.inputQueues.get(agentId) || Promise.resolve();
    let released = false;
    let resolveReleased;
    const releasedPromise = new Promise(resolve => {
      resolveReleased = resolve;
    });
    const release = () => {
      if (released) return;
      released = true;
      resolveReleased();
    };

    const ready = previous.catch(() => {});
    const completion = ready.then(() => operation(release));
    this.trackInputOperation(completion);
    completion.catch(() => release());
    const boundary = ready.then(() => releasedPromise);
    this.inputQueues.set(agentId, boundary);
    boundary.then(() => {
      if (this.inputQueues.get(agentId) === boundary) {
        this.inputQueues.delete(agentId);
      }
    });
    return completion;
  }

  async sendInput(agentId, input, options = {}) {
    return this.enqueueInputOperation(agentId, () => this.sendInputNow(agentId, input, options));
  }

  commitComposerCommand(agent, command) {
    const commands = normalizedComposerCommands(agent.composerCommands)
      .filter(candidate => candidate.requestId !== command.requestId);
    commands.push(command);
    const staged = {
      ...agent,
      composerCommands: normalizedComposerCommands(commands),
    };
    const persistentSessionId = this.ensurePersistentAgentSession(staged);
    if (
      typeof this.configManager?.ensureAgentSessionRecord === 'function'
      && !persistentSessionId
    ) {
      throw new Error('Agent session store did not return a persistent id');
    }
    agent.composerCommands = staged.composerCommands;
    setAgentRecordId(agent, staged.agentRecordId || staged.persistentSessionId || '');
    return command;
  }

  setComposerCommandInMemory(agent, command) {
    agent.composerCommands = normalizedComposerCommands([
      ...normalizedComposerCommands(agent.composerCommands)
        .filter(candidate => candidate.requestId !== command.requestId),
      command,
    ]);
  }

  sendPersistentComposerMessage(agentId, message, requestId) {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error('Agent not found'));
    if (runtimeKind(agent) === 'terminal') {
      return Promise.reject(new Error('Persistent Composer admission requires a structured runtime'));
    }
    const prompt = normalizedComposerPrompt(message);
    const contentHash = composerCommandHash(prompt);
    const commands = normalizedComposerCommands(agent.composerCommands);
    const existing = commands.find(command => command.requestId === requestId);
    const admissionKey = `${agentId}:${requestId}`;
    const inFlight = this.composerAdmissions.get(admissionKey);
    if (existing?.contentHash && existing.contentHash !== contentHash) {
      return Promise.reject(new Error(`Composer request ${requestId} was already used for different content`));
    }
    if (existing?.state === 'accepted') {
      return Promise.resolve({ ...(existing.result || {}), accepted: true, deduplicated: true });
    }
    if (inFlight) return inFlight.promise;
    if (existing?.state === 'unknown' || existing?.state === 'intent') {
      const detail = existing.error || `Composer request ${requestId} has an uncertain outcome and will not be replayed automatically`;
      if (existing.state === 'intent') {
        const unknown = { ...existing, state: 'unknown', error: detail, updatedAt: Date.now() };
        try {
          this.commitComposerCommand(agent, unknown);
        } catch {
          this.setComposerCommandInMemory(agent, unknown);
        }
      }
      return Promise.reject(composerAdmissionError(detail, true));
    }
    if (existing?.state === 'failed') {
      return Promise.reject(new Error(existing.error || `Composer request ${requestId} was not accepted`));
    }

    const intent = {
      requestId,
      contentHash,
      state: 'intent',
      result: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      this.commitComposerCommand(agent, intent);
    } catch (error) {
      return Promise.reject(new Error(`Failed to persist Composer intent: ${error.message || error}`));
    }

    let resolveAdmission;
    let rejectAdmission;
    const admissionPromise = new Promise((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    const entry = { contentHash, promise: admissionPromise };
    this.composerAdmissions.set(admissionKey, entry);
    let submitted = false;
    const onSubmitted = (result = { kind: runtimeKind(agent) }) => {
      if (submitted) return;
      submitted = true;
      const accepted = {
        ...intent,
        state: 'accepted',
        result,
        updatedAt: Date.now(),
      };
      try {
        this.commitComposerCommand(agent, accepted);
        resolveAdmission({ ...result, accepted: true });
      } catch (error) {
        const unknown = {
          ...intent,
          state: 'unknown',
          error: `Provider accepted Composer request, but admission could not be saved: ${error.message || error}`,
          updatedAt: Date.now(),
        };
        this.setComposerCommandInMemory(agent, unknown);
        rejectAdmission(composerAdmissionError(unknown.error, true));
      }
    };

    const completion = isAcpAgent(agent)
      ? this.enqueueInputOperationUntilReleased(
          agentId,
          releaseInput => this.sendComposerMessageNow(agentId, prompt, {
            onSubmitted: () => {
              try {
                onSubmitted({ kind: 'acp' });
              } finally {
                releaseInput();
              }
            },
          }),
        )
      : this.enqueueInputOperation(
          agentId,
          () => this.sendComposerMessageNow(agentId, prompt, {
            onSubmitted: result => onSubmitted(result),
          }),
        );
    void Promise.resolve(completion).then(result => {
      if (!submitted) onSubmitted(result);
    }).catch(error => {
      if (submitted) return;
      const failed = {
        ...intent,
        state: 'failed',
        error: error.message || String(error),
        updatedAt: Date.now(),
      };
      let uncertain = false;
      try {
        this.commitComposerCommand(agent, failed);
      } catch (persistError) {
        failed.state = 'unknown';
        failed.error = `${failed.error}; failed to persist rejection: ${persistError.message || persistError}`;
        this.setComposerCommandInMemory(agent, failed);
        uncertain = true;
      }
      rejectAdmission(composerAdmissionError(failed.error, uncertain));
    });
    void admissionPromise.finally(() => {
      if (this.composerAdmissions.get(admissionKey) === entry) {
        this.composerAdmissions.delete(admissionKey);
      }
    }).catch(() => {});
    return admissionPromise;
  }

  async sendComposerMessage(agentId, message, options = {}) {
    const requestId = String(options.requestId || '').trim();
    if (requestId) {
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) throw new Error('Composer requestId is invalid');
      return this.sendPersistentComposerMessage(agentId, message, requestId);
    }
    const agent = this.agents.get(agentId);
    if (agent && isAcpAgent(agent)) {
      return this.enqueueInputOperationUntilReleased(
        agentId,
        releaseInput => this.sendComposerMessageNow(agentId, message, { releaseInput }),
      );
    }
    return this.enqueueInputOperation(agentId, () => this.sendComposerMessageNow(agentId, message));
  }

  async setCodexTerminalProfile(agentId, profile, options = {}) {
    const previous = this.codexTerminalProfileQueues.get(agentId) || Promise.resolve();
    const start = () => this.enqueueInputOperationUntilReleased(
      agentId,
      releaseInput => this.setCodexTerminalProfileNow(agentId, profile, {
        ...options,
        onInputSafe: releaseInput,
      }),
    );
    const next = this.codexTerminalProfileQueues.has(agentId)
      ? previous.catch(() => {}).then(start)
      : start();
    this.codexTerminalProfileQueues.set(agentId, next);
    try {
      return await next;
    } finally {
      if (this.codexTerminalProfileQueues.get(agentId) === next) {
        this.codexTerminalProfileQueues.delete(agentId);
      }
    }
  }

  async setCodexTerminalProfileNow(agentId, profile, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (
      agentProgramName(agent.command).toLowerCase() !== 'codex'
      || isJsonCliAgent(agent)
      || isAcpAgent(agent)
      || runtimeKind(agent) !== 'terminal'
    ) {
      throw new Error('This Agent is not using Codex Terminal');
    }
    if (!isRunningAgentRuntimeStatus(agent.status)) {
      throw new Error('Codex Terminal is not running');
    }
    if (this.isAgentAttentionTurnActive(agent)) {
      throw new Error('Wait for the active Codex Terminal turn to finish before changing its model');
    }

    const applied = await applyCodexTerminalProfile({
      profile,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onInputSafe: options.onInputSafe,
      readPreview: async () => {
        const view = await this.getAgentSessionView(agentId);
        if (!view) throw new Error('Agent not found');
        return view.previewText;
      },
      readOutput: async () => String(await this.getAgentSessionText(agentId) || ''),
      // `/model` and `/fast on|off` are Farming-owned control traffic. They must not
      // make a fresh Terminal look user-authored, because that would remove
      // the safe fresh-session path into ACP Chat before the provider has
      // materialized a resumable history record.
      sendInput: async input => this.sendInputNow(agentId, input, { markUserInput: false }),
    });
    agent.codexTerminalProfile = {
      model: applied.model,
      reasoningEffort: applied.effort,
      serviceTier: applied.serviceTier,
      source: 'terminal-command',
    };

    // The HTTP response confirms the terminal has already reached this profile.
    // Publish that confirmation immediately instead of waiting for a later PTY
    // preview tick; otherwise the browser's bounded optimistic state can expire
    // and briefly fall back to the pre-command footer.
    const view = options.signal?.aborted
      ? null
      : await this.getAgentSessionView(agentId);
    if (view) {
      agent.previewText = view.previewText || agent.previewText || '';
      agent.previewSnapshot = view.previewSnapshot || agent.previewSnapshot || null;
      agent.previewCols = view.previewCols || agent.previewCols || 80;
      agent.previewRows = view.previewRows || agent.previewRows || 30;
      this.emit('session-preview-update', {
        agentId,
        previewText: agent.previewText,
        cols: agent.previewCols,
        rows: agent.previewRows,
        previewSnapshot: agent.previewSnapshot,
        codexTerminalProfile: agent.codexTerminalProfile,
        terminalStatus: view.terminalStatus,
        runtimeObservation: deriveRuntimeObservation({ ...agent, terminalStatus: view.terminalStatus }),
      });
    }
    this.emit('update');
    return applied;
  }

  async sendComposerMessageNow(agentId, message, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const prompt = normalizedComposerPrompt(message);
    const text = prompt
      .filter(content => content?.type === 'text')
      .map(content => String(content.text || ''))
      .join('')
      .trim();

    if (isJsonCliAgent(agent)) {
      const result = await this.jsonCliRuntime.submitComposerMessage(agentId, text, {
        approvalMode: agent.launchPermissionMode || 'approve',
      });
      agent.providerSessionId = result.sessionId || agent.providerSessionId;
      agent.providerSessionTemporary = !agent.providerSessionId;
      this.ensurePersistentAgentSession(agent);
      const submitted = { kind: 'json', sessionId: agent.providerSessionId };
      options.onSubmitted?.(submitted);
      return submitted;
    }

    if (isAcpAgent(agent)) {
      this.requireLiveAcpAgent(agentId);
      const result = await this.acpRuntime.submitMessage(agentId, prompt, {
        onSubmitted: options.onSubmitted || options.releaseInput,
      });
      if (result.steered !== true) {
        const runtime = runtimeBindingOf(agent, 'acp');
        runtime.state = 'idle';
        runtime.stopReason = result.stopReason || '';
      }
      this.ensurePersistentAgentSession(agent);
      return { kind: 'acp', ...result };
    }

    await this.sendInputNow(agentId, [{ type: 'paste', text }, '\r']);
    const submitted = { kind: 'terminal' };
    options.onSubmitted?.(submitted);
    return submitted;
  }

  getJsonCliTranscript(agentId, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (!isJsonCliAgent(agent)) throw new Error('Agent is not using the JSON CLI runtime');
    return this.jsonCliRuntime.getTranscript(agentId, options);
  }

  getAcpSession(agentId, options = {}) {
    this.requireLiveAcpAgent(agentId);
    return this.acpRuntime.getSession(agentId, options);
  }

  getAcpTranscript(agentId, options = {}) {
    this.requireLiveAcpAgent(agentId);
    const transcript = this.acpRuntime.getTranscriptSession(agentId, options);
    return {
      ...transcript,
      entries: transcript.entries.map(entry => entry?.type === 'tool' ? acpTranscriptToolEntry(entry) : entry),
    };
  }

  getAcpToolDetail(agentId, toolCallId) {
    this.requireLiveAcpAgent(agentId);
    const entry = this.acpRuntime.getToolEntry(agentId, toolCallId);
    if (!entry) throw new Error('ACP tool call not found');
    const subagentSessionId = String(entry?._meta?.subagent_session_info?.session_id || '');
    const subagentSession = subagentSessionId
      ? this.acpRuntime.getSubagentTranscriptSession(agentId, subagentSessionId, { maxTurns: 12 })
      : null;
    return {
      toolCallId: String(toolCallId || ''),
      detail: acpToolDetail(entry),
      changes: acpToolChanges(entry),
      ...(subagentSession ? { subagentSession } : {}),
      terminals: (Array.isArray(entry.content) ? entry.content : [])
        .filter(block => block?.type === 'terminal')
        .map(block => ({ terminalId: String(block.terminalId || ''), ...(block.terminal ? { terminal: block.terminal } : {}) })),
    };
  }

  killAcpTerminal(agentId, terminalId) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.killTerminal(agentId, terminalId);
  }

  inputAcpTerminal(agentId, terminalId, input) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.inputTerminal(agentId, terminalId, input);
  }

  resizeAcpTerminal(agentId, terminalId, cols, rows) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.resizeTerminal(agentId, terminalId, cols, rows);
  }

  cancelAcpSubagent(agentId, sessionId) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.cancelSubagent(agentId, sessionId);
  }

  decideAcpPatch(agentId, toolCallId, requestedPath, decision) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.decidePatch(agentId, toolCallId, requestedPath, decision);
  }

  getAcpReviewChanges(agentId, toolCallIds) {
    this.requireLiveAcpAgent(agentId);
    if (!Array.isArray(toolCallIds) || toolCallIds.length === 0 || toolCallIds.length > 256) {
      throw new Error('ACP review tool calls are invalid');
    }
    return toolCallIds.flatMap(toolCallId => {
      if (typeof toolCallId !== 'string' || !toolCallId.trim()) {
        throw new Error('ACP review tool calls are invalid');
      }
      const entry = this.acpRuntime.getToolEntry(agentId, toolCallId.trim());
      if (!entry) throw new Error('ACP tool call not found');
      return acpToolReviewChanges(entry);
    });
  }

  listAcpSessions(agentId, options = {}) {
    this.requireLiveAcpAgent(agentId);
    return this.acpRuntime.listSessions(agentId, options);
  }

  respondToAcpPermission(agentId, requestId, optionId, cancelled = false) {
    this.assertAgentOperationAdmission();
    this.requireLiveAcpAgent(agentId);
    return this.acpRuntime.respondPermission(agentId, requestId, optionId, cancelled);
  }

  respondToAcpElicitation(agentId, requestId, action, content) {
    this.assertAgentOperationAdmission();
    this.requireLiveAcpAgent(agentId);
    return this.acpRuntime.respondElicitation(agentId, requestId, action, content);
  }

  requireLiveAcpAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (!isAcpAgent(agent)) throw new Error('Agent is not using the ACP runtime');
    if (typeof this.acpRuntime.hasBinding === 'function' && !this.acpRuntime.hasBinding(agentId)) {
      const runtime = runtimeBindingOf(agent, 'acp');
      const message = runtime?.error || (
        runtime?.state === 'connecting'
          ? 'ACP Agent is still connecting'
          : 'ACP Agent runtime is unavailable'
      );
      const error = new Error(message);
      error.code = 'ACP_RUNTIME_UNAVAILABLE';
      throw error;
    }
    return agent;
  }

  authenticateAcpAgent(agentId, methodId) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.authenticate(agentId, methodId);
  }

  logoutAcpAgent(agentId) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.logout(agentId);
  }

  forkAcpSession(agentId, options = {}) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.forkSession(agentId, options);
  }

  deleteAcpSession(agentId, sessionId) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.deleteSession(agentId, sessionId);
  }

  closeAcpSession(agentId) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.closeSession(agentId);
  }

  setAcpSessionMode(agentId, modeId) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.setSessionMode(agentId, modeId);
  }

  setAcpSessionConfigOption(agentId, configId, value) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.setSessionConfigOption(agentId, configId, value);
  }

  setAcpSessionConfigOptions(agentId, changes) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.setSessionConfigOptions(agentId, changes);
  }

  async sendInputNow(agentId, input, { markUserInput = true, expectedRuntimeEpoch = '' } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (isJsonCliAgent(agent) || isAcpAgent(agent)) return;
    if (expectedRuntimeEpoch && agent.runtimeEpoch !== expectedRuntimeEpoch) {
      return { status: 'input-rejected', reason: 'runtime-epoch-mismatch' };
    }

    const engine = this.engineBridge.getEngine(agent.engineName);
    if (!engine) return;

    const submittedUserInput = markUserInput && hasSubmittedTerminalInput(input);
    if (submittedUserInput && agent.terminalInputReceived !== true) {
      agent.terminalInputReceived = true;
      this.ensurePersistentAgentSession(agent);
      this.updateEngineProviderSessionMetadata(agent);
      this.emit('agent-update', { agentId, patch: { terminalInputReceived: true } });
    }

    try {
      const result = await engine.sendInput(agentId, input, { expectedRuntimeEpoch });
      if (submittedUserInput) {
        this.providerSessionService.observe(agentId, { force: true });
      }
      return result;
    } catch (error) {
      console.error('Failed to send input:', error);
      if (isSessionNotAvailableError(error)) {
        this.markAgentSessionDead(agentId, error);
      }
      return;
    }
  }

  markAgentSessionDead(agentId, error) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status === 'dead') return;
    const message = error && error.message ? error.message : String(error || 'Session not available');
    agent.status = 'dead';
    agent.engineStatus = 'dead';
    agent.terminalBusy = false;
    agent.exitedAt = Date.now();
    agent.output = trimSessionOutput(`${agent.output || ''}\n${message}`);
    this.providerSessionService.observe(agentId, { force: true });
    this.emit('update');
  }

  async interruptAgent(agentId, options = {}) {
    this.assertAgentOperationAdmission();
    const agent = this.agents.get(agentId);
    if (!agent) return;
    try {
      if (isJsonCliAgent(agent)) {
        this.jsonCliRuntime.interruptAgent(agentId);
        return;
      }
      if (isAcpAgent(agent)) {
        await this.acpRuntime.cancel(agentId);
        return;
      }
      const engine = this.engineBridge.getEngine(agent.engineName);
      if (!engine) return;

      const input = interruptInputForAgent(agent);
      if (engine.interruptSession) {
        return await engine.interruptSession(agentId, input, options);
      } else {
        return await engine.sendInput(agentId, input, options);
      }
    } catch (error) {
      console.error('Failed to interrupt agent:', error);
      if (isSessionNotAvailableError(error)) {
        this.markAgentSessionDead(agentId, error);
      }
    }
  }

  agentSupportsTerminalInput(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    return !isJsonCliAgent(agent) && !isAcpAgent(agent);
  }

  async getAgentSessionAttachCheckpoint(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent || isAcpAgent(agent) || isJsonCliAgent(agent)) {
      return null;
    }
    try {
      return await this.engineBridge.getSessionAttachCheckpoint(agent.engineName, agentId);
    } catch (error) {
      console.error('Failed to read agent terminal attach checkpoint:', error);
      return null;
    }
  }

  requestAgentSessionResize(agentId, cols, rows) {
    if (this.disposing) return false;
    this.pendingResizeByAgent.set(agentId, { cols, rows });
    if (this.resizeDrains.has(agentId)) return true;

    const drain = (async () => {
      while (this.pendingResizeByAgent.has(agentId)) {
        const next = this.pendingResizeByAgent.get(agentId);
        this.pendingResizeByAgent.delete(agentId);
        await this.resizeAgentSession(agentId, next.cols, next.rows);
      }
    })().finally(() => {
      this.resizeDrains.delete(agentId);
    });
    this.resizeDrains.set(agentId, drain);
    return true;
  }

  async resizeAgentSession(agentId, cols, rows) {
    const agent = this.agents.get(agentId);
    if (!agent) return { status: 'resize-rejected', reason: 'session-unavailable', resized: false };
    if (isAcpAgent(agent) || isJsonCliAgent(agent)) {
      return { status: 'resize-rejected', reason: 'unsupported-session', resized: false };
    }

    const nextCols = Math.floor(Number(cols));
    const nextRows = Math.floor(Number(rows));
    if (
      !Number.isFinite(nextCols) ||
      !Number.isFinite(nextRows) ||
      nextCols < MIN_TERMINAL_RESIZE_COLS ||
      nextRows < MIN_TERMINAL_RESIZE_ROWS
    ) {
      return { status: 'resize-rejected', reason: 'invalid-dimensions', resized: false };
    }

    try {
      const engine = this.engineBridge.getEngine(agent.engineName);
      if (!engine || !engine.resizeSession) {
        return { status: 'resize-rejected', reason: 'unsupported-engine', resized: false };
      }

      const result = await engine.resizeSession(agentId, nextCols, nextRows);
      if (result && result.resized === false && result.reason === 'session-unavailable') {
        this.markAgentSessionDead(agentId, 'Session not available');
      }
      if (result && result.status === 'resize-committed') {
        this.lastResizeByAgent.set(agentId, { cols: nextCols, rows: nextRows });
      }
      return result;
    } catch (error) {
      console.error('Failed to resize agent session:', error);
      return { status: 'resize-rejected', reason: 'resize-failed', resized: false };
    }
  }

  async clearAgentSessionBuffer(agentId, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return { cleared: false };
    if (isAcpAgent(agent) || isJsonCliAgent(agent)) return { cleared: false };
    if (options.expectedRuntimeEpoch && agent.runtimeEpoch !== options.expectedRuntimeEpoch) {
      return { cleared: false, reason: 'runtime-epoch-mismatch' };
    }

    try {
      const engine = this.engineBridge.getEngine(agent.engineName);
      if (!engine || !engine.clearBuffer) return { cleared: false };
      const result = await engine.clearBuffer(agentId, options);
      if (result && result.cleared === false) {
        if (result.reason === 'session-unavailable') {
          this.markAgentSessionDead(agentId, 'Session not available');
        }
        return result;
      }
      // The ordered clear transition is the single metadata writer. Output
      // committed immediately after clear must not be erased by this RPC
      // response path racing the transition stream.
      return result || { cleared: true };
    } catch (error) {
      console.error('Failed to clear agent session buffer:', error);
      if (isSessionNotAvailableError(error)) {
        this.markAgentSessionDead(agentId, error);
      }
      return { cleared: false, error: error && error.message ? error.message : String(error) };
    }
  }

  renameAgent(agentId, title) {
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent updates are not accepted' };
    }
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const customTitle = String(title || '').trim().slice(0, 80);
    const admission = this.beginPersistentAgentUpdate(
      agent,
      `rename:${customTitle}`,
      { customTitle },
    );
    if (admission.error) return { error: `Failed to rename Agent: ${admission.error}` };
    if (admission.deduplicated) {
      return { agentId, customTitle, operationId: admission.operation.id, deduplicated: true };
    }
    const staged = {
      ...agent,
      customTitle,
      lifecycleJournal: lifecycleJournal(agent),
    };
    transitionLifecycleOperation(staged, admission.operation.id, 'succeeded');
    try {
      this.ensurePersistentAgentSession(staged, { customTitle });
    } catch (error) {
      return {
        error: `Failed to rename Agent: ${error.message || error}`,
        operationId: admission.operation.id,
        retryable: true,
      };
    }
    agent.customTitle = customTitle;
    agent.lifecycleJournal = staged.lifecycleJournal;
    setAgentRecordId(agent, staged.agentRecordId || staged.persistentSessionId || '');
    this.updateEngineProviderSessionMetadata(agent);
    this.emit('update');
    return { agentId, customTitle, operationId: admission.operation.id };
  }

  setAgentTask(agentId, task) {
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent updates are not accepted' };
    }
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const nextTask = String(task || '').trim().slice(0, 240);
    const admission = this.beginPersistentAgentUpdate(
      agent,
      `task:${nextTask}`,
      { task: nextTask },
    );
    if (admission.error) return { error: `Failed to update Agent task: ${admission.error}` };
    if (admission.deduplicated) {
      return { agentId, task: nextTask, operationId: admission.operation.id, deduplicated: true };
    }
    const staged = {
      ...agent,
      task: nextTask,
      lifecycleJournal: lifecycleJournal(agent),
    };
    transitionLifecycleOperation(staged, admission.operation.id, 'succeeded');
    try {
      this.ensurePersistentAgentSession(staged, { task: nextTask });
    } catch (error) {
      return {
        error: `Failed to update Agent task: ${error.message || error}`,
        operationId: admission.operation.id,
        retryable: true,
      };
    }
    agent.task = nextTask;
    agent.lifecycleJournal = staged.lifecycleJournal;
    setAgentRecordId(agent, staged.agentRecordId || staged.persistentSessionId || '');
    this.emit('update');
    return { agentId, task: nextTask, operationId: admission.operation.id };
  }

  updateAgentFlags(agentId, flags) {
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent updates are not accepted' };
    }
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }
    if (flags.archived === true) {
      if (agent.id === this.mainAgentId) {
        return { error: 'Main Agent cannot be archived' };
      }
      return { error: 'Use archiveAgent to archive live agents' };
    }

    const persistedFlags = {};
    [
      'pinned',
      'unread',
      'archived',
      'readAttentionSeq',
      'readOutputEpoch',
      'readOutputSeq',
    ].forEach(field => {
      if (Object.prototype.hasOwnProperty.call(flags, field)) persistedFlags[field] = flags[field];
    });
    const requestKey = `flags:${JSON.stringify(persistedFlags)}`;
    const activeUpdate = activeLifecycleOperation(agent);
    const needsLifecycleJournal = typeof persistedFlags.pinned === 'boolean'
      || persistedFlags.archived === false
      || (
        activeUpdate?.type === 'update'
        && activeUpdate.requestKey === requestKey
      );
    const admission = needsLifecycleJournal
      ? this.beginPersistentAgentOperation(
          agent,
          'update',
          requestKey,
          persistedFlags,
        )
      : null;
    if (admission?.error) return { error: `Failed to update Agent: ${admission.error}` };

    const staged = {
      ...agent,
      lifecycleJournal: lifecycleJournal(agent),
    };
    const updates = {};
    let structuralUpdateChanged = false;
    let readUpdateChanged = false;
    if (typeof flags.pinned === 'boolean') {
      const wasPinned = staged.pinned === true;
      staged.pinned = flags.pinned;
      structuralUpdateChanged = structuralUpdateChanged || wasPinned !== staged.pinned;
      updates.pinned = staged.pinned;
      if (!wasPinned && staged.pinned) {
        staged.pinnedOrder = nextPinnedOrder(Array.from(this.agents.values()));
      }
      updates.pinnedOrder = finiteOrder(staged.pinnedOrder);
    }

    if (
      typeof flags.readOutputEpoch === 'string'
      && typeof flags.readOutputSeq === 'number'
      && Number.isFinite(flags.readOutputSeq)
    ) {
      const currentRuntimeEpoch = typeof staged.runtimeEpoch === 'string' ? staged.runtimeEpoch : '';
      const currentOutputSeq = finiteNumberOrNull(staged.lastOutputSeq);
      if (
        currentRuntimeEpoch
        && flags.readOutputEpoch === currentRuntimeEpoch
        && currentOutputSeq !== null
      ) {
        const nextOutputSeq = Math.min(currentOutputSeq, Math.max(0, Math.floor(flags.readOutputSeq)));
        const previousOutputSeq = staged.readOutputEpoch === currentRuntimeEpoch
          ? finiteNumberOrNull(staged.readOutputSeq)
          : null;
        const readOutputSeq = previousOutputSeq === null
          ? nextOutputSeq
          : Math.max(previousOutputSeq, nextOutputSeq);
        readUpdateChanged = readUpdateChanged
          || staged.readOutputEpoch !== currentRuntimeEpoch
          || previousOutputSeq !== readOutputSeq;
        staged.readOutputEpoch = currentRuntimeEpoch;
        staged.readOutputSeq = readOutputSeq;
      }
      updates.readOutputEpoch = typeof staged.readOutputEpoch === 'string' ? staged.readOutputEpoch : '';
      updates.readOutputSeq = finiteNumberOrNull(staged.readOutputSeq);
    }

    if (typeof flags.unread === 'boolean') {
      const previousReadSeq = finiteNonNegativeInteger(staged.readAttentionSeq);
      const previousUnread = staged.unread === true;
      if (flags.unread) {
        if (finiteNonNegativeInteger(staged.attentionSeq) === 0) {
          const now = Date.now();
          staged.attentionSeq = 1;
          staged.attentionUpdatedAt = now;
          staged.attentionReason = 'manual-unread';
          staged.attentionOutputEpoch = typeof staged.runtimeEpoch === 'string' ? staged.runtimeEpoch : '';
          staged.attentionOutputSeq = Number.isFinite(staged.lastOutputSeq) ? staged.lastOutputSeq : null;
          staged.attentionAutoReadNext = false;
        }
        staged.readAttentionSeq = Math.max(0, finiteNonNegativeInteger(staged.attentionSeq) - 1);
      } else {
        staged.readAttentionSeq = finiteNonNegativeInteger(staged.attentionSeq);
      }
      staged.readAttentionAt = Date.now();
      staged.unread = agentAttentionUnread(staged);
      readUpdateChanged = readUpdateChanged
        || previousReadSeq !== staged.readAttentionSeq
        || previousUnread !== staged.unread;
      updates.unread = staged.unread;
      updates.attentionSeq = finiteNonNegativeInteger(staged.attentionSeq);
      updates.readAttentionSeq = finiteNonNegativeInteger(staged.readAttentionSeq);
    }

    if (typeof flags.readAttentionSeq === 'number' && Number.isFinite(flags.readAttentionSeq)) {
      const previousReadSeq = finiteNonNegativeInteger(staged.readAttentionSeq);
      const previousUnread = staged.unread === true;
      const attentionSeq = finiteNonNegativeInteger(staged.attentionSeq);
      staged.readAttentionSeq = Math.min(
        attentionSeq,
        Math.max(previousReadSeq, finiteNonNegativeInteger(flags.readAttentionSeq)),
      );
      staged.readAttentionAt = Date.now();
      staged.unread = agentAttentionUnread(staged);
      readUpdateChanged = readUpdateChanged
        || previousReadSeq !== staged.readAttentionSeq
        || previousUnread !== staged.unread;
      updates.unread = staged.unread;
      updates.attentionSeq = attentionSeq;
      updates.readAttentionSeq = staged.readAttentionSeq;
    }

    if (flags.archived === false) {
      structuralUpdateChanged = structuralUpdateChanged || staged.archived === true || staged.archivedAt !== null;
      staged.archived = false;
      staged.archivedAt = null;
      updates.archived = staged.archived;
      updates.archivedAt = staged.archivedAt;
    }

    if (admission) {
      transitionLifecycleOperation(staged, admission.operation.id, 'succeeded');
    }
    try {
      this.ensurePersistentAgentSession(staged);
    } catch (error) {
      return {
        error: `Failed to update Agent: ${error.message || error}`,
        ...(admission ? { operationId: admission.operation.id } : {}),
        retryable: true,
      };
    }
    Object.assign(agent, staged);
    if (structuralUpdateChanged || readUpdateChanged) {
      this.updateEngineProviderSessionMetadata(agent);
    }
    if (structuralUpdateChanged) {
      this.emit('update');
    } else if (readUpdateChanged) {
      this.emit('agent-read', {
        agentId,
        unread: agent.unread === true,
        attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
        readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
        readOutputEpoch: typeof agent.readOutputEpoch === 'string' ? agent.readOutputEpoch : '',
        readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
      });
    }
    return {
      agentId,
      ...updates,
      changed: structuralUpdateChanged || readUpdateChanged,
      requiresState: structuralUpdateChanged,
      ...(admission ? { operationId: admission.operation.id } : {}),
    };
  }

  reorderProjectAgent(agentId, { beforeAgentId = '', afterAgentId = '' } = {}) {
    const result = reorderedProjectAgentOrders(
      Array.from(this.agents.values()),
      agentId,
      String(beforeAgentId || ''),
      String(afterAgentId || ''),
    );
    if (result.error) return result;
    return this.commitAgentOrderUpdates(agentId, result.updates, 'projectOrder');
  }

  reorderPinnedAgent(agentId, { beforeAgentId = '', afterAgentId = '' } = {}) {
    const result = reorderedPinnedAgentOrders(
      Array.from(this.agents.values()),
      agentId,
      String(beforeAgentId || ''),
      String(afterAgentId || ''),
    );
    if (result.error) return result;
    return this.commitAgentOrderUpdates(agentId, result.updates, 'pinnedOrder');
  }

  commitAgentOrderUpdates(agentId, orderUpdates, field) {
    const staged = [...orderUpdates].map(([updatedAgentId, order]) => ({
      agent: this.agents.get(updatedAgentId),
      order,
    })).filter(item => item.agent);
    const conflicting = staged.find(item => this.agentLifecycleOperations.has(item.agent.id));
    if (conflicting) {
      const lifecycleOperation = this.agentLifecycleOperations.get(conflicting.agent.id);
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }

    const attempted = [];
    try {
      for (const item of staged) {
        item.stagedAgent = { ...item.agent, [field]: item.order };
        attempted.push(item);
        this.ensurePersistentAgentSession(item.stagedAgent);
      }
    } catch (error) {
      let rollbackError = null;
      for (const item of attempted.reverse()) {
        try {
          const agentRecordId = item.stagedAgent.agentRecordId
            || item.stagedAgent.persistentSessionId
            || item.agent.agentRecordId
            || item.agent.persistentSessionId;
          this.ensurePersistentAgentSession({
            ...item.agent,
            agentRecordId,
            persistentSessionId: agentRecordId,
          });
        } catch (restoreError) {
          rollbackError = restoreError;
        }
      }
      return {
        error: `Failed to reorder Agents: ${error.message || error}${
          rollbackError ? `; storage rollback failed: ${rollbackError.message || rollbackError}` : ''
        }`,
      };
    }

    const updates = staged.map(item => {
      item.agent[field] = item.order;
      setAgentRecordId(
        item.agent,
        item.stagedAgent.agentRecordId || item.stagedAgent.persistentSessionId || '',
      );
      this.updateEngineProviderSessionMetadata(item.agent);
      return { agentId: item.agent.id, [field]: item.order };
    });
    this.emit('update');
    return {
      agentId,
      [field]: finiteOrder(this.agents.get(agentId)?.[field]),
      updates,
    };
  }

  reorderAgent(agentId, neighbors = {}) {
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent updates are not accepted' };
    }
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    return agent.pinned === true
      ? this.reorderPinnedAgent(agentId, neighbors)
      : this.reorderProjectAgent(agentId, neighbors);
  }

  async syncCodexTerminalPermissionMode(agentId, mode) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    return this.restartAgentWithPermissionMode(agentId, mode);
  }

  runAgentLifecycleOperation(agentId, key, kind, label, operation, sameKindConflictError = '') {
    const inFlight = this.agentLifecycleOperations.get(agentId);
    if (inFlight) {
      if (inFlight.key === key) return inFlight.promise;
      if (sameKindConflictError && inFlight.kind === kind) {
        return Promise.resolve({ error: sameKindConflictError });
      }
      return inFlight.promise
        .catch(() => {})
        .then(() => this.runAgentLifecycleOperation(
          agentId,
          key,
          kind,
          label,
          operation,
          sameKindConflictError,
        ));
    }
    if (this.disposing) {
      return Promise.resolve({ error: 'Farming is shutting down; Agent lifecycle changes are not accepted' });
    }

    const token = Symbol(key);
    const promise = Promise.resolve().then(() => operation(token));
    const entry = { key, kind, label, token, promise, agentIds: new Set([agentId]) };
    this.agentLifecycleOperations.set(agentId, entry);
    void promise.finally(() => {
      for (const ownedAgentId of entry.agentIds) {
        if (this.agentLifecycleOperations.get(ownedAgentId) === entry) {
          this.agentLifecycleOperations.delete(ownedAgentId);
        }
      }
    }).catch(() => {});
    return promise;
  }

  async whenAgentLifecycleIdle(agentId) {
    await this.whenRecovered();
    while (true) {
      const inFlight = this.agentLifecycleOperations.get(agentId);
      if (!inFlight) return;
      await inFlight.promise.catch(() => {});
    }
  }

  beginAgentStartLifecycleOperation(agentId, startAdmissionToken) {
    if (this.agentLifecycleOperations.has(agentId)) return null;
    if (this.disposing && !this.agentStartAdmissions.has(startAdmissionToken)) return null;
    let resolveCompletion;
    const promise = new Promise(resolve => {
      resolveCompletion = resolve;
    });
    const entry = {
      key: 'start',
      kind: 'start',
      label: 'start',
      token: Symbol('start'),
      promise,
      agentIds: new Set([agentId]),
    };
    this.agentLifecycleOperations.set(agentId, entry);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (this.agentLifecycleOperations.get(agentId) === entry) {
        this.agentLifecycleOperations.delete(agentId);
      }
      resolveCompletion({ agentId, started: true });
    };
  }

  adoptAgentLifecycleOperation(agentId, lifecycleToken) {
    if (!lifecycleToken) return false;
    const entry = [...new Set(this.agentLifecycleOperations.values())]
      .find(candidate => candidate.token === lifecycleToken);
    if (!entry) return false;
    const existing = this.agentLifecycleOperations.get(agentId);
    if (existing && existing !== entry) return false;
    entry.agentIds.add(agentId);
    this.agentLifecycleOperations.set(agentId, entry);
    return true;
  }

  restartAgentWithPermissionMode(agentId, mode) {
    return this.runAgentLifecycleOperation(
      agentId,
      `permission-restart:${mode}`,
      'permission-restart',
      'permission restart',
      token => this.performAgentPermissionRestart(agentId, mode, token),
      'Permission change already in progress',
    );
  }

  restartAgentRuntimeMode(agentId, mode) {
    return this.runAgentLifecycleOperation(
      agentId,
      `runtime-switch:${mode}`,
      'runtime-switch',
      'runtime switch',
      token => this.performAgentRuntimeModeRestart(agentId, mode, token),
      'Agent runtime switch already in progress',
    );
  }

  async performAgentRuntimeModeRestart(agentId, mode, lifecycleToken) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    const provider = agent.providerSessionProvider || '';
    const requestedMode = ['terminal', 'acp', 'chat'].includes(mode) ? mode : '';
    const nextMode = requestedMode === 'acp' && provider === 'codex' ? 'chat' : requestedMode;
    if (!nextMode) return { error: 'Unsupported Agent runtime mode' };
    const currentKind = runtimeKind(agent);
    const currentMode = currentKind === 'acp'
      ? 'chat'
      : (currentKind === 'json' ? 'json' : 'terminal');
    const nextRuntimeKind = nextMode === 'chat' ? chatRuntimeForProvider(provider) : nextMode;
    if (currentMode === nextMode) {
      return { agentId, agentRuntimeMode: nextMode };
    }
    const turnActive = currentKind === 'acp'
      ? ['working', 'waiting-for-permission', 'interrupting'].includes(runtimeBindingOf(agent, 'acp').state)
      : this.isAgentAttentionTurnActive(agent);
    if (turnActive) {
      return { error: 'Interrupt the active Agent turn before switching Chat and Terminal.' };
    }
    const supportsNextMode = nextMode === 'chat'
      ? providerCapabilities(provider).supportsChat === true
      : providerSupportsRuntime(provider, nextMode);
    if (!supportsNextMode) {
      return { error: `Agent does not support the ${nextMode.toUpperCase()} runtime` };
    }
    const sessionId = String(agent.providerSessionId || '').trim();
    const canStartFreshChatSession = nextMode === 'chat'
      && currentMode === 'terminal'
      && agent.terminalInputReceived !== true
      && (
        agent.providerSessionTemporary === true
        || isFreshAcpSessionSource(provider, agent.providerSessionSource || '')
      );
    if (!isSafeProviderSessionId(sessionId) && !canStartFreshChatSession) {
      return { error: 'Runtime switching requires a resumable provider session. Send the first message and try again.' };
    }
    // A live ACP binding is the authoritative owner of a newly-created
    // provider session. Provider history indexes can lag behind that binding
    // (and some adapters persist only while closing), so requiring an
    // immediate filesystem/history hit makes Chat -> Terminal spuriously
    // fail. Historical/terminal sessions still use the provider lookup as a
    // stale-session guard.
    let liveAcpSession = false;
    if (currentKind === 'acp' && this.acpRuntime && typeof this.acpRuntime.getSession === 'function') {
      try {
        const snapshot = this.acpRuntime.getSession(agentId, { maxEntries: 0 });
        liveAcpSession = String(snapshot?.sessionId || '') === sessionId;
      } catch {
        liveAcpSession = false;
      }
    }
    const previouslyVerifiedSession = String(agent.runtimeSwitchVerifiedSessionId || '') === sessionId;
    let startsFreshChatSession = canStartFreshChatSession && !isSafeProviderSessionId(sessionId);
    if (!startsFreshChatSession && !liveAcpSession && !previouslyVerifiedSession) {
      const providerSession = await this.findRuntimeSwitchSession(agent);
      if (!providerSession) {
        if (canStartFreshChatSession) startsFreshChatSession = true;
        else return { error: 'The saved Agent session is no longer available in the selected Agent Home.' };
      }
    }
    const command = startsFreshChatSession
      ? (agent.forkCommand || agent.command)
      : buildAgentSessionResumeCommand(provider, sessionId, {
          cwd: effectiveAgentWorkspaceRoot(agent),
          providerHomePath: agent.providerHomePath || '',
        });
    if (!command) return { error: 'Failed to build provider resume command' };
    const preserved = {
      pinned: agent.pinned === true,
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      customTitle: agent.customTitle || '',
      unread: agent.unread === true,
      jsonCliEvents: isJsonCliAgent(agent)
        ? this.jsonCliRuntime.getEvents(agentId)
        : (Array.isArray(agent.runtimeResumeState?.jsonEvents) ? agent.runtimeResumeState.jsonEvents : []),
    };
    let acpSessionOptions = {};
    if (currentKind === 'acp' && this.acpRuntime?.getSessionRequestOptions) {
      try {
        acpSessionOptions = this.acpRuntime.getSessionRequestOptions(agentId);
      } catch {
        acpSessionOptions = {};
      }
    }
    const restartOptions = {
      wantsMain: agent.wantsMain === true,
      task: agent.task || agent.providerSessionTitle || '',
      workflowTemplate: agent.workflowTemplate || '',
      projectWorkspace: effectiveAgentWorkspaceRoot(agent),
      source: startsFreshChatSession
        ? 'ui-runtime-switch-fresh'
        : resumedAgentSource(provider, sessionId, agent.providerHomeId || ''),
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      providerSessionTitle: agent.providerSessionTitle || '',
      restartedFromAgentId: agentId,
      restartedFromAgentIds: Array.from(new Set([
        ...(Array.isArray(agent.restartedFromAgentIds) ? agent.restartedFromAgentIds : []),
        ...(agent.restartedFromAgentId ? [agent.restartedFromAgentId] : []),
        agentId,
      ])),
      projectOrder: preserved.projectOrder,
      pinnedOrder: preserved.pinnedOrder,
      agentRuntimeMode: nextMode,
      acpStartFresh: startsFreshChatSession && nextRuntimeKind === 'acp',
      codexApprovalMode: agent.launchPermissionMode || undefined,
      jsonCliEvents: preserved.jsonCliEvents,
      runtimeSwitchVerifiedSessionId: startsFreshChatSession ? '' : sessionId,
      lifecycleToken,
      ...acpSessionOptions,
      ...(provider === 'codex' && !startsFreshChatSession
        ? preserveCodexSessionProfileOptions()
        : {}),
    };
    const originalMode = currentMode;
    const originalOptions = {
      ...restartOptions,
      agentRuntimeMode: originalMode,
      acpStartFresh: false,
      ...(originalMode === 'json' ? { allowLegacyJsonRuntime: true } : {}),
    };
    const startReplacement = options => new Promise(resolve => {
      let settled = false;
      const finish = (restartedAgentId, error) => {
        if (settled) return;
        settled = true;
        resolve({ restartedAgentId: restartedAgentId || '', error: error || '' });
      };
      try {
        const started = this.startAgent(
          command,
          effectiveAgentWorkspaceRoot(agent) || null,
          (restartedAgentId, error) => finish(restartedAgentId, error),
          options
        );
        Promise.resolve(started).catch(error => finish('', error?.message || 'Failed to start Agent'));
      } catch (error) {
        finish('', error?.message || 'Failed to start Agent');
      }
    });
    const restorePreservedState = restartedAgentId => {
      const replacement = this.agents.get(restartedAgentId);
      if (!replacement) return;
      Object.assign(replacement, preserved);
      this.ensurePersistentAgentSession(replacement);
    };
    const killResult = await this.killAgent(agentId, {
      reason: 'runtime-switch',
      recordHistory: false,
      emitUpdate: false,
      lifecycleToken,
      persistDeleteOperation: false,
    });
    if (killResult?.error) return killResult;
    const switched = await startReplacement(restartOptions);
    if (switched.restartedAgentId && !switched.error) {
      restorePreservedState(switched.restartedAgentId);
      this.emit('update');
      return {
        agentId,
        restarted: true,
        restartedAgentId: switched.restartedAgentId,
        agentRuntimeMode: nextMode,
      };
    }
    if (switched.restartedAgentId && this.agents.has(switched.restartedAgentId)) {
      const cleanup = await this.killAgent(switched.restartedAgentId, {
          reason: 'runtime-switch-start-failed',
          recordHistory: false,
          emitUpdate: false,
          lifecycleToken,
      });
      if (cleanup?.error) {
        this.emit('update');
        return {
          agentId,
          restartedAgentId: switched.restartedAgentId,
          cleanupUncertain: true,
          error: `${switched.error || 'Failed to switch Agent runtime'} Replacement cleanup could not be verified: ${cleanup.error}`,
        };
      }
    }

    const restored = await startReplacement(originalOptions);
    if (restored.restartedAgentId && !restored.error) {
      restorePreservedState(restored.restartedAgentId);
      this.emit('update');
      return {
        agentId,
        restarted: true,
        restartedAgentId: restored.restartedAgentId,
        agentRuntimeMode: originalMode,
        switchFailed: true,
        warning: `${switched.error || 'Failed to switch Agent runtime'} Original runtime restored.`,
      };
    }
    let restoreCleanupError = '';
    if (restored.restartedAgentId && this.agents.has(restored.restartedAgentId)) {
      const cleanup = await this.killAgent(restored.restartedAgentId, {
        reason: 'runtime-switch-restore-failed',
        recordHistory: false,
        emitUpdate: false,
        lifecycleToken,
      });
      restoreCleanupError = cleanup?.error || '';
    }
    this.emit('update');
    return {
      ...(restoreCleanupError
        ? { restartedAgentId: restored.restartedAgentId, cleanupUncertain: true }
        : {}),
      error: `${switched.error || 'Failed to switch Agent runtime'} Restore also failed: ${
        restored.error || 'unknown error'
      }${restoreCleanupError ? ` Cleanup could not be verified: ${restoreCleanupError}` : ''}`,
    };
  }

  findRuntimeSwitchSession(agent) {
    const provider = agent.providerSessionProvider;
    const providerHomeId = agent.providerHomeId || 'default';
    const providerHomePath = agent.providerHomePath || '';
    return findAgentSession(agent.providerSessionProvider, agent.providerSessionId, {
      limit: 1000,
      providerLimit: 1000,
      scanLimit: 5000,
      providerHomeId,
      providerHomes: providerHomePath
        ? { [provider]: [{ id: providerHomeId, path: providerHomePath }] }
        : undefined,
    });
  }

  async performAgentPermissionRestart(agentId, mode, lifecycleToken) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const sourceSession = resumedSessionFromSource(agent.source);
    const provider = agent.providerSessionProvider || (sourceSession && sourceSession.provider) || '';
    const providerHomeId = agent.providerHomeId || (sourceSession && sourceSession.providerHomeId) || '';
    const sessionId = agent.providerSessionTemporary === true
      ? (sourceSession && sourceSession.sessionId)
      : (agent.providerSessionId || (sourceSession && sourceSession.sessionId) || '');

    if (!['codex', 'claude'].includes(provider)) {
      return { error: 'Agent does not support permission restart' };
    }

    const nextMode = provider === 'codex'
      ? (['ask', 'approve', 'full', 'custom'].includes(mode) ? mode : '')
      : (['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'].includes(mode) ? mode : '');
    if (!nextMode) {
      return { error: `Unsupported ${provider === 'codex' ? 'Codex' : 'Claude'} permission mode` };
    }

    const hasResumableSession = isSafeProviderSessionId(sessionId);
    const startsFreshCodexSession = provider === 'codex'
      && !hasResumableSession
      && (agent.providerSessionTemporary === true || !String(agent.providerSessionId || '').trim());
    if (startsFreshCodexSession && agent.terminalInputReceived === true) {
      return { error: 'Permission changes require a resumable provider session. Try again after the session id is available.' };
    }
    if (!hasResumableSession && !startsFreshCodexSession) {
      return { error: 'Permission changes require a resumable provider session. Try again after the session id is available.' };
    }
    const command = startsFreshCodexSession
      ? 'codex'
      : buildAgentSessionResumeCommand(provider, sessionId, {
        cwd: effectiveAgentWorkspaceRoot(agent),
        providerHomePath: agent.providerHomePath || '',
      });
    if (!command) {
      return { error: 'Failed to build provider resume command' };
    }

    let acpSessionOptions = {};
    if (isAcpAgent(agent) && this.acpRuntime?.getSessionRequestOptions) {
      try {
        acpSessionOptions = this.acpRuntime.getSessionRequestOptions(agentId);
      } catch {
        acpSessionOptions = {};
      }
    }
    const restartOptions = {
      wantsMain: agent.wantsMain === true,
      task: agent.task || agent.providerSessionTitle || '',
      workflowTemplate: agent.workflowTemplate || '',
      requiredCliVersion: provider === 'codex' ? (agent.requiredCliVersion || '') : '',
      projectWorkspace: effectiveAgentWorkspaceRoot(agent),
      source: startsFreshCodexSession
        ? 'ui'
        : (resumedSessionFromSource(agent.source)
          ? agent.source
          : resumedAgentSource(provider, sessionId, providerHomeId)),
      providerHomeId,
      providerHomePath: agent.providerHomePath || '',
      providerSessionTitle: agent.providerSessionTitle || '',
      restartedFromAgentId: agentId,
      restartedFromAgentIds: Array.from(new Set([
        ...(Array.isArray(agent.restartedFromAgentIds) ? agent.restartedFromAgentIds : []),
        ...(agent.restartedFromAgentId ? [agent.restartedFromAgentId] : []),
        agentId,
      ])),
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      lifecycleToken,
      ...acpSessionOptions,
      ...(provider === 'codex' ? { codexApprovalMode: nextMode } : { claudePermissionMode: nextMode }),
      ...(provider === 'codex' && hasResumableSession
        ? preserveCodexSessionProfileOptions()
        : {}),
    };
    const preserved = {
      pinned: agent.pinned === true,
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      customTitle: agent.customTitle || '',
      unread: agent.unread === true,
      attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
    };

    const killResult = await this.killAgent(agentId, {
      reason: 'permission-restart',
      recordHistory: false,
      emitUpdate: false,
      lifecycleToken,
      persistDeleteOperation: false,
    });
    if (killResult?.error) return killResult;

    return new Promise((resolve) => {
      const startResult = this.startAgent(command, effectiveAgentWorkspaceRoot(agent) || null, (restartedAgentId, error) => {
        if (error) {
          this.emit('update');
          resolve({ error });
          return;
        }
        if (!restartedAgentId) {
          this.emit('update');
          resolve({ error: 'Failed to restart agent with updated permissions' });
          return;
        }

        const restartedAgent = this.agents.get(restartedAgentId);
        if (restartedAgent) {
          restartedAgent.pinned = preserved.pinned;
          restartedAgent.projectOrder = preserved.projectOrder;
          restartedAgent.pinnedOrder = preserved.pinnedOrder;
          restartedAgent.customTitle = preserved.customTitle;
          restartedAgent.unread = preserved.unread;
          restartedAgent.attentionSeq = preserved.attentionSeq;
          restartedAgent.readAttentionSeq = preserved.readAttentionSeq;
          restartedAgent.launchPermissionMode = nextMode;
          this.updateEngineProviderSessionMetadata(restartedAgent);
          this.ensurePersistentAgentSession(restartedAgent, {
            pinned: restartedAgent.pinned,
            projectOrder: restartedAgent.projectOrder,
            pinnedOrder: restartedAgent.pinnedOrder,
            customTitle: restartedAgent.customTitle,
            unread: restartedAgent.unread,
            attentionSeq: restartedAgent.attentionSeq,
            readAttentionSeq: restartedAgent.readAttentionSeq,
            launchPermissionMode: nextMode,
          });
        }
        this.emit('update');
        resolve({
          agentId,
          restarted: true,
          restartedAgentId,
          launchPermissionMode: nextMode,
        });
      }, restartOptions);
      Promise.resolve(startResult).catch((error) => {
        this.emit('update');
        resolve({ error: error.message || 'Failed to restart agent with updated permissions' });
      });
    });
  }

  setAgentUnread(agentId, unread) {
    return unread === true
      ? this.markAgentUnreadCursor(agentId)
      : this.markAgentReadCursor(agentId);
  }

  persistentProjectOperation(requestId, type, signature, request) {
    if (
      !requestId
      || typeof this.configManager?.getProjectOperation !== 'function'
      || typeof this.configManager?.commitProjectOperation !== 'function'
    ) {
      return { operation: null, created: true };
    }
    const existing = this.configManager.getProjectOperation(requestId);
    if (existing) {
      if (existing.type !== type || existing.signature !== signature) {
        return { error: `Project operation request ${requestId} was already used for different parameters` };
      }
      return { operation: existing, created: false };
    }
    const operation = {
      id: requestId,
      type,
      state: 'pending',
      signature,
      request,
      result: null,
      error: '',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
    };
    try {
      this.configManager.commitProjectOperation(operation);
      return { operation, created: true };
    } catch (error) {
      return { error: `Failed to persist Project operation intent: ${error.message || error}` };
    }
  }

  commitPersistentProjectOperation(operation, state, result = null, error = '', membership = {}) {
    if (!operation || typeof this.configManager?.commitProjectOperation !== 'function') {
      return { operation: null, projectWorkspaces: null, pinnedProjectWorkspaces: null };
    }
    const terminal = ['succeeded', 'failed', 'blocked'].includes(state);
    const nextOperation = {
      ...operation,
      state,
      result,
      error,
      updatedAt: Date.now(),
      finishedAt: terminal ? Date.now() : null,
    };
    return this.configManager.commitProjectOperation(nextOperation, membership);
  }

  async listGitWorktrees(sourceWorkspace) {
    const { stdout } = await execFileAsync('git', ['-C', sourceWorkspace, 'worktree', 'list', '--porcelain'], {
      timeout: 15000,
      maxBuffer: 1024 * 1024 * 4,
    });
    return worktreesFromPorcelain(stdout);
  }

  async inspectGitWorktreePostcondition(sourceWorkspace, workspace, branch = '') {
    const target = path.resolve(workspace);
    let worktrees;
    try {
      worktrees = await this.listGitWorktrees(sourceWorkspace);
    } catch (error) {
      return { proven: false, error: error.message || String(error) };
    }
    const registered = worktrees.find(entry => entry.workspace === target) || null;
    let exists = false;
    try {
      exists = fs.statSync(target).isDirectory();
    } catch {
      exists = false;
    }
    let branchExists = false;
    if (branch) {
      try {
        await execFileAsync('git', ['-C', sourceWorkspace, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        });
        branchExists = true;
      } catch (error) {
        if (error?.code !== 1) {
          return { proven: false, error: error.message || String(error) };
        }
      }
    }
    return {
      proven: true,
      exists,
      registered: Boolean(registered),
      branchMatches: !branch || registered?.branch === branch,
      branchExists,
      worktree: registered,
    };
  }

  async resolveGitWorktreeSourceRoot(workspace) {
    const sourceWorkspace = this.expandWorkspacePath(workspace);
    if (!sourceWorkspace) {
      throw new Error('Source workspace is empty');
    }

    try {
      const { stdout } = await execFileAsync('git', ['-C', sourceWorkspace, 'rev-parse', '--show-toplevel'], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      const message = error && error.stderr ? String(error.stderr).trim() : '';
      throw new Error(message || 'Source workspace is not inside a git repository', { cause: error });
    }
  }

  async createForkWorktree(workspace) {
    const root = await this.resolveGitWorktreeSourceRoot(workspace);

    const parentDir = path.dirname(root);
    const baseName = path.basename(root);
    const slug = timestampSlug();
    let target = path.join(parentDir, `${baseName}-farming-fork-${slug}`);
    let suffix = 2;
    while (fs.existsSync(target)) {
      target = path.join(parentDir, `${baseName}-farming-fork-${slug}-${suffix}`);
      suffix += 1;
    }

    try {
      await execFileAsync('git', ['-C', root, 'worktree', 'add', target, 'HEAD'], {
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 4,
      });
    } catch (error) {
      const message = error && error.stderr ? String(error.stderr).trim() : '';
      throw new Error(message || 'Failed to create git worktree', { cause: error });
    }

    return target;
  }

  createPermanentWorktree(workspace, options = {}) {
    const requestId = String(options.requestId || '').trim().slice(0, 160);
    if (!requestId) return this.createPermanentWorktreeAdmitted(workspace, options);
    const workspaceKey = canonicalWorkspacePath(this.expandWorkspacePath(workspace));
    const current = this.projectOperationAdmissions.get(requestId);
    if (current) {
      if (current.workspaceKey === workspaceKey) return current.promise;
      return Promise.reject(new Error(`Project operation request ${requestId} was already used for different parameters`));
    }
    const promise = this.createPermanentWorktreeAdmitted(workspace, options);
    const admission = { workspaceKey, promise };
    this.projectOperationAdmissions.set(requestId, admission);
    void promise.finally(() => {
      if (this.projectOperationAdmissions.get(requestId) === admission) {
        this.projectOperationAdmissions.delete(requestId);
      }
    }).catch(() => {});
    return promise;
  }

  async createPermanentWorktreeAdmitted(workspace, options = {}) {
    const root = await this.resolveGitWorktreeSourceRoot(workspace);
    const requestId = String(options.requestId || '').trim().slice(0, 160);
    const signature = projectOperationSignature({ sourceWorkspace: root, type: 'create-worktree' });
    const existingOperation = requestId && typeof this.configManager?.getProjectOperation === 'function'
      ? this.configManager.getProjectOperation(requestId)
      : null;
    const operationWasExisting = Boolean(existingOperation);
    if (
      existingOperation
      && (
        existingOperation.type !== 'create-worktree'
        || existingOperation.signature !== signature
      )
    ) {
      throw new Error(`Project operation request ${requestId} was already used for different parameters`);
    }
    if (existingOperation?.state === 'succeeded' && existingOperation.result) {
      const settings = this.configManager.getSettings?.() || {};
      return {
        ...existingOperation.result,
        deduplicated: true,
        projectWorkspaces: settings.projectWorkspaces || [],
        pinnedProjectWorkspaces: settings.pinnedProjectWorkspaces || [],
      };
    }

    const parentDir = path.dirname(root);
    const baseName = path.basename(root);
    let target = String(existingOperation?.request?.workspace || '');
    let branch = String(existingOperation?.request?.branch || '');
    let operation = existingOperation;
    if (!operation) {
      const slug = timestampSlug();
      let suffix = 1;
      while (suffix < 1000) {
        const suffixText = suffix === 1 ? '' : `-${suffix}`;
        const candidateTarget = path.join(parentDir, `${baseName}-farming-worktree-${slug}${suffixText}`);
        const candidateBranch = `farming/worktree-${slug}${suffixText}`;
        let branchExists = false;
        try {
          await execFileAsync('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${candidateBranch}`], {
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          });
          branchExists = true;
        } catch (error) {
          if (error?.code !== 1) {
            const message = error && error.stderr ? String(error.stderr).trim() : '';
            throw new Error(message || 'Failed to inspect git branches', { cause: error });
          }
        }

        if (!fs.existsSync(candidateTarget) && !branchExists) {
          target = candidateTarget;
          branch = candidateBranch;
          break;
        }
        suffix += 1;
      }
      if (!target || !branch) throw new Error('Unable to allocate a permanent worktree name');
      const admission = this.persistentProjectOperation(requestId, 'create-worktree', signature, {
        sourceWorkspace: root,
        workspace: target,
        branch,
      });
      if (admission.error) throw new Error(admission.error);
      operation = admission.operation;
    }

    const commitSuccess = () => {
      const result = { workspace: target, branch, sourceWorkspace: root, ...(requestId ? { requestId } : {}) };
      if (!operation) return result;
      const committed = this.commitPersistentProjectOperation(
        operation,
        'succeeded',
        result,
        '',
        { mountWorkspace: target },
      );
      return {
        ...result,
        projectWorkspaces: committed.projectWorkspaces,
        pinnedProjectWorkspaces: committed.pinnedProjectWorkspaces,
      };
    };

    if (operation && !['pending', 'unknown'].includes(operation.state)) {
      throw new Error(operation.error || `Project operation ${requestId} already finished with state ${operation.state}`);
    }
    if (operation && operationWasExisting) {
      const postcondition = await this.inspectGitWorktreePostcondition(root, target, branch);
      if (
        postcondition.proven
        && postcondition.exists
        && postcondition.registered
        && postcondition.branchMatches
      ) {
        return commitSuccess();
      }
      if (operation.state === 'unknown') {
        throw new Error(operation.error || 'Permanent worktree creation has an uncertain outcome and will not be replayed automatically');
      }
      if (
        !postcondition.proven
        || postcondition.exists
        || postcondition.registered
        || postcondition.branchExists
      ) {
        const detail = postcondition.error || 'Permanent worktree creation has a partial or unverifiable result';
        this.commitPersistentProjectOperation(operation, 'unknown', null, detail);
        throw new Error(`${detail}; the operation will not be replayed automatically`);
      }
    }

    try {
      await execFileAsync('git', ['-C', root, 'worktree', 'add', '-b', branch, target, 'HEAD'], {
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 4,
      });
    } catch (error) {
      const postcondition = await this.inspectGitWorktreePostcondition(root, target, branch);
      if (
        postcondition.proven
        && postcondition.exists
        && postcondition.registered
        && postcondition.branchMatches
      ) {
        return commitSuccess();
      }
      const message = error && error.stderr ? String(error.stderr).trim() : '';
      const detail = message || 'Failed to create permanent git worktree';
      if (operation) {
        const state = postcondition.proven
          && !postcondition.exists
          && !postcondition.registered
          && !postcondition.branchExists
          ? 'failed'
          : 'unknown';
        this.commitPersistentProjectOperation(operation, state, null, detail);
      }
      throw new Error(detail, { cause: error });
    }

    const postcondition = await this.inspectGitWorktreePostcondition(root, target, branch);
    if (
      !postcondition.proven
      || !postcondition.exists
      || !postcondition.registered
      || !postcondition.branchMatches
    ) {
      const detail = postcondition.error || 'Permanent worktree creation could not be proven';
      if (operation) this.commitPersistentProjectOperation(operation, 'unknown', null, detail);
      throw new Error(`${detail}; the operation will not be replayed automatically`);
    }
    return commitSuccess();
  }

  async rollbackPermanentWorktree(created) {
    if (!created?.workspace || !created?.sourceWorkspace) {
      return { rolledBack: true };
    }
    const errors = [];
    try {
      await execFileAsync('git', ['-C', created.sourceWorkspace, 'worktree', 'remove', '--force', created.workspace], {
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 4,
      });
    } catch (error) {
      const message = error && error.stderr ? String(error.stderr).trim() : '';
      errors.push(message || 'Failed to remove the created worktree');
    }
    if (created.branch) {
      try {
        await execFileAsync('git', ['-C', created.sourceWorkspace, 'branch', '-D', created.branch], {
          timeout: 30000,
          maxBuffer: 1024 * 1024 * 4,
        });
      } catch (error) {
        const message = error && error.stderr ? String(error.stderr).trim() : '';
        errors.push(message || 'Failed to delete the created worktree branch');
      }
    }
    return errors.length > 0
      ? { rolledBack: false, error: errors.join('; ') }
      : { rolledBack: true };
  }

  async inspectForkWorktreeProject(workspace) {
    const expanded = this.expandWorkspacePath(workspace);
    const resolvedWorkspace = expanded ? path.resolve(expanded) : '';
    if (!resolvedWorkspace) {
      return { error: 'Workspace is required' };
    }
    if (!isFarmingForkWorktreePath(resolvedWorkspace)) {
      return { error: 'Only Farming fork worktrees can be deleted' };
    }
    try {
      if (!fs.statSync(resolvedWorkspace).isDirectory()) {
        return { error: 'Workspace is not a directory' };
      }
    } catch {
      return { error: 'Workspace not found' };
    }

    let topLevel = '';
    try {
      const { stdout } = await execFileAsync('git', ['-C', resolvedWorkspace, 'rev-parse', '--show-toplevel'], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      topLevel = path.resolve(stdout.trim());
    } catch (error) {
      const message = error && error.stderr ? String(error.stderr).trim() : '';
      return { error: message || 'Workspace is not a git worktree' };
    }

    if (topLevel !== resolvedWorkspace) {
      return { error: 'Workspace must be the root of a Farming fork worktree' };
    }

    try {
      const worktrees = await this.listGitWorktrees(resolvedWorkspace);
      const sourceWorkspace = worktrees[0]?.workspace || resolvedWorkspace;
      const { stdout } = await execFileAsync('git', ['-C', resolvedWorkspace, 'status', '--porcelain', '--untracked-files=all'], {
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 4,
      });
      const dirtyEntries = statusEntriesFromPorcelain(stdout);
      return {
        workspace: resolvedWorkspace,
        sourceWorkspace,
        dirtyEntries,
        requiresForce: dirtyEntries.length > 0,
      };
    } catch (error) {
      const message = error && error.stderr ? String(error.stderr).trim() : '';
      return { error: message || 'Failed to inspect worktree status' };
    }
  }

  agentsForProjectWorkspace(workspace) {
    const resolvedWorkspace = path.resolve(workspace);
    return Array.from(this.agents.values()).filter(agent => {
      if (!agent || agent.isMain) return false;
      const agentWorkspace = this.expandWorkspacePath(effectiveAgentWorkspaceRoot(agent));
      if (!agentWorkspace) return false;
      return path.resolve(agentWorkspace) === resolvedWorkspace;
    });
  }

  removeMainPageProviderSessionsForAgents(agents) {
    if (!this.configManager) {
      return [];
    }

    const keysToRemove = new Set();
    agents.forEach(agent => {
      const providerSessionKey = agent.providerSessionKey || mainPageAgentSessionKey(
        agent.providerSessionProvider,
        agent.providerSessionId,
        agent.providerHomeId || ''
      );
      if (providerSessionKey) keysToRemove.add(providerSessionKey);
    });
    if (keysToRemove.size === 0) return [];

    const currentKeys = this.getMainPageSessionKeys();
    const removedKeys = currentKeys.filter(key => keysToRemove.has(key));
    if (removedKeys.length === 0) return [];
    if (typeof this.configManager.removeMainPageSessionKeys === 'function') {
      this.configManager.removeMainPageSessionKeys(removedKeys);
    } else {
      const nextKeys = currentKeys.filter(key => !keysToRemove.has(key));
      this.setMainPageSessionKeys(nextKeys);
    }
    return removedKeys;
  }

  deleteForkWorktreeProject(workspace, options = {}) {
    const workspaceKey = canonicalWorkspacePath(this.expandWorkspacePath(workspace));
    if (!workspaceKey) return this.deleteForkWorktreeProjectAdmitted(workspace, options);
    const inFlight = this.projectWorkspaceDeleteAdmissions.get(workspaceKey);
    const requestId = String(options.requestId || '').trim();
    if (inFlight) {
      if (requestId && inFlight.requestId === requestId) return inFlight.promise;
      return inFlight.promise
        .catch(() => {})
        .then(() => this.deleteForkWorktreeProject(workspace, options));
    }

    const promise = this.deleteForkWorktreeProjectAdmitted(workspace, options);
    const admission = { requestId, promise };
    this.projectWorkspaceDeleteAdmissions.set(workspaceKey, admission);
    void promise.finally(() => {
      if (this.projectWorkspaceDeleteAdmissions.get(workspaceKey) === admission) {
        this.projectWorkspaceDeleteAdmissions.delete(workspaceKey);
      }
    }).catch(() => {});
    return promise;
  }

  async deleteForkWorktreeProjectAdmitted(workspace, options = {}) {
    await this.whenRecovered();
    const workspaceKey = canonicalWorkspacePath(this.expandWorkspacePath(workspace));
    const requestId = String(options.requestId || '').trim().slice(0, 160);
    const signature = projectOperationSignature({
      force: options.force === true,
      type: 'delete-worktree',
      workspace: workspaceKey,
    });
    const existingOperation = requestId && typeof this.configManager?.getProjectOperation === 'function'
      ? this.configManager.getProjectOperation(requestId)
      : null;
    if (
      existingOperation
      && (
        existingOperation.type !== 'delete-worktree'
        || existingOperation.signature !== signature
      )
    ) {
      return { workspace: workspaceKey, error: `Project operation request ${requestId} was already used for different parameters` };
    }
    if (existingOperation?.state === 'succeeded' && existingOperation.result) {
      const settings = this.configManager.getSettings?.() || {};
      return {
        ...existingOperation.result,
        deduplicated: true,
        projectWorkspaces: settings.projectWorkspaces || [],
        pinnedProjectWorkspaces: settings.pinnedProjectWorkspaces || [],
      };
    }
    let operation = existingOperation;
    const storedSourceWorkspace = String(operation?.request?.sourceWorkspace || '');
    const commitDeleted = (baseResult) => {
      const result = { ...baseResult, ...(requestId ? { requestId } : {}) };
      if (!operation) return result;
      const committed = this.commitPersistentProjectOperation(
        operation,
        'succeeded',
        result,
        '',
        { removeWorkspace: workspaceKey },
      );
      return {
        ...result,
        projectWorkspaces: committed.projectWorkspaces,
        pinnedProjectWorkspaces: committed.pinnedProjectWorkspaces,
      };
    };
    if (operation && ['pending', 'unknown'].includes(operation.state) && storedSourceWorkspace) {
      const postcondition = await this.inspectGitWorktreePostcondition(
        storedSourceWorkspace,
        operation.request.workspace || workspaceKey,
      );
      if (postcondition.proven && !postcondition.exists && !postcondition.registered) {
        try {
          return commitDeleted({
            workspace: workspaceKey,
            deleted: true,
            forced: operation.request.force === true,
            archivedAgentIds: [],
            removedMainPageSessionKeys: [],
          });
        } catch (error) {
          return {
            workspace: workspaceKey,
            deleted: true,
            retryable: true,
            error: `Worktree was deleted, but Project operation commit failed: ${error.message || error}`,
          };
        }
      }
      if (operation.state === 'unknown') {
        return {
          workspace: workspaceKey,
          error: operation.error || 'Worktree deletion has an uncertain outcome and will not be replayed automatically',
          uncertain: true,
        };
      }
      if (!postcondition.proven || postcondition.exists !== postcondition.registered) {
        const detail = postcondition.error || 'Worktree deletion has a partial or unverifiable result';
        try {
          this.commitPersistentProjectOperation(operation, 'unknown', null, detail);
        } catch {
          // The previously persisted pending intent still prevents blind replay.
        }
        return { workspace: workspaceKey, error: `${detail}; the operation will not be replayed automatically`, uncertain: true };
      }
    } else if (operation && !['pending', 'unknown'].includes(operation.state)) {
      return {
        workspace: workspaceKey,
        error: operation.error || `Project operation ${requestId} already finished with state ${operation.state}`,
      };
    }
    const relatedStarts = workspaceKey
      ? [...this.agentStartAdmissions.values()].filter(admission => (
          !admission.workspaceKey
          || isSameOrDescendantPath(workspaceKey, admission.workspaceKey)
        ))
      : [];
    try {
      await withBoundedWait(
        Promise.allSettled(relatedStarts.map(admission => admission.promise)),
        WORKTREE_DELETE_START_DRAIN_TIMEOUT_MS,
        `Worktree ${workspaceKey} Agent start drain`,
      );
    } catch (error) {
      return {
        workspace: workspaceKey,
        error: error.message || String(error),
      };
    }
    const inspected = await this.inspectForkWorktreeProject(workspace);
    if (inspected.error) return inspected;
    if (inspected.requiresForce && options.force !== true) {
      return {
        ...inspected,
        error: 'Worktree has uncommitted or untracked files',
      };
    }

    if (!operation) {
      const admission = this.persistentProjectOperation(requestId, 'delete-worktree', signature, {
        workspace: inspected.workspace,
        sourceWorkspace: inspected.sourceWorkspace,
        force: options.force === true,
      });
      if (admission.error) return { ...inspected, error: admission.error };
      operation = admission.operation;
    }

    const archivedAgentIds = [];
    const removedMainPageSessionKeys = [];
    const projectAgents = this.agentsForProjectWorkspace(inspected.workspace);
    for (const agent of projectAgents) {
      const result = await this.archiveAgent(agent.id, { requireEngineExit: true });
      if (result && !result.error) {
        archivedAgentIds.push(agent.id);
        removedMainPageSessionKeys.push(...(result.removedMainPageSessionKeys || []));
      } else {
        return {
          ...inspected,
          error: `Agent ${agent.id} could not be stopped before deleting the worktree: ${result?.error || 'Failed to archive Agent'}`,
          archivedAgentIds,
          removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
        };
      }
    }

    const args = ['-C', inspected.workspace, 'worktree', 'remove'];
    if (options.force === true) args.push('--force');
    args.push(inspected.workspace);
    try {
      await execFileAsync('git', args, {
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 4,
      });
    } catch (error) {
      const postcondition = await this.inspectGitWorktreePostcondition(
        inspected.sourceWorkspace,
        inspected.workspace,
      );
      if (postcondition.proven && !postcondition.exists && !postcondition.registered) {
        try {
          return commitDeleted({
            workspace: inspected.workspace,
            deleted: true,
            forced: options.force === true,
            archivedAgentIds,
            removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
          });
        } catch (commitError) {
          return {
            ...inspected,
            deleted: true,
            retryable: true,
            error: `Worktree was deleted, but Project operation commit failed: ${commitError.message || commitError}`,
            archivedAgentIds,
            removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
          };
        }
      }
      const message = error && error.stderr ? String(error.stderr).trim() : '';
      const detail = message || 'Failed to delete git worktree';
      if (operation) {
        const state = postcondition.proven && postcondition.exists && postcondition.registered
          ? 'failed'
          : 'unknown';
        try {
          this.commitPersistentProjectOperation(operation, state, null, detail);
        } catch {
          // Preserve the earlier durable pending intent when the result write fails.
        }
      }
      return {
        ...inspected,
        error: detail,
        ...(postcondition.proven && postcondition.exists && postcondition.registered
          ? {}
          : { uncertain: true }),
        archivedAgentIds,
        removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
      };
    }

    const postcondition = await this.inspectGitWorktreePostcondition(
      inspected.sourceWorkspace,
      inspected.workspace,
    );
    if (!postcondition.proven || postcondition.exists || postcondition.registered) {
      const detail = postcondition.error || 'Worktree deletion could not be proven';
      if (operation) {
        try {
          this.commitPersistentProjectOperation(operation, 'unknown', null, detail);
        } catch {
          // Preserve the earlier durable pending intent when the result write fails.
        }
      }
      return {
        ...inspected,
        error: `${detail}; the operation will not be replayed automatically`,
        uncertain: true,
        archivedAgentIds,
        removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
      };
    }
    try {
      return commitDeleted({
        workspace: inspected.workspace,
        deleted: true,
        forced: options.force === true,
        archivedAgentIds,
        removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
      });
    } catch (error) {
      return {
        ...inspected,
        deleted: true,
        retryable: true,
        error: `Worktree was deleted, but Project operation commit failed: ${error.message || error}`,
        archivedAgentIds,
        removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
      };
    }
  }

  async replayPersistentForkRequest(agent, requestId, signature) {
    const requestKey = `fork-request:${requestId}`;
    const operation = lifecycleJournal(agent).entries.find(candidate => (
      candidate.type === 'fork' && candidate.requestKey === requestKey
    ));
    if (!operation) return null;
    if (operation.request?.signature && operation.request.signature !== signature) {
      return { error: `Fork request ${requestId} was already used for different parameters` };
    }
    if (operation.state === 'succeeded' && operation.result) {
      return { ...operation.result, deduplicated: true };
    }
    if (TERMINAL_OPERATION_STATES.has(operation.state)) {
      return { error: operation.error || `Fork request ${requestId} finished with state ${operation.state}` };
    }

    const children = typeof this.configManager?.listAgentSessionRecords === 'function'
      ? this.configManager.listAgentSessionRecords().filter(record => (
          record?.parentAgentId === agent.id
          && record?.forkRequestId === requestId
          && record?.archived !== true
        ))
      : [];
    if (children.length === 1) {
      const child = children[0];
      const request = operation.request || {};
      const result = {
        agentId: child.runtimeAgentId,
        workspace: child.projectWorkspace || child.cwd || '',
        mode: request.mode || 'same-worktree',
        ...(request.targetRuntime ? { targetRuntime: request.targetRuntime } : {}),
        ...(child.providerSessionId ? { providerSessionId: child.providerSessionId } : {}),
        requestId,
      };
      try {
        this.completePersistentAgentOperation(agent, operation.id, result);
        return { ...result, deduplicated: true, reconciled: true };
      } catch (error) {
        return {
          ...result,
          error: `Fork exists, but its result could not be committed: ${error.message || error}`,
          retryable: true,
        };
      }
    }

    const detail = children.length > 1
      ? `Fork request ${requestId} has multiple child Agent records and cannot be reconciled safely`
      : `Fork request ${requestId} has an uncertain outcome and will not be replayed automatically`;
    if (operation.state !== 'blocked') {
      try {
        this.transitionPersistentAgentOperation(agent, operation.id, 'blocked', detail);
      } catch (error) {
        return { error: `${detail}; failed to persist blocked state: ${error.message || error}`, uncertain: true };
      }
    }
    return { error: detail, uncertain: true };
  }

  async forkAgent(agentId, mode = 'same-worktree', options = {}) {
    const requestId = String(options.requestId || '').trim().slice(0, 160);
    if (!requestId) return this.forkAgentUntracked(agentId, mode, options);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
      return { error: 'Fork requires a valid requestId' };
    }
    await this.whenRecovered();
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    const signature = projectOperationSignature({
      agentRecordId: agent.agentRecordId || agent.persistentSessionId || '',
      expectedRevision: Number.isSafeInteger(options.expectedRevision) ? options.expectedRevision : null,
      mode,
      targetRuntime: options.targetRuntime || '',
    });
    const key = `fork:${requestId}:${signature}`;
    const inFlight = this.agentLifecycleOperations.get(agentId);
    if (inFlight?.key === key) return inFlight.promise;
    const replay = await this.replayPersistentForkRequest(agent, requestId, signature);
    if (replay) return replay;
    return this.runAgentLifecycleOperation(
      agentId,
      key,
      'fork',
      'fork',
      async lifecycleToken => {
        const admission = this.beginPersistentAgentOperation(
          agent,
          'fork',
          `fork-request:${requestId}`,
          {
            signature,
            mode,
            targetRuntime: options.targetRuntime || '',
            expectedRevision: Number.isSafeInteger(options.expectedRevision) ? options.expectedRevision : null,
          },
        );
        if (admission.error) return { error: admission.error };
        const result = await this.forkAgentUntracked(agentId, mode, {
          ...options,
          requestId: '',
          forkRequestId: requestId,
          lifecycleToken,
        });
        if (result?.error) {
          try {
            this.transitionPersistentAgentOperation(
              agent,
              admission.operation.id,
              'blocked',
              result.error,
            );
          } catch (error) {
            return { ...result, error: `${result.error}; failed to persist Fork outcome: ${error.message || error}` };
          }
          return { ...result, requestId, uncertain: true };
        }
        const committedResult = { ...result, requestId };
        try {
          this.completePersistentAgentOperation(agent, admission.operation.id, committedResult);
          return committedResult;
        } catch (error) {
          return {
            ...committedResult,
            error: `Fork was created, but its result could not be committed: ${error.message || error}`,
            retainedAgentId: result.agentId,
            retryable: true,
          };
        }
      },
    );
  }

  async forkAgentUntracked(agentId, mode = 'same-worktree', options = {}) {
    await this.whenRecovered();
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent lifecycle changes are not accepted' };
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }
    if (!['same-worktree', 'new-worktree'].includes(mode)) {
      return { error: 'Unsupported fork mode' };
    }
    if (options.targetRuntime === 'chat') {
      if (mode !== 'same-worktree') {
        return { error: 'Conversation Fork supports only the same worktree' };
      }
      const expectedRevision = Number(options.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return { error: 'Conversation Fork requires an exact transcript revision' };
      }
      if (options.lifecycleToken) {
        return this.performAcpConversationFork(
          agentId,
          expectedRevision,
          options.lifecycleToken,
          options.forkRequestId || '',
        );
      }
      return this.runAgentLifecycleOperation(
        agentId,
        `conversation-fork:${expectedRevision}`,
        'conversation-fork',
        'conversation fork',
        lifecycleToken => this.performAcpConversationFork(agentId, expectedRevision, lifecycleToken, ''),
      );
    }
    if (agent.providerSessionProvider === 'codex' && agent.providerSessionTemporary === true) {
      await this.providerSessionService.resolveTemporaryCodex(agentId, { force: true });
      if (agent.providerSessionTemporary === true) {
        return { error: 'Fork requires a resumable Codex session. Try again after the session id is available.' };
      }
    }

    const sourceWorkspace = effectiveAgentWorkspaceRoot(agent);
    const resumedSession = agent.providerSessionProvider
      && agent.providerSessionId
      && agent.providerSessionTemporary !== true
      ? { provider: agent.providerSessionProvider, providerHomeId: agent.providerHomeId || 'default', sessionId: agent.providerSessionId }
      : resumedSessionFromSource(agent.source);
    if (resumedSession?.provider === 'codex') {
      const availability = await this.ensureCodexSessionAvailableForFork(agent, resumedSession, sourceWorkspace);
      if (availability?.error) return availability;
    }

    let targetWorkspace = sourceWorkspace;
    if (mode === 'new-worktree') {
      try {
        targetWorkspace = await this.createForkWorktree(sourceWorkspace);
      } catch (error) {
        return { error: error.message || 'Failed to create git worktree' };
      }
    }

    const forkCommand = resumedSession
      ? buildAgentSessionResumeCommand(resumedSession.provider, resumedSession.sessionId, {
        fork: true,
        cwd: targetWorkspace,
        providerHomePath: agent.providerHomePath || '',
      })
      : (agent.forkCommand || agent.command);

    return new Promise((resolve) => {
      this.startAgent(forkCommand, targetWorkspace, (forkedAgentId, error) => {
        if (error) {
          resolve({ error });
          return;
        }
        if (!forkedAgentId) {
          resolve({ error: 'Failed to start forked agent' });
          return;
        }
        resolve({
          agentId: forkedAgentId,
          workspace: targetWorkspace,
          mode,
        });
      }, {
        wantsMain: false,
        parentAgentId: agent.id,
        forkRequestId: options.forkRequestId || '',
        task: agent.task ? `Fork: ${agent.task}` : `Fork of ${agent.command}`,
        workflowTemplate: agent.workflowTemplate || '',
        source: mode === 'new-worktree' ? 'ui-fork-new-worktree' : 'ui-fork-same-worktree',
        providerHomeId: agent.providerHomeId || (resumedSession && resumedSession.providerHomeId) || '',
        providerHomePath: agent.providerHomePath || '',
        ...(resumedSession?.provider === 'codex'
          ? preserveCodexSessionProfileOptions()
          : {}),
      });
    });
  }

  async performAcpConversationFork(agentId, expectedRevision, lifecycleToken, forkRequestId = '') {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    if (runtimeKind(agent) !== 'acp') {
      return { error: 'Conversation Fork requires an ACP Chat Agent' };
    }
    const provider = String(agent.providerSessionProvider || '').trim();
    const sourceSessionId = String(agent.providerSessionId || '').trim();
    if (!provider || !isSafeProviderSessionId(sourceSessionId) || agent.providerSessionTemporary === true) {
      return { error: 'Conversation Fork requires a stable ACP provider session' };
    }

    const workspace = effectiveAgentWorkspaceRoot(agent);
    let acpSessionOptions = {};
    try {
      acpSessionOptions = this.acpRuntime.getSessionRequestOptions(agentId);
    } catch (error) {
      return { error: error.message || 'Failed to read ACP session options' };
    }

    if (providerAcpForkMode(provider) === 'target-process') {
      return this.performTargetProcessAcpConversationFork({
        agent,
        provider,
        sourceSessionId,
        workspace,
        expectedRevision,
        lifecycleToken,
        acpSessionOptions,
        forkRequestId,
      });
    }

    let forkedSessionId = '';
    try {
      const forked = await this.acpRuntime.forkSession(agentId, {
        ...acpSessionOptions,
        cwd: workspace,
        expectedRevision,
        requireLoad: true,
      });
      forkedSessionId = String(forked?.sessionId || '').trim();
    } catch (error) {
      return { error: error.message || 'Failed to fork ACP conversation' };
    }
    if (!isSafeProviderSessionId(forkedSessionId) || forkedSessionId === sourceSessionId) {
      return { error: 'ACP Conversation Fork did not return a distinct resumable session' };
    }

    const command = buildAgentSessionResumeCommand(provider, forkedSessionId, {
      cwd: workspace,
      providerHomePath: agent.providerHomePath || '',
    });
    if (!command) {
      return { error: 'Failed to build provider resume command for the forked ACP session' };
    }

    return new Promise(resolve => {
      let settled = false;
      const finish = async (forkedAgentId, error) => {
        if (settled) return;
        settled = true;
        if (error || !forkedAgentId) {
          let rollbackError = '';
          if (!forkedAgentId) {
            try {
              await this.acpRuntime.deleteSession(agentId, forkedSessionId);
            } catch (cleanupError) {
              rollbackError = cleanupError.message || String(cleanupError);
            }
          }
          resolve({
            error: [
              error || 'Failed to start forked ACP Chat Agent',
              rollbackError ? `forked session cleanup failed: ${rollbackError}` : '',
            ].filter(Boolean).join('; '),
            ...(forkedAgentId ? { retainedAgentId: forkedAgentId } : {}),
          });
          return;
        }
        resolve({
          agentId: forkedAgentId,
          workspace,
          mode: 'same-worktree',
          targetRuntime: 'chat',
          providerSessionId: forkedSessionId,
        });
      };

      try {
        const started = this.startAgent(command, workspace, finish, {
          wantsMain: false,
          parentAgentId: agent.id,
          forkRequestId,
          task: agent.task ? `Fork: ${agent.task}` : `Fork of ${agent.command}`,
          workflowTemplate: agent.workflowTemplate || '',
          source: 'ui-fork-acp-chat',
          providerHomeId: agent.providerHomeId || 'default',
          providerHomePath: agent.providerHomePath || '',
          providerSessionTitle: agent.providerSessionTitle || '',
          requiredCliVersion: provider === 'codex' ? (agent.requiredCliVersion || '') : '',
          projectWorkspace: workspace,
          agentRuntimeMode: 'chat',
          acpHistoryMode: 'load',
          runtimeSwitchVerifiedSessionId: forkedSessionId,
          forkedFromProviderSessionId: sourceSessionId,
          lifecycleToken,
          ...acpSessionOptions,
          ...(provider === 'codex'
            ? {
                codexApprovalMode: agent.launchPermissionMode || undefined,
                ...preserveCodexSessionProfileOptions(),
              }
            : {}),
          ...(provider === 'claude'
            ? { claudePermissionMode: agent.launchPermissionMode || undefined }
            : {}),
        });
        Promise.resolve(started).then(startedAgentId => {
          if (!startedAgentId) void finish(null, 'Failed to start forked ACP Chat Agent');
        }).catch(startError => {
          void finish(null, startError?.message || 'Failed to start forked ACP Chat Agent');
        });
      } catch (startError) {
        void finish(null, startError?.message || 'Failed to start forked ACP Chat Agent');
      }
    });
  }

  async performTargetProcessAcpConversationFork(options) {
    const {
      agent,
      provider,
      sourceSessionId,
      workspace,
      expectedRevision,
      lifecycleToken,
      acpSessionOptions,
      forkRequestId,
    } = options;
    const command = getProviderAdapter(provider)?.executable || provider;
    let preparedSessionId = '';
    let result;
    try {
      result = await this.acpRuntime.runWithForkReservation(
        agent.id,
        { expectedRevision, requireLoad: true },
        sourceBinding => {
          const forkSourceCheckpoint = this.acpRuntime.bindingCheckpoint(sourceBinding).exportCheckpoint();
          if (!forkSourceCheckpoint?.sessionState) {
            throw new Error('ACP fork source transcript is unavailable');
          }
          return new Promise(resolve => {
            let settled = false;
            const finish = (forkedAgentId, error) => {
              if (settled) return;
              settled = true;
              if (error || !forkedAgentId) {
                resolve({
                  error: error || 'Failed to start forked ACP Chat Agent',
                  ...(forkedAgentId ? { retainedAgentId: forkedAgentId } : {}),
                });
                return;
              }
              const forkedAgent = this.agents.get(forkedAgentId);
              const forkedSessionId = String(forkedAgent?.providerSessionId || preparedSessionId).trim();
              resolve({
                agentId: forkedAgentId,
                workspace,
                mode: 'same-worktree',
                targetRuntime: 'chat',
                providerSessionId: forkedSessionId,
              });
            };

            try {
              const started = this.startAgent(command, workspace, finish, {
                wantsMain: false,
                parentAgentId: agent.id,
                forkRequestId,
                task: agent.task ? `Fork: ${agent.task}` : `Fork of ${agent.command}`,
                workflowTemplate: agent.workflowTemplate || '',
                source: 'ui-fork-acp-chat',
                providerHomeId: agent.providerHomeId || 'default',
                providerHomePath: agent.providerHomePath || '',
                providerSessionTitle: agent.providerSessionTitle || '',
                projectWorkspace: workspace,
                agentRuntimeMode: 'chat',
                acpForkSourceSessionId: sourceSessionId,
                acpForkSourceCheckpoint: forkSourceCheckpoint,
                forkedFromProviderSessionId: sourceSessionId,
                lifecycleToken,
                ...acpSessionOptions,
                onAcpForkSessionCreated: sessionId => {
                  preparedSessionId = String(sessionId || '').trim();
                },
                onAcpSessionPrepared: prepared => {
                  preparedSessionId = String(prepared?.sessionId || '').trim();
                },
                ...(provider === 'claude'
                  ? { claudePermissionMode: agent.launchPermissionMode || undefined }
                  : {}),
              });
              Promise.resolve(started).then(startedAgentId => {
                if (!startedAgentId) void finish(null, 'Failed to start forked ACP Chat Agent');
              }).catch(startError => {
                void finish(null, startError?.message || 'Failed to start forked ACP Chat Agent');
              });
            } catch (startError) {
              void finish(null, startError?.message || 'Failed to start forked ACP Chat Agent');
            }
          });
        },
      );
    } catch (error) {
      return { error: error.message || 'Failed to fork ACP conversation' };
    }
    if (
      result?.error
      && !result.retainedAgentId
      && isSafeProviderSessionId(preparedSessionId)
    ) {
      try {
        await this.acpRuntime.deleteSession(agent.id, preparedSessionId);
      } catch (cleanupError) {
        result.retainedProviderSessionId = preparedSessionId;
        result.error = `${result.error}; forked session ${preparedSessionId} cleanup failed: ${cleanupError.message || cleanupError}`;
      }
    }
    return result;
  }

  enqueueCodexSessionMutation(sessionId, options, type, operation, joinSameType = false) {
    const providerHomeId = String(options?.providerHomeId || 'default').trim() || 'default';
    const key = JSON.stringify([providerHomeId, sessionId]);
    const current = this.codexSessionMutationQueues.get(key);
    if (joinSameType && current?.type === type) return current.promise;

    const previous = current?.promise || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const entry = { type, promise: next };
    this.codexSessionMutationQueues.set(key, entry);
    void next.finally(() => {
      if (this.codexSessionMutationQueues.get(key) === entry) {
        this.codexSessionMutationQueues.delete(key);
      }
    }).catch(() => {});
    return next;
  }

  ensureCodexSessionAvailable(sessionId, options = {}) {
    const providerHomeId = String(options.providerHomeId || 'default').trim() || 'default';
    const providerHomePath = String(options.providerHomePath || '').trim();
    return this.enqueueCodexSessionMutation(
      sessionId,
      { providerHomeId, providerHomePath },
      'unarchive',
      async () => {
        let session;
        try {
          session = await findAgentSession('codex', sessionId, {
            limit: 1000,
            providerLimit: 1000,
            scanLimit: 5000,
            providerHomeId,
            providerHomes: options.providerHomes || (providerHomePath
              ? { codex: [{ id: providerHomeId, path: providerHomePath }] }
              : undefined),
          });
        } catch (error) {
          return {
            error: `Failed to inspect Codex session before unarchiving: ${error && (error.message || error)}`,
          };
        }
        if (!session || session.archived !== true) return null;

        const result = await this.unarchiveCodexSession(sessionId, {
          ...session,
          cwd: options.cwd || session.cwd || session.workspace,
          providerHomePath: session.providerHomePath || providerHomePath,
        });
        return result?.error ? { error: result.error } : null;
      },
      true,
    );
  }

  async ensureCodexSessionAvailableForFork(agent, resumedSession, sourceWorkspace) {
    const providerHomeId = agent.providerHomeId || resumedSession.providerHomeId || 'default';
    const providerHomePath = agent.providerHomePath || '';
    const sessionId = resumedSession.sessionId;
    const result = await this.ensureCodexSessionAvailable(sessionId, {
      providerHomeId,
      providerHomePath,
      providerHomes: providerHomePath
        ? { codex: [{ id: providerHomeId, path: providerHomePath }] }
        : undefined,
      // Fork is an action on the live Farming Agent. Its current workspace is
      // authoritative even when the older provider history cwd no longer exists.
      cwd: sourceWorkspace,
    });
    if (!result?.error) return null;
    const detail = result.error.startsWith('Failed to inspect Codex session')
      ? result.error.replace('before unarchiving', 'before forking')
      : `Codex session ${sessionId} is archived and could not be unarchived before forking: ${result.error}`;
    return { error: detail };
  }

  recordTaskHistory(agent, options = {}) {
    if (!agent || agent.id === this.mainAgentId) return;
    if (!isSupportedHistoryAgent(agent.forkCommand || agent.command || '')) return;
    const providerHistorySource = agent.providerSessionProvider
      && agent.providerSessionId
      && agent.providerSessionTemporary !== true
      ? resumedAgentSource(agent.providerSessionProvider, agent.providerSessionId, agent.providerHomeId || '')
      : '';
    const entry = {
      id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId: agent.id,
      command: agent.command || '',
      cwd: agent.cwd || '',
      projectWorkspace: effectiveAgentWorkspaceRoot(agent),
      title: agent.customTitle || agent.sessionTitle || agent.task || '',
      customTitle: agent.customTitle || '',
      task: agent.task || '',
      workflowTemplate: agent.workflowTemplate || '',
      source: providerHistorySource || agent.source || 'ui',
      reason: options.reason || 'manual-kill',
      status: agent.status || 'stopped',
      startedAt: agent.startedAt || null,
      lastActivity: this.lastActivity.get(agent.id) || null,
      archivedAt: options.archivedAt || Date.now(),
    };
    this.taskHistory = [entry, ...this.taskHistory].slice(0, 200);
    if (this.configManager && this.configManager.appendTaskHistory) {
      this.configManager.appendTaskHistory(entry);
    }
  }

  archiveAgent(agentId, options = {}) {
    if (options.skipRecoveryWait !== true && !this.recoveryComplete) {
      return this.whenRecovered().then(() => this.archiveAgent(agentId, {
        ...options,
        skipRecoveryWait: true,
      }));
    }
    const inFlight = this.agentLifecycleOperations.get(agentId);
    if (inFlight) {
      return this.runAgentLifecycleOperation(
        agentId,
        'archive',
        'archive',
        'archive',
        lifecycleToken => this.performArchiveAgent(agentId, options, lifecycleToken),
      );
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return Promise.resolve({ error: 'Agent not found' });
    }
    if (agent.id === this.mainAgentId) {
      return Promise.resolve({ error: 'Main Agent cannot be archived' });
    }

    return this.runAgentLifecycleOperation(
      agentId,
      'archive',
      'archive',
      'archive',
      lifecycleToken => this.performArchiveAgent(agentId, options, lifecycleToken),
    );
  }

  async performArchiveAgent(agentId, options, lifecycleToken) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    const admission = this.beginPersistentAgentOperation(agent, 'archive', 'archive', {
      reason: options.reason || 'manual-archive',
      structuredProcessProofRequired: runtimeKind(agent) === 'acp',
    });
    if (admission.error) return { agentId, error: admission.error };
    const operationId = admission.operation.id;
    const killResult = await this.killAgent(agentId, {
      reason: options.reason || 'manual-archive',
      recordHistory: false,
      requireEngineExit: true,
      retainAgentRecord: true,
      emitUpdate: false,
      lifecycleToken,
      persistDeleteOperation: false,
      skipRecoveryWait: options.skipRecoveryWait === true,
    });
    if (killResult?.error) {
      try {
        this.transitionPersistentAgentOperation(agent, operationId, 'blocked', killResult.error);
      } catch (error) {
        return {
          ...killResult,
          error: `${killResult.error}; failed to persist blocked Archive: ${error.message || error}`,
        };
      }
      return { ...killResult, operationId };
    }
    let removedMainPageSessionKeys = [];
    try {
      this.transitionPersistentAgentOperation(agent, operationId, 'provider-archive-pending', '', {
        visibleOnMainPage: false,
        archived: true,
        archivedAt: Date.now(),
        runtimeAgentId: '',
      });
    } catch (error) {
      this.emit('update');
      return {
        agentId,
        error: `Agent stopped, but archive metadata could not be saved: ${error.message || error}`,
        stopped: true,
        archived: false,
        retryable: true,
        operationId,
        removedMainPageSessionKeys,
      };
    }
    agent.archived = true;
    agent.archivedAt = Date.now();
    let metadataWarning = '';
    try {
      removedMainPageSessionKeys = this.removeMainPageProviderSessionsForAgents([agent]);
    } catch (error) {
      metadataWarning = `Agent archived, but main-page membership cleanup failed: ${error.message || error}`;
      console.error(metadataWarning);
    }

    let historyWarning = '';
    if (!admission.joined && options.recordHistory !== false && !isEphemeralShellAgent(agent)) {
      const previousTaskHistory = this.taskHistory;
      try {
        this.recordTaskHistory(agent, {
          reason: options.reason || 'manual-archive',
          archivedAt: Date.now(),
        });
      } catch (error) {
        this.taskHistory = previousTaskHistory;
        historyWarning = `Agent stopped, but history could not be saved: ${error.message || error}`;
        console.error(historyWarning);
      }
    }
    if (options.scheduleProviderArchive !== false) {
      const providerArchive = await this.archiveCodexProviderSession(agent);
      if (providerArchive?.error) {
        try {
          this.transitionPersistentAgentOperation(agent, operationId, 'blocked', providerArchive.error, {
            visibleOnMainPage: false,
            archived: true,
            runtimeAgentId: '',
          });
        } catch (error) {
          return {
            agentId,
            archived: true,
            stopped: true,
            retryable: true,
            operationId,
            removedMainPageSessionKeys,
            error: `Provider archive failed: ${providerArchive.error}; failed to persist blocked Archive: ${error.message || error}`,
          };
        }
        this.emit('update');
        return {
          agentId,
          archived: true,
          stopped: true,
          providerArchived: false,
          retryable: true,
          operationId,
          removedMainPageSessionKeys,
          error: `Provider archive failed: ${providerArchive.error}`,
        };
      }
    }
    try {
      this.transitionPersistentAgentOperation(agent, operationId, 'succeeded', '', {
        visibleOnMainPage: false,
        archived: true,
        runtimeAgentId: '',
      });
    } catch (error) {
      this.emit('update');
      return {
        agentId,
        archived: true,
        stopped: true,
        providerArchived: true,
        retryable: true,
        operationId,
        removedMainPageSessionKeys,
        error: `Provider archive succeeded, but terminal Archive result could not be saved: ${error.message || error}`,
      };
    }
    this.forgetStoppedAgentRecord(agentId);
    return {
      agentId,
      archived: true,
      removed: true,
      operationId,
      removedMainPageSessionKeys,
      ...(
        metadataWarning || historyWarning
          ? { warning: [metadataWarning, historyWarning].filter(Boolean).join('; ') }
          : {}
      ),
    };
  }

  async archiveCodexProviderSession(agent) {
    if (
      !agent
      || agent.providerSessionProvider !== 'codex'
      || !agent.providerSessionId
      || agent.providerSessionTemporary === true
    ) {
      return null;
    }

    const sessionId = agent.providerSessionId;
    const session = {
      cliVersion: agent.cliVersion || '',
      cwd: agent.cwd || '',
      workspace: agent.projectWorkspace || '',
      providerHomePath: agent.providerHomePath || '',
    };
    try {
      const result = await this.enqueueCodexSessionMutation(
        sessionId,
        {
          providerHomeId: agent.providerHomeId || 'default',
          providerHomePath: agent.providerHomePath || '',
        },
        'archive',
        () => this.archiveCodexSession(sessionId, session),
        true,
      );
      return result?.error ? { error: result.error } : { archived: true };
    } catch (error) {
      return { error: error.message || String(error) };
    }
  }

  admitPersistentDelete(agent, options = {}) {
    const activeOperation = activeLifecycleOperation(agent);
    if (
      activeOperation?.type === 'create'
      && ['pending', 'blocked'].includes(activeOperation.state)
    ) {
      const previousJournal = lifecycleJournal(agent);
      try {
        transitionLifecycleOperation(
          agent,
          activeOperation.id,
          'cancelled',
          'Create was superseded by Delete',
        );
        const admittedDelete = beginLifecycleOperation(
          agent,
          'delete',
          'delete',
          {
            reason: options.reason || 'manual-kill',
            structuredProcessProofRequired: runtimeKind(agent) === 'acp',
          },
        );
        const persistentSessionId = this.ensurePersistentAgentSession(agent);
        if (
          typeof this.configManager?.ensureAgentSessionRecord === 'function'
          && !persistentSessionId
        ) {
          throw new Error('Agent session store did not return a persistent id');
        }
        return {
          operationId: admittedDelete.operation.id,
          completesBlockedCreate: false,
        };
      } catch (error) {
        agent.lifecycleJournal = previousJournal;
        return { error: `Failed to persist Create cleanup retry: ${error.message || error}` };
      }
    }
    const admitted = this.beginPersistentAgentOperation(agent, 'delete', 'delete', {
      reason: options.reason || 'manual-kill',
      structuredProcessProofRequired: runtimeKind(agent) === 'acp',
    });
    if (admitted.error) return { error: admitted.error };
    return {
      operationId: admitted.operation.id,
      completesBlockedCreate: false,
    };
  }

  async requestKillAgent(agentId, options = {}) {
    if (options.skipRecoveryWait !== true) await this.whenRecovered();
    const existing = this.agentLifecycleOperations.get(agentId);
    if (existing && existing.key !== 'kill') {
      await existing.promise.catch(() => {});
      return this.requestKillAgent(agentId, options);
    }
    const completion = this.killAgent(agentId, options);
    const operation = activeLifecycleOperation(this.agents.get(agentId));
    if (!operation || !['create', 'delete'].includes(operation.type)) {
      const result = await completion;
      return { result, completion: Promise.resolve(result) };
    }
    return {
      result: {
        agentId,
        accepted: true,
        operationId: operation.id,
        operationType: operation.type,
        operationState: operation.state,
      },
      completion,
    };
  }

  killAgent(agentId, options = {}) {
    if (options.skipRecoveryWait !== true && !this.recoveryComplete) {
      return this.whenRecovered().then(() => this.killAgent(agentId, {
        ...options,
        skipRecoveryWait: true,
      }));
    }
    const inFlight = this.agentLifecycleOperations.get(agentId);
    if (inFlight) {
      if (options.lifecycleToken && inFlight.token === options.lifecycleToken) {
        return this.performKillAgent(agentId, options);
      }
      return this.runAgentLifecycleOperation(
        agentId,
        'kill',
        'kill',
        'kill',
        lifecycleToken => {
          const agent = this.agents.get(agentId);
          if (!agent) return { agentId, killed: true, missing: true };
          let queuedOptions = options;
          if (options.persistDeleteOperation !== false && !options.persistentOperationId) {
            const admitted = this.admitPersistentDelete(agent, options);
            if (admitted.error) return { agentId, error: admitted.error };
            queuedOptions = {
              ...options,
              persistentOperationId: admitted.operationId,
              completesBlockedCreate: admitted.completesBlockedCreate,
            };
          }
          return this.performKillAgent(agentId, { ...queuedOptions, lifecycleToken });
        },
      );
    }
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.resolve({ agentId, killed: true, missing: true });
    let admittedOptions = options;
    if (options.persistDeleteOperation !== false && !options.persistentOperationId) {
      const admitted = this.admitPersistentDelete(agent, options);
      if (admitted.error) return Promise.resolve({ agentId, error: admitted.error });
      admittedOptions = {
        ...options,
        persistentOperationId: admitted.operationId,
        completesBlockedCreate: admitted.completesBlockedCreate,
      };
    }

    return this.runAgentLifecycleOperation(
      agentId,
      'kill',
      'kill',
      'kill',
      lifecycleToken => this.performKillAgent(agentId, { ...admittedOptions, lifecycleToken }),
    );
  }

  async performKillAgent(agentId, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return { agentId, killed: true, missing: true };

    let persistentOperationId = options.persistentOperationId || '';
    const completesBlockedCreate = options.completesBlockedCreate === true;
    const cleanupFailure = (message, kind = '') => {
      const error = String(message || 'Failed to stop Agent runtime');
      if (kind === 'acp' || kind === 'json') {
        return this.markStructuredAgentCleanupUncertain(
          agentId,
          kind,
          error,
          { operationId: persistentOperationId },
        );
      }
      agent.status = 'error';
      agent.engineStatus = 'cleanup-uncertain';
      if (persistentOperationId) {
        try {
          this.transitionPersistentAgentOperation(agent, persistentOperationId, 'blocked', error);
        } catch (persistError) {
          return {
            agentId,
            error: `${error}; failed to persist blocked Agent operation: ${persistError.message || persistError}`,
            cleanupUncertain: true,
            retryable: true,
          };
        }
      }
      this.emit('update');
      return { agentId, error, cleanupUncertain: true, retryable: true };
    };

    const requireEngineExit = options.requireEngineExit !== false;
    const currentRuntimeKind = runtimeKind(agent);
    if (!this.verifiedStoppedAgentIds.has(agentId)) {
      this.permissionRestartSuppressedAgentIds.add(agentId);
      try {
      if (currentRuntimeKind === 'acp') {
        if (typeof this.acpRuntime?.unregisterAgentAndWait !== 'function') {
          return cleanupFailure('ACP runtime exit cannot be verified', 'acp');
        }
        const stopped = await this.acpRuntime.unregisterAgentAndWait(agentId);
        if (stopped !== true) {
          if (!agent.structuredRuntimeProcess) {
            if (
              options.acknowledgeUnprovenAcpExit !== true
              || agent.requiresProcessExitAcknowledgement !== true
            ) {
              return cleanupFailure('ACP runtime binding is missing; process exit cannot be verified', 'acp');
            }
            const previousAcknowledgedAt = agent.legacyAcpProcessExitAcknowledgedAt;
            agent.legacyAcpProcessExitAcknowledgedAt = Date.now();
            agent.requiresProcessExitAcknowledgement = false;
            try {
              this.ensurePersistentAgentSession(agent);
            } catch (error) {
              agent.legacyAcpProcessExitAcknowledgedAt = previousAcknowledgedAt;
              agent.requiresProcessExitAcknowledgement = true;
              throw error;
            }
          } else {
            const cleanup = await this.stopPersistedAcpProcessGroup(agent.structuredRuntimeProcess);
            if (cleanup.stopped !== true) {
              return cleanupFailure(
                'ACP runtime binding is missing and the persisted process identity could not be safely stopped',
                'acp',
              );
            }
          }
        }
      } else if (currentRuntimeKind === 'json') {
        if (typeof this.jsonCliRuntime?.unregisterAgentAndWait !== 'function') {
          return cleanupFailure('JSON runtime exit cannot be verified', 'json');
        }
        const stopped = await this.jsonCliRuntime.unregisterAgentAndWait(agentId);
        if (stopped !== true) {
          return cleanupFailure('JSON runtime binding is missing; process exit cannot be verified', 'json');
        }
      } else {
        const engine = this.engineBridge.getEngine(agent.engineName);
        if (requireEngineExit && !engine) {
          return cleanupFailure('Agent runtime is unavailable; process exit cannot be verified');
        }
        let killError = null;
        try {
          if (engine) {
            await engine.killSession(agentId);
          }
        } catch (error) {
          console.error('Failed to kill agent:', error);
          killError = error;
        }

        if (requireEngineExit && engine) {
          const deadline = Date.now() + 3000;
          let lastState = null;
          while (Date.now() < deadline) {
            try {
              lastState = await engine.getSessionState(agentId);
            } catch (error) {
              if (isSessionNotAvailableError(error)) {
                lastState = null;
                break;
              }
              return cleanupFailure(error.message || 'Failed to verify Agent process exit');
            }
            if (!isLiveEngineSessionState(lastState)) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          if (isLiveEngineSessionState(lastState)) {
            return cleanupFailure(killError?.message || 'Agent process did not exit within 3 seconds');
          }
        } else if (killError) {
          return cleanupFailure(killError.message || 'Failed to stop Agent runtime');
        }
      }
      } catch (error) {
        if (currentRuntimeKind === 'acp' || currentRuntimeKind === 'json') {
          return cleanupFailure(error.message || 'Failed to stop Agent runtime', currentRuntimeKind);
        }
        return cleanupFailure(error.message || 'Failed to stop Agent runtime');
      } finally {
        this.permissionRestartSuppressedAgentIds.delete(agentId);
      }
    }
    if (currentRuntimeKind === 'acp' || currentRuntimeKind === 'json') {
      agent.structuredRuntimeProcess = null;
    }

    if (completesBlockedCreate) {
      try {
        this.transitionPersistentAgentOperation(
          agent,
          persistentOperationId,
          'failed',
          'Create runtime was stopped by Delete recovery',
        );
      } catch (error) {
        const message = `Agent stopped, but Create cleanup could not be committed: ${error.message || error}`;
        this.verifiedStoppedAgentIds.add(agentId);
        agent.status = 'stopped';
        agent.engineStatus = 'exited';
        this.emit('update');
        return {
          agentId,
          error: message,
          stopped: true,
          retryable: true,
          operationId: persistentOperationId,
        };
      }
      const admittedDelete = this.beginPersistentAgentOperation(agent, 'delete', 'delete', {
        reason: options.reason || 'manual-kill',
        structuredProcessProofRequired: runtimeKind(agent) === 'acp',
      });
      if (admittedDelete.error) {
        return { agentId, error: admittedDelete.error, stopped: true, retryable: true };
      }
      persistentOperationId = admittedDelete.operation.id;
    }

    if (persistentOperationId) {
      try {
        this.transitionPersistentAgentOperation(agent, persistentOperationId, 'succeeded', '', {
          visibleOnMainPage: false,
          archived: true,
          archivedAt: Date.now(),
          runtimeAgentId: '',
        });
        this.removeMainPageProviderSessionsForAgents([agent]);
      } catch (error) {
        const message = `Agent stopped, but Delete metadata could not be committed: ${error.message || error}`;
        console.error(message);
        this.verifiedStoppedAgentIds.add(agentId);
        agent.status = 'stopped';
        agent.engineStatus = 'exited';
        this.emit('update');
        return {
          agentId,
          error: message,
          stopped: true,
          retryable: true,
          operationId: persistentOperationId,
        };
      }
    }

    let historyWarning = '';
    if (options.recordHistory !== false && !isEphemeralShellAgent(agent)) {
      const previousTaskHistory = this.taskHistory;
      try {
        this.recordTaskHistory(agent, {
          reason: options.reason || 'manual-kill',
          archivedAt: Date.now(),
        });
      } catch (error) {
        this.taskHistory = previousTaskHistory;
        historyWarning = `Agent stopped, but history could not be saved: ${error.message || error}`;
        console.error(historyWarning);
      }
    }

    if (options.retainAgentRecord === true) {
      this.verifiedStoppedAgentIds.add(agentId);
      agent.status = 'stopped';
      agent.engineStatus = 'exited';
      if (options.emitUpdate !== false) this.emit('update');
      return {
        agentId,
        killed: true,
        retained: true,
        ...(historyWarning ? { warning: historyWarning } : {}),
      };
    }

    this.forgetStoppedAgentRecord(agentId, { emitUpdate: options.emitUpdate !== false });
    return {
      agentId,
      killed: true,
      ...(persistentOperationId ? { operationId: persistentOperationId } : {}),
      ...(historyWarning ? { warning: historyWarning } : {}),
    };
  }

  markStructuredAgentCleanupUncertain(agentId, kind, error, options = {}) {
    const agent = this.agents.get(agentId);
    const message = String(error || 'Agent runtime exit cannot be verified');
    if (agent) {
      agent.status = 'error';
      agent.engineStatus = 'cleanup-uncertain';
      const runtime = runtimeBindingOf(agent, kind);
      if (runtime) {
        runtime.state = 'error';
        runtime.error = message;
      }
      if (options.operationId) {
        try {
          this.transitionPersistentAgentOperation(agent, options.operationId, 'blocked', message);
        } catch (persistError) {
          return {
            agentId,
            error: `${message}; failed to persist blocked Agent operation: ${persistError.message || persistError}`,
            cleanupUncertain: true,
            retryable: true,
          };
        }
      }
      if (options.emitUpdate !== false) this.emit('update');
    }
    return {
      agentId,
      error: message,
      cleanupUncertain: true,
      retryable: true,
    };
  }

  forgetStoppedAgentRecord(agentId, options = {}) {
    this.agents.delete(agentId);
    this.verifiedStoppedAgentIds.delete(agentId);
    this.lastActivity.delete(agentId);
    this.lastActivityUpdate.delete(agentId);
    this.outputEvents.delete(agentId);
    this.agentUsageRateCache.delete(agentId);
    this.lastResizeByAgent.delete(agentId);
    this.providerSessionService.stop(agentId);
    if (this.jsonCliRuntime) this.jsonCliRuntime.unregisterAgent(agentId);
    if (this.acpRuntime) this.acpRuntime.unregisterAgent(agentId);

    if (this.mainAgentId === agentId) {
      this.mainAgentId = null;
    }
    
    if (options.emitUpdate !== false) this.emit('update');
  }

  async getAgentSessionText(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    const engine = this.engineBridge.getEngine(agent.engineName);
    if (!engine) {
      return agent.output;
    }

    try {
      const sessionState = await engine.getSessionState(agentId);
      if (isLiveEngineSessionState(sessionState) && this.reviveAgentRuntime(agent, sessionState)) {
        this.emit('update');
      }
      if (sessionState && typeof sessionState.output === 'string') {
        return sessionState.output;
      }
      if (!sessionState && isRunningAgentRuntimeStatus(agent.status) && !this.shouldDeferMissingEngineSession(agent)) {
        this.markAgentSessionDead(agentId, 'Session not available');
      }
    } catch (error) {
      console.error('Failed to read session text:', error);
      if (isSessionNotAvailableError(error) && !this.shouldDeferMissingEngineSession(agent)) {
        this.markAgentSessionDead(agentId, error);
      }
    }

    return agent.output;
  }

  getAgentWorkspaceRoot(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    return effectiveAgentWorkspaceRoot(agent);
  }

  getAgentProviderSession(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return {
      provider: agent.providerSessionProvider || '',
      sessionId: agent.providerSessionId || '',
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      runtimeBinding: publicRuntimeBinding(agent),
      temporary: agent.providerSessionTemporary === true,
      title: agent.providerSessionTitle || '',
    };
  }

  async getAgentSessionView(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    const engine = this.engineBridge.getEngine(agent.engineName);
    let sessionState = null;

    if (engine && engine.getSessionState) {
      try {
        sessionState = await engine.getSessionState(agentId);
        if (isLiveEngineSessionState(sessionState) && this.reviveAgentRuntime(agent, sessionState)) {
          this.emit('update');
        }
        if (!sessionState && isRunningAgentRuntimeStatus(agent.status) && !this.shouldDeferMissingEngineSession(agent)) {
          this.markAgentSessionDead(agentId, 'Session not available');
        }
      } catch (error) {
        console.error('Failed to read session state:', error);
        if (isSessionNotAvailableError(error) && !this.shouldDeferMissingEngineSession(agent)) {
          this.markAgentSessionDead(agentId, error);
        }
      }
    }

    const fallbackOutput = agent.output || '';
    const fallbackPreview = agent.previewText || fallbackOutput.slice(-2000);
    const lastActivity = this.lastActivity.get(agentId) || Date.now();
    const terminalBusy = sessionState && typeof sessionState.terminalBusy === 'boolean'
      ? sessionState.terminalBusy
      : (typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null);
    const shellCommand = sessionState && typeof sessionState.shellCommand === 'string'
      ? sessionState.shellCommand
      : (agent.shellCommand || '');
    const shellLastCommand = sessionState && typeof sessionState.shellLastCommand === 'string'
      ? sessionState.shellLastCommand
      : (agent.shellLastCommand || '');
    const shellCommandStartedAt = sessionState && Object.prototype.hasOwnProperty.call(sessionState, 'shellCommandStartedAt')
      ? finiteNumberOrNull(sessionState.shellCommandStartedAt)
      : finiteNumberOrNull(agent.shellCommandStartedAt);
    const shellLastCommandStartedAt = sessionState && Object.prototype.hasOwnProperty.call(sessionState, 'shellLastCommandStartedAt')
      ? finiteNumberOrNull(sessionState.shellLastCommandStartedAt)
      : finiteNumberOrNull(agent.shellLastCommandStartedAt);
    const shellLastCommandFinishedAt = sessionState && Object.prototype.hasOwnProperty.call(sessionState, 'shellLastCommandFinishedAt')
      ? finiteNumberOrNull(sessionState.shellLastCommandFinishedAt)
      : finiteNumberOrNull(agent.shellLastCommandFinishedAt);
    const shellLastCommandDurationMs = sessionState && Object.prototype.hasOwnProperty.call(sessionState, 'shellLastCommandDurationMs')
      ? finiteNumberOrNull(sessionState.shellLastCommandDurationMs)
      : finiteNumberOrNull(agent.shellLastCommandDurationMs);
    const previewText = (sessionState && typeof sessionState.previewText === 'string') ? sessionState.previewText : fallbackPreview;
    const sessionTitle = (sessionState && typeof sessionState.title === 'string' && sessionState.title) || agent.sessionTitle || '';
    const terminalStatus = (sessionState && sessionState.terminalStatus) || deriveAgentTerminalStatus(agent, {
      terminalBusy,
      status: sessionState && sessionState.status ? sessionState.status : terminalRuntimeStatus(agent.status),
      title: sessionTitle,
      previewText,
      cwd: (sessionState && sessionState.terminalStatus && sessionState.terminalStatus.cwd) || agent.shellCwd || agent.cwd,
      shellCommand,
      shellLastCommand,
      shellCommandStartedAt,
      shellLastCommandStartedAt,
      shellLastCommandFinishedAt,
      shellLastCommandDurationMs,
    });

    const now = Date.now();
    const isMain = this.isMainAgentRecord(agent.id, agent);
    return {
      agentId: agent.id,
      command: agent.command,
      engineName: agent.engineName || '',
      cwd: agent.cwd,
      projectWorkspace: agent.projectWorkspace || '',
      gitWorktree: publicAgentGitWorktree(agent),
      status: sessionState && sessionState.status === 'exited'
        ? agent.status
        : (isLiveEngineSessionState(sessionState) ? 'running' : agent.status),
      terminalBusy,
      terminalStatus,
      shellCommand,
      shellLastCommand,
      shellCommandStartedAt,
      shellLastCommandStartedAt,
      shellLastCommandFinishedAt,
      shellLastCommandDurationMs,
      parentAgentId: agent.parentAgentId || '',
      task: agent.task || '',
      workflowTemplate: agent.workflowTemplate || '',
      source: agent.source || '',
      providerSessionProvider: agent.providerSessionProvider || '',
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      providerSessionId: agent.providerSessionId || '',
      providerSessionKey: agent.providerSessionKey || '',
      providerSessionTemporary: agent.providerSessionTemporary === true,
      providerSessionSource: agent.providerSessionSource || '',
      providerSessionResolvedAt: agent.providerSessionResolvedAt || null,
      providerSessionTitle: agent.providerSessionTitle || '',
      providerSessionWorkspace: agent.providerSessionWorkspace || '',
      terminalInputReceived: agent.terminalInputReceived === true,
      runtimeBinding: publicRuntimeBinding(agent),
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
      customTitle: agent.customTitle || '',
      pinned: agent.pinned === true,
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(agent.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(agent.readAttentionAt),
      attentionReason: agent.attentionReason || '',
      attentionOutputEpoch: agent.attentionOutputEpoch || '',
      attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
      readOutputEpoch: agent.readOutputEpoch || '',
      readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
      unread: agentAttentionUnread(agent),
      archived: agent.archived === true,
      archivedAt: agent.archivedAt || null,
      sessionSource: this.getEngineSessionSource(agent.engineName),
      runtimeEpoch: sessionState && typeof sessionState.runtimeEpoch === 'string'
        ? sessionState.runtimeEpoch
        : (agent.runtimeEpoch || ''),
      outputSeq: sessionState && Number.isFinite(sessionState.outputSeq) ? sessionState.outputSeq : null,
      stateRevision: sessionState && Number.isFinite(sessionState.stateRevision)
        ? sessionState.stateRevision
        : null,
      isMain,
      activityLevel: isMain ? 'warm' : this.calculateActivityLevel(lastActivity, now),
      lastActivity,
      attentionScore: isMain ? 0 : this.calculateAttentionScore(agentId, now),
      isZombie: isMain ? false : this.isZombie(agentId, now),
      startedAt: (sessionState && sessionState.startedAt) || agent.startedAt || null,
      exitedAt: (sessionState && sessionState.exitedAt) || agent.exitedAt || null,
      sessionTitle,
      output: (sessionState && typeof sessionState.output === 'string') ? sessionState.output : fallbackOutput,
      renderOutput: (sessionState && typeof sessionState.renderOutput === 'string') ? sessionState.renderOutput : fallbackOutput,
      previewText,
      codexTerminalProfile: activeCodexTerminalProfile(agent, previewText),
      previewSnapshot: (sessionState && sessionState.previewSnapshot) || agent.previewSnapshot || null,
      previewCols: (sessionState && Number.isFinite(sessionState.previewCols) && sessionState.previewCols > 0)
        ? sessionState.previewCols
        : (agent.previewCols || 80),
      previewRows: (sessionState && Number.isFinite(sessionState.previewRows) && sessionState.previewRows > 0)
        ? sessionState.previewRows
        : (agent.previewRows || 30),
      usageRate: this.getAgentUsageRate(agent.id),
    };
  }

  getAgentUsageRate(agentId, options = {}) {
    const now = options.now || Date.now();
    const windowMs = options.windowMs || AGENT_USAGE_RATE_WINDOW_MS;
    const cached = this.agentUsageRateCache.get(agentId);
    if (
      cached
      && cached.windowMs === windowMs
      && now >= cached.sampledAt
      && now - cached.sampledAt < AGENT_USAGE_RATE_REFRESH_MS
    ) {
      return cached.value;
    }

    const value = this.calculateAgentUsageRate(agentId, { now, windowMs });
    this.agentUsageRateCache.set(agentId, { windowMs, sampledAt: now, value });
    return value;
  }

  calculateAgentUsageRate(agentId, options = {}) {
    const now = options.now || Date.now();
    const windowMs = options.windowMs || AGENT_USAGE_RATE_WINDOW_MS;
    const cutoff = now - windowMs;
    const events = (this.outputEvents.get(agentId) || []).filter(event => (
      event.timestamp >= cutoff && event.timestamp <= now + 1000
    ));
    if (events.length > 0) {
      this.outputEvents.set(agentId, events);
    } else {
      this.outputEvents.delete(agentId);
    }
    const outputBytes = events.reduce((sum, event) => sum + Math.max(0, event.bytes || 0), 0);
    const estimatedOutputTokens = Math.ceil(outputBytes / 4);
    const windowMinutes = Math.max(1, windowMs / 60_000);

    return {
      windowMs,
      outputBytes,
      estimatedOutputTokens,
      estimatedTokensPerMinute: Math.round((estimatedOutputTokens / windowMinutes) * 10) / 10,
      eventCount: events.length,
      sampledAt: now,
      source: 'terminal-output-estimate',
    };
  }

  getAgentUsageSnapshots(options = {}) {
    const now = options.now || Date.now();
    const windowMs = options.windowMs || AGENT_USAGE_RATE_WINDOW_MS;
    const agents = Array.from(this.agents.values()).map(agent => ({
      agentId: agent.id,
      command: agent.command,
      cwd: agent.cwd,
      isMain: this.isMainAgentRecord(agent.id, agent),
      status: agent.status,
      usageRate: this.getAgentUsageRate(agent.id, { now, windowMs }),
    }));
    const totalOutputBytes = agents.reduce((sum, agent) => sum + agent.usageRate.outputBytes, 0);
    const estimatedOutputTokens = agents.reduce((sum, agent) => sum + agent.usageRate.estimatedOutputTokens, 0);
    const windowMinutes = Math.max(1, windowMs / 60_000);

    return {
      windowMs,
      sampledAt: now,
      source: 'terminal-output-estimate',
      totalOutputBytes,
      estimatedOutputTokens,
      estimatedTokensPerMinute: Math.round((estimatedOutputTokens / windowMinutes) * 10) / 10,
      agents,
    };
  }
  
  getState() {
    const state = {
      mainAgentId: this.mainAgentId,
      agents: [],
      taskHistory: this.taskHistory
    };
    
    for (const [id, agent] of this.agents) {
      const now = Date.now();
      const lastActivity = this.lastActivity.get(id) || now;
      const isMain = this.isMainAgentRecord(id, agent);
      const terminalBusy = typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null;
      const terminalStatus = deriveAgentTerminalStatus(agent, {
        terminalBusy,
        status: terminalRuntimeStatus(agent.status),
        title: agent.sessionTitle || '',
        previewText: agent.previewText || '',
      });

      state.agents.push({
        id: agent.id,
        command: agent.command,
        engineName: agent.engineName || '',
        cwd: agent.cwd,
        projectWorkspace: canonicalWorkspacePath(agent.projectWorkspace || ''),
        gitWorktree: publicAgentGitWorktree(agent),
        output: agent.output.slice(-2000),
        previewText: agent.previewText || '',
        codexTerminalProfile: activeCodexTerminalProfile(agent, agent.previewText || ''),
        previewCols: agent.previewCols || 80,
        previewRows: agent.previewRows || 30,
        sessionTitle: agent.sessionTitle || '',
        sessionSource: this.getEngineSessionSource(agent.engineName),
        runtimeEpoch: agent.runtimeEpoch || '',
        outputSeq: finiteNumberOrNull(agent.lastOutputSeq),
        stateRevision: finiteNumberOrNull(agent.stateRevision),
        status: agent.status,
        terminalBusy,
        terminalStatus,
        shellCommand: agent.shellCommand || '',
        shellLastCommand: agent.shellLastCommand || '',
        shellCommandStartedAt: finiteNumberOrNull(agent.shellCommandStartedAt),
        shellLastCommandStartedAt: finiteNumberOrNull(agent.shellLastCommandStartedAt),
        shellLastCommandFinishedAt: finiteNumberOrNull(agent.shellLastCommandFinishedAt),
        shellLastCommandDurationMs: finiteNumberOrNull(agent.shellLastCommandDurationMs),
        isMain,
        parentAgentId: agent.parentAgentId || '',
        task: agent.task || '',
        workflowTemplate: agent.workflowTemplate || '',
        source: agent.source || '',
        providerSessionProvider: agent.providerSessionProvider || '',
        providerHomeId: agent.providerHomeId || '',
        providerHomePath: agent.providerHomePath || '',
        providerSessionId: agent.providerSessionId || '',
        providerSessionKey: agent.providerSessionKey || '',
        providerSessionTemporary: agent.providerSessionTemporary === true,
        providerSessionSource: agent.providerSessionSource || '',
        providerSessionResolvedAt: agent.providerSessionResolvedAt || null,
        providerSessionTitle: agent.providerSessionTitle || '',
        providerSessionWorkspace: agent.providerSessionWorkspace || '',
        providerCapabilities: {
          ...providerCapabilities(agent.providerSessionProvider),
          supportsSteer: runtimeBindingOf(agent, 'acp')?.supportsSteer === true,
        },
        terminalInputReceived: agent.terminalInputReceived === true,
        runtimeBinding: publicRuntimeBinding(agent),
        runtimeObservation: deriveRuntimeObservation(agent),
        lifecycleOperation: publicActiveLifecycleOperation(agent),
        requiresProcessExitAcknowledgement:
          agent.requiresProcessExitAcknowledgement === true,
        forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
        restartedFromAgentId: agent.restartedFromAgentId || '',
        restartedFromAgentIds: Array.isArray(agent.restartedFromAgentIds) ? agent.restartedFromAgentIds : [],
        launchPermissionMode: agent.launchPermissionMode || '',
        customTitle: agent.customTitle || '',
        pinned: agent.pinned === true,
        projectOrder: finiteOrder(agent.projectOrder),
        pinnedOrder: finiteOrder(agent.pinnedOrder),
        attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
        readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
        attentionUpdatedAt: finiteNumberOrNull(agent.attentionUpdatedAt),
        readAttentionAt: finiteNumberOrNull(agent.readAttentionAt),
        attentionReason: agent.attentionReason || '',
        attentionOutputEpoch: agent.attentionOutputEpoch || '',
        attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
        readOutputEpoch: agent.readOutputEpoch || '',
        readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
        unread: agentAttentionUnread(agent),
        archived: agent.archived === true,
        archivedAt: agent.archivedAt || null,
        canForkNewWorktree: this.canCreateForkWorktree(effectiveAgentWorkspaceRoot(agent)),
        startedAt: agent.startedAt || null,
        exitedAt: agent.exitedAt || null,
        // Main agent is exempt from activity/attention/zombie scoring
        activityLevel: isMain ? 'warm' : this.calculateActivityLevel(lastActivity, now),
        lastActivity,
        attentionScore: isMain ? 0 : this.calculateAttentionScore(id, now),
        isZombie: isMain ? false : this.isZombie(id, now),
        usageRate: this.getAgentUsageRate(id, { now })
      });
    }
    
    return state;
  }
  
  calculateActivityLevel(lastActivity, now) {
    const secondsSinceActivity = (now - lastActivity) / 1000;

    if (secondsSinceActivity < ACTIVITY_HOT_SEC) return 'hot';
    if (secondsSinceActivity < ACTIVITY_WARM_SEC) return 'warm';
    if (secondsSinceActivity < ACTIVITY_COOL_SEC) return 'cool';
    return 'cold';
  }

  isZombie(agentId, now) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== 'running') return false;
    if (this.isMainAgentRecord(agentId, agent)) return false;
    const lastAct = this.lastActivity.get(agentId) || now;
    return now - lastAct > ZOMBIE_IDLE_MS;
  }

  calculateAttentionScore(agentId, now) {
    const agent = this.agents.get(agentId);
    if (!agent) return 0;
    if (this.isMainAgentRecord(agentId, agent)) return 0;

    let score = 0;
    const lastAct = this.lastActivity.get(agentId) || now;
    const secsSinceActivity = (now - lastAct) / 1000;

    // Status weight (0-20)
    if (agent.status === 'running') score += 20;
    else if (agent.status === 'pending') score += 15;
    else if (agent.status === 'stopped') score += 5;

    // Recency (0-40)
    if (secsSinceActivity < ACTIVITY_HOT_SEC) score += 40;
    else if (secsSinceActivity < ACTIVITY_WARM_SEC) score += 30;
    else if (secsSinceActivity < ACTIVITY_COOL_SEC) score += 15;

    // Output rate (0-30) — based on events in last 30s
    const events = this.outputEvents.get(agentId) || [];
    const recentEvents = events.filter(e => (now - e.timestamp) < 30000);
    if (recentEvents.length > 0) {
      const eventsPerSec = recentEvents.length / 30;
      const totalBytes = recentEvents.reduce((sum, e) => sum + e.bytes, 0);
      const bytesPerSec = totalBytes / 30;
      score += Math.min(30, Math.round(eventsPerSec * 6 + bytesPerSec / 50));
    }

    // Zombie penalty
    if (this.isZombie(agentId, now)) {
      score = Math.max(0, score - 10);
    }

    return Math.min(100, Math.max(0, score));
  }

  getUptime() {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
  
  onSystemStats(callback) {
    this.on('system-stats', callback);
  }
  
  onUpdate(callback) {
    this.on('update', callback);
  }

  onAgentActivity(callback) {
    this.on('agent-activity', callback);
  }

  onSessionStream(callback) {
    this.on('session-stream', callback);
  }

  onSessionPreview(callback) {
    this.on('session-preview-update', callback);
  }

  getPreviewPayloads() {
    const previews = [];
    for (const agent of this.agents.values()) {
      if (!agent.previewText && !agent.previewSnapshot) {
        continue;
      }

      const terminalStatus = deriveAgentTerminalStatus(agent, {
        previewText: agent.previewText || '',
        title: agent.sessionTitle || '',
        terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
      });
      previews.push({
        agentId: agent.id,
        previewText: agent.previewText || '',
        cols: agent.previewCols || 80,
        rows: agent.previewRows || 30,
        previewSnapshot: agent.previewSnapshot || null,
        codexTerminalProfile: activeCodexTerminalProfile(agent, agent.previewText || ''),
        terminalStatus,
        runtimeObservation: deriveRuntimeObservation({ ...agent, terminalStatus }),
      });
    }

    return previews;
  }
}

module.exports = AgentManager;
module.exports.SESSION_OUTPUT_LIMIT = SESSION_OUTPUT_LIMIT;
module.exports.AGENT_USAGE_RATE_WINDOW_MS = AGENT_USAGE_RATE_WINDOW_MS;
module.exports.ZOMBIE_IDLE_MS = ZOMBIE_IDLE_MS;
module.exports.trimSessionOutput = trimSessionOutput;
