const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Writable } = require('stream');
const { createRequire } = require('module');
const packageJson = require('../package.json');
const { AcpSessionState } = require('./acp-session-state');

const ADAPTER_VERSIONS = Object.freeze({
  codex: '1.1.2',
  claude: '0.58.1',
  opencode: 'native',
  qoder: 'native',
});
const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_SETUP_TIMEOUT_MS = 120_000;
const DEFAULT_HISTORY_REPLAY_MIN_WAIT_MS = 350;
const DEFAULT_HISTORY_REPLAY_QUIET_MS = 150;
const DEFAULT_HISTORY_REPLAY_MAX_WAIT_MS = 5_000;

let sdkPromise;
const runtimeRequire = createRequire(__filename);
function loadAcpSdk() {
  if (!sdkPromise) sdkPromise = import('@agentclientprotocol/sdk');
  return sdkPromise;
}

function adapterEntry(packageName) {
  let sdkDirectory;
  try {
    sdkDirectory = path.dirname(runtimeRequire.resolve('@agentclientprotocol/sdk'));
  } catch {
    throw new Error('ACP runtime packages are unavailable in this installation. Use the npm or app-bundle distribution.');
  }
  const entry = path.resolve(sdkDirectory, '..', '..', packageName.split('/').pop(), 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`ACP adapter is not installed: ${packageName}`);
  return entry;
}

function resolveAcpLaunch(provider, options = {}) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'codex') {
    return {
      command: process.execPath,
      args: [adapterEntry('@agentclientprotocol/codex-acp')],
      version: ADAPTER_VERSIONS.codex,
    };
  }
  if (normalized === 'claude') {
    return {
      command: process.execPath,
      args: [adapterEntry('@agentclientprotocol/claude-agent-acp')],
      version: ADAPTER_VERSIONS.claude,
    };
  }
  if (normalized === 'opencode') {
    return {
      command: options.executable || 'opencode',
      args: ['acp', '--cwd', path.resolve(options.cwd || process.cwd())],
      version: ADAPTER_VERSIONS.opencode,
    };
  }
  if (normalized === 'qoder') {
    return {
      command: options.executable || 'qodercli',
      args: ['--acp'],
      version: ADAPTER_VERSIONS.qoder,
    };
  }
  throw new Error(`Unsupported ACP provider: ${provider}`);
}

function selectedPermission(option) {
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function acpErrorMessage(error) {
  const message = error && error.message ? error.message : String(error || 'ACP request failed');
  const details = error?.data?.details;
  return typeof details === 'string' && details && details !== message
    ? `${message}: ${details}`
    : message;
}

function autoPermissionResponse(request, approvalMode) {
  const options = Array.isArray(request?.options) ? request.options : [];
  if (approvalMode === 'full') {
    const option = options.find(item => item.kind === 'allow_always')
      || options.find(item => item.kind === 'allow_once');
    return option ? selectedPermission(option) : { outcome: { outcome: 'cancelled' } };
  }
  if (approvalMode === 'ask') {
    const option = options.find(item => item.kind === 'reject_once')
      || options.find(item => item.kind === 'reject_always');
    return option ? selectedPermission(option) : { outcome: { outcome: 'cancelled' } };
  }
  return null;
}

class AcpRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawn = options.spawn || spawn;
    this.createConnection = options.createConnection || null;
    this.resolveLaunch = options.resolveLaunch || resolveAcpLaunch;
    this.maxUpdates = options.maxUpdates;
    this.initializeTimeoutMs = options.initializeTimeoutMs || DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.sessionSetupTimeoutMs = options.sessionSetupTimeoutMs || DEFAULT_SESSION_SETUP_TIMEOUT_MS;
    this.historyReplayMinWaitMs = options.historyReplayMinWaitMs ?? DEFAULT_HISTORY_REPLAY_MIN_WAIT_MS;
    this.historyReplayQuietMs = options.historyReplayQuietMs ?? DEFAULT_HISTORY_REPLAY_QUIET_MS;
    this.historyReplayMaxWaitMs = options.historyReplayMaxWaitMs ?? DEFAULT_HISTORY_REPLAY_MAX_WAIT_MS;
    this.bindings = new Map();
    this.permissionSequence = 0;
  }

  async prepareAgent(options = {}) {
    const agentId = String(options.agentId || '');
    if (!agentId) throw new Error('ACP Agent id is required');
    if (this.bindings.has(agentId)) throw new Error('ACP Agent is already registered');
    const provider = String(options.provider || '').trim().toLowerCase();
    const launch = this.resolveLaunch(provider, options);
    const binding = {
      agentId,
      provider,
      cwd: path.resolve(options.cwd || process.cwd()),
      env: options.env || process.env,
      launch,
      approvalMode: options.approvalMode || 'approve',
      child: null,
      connection: null,
      initializeResponse: null,
      sessionId: '',
      state: 'connecting',
      error: '',
      stopReason: '',
      modes: null,
      configOptions: [],
      pendingPermissions: new Map(),
      permissionResolvers: new Map(),
      sessionState: null,
      stderr: '',
      updatedAt: new Date().toISOString(),
    };
    this.bindings.set(agentId, binding);
    this.emitRuntime(binding);

    try {
      const child = this.spawn(launch.command, launch.args, {
        cwd: binding.cwd,
        env: binding.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      binding.child = child;
      child.stderr.on('data', chunk => {
        binding.stderr = `${binding.stderr}${chunk.toString('utf8')}`.slice(-16_000);
      });
      child.on('error', error => this.handleExit(binding, error));
      child.on('close', (code, signal) => {
        if (!binding.connection?.signal?.aborted) {
          const detail = binding.stderr.trim() || `ACP adapter exited with code ${code}${signal ? ` (${signal})` : ''}`;
          this.handleExit(binding, code === 0 ? null : new Error(detail));
        }
      });

      const connection = this.createConnection
        ? await this.createConnection(this.clientHandlers(binding), child, binding)
        : await this.officialConnection(this.clientHandlers(binding), child);
      binding.connection = connection;
      connection.closed.catch(error => this.handleExit(binding, error));
      const sdk = await loadAcpSdk();
      binding.initializeResponse = await withTimeout(connection.initialize({
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { configOptions: { boolean: {} } },
          plan: {},
        },
        clientInfo: { name: 'farming', title: 'Farming', version: packageJson.version || '0.0.0' },
      }), this.initializeTimeoutMs, 'ACP initialize');
      if (binding.initializeResponse.protocolVersion !== sdk.PROTOCOL_VERSION) {
        throw new Error(`ACP protocol version mismatch: Agent selected ${binding.initializeResponse.protocolVersion}, Farming supports ${sdk.PROTOCOL_VERSION}`);
      }

      const requestedSessionId = String(options.sessionId || '').trim();
      const sessionRequest = { sessionId: requestedSessionId, cwd: binding.cwd, mcpServers: [] };
      let sessionResponse;
      let historyMode = 'new';
      if (requestedSessionId) {
        const capabilities = binding.initializeResponse.agentCapabilities || {};
        if (options.historyMode !== 'resume' && capabilities.loadSession) {
          binding.sessionId = requestedSessionId;
          binding.sessionState = new AcpSessionState({ provider, sessionId: requestedSessionId, cwd: binding.cwd, maxUpdates: this.maxUpdates });
          sessionResponse = await withTimeout(
            connection.loadSession(sessionRequest),
            this.sessionSetupTimeoutMs,
            'ACP session/load'
          );
          if (provider === 'qoder') await this.waitForHistoryReplay(binding);
          binding.sessionState.finishHistoryReplay();
          historyMode = 'load';
        } else if (capabilities.sessionCapabilities?.resume) {
          binding.sessionId = requestedSessionId;
          binding.sessionState = new AcpSessionState({ provider, sessionId: requestedSessionId, cwd: binding.cwd, maxUpdates: this.maxUpdates });
          sessionResponse = await withTimeout(
            connection.resumeSession(sessionRequest),
            this.sessionSetupTimeoutMs,
            'ACP session/resume'
          );
          historyMode = 'resume';
        } else {
          throw new Error(`${provider} ACP Agent cannot load or resume session ${requestedSessionId}`);
        }
      } else {
        sessionResponse = await withTimeout(
          connection.newSession({ cwd: binding.cwd, mcpServers: [] }),
          this.sessionSetupTimeoutMs,
          'ACP session/new'
        );
        binding.sessionId = String(sessionResponse.sessionId || '');
        if (!binding.sessionId) throw new Error('ACP session/new did not return a session id');
        binding.sessionState = new AcpSessionState({ provider, sessionId: binding.sessionId, cwd: binding.cwd, maxUpdates: this.maxUpdates });
      }
      binding.modes = sessionResponse?.modes || null;
      binding.configOptions = sessionResponse?.configOptions || [];
      binding.sessionState.currentModeId = String(binding.modes?.currentModeId || '');
      binding.sessionState.configOptions = JSON.parse(JSON.stringify(binding.configOptions));
      binding.state = 'idle';
      binding.updatedAt = new Date().toISOString();
      this.emitRuntime(binding);
      this.emitSession(binding);
      return {
        sessionId: binding.sessionId,
        historyMode,
        protocolVersion: binding.initializeResponse.protocolVersion,
        agentInfo: binding.initializeResponse.agentInfo || null,
        capabilities: binding.initializeResponse.agentCapabilities || {},
        adapter: launch,
      };
    } catch (error) {
      const runtimeError = new Error(acpErrorMessage(error), { cause: error });
      this.handleExit(binding, runtimeError);
      this.unregisterAgent(agentId);
      throw runtimeError;
    }
  }

  async officialConnection(handlers, child) {
    const sdk = await loadAcpSdk();
    const stream = sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    return new sdk.ClientSideConnection(() => handlers, stream);
  }

  async waitForHistoryReplay(binding) {
    const startedAt = Date.now();
    let lastUpdateCount = binding.sessionState?.updates.length || 0;
    let lastChangedAt = startedAt;
    while (Date.now() - startedAt < this.historyReplayMaxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const now = Date.now();
      const updateCount = binding.sessionState?.updates.length || 0;
      if (updateCount !== lastUpdateCount) {
        lastUpdateCount = updateCount;
        lastChangedAt = now;
      }
      if (
        now - startedAt >= this.historyReplayMinWaitMs
        && now - lastChangedAt >= this.historyReplayQuietMs
      ) return;
    }
  }

  clientHandlers(binding) {
    return {
      sessionUpdate: notification => {
        if (binding.sessionState?.apply(notification)) {
          const update = notification?.update;
          if (update?.sessionUpdate === 'current_mode_update' && binding.modes) {
            binding.modes = { ...binding.modes, currentModeId: String(update.currentModeId || '') };
          }
          if (update?.sessionUpdate === 'config_option_update') {
            binding.configOptions = JSON.parse(JSON.stringify(update.configOptions || []));
          }
          binding.updatedAt = new Date().toISOString();
          this.emitSession(binding);
        }
      },
      requestPermission: request => this.requestPermission(binding, request),
    };
  }

  requestPermission(binding, request) {
    const automatic = autoPermissionResponse(request, binding.approvalMode);
    if (automatic) return automatic;
    const requestId = `acp-permission-${++this.permissionSequence}`;
    binding.state = 'waiting-for-permission';
    binding.pendingPermissions.set(requestId, { requestId, ...JSON.parse(JSON.stringify(request)) });
    this.emitRuntime(binding);
    return new Promise(resolve => binding.permissionResolvers.set(requestId, resolve));
  }

  respondPermission(agentId, requestId, optionId, cancelled = false) {
    const binding = this.requireBinding(agentId);
    const pending = binding.pendingPermissions.get(String(requestId || ''));
    const resolve = binding.permissionResolvers.get(String(requestId || ''));
    if (!pending || pending.requestId !== requestId || !resolve) throw new Error('ACP permission request is no longer pending');
    let response = { outcome: { outcome: 'cancelled' } };
    if (!cancelled) {
      const option = pending.options.find(item => item.optionId === optionId);
      if (!option) throw new Error('Unknown ACP permission option');
      response = selectedPermission(option);
    }
    binding.permissionResolvers.delete(requestId);
    binding.pendingPermissions.delete(requestId);
    binding.state = binding.pendingPermissions.size > 0 ? 'waiting-for-permission' : 'working';
    resolve(response);
    this.emitRuntime(binding);
    return response;
  }

  async prompt(agentId, prompt) {
    const binding = this.requireBinding(agentId);
    if (!['idle', 'error'].includes(binding.state)) throw new Error(`ACP Agent is not ready (${binding.state})`);
    const content = Array.isArray(prompt) ? prompt : [{ type: 'text', text: String(prompt || '') }];
    binding.sessionState.beginPrompt(content);
    binding.state = 'working';
    binding.error = '';
    binding.stopReason = '';
    this.emitRuntime(binding);
    this.emitSession(binding);
    try {
      const response = await binding.connection.prompt({ sessionId: binding.sessionId, prompt: content });
      binding.stopReason = String(response?.stopReason || '');
      binding.sessionState.completePrompt(binding.stopReason);
      binding.state = 'idle';
      binding.updatedAt = new Date().toISOString();
      this.emitSession(binding);
      this.emitRuntime(binding);
      return { sessionId: binding.sessionId, stopReason: binding.stopReason };
    } catch (error) {
      const runtimeError = new Error(acpErrorMessage(error), { cause: error });
      binding.sessionState.completePrompt('error');
      binding.state = 'error';
      binding.error = runtimeError.message;
      this.emitSession(binding);
      this.emitRuntime(binding);
      throw runtimeError;
    }
  }

  async cancel(agentId) {
    const binding = this.requireBinding(agentId);
    if (!binding.sessionId) return false;
    binding.state = 'interrupting';
    for (const resolve of binding.permissionResolvers.values()) {
      resolve({ outcome: { outcome: 'cancelled' } });
    }
    binding.permissionResolvers.clear();
    binding.pendingPermissions.clear();
    this.emitRuntime(binding);
    await binding.connection.cancel({ sessionId: binding.sessionId });
    return true;
  }

  async listSessions(agentId, options = {}) {
    const binding = this.requireBinding(agentId);
    const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.list) throw new Error(`${binding.provider} ACP Agent does not support session/list`);
    return binding.connection.listSessions({
      ...(options.cwd ? { cwd: path.resolve(options.cwd) } : {}),
      ...(options.cursor ? { cursor: String(options.cursor) } : {}),
    });
  }

  async authenticate(agentId, methodId) {
    const binding = this.requireBinding(agentId);
    const method = binding.initializeResponse?.authMethods?.find(item => item.id === methodId);
    if (!method) throw new Error('Unknown ACP authentication method');
    await binding.connection.authenticate({ methodId });
    return { authenticated: true, methodId };
  }

  async forkSession(agentId, options = {}) {
    const binding = this.requireBinding(agentId);
    const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.fork) throw new Error(`${binding.provider} ACP Agent does not support session/fork`);
    return binding.connection.unstable_forkSession({
      sessionId: options.sessionId || binding.sessionId,
      cwd: path.resolve(options.cwd || binding.cwd),
      additionalDirectories: Array.isArray(options.additionalDirectories)
        ? options.additionalDirectories.map(directory => path.resolve(directory))
        : [],
      mcpServers: [],
    });
  }

  async deleteSession(agentId, sessionId) {
    const binding = this.requireBinding(agentId);
    const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.delete) throw new Error(`${binding.provider} ACP Agent does not support session/delete`);
    await binding.connection.deleteSession({ sessionId: String(sessionId || '') });
    return { deleted: true, sessionId: String(sessionId || '') };
  }

  async closeSession(agentId) {
    const binding = this.requireBinding(agentId);
    const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.close) throw new Error(`${binding.provider} ACP Agent does not support session/close`);
    await binding.connection.closeSession({ sessionId: binding.sessionId });
    binding.state = 'closed';
    this.emitRuntime(binding);
    return { closed: true, sessionId: binding.sessionId };
  }

  async setSessionMode(agentId, modeId) {
    const binding = this.requireBinding(agentId);
    await binding.connection.setSessionMode({ sessionId: binding.sessionId, modeId: String(modeId || '') });
    binding.sessionState.currentModeId = String(modeId || '');
    if (binding.modes) binding.modes = { ...binding.modes, currentModeId: binding.sessionState.currentModeId };
    this.emitSession(binding);
    return { sessionId: binding.sessionId, modeId: binding.sessionState.currentModeId };
  }

  async setSessionConfigOption(agentId, configId, value) {
    const binding = this.requireBinding(agentId);
    const request = typeof value === 'boolean'
      ? { sessionId: binding.sessionId, configId: String(configId || ''), type: 'boolean', value }
      : { sessionId: binding.sessionId, configId: String(configId || ''), value: String(value ?? '') };
    const response = await binding.connection.setSessionConfigOption(request);
    binding.configOptions = response?.configOptions || binding.configOptions;
    binding.sessionState.configOptions = JSON.parse(JSON.stringify(binding.configOptions));
    this.emitSession(binding);
    return { sessionId: binding.sessionId, configOptions: binding.configOptions };
  }

  getSession(agentId, options = {}) {
    const binding = this.requireBinding(agentId);
    const runtimeState = {
      state: binding.state,
      error: binding.error,
      stopReason: binding.stopReason,
      protocolVersion: binding.initializeResponse?.protocolVersion || null,
      agentInfo: binding.initializeResponse?.agentInfo || null,
      capabilities: binding.initializeResponse?.agentCapabilities || {},
      authMethods: binding.initializeResponse?.authMethods || [],
      modes: binding.modes,
      configOptions: binding.configOptions,
      pendingPermission: binding.pendingPermissions.values().next().value || null,
      pendingPermissions: [...binding.pendingPermissions.values()],
      adapter: binding.launch,
      updatedAt: binding.updatedAt,
    };
    if (!binding.sessionState) {
      return {
        version: 1,
        protocol: 'acp',
        provider: binding.provider,
        sessionId: binding.sessionId,
        cwd: binding.cwd,
        title: '',
        updatedAt: binding.updatedAt,
        truncated: false,
        entries: [],
        usage: null,
        availableCommands: [],
        currentModeId: '',
        configOptions: [],
        ...runtimeState,
      };
    }
    return binding.sessionState.snapshot(runtimeState, options);
  }

  requireBinding(agentId) {
    const binding = this.bindings.get(agentId);
    if (!binding) throw new Error('ACP Agent is not registered');
    return binding;
  }

  emitRuntime(binding) {
    this.emit('agent-runtime', {
      agentId: binding.agentId,
      provider: binding.provider,
      sessionId: binding.sessionId,
      state: binding.state,
      error: binding.error,
      stopReason: binding.stopReason,
      pendingPermission: binding.pendingPermissions.values().next().value || null,
      pendingPermissions: [...binding.pendingPermissions.values()],
      updatedAt: binding.updatedAt,
    });
  }

  emitSession(binding) {
    this.emit('session', { agentId: binding.agentId, updatedAt: binding.updatedAt });
  }

  handleExit(binding, error) {
    if (!this.bindings.has(binding.agentId)) return;
    if (error) {
      binding.state = 'error';
      binding.error = acpErrorMessage(error);
    } else if (binding.state !== 'error') {
      binding.state = 'stopped';
    }
    for (const resolve of binding.permissionResolvers.values()) {
      resolve({ outcome: { outcome: 'cancelled' } });
    }
    binding.permissionResolvers.clear();
    binding.pendingPermissions.clear();
    this.emitRuntime(binding);
  }

  unregisterAgent(agentId) {
    const binding = this.bindings.get(agentId);
    if (!binding) return;
    this.bindings.delete(agentId);
    for (const resolve of binding.permissionResolvers.values()) resolve({ outcome: { outcome: 'cancelled' } });
    binding.permissionResolvers.clear();
    binding.pendingPermissions.clear();
    try {
      binding.connection?.close();
    } catch {
      // The adapter process is terminated below even if transport cleanup raced its exit.
    }
    if (binding.child && !binding.child.killed) binding.child.kill('SIGTERM');
  }

  dispose() {
    for (const agentId of [...this.bindings.keys()]) this.unregisterAgent(agentId);
  }
}

module.exports = {
  AcpRuntime,
  ADAPTER_VERSIONS,
  autoPermissionResponse,
  resolveAcpLaunch,
};
