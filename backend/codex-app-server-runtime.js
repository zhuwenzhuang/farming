const EventEmitter = require('events');
const path = require('path');
const { spawn } = require('child_process');
const packageJson = require('../package.json');
const { AppServerConnection } = require('./app-server-api');
const { buildTranscriptFromEvents } = require('./codex-transcript');

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_DELAY_MS = 80;
const MAX_PENDING_REQUEST_DEPTH = 5;
const MAX_PENDING_REQUEST_ITEMS = 24;
const MAX_PENDING_REQUEST_STRING_LENGTH = 4_000;
const MAX_TRANSCRIPT_EVENTS = 12_000;
const CODEX_GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const AUTO_REJECT_APPROVAL_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);

function normalizeCodexRuntimeMode(value) {
  return value === 'cli' ? 'cli' : 'app-server';
}

function socketPathForCodexHome(codexHome) {
  return path.join(
    path.resolve(String(codexHome || '')),
    'app-server-control',
    'app-server-control.sock'
  );
}

function endpointForCodexHome(codexHome) {
  return `unix://${socketPathForCodexHome(codexHome)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readThreadId(response, method) {
  if (response && response.error) {
    throw new Error(response.error.message || `${method} failed`);
  }

  const threadId = response && response.result && response.result.thread && response.result.thread.id;
  if (typeof threadId !== 'string' || !threadId.trim()) {
    throw new Error(`${method} did not return a Codex thread id`);
  }
  return threadId.trim();
}

function readTurnId(response, method) {
  if (response && response.error) {
    throw new Error(response.error.message || `${method} failed`);
  }

  const turnId = response && response.result && (
    response.result.turnId
    || (response.result.turn && response.result.turn.id)
  );
  if (typeof turnId !== 'string' || !turnId.trim()) {
    throw new Error(`${method} did not return a Codex turn id`);
  }
  return turnId.trim();
}

function readResult(response, method) {
  if (response && response.error) {
    throw new Error(response.error.message || `${method} failed`);
  }
  return response && response.result ? response.result : {};
}

function normalizeGoalStatus(status) {
  const value = String(status || '').trim();
  return CODEX_GOAL_STATUSES.has(value) ? value : '';
}

function normalizeGoal(goal, fallbackThreadId = '') {
  if (!goal || typeof goal !== 'object') return null;
  const objective = typeof goal.objective === 'string' ? goal.objective : '';
  const status = normalizeGoalStatus(goal.status);
  const threadId = typeof goal.threadId === 'string' && goal.threadId ? goal.threadId : String(fallbackThreadId || '');
  if (!objective || !status || !threadId) return null;
  return {
    threadId,
    objective,
    status,
    tokenBudget: Number.isFinite(Number(goal.tokenBudget)) ? Number(goal.tokenBudget) : null,
    tokensUsed: Number.isFinite(Number(goal.tokensUsed)) ? Number(goal.tokensUsed) : 0,
    timeUsedSeconds: Number.isFinite(Number(goal.timeUsedSeconds)) ? Number(goal.timeUsedSeconds) : 0,
    createdAt: Number.isFinite(Number(goal.createdAt)) ? Number(goal.createdAt) : 0,
    updatedAt: Number.isFinite(Number(goal.updatedAt)) ? Number(goal.updatedAt) : 0,
  };
}

function runtimePermissions(mode) {
  if (mode === 'ask') {
    return {
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    };
  }
  if (mode === 'approve') {
    return {
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    };
  }
  if (mode === 'full') {
    return {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    };
  }
  return {};
}

function threadSettingsSandboxPolicy(sandbox) {
  // `thread/settings/update` uses the App Server's structured SandboxPolicy
  // object, whose installed protocol is camelCase (unlike the legacy string
  // accepted by thread/start and thread/resume).
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (sandbox === 'workspace-write') return { type: 'workspaceWrite', writableRoots: [] };
  return null;
}

function requestThreadParams(options = {}) {
  const permissions = runtimePermissions(options.approvalMode);
  const config = {};
  if (options.reasoningEffort && options.reasoningEffort !== 'config') {
    config.model_reasoning_effort = options.reasoningEffort;
  }

  return {
    ...(options.model && options.model !== 'config' ? { model: options.model } : {}),
    ...(options.serviceTier && !['default', 'config'].includes(options.serviceTier)
      ? { serviceTier: options.serviceTier }
      : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.workspaceRoot ? { runtimeWorkspaceRoots: [options.workspaceRoot] } : {}),
    ...(permissions.approvalPolicy ? { approvalPolicy: permissions.approvalPolicy } : {}),
    ...(permissions.sandbox ? { sandbox: permissions.sandbox } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
    ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
  };
}

function appServerUserInput(options = {}) {
  const input = [];
  for (const item of Array.isArray(options.input) ? options.input : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      input.push({ type: 'text', text: item.text, textElements: [] });
      continue;
    }
    if (item.type === 'image' && typeof item.path === 'string' && path.isAbsolute(item.path)) {
      input.push({ type: 'localImage', path: item.path });
    }
  }
  if (input.length === 0 && String(options.message || '').trim()) {
    input.push({ type: 'text', text: String(options.message), textElements: [] });
  }
  return input;
}

function composerTranscriptInput(input) {
  return input.map((item) => (
    item.type === 'text'
      ? { type: 'input_text', text: item.text }
      : { type: 'localImage', path: item.path }
  ));
}

function requestTurnParams(options = {}) {
  const input = appServerUserInput(options);
  return {
    threadId: options.threadId,
    input,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.workspaceRoot ? { runtimeWorkspaceRoots: [options.workspaceRoot] } : {}),
    ...(options.model && options.model !== 'config' ? { model: options.model } : {}),
    ...(options.serviceTier && !['default', 'config'].includes(options.serviceTier)
      ? { serviceTier: options.serviceTier }
      : {}),
    ...(options.reasoningEffort && options.reasoningEffort !== 'config'
      ? { effort: options.reasoningEffort }
      : {}),
  };
}

function cliResumeArgs(threadId, cwd) {
  return [
    'resume',
    ...(cwd ? ['-C', cwd] : []),
    threadId,
  ];
}

function serializePendingRequestValue(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, MAX_PENDING_REQUEST_STRING_LENGTH);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth >= MAX_PENDING_REQUEST_DEPTH) return '[omitted]';
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PENDING_REQUEST_ITEMS)
      .map(item => serializePendingRequestValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_PENDING_REQUEST_ITEMS)
        .map(([key, item]) => [key, serializePendingRequestValue(item, depth + 1)])
    );
  }
  return String(value);
}

function serializePendingServerRequest(event) {
  const request = event && event.payload ? event.payload : {};
  return {
    id: String(request.id || ''),
    method: String(request.method || ''),
    params: serializePendingRequestValue(request.params || {}),
    receivedAt: event && event.at ? event.at : new Date().toISOString(),
  };
}

function approvalRejectedNotice(request) {
  return {
    id: `notice-${String(request.id || Date.now())}`,
    kind: 'approval-rejected',
    method: String(request.method || ''),
    message: 'Permission request was declined in Chat. Increase this agent permission mode or use Terminal view to handle it.',
    receivedAt: new Date().toISOString(),
  };
}

class CodexAppServerRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.connectTimeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs || DEFAULT_RETRY_DELAY_MS;
    this.spawnAppServer = options.spawnAppServer || spawn;
    this.createConnection = options.createConnection || (connectionOptions => new AppServerConnection(connectionOptions));
    this.maxTranscriptEvents = Number.isFinite(options.maxTranscriptEvents)
      ? Math.max(2, Math.floor(options.maxTranscriptEvents))
      : MAX_TRANSCRIPT_EVENTS;
    this.transcriptRefreshes = new Map();
    this.clientInfo = {
      name: 'farming',
      title: 'Farming Codex runtime',
      version: packageJson.version || '0.0.0',
    };
    this.homes = new Map();
    this.bindings = new Map();
    this.transcripts = new Map();
    this.disposed = false;
  }

  homeEntry(codexHome) {
    const rawHomePath = String(codexHome || '').trim();
    if (!rawHomePath) throw new Error('Codex home path is required for App Server mode');
    const homePath = path.resolve(rawHomePath);

    let entry = this.homes.get(homePath);
    if (entry) return entry;

    entry = {
      homePath,
      endpoint: endpointForCodexHome(homePath),
      socketPath: socketPathForCodexHome(homePath),
      connection: null,
      connectPromise: null,
      spawnedByFarming: false,
      child: null,
      lastError: '',
      lastConnectedAt: null,
      agentIds: new Set(),
    };
    entry.connection = this.createRuntimeConnection(entry);
    this.homes.set(homePath, entry);
    return entry;
  }

  createRuntimeConnection(entry) {
    const connection = this.createConnection({
      provider: 'codex',
      endpoint: entry.endpoint,
      experimentalApi: true,
      clientInfo: this.clientInfo,
    });
    connection.subscribe(event => this.handleConnectionEvent(entry, event), { replay: false });
    return connection;
  }

  handleConnectionEvent(entry, event) {
    if (event.kind === 'transport') {
      if (event.payload && event.payload.state === 'connected') {
        entry.lastConnectedAt = event.at;
        entry.lastError = '';
      }
      if (event.payload && event.payload.state === 'error') {
        entry.lastError = String(event.payload.error || 'Codex App Server transport failed');
      }
      if (event.payload && event.payload.state === 'closed') {
        for (const agentId of entry.agentIds) {
          this.emitAgentRuntime(agentId, {
            state: 'disconnected',
            error: entry.lastError || 'Codex App Server connection closed',
            pendingRequestId: '',
            pendingRequestMethod: '',
            pendingRequest: null,
          });
        }
      }
      return;
    }

    if (event.kind === 'server-request') {
      const request = event.payload || {};
      const threadId = request.params && request.params.threadId;
      const binding = this.bindingForThread(threadId, entry);
      if (binding) {
        if (AUTO_REJECT_APPROVAL_REQUEST_METHODS.has(String(request.method || ''))) {
          try {
            entry.connection.rejectServerRequest(request.id, {
              code: -32000,
              message: 'Permission request declined in Farming Chat. Increase permissions or use Terminal view.',
            });
          } catch (error) {
            entry.lastError = error && error.message ? error.message : String(error);
          }
          this.emitAgentRuntime(binding.agentId, {
            notice: approvalRejectedNotice(request),
            state: binding.turnId ? 'working' : 'idle',
            pendingRequestId: '',
            pendingRequestMethod: '',
            pendingRequest: null,
          });
          return;
        }
        const pendingRequest = serializePendingServerRequest(event);
        this.emitAgentRuntime(binding.agentId, {
          pendingRequestId: pendingRequest.id,
          pendingRequestMethod: pendingRequest.method,
          pendingRequest,
          notice: null,
          state: 'waiting-for-input',
        });
      }
      return;
    }

    if (event.kind !== 'notification') return;
    const message = event.payload || {};
    const params = message.params || {};
    const binding = this.bindingForThread(params.threadId, entry);
    if (!binding) return;

    this.appendTranscriptEvent(binding.agentId, message);

    if (message.method === 'turn/started') {
      const turnId = params.turn && params.turn.id;
      if (turnId) binding.turnId = turnId;
      this.emitAgentRuntime(binding.agentId, {
        turnId: binding.turnId || '',
        state: 'working',
        notice: null,
        pendingRequestId: '',
        pendingRequestMethod: '',
      });
      return;
    }

    if (message.method === 'turn/completed') {
      const turnId = params.turn && params.turn.id;
      if (!turnId || turnId === binding.turnId) binding.turnId = '';
      this.emitAgentRuntime(binding.agentId, {
        turnId: binding.turnId,
        state: 'idle',
        cliResumable: true,
        pendingRequestId: '',
        pendingRequestMethod: '',
        pendingRequest: null,
      });
      return;
    }

    if (message.method === 'thread/status/changed') {
      const status = String(params.status || '');
      const state = /in.?progress|working|running/i.test(status)
        ? 'working'
        : /idle|completed/i.test(status)
          ? 'idle'
          : status || 'connected';
      this.emitAgentRuntime(binding.agentId, { state });
      return;
    }

    if (message.method === 'thread/goal/updated') {
      this.emitAgentRuntime(binding.agentId, {
        goal: normalizeGoal(params.goal, params.threadId),
      });
      return;
    }

    if (message.method === 'thread/goal/cleared') {
      this.emitAgentRuntime(binding.agentId, {
        goal: null,
      });
    }
  }

  bindingForThread(threadId, entry) {
    if (typeof threadId === 'string' && threadId) {
      for (const binding of this.bindings.values()) {
        if (binding.threadId === threadId && binding.entry === entry) return binding;
      }
    }
    if (entry.agentIds.size === 1) {
      return this.bindings.get(Array.from(entry.agentIds)[0]) || null;
    }
    return null;
  }

  emitAgentRuntime(agentId, patch) {
    const binding = this.bindings.get(agentId);
    if (binding) {
      if (Object.prototype.hasOwnProperty.call(patch, 'turnId')) {
        binding.turnId = patch.turnId || '';
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'state')) {
        binding.state = patch.state || binding.state;
      }
    }
    this.emit('agent-runtime', { agentId, ...patch });
  }

  async connectEntry(entry, options = {}) {
    try {
      await entry.connection.connect();
      entry.lastConnectedAt = new Date().toISOString();
      entry.lastError = '';
      return entry;
    } catch (error) {
      entry.lastError = error && error.message ? error.message : String(error);
      if (options.throwOnFailure === true) throw error;
      return null;
    }
  }

  async spawnAndConnect(entry, options) {
    const executable = String(options.executable || '').trim();
    if (!executable) throw new Error('Codex executable is required for App Server mode');

    let child;
    try {
      child = this.spawnAppServer(executable, ['app-server', '--listen', 'unix://'], {
        cwd: options.cwd || process.cwd(),
        env: options.env,
        detached: true,
        stdio: 'ignore',
      });
      if (child && typeof child.unref === 'function') child.unref();
    } catch (error) {
      throw new Error(`Failed to launch Codex App Server: ${error.message || error}`, { cause: error });
    }

    entry.child = child || null;
    entry.spawnedByFarming = true;
    if (child && typeof child.once === 'function') {
      child.once('error', error => {
        entry.lastError = error && error.message ? error.message : String(error);
      });
      child.once('exit', (code, signal) => {
        entry.child = null;
        // Some package launchers hand the long-lived native binary to a child
        // process and then exit themselves. Once the socket is healthy, that
        // wrapper exit is not an App Server failure.
        const connected = entry.connection && typeof entry.connection.status === 'function'
          && entry.connection.status().connected;
        if (code !== 0 && signal !== 'SIGTERM' && !connected) {
          entry.lastError = `Codex App Server exited (${signal || code})`;
        }
      });
    }

    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      const connected = await this.connectEntry(entry);
      if (connected) return entry;
      lastError = entry.lastError;
      await sleep(this.retryDelayMs);
    }
    throw new Error(`Timed out waiting for Codex App Server at ${entry.socketPath}${lastError ? `: ${lastError}` : ''}`);
  }

  async ensure(options = {}) {
    if (this.disposed) throw new Error('Codex App Server runtime is shut down');
    const entry = this.homeEntry(options.codexHome);
    if (entry.connectPromise) return entry.connectPromise;

    entry.connectPromise = (async () => {
      const existing = await this.connectEntry(entry);
      if (existing) return entry;

      entry.connection.close();
      entry.connection = this.createRuntimeConnection(entry);
      return this.spawnAndConnect(entry, options);
    })().finally(() => {
      entry.connectPromise = null;
    });
    return entry.connectPromise;
  }

  bindAgent(agentId, entry, threadId, options = {}) {
    const existing = this.bindings.get(agentId);
    if (existing && existing.entry !== entry) {
      existing.entry.agentIds.delete(agentId);
    }
    const binding = {
      agentId,
      entry,
      threadId,
      turnId: options.turnId || '',
      state: options.state || 'idle',
      options: { ...options },
    };
    this.bindings.set(agentId, binding);
    entry.agentIds.add(agentId);
    this.emitAgentRuntime(agentId, {
      threadId,
      turnId: binding.turnId,
      state: binding.state,
      error: '',
    });
    return binding;
  }

  appendTranscriptEvent(agentId, message) {
    if (!agentId || !message || typeof message.method !== 'string') return;
    const transcript = this.transcripts.get(agentId) || { events: [], updatedAt: '', sequence: 0, truncated: false };
    transcript.sequence = Number(transcript.sequence || 0) + 1;
    transcript.events.push({
      method: message.method,
      params: message.params && typeof message.params === 'object' ? message.params : {},
      farmingSequence: transcript.sequence,
    });
    transcript.updatedAt = new Date().toISOString();
    this.transcripts.set(agentId, transcript);
    this.emitAgentRuntime(agentId, { transcriptUpdatedAt: transcript.updatedAt });
    if (transcript.events.length > this.maxTranscriptEvents) {
      void this.refreshTranscriptSnapshot(agentId);
    }
  }

  async refreshTranscriptSnapshot(agentId) {
    const existing = this.transcriptRefreshes.get(agentId);
    if (existing) return existing;
    const binding = this.bindings.get(agentId);
    const transcript = this.transcripts.get(agentId);
    if (!binding || !transcript) return null;

    const boundarySequence = Number(transcript.sequence || 0);
    const refresh = (async () => {
      let snapshotRefreshed = false;
      try {
        const response = await binding.entry.connection.request('thread/read', {
          threadId: binding.threadId,
        });
        const snapshot = readResult(response, 'thread/read');
        const current = this.transcripts.get(agentId);
        if (!current) return null;
        const trailingEvents = current.events.filter(event => (
          Number(event && event.farmingSequence || 0) > boundarySequence
        ));
        current.events = [{ method: 'thread/read', params: snapshot }, ...trailingEvents];
        current.truncated = false;
        snapshotRefreshed = true;
        current.updatedAt = new Date().toISOString();
        this.emitAgentRuntime(agentId, { transcriptUpdatedAt: current.updatedAt });
        return snapshot;
      } catch {
        const current = this.transcripts.get(agentId);
        const fallbackLimit = this.maxTranscriptEvents * 2;
        if (current && current.events.length > fallbackLimit) {
          current.events.splice(0, current.events.length - fallbackLimit);
          current.truncated = true;
          current.updatedAt = new Date().toISOString();
        }
        return null;
      } finally {
        this.transcriptRefreshes.delete(agentId);
        const current = this.transcripts.get(agentId);
        if (snapshotRefreshed && current && current.events.length > this.maxTranscriptEvents) {
          void this.refreshTranscriptSnapshot(agentId);
        }
      }
    })();
    this.transcriptRefreshes.set(agentId, refresh);
    return refresh;
  }

  appendComposerTranscriptInput(agentId, threadId, turnId, input) {
    this.appendTranscriptEvent(agentId, {
      method: 'item/started',
      params: {
        threadId,
        turnId,
        item: {
          id: `farming-composer-${turnId}-${Date.now()}`,
          type: 'user_message',
          content: composerTranscriptInput(input),
          status: 'completed',
        },
      },
    });
  }

  async hydrateTranscript(binding) {
    try {
      const response = await binding.entry.connection.request('thread/read', {
        threadId: binding.threadId,
      });
      const snapshot = readResult(response, 'thread/read');
      const transcript = {
        events: [{ method: 'thread/read', params: snapshot }],
        updatedAt: new Date().toISOString(),
      };
      this.transcripts.set(binding.agentId, transcript);
      this.emitAgentRuntime(binding.agentId, { transcriptUpdatedAt: transcript.updatedAt });
    } catch {
      // New empty threads have no readable history. Their first App Server
      // turn establishes the transcript through notifications instead.
    }
  }

  async prepareAgent(options = {}) {
    const entry = await this.ensure(options);
    const existingThreadId = options.resumeThreadId && options.resumeThreadId !== options.temporaryThreadId
      ? String(options.resumeThreadId)
      : '';
    const params = requestThreadParams(options);
    try {
      const response = existingThreadId
        ? await entry.connection.request('thread/resume', { threadId: existingThreadId, ...params })
        : await entry.connection.request('thread/start', params);
      const threadId = readThreadId(response, existingThreadId ? 'thread/resume' : 'thread/start');
      const binding = this.bindAgent(options.agentId, entry, threadId, {
        ...options,
        state: 'idle',
      });
      await this.hydrateTranscript(binding);
      return {
        threadId,
        resumed: Boolean(existingThreadId),
        endpoint: entry.endpoint,
      };
    } catch (error) {
      this.releaseUnusedEntry(entry);
      throw error;
    }
  }

  async reattachAgent(options = {}) {
    const existing = this.bindings.get(options.agentId);
    if (existing) return existing;
    const threadId = String(options.threadId || '').trim();
    if (!threadId) throw new Error('Codex App Server agent is missing its thread id');

    const entry = await this.ensure(options);
    const response = await entry.connection.request('thread/resume', {
      threadId,
      ...requestThreadParams(options),
    });
    const resolvedThreadId = readThreadId(response, 'thread/resume');
    const binding = this.bindAgent(options.agentId, entry, resolvedThreadId, {
      ...options,
      state: 'idle',
    });
    await this.hydrateTranscript(binding);
    return binding;
  }

  async submitComposerMessage(options = {}) {
    const message = String(options.message || '').trim();
    const input = appServerUserInput(options);
    if (input.length === 0) throw new Error('Composer message is empty');

    let binding = this.bindings.get(options.agentId);
    if (!binding) binding = await this.reattachAgent(options);
    const { entry } = binding;

    if (binding.turnId) {
      const response = await entry.connection.request('turn/steer', {
        threadId: binding.threadId,
        expectedTurnId: binding.turnId,
        input,
      });
      const turnId = readTurnId(response, 'turn/steer');
      this.appendComposerTranscriptInput(binding.agentId, binding.threadId, turnId, input);
      this.emitAgentRuntime(binding.agentId, {
        turnId,
        state: 'working',
      });
      return { kind: 'steer', threadId: binding.threadId, turnId };
    }

    const response = await entry.connection.request('turn/start', requestTurnParams({
      ...binding.options,
      ...options,
      threadId: binding.threadId,
      message,
    }));
    const turnId = readTurnId(response, 'turn/start');
    this.appendComposerTranscriptInput(binding.agentId, binding.threadId, turnId, input);
    this.emitAgentRuntime(binding.agentId, {
      turnId,
      state: 'working',
    });
    return { kind: 'start', threadId: binding.threadId, turnId };
  }

  async updateAgentPermissionMode(options = {}) {
    const permissions = runtimePermissions(options.approvalMode);
    const sandboxPolicy = threadSettingsSandboxPolicy(permissions.sandbox);
    if (!permissions.approvalPolicy || !sandboxPolicy) {
      throw new Error('Custom App Server permission mode cannot be applied without a named permission profile');
    }

    let binding = this.bindings.get(options.agentId);
    if (!binding) binding = await this.reattachAgent(options);

    const response = await binding.entry.connection.request('thread/settings/update', {
      threadId: binding.threadId,
      approvalPolicy: permissions.approvalPolicy,
      sandboxPolicy,
    });
    if (response && response.error) {
      throw new Error(response.error.message || 'thread/settings/update failed');
    }

    binding.options = { ...binding.options, ...options };
    this.emitAgentRuntime(binding.agentId, {
      permissionMode: options.approvalMode,
      error: '',
    });
    return { threadId: binding.threadId };
  }

  async interruptAgent(agentId) {
    const binding = this.bindings.get(agentId);
    if (!binding || !binding.turnId) return false;

    const response = await binding.entry.connection.request('turn/interrupt', {
      threadId: binding.threadId,
      turnId: binding.turnId,
    });
    if (response && response.error) {
      throw new Error(response.error.message || 'turn/interrupt failed');
    }
    this.emitAgentRuntime(agentId, {
      state: 'interrupting',
    });
    return true;
  }

  async goalBinding(options = {}) {
    let binding = this.bindings.get(options.agentId);
    if (!binding) binding = await this.reattachAgent(options);
    if (!binding.threadId) throw new Error('Codex App Server thread id is required for goal management');
    return binding;
  }

  async getAgentGoal(options = {}) {
    const binding = await this.goalBinding(options);
    const response = await binding.entry.connection.request('thread/goal/get', {
      threadId: binding.threadId,
    });
    const goal = normalizeGoal(readResult(response, 'thread/goal/get').goal, binding.threadId);
    this.emitAgentRuntime(binding.agentId, { goal });
    return goal;
  }

  async setAgentGoal(options = {}) {
    const binding = await this.goalBinding(options);
    const params = { threadId: binding.threadId };
    if (typeof options.objective === 'string') params.objective = options.objective;
    if (Object.prototype.hasOwnProperty.call(options, 'status')) {
      const status = normalizeGoalStatus(options.status);
      if (!status) throw new Error('Unsupported Codex goal status');
      params.status = status;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'tokenBudget')) {
      params.tokenBudget = Number.isFinite(Number(options.tokenBudget)) ? Number(options.tokenBudget) : null;
    }

    const response = await binding.entry.connection.request('thread/goal/set', params);
    const goal = normalizeGoal(readResult(response, 'thread/goal/set').goal, binding.threadId);
    this.emitAgentRuntime(binding.agentId, { goal });
    return goal;
  }

  async clearAgentGoal(options = {}) {
    const binding = await this.goalBinding(options);
    const response = await binding.entry.connection.request('thread/goal/clear', {
      threadId: binding.threadId,
    });
    readResult(response, 'thread/goal/clear');
    this.emitAgentRuntime(binding.agentId, { goal: null });
    return null;
  }

  resolveAgentServerRequest(agentId, requestId, result) {
    const binding = this.bindings.get(agentId);
    if (!binding) throw new Error('Codex App Server agent is not connected');
    const response = binding.entry.connection.resolveServerRequest(requestId, result);
    this.emitAgentRuntime(agentId, {
      pendingRequestId: '',
      pendingRequestMethod: '',
      pendingRequest: null,
      state: binding.turnId ? 'working' : 'idle',
    });
    return response;
  }

  rejectAgentServerRequest(agentId, requestId, error) {
    const binding = this.bindings.get(agentId);
    if (!binding) throw new Error('Codex App Server agent is not connected');
    const response = binding.entry.connection.rejectServerRequest(requestId, error);
    this.emitAgentRuntime(agentId, {
      pendingRequestId: '',
      pendingRequestMethod: '',
      pendingRequest: null,
      state: binding.turnId ? 'working' : 'idle',
    });
    return response;
  }

  unregisterAgent(agentId) {
    const binding = this.bindings.get(agentId);
    if (!binding) return;
    binding.entry.agentIds.delete(agentId);
    this.bindings.delete(agentId);
    this.transcripts.delete(agentId);
    this.releaseUnusedEntry(binding.entry);
  }

  releaseUnusedEntry(entry) {
    if (!entry || entry.agentIds.size > 0) return;
    entry.connection.close();
    this.homes.delete(entry.homePath);
    if (!entry.spawnedByFarming || !entry.child || !Number.isInteger(entry.child.pid)) return;
    try {
      if (process.platform !== 'win32') {
        process.kill(-entry.child.pid, 'SIGTERM');
      } else {
        entry.child.kill('SIGTERM');
      }
    } catch (error) {
      if (error && error.code !== 'ESRCH') {
        console.warn('Failed to stop Codex App Server:', error && (error.message || error));
      }
    }
  }

  statusForAgent(agentId) {
    const binding = this.bindings.get(agentId);
    if (!binding) return null;
    return {
      endpoint: binding.entry.endpoint,
      threadId: binding.threadId,
      turnId: binding.turnId,
      state: binding.state,
    };
  }

  getAgentTranscript(agentId, options = {}) {
    const binding = this.bindings.get(agentId);
    if (!binding) throw new Error('Codex App Server agent is not connected');
    const transcript = this.transcripts.get(agentId) || { events: [], updatedAt: '' };
    const maxTurns = Number.isFinite(options.maxTurns) ? Math.max(1, Math.floor(options.maxTurns)) : undefined;
    return {
      available: true,
      sessionId: binding.threadId,
      updatedAt: transcript.updatedAt || new Date().toISOString(),
      source: 'codex-app-server',
      hasMoreBefore: false,
      truncated: transcript.truncated === true,
      turnLimit: maxTurns,
      turns: buildTranscriptFromEvents(transcript.events, { maxTurns }),
    };
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.homes.values()) {
      entry.connection.close();
    }
    this.homes.clear();
    this.bindings.clear();
    this.transcripts.clear();
    this.transcriptRefreshes.clear();
  }
}

module.exports = {
  CodexAppServerRuntime,
  cliResumeArgs,
  endpointForCodexHome,
  normalizeGoal,
  normalizeCodexRuntimeMode,
  requestThreadParams,
  requestTurnParams,
  socketPathForCodexHome,
};
