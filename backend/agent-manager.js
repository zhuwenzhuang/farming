const EventEmitter = require('events');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const SystemMonitor = require('./system-monitor');
const SessionEngineBridge = require('./session-engine-bridge');
const { resolveLaunchCommand } = require('./cli-agents');
const { buildAgentSessionResumeCommand } = require('./agent-session-history');
const { listCodexSessions } = require('./codex-session-history');
const { buildAgentProviderSessionPlan, sessionFromExactResumeSource } = require('./agent-provider-session');
const { resolveAgentExecutable, resolveCompatibleCodexExecutable } = require('./executable-discovery');
const { ensureMainAgentSkillFiles, renderMainAgentBootstrap } = require('./main-agent-skills');
const { mainPageAgentSessionKey } = require('./main-page-session');
const { isTemporaryProviderSessionId } = require('./provider-session-id');
const { deriveTerminalStatus } = require('./terminal-status');
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
const MIN_TERMINAL_RESIZE_COLS = 40;
const MIN_TERMINAL_RESIZE_ROWS = 10;
const CODEX_PROVIDER_SESSION_RESOLVE_COOLDOWN_MS = 1000;
const CODEX_PROVIDER_SESSION_MATCH_GRACE_MS = 30 * 1000;
const execFileAsync = promisify(execFile);

function trimSessionOutput(output) {
  const text = typeof output === 'string' ? output : '';
  return text.length > SESSION_OUTPUT_LIMIT ? text.slice(-SESSION_OUTPUT_LIMIT) : text;
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

function isShellProgram(command) {
  return ['bash', 'zsh', 'sh', 'fish'].includes(agentProgramName(command).toLowerCase());
}

function isEphemeralShellAgent(agent) {
  return agent && isShellProgram(agent.forkCommand || agent.command || '');
}

function terminalRuntimeStatus(agentStatus) {
  return agentStatus === 'stopped' || agentStatus === 'dead' ? 'exited' : agentStatus;
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
  });
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
  if (program === 'codex' || program === 'claude') {
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
      : () => resolveUserShellEnvSync({ processEnv: process.env });
    this.agentShellEnvCache = {
      resolvedAt: 0,
      env: null,
      initialized: false,
    };
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
    if (this.configManager && this.configManager.farmingDir) {
      this.recoveryPromise = this.recoverEngineSessions().catch((error) => {
        console.warn('Failed to recover engine sessions:', error && (error.message || error));
      });
    }
  }

  bindEngineEvents() {
    this.engineBridge.on('session-started', ({ sessionId, status, startedAt }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        agent.engineStarted = true;
        agent.engineStatus = status || 'running';
        agent.startedAt = startedAt || Date.now();
        this.observeAgentStateChange(sessionId, { force: true });
        this.emit('update');
      });

    this.engineBridge.on('session-output', ({ sessionId, data, engineName, outputSeq }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        agent.output = trimSessionOutput(agent.output + data);
        agent.lastEngineOutputAt = Date.now();

        this.lastActivity.set(sessionId, Date.now());

        // Track output events for rate calculation
        const events = this.outputEvents.get(sessionId) || [];
        events.push({ timestamp: Date.now(), bytes: Buffer.byteLength(String(data), 'utf8') });
        const cutoff = Date.now() - AGENT_USAGE_RATE_WINDOW_MS;
        this.outputEvents.set(sessionId, events.filter(e => e.timestamp > cutoff));

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

    this.engineBridge.on('session-sync', ({ sessionId, output, engineName, replaceLive = true }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        agent.output = trimSessionOutput(output);
        agent.previewText = agent.output.slice(-2000);
        this.lastActivity.set(sessionId, Date.now());

        if (replaceLive) {
          const sessionSource = this.getEngineSessionSource(engineName);
          this.emit('session-stream', {
            agentId: sessionId,
            data: agent.output,
            sessionSource,
            replace: true,
          });
        }
        this.observeAgentStateChange(sessionId);
        this.emit('update');
      });

    this.engineBridge.on('session-preview', ({ sessionId, previewText, cols, rows, previewSnapshot, title }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

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
        this.observeAgentStateChange(sessionId);
        if (titleChanged) {
          this.emit('update');
        }
      });

    this.engineBridge.on('session-title', ({ sessionId, title }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        if (this.updateAgentSessionTitle(agent, title)) {
          this.observeAgentStateChange(sessionId);
          this.emit('update');
        }
      });

    this.engineBridge.on('session-activity', ({ sessionId, lastActivityAt }) => {
        this.lastActivity.set(sessionId, lastActivityAt || Date.now());
        this.observeAgentStateChange(sessionId);
        this.emitActivityUpdate(sessionId, lastActivityAt || Date.now());
      });

    this.engineBridge.on('session-busy-state', (payload = {}) => {
        const {
          sessionId,
          terminalBusy,
          cwd,
          lastExitCode,
          shellEvent,
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
          shellStatusMarkerSeen: agent.shellStatusMarkerSeen === true,
          shellBusyMarkerSeen: agent.shellBusyMarkerSeen === true,
        });
        if (previousState === nextState) return;
        this.observeAgentStateChange(sessionId);
        this.emit('update');
      });

    this.engineBridge.on('session-exited', ({ sessionId, code, exitedAt }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        if (!agent.validated) {
          this.stopCodexProviderSessionResolver(sessionId);
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

        this.observeAgentStateChange(sessionId, { force: true });
        this.stopCodexProviderSessionResolver(sessionId);
        agent.status = sessionId === this.mainAgentId ? 'dead' : 'stopped';
        agent.exitedAt = exitedAt || Date.now();
        agent.output = trimSessionOutput(`${agent.output}\nProcess exited with code ${code}`);
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

        if (fatal === false) {
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
    let changed = false;

    for (const entry of recovered || []) {
      const metadata = entry.metadata || {};
      const state = entry.state || {};
      const agentId = recoveredEngineSessionId(entry, metadata);
      if (!agentId || this.agents.has(agentId)) continue;
      if (!shouldRecoverEngineSession(metadata)) {
        await this.killRecoveredEngineSession(entry, metadata, agentId);
        continue;
      }

      const agentRecord = this.recoveredAgentRecord(agentId, entry.engineName || metadata.engineName || 'native', metadata, state);
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
      parentAgentId: metadata.parentAgentId || '',
      task: metadata.task || '',
      workflowTemplate: metadata.workflowTemplate || '',
      source: metadata.source || 'recovered',
      providerSessionProvider: metadata.providerSessionProvider || '',
      providerSessionId: metadata.providerSessionId || '',
      providerSessionKey: metadata.providerSessionKey || (
        metadata.providerSessionProvider && metadata.providerSessionId
          ? mainPageAgentSessionKey(metadata.providerSessionProvider, metadata.providerSessionId)
          : ''
      ),
      providerSessionTemporary: metadata.providerSessionTemporary === true || isTemporaryProviderSessionId(metadata.providerSessionId),
      providerSessionSource: metadata.providerSessionSource || '',
      providerSessionResolvedAt: metadata.providerSessionResolvedAt || null,
      forkedFromProviderSessionId: metadata.forkedFromProviderSessionId || '',
      customTitle: metadata.customTitle || '',
      terminalBusy: typeof state.terminalBusy === 'boolean' ? state.terminalBusy : null,
      shellCwd: state.shellCwd || metadata.cwd || '',
      shellLastExitCode: typeof state.shellLastExitCode === 'number' ? state.shellLastExitCode : null,
      shellLastEvent: state.shellLastEvent || '',
      pinned: metadata.pinned === true,
      unread: false,
      archived: false,
      archivedAt: null,
      canForkNewWorktree: this.canCreateForkWorktree(metadata.projectWorkspace || metadata.cwd || ''),
      validated: true,
      engineStarted: true,
      engineStatus: state.status || 'running',
      startedAt: state.startedAt || metadata.startedAt || Date.now(),
      lastEngineOutputAt: Date.now(),
    };
  }

  providerSessionKey(provider, sessionId) {
    return provider && sessionId ? mainPageAgentSessionKey(provider, sessionId) : '';
  }

  currentProviderSessionIds(provider, excludedAgentId = '') {
    const ids = new Set();
    for (const agent of this.agents.values()) {
      if (!agent || agent.id === excludedAgentId) continue;
      if (agent.providerSessionProvider !== provider) continue;
      if (!agent.providerSessionId || agent.providerSessionTemporary === true) continue;
      ids.add(agent.providerSessionId);
    }
    return ids;
  }

  rememberMainPageProviderSession(agent) {
    if (!agent || agent.wantsMain) return;
    if (!agent.providerSessionProvider || !agent.providerSessionId || agent.providerSessionTemporary === true) return;
    if (!this.configManager || typeof this.configManager.getSettings !== 'function' || typeof this.configManager.updateSettings !== 'function') {
      return;
    }

    const sessionKey = this.providerSessionKey(agent.providerSessionProvider, agent.providerSessionId);
    if (!sessionKey) return;
    const settings = this.configManager.getSettings();
    const currentKeys = Array.isArray(settings.mainPageSessionKeys) ? settings.mainPageSessionKeys : [];
    if (currentKeys[0] === sessionKey) return;
    this.configManager.updateSettings({
      mainPageSessionKeys: [
        sessionKey,
        ...currentKeys.filter(key => key !== sessionKey),
      ],
    });
  }

  updateEngineProviderSessionMetadata(agent) {
    if (!agent || !agent.engineName) return;
    const engine = this.engineBridge.getEngine(agent.engineName);
    if (!engine || typeof engine.updateSessionMetadata !== 'function') return;
    Promise.resolve(engine.updateSessionMetadata(agent.id, {
      providerSessionProvider: agent.providerSessionProvider || '',
      providerSessionId: agent.providerSessionId || '',
      providerSessionKey: agent.providerSessionKey || '',
      providerSessionTemporary: agent.providerSessionTemporary === true,
      providerSessionSource: agent.providerSessionSource || '',
      providerSessionResolvedAt: agent.providerSessionResolvedAt || null,
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
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
  }

  stopCodexProviderSessionResolver(agentId) {
    this.codexSessionResolveInFlight.delete(agentId);
    this.codexSessionResolveLastAttemptAt.delete(agentId);
  }

  observeAgentStateChange(agentId, options = {}) {
    this.attemptCodexProviderSessionResolution(agentId, options).catch((error) => {
      console.warn('Failed to resolve Codex provider session:', error && (error.message || error));
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

  async findCodexSessionForTemporaryAgent(agent) {
    const sessions = await listCodexSessions({ limit: 100, scanLimit: 1000 });
    const workspace = normalizePathValue(agent.projectWorkspace || agent.cwd);
    const startedAt = Number(agent.startedAt) || 0;
    const claimedSessionIds = this.currentProviderSessionIds('codex', agent.id);
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

  resolveProviderSession(agentId, { provider, sessionId, source }) {
    const agent = this.agents.get(agentId);
    if (!agent || !provider || !sessionId || isTemporaryProviderSessionId(sessionId)) return false;

    const previousSessionId = agent.providerSessionId || '';
    agent.providerSessionProvider = provider;
    agent.providerSessionId = sessionId;
    agent.providerSessionKey = this.providerSessionKey(provider, sessionId);
    agent.providerSessionTemporary = false;
    agent.providerSessionSource = source || agent.providerSessionSource || '';
    agent.providerSessionResolvedAt = Date.now();

    this.stopCodexProviderSessionResolver(agentId);
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

  resolveAgentShellEnv() {
    const now = Date.now();
    if (
      this.agentShellEnvCache.initialized &&
      (this.agentShellEnvCacheMs === 0 || now - this.agentShellEnvCache.resolvedAt < this.agentShellEnvCacheMs)
    ) {
      return this.agentShellEnvCache.env;
    }

    let shellEnv = null;
    try {
      shellEnv = this.agentShellEnvProvider() || null;
    } catch (error) {
      console.warn('Failed to resolve user shell environment for agent:', error && (error.message || error));
    }

    this.agentShellEnvCache = {
      initialized: true,
      resolvedAt: now,
      env: shellEnv,
    };
    return shellEnv;
  }

  buildAgentBaseEnv() {
    return buildInteractiveAgentBaseEnv({
      processEnv: process.env,
      shellEnv: this.resolveAgentShellEnv(),
    });
  }

  buildAgentEnv(agentId, agent) {
    const env = this.buildAgentBaseEnv();
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
    this.inputQueues.clear();
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
      codexApprovalMode: this.configManager && this.configManager.getCodexApprovalMode
        ? this.configManager.getCodexApprovalMode()
        : 'approve',
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
    const providerSessionPlan = buildAgentProviderSessionPlan({
      command,
      program,
      args: launch.args,
      source: typeof options.source === 'string' ? options.source : 'ui',
    });
    const args = providerSessionPlan.args;
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
      parentAgentId,
      task: typeof options.task === 'string' ? options.task : '',
      workflowTemplate: typeof options.workflowTemplate === 'string' ? options.workflowTemplate : '',
      source: typeof options.source === 'string' ? options.source : 'ui',
      providerSessionProvider: providerSessionPlan.provider || '',
      providerSessionId: providerSessionPlan.id || '',
      providerSessionKey: this.providerSessionKey(providerSessionPlan.provider, providerSessionPlan.id),
      providerSessionTemporary: providerSessionPlan.temporary === true,
      providerSessionSource: providerSessionPlan.source || '',
      providerSessionResolvedAt: providerSessionPlan.temporary === true ? null : Date.now(),
      forkedFromProviderSessionId: providerSessionPlan.forkedFromProviderSessionId || '',
      customTitle: '',
      terminalBusy: null,
      shellCwd: '',
      shellLastExitCode: null,
      shellLastEvent: '',
      pinned: false,
      unread: false,
      archived: false,
      archivedAt: null,
      canForkNewWorktree: this.canCreateForkWorktree(projectWorkspace || workspace),
      validated: true,
      engineStarted: false,
      startedAt: Date.now()
    };

    this.agents.set(agentId, agentRecord);

    this.lastActivity.set(agentId, Date.now());

    this.emit('update');

    try {
      await resolution.engine.createSession({
        agentId,
        command: spawnProgram,
        args,
        cwd: workspace,
        env: this.buildAgentEnv(agentId, agentRecord),
        category: resolution.spec ? resolution.spec.category : 'shell',
        metadata: {
          agentId,
          command: launch.program,
          forkCommand: agentRecord.forkCommand,
          cwd: workspace,
          projectWorkspace,
          mainWorkspace: agentRecord.mainWorkspace || '',
          wantsMain,
          category: agentRecord.category,
          parentAgentId,
          task: agentRecord.task,
          workflowTemplate: agentRecord.workflowTemplate,
          source: agentRecord.source,
          providerSessionProvider: agentRecord.providerSessionProvider,
          providerSessionId: agentRecord.providerSessionId,
          providerSessionKey: agentRecord.providerSessionKey,
          providerSessionTemporary: agentRecord.providerSessionTemporary,
          providerSessionSource: agentRecord.providerSessionSource,
          providerSessionResolvedAt: agentRecord.providerSessionResolvedAt,
          forkedFromProviderSessionId: agentRecord.forkedFromProviderSessionId,
          customTitle: agentRecord.customTitle,
          pinned: agentRecord.pinned,
          startedAt: agentRecord.startedAt,
        }
      });

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

  async sendInputNow(agentId, input) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

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
      agent.pinned = flags.pinned;
      updates.pinned = agent.pinned;
    }

    if (typeof flags.unread === 'boolean') {
      agent.unread = flags.unread;
      updates.unread = agent.unread;
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

    this.emit('update');
    return { agentId, ...updates };
  }

  setAgentUnread(agentId, unread) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const nextUnread = unread === true;
    if (agent.unread === nextUnread) {
      return { agentId, unread: nextUnread, changed: false };
    }

    agent.unread = nextUnread;
    this.emit('update');
    return { agentId, unread: nextUnread, changed: true };
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
    if (!this.configManager || typeof this.configManager.getSettings !== 'function' || typeof this.configManager.updateSettings !== 'function') {
      return [];
    }

    const keysToRemove = new Set();
    agents.forEach(agent => {
      const providerSessionKey = agent.providerSessionKey || this.providerSessionKey(agent.providerSessionProvider, agent.providerSessionId);
      if (providerSessionKey) keysToRemove.add(providerSessionKey);
    });
    if (keysToRemove.size === 0) return [];

    const settings = this.configManager.getSettings();
    const currentKeys = Array.isArray(settings.mainPageSessionKeys) ? settings.mainPageSessionKeys : [];
    const removedKeys = currentKeys.filter(key => keysToRemove.has(key));
    if (removedKeys.length === 0) return [];
    const nextKeys = currentKeys.filter(key => !keysToRemove.has(key));
    this.configManager.updateSettings({ mainPageSessionKeys: nextKeys });
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
      ? { provider: agent.providerSessionProvider, sessionId: agent.providerSessionId }
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
      });
    });
  }

  recordTaskHistory(agent, options = {}) {
    if (!agent || agent.id === this.mainAgentId) return;
    const providerHistorySource = agent.providerSessionProvider
      && agent.providerSessionId
      && agent.providerSessionTemporary !== true
      ? `${agent.providerSessionProvider}-history:${agent.providerSessionId}`
      : '';
    const entry = {
      id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId: agent.id,
      command: agent.command || '',
      cwd: agent.cwd || '',
      projectWorkspace: agent.projectWorkspace || agent.cwd || '',
      title: agent.customTitle || agent.sessionTitle || agent.task || '',
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

    if (this.mainAgentId === agentId) {
      this.mainAgentId = null;
    }
    
    this.emit('update');
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
      if (sessionState && typeof sessionState.output === 'string') {
        return sessionState.output;
      }
      if (!sessionState && isRunningAgentRuntimeStatus(agent.status)) {
        this.markAgentSessionDead(agentId, 'Session not available');
      }
    } catch (error) {
      console.error('Failed to read session text:', error);
      if (isSessionNotAvailableError(error)) {
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
        if (!sessionState && isRunningAgentRuntimeStatus(agent.status)) {
          this.markAgentSessionDead(agentId, 'Session not available');
        }
      } catch (error) {
        console.error('Failed to read session state:', error);
        if (isSessionNotAvailableError(error)) {
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
    const previewText = (sessionState && typeof sessionState.previewText === 'string') ? sessionState.previewText : fallbackPreview;
    const sessionTitle = (sessionState && typeof sessionState.title === 'string' && sessionState.title) || agent.sessionTitle || '';
    const terminalStatus = (sessionState && sessionState.terminalStatus) || deriveAgentTerminalStatus(agent, {
      terminalBusy,
      status: sessionState && sessionState.status ? sessionState.status : terminalRuntimeStatus(agent.status),
      title: sessionTitle,
      previewText,
      cwd: (sessionState && sessionState.terminalStatus && sessionState.terminalStatus.cwd) || agent.shellCwd || agent.cwd,
    });

    const now = Date.now();
    const isMain = this.isMainAgentRecord(agent.id, agent);
    return {
      agentId: agent.id,
      command: agent.command,
      engineName: agent.engineName || '',
      cwd: agent.cwd,
      projectWorkspace: agent.projectWorkspace || '',
      status: agent.status,
      terminalBusy,
      terminalStatus,
      parentAgentId: agent.parentAgentId || '',
      task: agent.task || '',
      workflowTemplate: agent.workflowTemplate || '',
      source: agent.source || '',
      providerSessionProvider: agent.providerSessionProvider || '',
      providerSessionId: agent.providerSessionId || '',
      providerSessionKey: agent.providerSessionKey || '',
      providerSessionTemporary: agent.providerSessionTemporary === true,
      providerSessionSource: agent.providerSessionSource || '',
      providerSessionResolvedAt: agent.providerSessionResolvedAt || null,
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
      customTitle: agent.customTitle || '',
      pinned: agent.pinned === true,
      unread: agent.unread === true,
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
        isMain,
        parentAgentId: agent.parentAgentId || '',
        task: agent.task || '',
        workflowTemplate: agent.workflowTemplate || '',
        source: agent.source || '',
        providerSessionProvider: agent.providerSessionProvider || '',
        providerSessionId: agent.providerSessionId || '',
        providerSessionKey: agent.providerSessionKey || '',
        providerSessionTemporary: agent.providerSessionTemporary === true,
        providerSessionSource: agent.providerSessionSource || '',
        providerSessionResolvedAt: agent.providerSessionResolvedAt || null,
        forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
        customTitle: agent.customTitle || '',
        pinned: agent.pinned === true,
        unread: agent.unread === true,
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
