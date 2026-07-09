const EventEmitter = require('events');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const SystemMonitor = require('./system-monitor');
const SessionEngineBridge = require('./session-engine-bridge');
const { isSupportedHistoryAgent, resolveLaunchCommand } = require('./cli-agents');
const { buildAgentSessionResumeCommand, findAgentSession } = require('./agent-session-history');
const { listCodexSessions } = require('./codex-session-history');
const { buildAgentProviderSessionPlan, sessionFromExactResumeSource } = require('./agent-provider-session');
const { resolveAgentExecutable, resolveCompatibleCodexExecutable } = require('./executable-discovery');
const { ensureMainAgentSkillFiles, renderMainAgentBootstrap } = require('./main-agent-skills');
const { mainPageAgentSessionKey, resumedAgentSource } = require('./main-page-session');
const { isSafeProviderSessionId, isTemporaryProviderSessionId } = require('./provider-session-id');
const { deriveTerminalStatus } = require('./terminal-status');
const { CodexAppServerRuntime, normalizeCodexRuntimeMode } = require('./codex-app-server-runtime');
const { JsonCliRuntime } = require('./json-cli-runtime');
const { ensureCodexAppServerHome } = require('./codex-app-server-home');
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

const SESSION_OUTPUT_LIMIT = 10000;
const AGENT_USAGE_RATE_WINDOW_MS = 5 * 60 * 1000;
const ACTIVITY_UPDATE_INTERVAL_MS = 1000;
const ACTIVITY_HOT_SEC = 30 * 60;
const ACTIVITY_WARM_SEC = 3 * 60 * 60;
const ACTIVITY_COOL_SEC = 12 * 60 * 60;
const ZOMBIE_IDLE_MS = 72 * 60 * 60 * 1000;
const ZOMBIE_SWEEP_INTERVAL_MS = 60 * 1000;
const INPUT_SESSION_RETRY_DELAYS_MS = [25, 50, 100, 180, 300, 500];
const MISSING_ENGINE_SESSION_STARTUP_GRACE_MS = 5000;
const MIN_TERMINAL_RESIZE_COLS = 40;
const MIN_TERMINAL_RESIZE_ROWS = 10;
const CODEX_PROVIDER_SESSION_RESOLVE_COOLDOWN_MS = 1000;
const CODEX_PROVIDER_SESSION_MATCH_GRACE_MS = 30 * 1000;
const PROVIDER_SESSION_TITLE_RESOLVE_COOLDOWN_MS = 30 * 1000;
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
const execFileAsync = promisify(execFile);

function trimSessionOutput(output) {
  const text = typeof output === 'string' ? output : '';
  return text.length > SESSION_OUTPUT_LIMIT ? text.slice(-SESSION_OUTPUT_LIMIT) : text;
}

function hasResumeArg(args) {
  return Array.isArray(args)
    ? args.some(arg => arg === '--resume' || (typeof arg === 'string' && arg.startsWith('--resume=')))
    : false;
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
  const program = agentProgramName(command).toLowerCase();
  if (program === 'qodercli') return 'qoder';
  return ['codex', 'claude', 'opencode', 'qoder'].includes(program) ? program : '';
}

function hasUsableCodexAppServerHome(metadata) {
  const homePath = String(metadata?.codexAppServerHomePath || '').trim();
  return Boolean(homePath) && fs.existsSync(homePath);
}

function shouldRecoverAsCodexAppServer(metadata) {
  const provider = metadata?.providerSessionProvider || metadata?.provider || '';
  return provider === 'codex'
    && metadata?.codexRuntimeMode === 'app-server'
    && hasUsableCodexAppServerHome(metadata);
}

function isJsonCliAgent(agent) {
  return agent && agent.agentRuntimeMode === 'json';
}

function isShellProgram(command) {
  return ['bash', 'zsh', 'sh', 'fish'].includes(agentProgramName(command).toLowerCase());
}

function isEphemeralShellAgent(agent) {
  return agent && isShellProgram(agent.forkCommand || agent.command || '');
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

function shouldRecoverEngineSession(metadata) {
  if (!metadata) return false;
  if (metadata.category === 'shell') return false;
  return !isShellProgram(metadata.forkCommand || metadata.command || '');
}

function recoveredEngineSessionId(entry, metadata = {}) {
  return entry && (entry.sessionId || entry.agentId || metadata.agentId) || '';
}

function agentDisplayName(command) {
  const program = agentProgramName(command).toLowerCase();
  if (program === 'codex') return 'codex';
  if (program === 'claude') return 'claude code';
  return program;
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
  const program = agentProgramName(agent && agent.command);
  if (program === 'codex' || program === 'claude' || program === 'qodercli') {
    return '\x1b';
  }
  return '\x03';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePathValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
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

function isCodexAppServerAgent(agent) {
  return agent && agent.codexRuntimeMode === 'app-server';
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
    this.agents = new Map();
    this.mainAgentId = null;
    this.lastActivity = new Map();
    this.lastActivityUpdate = new Map();
    this.outputEvents = new Map(); // Map<agentId, Array<{timestamp, bytes}>> for rate tracking
    this.lastResizeByAgent = new Map();
    this.inputQueues = new Map();
    this.codexSessionResolveInFlight = new Map();
    this.codexSessionResolveLastAttemptAt = new Map();
    this.providerSessionTitleResolveInFlight = new Map();
    this.providerSessionTitleResolveLastAttemptAt = new Map();
    this.permissionRestartInFlight = new Map();
    this.permissionRestartSuppressedAgentIds = new Set();
    this.codexAppServerRuntime = options.codexAppServerRuntime || new CodexAppServerRuntime();
    this.jsonCliRuntime = options.jsonCliRuntime || new JsonCliRuntime();
    this.gitWorkspaceCache = new Map();
    this.heartbeatInterval = null;
    this.disposed = false;
    this.systemMonitor = new SystemMonitor();
    this.startTime = Date.now();
    this.engineBridge = new SessionEngineBridge(configManager);
    this.recoveryPromise = Promise.resolve();
    this.taskHistory = (this.configManager && this.configManager.getTaskHistory)
      ? [...this.configManager.getTaskHistory()]
      : [];
    this.lastZombieSweepAt = 0;
    this.startHeartbeat();
    this.bindEngineEvents();
    this.bindCodexAppServerRuntimeEvents();
    this.bindJsonCliRuntimeEvents();
    if (this.configManager && this.configManager.farmingDir) {
      this.recoveryPromise = this.recoverEngineSessions().catch((error) => {
        console.warn('Failed to recover engine sessions:', error && (error.message || error));
      });
    }
  }

  bindJsonCliRuntimeEvents() {
    if (!this.jsonCliRuntime || typeof this.jsonCliRuntime.on !== 'function') return;
    this.jsonCliRuntime.on('agent-runtime', ({ agentId, state, error, sessionId }) => {
      const agent = this.agents.get(agentId);
      if (!agent) return;
      agent.jsonCliState = state || '';
      agent.jsonCliError = error || '';
      if (sessionId) {
        agent.providerSessionId = sessionId;
        agent.providerSessionTemporary = false;
        agent.providerSessionKey = this.providerSessionKey(
          agent.providerSessionProvider,
          sessionId,
          agent.providerHomeId || 'default'
        );
        this.ensurePersistentAgentSession(agent);
      }
      this.lastActivity.set(agentId, Date.now());
      this.emit('update');
    });
    this.jsonCliRuntime.on('transcript', ({ agentId }) => {
      const agent = this.agents.get(agentId);
      if (!agent) return;
      agent.jsonCliEvents = this.jsonCliRuntime.getEvents(agentId);
      agent.jsonCliTranscriptUpdatedAt = new Date().toISOString();
      this.emit('update');
    });
  }

  bindCodexAppServerRuntimeEvents() {
    if (!this.codexAppServerRuntime || typeof this.codexAppServerRuntime.on !== 'function') return;
    this.codexAppServerRuntime.on('agent-runtime', ({ agentId, ...patch }) => {
      const agent = this.agents.get(agentId);
      if (!agent) return;

      if (typeof patch.threadId === 'string' && patch.threadId) {
        agent.codexAppServerThreadId = patch.threadId;
        agent.providerSessionId = patch.threadId;
        agent.providerSessionTemporary = false;
        agent.providerSessionKey = this.providerSessionKey(
          agent.providerSessionProvider || 'codex',
          patch.threadId,
          agent.providerHomeId || 'default'
        );
      }
      if (typeof patch.turnId === 'string') agent.codexAppServerTurnId = patch.turnId;
      if (typeof patch.state === 'string' && patch.state) agent.codexAppServerState = patch.state;
      if (typeof patch.error === 'string') agent.codexAppServerError = patch.error;
      if (typeof patch.pendingRequestId === 'string') agent.codexAppServerPendingRequestId = patch.pendingRequestId;
      if (typeof patch.pendingRequestMethod === 'string') agent.codexAppServerPendingRequestMethod = patch.pendingRequestMethod;
      if (Object.prototype.hasOwnProperty.call(patch, 'pendingRequest')) {
        agent.codexAppServerPendingRequest = patch.pendingRequest || null;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'notice')) {
        agent.codexAppServerNotice = patch.notice || null;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'goal')) {
        agent.codexAppServerGoal = patch.goal || null;
      }
      if (typeof patch.transcriptUpdatedAt === 'string') {
        agent.codexAppServerTranscriptUpdatedAt = patch.transcriptUpdatedAt;
      }

      if (patch.state === 'working' || patch.state === 'waiting-for-input') {
        this.lastActivity.set(agentId, Date.now());
      }
      this.emit('update');
    });
  }

  bindEngineEvents() {
    this.engineBridge.on('session-started', ({ sessionId, status, startedAt }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        agent.engineStarted = true;
        agent.engineStatus = status || 'running';
        agent.startedAt = startedAt || Date.now();
        this.observeAgentAttentionState(sessionId);
        this.observeAgentStateChange(sessionId, { force: true });
        this.emit('update');
      });

    this.engineBridge.on('session-output', ({ sessionId, data, engineName, outputSeq }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        this.reviveAgentRuntime(agent);
        agent.output = trimSessionOutput(agent.output + data);
        agent.lastEngineOutputAt = Date.now();
        if (Number.isFinite(outputSeq)) {
          agent.lastOutputSeq = outputSeq;
        }

        this.lastActivity.set(sessionId, Date.now());

        // Track output events for rate calculation
        const events = this.outputEvents.get(sessionId) || [];
        events.push({ timestamp: Date.now(), bytes: Buffer.byteLength(String(data), 'utf8') });
        const cutoff = Date.now() - AGENT_USAGE_RATE_WINDOW_MS;
        this.outputEvents.set(sessionId, events.filter(e => e.timestamp > cutoff));

        this.observeAgentAttentionState(sessionId);
        this.observeAgentStateChange(sessionId);
        const sessionSource = this.getEngineSessionSource(engineName);
        const stream = {
          agentId: sessionId,
          data,
          sessionSource,
        };
        if (Number.isFinite(outputSeq)) {
          stream.outputSeq = outputSeq;
        }
        this.emit('session-stream', stream);
      });

    this.engineBridge.on('session-sync', ({ sessionId, output, engineName, replaceLive = true, outputSeq }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        this.reviveAgentRuntime(agent);
        agent.output = trimSessionOutput(output);
        agent.previewText = agent.output.slice(-2000);
        if (Number.isFinite(outputSeq)) {
          agent.lastOutputSeq = outputSeq;
        }
        this.lastActivity.set(sessionId, Date.now());

        if (replaceLive) {
          const sessionSource = this.getEngineSessionSource(engineName);
          const stream = {
            agentId: sessionId,
            data: agent.output,
            sessionSource,
            replace: true,
          };
          if (Number.isFinite(outputSeq)) {
            stream.outputSeq = outputSeq;
          }
          this.emit('session-stream', stream);
        }
        this.observeAgentAttentionState(sessionId);
        this.observeAgentStateChange(sessionId);
        this.emit('update');
      });

    this.engineBridge.on('session-preview', ({ sessionId, previewText, cols, rows, previewSnapshot, title }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        const revived = this.reviveAgentRuntime(agent);
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
        this.emit('session-preview-update', {
          agentId: sessionId,
          previewText: agent.previewText,
          cols: agent.previewCols || 80,
          rows: agent.previewRows || 30,
          previewSnapshot: agent.previewSnapshot,
          terminalStatus: deriveAgentTerminalStatus(agent, {
            previewText: agent.previewText,
            title: agent.sessionTitle || '',
            terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
          }),
        });
        this.observeAgentAttentionState(sessionId);
        this.observeAgentStateChange(sessionId);
        if (titleChanged || revived) {
          this.emit('update');
        }
      });

    this.engineBridge.on('session-title', ({ sessionId, title }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        if (this.updateAgentSessionTitle(agent, title)) {
          this.observeAgentAttentionState(sessionId);
          this.observeAgentStateChange(sessionId);
          this.emit('update');
        }
      });

    this.engineBridge.on('session-activity', ({ sessionId, lastActivityAt }) => {
        const agent = this.agents.get(sessionId);
        const revived = agent ? this.reviveAgentRuntime(agent) : false;
        this.lastActivity.set(sessionId, lastActivityAt || Date.now());
        this.observeAgentAttentionState(sessionId);
        this.observeAgentStateChange(sessionId);
        this.emitActivityUpdate(sessionId, lastActivityAt || Date.now());
        if (revived) this.emit('update');
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
        } = payload;
        const agent = this.agents.get(sessionId);
        if (!agent) return;

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
        this.observeAgentAttentionState(sessionId);
        this.observeAgentStateChange(sessionId);
        this.emit('update');
      });

    this.engineBridge.on('session-exited', ({ sessionId, code, exitedAt }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;
        if (this.permissionRestartSuppressedAgentIds.has(sessionId)) return;

        // A fresh App Server thread deliberately has no CLI/PTy observer until
        // its first turn has completed and become resumable.  Native host
        // cleanup can still report an old/missing session id while that gap is
        // open; it is not an exit of the App Server Agent.
        if (isCodexAppServerAgent(agent)) return;

        if (!agent.validated) {
          this.stopCodexProviderSessionResolver(sessionId);
          this.stopProviderSessionTitleResolver(sessionId);
          this.agents.delete(sessionId);
          this.lastActivity.delete(sessionId);
          this.lastActivityUpdate.delete(sessionId);
          this.outputEvents.delete(sessionId);
          this.lastResizeByAgent.delete(sessionId);

          if (this.mainAgentId === sessionId) {
            this.mainAgentId = null;
          }

          this.emit('update');
          return;
        }

        this.stopCodexProviderSessionResolver(sessionId);
        this.stopProviderSessionTitleResolver(sessionId);
        agent.status = sessionId === this.mainAgentId ? 'dead' : 'stopped';
        agent.exitedAt = exitedAt || Date.now();
        agent.output = trimSessionOutput(`${agent.output}\nProcess exited with code ${code}`);
        this.observeAgentAttentionState(sessionId);
        this.observeAgentStateChange(sessionId, { force: true });
        if (sessionId !== this.mainAgentId) {
          this.recordTaskHistory(agent, {
            reason: 'process-exit',
            archivedAt: Date.now(),
          });
        }
        this.emit('update');
      });

    this.engineBridge.on('session-error', ({ sessionId, error, fatal = true }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;
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
    const persistedByRuntimeAgentId = new Map(persistedRecords
      .filter(record => record && record.runtimeAgentId)
      .map(record => [record.runtimeAgentId, record]));
    let changed = false;

    for (const entry of recovered || []) {
      const engineMetadata = entry.metadata || {};
      const state = entry.state || {};
      const agentId = recoveredEngineSessionId(entry, engineMetadata);
      const persisted = persistedByRuntimeAgentId.get(agentId);
      const metadata = persisted ? {
        ...engineMetadata,
        pinned: persisted.pinned === true,
        projectOrder: finiteOrder(persisted.projectOrder) ?? finiteOrder(engineMetadata.projectOrder),
        pinnedOrder: finiteOrder(persisted.pinnedOrder) ?? finiteOrder(engineMetadata.pinnedOrder),
      } : engineMetadata;
      if (!agentId || this.agents.has(agentId)) continue;
      if (!shouldRecoverEngineSession(metadata)) {
        await this.killRecoveredEngineSession(entry, metadata, agentId);
        continue;
      }

      const agentRecord = this.recoveredAgentRecord(agentId, entry.engineName || metadata.engineName || 'native', metadata, state);
      ensureAgentOrders(agentRecord, Array.from(this.agents.values()));
      agentRecord.lastObservedTurnActive = this.isAgentAttentionTurnActive(agentRecord);
      this.ensurePersistentAgentSession(agentRecord);
      this.agents.set(agentId, agentRecord);
      this.lastActivity.set(agentId, state.lastActivityAt || metadata.lastActivityAt || Date.now());
      if (agentRecord.wantsMain && !this.mainAgentId) {
        this.mainAgentId = agentId;
      }
      this.activateProviderSessionTracking(agentId);
      changed = true;
    }

    if (changed) {
      this.emit('update');
    }

    await this.recoverCodexAppServerSessions();
  }

  async recoverCodexAppServerSessions() {
    if (!this.codexAppServerRuntime || !this.configManager || typeof this.configManager.listAgentSessionRecords !== 'function') return;
    const records = this.configManager.listAgentSessionRecords();
    for (const record of records) {
      if (!record || record.archived === true || record.codexRuntimeMode !== 'app-server') continue;
      const agentId = String(record.runtimeAgentId || '').trim();
      const threadId = String(record.codexAppServerThreadId || record.providerSessionId || '').trim();
      const home = String(record.codexAppServerHomePath || '').trim();
      if (!agentId || !threadId || !home || !fs.existsSync(home)) {
        if (record.provider === 'codex' || record.providerSessionProvider === 'codex') {
          let agent = this.agents.get(agentId);
          if (!agent && agentId) {
            agent = this.recoveredAgentRecord(agentId, record.engine || 'native', record, { status: 'running' });
            agent.persistentSessionId = record.id || '';
          }
          if (agent) {
            ensureAgentOrders(agent, Array.from(this.agents.values()));
            agent.codexRuntimeMode = 'cli';
            agent.codexAppServerHomePath = '';
            agent.codexAppServerState = '';
            agent.codexAppServerEndpoint = '';
            agent.codexAppServerTurnId = '';
            agent.codexAppServerError = '';
            agent.codexAppServerPendingRequestId = '';
            agent.codexAppServerPendingRequestMethod = '';
            agent.codexAppServerPendingRequest = null;
            agent.codexCliObserverDeferred = false;
            this.ensurePersistentAgentSession(agent);
            this.updateEngineProviderSessionMetadata(agent);
          }
        }
        continue;
      }
      let agent = this.agents.get(agentId);
      if (!agent) {
        agent = this.recoveredAgentRecord(agentId, record.engine || 'native', record, { status: 'running' });
        ensureAgentOrders(agent, Array.from(this.agents.values()));
        agent.persistentSessionId = record.id || '';
        agent.engineStarted = false;
        this.agents.set(agentId, agent);
        this.lastActivity.set(agentId, Date.now());
      }
      try {
        // Remove a CLI observer recovered from pre-split metadata before the
        // structured runtime reconnects to this App Server Agent.
        await this.killRecoveredEngineSession({ engineName: agent.engineName }, record, agentId);
        const executable = resolveCompatibleCodexExecutable('').path || resolveAgentExecutable('codex') || 'codex';
        const binding = await this.codexAppServerRuntime.reattachAgent({
          agentId,
          threadId,
          codexHome: home,
          executable,
          env: this.buildAgentEnv(agentId, agent),
          cwd: agent.cwd,
          workspaceRoot: agent.projectWorkspace || agent.cwd,
          approvalMode: agent.launchPermissionMode || 'approve',
        });
        agent.codexAppServerThreadId = binding.threadId;
        agent.codexAppServerState = 'idle';
        agent.codexAppServerError = '';
        // App Server owns this runtime. It deliberately has no CLI/PTy
        // observer, so recovery cannot create a second reader or writer.
        agent.status = 'running';
        agent.engineStatus = 'running';
        agent.engineStarted = false;
        agent.codexCliObserverDeferred = false;
        agent.exitedAt = null;
        this.activateProviderSessionTracking(agentId);
        this.ensurePersistentAgentSession(agent);
      } catch (error) {
        agent.codexAppServerError = `Codex App Server recovery failed: ${error && (error.message || error)}`;
      }
    }
    this.emit('update');
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
  }

  recoveredAgentRecord(agentId, engineName, metadata, state) {
    const wantsMain = metadata.wantsMain === true;
    const providerSessionProvider = metadata.providerSessionProvider || metadata.provider || '';
    const recoverCodexAppServer = shouldRecoverAsCodexAppServer(metadata);
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
      task: metadata.task || '',
      workflowTemplate: metadata.workflowTemplate || '',
      source: metadata.source || 'recovered',
      providerSessionProvider,
      providerHomeId: metadata.providerHomeId || '',
      providerHomePath: metadata.providerHomePath || '',
      providerSessionId: metadata.providerSessionId || '',
      providerSessionKey: metadata.providerSessionKey || (
        providerSessionProvider && metadata.providerSessionId
          ? mainPageAgentSessionKey(providerSessionProvider, metadata.providerSessionId, metadata.providerHomeId || '')
          : ''
      ),
      providerSessionTemporary: metadata.providerSessionTemporary === true || isTemporaryProviderSessionId(metadata.providerSessionId),
      providerSessionSource: metadata.providerSessionSource || '',
      providerSessionResolvedAt: metadata.providerSessionResolvedAt || null,
      providerSessionTitle: metadata.providerSessionTitle || '',
      // Older persisted sessions predate App Server mode. Also, a Codex
      // App Server record without its isolated runtime home is not actually
      // attachable; recover it as terminal-owned CLI instead of leaving the
      // UI in a split state where the pane is terminal but Composer sends to
      // App Server.
      codexRuntimeMode: recoverCodexAppServer ? 'app-server' : 'cli',
      codexAppServerHomePath: recoverCodexAppServer ? metadata.codexAppServerHomePath : '',
      codexAppServerState: recoverCodexAppServer ? (metadata.codexAppServerState || '') : '',
      codexAppServerEndpoint: recoverCodexAppServer ? (metadata.codexAppServerEndpoint || '') : '',
      codexAppServerThreadId: metadata.codexAppServerThreadId || metadata.providerSessionId || '',
      codexAppServerTurnId: recoverCodexAppServer ? (metadata.codexAppServerTurnId || '') : '',
      codexAppServerError: recoverCodexAppServer ? (metadata.codexAppServerError || '') : '',
      codexAppServerPendingRequestId: recoverCodexAppServer ? (metadata.codexAppServerPendingRequestId || '') : '',
      codexAppServerPendingRequestMethod: recoverCodexAppServer ? (metadata.codexAppServerPendingRequestMethod || '') : '',
      codexAppServerPendingRequest: recoverCodexAppServer ? (metadata.codexAppServerPendingRequest || null) : null,
      codexCliObserverDeferred: false,
      forkedFromProviderSessionId: metadata.forkedFromProviderSessionId || '',
      restartedFromAgentId: metadata.restartedFromAgentId || '',
      restartedFromAgentIds: Array.isArray(metadata.restartedFromAgentIds)
        ? metadata.restartedFromAgentIds.filter(id => typeof id === 'string' && id)
        : [],
      persistentSessionId: metadata.persistentSessionId || '',
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
      attentionOutputSeq: finiteNumberOrNull(metadata.attentionOutputSeq),
      unread: finiteNonNegativeInteger(metadata.attentionSeq) > finiteNonNegativeInteger(metadata.readAttentionSeq),
      archived: false,
      archivedAt: null,
      canForkNewWorktree: this.canCreateForkWorktree(metadata.projectWorkspace || metadata.cwd || ''),
      validated: true,
      engineStarted: true,
      engineStatus: state.status || 'running',
      startedAt: state.startedAt || metadata.startedAt || Date.now(),
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
    if (isCodexAppServerAgent(agent)) return true;
    if (agent.engineStarted === false) return true;
    const startedAt = Number(agent.startedAt);
    return Number.isFinite(startedAt) && Date.now() - startedAt < MISSING_ENGINE_SESSION_STARTUP_GRACE_MS;
  }

  providerSessionKey(provider, sessionId, providerHomeId = '') {
    return provider && sessionId ? mainPageAgentSessionKey(provider, sessionId, providerHomeId) : '';
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
    const persistentSessionId = this.configManager.ensureAgentSessionRecord(agent, patch);
    if (persistentSessionId && !agent.persistentSessionId) {
      agent.persistentSessionId = persistentSessionId;
    }
    return persistentSessionId;
  }

  currentProviderSessionIds(provider, excludedAgentId = '', providerHomeId = 'default') {
    const ids = new Set();
    const normalizedHomeId = String(providerHomeId || 'default').trim() || 'default';
    for (const agent of this.agents.values()) {
      if (!agent || agent.id === excludedAgentId) continue;
      if (agent.providerSessionProvider !== provider) continue;
      if ((String(agent.providerHomeId || 'default').trim() || 'default') !== normalizedHomeId) continue;
      if (!agent.providerSessionId || agent.providerSessionTemporary === true) continue;
      ids.add(agent.providerSessionId);
    }
    return ids;
  }

  rememberMainPageProviderSession(agent) {
    if (!agent || agent.wantsMain) return;
    if (!agent.providerSessionProvider || !agent.providerSessionId || agent.providerSessionTemporary === true) return;
    if (!this.configManager) {
      return;
    }

    const sessionKey = this.providerSessionKey(agent.providerSessionProvider, agent.providerSessionId, agent.providerHomeId || '');
    if (!sessionKey) return;
    const currentKeys = this.getMainPageSessionKeys();
    if (currentKeys[0] === sessionKey) {
      this.ensurePersistentAgentSession(agent, { visibleOnMainPage: true, archived: false });
      return;
    }
    if (typeof this.configManager.rememberAgentSessionRecord === 'function') {
      const persistentSessionId = this.configManager.rememberAgentSessionRecord(agent);
      if (persistentSessionId) agent.persistentSessionId = persistentSessionId;
      return;
    }
    this.setMainPageSessionKeys([
      sessionKey,
      ...currentKeys.filter(key => key !== sessionKey),
    ]);
  }

  updateEngineProviderSessionMetadata(agent) {
    if (!agent || !agent.engineName) return;
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
      codexRuntimeMode: agent.codexRuntimeMode || '',
      codexAppServerHomePath: agent.codexAppServerHomePath || '',
      codexAppServerState: agent.codexAppServerState || '',
      codexAppServerEndpoint: agent.codexAppServerEndpoint || '',
      codexAppServerThreadId: agent.codexAppServerThreadId || '',
      codexAppServerTurnId: agent.codexAppServerTurnId || '',
      codexAppServerError: agent.codexAppServerError || '',
      codexAppServerPendingRequestId: agent.codexAppServerPendingRequestId || '',
      codexAppServerPendingRequestMethod: agent.codexAppServerPendingRequestMethod || '',
      codexAppServerPendingRequest: agent.codexAppServerPendingRequest || null,
      codexCliObserverDeferred: agent.codexCliObserverDeferred === true,
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
      launchPermissionMode: agent.launchPermissionMode || '',
      attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(agent.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(agent.readAttentionAt),
      attentionReason: agent.attentionReason || '',
      attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
    })).catch((error) => {
      console.warn('Failed to update provider session metadata:', error && (error.message || error));
    });
  }

  activateProviderSessionTracking(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.providerSessionProvider || !agent.providerSessionId) return;

    if (agent.providerSessionProvider === 'codex' && agent.providerSessionTemporary === true) {
      this.observeAgentStateChange(agentId, { force: true });
      return;
    }

    this.stopCodexProviderSessionResolver(agentId);
    this.updateEngineProviderSessionMetadata(agent);
    this.rememberMainPageProviderSession(agent);
    this.attemptProviderSessionTitleResolution(agentId, { force: true }).catch((error) => {
      console.warn('Failed to resolve provider session title:', error && (error.message || error));
    });
  }

  stopCodexProviderSessionResolver(agentId) {
    this.codexSessionResolveInFlight.delete(agentId);
    this.codexSessionResolveLastAttemptAt.delete(agentId);
  }

  stopProviderSessionTitleResolver(agentId) {
    this.providerSessionTitleResolveInFlight.delete(agentId);
    this.providerSessionTitleResolveLastAttemptAt.delete(agentId);
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
    agent.attentionOutputSeq = Number.isFinite(agent.lastOutputSeq) ? agent.lastOutputSeq : null;
    if (agent.attentionAutoReadNext === true) {
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

  markAgentReadCursor(agentId, readAttentionSeq) {
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
      this.emit('update');
    }
    return {
      agentId,
      attentionSeq,
      readAttentionSeq: agent.readAttentionSeq,
      unread: agent.unread,
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

  observeAgentStateChange(agentId, options = {}) {
    this.attemptCodexProviderSessionResolution(agentId, options).catch((error) => {
      console.warn('Failed to resolve Codex provider session:', error && (error.message || error));
    });
    this.attemptProviderSessionTitleResolution(agentId, options).catch((error) => {
      console.warn('Failed to resolve provider session title:', error && (error.message || error));
    });
  }

  attemptCodexProviderSessionResolution(agentId, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.providerSessionProvider !== 'codex' || agent.providerSessionTemporary !== true) {
      this.stopCodexProviderSessionResolver(agentId);
      return Promise.resolve(false);
    }

    const inFlight = this.codexSessionResolveInFlight.get(agentId);
    if (inFlight) return inFlight;

    const now = Date.now();
    const lastAttemptAt = this.codexSessionResolveLastAttemptAt.get(agentId) || 0;
    if (options.force !== true && now - lastAttemptAt < CODEX_PROVIDER_SESSION_RESOLVE_COOLDOWN_MS) {
      return Promise.resolve(false);
    }
    this.codexSessionResolveLastAttemptAt.set(agentId, now);

    const attempt = this.findCodexSessionForTemporaryAgent(agent)
      .then((session) => {
        if (!session || !session.id) return false;
        return this.resolveProviderSession(agentId, {
          provider: 'codex',
          sessionId: session.id,
          source: 'codex-rollout',
          title: session.title || '',
        });
      })
      .catch(() => false)
      .finally(() => {
        if (this.codexSessionResolveInFlight.get(agentId) === attempt) {
          this.codexSessionResolveInFlight.delete(agentId);
        }
      });
    this.codexSessionResolveInFlight.set(agentId, attempt);
    return attempt;
  }

  attemptProviderSessionTitleResolution(agentId, options = {}) {
    const agent = this.agents.get(agentId);
    if (
      !agent
      || !agent.providerSessionProvider
      || !agent.providerSessionId
      || agent.providerSessionTemporary === true
      || isTemporaryProviderSessionId(agent.providerSessionId)
      || String(agent.providerSessionTitle || '').trim()
    ) {
      this.stopProviderSessionTitleResolver(agentId);
      return Promise.resolve(false);
    }

    const inFlight = this.providerSessionTitleResolveInFlight.get(agentId);
    if (inFlight) return inFlight;

    const now = Date.now();
    const lastAttemptAt = this.providerSessionTitleResolveLastAttemptAt.get(agentId) || 0;
    if (options.force !== true && now - lastAttemptAt < PROVIDER_SESSION_TITLE_RESOLVE_COOLDOWN_MS) {
      return Promise.resolve(false);
    }
    this.providerSessionTitleResolveLastAttemptAt.set(agentId, now);

    const provider = agent.providerSessionProvider;
    const sessionId = agent.providerSessionId;
    const attempt = findAgentSession(provider, sessionId, { limit: 200, providerLimit: 200, providerHomeId: agent.providerHomeId || 'default', providerHomes: this.configManager && this.configManager.getSettings ? this.configManager.getSettings().agentHomes : undefined })
      .then((session) => {
        const title = String(session && session.title || '').trim().slice(0, 160);
        if (!title) return false;

        const current = this.agents.get(agentId);
        if (
          !current
          || current.providerSessionProvider !== provider
          || current.providerSessionId !== sessionId
          || current.providerSessionTemporary === true
          || String(current.providerSessionTitle || '').trim()
        ) {
          return false;
        }

        current.providerSessionTitle = title;
        this.ensurePersistentAgentSession(current);
        this.updateEngineProviderSessionMetadata(current);
        this.rememberMainPageProviderSession(current);
        this.emit('provider-session-updated', {
          agentId,
          provider,
          sessionId,
          title,
          temporary: false,
        });
        this.emit('update');
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (this.providerSessionTitleResolveInFlight.get(agentId) === attempt) {
          this.providerSessionTitleResolveInFlight.delete(agentId);
        }
      });
    this.providerSessionTitleResolveInFlight.set(agentId, attempt);
    return attempt;
  }

  async findCodexSessionForTemporaryAgent(agent) {
    const sessions = await listCodexSessions({ codexHome: agent.providerHomePath || undefined, limit: 100, scanLimit: 1000 });
    const workspace = normalizePathValue(agent.projectWorkspace || agent.cwd);
    const startedAt = Number(agent.startedAt) || 0;
    const claimedSessionIds = this.currentProviderSessionIds('codex', agent.id, agent.providerHomeId || 'default');
    const candidates = sessions
      .filter(session => {
        if (!session || !session.id || claimedSessionIds.has(session.id)) return false;
        const sessionWorkspace = normalizePathValue(session.workspace || session.cwd);
        if (workspace && !sessionWorkspace) return false;
        if (workspace && workspace !== sessionWorkspace) return false;
        const sessionTime = timestampMs(session.createdAt || session.updatedAt);
        if (!sessionTime || !startedAt) return true;
        return sessionTime >= startedAt - CODEX_PROVIDER_SESSION_MATCH_GRACE_MS;
      })
      .sort((a, b) => {
        const aTime = timestampMs(a.createdAt || a.updatedAt);
        const bTime = timestampMs(b.createdAt || b.updatedAt);
        const aDistance = startedAt && aTime ? Math.abs(aTime - startedAt) : Number.MAX_SAFE_INTEGER;
        const bDistance = startedAt && bTime ? Math.abs(bTime - startedAt) : Number.MAX_SAFE_INTEGER;
        if (aDistance !== bDistance) return aDistance - bDistance;
        return bTime - aTime;
      });

    return candidates[0] || null;
  }

  resolveProviderSession(agentId, { provider, sessionId, source, title }) {
    const agent = this.agents.get(agentId);
    if (!agent || !provider || !sessionId || isTemporaryProviderSessionId(sessionId)) return false;

    const previousSessionId = agent.providerSessionId || '';
    const providerSessionTitle = String(title || '').trim().slice(0, 160);
    agent.providerSessionProvider = provider;
    agent.providerSessionId = sessionId;
    agent.providerSessionKey = this.providerSessionKey(provider, sessionId, agent.providerHomeId || '');
    agent.providerSessionTemporary = false;
    agent.providerSessionSource = source || agent.providerSessionSource || '';
    agent.providerSessionResolvedAt = Date.now();
    if (providerSessionTitle) {
      agent.providerSessionTitle = providerSessionTitle;
    }

    this.stopCodexProviderSessionResolver(agentId);
    this.stopProviderSessionTitleResolver(agentId);
    this.ensurePersistentAgentSession(agent);
    this.updateEngineProviderSessionMetadata(agent);
    this.rememberMainPageProviderSession(agent);
    this.emit('provider-session-updated', {
      agentId,
      provider,
      sessionId,
      previousSessionId,
      temporary: false,
    });
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
    this.emit('update');
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

  resolveAgentShellEnv(shell = '') {
    const now = Date.now();
    const cacheKey = String(shell || '').trim() || '__default__';
    const cached = this.agentShellEnvCache.get(cacheKey);
    if (
      cached &&
      (this.agentShellEnvCacheMs === 0 || now - cached.resolvedAt < this.agentShellEnvCacheMs)
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
    env.FARMING_PROJECT_WORKSPACE = agent.projectWorkspace || '';

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
      if (provider === 'codex') env.CODEX_HOME = agent.codexAppServerHomePath || agent.providerHomePath;
      if (provider === 'claude') env.CLAUDE_CONFIG_DIR = agent.providerHomePath;
      if (provider === 'opencode') env.OPENCODE_CONFIG_DIR = agent.providerHomePath;
      if (provider === 'qoder') env.QODER_CONFIG_DIR = agent.providerHomePath;
    }

    return env;
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
    const workspaceHandle = path.resolve(sourceWorkspace);
    if (this.gitWorkspaceCache.has(workspaceHandle)) {
      return this.gitWorkspaceCache.get(workspaceHandle) === true;
    }

    let canFork = false;
    try {
      execFileSync('git', ['-C', sourceWorkspace, 'rev-parse', '--show-toplevel'], {
        stdio: 'ignore',
        timeout: 3000,
      });
      canFork = true;
    } catch {
      canFork = false;
    }

    this.gitWorkspaceCache.set(workspaceHandle, canFork);
    return canFork;
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

  async dispose(options = {}) {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.codexSessionResolveInFlight.clear();
    this.codexSessionResolveLastAttemptAt.clear();
    this.providerSessionTitleResolveInFlight.clear();
    this.providerSessionTitleResolveLastAttemptAt.clear();
    this.permissionRestartInFlight.clear();
    this.permissionRestartSuppressedAgentIds.clear();
    this.inputQueues.clear();
    if (this.codexAppServerRuntime && typeof this.codexAppServerRuntime.dispose === 'function') {
      this.codexAppServerRuntime.dispose();
    }
    if (this.jsonCliRuntime) {
      for (const agentId of this.agents.keys()) this.jsonCliRuntime.unregisterAgent(agentId);
    }
    if (this.engineBridge && typeof this.engineBridge.dispose === 'function') {
      await this.engineBridge.dispose({
        preserveHost: options.preserveTerminalHost === true,
      });
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
      mainWorkspace: agent.mainWorkspace || '',
      wantsMain: agent.wantsMain === true,
      category: agent.category,
      launchPermissionMode: agent.launchPermissionMode,
      parentAgentId: agent.parentAgentId || '',
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
      codexRuntimeMode: agent.codexRuntimeMode,
      agentRuntimeMode: agent.agentRuntimeMode || 'terminal',
      jsonCliState: agent.jsonCliState || '',
      jsonCliError: agent.jsonCliError || '',
      codexAppServerHomePath: agent.codexAppServerHomePath || '',
      codexAppServerState: agent.codexAppServerState,
      codexAppServerEndpoint: agent.codexAppServerEndpoint,
      codexAppServerThreadId: agent.codexAppServerThreadId,
      codexAppServerTurnId: agent.codexAppServerTurnId,
      codexAppServerError: agent.codexAppServerError,
      codexAppServerPendingRequestId: agent.codexAppServerPendingRequestId,
      codexAppServerPendingRequestMethod: agent.codexAppServerPendingRequestMethod,
      codexAppServerPendingRequest: agent.codexAppServerPendingRequest || null,
      codexCliObserverDeferred: agent.codexCliObserverDeferred === true,
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
      attentionOutputSeq: agent.attentionOutputSeq,
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
    });
  }

  async startAgent(command, customWorkspace, callback, options = {}) {
    if (options.wantsMain !== false) {
      await this.whenRecovered();
    }

    const wantsMain = options.wantsMain === true || (options.wantsMain !== false && !this.mainAgentId);
    if (wantsMain) {
      const existingMainStart = this.findActiveMainAgentStart();
      if (existingMainStart) {
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
      codexModel: this.configManager && this.configManager.getCodexModel
        ? this.configManager.getCodexModel()
        : 'gpt-5.5',
      codexReasoningEffort: this.configManager && this.configManager.getCodexReasoningEffort
        ? this.configManager.getCodexReasoningEffort()
        : 'xhigh',
      codexServiceTier: this.configManager && this.configManager.getCodexServiceTier
        ? this.configManager.getCodexServiceTier()
        : 'default',
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
    if (providerSessionPlan.source === 'resume-source' && hasResumeSource && !hasResumeArg(launch.args)) {
      providerSessionPlan = buildAgentProviderSessionPlan({
        command,
        program,
        args: launch.args,
        source: 'ui',
      });
    }

    let args = providerSessionPlan.args;
    let spawnProgram = resolveAgentExecutable(program) || program;
    if (path.basename(program) === 'codex') {
      const codexResolution = resolveCompatibleCodexExecutable(options.requiredCliVersion || '');
      if (!codexResolution.compatible) {
        if (callback) callback(null, codexResolution.error || 'Codex CLI is not compatible with this session');
        return null;
      }
      spawnProgram = codexResolution.path || spawnProgram;
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
    
    const logArgs = args.map((arg, index) => (
      index > 0 && args[index - 1] === '--append-system-prompt'
        ? '<farming-main-agent-bootstrap>'
        : arg
    ));
    console.log('Starting agent:', program, logArgs, 'workspace:', workspace, spawnProgram !== program ? `resolved: ${spawnProgram}` : '');
    
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
    
    const agentId = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
    const requestedCodexRuntimeMode = options.codexRuntimeMode === 'app-server' || options.codexRuntimeMode === 'cli'
      ? options.codexRuntimeMode
      : (this.configManager && typeof this.configManager.getCodexRuntimeMode === 'function'
        ? this.configManager.getCodexRuntimeMode()
        : 'cli');
    const useCodexAppServer = providerSessionPlan.provider === 'codex'
      && this.codexAppServerRuntime
      // The deterministic browser/server fixtures are terminal-only shims,
      // not an implementation of the Codex App Server protocol. App Server
      // behavior has its own mock runtime test; keep these legacy PTY tests
      // on the path they are designed to exercise.
      && process.env.FARMING_E2E_FAKE_EXECUTABLES !== '1'
      && normalizeCodexRuntimeMode(requestedCodexRuntimeMode) === 'app-server';
    const requestedAgentRuntimeMode = options.agentRuntimeMode === 'json' ? 'json' : 'terminal';
    const useJsonCli = requestedAgentRuntimeMode === 'json'
      && ['codex', 'opencode'].includes(providerSessionPlan.provider)
      && !useCodexAppServer
      && process.env.FARMING_E2E_FAKE_EXECUTABLES !== '1';
    let codexAppServerHomePath = '';
    if (useCodexAppServer) {
      try {
        codexAppServerHomePath = ensureCodexAppServerHome({
          configDir: this.configManager && this.configManager.farmingDir,
          agentId,
          sourceHome: providerHomePath || path.join(os.homedir(), '.codex'),
        });
      } catch (error) {
        if (callback) callback(null, error.message);
        return null;
      }
    }
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
      task: typeof options.task === 'string' ? options.task : '',
      workflowTemplate: typeof options.workflowTemplate === 'string' ? options.workflowTemplate : '',
      source: typeof options.source === 'string' ? options.source : 'ui',
      providerSessionProvider: providerSessionPlan.provider || '',
      providerHomeId: resolvedProviderHomeId,
      providerHomePath,
      providerSessionId: providerSessionPlan.id || '',
      providerSessionKey: this.providerSessionKey(providerSessionPlan.provider, providerSessionPlan.id, providerHome ? providerHome.id : providerHomeId),
      providerSessionTemporary: providerSessionPlan.temporary === true,
      providerSessionSource: providerSessionPlan.source || '',
      providerSessionResolvedAt: providerSessionPlan.temporary === true ? null : Date.now(),
      providerSessionTitle: typeof options.providerSessionTitle === 'string' ? options.providerSessionTitle.trim().slice(0, 160) : '',
      codexRuntimeMode: providerSessionPlan.provider === 'codex'
        ? (useCodexAppServer ? 'app-server' : 'cli')
        : '',
      agentRuntimeMode: useJsonCli ? 'json' : 'terminal',
      jsonCliState: useJsonCli ? 'idle' : '',
      jsonCliError: '',
      jsonCliTranscriptUpdatedAt: '',
      jsonCliEvents: Array.isArray(options.jsonCliEvents) ? options.jsonCliEvents : [],
      codexAppServerHomePath,
      codexAppServerState: useCodexAppServer ? 'connecting' : '',
      codexAppServerEndpoint: '',
      codexAppServerThreadId: '',
      codexAppServerTurnId: '',
      codexAppServerError: '',
      codexAppServerPendingRequestId: '',
      codexAppServerPendingRequestMethod: '',
      codexAppServerPendingRequest: null,
      codexCliObserverDeferred: false,
      forkedFromProviderSessionId: providerSessionPlan.forkedFromProviderSessionId || '',
      restartedFromAgentId: typeof options.restartedFromAgentId === 'string' ? options.restartedFromAgentId : '',
      restartedFromAgentIds: Array.isArray(options.restartedFromAgentIds)
        ? Array.from(new Set(options.restartedFromAgentIds.filter(id => typeof id === 'string' && id)))
        : [],
      persistentSessionId: '',
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
      pinned: false,
      projectOrder: finiteOrder(options.projectOrder),
      pinnedOrder: finiteOrder(options.pinnedOrder),
      attentionSeq: 0,
      readAttentionSeq: 0,
      attentionUpdatedAt: null,
      readAttentionAt: null,
      attentionReason: '',
      attentionOutputSeq: null,
      unread: false,
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

    ensureAgentOrders(agentRecord, Array.from(this.agents.values()));
    this.agents.set(agentId, agentRecord);

    this.lastActivity.set(agentId, Date.now());

    this.emit('update');

    try {
      if (useCodexAppServer) {
        try {
          const prepared = await this.codexAppServerRuntime.prepareAgent({
            agentId,
            codexHome: agentRecord.codexAppServerHomePath,
            executable: spawnProgram,
            env: this.buildAgentEnv(agentId, agentRecord),
            cwd: workspace,
            workspaceRoot: projectWorkspace || workspace,
            resumeThreadId: agentRecord.providerSessionTemporary ? '' : agentRecord.providerSessionId,
            temporaryThreadId: agentRecord.providerSessionTemporary ? agentRecord.providerSessionId : '',
            approvalMode: agentRecord.launchPermissionMode || (
              this.configManager && this.configManager.getCodexApprovalMode
                ? this.configManager.getCodexApprovalMode()
                : 'approve'
            ),
            model: this.configManager && this.configManager.getCodexModel
              ? this.configManager.getCodexModel()
              : 'gpt-5.5',
            reasoningEffort: this.configManager && this.configManager.getCodexReasoningEffort
              ? this.configManager.getCodexReasoningEffort()
              : 'xhigh',
            serviceTier: this.configManager && this.configManager.getCodexServiceTier
              ? this.configManager.getCodexServiceTier()
              : 'default',
            developerInstructions: wantsMain ? renderMainAgentBootstrap() : '',
          });
          agentRecord.providerSessionId = prepared.threadId;
          agentRecord.providerSessionKey = this.providerSessionKey(
            'codex',
            prepared.threadId,
            agentRecord.providerHomeId || 'default'
          );
          agentRecord.providerSessionTemporary = false;
          agentRecord.providerSessionSource = prepared.resumed ? 'app-server-resume' : 'app-server-start';
          agentRecord.providerSessionResolvedAt = Date.now();
          agentRecord.codexAppServerState = 'idle';
          agentRecord.codexAppServerEndpoint = prepared.endpoint;
          agentRecord.codexAppServerThreadId = prepared.threadId;
          agentRecord.codexAppServerError = '';
          // App Server mode has no embedded CLI observer. Its chat and
          // lifecycle both come from the structured App Server connection.
          agentRecord.codexCliObserverDeferred = false;
        } catch (error) {
          const reason = error && error.message ? error.message : String(error);
          throw new Error(`Codex App Server failed to start: ${reason}`, { cause: error });
        }
      }

      if (useJsonCli) {
        this.jsonCliRuntime.registerAgent({
          agentId,
          provider: providerSessionPlan.provider,
          executable: spawnProgram,
          env: this.buildAgentEnv(agentId, agentRecord),
          cwd: workspace,
          sessionId: agentRecord.providerSessionTemporary ? '' : agentRecord.providerSessionId,
          approvalMode: agentRecord.launchPermissionMode || 'approve',
          autoApprove: options.dangerouslySkipPermissions === true,
          initialEvents: agentRecord.jsonCliEvents,
        });
      }

      agentRecord.persistentSessionId = this.ensurePersistentAgentSession(agentRecord);
      if (!useCodexAppServer && !useJsonCli) {
        const engineLaunch = {
          command: spawnProgram,
          args,
          cwd: workspace,
          category: resolution.spec ? resolution.spec.category : 'shell',
        };
        await this.createAgentEngineSession(agentRecord, resolution.engine, engineLaunch);
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

      this.activateProviderSessionTracking(agentId);
      if (callback) callback(agentId);
      this.emit('update');
      return agentId;
    } catch (error) {
      console.error('Failed to start agent:', error);
      this.agents.delete(agentId);
      this.lastActivity.delete(agentId);
      this.lastActivityUpdate.delete(agentId);
      this.outputEvents.delete(agentId);
      this.lastResizeByAgent.delete(agentId);
      this.stopCodexProviderSessionResolver(agentId);
      if (this.codexAppServerRuntime && typeof this.codexAppServerRuntime.unregisterAgent === 'function') {
        this.codexAppServerRuntime.unregisterAgent(agentId);
      }

      if (this.mainAgentId === agentId) {
        this.mainAgentId = null;
      }

      this.emit('update');
      if (callback) callback(null, error.message);
      return null;
    }
  }
  
  async sendInput(agentId, input) {
    const previous = this.inputQueues.get(agentId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.sendInputNow(agentId, input));

    this.inputQueues.set(agentId, next);
    try {
      await next;
    } finally {
      if (this.inputQueues.get(agentId) === next) {
        this.inputQueues.delete(agentId);
      }
    }
  }

  codexAppServerOptionsForAgent(agent, message = '') {
    const codexResolution = resolveCompatibleCodexExecutable(agent.requiredCliVersion || '');
    if (!codexResolution.compatible) {
      throw new Error(codexResolution.error || 'Codex CLI is not compatible with App Server mode');
    }

    return {
      agentId: agent.id,
      codexHome: agent.codexAppServerHomePath || '',
      executable: codexResolution.path || resolveAgentExecutable(agent.command) || agent.command,
      env: this.buildAgentEnv(agent.id, agent),
      cwd: agent.cwd,
      workspaceRoot: agent.projectWorkspace || agent.cwd,
      threadId: agent.codexAppServerThreadId || agent.providerSessionId || '',
      approvalMode: agent.launchPermissionMode || (
        this.configManager && this.configManager.getCodexApprovalMode
          ? this.configManager.getCodexApprovalMode()
          : 'approve'
      ),
      model: this.configManager && this.configManager.getCodexModel
        ? this.configManager.getCodexModel()
        : 'gpt-5.5',
      reasoningEffort: this.configManager && this.configManager.getCodexReasoningEffort
        ? this.configManager.getCodexReasoningEffort()
        : 'xhigh',
      serviceTier: this.configManager && this.configManager.getCodexServiceTier
        ? this.configManager.getCodexServiceTier()
        : 'default',
      message,
    };
  }

  async sendComposerMessage(agentId, message) {
    const previous = this.inputQueues.get(agentId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.sendComposerMessageNow(agentId, message));

    this.inputQueues.set(agentId, next);
    try {
      return await next;
    } finally {
      if (this.inputQueues.get(agentId) === next) {
        this.inputQueues.delete(agentId);
      }
    }
  }

  async sendComposerMessageNow(agentId, message) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const text = String(message || '').trim();
    if (!text) throw new Error('Composer message is empty');

    if (
      agent.providerSessionProvider === 'codex'
      && agent.codexRuntimeMode === 'app-server'
      && this.codexAppServerRuntime
      && typeof this.codexAppServerRuntime.submitComposerMessage === 'function'
    ) {
      const result = await this.codexAppServerRuntime.submitComposerMessage(
        this.codexAppServerOptionsForAgent(agent, text)
      );
      agent.codexAppServerThreadId = result.threadId;
      agent.codexAppServerTurnId = result.turnId;
      agent.codexAppServerState = 'working';
      agent.codexAppServerError = '';
      this.lastActivity.set(agentId, Date.now());
      this.emit('update');
      return result;
    }

    if (isJsonCliAgent(agent)) {
      const result = await this.jsonCliRuntime.submitComposerMessage(agentId, text, {
        approvalMode: agent.launchPermissionMode || 'approve',
      });
      agent.providerSessionId = result.sessionId || agent.providerSessionId;
      agent.providerSessionTemporary = !agent.providerSessionId;
      this.ensurePersistentAgentSession(agent);
      return { kind: 'json', sessionId: agent.providerSessionId };
    }

    await this.sendInputNow(agentId, [{ type: 'paste', text }, '\r']);
    return { kind: 'terminal' };
  }

  respondToCodexAppServerRequest(agentId, requestId, result, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (agent.providerSessionProvider !== 'codex' || agent.codexRuntimeMode !== 'app-server') {
      throw new Error('This Agent is not using the Codex App Server runtime');
    }
    const resolvedRequestId = String(requestId || '');
    if (!resolvedRequestId || resolvedRequestId !== agent.codexAppServerPendingRequestId) {
      throw new Error('Codex App Server request is no longer pending');
    }
    if (!this.codexAppServerRuntime) throw new Error('Codex App Server runtime is unavailable');

    const response = options.reject === true
      ? this.codexAppServerRuntime.rejectAgentServerRequest(
        agentId,
        resolvedRequestId,
        { code: -32000, message: String(options.reason || 'Rejected by Farming') }
      )
      : this.codexAppServerRuntime.resolveAgentServerRequest(agentId, resolvedRequestId, result);
    agent.codexAppServerPendingRequestId = '';
    agent.codexAppServerPendingRequestMethod = '';
    agent.codexAppServerPendingRequest = null;
    agent.codexAppServerState = agent.codexAppServerTurnId ? 'working' : 'idle';
    this.emit('update');
    return response;
  }

  assertCodexAppServerGoalAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (agent.providerSessionProvider !== 'codex' || agent.codexRuntimeMode !== 'app-server') {
      throw new Error('This Agent is not using the Codex App Server runtime');
    }
    if (!this.codexAppServerRuntime) throw new Error('Codex App Server runtime is unavailable');
    if (!(agent.codexAppServerThreadId || agent.providerSessionId)) {
      throw new Error('Codex App Server thread id is not available yet');
    }
    return agent;
  }

  async getCodexAppServerGoal(agentId) {
    const agent = this.assertCodexAppServerGoalAgent(agentId);
    const goal = await this.codexAppServerRuntime.getAgentGoal(this.codexAppServerOptionsForAgent(agent));
    agent.codexAppServerGoal = goal || null;
    this.emit('update');
    return goal || null;
  }

  getCodexAppServerTranscript(agentId, options = {}) {
    const agent = this.assertCodexAppServerGoalAgent(agentId);
    if (!this.codexAppServerRuntime || typeof this.codexAppServerRuntime.getAgentTranscript !== 'function') {
      throw new Error('Codex App Server transcript is unavailable');
    }
    return this.codexAppServerRuntime.getAgentTranscript(agent.id, options);
  }

  getJsonCliTranscript(agentId, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (!isJsonCliAgent(agent)) throw new Error('Agent is not using the JSON CLI runtime');
    return this.jsonCliRuntime.getTranscript(agentId, options);
  }

  async setCodexAppServerGoal(agentId, patch = {}) {
    const agent = this.assertCodexAppServerGoalAgent(agentId);
    const objective = typeof patch.objective === 'string' ? patch.objective.trim().slice(0, 4000) : undefined;
    const status = typeof patch.status === 'string' ? patch.status : undefined;
    let tokenBudget;
    if (Object.prototype.hasOwnProperty.call(patch, 'tokenBudget')) {
      tokenBudget = Number.isFinite(Number(patch.tokenBudget)) && Number(patch.tokenBudget) > 0
        ? Math.floor(Number(patch.tokenBudget))
        : null;
    }
    if (objective !== undefined && !objective) {
      throw new Error('Codex goal objective is required');
    }
    const goal = await this.codexAppServerRuntime.setAgentGoal({
      ...this.codexAppServerOptionsForAgent(agent),
      ...(objective !== undefined ? { objective } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'tokenBudget') ? { tokenBudget } : {}),
    });
    agent.codexAppServerGoal = goal || null;
    this.emit('update');
    return goal || null;
  }

  async clearCodexAppServerGoal(agentId) {
    const agent = this.assertCodexAppServerGoalAgent(agentId);
    await this.codexAppServerRuntime.clearAgentGoal(this.codexAppServerOptionsForAgent(agent));
    agent.codexAppServerGoal = null;
    this.emit('update');
    return null;
  }

  async sendInputNow(agentId, input) {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    // The observer PTY is optional telemetry for App Server Agents. Its
    // disappearance must never redefine the App Server Agent as dead.
    if (isCodexAppServerAgent(agent) || isJsonCliAgent(agent)) return;

    const engine = this.engineBridge.getEngine(agent.engineName);
    if (!engine) return;

    for (let attempt = 0; ; attempt += 1) {
      try {
        await engine.sendInput(agentId, input);
        this.observeAgentStateChange(agentId, { force: true });
        return;
      } catch (error) {
        const delay = INPUT_SESSION_RETRY_DELAYS_MS[attempt];
        if (!isSessionNotAvailableError(error) || delay === undefined) {
          console.error('Failed to send input:', error);
          if (isSessionNotAvailableError(error)) {
            this.markAgentSessionDead(agentId, error);
          }
          return;
        }
        await sleep(delay);
      }
    }
  }

  markAgentSessionDead(agentId, error) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status === 'dead') return;
    if (isCodexAppServerAgent(agent)) return;

    const message = error && error.message ? error.message : String(error || 'Session not available');
    agent.status = 'dead';
    agent.engineStatus = 'dead';
    agent.terminalBusy = false;
    agent.exitedAt = Date.now();
    agent.output = trimSessionOutput(`${agent.output || ''}\n${message}`);
    this.observeAgentStateChange(agentId, { force: true });
    this.emit('update');
  }

  async interruptAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    try {
      if (
        agent.providerSessionProvider === 'codex'
        && agent.codexRuntimeMode === 'app-server'
        && this.codexAppServerRuntime
        && typeof this.codexAppServerRuntime.interruptAgent === 'function'
      ) {
        try {
          const interrupted = await this.codexAppServerRuntime.interruptAgent(agentId);
          if (interrupted) {
            agent.codexAppServerState = 'interrupting';
            this.emit('update');
            return;
          }
          agent.codexAppServerError = 'Codex App Server interrupt is not available';
          this.emit('update');
          return;
        } catch (error) {
          agent.codexAppServerError = `Codex App Server interrupt failed: ${error && (error.message || error)}`;
          this.emit('update');
          return;
        }
      }
      if (isJsonCliAgent(agent)) {
        this.jsonCliRuntime.interruptAgent(agentId);
        return;
      }
      const engine = this.engineBridge.getEngine(agent.engineName);
      if (!engine) return;

      const input = interruptInputForAgent(agent);
      if (engine.interruptSession) {
        await engine.interruptSession(agentId, input);
      } else {
        await engine.sendInput(agentId, input);
      }
    } catch (error) {
      console.error('Failed to interrupt agent:', error);
      if (isSessionNotAvailableError(error)) {
        this.markAgentSessionDead(agentId, error);
      }
    }
  }

  async resizeAgentSession(agentId, cols, rows) {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (isCodexAppServerAgent(agent)) return;

    const nextCols = Math.floor(Number(cols));
    const nextRows = Math.floor(Number(rows));
    if (
      !Number.isFinite(nextCols) ||
      !Number.isFinite(nextRows) ||
      nextCols < MIN_TERMINAL_RESIZE_COLS ||
      nextRows < MIN_TERMINAL_RESIZE_ROWS
    ) {
      return;
    }

    try {
      const previousSize = this.lastResizeByAgent.get(agentId);
      if (previousSize && previousSize.cols === nextCols && previousSize.rows === nextRows) {
        return;
      }

      const engine = this.engineBridge.getEngine(agent.engineName);
      if (!engine || !engine.resizeSession) return;

      const result = await engine.resizeSession(agentId, nextCols, nextRows);
      if (result && result.resized === false) {
        this.markAgentSessionDead(agentId, 'Session not available');
        return;
      }
      this.lastResizeByAgent.set(agentId, { cols: nextCols, rows: nextRows });
    } catch (error) {
      console.error('Failed to resize agent session:', error);
    }
  }

  async clearAgentSessionBuffer(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return { cleared: false };
    if (isCodexAppServerAgent(agent)) return { cleared: false };

    try {
      const engine = this.engineBridge.getEngine(agent.engineName);
      if (!engine || !engine.clearBuffer) return { cleared: false };
      const result = await engine.clearBuffer(agentId);
      if (result && result.cleared === false) {
        this.markAgentSessionDead(agentId, 'Session not available');
        return result;
      }
      agent.output = '';
      agent.previewText = '';
      agent.previewSnapshot = null;
      this.outputEvents.delete(agentId);
      this.lastActivity.set(agentId, Date.now());
      this.observeAgentStateChange(agentId, { force: true });
      this.emit('update');
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
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const customTitle = String(title || '').trim().slice(0, 80);
    agent.customTitle = customTitle;
    this.emit('update');
    return { agentId, customTitle };
  }

  setAgentTask(agentId, task) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const nextTask = String(task || '').trim().slice(0, 240);
    agent.task = nextTask;
    this.emit('update');
    return { agentId, task: nextTask };
  }

  updateAgentFlags(agentId, flags) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const updates = {};
    if (typeof flags.pinned === 'boolean') {
      const wasPinned = agent.pinned === true;
      agent.pinned = flags.pinned;
      updates.pinned = agent.pinned;
      if (!wasPinned && agent.pinned) {
        agent.pinnedOrder = nextPinnedOrder(Array.from(this.agents.values()));
      }
      updates.pinnedOrder = finiteOrder(agent.pinnedOrder);
    }

    if (typeof flags.unread === 'boolean') {
      const result = flags.unread
        ? this.markAgentUnreadCursor(agentId)
        : this.markAgentReadCursor(agentId);
      if (result.error) return result;
      updates.unread = result.unread;
      updates.attentionSeq = result.attentionSeq;
      updates.readAttentionSeq = result.readAttentionSeq;
    }

    if (typeof flags.readAttentionSeq === 'number' && Number.isFinite(flags.readAttentionSeq)) {
      const result = this.markAgentReadCursor(agentId, flags.readAttentionSeq);
      if (result.error) return result;
      updates.unread = result.unread;
      updates.attentionSeq = result.attentionSeq;
      updates.readAttentionSeq = result.readAttentionSeq;
    }

    if (flags.archived === true) {
      if (agent.id === this.mainAgentId) {
        return { error: 'Main Agent cannot be archived' };
      }
      return { error: 'Use archiveAgent to archive live agents' };
    }

    if (flags.archived === false) {
      agent.archived = false;
      agent.archivedAt = null;
      updates.archived = agent.archived;
      updates.archivedAt = agent.archivedAt;
    }

    if (typeof flags.pinned === 'boolean') {
      this.ensurePersistentAgentSession(agent);
      this.updateEngineProviderSessionMetadata(agent);
    }
    this.emit('update');
    return { agentId, ...updates };
  }

  reorderProjectAgent(agentId, { beforeAgentId = '', afterAgentId = '' } = {}) {
    const result = reorderedProjectAgentOrders(
      Array.from(this.agents.values()),
      agentId,
      String(beforeAgentId || ''),
      String(afterAgentId || ''),
    );
    if (result.error) return result;

    const updates = [];
    for (const [updatedAgentId, projectOrder] of result.updates) {
      const agent = this.agents.get(updatedAgentId);
      if (!agent) continue;
      agent.projectOrder = projectOrder;
      this.ensurePersistentAgentSession(agent);
      this.updateEngineProviderSessionMetadata(agent);
      updates.push({ agentId: updatedAgentId, projectOrder });
    }
    this.emit('update');
    return { agentId, projectOrder: finiteOrder(this.agents.get(agentId)?.projectOrder), updates };
  }

  reorderPinnedAgent(agentId, { beforeAgentId = '', afterAgentId = '' } = {}) {
    const result = reorderedPinnedAgentOrders(
      Array.from(this.agents.values()),
      agentId,
      String(beforeAgentId || ''),
      String(afterAgentId || ''),
    );
    if (result.error) return result;

    const updates = [];
    for (const [updatedAgentId, pinnedOrder] of result.updates) {
      const agent = this.agents.get(updatedAgentId);
      if (!agent) continue;
      agent.pinnedOrder = pinnedOrder;
      this.ensurePersistentAgentSession(agent);
      this.updateEngineProviderSessionMetadata(agent);
      updates.push({ agentId: updatedAgentId, pinnedOrder });
    }
    this.emit('update');
    return { agentId, pinnedOrder: finiteOrder(this.agents.get(agentId)?.pinnedOrder), updates };
  }

  reorderAgent(agentId, neighbors = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    return agent.pinned === true
      ? this.reorderPinnedAgent(agentId, neighbors)
      : this.reorderProjectAgent(agentId, neighbors);
  }

  async syncCodexTerminalPermissionMode(agentId, mode) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };

    if (
      agent.providerSessionProvider === 'codex'
      && agent.codexRuntimeMode === 'app-server'
    ) {
      return this.updateCodexAppServerPermissionMode(agentId, mode);
    }

    return this.restartAgentWithPermissionMode(agentId, mode);
  }

  async updateCodexAppServerPermissionMode(agentId, mode) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    if (agent.providerSessionProvider !== 'codex' || agent.codexRuntimeMode !== 'app-server') {
      return { error: 'Agent is not using the Codex App Server runtime' };
    }

    const nextMode = ['ask', 'approve', 'full', 'custom'].includes(mode) ? mode : '';
    if (!nextMode) return { error: 'Unsupported Codex permission mode' };
    if (!this.codexAppServerRuntime || typeof this.codexAppServerRuntime.updateAgentPermissionMode !== 'function') {
      return { error: 'Codex App Server permission updates are unavailable' };
    }

    try {
      await this.codexAppServerRuntime.updateAgentPermissionMode({
        ...this.codexAppServerOptionsForAgent(agent),
        approvalMode: nextMode,
      });
    } catch (error) {
      return { error: error && error.message ? error.message : 'Failed to update Codex App Server permissions' };
    }

    agent.launchPermissionMode = nextMode;
    agent.codexAppServerError = '';
    this.updateEngineProviderSessionMetadata(agent);
    this.ensurePersistentAgentSession(agent, { launchPermissionMode: nextMode });
    this.emit('update');
    return {
      agentId,
      updated: true,
      launchPermissionMode: nextMode,
    };
  }

  async restartAgentWithPermissionMode(agentId, mode) {
    const inFlight = this.permissionRestartInFlight.get(agentId);
    if (inFlight) {
      return inFlight.mode === mode
        ? inFlight.promise
        : { error: 'Permission change already in progress' };
    }

    const restart = this.performAgentPermissionRestart(agentId, mode);
    const entry = { mode, promise: restart };
    this.permissionRestartInFlight.set(agentId, entry);
    try {
      return await restart;
    } finally {
      if (this.permissionRestartInFlight.get(agentId) === entry) {
        this.permissionRestartInFlight.delete(agentId);
      }
    }
  }

  async restartAgentRuntimeMode(agentId, mode) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    const nextMode = mode === 'json' ? 'json' : mode === 'terminal' ? 'terminal' : '';
    if (!nextMode) return { error: 'Unsupported Agent runtime mode' };
    if (agent.agentRuntimeMode === nextMode) return { agentId, agentRuntimeMode: nextMode };
    const provider = agent.providerSessionProvider || '';
    if (!['codex', 'opencode'].includes(provider)) {
      return { error: 'Agent does not support JSON Chat runtime' };
    }
    const sessionId = String(agent.providerSessionId || '').trim();
    if (!isSafeProviderSessionId(sessionId)) {
      return { error: 'Runtime switching requires a resumable provider session. Send the first message and try again.' };
    }
    const providerSession = await this.findRuntimeSwitchSession(agent);
    if (!providerSession) {
      return { error: 'The saved Agent session is no longer available in the selected Agent Home.' };
    }
    const command = buildAgentSessionResumeCommand(provider, sessionId, {
      cwd: agent.cwd || agent.projectWorkspace || '',
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
        : (Array.isArray(agent.jsonCliEvents) ? agent.jsonCliEvents : []),
    };
    const restartOptions = {
      wantsMain: agent.wantsMain === true,
      task: agent.task || agent.providerSessionTitle || '',
      workflowTemplate: agent.workflowTemplate || '',
      projectWorkspace: agent.projectWorkspace || agent.cwd || '',
      source: resumedAgentSource(provider, sessionId, agent.providerHomeId || ''),
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
      codexRuntimeMode: 'cli',
      codexApprovalMode: agent.launchPermissionMode || undefined,
      jsonCliEvents: preserved.jsonCliEvents,
    };
    await this.killAgent(agentId, { reason: 'runtime-switch', recordHistory: false, emitUpdate: false });
    return new Promise(resolve => {
      const started = this.startAgent(command, agent.cwd || agent.projectWorkspace || null, (restartedAgentId, error) => {
        if (error || !restartedAgentId) {
          this.emit('update');
          resolve({ error: error || 'Failed to switch Agent runtime' });
          return;
        }
        const replacement = this.agents.get(restartedAgentId);
        if (replacement) {
          Object.assign(replacement, preserved);
          this.ensurePersistentAgentSession(replacement);
        }
        this.emit('update');
        resolve({
          agentId,
          restarted: true,
          restartedAgentId,
          agentRuntimeMode: nextMode,
        });
      }, restartOptions);
      Promise.resolve(started).catch(error => resolve({ error: error.message || 'Failed to switch Agent runtime' }));
    });
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

  async performAgentPermissionRestart(agentId, mode) {
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
    if (!hasResumableSession && !startsFreshCodexSession) {
      return { error: 'Permission changes require a resumable provider session. Try again after the session id is available.' };
    }

    const command = startsFreshCodexSession
      ? 'codex'
      : buildAgentSessionResumeCommand(provider, sessionId, {
        cwd: agent.cwd || agent.projectWorkspace || '',
      });
    if (!command) {
      return { error: 'Failed to build provider resume command' };
    }

    const restartOptions = {
      wantsMain: agent.wantsMain === true,
      task: agent.task || agent.providerSessionTitle || '',
      workflowTemplate: agent.workflowTemplate || '',
      requiredCliVersion: provider === 'codex' ? (agent.requiredCliVersion || '') : '',
      projectWorkspace: agent.projectWorkspace || agent.cwd || '',
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
      ...(provider === 'codex' ? { codexApprovalMode: nextMode } : { claudePermissionMode: nextMode }),
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

    this.permissionRestartSuppressedAgentIds.add(agentId);
    try {
      await this.killAgent(agentId, {
        reason: 'permission-restart',
        recordHistory: false,
        emitUpdate: false,
      });
    } finally {
      this.permissionRestartSuppressedAgentIds.delete(agentId);
    }

    return new Promise((resolve) => {
      const startResult = this.startAgent(command, agent.cwd || agent.projectWorkspace || null, (restartedAgentId, error) => {
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

  async createForkWorktree(workspace) {
    const sourceWorkspace = this.expandWorkspacePath(workspace);
    if (!sourceWorkspace) {
      throw new Error('Source workspace is empty');
    }

    let root;
    try {
      const { stdout } = await execFileAsync('git', ['-C', sourceWorkspace, 'rev-parse', '--show-toplevel'], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      root = stdout.trim();
    } catch (error) {
      const message = error && error.stderr ? String(error.stderr).trim() : '';
      throw new Error(message || 'Source workspace is not inside a git repository', { cause: error });
    }

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
      const { stdout } = await execFileAsync('git', ['-C', resolvedWorkspace, 'status', '--porcelain', '--untracked-files=all'], {
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 4,
      });
      const dirtyEntries = statusEntriesFromPorcelain(stdout);
      return {
        workspace: resolvedWorkspace,
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
      const agentWorkspace = this.expandWorkspacePath(agent.projectWorkspace || agent.cwd || '');
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
      const providerSessionKey = agent.providerSessionKey || this.providerSessionKey(
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

  async deleteForkWorktreeProject(workspace, options = {}) {
    const inspected = await this.inspectForkWorktreeProject(workspace);
    if (inspected.error) return inspected;
    if (inspected.requiresForce && options.force !== true) {
      return {
        ...inspected,
        error: 'Worktree has uncommitted or untracked files',
      };
    }

    const projectAgents = this.agentsForProjectWorkspace(inspected.workspace);
    const removedMainPageSessionKeys = this.removeMainPageProviderSessionsForAgents(projectAgents);
    const archivedAgentIds = [];
    for (const agent of projectAgents) {
      const result = await this.archiveAgent(agent.id);
      if (result && !result.error) archivedAgentIds.push(agent.id);
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
      const message = error && error.stderr ? String(error.stderr).trim() : '';
      return {
        ...inspected,
        archivedAgentIds,
        removedMainPageSessionKeys,
        error: message || 'Failed to delete git worktree',
      };
    }

    return {
      workspace: inspected.workspace,
      deleted: true,
      forced: options.force === true,
      archivedAgentIds,
      removedMainPageSessionKeys,
    };
  }

  async forkAgent(agentId, mode = 'same-worktree') {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const sourceWorkspace = agent.projectWorkspace || agent.cwd;
    let targetWorkspace = sourceWorkspace;
    if (mode === 'new-worktree') {
      try {
        targetWorkspace = await this.createForkWorktree(sourceWorkspace);
      } catch (error) {
        return { error: error.message || 'Failed to create git worktree' };
      }
    } else if (mode !== 'same-worktree') {
      return { error: 'Unsupported fork mode' };
    }

    const resumedSession = agent.providerSessionProvider
      && agent.providerSessionId
      && agent.providerSessionTemporary !== true
      ? { provider: agent.providerSessionProvider, providerHomeId: agent.providerHomeId || 'default', sessionId: agent.providerSessionId }
      : resumedSessionFromSource(agent.source);
    const forkCommand = resumedSession
      ? buildAgentSessionResumeCommand(resumedSession.provider, resumedSession.sessionId, {
        fork: true,
        cwd: targetWorkspace,
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
        task: agent.task ? `Fork: ${agent.task}` : `Fork of ${agent.command}`,
        workflowTemplate: agent.workflowTemplate || '',
        source: mode === 'new-worktree' ? 'ui-fork-new-worktree' : 'ui-fork-same-worktree',
        providerHomeId: agent.providerHomeId || (resumedSession && resumedSession.providerHomeId) || '',
        providerHomePath: agent.providerHomePath || '',
      });
    });
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
      projectWorkspace: agent.projectWorkspace || agent.cwd || '',
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

  async archiveAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }
    if (agent.id === this.mainAgentId) {
      return { error: 'Main Agent cannot be archived' };
    }

    const removedMainPageSessionKeys = this.removeMainPageProviderSessionsForAgents([agent]);
    await this.killAgent(agentId, {
      reason: 'manual-archive',
      recordHistory: !isEphemeralShellAgent(agent),
    });
    return { agentId, archived: true, removed: true, removedMainPageSessionKeys };
  }
  
  async killAgent(agentId, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    try {
      const engine = this.engineBridge.getEngine(agent.engineName);
      if (engine) {
        await engine.killSession(agentId);
      }
    } catch (error) {
      console.error('Failed to kill agent:', error);
    }

    if (options.recordHistory !== false && !isEphemeralShellAgent(agent)) {
      this.recordTaskHistory(agent, {
        reason: options.reason || 'manual-kill',
        archivedAt: Date.now(),
      });
    }

    this.agents.delete(agentId);
    this.lastActivity.delete(agentId);
    this.lastActivityUpdate.delete(agentId);
    this.outputEvents.delete(agentId);
    this.lastResizeByAgent.delete(agentId);
    this.stopCodexProviderSessionResolver(agentId);
    this.stopProviderSessionTitleResolver(agentId);
    if (this.codexAppServerRuntime && typeof this.codexAppServerRuntime.unregisterAgent === 'function') {
      this.codexAppServerRuntime.unregisterAgent(agentId);
    }
    if (this.jsonCliRuntime) this.jsonCliRuntime.unregisterAgent(agentId);

    if (this.mainAgentId === agentId) {
      this.mainAgentId = null;
    }
    
    if (options.emitUpdate !== false) {
      this.emit('update');
    }
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

    return agent.projectWorkspace || agent.cwd;
  }

  getAgentProviderSession(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return {
      provider: agent.providerSessionProvider || '',
      sessionId: agent.providerSessionId || '',
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      codexAppServerHomePath: agent.codexAppServerHomePath || '',
      codexRuntimeMode: agent.codexRuntimeMode || '',
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
      codexRuntimeMode: agent.codexRuntimeMode || '',
      codexAppServerState: agent.codexAppServerState || '',
      codexAppServerEndpoint: agent.codexAppServerEndpoint || '',
      codexAppServerThreadId: agent.codexAppServerThreadId || '',
      codexAppServerTurnId: agent.codexAppServerTurnId || '',
      codexAppServerError: agent.codexAppServerError || '',
      codexAppServerPendingRequestId: agent.codexAppServerPendingRequestId || '',
      codexAppServerPendingRequestMethod: agent.codexAppServerPendingRequestMethod || '',
      codexAppServerPendingRequest: agent.codexAppServerPendingRequest || null,
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
      attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
      unread: agentAttentionUnread(agent),
      archived: agent.archived === true,
      archivedAt: agent.archivedAt || null,
      sessionSource: this.getEngineSessionSource(agent.engineName),
      outputSeq: sessionState && Number.isFinite(sessionState.outputSeq) ? sessionState.outputSeq : null,
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
      previewSnapshot: (sessionState && sessionState.previewSnapshot) || agent.previewSnapshot || null,
      previewCols: (sessionState && Number.isFinite(sessionState.previewCols) && sessionState.previewCols > 0)
        ? sessionState.previewCols
        : (agent.previewCols || 80),
      previewRows: (sessionState && Number.isFinite(sessionState.previewRows) && sessionState.previewRows > 0)
        ? sessionState.previewRows
        : (agent.previewRows || 30),
      usageRate: this.calculateAgentUsageRate(agent.id),
    };
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
      usageRate: this.calculateAgentUsageRate(agent.id, { now, windowMs }),
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
        projectWorkspace: agent.projectWorkspace || '',
        output: agent.output.slice(-2000),
        previewText: agent.previewText || '',
        previewCols: agent.previewCols || 80,
        previewRows: agent.previewRows || 30,
        sessionTitle: agent.sessionTitle || '',
        sessionSource: this.getEngineSessionSource(agent.engineName),
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
        codexRuntimeMode: agent.codexRuntimeMode || '',
        agentRuntimeMode: agent.agentRuntimeMode || 'terminal',
        jsonCliState: agent.jsonCliState || '',
        jsonCliError: agent.jsonCliError || '',
        jsonCliTranscriptUpdatedAt: agent.jsonCliTranscriptUpdatedAt || '',
        codexAppServerState: agent.codexAppServerState || '',
        codexAppServerEndpoint: agent.codexAppServerEndpoint || '',
        codexAppServerThreadId: agent.codexAppServerThreadId || '',
        codexAppServerTurnId: agent.codexAppServerTurnId || '',
        codexAppServerError: agent.codexAppServerError || '',
        codexAppServerPendingRequestId: agent.codexAppServerPendingRequestId || '',
        codexAppServerPendingRequestMethod: agent.codexAppServerPendingRequestMethod || '',
        codexAppServerPendingRequest: agent.codexAppServerPendingRequest || null,
        codexAppServerNotice: agent.codexAppServerNotice || null,
        codexAppServerGoal: agent.codexAppServerGoal || null,
        codexCliObserverDeferred: agent.codexCliObserverDeferred === true,
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
        attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
        unread: agentAttentionUnread(agent),
        archived: agent.archived === true,
        archivedAt: agent.archivedAt || null,
        canForkNewWorktree: agent.canForkNewWorktree === true,
        startedAt: agent.startedAt || null,
        exitedAt: agent.exitedAt || null,
        // Main agent is exempt from activity/attention/zombie scoring
        activityLevel: isMain ? 'warm' : this.calculateActivityLevel(lastActivity, now),
        lastActivity,
        attentionScore: isMain ? 0 : this.calculateAttentionScore(id, now),
        isZombie: isMain ? false : this.isZombie(id, now),
        usageRate: this.calculateAgentUsageRate(id, { now })
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

      previews.push({
        agentId: agent.id,
        previewText: agent.previewText || '',
        cols: agent.previewCols || 80,
        rows: agent.previewRows || 30,
        previewSnapshot: agent.previewSnapshot || null,
        terminalStatus: deriveAgentTerminalStatus(agent, {
          previewText: agent.previewText || '',
          title: agent.sessionTitle || '',
          terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
        }),
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
