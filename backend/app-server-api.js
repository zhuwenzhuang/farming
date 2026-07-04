const express = require('express');
const crypto = require('crypto');
const path = require('path');
const WebSocket = require('ws');
const packageJson = require('../package.json');

const DEFAULT_PROVIDER = 'codex';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const EVENT_BUFFER_LIMIT = 500;

const CODEX_APP_SERVER_CLIENT_METHODS = Object.freeze([
  'thread/start',
  'thread/resume',
  'thread/fork',
  'thread/archive',
  'thread/delete',
  'thread/unsubscribe',
  'thread/increment_elicitation',
  'thread/decrement_elicitation',
  'thread/name/set',
  'thread/goal/set',
  'thread/goal/get',
  'thread/goal/clear',
  'thread/metadata/update',
  'thread/settings/update',
  'thread/memoryMode/set',
  'memory/reset',
  'thread/unarchive',
  'thread/compact/start',
  'thread/shellCommand',
  'thread/approveGuardianDeniedAction',
  'thread/backgroundTerminals/clean',
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/terminate',
  'thread/rollback',
  'thread/list',
  'thread/search',
  'thread/loaded/list',
  'thread/read',
  'thread/turns/list',
  'thread/items/list',
  'thread/inject_items',
  'skills/list',
  'skills/extraRoots/set',
  'hooks/list',
  'marketplace/add',
  'marketplace/remove',
  'marketplace/upgrade',
  'plugin/list',
  'plugin/installed',
  'plugin/read',
  'plugin/skill/read',
  'plugin/share/save',
  'plugin/share/updateTargets',
  'plugin/share/list',
  'plugin/share/checkout',
  'plugin/share/delete',
  'app/list',
  'fs/readFile',
  'fs/writeFile',
  'fs/createDirectory',
  'fs/getMetadata',
  'fs/readDirectory',
  'fs/remove',
  'fs/copy',
  'fs/watch',
  'fs/unwatch',
  'skills/config/write',
  'plugin/install',
  'plugin/uninstall',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/realtime/start',
  'thread/realtime/appendAudio',
  'thread/realtime/appendText',
  'thread/realtime/appendSpeech',
  'thread/realtime/stop',
  'thread/realtime/listVoices',
  'review/start',
  'model/list',
  'modelProvider/capabilities/read',
  'experimentalFeature/list',
  'permissionProfile/list',
  'experimentalFeature/enablement/set',
  'remoteControl/enable',
  'remoteControl/disable',
  'remoteControl/status/read',
  'remoteControl/pairing/start',
  'remoteControl/pairing/status',
  'remoteControl/client/list',
  'remoteControl/client/revoke',
  'collaborationMode/list',
  'environment/add',
  'environment/info',
  'mcpServer/oauth/login',
  'config/mcpServer/reload',
  'mcpServerStatus/list',
  'mcpServer/resource/read',
  'mcpServer/tool/call',
  'windowsSandbox/setupStart',
  'windowsSandbox/readiness',
  'account/login/start',
  'account/login/cancel',
  'account/logout',
  'account/rateLimits/read',
  'account/rateLimitResetCredit/consume',
  'account/usage/read',
  'account/workspaceMessages/read',
  'account/sendAddCreditsNudgeEmail',
  'feedback/upload',
  'command/exec',
  'command/exec/write',
  'command/exec/terminate',
  'command/exec/resize',
  'process/spawn',
  'process/writeStdin',
  'process/kill',
  'process/resizePty',
  'config/read',
  'externalAgentConfig/detect',
  'externalAgentConfig/import',
  'externalAgentConfig/import/readHistories',
  'config/value/write',
  'config/batchWrite',
  'configRequirements/read',
  'account/read',
  'getConversationSummary',
  'gitDiffToRemote',
  'getAuthStatus',
  'fuzzyFileSearch',
  'fuzzyFileSearch/sessionStart',
  'fuzzyFileSearch/sessionUpdate',
  'fuzzyFileSearch/sessionStop',
]);

const CODEX_APP_SERVER_SERVER_REQUEST_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval',
]);

const CODEX_APP_SERVER_NOTIFICATION_METHODS = Object.freeze([
  'error',
  'thread/started',
  'thread/status/changed',
  'thread/archived',
  'thread/deleted',
  'thread/unarchived',
  'thread/closed',
  'skills/changed',
  'thread/name/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/settings/updated',
  'thread/tokenUsage/updated',
  'turn/started',
  'hook/started',
  'turn/completed',
  'hook/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/started',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'item/completed',
  'rawResponseItem/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'serverRequest/resolved',
  'item/mcpToolCall/progress',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'account/updated',
  'account/rateLimits/updated',
  'app/list/updated',
  'remoteControl/status/changed',
  'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed',
  'fs/changed',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'thread/compacted',
  'model/rerouted',
  'model/verification',
  'turn/moderationMetadata',
  'model/safetyBuffering/updated',
  'warning',
  'guardianWarning',
  'deprecationNotice',
  'configWarning',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
  'account/login/completed',
]);

const CODEX_APP_SERVER_METHOD_SET = new Set(CODEX_APP_SERVER_CLIENT_METHODS);

class AppServerApiError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clampTimeoutMs(value, fallback = DEFAULT_REQUEST_TIMEOUT_MS) {
  const timeoutMs = Math.floor(Number(value));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fallback;
  return Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS);
}

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase() === DEFAULT_PROVIDER ? DEFAULT_PROVIDER : '';
}

function normalizeEndpoint(endpoint, fallbackEndpoint = '') {
  const value = String(endpoint || fallbackEndpoint || '').trim();
  if (!value) {
    throw new AppServerApiError(
      400,
      'Codex app-server endpoint is required. Start Codex with `codex app-server --listen ws://127.0.0.1:4500` or set FARMING_CODEX_APP_SERVER_ENDPOINT.'
    );
  }
  if (/^wss?:\/\//i.test(value)) return value;
  if (/^unix:\/\//i.test(value)) {
    const socketPath = value.slice('unix://'.length);
    if (!socketPath || !path.isAbsolute(socketPath)) {
      throw new AppServerApiError(400, 'Explicit Unix socket endpoints must look like unix:///absolute/path.sock');
    }
    return value;
  }
  throw new AppServerApiError(400, 'Codex app-server endpoint must be ws://, wss://, or unix:///absolute/path.sock');
}

function bearerTokenFromRequest(req, body = {}) {
  if (body && typeof body.authToken === 'string' && body.authToken.trim()) {
    return body.authToken.trim();
  }

  const appServerToken = req.get('x-app-server-auth-token');
  if (appServerToken && appServerToken.trim()) return appServerToken.trim();

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function tokenFingerprint(token) {
  if (!token) return 'none';
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function requestIdKey(id) {
  return typeof id === 'string' ? id : JSON.stringify(id);
}

function safeJsonForSse(value) {
  return JSON.stringify(value).replace(/\u2028|\u2029/g, '');
}

function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${safeJsonForSse(payload)}\n\n`);
}

function isJsonRpcResponse(message) {
  return message && Object.prototype.hasOwnProperty.call(message, 'id') &&
    (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
}

function isJsonRpcServerRequest(message) {
  return message && Object.prototype.hasOwnProperty.call(message, 'id') &&
    typeof message.method === 'string' &&
    !Object.prototype.hasOwnProperty.call(message, 'result') &&
    !Object.prototype.hasOwnProperty.call(message, 'error');
}

function isJsonRpcNotification(message) {
  return message && !Object.prototype.hasOwnProperty.call(message, 'id') &&
    typeof message.method === 'string';
}

class AppServerConnection {
  constructor(options) {
    this.provider = options.provider;
    this.endpoint = options.endpoint;
    this.authToken = options.authToken || '';
    this.experimentalApi = options.experimentalApi !== false;
    this.clientInfo = options.clientInfo;
    this.initializeTimeoutMs = options.initializeTimeoutMs || DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.requestCounter = 1;
    this.eventCounter = 1;
    this.pendingRequests = new Map();
    this.pendingServerRequests = new Map();
    this.eventSubscribers = new Set();
    this.recentEvents = [];
    this.ws = null;
    this.connectPromise = null;
    this.connectedAt = null;
    this.closedAt = null;
    this.lastError = null;
    this.serverInfo = null;
  }

  status() {
    return {
      provider: this.provider,
      endpoint: this.endpoint,
      connected: this.ws && this.ws.readyState === WebSocket.OPEN,
      connecting: !!this.connectPromise && !(this.ws && this.ws.readyState === WebSocket.OPEN),
      connectedAt: this.connectedAt,
      closedAt: this.closedAt,
      lastError: this.lastError,
      serverInfo: this.serverInfo,
      pendingRequestCount: this.pendingRequests.size,
      pendingServerRequestIds: Array.from(this.pendingServerRequests.keys()),
      recentEventCount: this.recentEvents.length,
    };
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.open().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async open() {
    const ws = await this.openWebSocket();
    this.ws = ws;
    this.closedAt = null;
    this.lastError = null;
    this.attachWebSocketHandlers(ws);

    const initializeResult = await this.sendRequest('initialize', {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: this.experimentalApi,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    }, {
      id: 'initialize',
      timeoutMs: this.initializeTimeoutMs,
      allowInitialize: true,
    });
    if (initializeResult.error) {
      throw new AppServerApiError(502, `Codex app-server initialize failed: ${initializeResult.error.message || 'unknown error'}`, initializeResult.error);
    }

    this.serverInfo = initializeResult.result || null;
    this.connectedAt = nowIso();
    this.sendRaw({ method: 'initialized' });
    this.emitEvent('transport', {
      state: 'connected',
      serverInfo: this.serverInfo,
    });
    return this;
  }

  openWebSocket() {
    const headers = this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
    const endpoint = this.endpoint;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new AppServerApiError(504, `Timed out connecting to Codex app-server at ${endpoint}`));
      }, this.initializeTimeoutMs);
      if (typeof timeout.unref === 'function') timeout.unref();

      const handleOpen = (ws) => {
        clearTimeout(timeout);
        resolve(ws);
      };
      const handleError = (error) => {
        clearTimeout(timeout);
        reject(new AppServerApiError(502, `Failed to connect to Codex app-server: ${error.message || error}`));
      };

      let ws;
      if (endpoint.startsWith('unix://')) {
        ws = new WebSocket('ws://localhost/', {
          headers,
          socketPath: endpoint.slice('unix://'.length),
        });
      } else {
        ws = new WebSocket(endpoint, { headers });
      }
      ws.once('open', () => handleOpen(ws));
      ws.once('error', handleError);
    });
  }

  attachWebSocketHandlers(ws) {
    ws.on('message', (data) => {
      this.handleMessage(data);
    });
    ws.on('error', (error) => {
      this.lastError = error.message || String(error);
      this.emitEvent('transport', {
        state: 'error',
        error: this.lastError,
      });
    });
    ws.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer ? reasonBuffer.toString() : '';
      this.closedAt = nowIso();
      this.emitEvent('transport', {
        state: 'closed',
        code,
        reason,
      });
      this.rejectPendingRequests({
        code: -32000,
        message: reason || 'Codex app-server connection closed',
      });
    });
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      this.emitEvent('parse-error', {
        error: error.message || 'Failed to parse Codex app-server message',
      });
      return;
    }

    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (isJsonRpcServerRequest(message)) {
      const key = requestIdKey(message.id);
      this.pendingServerRequests.set(key, {
        id: message.id,
        method: message.method,
        params: message.params,
        receivedAt: nowIso(),
      });
      this.emitEvent('server-request', message);
      return;
    }

    if (isJsonRpcNotification(message)) {
      this.emitEvent('notification', message);
      return;
    }

    this.emitEvent('unknown-message', { message });
  }

  handleResponse(message) {
    const key = requestIdKey(message.id);
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      this.emitEvent('response', message);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(key);
    pending.resolve(message);
  }

  rejectPendingRequests(error) {
    this.pendingRequests.forEach((pending, key) => {
      clearTimeout(pending.timeout);
      pending.resolve({
        id: pending.id,
        error,
      });
      this.pendingRequests.delete(key);
    });
  }

  sendRaw(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new AppServerApiError(502, 'Codex app-server connection is not open');
    }
    this.ws.send(JSON.stringify(message));
  }

  sendRequest(method, params, options = {}) {
    if (!options.allowInitialize && !CODEX_APP_SERVER_METHOD_SET.has(method)) {
      throw new AppServerApiError(400, `Unsupported Codex app-server method: ${method}`);
    }

    const id = options.id || `farming-${this.requestCounter++}`;
    const message = { id, method };
    if (params !== undefined) message.params = params;
    const timeoutMs = clampTimeoutMs(options.timeoutMs);

    return new Promise((resolve, reject) => {
      let timeout = null;
      try {
        timeout = setTimeout(() => {
          this.pendingRequests.delete(requestIdKey(id));
          resolve({
            id,
            error: {
              code: -32002,
              message: `Timed out waiting for ${method} response`,
            },
          });
        }, timeoutMs);
        if (typeof timeout.unref === 'function') timeout.unref();
        this.pendingRequests.set(requestIdKey(id), { id, method, resolve, timeout });
        this.sendRaw(message);
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.pendingRequests.delete(requestIdKey(id));
        reject(error);
      }
    });
  }

  async request(method, params, options = {}) {
    await this.connect();
    return this.sendRequest(method, params, options);
  }

  resolveServerRequest(rawRequestId, result) {
    const key = String(rawRequestId || '');
    const request = this.pendingServerRequests.get(key);
    if (!request) {
      throw new AppServerApiError(404, 'Codex app-server server request not found');
    }
    this.sendRaw({ id: request.id, result: result === undefined ? null : result });
    this.pendingServerRequests.delete(key);
    return { id: request.id, resolved: true };
  }

  rejectServerRequest(rawRequestId, error) {
    const key = String(rawRequestId || '');
    const request = this.pendingServerRequests.get(key);
    if (!request) {
      throw new AppServerApiError(404, 'Codex app-server server request not found');
    }
    this.sendRaw({
      id: request.id,
      error: {
        code: Number.isFinite(Number(error && error.code)) ? Number(error.code) : -32000,
        message: String(error && error.message ? error.message : 'Rejected by Farming app-server API'),
        ...(error && error.data !== undefined ? { data: error.data } : {}),
      },
    });
    this.pendingServerRequests.delete(key);
    return { id: request.id, rejected: true };
  }

  subscribe(handler, options = {}) {
    if (options.replay !== false) {
      this.recentEvents.forEach(handler);
    }
    this.eventSubscribers.add(handler);
    return () => {
      this.eventSubscribers.delete(handler);
    };
  }

  emitEvent(kind, payload) {
    const event = {
      id: this.eventCounter++,
      at: nowIso(),
      provider: this.provider,
      endpoint: this.endpoint,
      kind,
      payload,
    };
    this.recentEvents.push(event);
    if (this.recentEvents.length > EVENT_BUFFER_LIMIT) {
      this.recentEvents.splice(0, this.recentEvents.length - EVENT_BUFFER_LIMIT);
    }
    this.eventSubscribers.forEach((handler) => {
      try {
        handler(event);
      } catch {
        // Event subscribers are HTTP response writers; a failed subscriber should
        // not break the app-server transport connection.
      }
    });
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.rejectPendingRequests({
      code: -32000,
      message: 'Codex app-server connection closed by Farming',
    });
  }
}

class AppServerApiBridge {
  constructor(options = {}) {
    this.defaultCodexEndpoint = options.defaultCodexEndpoint || process.env.FARMING_CODEX_APP_SERVER_ENDPOINT || '';
    this.clientInfo = {
      name: 'farming',
      title: 'Farming app-server API',
      version: packageJson.version || '0.0.0',
    };
    this.connections = new Map();
  }

  metadata() {
    return {
      providers: [DEFAULT_PROVIDER],
      codex: {
        transportManagedMethods: ['initialize', 'initialized'],
        clientMethods: CODEX_APP_SERVER_CLIENT_METHODS,
        serverRequestMethods: CODEX_APP_SERVER_SERVER_REQUEST_METHODS,
        notificationMethods: CODEX_APP_SERVER_NOTIFICATION_METHODS,
        defaultEndpointConfigured: !!this.defaultCodexEndpoint,
      },
    };
  }

  connectionKey(provider, endpoint, authToken) {
    return `${provider}\0${endpoint}\0${tokenFingerprint(authToken)}`;
  }

  getConnection(provider, options = {}) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider) {
      throw new AppServerApiError(404, 'Only the codex app-server provider is supported');
    }
    const endpoint = normalizeEndpoint(options.endpoint, this.defaultCodexEndpoint);
    const authToken = options.authToken || '';
    const key = this.connectionKey(normalizedProvider, endpoint, authToken);
    let connection = this.connections.get(key);
    if (!connection) {
      connection = new AppServerConnection({
        provider: normalizedProvider,
        endpoint,
        authToken,
        experimentalApi: options.experimentalApi,
        clientInfo: this.clientInfo,
      });
      this.connections.set(key, connection);
    }
    return connection;
  }

  getStatus(provider, options = {}) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider) {
      throw new AppServerApiError(404, 'Only the codex app-server provider is supported');
    }
    const endpoint = normalizeEndpoint(options.endpoint, this.defaultCodexEndpoint);
    const authToken = options.authToken || '';
    const connection = this.connections.get(this.connectionKey(normalizedProvider, endpoint, authToken));
    return connection
      ? connection.status()
      : {
        provider: normalizedProvider,
        endpoint,
        connected: false,
        connecting: false,
        connectedAt: null,
        closedAt: null,
        lastError: null,
        serverInfo: null,
        pendingRequestCount: 0,
        pendingServerRequestIds: [],
        recentEventCount: 0,
      };
  }

  async connect(provider, options = {}) {
    const connection = this.getConnection(provider, options);
    await connection.connect();
    return connection.status();
  }

  async request(provider, method, params, options = {}) {
    const connection = this.getConnection(provider, options);
    return connection.request(method, params, {
      timeoutMs: options.timeoutMs,
    });
  }

  resolveServerRequest(provider, requestId, result, options = {}) {
    const connection = this.getConnection(provider, options);
    return connection.resolveServerRequest(requestId, result);
  }

  rejectServerRequest(provider, requestId, error, options = {}) {
    const connection = this.getConnection(provider, options);
    return connection.rejectServerRequest(requestId, error);
  }

  disconnect(provider, options = {}) {
    const connection = this.getConnection(provider, options);
    connection.close();
    return connection.status();
  }
}

function sendError(res, error) {
  if (error instanceof AppServerApiError) {
    res.status(error.status).json({
      error: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
    return;
  }
  res.status(500).json({ error: error.message || 'Farming app-server API failed' });
}

function requestOptions(req, body = {}) {
  return {
    endpoint: body.endpoint || req.query.endpoint,
    authToken: bearerTokenFromRequest(req, body),
    experimentalApi: body.experimentalApi !== false,
    timeoutMs: body.timeoutMs,
  };
}

function createAppServerApiRouter(options = {}) {
  const bridge = options.bridge || new AppServerApiBridge(options);
  const router = express.Router();

  router.use(express.json({ limit: '2mb' }));

  router.get('/', (_req, res) => {
    res.json(bridge.metadata());
  });

  router.get('/:provider', (req, res) => {
    try {
      const provider = normalizeProvider(req.params.provider);
      if (!provider) throw new AppServerApiError(404, 'Only the codex app-server provider is supported');
      const options = requestOptions(req);
      const hasEndpoint = !!(options.endpoint || bridge.defaultCodexEndpoint);
      res.json({
        ...bridge.metadata()[provider],
        status: hasEndpoint
          ? bridge.getStatus(provider, options)
          : {
            provider,
            endpoint: null,
            connected: false,
            connecting: false,
            endpointRequired: true,
          },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:provider/connect', async (req, res) => {
    try {
      const status = await bridge.connect(req.params.provider, requestOptions(req, req.body || {}));
      res.json({ status });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:provider/disconnect', (req, res) => {
    try {
      const status = bridge.disconnect(req.params.provider, requestOptions(req, req.body || {}));
      res.json({ status });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:provider/rpc', async (req, res) => {
    const body = req.body || {};
    try {
      const method = String(body.method || '').trim();
      if (!method) throw new AppServerApiError(400, 'method is required');
      const response = await bridge.request(req.params.provider, method, body.params, requestOptions(req, body));
      res.json(response);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:provider/server-requests/:requestId/resolve', (req, res) => {
    try {
      const body = req.body || {};
      const response = bridge.resolveServerRequest(
        req.params.provider,
        req.params.requestId,
        Object.prototype.hasOwnProperty.call(body, 'result') ? body.result : null,
        requestOptions(req, body)
      );
      res.json(response);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:provider/server-requests/:requestId/reject', (req, res) => {
    try {
      const body = req.body || {};
      const response = bridge.rejectServerRequest(
        req.params.provider,
        req.params.requestId,
        body.error || {},
        requestOptions(req, body)
      );
      res.json(response);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:provider/events', async (req, res) => {
    let heartbeat = null;
    let unsubscribe = null;

    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sendSseEvent(res, 'ready', {
        provider: req.params.provider,
        at: nowIso(),
      });

      const connection = bridge.getConnection(req.params.provider, requestOptions(req));
      unsubscribe = connection.subscribe((event) => {
        sendSseEvent(res, event.kind, event);
      }, {
        replay: req.query.replay !== '0',
      });
      await connection.connect();
      heartbeat = setInterval(() => {
        sendSseEvent(res, 'heartbeat', { at: nowIso() });
      }, 25_000);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
    } catch (error) {
      sendSseEvent(res, 'error', {
        at: nowIso(),
        error: error.message || 'Farming app-server API event stream failed',
      });
      res.end();
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      return;
    }

    req.on('close', () => {
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    });
  });

  return router;
}

module.exports = {
  AppServerApiBridge,
  AppServerApiError,
  CODEX_APP_SERVER_CLIENT_METHODS,
  CODEX_APP_SERVER_NOTIFICATION_METHODS,
  CODEX_APP_SERVER_SERVER_REQUEST_METHODS,
  createAppServerApiRouter,
  normalizeEndpoint,
};
