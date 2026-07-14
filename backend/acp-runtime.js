const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Writable } = require('stream');
const { createRequire } = require('module');
const packageJson = require('../package.json');
const { AcpSessionState } = require('./acp-session-state');
const { AcpClientFileSystem, AcpClientTerminalManager } = require('./acp/client-services');
const { permissionSecurityWarnings } = require('./acp/permission-security');
const { rejectPatch } = require('./acp/patch-decisions');

const ADAPTER_VERSIONS = Object.freeze({
  codex: '1.1.2',
  claude: '0.58.1',
  opencode: 'native',
  qoder: 'native',
});
const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_SETUP_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;
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

function codexAcpEnvironment(options = {}) {
  const env = { ...(options.env || process.env) };
  let config = {};
  if (env.CODEX_CONFIG) {
    try {
      const parsed = JSON.parse(env.CODEX_CONFIG);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch {
      // A selected Farming profile below replaces an invalid adapter config.
    }
  }

  if (options.model && options.model !== 'config') config.model = options.model;
  if (options.reasoningEffort && options.reasoningEffort !== 'config') {
    config.model_reasoning_effort = options.reasoningEffort;
  }
  if (options.serviceTier && !['config', 'default'].includes(options.serviceTier)) {
    config.service_tier = options.serviceTier;
  }
  if (Object.keys(config).length > 0) env.CODEX_CONFIG = JSON.stringify(config);

  const initialMode = {
    ask: 'read-only',
    approve: 'agent',
    full: 'agent-full-access',
  }[options.approvalMode];
  if (initialMode) env.INITIAL_AGENT_MODE = initialMode;
  return env;
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

function acpErrorKind(error) {
  const message = (error && error.message ? error.message : String(error || '')).toLowerCase();
  const code = String(error?.code || error?.data?.code || '').toLowerCase();
  const text = `${code} ${message}`;
  if (/\b(401|unauthorized|authentication|authenticate|login|sign[ -]?in|invalid api key)\b/.test(text)) return 'authentication';
  if (/\b(402|payment|billing|credit|insufficient quota)\b/.test(text)) return 'payment';
  if (/context (?:window|length|limit)|too many tokens|max(?:imum)? tokens/.test(text)) return 'context';
  if (/\b(model_not_found|unknown model|model unavailable|unsupported model)\b/.test(text)) return 'model';
  if (/\b(429|rate[ -]?limit|too many requests)\b/.test(text)) return 'rate-limit';
  if (/\b(econn|enet|ehost|socket|network|connection|timed? out|timeout|dns)\b/.test(text)) return 'network';
  if (/\b(protocol|json-rpc|parse error|invalid request|method not found)\b/.test(text)) return 'protocol';
  return 'unknown';
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

function validateElicitationContent(request, content) {
  if (request?.mode !== 'form') return undefined;
  const value = content && typeof content === 'object' && !Array.isArray(content) ? content : {};
  const schema = request.requestedSchema && typeof request.requestedSchema === 'object'
    ? request.requestedSchema
    : {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) throw new Error(`ACP input is required: ${name}`);
  }
  for (const [name, fieldValue] of Object.entries(value)) {
    const property = properties[name];
    if (!property || typeof property !== 'object') throw new Error(`Unknown ACP input field: ${name}`);
    if (property.type === 'string' && typeof fieldValue !== 'string') throw new Error(`ACP input must be text: ${name}`);
    if (property.type === 'number' && (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue))) {
      throw new Error(`ACP input must be a number: ${name}`);
    }
    if (property.type === 'integer' && !Number.isInteger(fieldValue)) throw new Error(`ACP input must be an integer: ${name}`);
    if (property.type === 'boolean' && typeof fieldValue !== 'boolean') throw new Error(`ACP input must be true or false: ${name}`);
    if (property.type === 'array' && (!Array.isArray(fieldValue) || fieldValue.some(item => typeof item !== 'string'))) {
      throw new Error(`ACP input must be a text selection: ${name}`);
    }
    if (typeof fieldValue === 'string') {
      if (Number.isFinite(property.minLength) && fieldValue.length < property.minLength) throw new Error(`ACP input is too short: ${name}`);
      if (Number.isFinite(property.maxLength) && fieldValue.length > property.maxLength) throw new Error(`ACP input is too long: ${name}`);
      if (typeof property.pattern === 'string') {
        let pattern;
        try {
          pattern = new RegExp(property.pattern);
        } catch {
          throw new Error(`ACP input schema has an invalid pattern: ${name}`);
        }
        if (!pattern.test(fieldValue)) throw new Error(`ACP input has an invalid format: ${name}`);
      }
      const allowed = Array.isArray(property.enum)
        ? property.enum
        : Array.isArray(property.oneOf)
          ? property.oneOf.map(option => option?.const)
          : null;
      if (allowed && !allowed.includes(fieldValue)) throw new Error(`ACP input is not an allowed choice: ${name}`);
    }
    if (typeof fieldValue === 'number') {
      if (Number.isFinite(property.minimum) && fieldValue < property.minimum) throw new Error(`ACP input is below the minimum: ${name}`);
      if (Number.isFinite(property.maximum) && fieldValue > property.maximum) throw new Error(`ACP input is above the maximum: ${name}`);
    }
    if (Array.isArray(fieldValue)) {
      if (Number.isFinite(property.minItems) && fieldValue.length < property.minItems) throw new Error(`ACP input needs more selections: ${name}`);
      if (Number.isFinite(property.maxItems) && fieldValue.length > property.maxItems) throw new Error(`ACP input has too many selections: ${name}`);
      const allowedItems = Array.isArray(property.items?.enum)
        ? property.items.enum
        : Array.isArray(property.items?.anyOf)
          ? property.items.anyOf.map(option => option?.const)
          : null;
      if (allowedItems && fieldValue.some(item => !allowedItems.includes(item))) {
        throw new Error(`ACP input contains an unknown selection: ${name}`);
      }
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function interactiveRuntimeState(binding, fallback = '') {
  if (binding.pendingPermissions.size > 0) return 'waiting-for-permission';
  if (binding.pendingElicitations.size > 0) return 'waiting-for-input';
  if (binding.promptActive) return 'working';
  if (['connecting', 'idle', 'error'].includes(String(fallback || ''))) return fallback;
  return binding.sessionId ? 'idle' : 'connecting';
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
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.cancelTimeoutMs = options.cancelTimeoutMs || DEFAULT_CANCEL_TIMEOUT_MS;
    this.historyReplayMinWaitMs = options.historyReplayMinWaitMs ?? DEFAULT_HISTORY_REPLAY_MIN_WAIT_MS;
    this.historyReplayQuietMs = options.historyReplayQuietMs ?? DEFAULT_HISTORY_REPLAY_QUIET_MS;
    this.historyReplayMaxWaitMs = options.historyReplayMaxWaitMs ?? DEFAULT_HISTORY_REPLAY_MAX_WAIT_MS;
    this.bindings = new Map();
    this.permissionSequence = 0;
    this.elicitationSequence = 0;
    this.clientFileSystem = options.clientFileSystem || new AcpClientFileSystem();
    this.clientTerminals = options.clientTerminals || new AcpClientTerminalManager({ spawn: options.terminalSpawn });
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
      env: provider === 'codex' ? codexAcpEnvironment(options) : (options.env || process.env),
      launch,
      restartOptions: { ...options, agentId, provider },
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
      pendingElicitations: new Map(),
      elicitationResolvers: new Map(),
      activeElicitations: new Map(),
      subagentStates: new Map(),
      interactionOrigins: new Map(),
      promptActive: false,
      sessionState: null,
      authTerminal: null,
      patchDecisions: new Map(),
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
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          auth: { terminal: true },
          session: { configOptions: { boolean: {} } },
          plan: {},
          elicitation: { form: {}, url: {} },
          _meta: { terminal_output: true },
        },
        clientInfo: { name: 'farming', title: 'Farming', version: packageJson.version || '0.0.0' },
      }), this.initializeTimeoutMs, 'ACP initialize');
      if (binding.initializeResponse.protocolVersion !== sdk.PROTOCOL_VERSION) {
        throw new Error(`ACP protocol version mismatch: Agent selected ${binding.initializeResponse.protocolVersion}, Farming supports ${sdk.PROTOCOL_VERSION}`);
      }

      const requestedSessionId = String(options.sessionId || '').trim();
      const revisionBase = Number.isFinite(Number(options.revisionBase))
        ? Math.max(0, Math.floor(Number(options.revisionBase)))
        : 0;
      const sessionRequest = { sessionId: requestedSessionId, cwd: binding.cwd, mcpServers: [] };
      let sessionResponse;
      let historyMode = 'new';
      if (requestedSessionId) {
        const capabilities = binding.initializeResponse.agentCapabilities || {};
        if (options.historyMode !== 'resume' && capabilities.loadSession) {
          binding.sessionId = requestedSessionId;
          binding.sessionState = new AcpSessionState({
            provider,
            sessionId: requestedSessionId,
            cwd: binding.cwd,
            maxUpdates: this.maxUpdates,
            revisionBase,
            resetBeforeRevision: revisionBase,
          });
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
          binding.sessionState = new AcpSessionState({
            provider,
            sessionId: requestedSessionId,
            cwd: binding.cwd,
            maxUpdates: this.maxUpdates,
            revisionBase,
          });
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
        const notificationSessionId = String(notification?.sessionId || '');
        const isPrimarySession = !binding.sessionId || !notificationSessionId || notificationSessionId === binding.sessionId;
        let targetState = isPrimarySession ? binding.sessionState : binding.subagentStates.get(notificationSessionId);
        if (!targetState && notificationSessionId && binding.subagentStates.size < 32) {
          targetState = new AcpSessionState({
            provider: binding.provider,
            sessionId: notificationSessionId,
            cwd: binding.cwd,
            maxUpdates: this.maxUpdates,
          });
          binding.subagentStates.set(notificationSessionId, targetState);
        }
        if (targetState?.apply(notification)) {
          const update = notification?.update;
          if (isPrimarySession && update?.sessionUpdate === 'current_mode_update' && binding.modes) {
            binding.modes = { ...binding.modes, currentModeId: String(update.currentModeId || '') };
          }
          if (isPrimarySession && update?.sessionUpdate === 'config_option_update') {
            binding.configOptions = JSON.parse(JSON.stringify(update.configOptions || []));
          }
          if (!isPrimarySession && binding.sessionState) {
            const parentTool = binding.sessionState.entries.find(entry => (
              entry?.type === 'tool'
              && String(entry?._meta?.subagent_session_info?.session_id || '') === notificationSessionId
            ));
            if (parentTool) binding.sessionState.touchEntry(parentTool);
          }
          binding.updatedAt = new Date().toISOString();
          this.emitSession(binding);
        }
      },
      requestPermission: request => this.requestPermission(binding, request),
      readTextFile: request => this.clientFileSystem.readTextFile(binding, request),
      writeTextFile: request => this.clientFileSystem.writeTextFile(binding, request),
      createTerminal: request => this.clientTerminals.create(binding, request),
      terminalOutput: request => this.clientTerminals.output(binding, request),
      waitForTerminalExit: request => this.clientTerminals.waitForExit(binding, request),
      killTerminal: request => this.clientTerminals.kill(binding, request),
      releaseTerminal: request => this.clientTerminals.release(binding, request),
      unstable_createElicitation: request => this.requestElicitation(binding, request),
      unstable_completeElicitation: notification => this.completeElicitation(binding, notification),
    };
  }

  requestPermission(binding, request) {
    const automatic = autoPermissionResponse(request, binding.approvalMode);
    if (automatic) return automatic;
    const requestId = `acp-permission-${++this.permissionSequence}`;
    binding.interactionOrigins.set(requestId, binding.state);
    binding.state = 'waiting-for-permission';
    const pending = { ...JSON.parse(JSON.stringify(request)), requestId };
    pending.origin = String(request?.sessionId || '') && String(request.sessionId) !== binding.sessionId
      ? 'subagent'
      : 'agent';
    pending.securityWarnings = permissionSecurityWarnings(pending);
    binding.pendingPermissions.set(requestId, pending);
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
    const origin = binding.interactionOrigins.get(requestId);
    binding.interactionOrigins.delete(requestId);
    binding.state = interactiveRuntimeState(binding, origin);
    resolve(response);
    this.emitRuntime(binding);
    return response;
  }

  requestElicitation(binding, request) {
    const requestSessionId = String(request?.sessionId || binding.sessionId);
    const isPrimarySession = requestSessionId === binding.sessionId;
    if (!isPrimarySession && !binding.subagentStates.has(requestSessionId)) {
      throw new Error('ACP elicitation does not match an active session');
    }
    if (!['form', 'url'].includes(String(request?.mode || ''))) {
      return { action: 'cancel' };
    }
    const requestId = `acp-elicitation-${++this.elicitationSequence}`;
    const cloned = JSON.parse(JSON.stringify(request));
    const protocolRequestId = Object.prototype.hasOwnProperty.call(cloned, 'requestId')
      ? cloned.requestId
      : undefined;
    delete cloned.requestId;
    const pending = {
      ...cloned,
      ...(protocolRequestId !== undefined ? { protocolRequestId } : {}),
      requestId,
      origin: isPrimarySession ? 'agent' : 'subagent',
    };
    binding.interactionOrigins.set(requestId, binding.state);
    binding.pendingElicitations.set(requestId, pending);
    binding.state = 'waiting-for-input';
    this.emitRuntime(binding);
    return new Promise(resolve => binding.elicitationResolvers.set(requestId, resolve));
  }

  respondElicitation(agentId, requestId, action, content) {
    const binding = this.requireBinding(agentId);
    const id = String(requestId || '');
    const pending = binding.pendingElicitations.get(id);
    const resolve = binding.elicitationResolvers.get(id);
    if (!pending || !resolve) throw new Error('ACP input request is no longer pending');
    const normalizedAction = String(action || 'cancel');
    if (!['accept', 'decline', 'cancel'].includes(normalizedAction)) throw new Error('Unknown ACP input action');
    const response = normalizedAction === 'accept'
      ? { action: 'accept', ...(pending.mode === 'form' ? { content: validateElicitationContent(pending, content) } : {}) }
      : { action: normalizedAction };
    binding.elicitationResolvers.delete(id);
    binding.pendingElicitations.delete(id);
    if (pending.mode === 'url' && normalizedAction === 'accept') {
      binding.activeElicitations.set(String(pending.elicitationId || id), { ...pending, status: 'accepted' });
    }
    const origin = binding.interactionOrigins.get(id);
    binding.interactionOrigins.delete(id);
    binding.state = interactiveRuntimeState(binding, origin);
    resolve(response);
    this.emitRuntime(binding);
    return response;
  }

  completeElicitation(binding, notification) {
    const elicitationId = String(notification?.elicitationId || '');
    if (elicitationId) binding.activeElicitations.delete(elicitationId);
    this.emitRuntime(binding);
  }

  async prompt(agentId, prompt) {
    const binding = this.requireBinding(agentId);
    if (!['idle', 'error'].includes(binding.state)) throw new Error(`ACP Agent is not ready (${binding.state})`);
    const content = Array.isArray(prompt) ? prompt : [{ type: 'text', text: String(prompt || '') }];
    binding.sessionState.beginPrompt(content);
    binding.promptActive = true;
    binding.state = 'working';
    binding.error = '';
    binding.stopReason = '';
    this.emitRuntime(binding);
    this.emitSession(binding);
    try {
      const response = await binding.connection.prompt({ sessionId: binding.sessionId, prompt: content });
      binding.stopReason = String(response?.stopReason || '');
      binding.sessionState.completePrompt(binding.stopReason);
      binding.promptActive = false;
      binding.state = 'idle';
      binding.updatedAt = new Date().toISOString();
      this.emitSession(binding);
      this.emitRuntime(binding);
      return { sessionId: binding.sessionId, stopReason: binding.stopReason };
    } catch (error) {
      const runtimeError = new Error(acpErrorMessage(error), { cause: error });
      binding.stopReason = 'error';
      // JSON-RPC implementations commonly move the actionable provider text
      // into error.data.details. Classify the normalized message so the
      // ordered transcript and runtime snapshot cannot disagree.
      binding.sessionState.recordError(runtimeError.message, acpErrorKind(runtimeError));
      binding.sessionState.completePrompt('error');
      binding.promptActive = false;
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
    for (const resolve of binding.elicitationResolvers.values()) resolve({ action: 'cancel' });
    binding.permissionResolvers.clear();
    binding.pendingPermissions.clear();
    binding.elicitationResolvers.clear();
    binding.pendingElicitations.clear();
    binding.activeElicitations.clear();
    binding.interactionOrigins.clear();
    this.emitRuntime(binding);
    try {
      await withTimeout(
        binding.connection.cancel({ sessionId: binding.sessionId }),
        this.cancelTimeoutMs,
        'ACP session/cancel'
      );
      return true;
    } catch (error) {
      const runtimeError = new Error(acpErrorMessage(error), { cause: error });
      binding.state = 'error';
      binding.error = runtimeError.message;
      binding.stopReason = 'cancel_error';
      binding.updatedAt = new Date().toISOString();
      this.emitSession(binding);
      this.emitRuntime(binding);
      throw runtimeError;
    }
  }

  async cancelSubagent(agentId, sessionId) {
    const binding = this.requireBinding(agentId);
    const targetSessionId = String(sessionId || '');
    if (!targetSessionId || targetSessionId === binding.sessionId || !binding.subagentStates.has(targetSessionId)) {
      throw new Error('ACP subagent session not found');
    }
    for (const [requestId, pending] of binding.pendingPermissions.entries()) {
      if (String(pending?.sessionId || '') !== targetSessionId) continue;
      binding.permissionResolvers.get(requestId)?.({ outcome: { outcome: 'cancelled' } });
      binding.permissionResolvers.delete(requestId);
      binding.pendingPermissions.delete(requestId);
      binding.interactionOrigins.delete(requestId);
    }
    for (const [requestId, pending] of binding.pendingElicitations.entries()) {
      if (String(pending?.sessionId || '') !== targetSessionId) continue;
      binding.elicitationResolvers.get(requestId)?.({ action: 'cancel' });
      binding.elicitationResolvers.delete(requestId);
      binding.pendingElicitations.delete(requestId);
      binding.interactionOrigins.delete(requestId);
    }
    for (const [elicitationId, active] of binding.activeElicitations.entries()) {
      if (String(active?.sessionId || '') === targetSessionId) binding.activeElicitations.delete(elicitationId);
    }
    binding.state = interactiveRuntimeState(binding, binding.state);
    this.emitRuntime(binding);
    await withTimeout(
      binding.connection.cancel({ sessionId: targetSessionId }),
      this.cancelTimeoutMs,
      'ACP subagent session/cancel'
    );
    binding.updatedAt = new Date().toISOString();
    this.emitSession(binding);
    this.emitRuntime(binding);
    return { cancelled: true, sessionId: targetSessionId };
  }

  async listSessions(agentId, options = {}) {
    const binding = this.requireBinding(agentId);
    const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.list) throw new Error(`${binding.provider} ACP Agent does not support session/list`);
    return withTimeout(binding.connection.listSessions({
      ...(options.cwd ? { cwd: path.resolve(options.cwd) } : {}),
      ...(options.cursor ? { cursor: String(options.cursor) } : {}),
    }), this.requestTimeoutMs, 'ACP session/list');
  }

  async authenticate(agentId, methodId) {
    const binding = this.requireBinding(agentId);
    const method = binding.initializeResponse?.authMethods?.find(item => item.id === methodId);
    if (!method) throw new Error('Unknown ACP authentication method');
    if (method.type === 'terminal' || method?._meta?.['terminal-auth']) {
      return this.startTerminalAuthentication(binding, method);
    }
    await withTimeout(
      binding.connection.authenticate({ methodId }),
      this.requestTimeoutMs,
      'ACP authenticate'
    );
    binding.error = '';
    binding.stopReason = '';
    binding.state = interactiveRuntimeState(binding, 'idle');
    binding.updatedAt = new Date().toISOString();
    this.emitRuntime(binding);
    this.emitSession(binding);
    return { authenticated: true, methodId };
  }

  terminalAuthenticationLaunch(binding, method) {
    const legacy = method?._meta?.['terminal-auth'];
    if (legacy && typeof legacy === 'object' && legacy.command) {
      return {
        command: String(legacy.command),
        args: Array.isArray(legacy.args) ? legacy.args.map(String) : [],
        env: legacy.env && typeof legacy.env === 'object' ? legacy.env : {},
      };
    }
    if (method.type !== 'terminal') throw new Error('ACP authentication method is not terminal based');
    return {
      command: binding.launch.command,
      args: [...binding.launch.args, ...(Array.isArray(method.args) ? method.args.map(String) : [])],
      env: method.env && typeof method.env === 'object' ? method.env : {},
    };
  }

  async startTerminalAuthentication(binding, method) {
    if (binding.authTerminal?.state === 'running') throw new Error('ACP terminal authentication is already running');
    const launch = this.terminalAuthenticationLaunch(binding, method);
    const created = await this.clientTerminals.create(binding, {
      sessionId: binding.sessionId,
      command: launch.command,
      args: launch.args,
      cwd: binding.cwd,
      env: Object.entries(launch.env).map(([name, value]) => ({ name, value: String(value) })),
      outputByteLimit: 2 * 1024 * 1024,
    });
    binding.authTerminal = {
      terminalId: created.terminalId,
      methodId: String(method.id || ''),
      name: String(method.name || 'Sign in'),
      state: 'running',
      error: '',
    };
    binding.updatedAt = new Date().toISOString();
    this.emitRuntime(binding);
    this.emitSession(binding);
    void Promise.resolve(this.clientTerminals.waitForExit(binding, {
      sessionId: binding.sessionId,
      terminalId: created.terminalId,
    })).then(async exit => {
      if (this.bindings.get(binding.agentId) !== binding) return;
      if (exit.exitCode !== 0) {
        binding.authTerminal.state = 'failed';
        binding.authTerminal.error = `Sign-in command exited ${exit.exitCode ?? exit.signal ?? ''}`.trim();
        binding.updatedAt = new Date().toISOString();
        this.emitRuntime(binding);
        this.emitSession(binding);
        return;
      }
      binding.authTerminal.state = 'completed';
      binding.updatedAt = new Date().toISOString();
      this.emitSession(binding);
      await this.restartAgentConnection(binding.agentId).catch(error => {
        const current = this.bindings.get(binding.agentId);
        if (!current) return;
        current.state = 'error';
        current.error = acpErrorMessage(error);
        current.updatedAt = new Date().toISOString();
        this.emitRuntime(current);
      });
    }).catch(error => {
      if (this.bindings.get(binding.agentId) !== binding) return;
      binding.authTerminal.state = 'failed';
      binding.authTerminal.error = acpErrorMessage(error);
      binding.updatedAt = new Date().toISOString();
      this.emitRuntime(binding);
      this.emitSession(binding);
    });
    return { authenticated: false, methodId: method.id, terminalId: created.terminalId };
  }

  async restartAgentConnection(agentId) {
    const binding = this.requireBinding(agentId);
    const revisionBase = Number(binding.sessionState?.revision || 0);
    const options = {
      ...binding.restartOptions,
      agentId: binding.agentId,
      provider: binding.provider,
      cwd: binding.cwd,
      env: binding.env,
      approvalMode: binding.approvalMode,
      ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
      ...(revisionBase > 0 ? { revisionBase } : {}),
    };
    this.unregisterAgent(agentId);
    return this.prepareAgent(options);
  }

  async forkSession(agentId, options = {}) {
    const binding = this.requireBinding(agentId);
    const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.fork) throw new Error(`${binding.provider} ACP Agent does not support session/fork`);
    return withTimeout(binding.connection.unstable_forkSession({
      sessionId: options.sessionId || binding.sessionId,
      cwd: path.resolve(options.cwd || binding.cwd),
      additionalDirectories: Array.isArray(options.additionalDirectories)
        ? options.additionalDirectories.map(directory => path.resolve(directory))
        : [],
      mcpServers: [],
    }), this.sessionSetupTimeoutMs, 'ACP session/fork');
  }

  async deleteSession(agentId, sessionId) {
    const binding = this.requireBinding(agentId);
    const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.delete) throw new Error(`${binding.provider} ACP Agent does not support session/delete`);
    await withTimeout(
      binding.connection.deleteSession({ sessionId: String(sessionId || '') }),
      this.requestTimeoutMs,
      'ACP session/delete'
    );
    return { deleted: true, sessionId: String(sessionId || '') };
  }

  async closeSession(agentId) {
    const binding = this.requireBinding(agentId);
    const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.close) throw new Error(`${binding.provider} ACP Agent does not support session/close`);
    await withTimeout(
      binding.connection.closeSession({ sessionId: binding.sessionId }),
      this.requestTimeoutMs,
      'ACP session/close'
    );
    binding.state = 'closed';
    this.emitRuntime(binding);
    return { closed: true, sessionId: binding.sessionId };
  }

  async setSessionMode(agentId, modeId) {
    const binding = this.requireBinding(agentId);
    await withTimeout(
      binding.connection.setSessionMode({ sessionId: binding.sessionId, modeId: String(modeId || '') }),
      this.requestTimeoutMs,
      'ACP session/set_mode'
    );
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
    const response = await withTimeout(
      binding.connection.setSessionConfigOption(request),
      this.requestTimeoutMs,
      'ACP session/set_config_option'
    );
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
      errorKind: binding.error ? acpErrorKind(binding.error) : '',
      stopReason: binding.stopReason,
      protocolVersion: binding.initializeResponse?.protocolVersion || null,
      agentInfo: binding.initializeResponse?.agentInfo || null,
      capabilities: binding.initializeResponse?.agentCapabilities || {},
      authMethods: binding.initializeResponse?.authMethods || [],
      modes: binding.modes,
      configOptions: binding.configOptions,
      pendingPermission: binding.pendingPermissions.values().next().value || null,
      pendingPermissions: [...binding.pendingPermissions.values()],
      pendingElicitation: binding.pendingElicitations.values().next().value || null,
      pendingElicitations: [...binding.pendingElicitations.values()],
      activeElicitations: [...binding.activeElicitations.values()],
      adapter: binding.launch,
      authTerminal: binding.authTerminal
        ? { ...binding.authTerminal, terminal: this.clientTerminals.display(binding.authTerminal.terminalId) }
        : null,
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

  getTranscriptSession(agentId, options = {}) {
    const binding = this.requireBinding(agentId);
    const slice = binding.sessionState
      ? binding.sessionState.transcriptSlice(options)
      : { entries: [], revision: 0, delta: false, hasMoreBefore: false };
    return {
      version: 2,
      protocol: 'acp',
      provider: binding.provider,
      sessionId: binding.sessionId,
      cwd: binding.cwd,
      title: binding.sessionState?.title || '',
      updatedAt: binding.updatedAt,
      truncated: binding.sessionState?.truncated === true,
      state: binding.state,
      error: binding.error,
      errorKind: binding.error ? acpErrorKind(binding.error) : '',
      stopReason: binding.stopReason,
      ...slice,
    };
  }

  getToolEntry(agentId, toolCallId) {
    const binding = this.requireBinding(agentId);
    const entry = binding.sessionState?.toolEntries.get(String(toolCallId || ''));
    if (!entry || binding.sessionState.isInternalEntry(entry)) return null;
    const visible = JSON.parse(JSON.stringify(entry));
    visible.content = (Array.isArray(visible.content) ? visible.content : []).map(block => {
      if (block?.type !== 'terminal') return block;
      const terminal = this.clientTerminals.display(block.terminalId);
      return terminal ? { ...block, terminal } : block;
    });
    return visible;
  }

  getPatchDecision(agentId, toolCallId, requestedPath) {
    const binding = this.requireBinding(agentId);
    return binding.patchDecisions.get(`${String(toolCallId || '')}\n${String(requestedPath || '')}`) || '';
  }

  async decidePatch(agentId, toolCallId, requestedPath, decision) {
    const binding = this.requireBinding(agentId);
    if (binding.promptActive) throw new Error('Wait for the Agent to finish before deciding a patch');
    const entry = binding.sessionState?.toolEntries.get(String(toolCallId || ''));
    if (entry && binding.sessionState.isInternalEntry(entry)) throw new Error('ACP tool call not found');
    if (!entry) throw new Error('ACP tool call not found');
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!['keep', 'revert'].includes(normalizedDecision)) throw new Error('ACP patch decision is invalid');
    const key = `${String(toolCallId || '')}\n${String(requestedPath || '')}`;
    if (binding.patchDecisions.has(key)) throw new Error('ACP patch file already has a decision');
    let result = { action: 'kept', path: String(requestedPath || '') };
    if (normalizedDecision === 'revert') {
      result = await rejectPatch({ entry, root: binding.cwd, requestedPath });
    }
    binding.patchDecisions.set(key, result.action);
    entry._meta = { ...(entry._meta || {}) };
    entry._meta.farming_patch_decisions = {
      ...(entry._meta.farming_patch_decisions || {}),
      [String(requestedPath || '')]: result.action,
    };
    binding.sessionState?.touchEntry(entry);
    binding.updatedAt = new Date().toISOString();
    this.emitSession(binding);
    return { ...result, toolCallId: String(toolCallId || '') };
  }

  killTerminal(agentId, terminalId) {
    const binding = this.requireBinding(agentId);
    this.clientTerminals.kill(binding, {
      sessionId: binding.sessionId,
      terminalId: String(terminalId || ''),
    });
    return { killed: true, terminalId: String(terminalId || '') };
  }

  inputTerminal(agentId, terminalId, input) {
    const binding = this.requireBinding(agentId);
    return this.clientTerminals.input(binding, {
      sessionId: binding.sessionId,
      terminalId,
      input,
    });
  }

  resizeTerminal(agentId, terminalId, cols, rows) {
    const binding = this.requireBinding(agentId);
    return this.clientTerminals.resize(binding, {
      sessionId: binding.sessionId,
      terminalId,
      cols,
      rows,
    });
  }

  getSubagentTranscriptSession(agentId, sessionId, options = {}) {
    const binding = this.requireBinding(agentId);
    const id = String(sessionId || '');
    const state = binding.subagentStates.get(id);
    if (!state) return null;
    const parentTool = binding.sessionState?.entries.find(entry => (
      entry?.type === 'tool'
      && String(entry?._meta?.subagent_session_info?.session_id || '') === id
    ));
    const status = String(parentTool?.status || '').toLowerCase();
    const pendingPermission = [...binding.pendingPermissions.values()]
      .some(request => String(request?.sessionId || '') === id);
    const pendingElicitation = [...binding.pendingElicitations.values()]
      .some(request => String(request?.sessionId || '') === id);
    const active = ['pending', 'in_progress', 'in-progress', 'running'].includes(status);
    const failed = ['failed', 'error'].includes(status);
    const stateName = pendingPermission
      ? 'waiting-for-permission'
      : pendingElicitation
        ? 'waiting-for-input'
        : active
          ? 'working'
          : failed
            ? 'error'
            : 'idle';
    return {
      version: 2,
      protocol: 'acp',
      provider: binding.provider,
      sessionId: id,
      cwd: binding.cwd,
      title: state.title || '',
      updatedAt: binding.updatedAt,
      truncated: state.truncated === true,
      state: stateName,
      error: failed ? String(parentTool?.title || 'Subagent failed') : '',
      errorKind: failed ? 'agent' : '',
      stopReason: failed ? 'error' : active ? '' : 'end_turn',
      ...state.transcriptSlice(options),
    };
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
      errorKind: binding.error ? acpErrorKind(binding.error) : '',
      stopReason: binding.stopReason,
      pendingPermission: binding.pendingPermissions.values().next().value || null,
      pendingPermissions: [...binding.pendingPermissions.values()],
      pendingElicitation: binding.pendingElicitations.values().next().value || null,
      pendingElicitations: [...binding.pendingElicitations.values()],
      activeElicitations: [...binding.activeElicitations.values()],
      updatedAt: binding.updatedAt,
    });
  }

  emitSession(binding) {
    this.emit('session', {
      agentId: binding.agentId,
      updatedAt: binding.updatedAt,
      revision: binding.sessionState?.revision || 0,
    });
  }

  handleExit(binding, error) {
    if (this.bindings.get(binding.agentId) !== binding) return;
    if (error) {
      binding.state = 'error';
      binding.error = acpErrorMessage(error);
    } else if (binding.state !== 'error') {
      binding.state = 'stopped';
    }
    for (const resolve of binding.permissionResolvers.values()) {
      resolve({ outcome: { outcome: 'cancelled' } });
    }
    for (const resolve of binding.elicitationResolvers.values()) resolve({ action: 'cancel' });
    binding.permissionResolvers.clear();
    binding.pendingPermissions.clear();
    binding.elicitationResolvers.clear();
    binding.pendingElicitations.clear();
    binding.activeElicitations.clear();
    binding.interactionOrigins.clear();
    binding.subagentStates.clear();
    this.clientTerminals.cleanupAgent(binding.agentId);
    this.emitRuntime(binding);
  }

  unregisterAgent(agentId) {
    const binding = this.bindings.get(agentId);
    if (!binding) return;
    this.bindings.delete(agentId);
    for (const resolve of binding.permissionResolvers.values()) resolve({ outcome: { outcome: 'cancelled' } });
    for (const resolve of binding.elicitationResolvers.values()) resolve({ action: 'cancel' });
    binding.permissionResolvers.clear();
    binding.pendingPermissions.clear();
    binding.elicitationResolvers.clear();
    binding.pendingElicitations.clear();
    binding.activeElicitations.clear();
    binding.interactionOrigins.clear();
    binding.subagentStates.clear();
    this.clientTerminals.cleanupAgent(binding.agentId);
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
  acpErrorKind,
  autoPermissionResponse,
  codexAcpEnvironment,
  resolveAcpLaunch,
};
