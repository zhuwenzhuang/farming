#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const TerminalScreenWorkerPool = require('./terminal-screen-worker-pool');
const { nativePtyHostSocketPath } = require('./native-pty-host-path');
const { terminalInputToPtyString } = require('./input-parts');
const { normalizeInteractiveTerminalEnv } = require('./agent-env');
const {
  cleanupShellBusyIntegration,
  parseShellBusyMarkers,
} = require('./shell-busy-integration');
const {
  extractLatestTerminalTitle,
  normalizeShellSessionOptions,
  createPtyProcess,
} = require('./local-session-engine');
const { deriveTerminalStatus } = require('./terminal-status');
const { probeUnixSocket } = require('./terminal-runtime-cleanup');
const { nativePtyHostRuntimeIdentity } = require('./native-pty-host-identity');
const {
  allocateNativePtyRuntimeGeneration,
  formatNativePtyRuntimeEpoch,
} = require('./native-pty-controller-generation');
const {
  beginTerminalGeometryResize,
  claimTerminalGeometry,
  commitTerminalGeometryResize,
  createTerminalGeometryControl,
  expireTerminalGeometryIfNeeded,
  invalidateTerminalGeometry,
  rejectTerminalGeometryResize,
  releaseTerminalGeometry,
  renewTerminalGeometry,
  validateTerminalGeometryClear,
  validateTerminalGeometryInput,
  validateTerminalGeometryOutputAck,
  validateTerminalGeometryRendererReady,
} = require('./terminal-geometry-control');
const {
  acknowledgeTerminalReducerData,
  acknowledgeTerminalRendererData,
  createTerminalReducerFlowControl,
  ensureTerminalReducerFlowControl,
  enqueueTerminalReducerData,
  enqueueTerminalRendererData,
  resetTerminalReducerFlowControl,
  resetTerminalRendererFlowControl,
  setTerminalExternalFlowControlBlocked,
} = require('./terminal-reducer-flow-control');
const {
  normalizeTerminalStateEntry,
  serializeTerminalState,
} = require('./terminal-state-serialization');
const {
  captureTerminalAttachCheckpoint,
} = require('./terminal-attach-checkpoint');

const OUTPUT_LIMIT = 10000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 30;
const OWNER_CHECK_INTERVAL_MS = 1000;
const DISPOSE_PTY_GRACE_MS = 800;
const DEFAULT_IDLE_EXIT_MS = 60000;
const DEFAULT_CLIENT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const DEFAULT_CLIENT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const HOST_RUNTIME_IDENTITY = nativePtyHostRuntimeIdentity();
const TERMINAL_HISTORY_RESTORED_MESSAGE = '\r\n\x1b[7m History restored \x1b[0m\r\n';

function trimOutput(output) {
  const text = typeof output === 'string' ? output : '';
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

function normalizePositiveInteger(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sanitizeAgentEnv(env) {
  const next = { ...(env || process.env) };
  return normalizeInteractiveTerminalEnv(next, {
    stripRuntimeShims: false,
    stripNodeOptions: false,
  });
}

class NativePtyHost {
  constructor(options = {}) {
    this.configDir = options.configDir || process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');
    this.socketPath = options.socketPath || process.env.FARMING_NATIVE_PTY_HOST_SOCKET || nativePtyHostSocketPath(this.configDir);
    this.ownerPid = Number(options.ownerPid || process.env.FARMING_NATIVE_PTY_HOST_OWNER_PID || 0);
    this.runtimeIdentity = options.runtimeIdentity || HOST_RUNTIME_IDENTITY;
    this.exitOnShutdown = options.exitOnShutdown !== false;
    this.sessions = new Map();
    this.clients = new Set();
    this.ownerCheckTimer = null;
    this.idleExitTimer = null;
    this.hasAcceptedClient = false;
    this.activeControllerClient = null;
    this.activeControllerIdentity = null;
    this.sessionMutationQueues = new Map();
    this.activeControllerMutations = new Set();
    this.rotationPreparation = null;
    this.clientMaxBufferedBytes = normalizePositiveInteger(
      options.clientMaxBufferedBytes,
      DEFAULT_CLIENT_MAX_BUFFERED_BYTES,
      1024,
      256 * 1024 * 1024,
    );
    this.clientMaxRequestBytes = normalizePositiveInteger(
      options.clientMaxRequestBytes,
      DEFAULT_CLIENT_MAX_REQUEST_BYTES,
      1024,
      256 * 1024 * 1024,
    );
    this.idleExitMs = normalizePositiveInteger(
      options.idleExitMs ?? process.env.FARMING_NATIVE_PTY_HOST_IDLE_EXIT_MS,
      DEFAULT_IDLE_EXIT_MS,
      0,
      3600000
    );
    this.disposed = false;
    this.screenWorkerPool = new TerminalScreenWorkerPool({
      size: normalizePositiveInteger(process.env.FARMING_NATIVE_PTY_SCREEN_WORKERS, 3, 0, 12),
      workerOptions: {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        previewSnapshot: true,
      },
    });
  }

  async start() {
    await this.prepareSocket();
    this.server = net.createServer(socket => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') {
      fs.chmodSync(this.socketPath, 0o600);
    }
    console.error(`[${new Date().toISOString()}] Native PTY host listening on ${this.socketPath} ownerPid=${this.ownerPid || ''}`);
    this.startOwnerWatch();
  }

  startOwnerWatch() {
    if (!this.ownerPid || this.ownerPid === process.pid || this.ownerCheckTimer) return;
    this.ownerCheckTimer = setInterval(() => {
      try {
        process.kill(this.ownerPid, 0);
      } catch {
        this.dispose().finally(() => process.exit(0));
      }
    }, OWNER_CHECK_INTERVAL_MS);
    if (typeof this.ownerCheckTimer.unref === 'function') {
      this.ownerCheckTimer.unref();
    }
  }

  async prepareSocket() {
    if (process.platform === 'win32') return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    if (fs.existsSync(this.socketPath)) {
      const probe = await probeUnixSocket(this.socketPath);
      if (probe.active) {
        const error = new Error(`Native PTY host socket is already active: ${this.socketPath}`);
        error.code = 'EADDRINUSE';
        error.socketPath = this.socketPath;
        throw error;
      }
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  handleConnection(socket) {
    const client = { socket, buffer: '' };
    this.hasAcceptedClient = true;
    this.cancelIdleExit();
    this.clients.add(client);
    socket.on('data', chunk => this.handleClientData(client, chunk));
    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));
  }

  removeClient(client) {
    this.clients.delete(client);
    if (this.activeControllerClient === client) {
      this.activeControllerClient = null;
      for (const session of this.sessions.values()) {
        invalidateTerminalGeometry(session, 'controller-disconnected');
        const flowControl = ensureTerminalReducerFlowControl(session);
        const resetError = resetTerminalRendererFlowControl(flowControl, session.process);
        const unblockError = setTerminalExternalFlowControlBlocked(flowControl, session.process, false);
        const flowError = resetError || unblockError;
        if (flowError) this.failSessionScreenState(session, flowError);
      }
    }
    this.scheduleIdleExitIfUnused();
  }

  hasLiveSessions() {
    for (const session of this.sessions.values()) {
      if (session && session.status !== 'exited') return true;
    }
    return false;
  }

  cancelIdleExit() {
    if (!this.idleExitTimer) return;
    clearTimeout(this.idleExitTimer);
    this.idleExitTimer = null;
  }

  scheduleIdleExitIfUnused() {
    if (
      this.disposed ||
      this.ownerPid ||
      this.idleExitMs <= 0 ||
      !this.hasAcceptedClient ||
      this.clients.size > 0 ||
      this.hasLiveSessions() ||
      this.idleExitTimer
    ) {
      return;
    }

    this.idleExitTimer = setTimeout(() => {
      this.idleExitTimer = null;
      if (
        this.disposed ||
        this.ownerPid ||
        this.clients.size > 0 ||
        this.hasLiveSessions()
      ) {
        return;
      }
      this.dispose().finally(() => process.exit(0));
    }, this.idleExitMs);
    if (typeof this.idleExitTimer.unref === 'function') {
      this.idleExitTimer.unref();
    }
  }

  handleClientData(client, chunk) {
    client.buffer += chunk.toString('utf8');
    let newline = client.buffer.indexOf('\n');
    while (newline >= 0) {
      if (newline > this.clientMaxRequestBytes) {
        this.disconnectSlowClient(client, 'native pty request exceeded limit');
        return;
      }
      const line = client.buffer.slice(0, newline);
      client.buffer = client.buffer.slice(newline + 1);
      if (line.trim()) {
        this.handleClientMessage(client, line);
      }
      newline = client.buffer.indexOf('\n');
    }
    if (client.buffer.length > this.clientMaxRequestBytes) {
      this.disconnectSlowClient(client, 'native pty request exceeded limit');
    }
  }

  async handleClientMessage(client, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const id = message && message.id;
    if (!id) return;

    try {
      const result = await this.dispatch(message.method, message.params || {}, client);
      this.send(client, { id, ok: true, result });
    } catch (error) {
      this.send(client, {
        id,
        ok: false,
        error: error && error.message ? error.message : 'Native pty host request failed',
      });
    }
  }

  dispatch(method, params, client) {
    switch (method) {
      case 'ping':
        return {
          ok: true,
          pid: process.pid,
          runtimeIdentity: this.runtimeIdentity,
        };
      case 'registerController':
        return this.registerController(client, params.identity || {});
      case 'createSession':
        return this.enqueueControllerMutation(
          params.options?.agentId,
          client,
          () => this.createSession(params.options || {}),
        );
      case 'sendInput':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.sendInput(params.sessionId, params.input, params.terminalControl || null),
        );
      case 'resizeSession':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.resizeSession(params.sessionId, params.cols, params.rows, params.geometry || {}, client),
        );
      case 'claimSessionGeometry':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.claimSessionGeometry(params.sessionId, params.geometry || {}, client),
        );
      case 'activateSessionRenderer':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.activateSessionRenderer(params.sessionId, params.geometry || {}, client),
        );
      case 'renewSessionGeometry':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.renewSessionGeometry(params.sessionId, params.geometry || {}, client),
        );
      case 'releaseSessionGeometry':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.releaseSessionGeometry(params.sessionId, params.geometry || {}, client),
        );
      case 'acknowledgeSessionOutput':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.acknowledgeSessionOutput(
            params.sessionId,
            params.charCount,
            params.geometry || {},
            client,
          ),
        );
      case 'clearBuffer':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.clearBuffer(params.sessionId, params.geometry || null),
        );
      case 'killSession':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.killSession(params.sessionId),
        );
      case 'getSessionState':
        return this.getSessionState(params.sessionId);
      case 'getSessionAttachCheckpoint':
        return this.getSessionAttachCheckpoint(params.sessionId, client);
      case 'getSessionPreview':
        return this.getSessionPreview(params.sessionId);
      case 'recoverSessions':
        return this.recoverSessions();
      case 'serializeTerminalState':
        return this.serializeTerminalState(client);
      case 'resumeTerminalState':
        return this.resumeTerminalState(client, params.preparationToken || '');
      case 'updateSessionMetadata':
        return this.enqueueControllerMutation(
          params.sessionId,
          client,
          () => this.updateSessionMetadata(params.sessionId, params.patch || {}),
        );
      case 'shutdownHost':
        return this.shutdownHost(
          client,
          params.controller || {},
          params.preparationToken || '',
        );
      default:
        throw new Error(`Unknown native pty host method: ${method}`);
    }
  }

  enqueueControllerMutation(sessionId, client, operation) {
    const key = typeof sessionId === 'string' && sessionId ? sessionId : '__host__';
    const previous = this.sessionMutationQueues.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        this.assertActiveController(client);
        if (this.rotationPreparation) {
          throw new Error('Native pty host is frozen for runtime rotation');
        }
        return operation();
      });
    this.activeControllerMutations.add(next);
    this.sessionMutationQueues.set(key, next);
    const cleanup = () => {
      this.activeControllerMutations.delete(next);
      if (this.sessionMutationQueues.get(key) === next) {
        this.sessionMutationQueues.delete(key);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  send(client, message) {
    this.writeClientMessage(client, `${JSON.stringify(message)}\n`);
  }

  disconnectSlowClient(client, reason) {
    if (!client || !client.socket || client.socket.destroyed) return false;
    client.socket.destroy(new Error(reason));
    return true;
  }

  writeClientMessage(client, message) {
    if (!client || !client.socket || client.socket.destroyed) return false;
    if (client.socket.writableLength > this.clientMaxBufferedBytes) {
      this.disconnectSlowClient(client, 'native pty client backpressure');
      return false;
    }
    const accepted = client.socket.write(message);
    if (!accepted && client.socket.writableLength > this.clientMaxBufferedBytes) {
      this.disconnectSlowClient(client, 'native pty client backpressure');
      return false;
    }
    return true;
  }

  broadcast(event, payload) {
    const message = `${JSON.stringify({ event, payload })}\n`;
    for (const client of this.clients) {
      this.writeClientMessage(client, message);
    }
  }

  emitSessionEvent(event, payload) {
    this.broadcast(event, payload);
  }

  registerController(client, rawIdentity) {
    const identity = {
      id: typeof rawIdentity.id === 'string' ? rawIdentity.id : '',
      generation: Math.floor(Number(rawIdentity.generation)),
    };
    if (!identity.id || !Number.isFinite(identity.generation) || identity.generation <= 0) {
      throw new Error('Invalid native pty controller identity');
    }

    const current = this.activeControllerIdentity;
    if (
      current &&
      (identity.generation < current.generation ||
        (identity.generation === current.generation && current.id !== identity.id))
    ) {
      throw new Error('Stale native pty controller');
    }

    if (
      !current ||
      current.id !== identity.id ||
      current.generation !== identity.generation
    ) {
      for (const session of this.sessions.values()) {
        invalidateTerminalGeometry(session, 'controller-replaced');
        const flowControl = ensureTerminalReducerFlowControl(session);
        const resetError = resetTerminalRendererFlowControl(flowControl, session.process);
        const unblockError = setTerminalExternalFlowControlBlocked(flowControl, session.process, false);
        const flowError = resetError || unblockError;
        if (flowError) this.failSessionScreenState(session, flowError);
      }
    }
    this.activeControllerIdentity = identity;
    this.activeControllerClient = client;
    client.controllerId = identity.id;
    client.controllerGeneration = identity.generation;
    return {
      registered: true,
      controllerId: identity.id,
      controllerGeneration: identity.generation,
    };
  }

  assertActiveController(client) {
    if (
      !client ||
      client !== this.activeControllerClient ||
      !this.activeControllerIdentity ||
      client.controllerId !== this.activeControllerIdentity.id ||
      client.controllerGeneration !== this.activeControllerIdentity.generation
    ) {
      throw new Error('Native pty mutation requires the active controller');
    }
  }

  async createSession(options) {
    if (this.rotationPreparation) {
      throw new Error('Native pty host is frozen for runtime rotation');
    }
    this.cancelIdleExit();
    const normalized = options.shellIntegrationPrepared === true
      ? {
        ...options,
        args: [...(options.args || [])],
        env: sanitizeAgentEnv(options.env),
      }
      : normalizeShellSessionOptions({
        ...options,
        env: sanitizeAgentEnv(options.env),
      });
    const agentId = normalized.agentId;
    if (!agentId) {
      throw new Error('Missing native pty session id');
    }

    const existing = this.sessions.get(agentId);
    if (existing && existing.status !== 'exited') {
      return { sessionId: agentId, status: existing.status };
    }

    const reviveState = options.reviveState
      ? normalizeTerminalStateEntry(options.reviveState)
      : null;
    const reviveEvent = reviveState?.replayEvent?.events?.[0] || null;
    const cols = reviveEvent?.cols || normalized.cols || DEFAULT_COLS;
    const rows = reviveEvent?.rows || normalized.rows || DEFAULT_ROWS;
    const runtimeGeneration = await allocateNativePtyRuntimeGeneration(this.configDir);
    const runtimeEpoch = formatNativePtyRuntimeEpoch(runtimeGeneration);
    const screenWorker = await this.screenWorkerPool.acquire({ cols, rows, runtimeEpoch });
    const replayText = reviveEvent?.data || '';
    const restoredOutput = reviveState
      ? `${replayText}${TERMINAL_HISTORY_RESTORED_MESSAGE}`
      : '';
    let restoredScreenState = null;
    if (restoredOutput) {
      try {
        await screenWorker.append(restoredOutput, 1, 1);
        restoredScreenState = await screenWorker.getState();
      } catch (error) {
        await screenWorker.dispose().catch(() => {});
        throw new Error(`Failed to restore serialized terminal history: ${error.message}`, {
          cause: error,
        });
      }
    }
    const metadata = {
      ...(normalized.metadata || {}),
      protocolVersion: 1,
      engineName: 'native',
      agentId,
      command: normalized.metadata?.command || normalized.command,
      cwd: normalized.cwd || process.cwd(),
      startedAt: normalized.metadata?.startedAt || Date.now(),
    };

    let ptyProcess;
    try {
      ptyProcess = createPtyProcess(normalized.command, normalized.args || [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: normalized.cwd,
        env: normalized.env || process.env,
      });
    } catch (error) {
      cleanupShellBusyIntegration(normalized.shellBusyIntegration);
      await screenWorker.dispose().catch(() => {});
      throw error;
    }

    const session = {
      id: agentId,
      command: normalized.command,
      args: normalized.args || [],
      cwd: normalized.cwd,
      metadata,
      process: ptyProcess,
      output: trimOutput(restoredOutput),
      outputSeq: restoredOutput ? 1 : 0,
      stateRevision: restoredOutput ? 1 : 0,
      runtimeEpoch,
      runtimeGeneration,
      stateProofAvailable: true,
      reducerFlowControl: createTerminalReducerFlowControl(),
      reducerCommitQueue: Promise.resolve(),
      geometryControl: createTerminalGeometryControl(),
      renderOutput: restoredScreenState?.renderOutput || restoredOutput,
      previewText: restoredScreenState?.previewText || restoredOutput,
      previewSnapshot: restoredScreenState?.previewSnapshot || null,
      previewCols: restoredScreenState?.cols || cols,
      previewRows: restoredScreenState?.rows || rows,
      title: restoredScreenState?.title || '',
      status: 'running',
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
      shellBusyMarkerPending: '',
      shellBusyIntegration: normalized.shellBusyIntegration || null,
      startedAt: metadata.startedAt || Date.now(),
      lastActivityAt: Date.now(),
      exitedAt: null,
      screenWorker,
    };

    this.sessions.set(agentId, session);
    this.bindScreenWorker(session);
    this.bindPty(session);
    this.emitSessionEvent('session-started', {
      sessionId: agentId,
      status: session.status,
      startedAt: session.startedAt,
      runtimeEpoch: session.runtimeEpoch,
      stateRevision: session.stateRevision,
    });
    if (restoredOutput) {
      this.emitSessionEvent('session-sync', {
        sessionId: agentId,
        output: session.renderOutput,
        textOutput: session.output,
        replaceLive: true,
        runtimeEpoch: session.runtimeEpoch,
        outputSeq: session.outputSeq,
        stateRevision: session.stateRevision,
        cols: session.previewCols,
        rows: session.previewRows,
        revived: true,
      });
    }

    return { sessionId: agentId, status: session.status };
  }

  bindScreenWorker(session) {
    session.screenWorker.on('preview', ({ previewText, title, cols, rows, previewSnapshot }) => {
      const current = this.sessions.get(session.id);
      if (!current) return;

      current.previewText = previewText || '';
      current.previewSnapshot = previewSnapshot || null;
      current.previewCols = cols || current.previewCols;
      current.previewRows = rows || current.previewRows;

      if (title && title !== current.title) {
        current.title = title;
        this.emitSessionEvent('session-title', {
          sessionId: current.id,
          title: current.title,
        });
      }

      this.emitSessionEvent('session-preview', {
        sessionId: current.id,
        previewText: current.previewText,
        cols: current.previewCols,
        rows: current.previewRows,
        previewSnapshot: current.previewSnapshot,
      });
    });

    session.screenWorker.on('error', error => {
      this.failSessionScreenState(session, error);
    });
  }

  failSessionScreenState(session, error) {
    const current = this.sessions.get(session.id);
    if (!current || current.stateProofAvailable === false) return;
    current.stateProofAvailable = false;
    const message = error instanceof Error ? error.message : String(error || 'unknown reducer failure');
    this.emitSessionEvent('session-error', {
      sessionId: current.id,
      error: `Terminal state reducer failed: ${message}`,
      fatal: true,
    });
    try {
      current.process?.kill();
    } catch {
      // The session is already unusable because its authoritative reducer failed.
    }
  }

  bindPty(session) {
    session.process.onData(data => this.handleSessionData(session.id, data));
    session.process.onExit(({ code }) => {
      this.handleSessionExit(session.id, code).catch(error => {
        this.emitSessionEvent('session-error', {
          sessionId: session.id,
          error: error.message,
          fatal: false,
        });
      });
    });
  }

  handleSessionData(sessionId, rawData) {
    const current = this.sessions.get(sessionId);
    if (!current || current.stateProofAvailable === false) return;

    const busyState = parseShellBusyMarkers(rawData, current.terminalBusy, current.shellBusyMarkerPending);
    current.shellBusyMarkerPending = busyState.pending;
    if (busyState.markerSeen) {
      const markerAt = Date.now();
      current.terminalBusy = busyState.terminalBusy;
      if (busyState.cwd) {
        current.shellCwd = busyState.cwd;
      }
      if (busyState.exitCodeSeen) {
        current.shellLastExitCode = busyState.lastExitCode;
      }
      if (busyState.shellEvent) {
        current.shellLastEvent = busyState.shellEvent;
      }
      if (busyState.shellEvent === 'start') {
        current.shellCommandStartedAt = markerAt;
      }
      if (busyState.commandTextSeen) {
        current.shellCommand = busyState.shellCommand || '';
      }
      if (busyState.shellEvent === 'finish') {
        const commandStartedAt = current.shellCommandStartedAt;
        if (current.shellCommand) {
          current.shellLastCommand = current.shellCommand;
        }
        if (typeof commandStartedAt === 'number') {
          current.shellLastCommandStartedAt = commandStartedAt;
          current.shellLastCommandFinishedAt = markerAt;
          current.shellLastCommandDurationMs = Math.max(0, markerAt - commandStartedAt);
        }
        current.shellCommand = '';
        current.shellCommandStartedAt = null;
      }
      this.emitSessionEvent('session-busy-state', {
        sessionId,
        terminalBusy: current.terminalBusy,
        cwd: current.shellCwd || current.cwd,
        lastExitCode: current.shellLastExitCode,
        shellEvent: current.shellLastEvent,
        shellCommand: current.shellCommand,
        shellLastCommand: current.shellLastCommand,
        shellCommandStartedAt: current.shellCommandStartedAt,
        shellLastCommandStartedAt: current.shellLastCommandStartedAt,
        shellLastCommandFinishedAt: current.shellLastCommandFinishedAt,
        shellLastCommandDurationMs: current.shellLastCommandDurationMs,
        statusMarkerSeen: busyState.statusMarkerSeen,
        busyMarkerSeen: busyState.busyMarkerSeen,
      });
    }

    const data = busyState.data;
    if (!data) return;

    const reducerDelivery = enqueueTerminalReducerData(
      ensureTerminalReducerFlowControl(current),
      current.process,
      data,
    );
    if (reducerDelivery.error) {
      this.failSessionScreenState(current, reducerDelivery.error);
      return;
    }
    current.outputSeq += 1;
    current.stateRevision += 1;
    const outputSeq = current.outputSeq;
    const stateRevision = current.stateRevision;
    current.output = trimOutput(current.output + data);
    current.lastActivityAt = Date.now();

    const fallbackTitle = extractLatestTerminalTitle(data);
    if (fallbackTitle && fallbackTitle !== current.title) {
      current.title = fallbackTitle;
      this.emitSessionEvent('session-title', {
        sessionId,
        title: current.title,
      });
    }

    if (current.screenWorker) {
      const commit = current.screenWorker.append(data, stateRevision, outputSeq);
      current.reducerCommitQueue = current.reducerCommitQueue.then(() => commit).then(() => {
        const latest = this.sessions.get(sessionId);
        if (latest !== current || latest.stateProofAvailable === false) return;
        const rendererFlowError = this.trackSessionRendererData(latest, data);
        if (rendererFlowError) {
          this.failSessionScreenState(latest, rendererFlowError);
          return;
        }
        const flowError = acknowledgeTerminalReducerData(
          ensureTerminalReducerFlowControl(latest),
          latest.process,
          reducerDelivery.bytes,
        );
        if (flowError) {
          this.failSessionScreenState(latest, flowError);
          return;
        }
        this.emitSessionEvent('session-output', {
          sessionId,
          data,
          runtimeEpoch: latest.runtimeEpoch,
          outputSeq,
          stateRevision,
        });
        this.emitSessionEvent('session-activity', {
          sessionId,
          lastActivityAt: latest.lastActivityAt,
        });
      }).catch(error => this.failSessionScreenState(current, error));
    }
  }

  trackSessionRendererData(session, data) {
    const expired = expireTerminalGeometryIfNeeded(session);
    const hasOwner = Boolean(
      session.geometryControl?.ownerKey &&
      session.geometryControl?.leaseId &&
      session.geometryControl.expiresAt > Date.now()
    );
    if (expired || !hasOwner) {
      const control = ensureTerminalReducerFlowControl(session);
      const resetError = resetTerminalRendererFlowControl(control, session.process);
      return resetError || setTerminalExternalFlowControlBlocked(control, session.process, false);
    }
    if (session.geometryControl.rendererReadyFence !== session.geometryControl.fence) {
      return null;
    }
    return enqueueTerminalRendererData(
      ensureTerminalReducerFlowControl(session),
      session.process,
      String(data || '').length,
    );
  }

  async handleSessionExit(sessionId, code) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') return;

    let screenState = null;
    if (session.screenWorker) {
      screenState = await session.screenWorker.getState().catch(() => null);
    }
    if (screenState) {
      session.renderOutput = screenState.renderOutput || session.renderOutput;
      session.previewText = screenState.previewText || session.previewText || session.output.slice(-2000);
      session.previewSnapshot = screenState.previewSnapshot || session.previewSnapshot;
      session.previewCols = screenState.cols || session.previewCols;
      session.previewRows = screenState.rows || session.previewRows;
      session.title = screenState.title || session.title;
    }

    session.status = 'exited';
    session.exitedAt = Date.now();
    resetTerminalReducerFlowControl(
      ensureTerminalReducerFlowControl(session),
      session.process,
    );
    cleanupShellBusyIntegration(session.shellBusyIntegration);
    if (session.screenWorker) {
      session.screenWorker.dispose().catch(() => {});
      session.screenWorker = null;
    }

    this.emitSessionEvent('session-exited', {
      sessionId,
      code: code == null ? 'unknown' : code,
      exitedAt: session.exitedAt,
    });
    this.emitSessionEvent('session-preview', {
      sessionId,
      previewText: session.previewText,
      cols: session.previewCols,
      rows: session.previewRows,
      previewSnapshot: session.previewSnapshot,
    });
    this.scheduleIdleExitIfUnused();
  }

  async sendInput(sessionId, input, terminalControl = null) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process || session.status === 'exited') {
      throw new Error('Session not available');
    }
    if (session.rotationFrozen === true) {
      throw new Error('Terminal session is frozen for native PTY host rotation');
    }
    if (terminalControl) {
      const controlState = validateTerminalGeometryInput(session, terminalControl);
      if (controlState.status !== 'input-accepted') return controlState;
    }
    session.process.write(terminalInputToPtyString(input));
    session.lastActivityAt = Date.now();
    this.emitSessionEvent('session-activity', {
      sessionId,
      lastActivityAt: session.lastActivityAt,
    });
    return { sent: true };
  }

  async claimSessionGeometry(sessionId, geometry, client) {
    this.assertActiveController(client);
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'rejected', reason: 'session-unavailable' };
    }
    const previousLeaseId = session.geometryControl?.leaseId || '';
    const result = claimTerminalGeometry(session, geometry);
    if (result.status === 'owner' && result.leaseId !== previousLeaseId) {
      const flowError = setTerminalExternalFlowControlBlocked(
        ensureTerminalReducerFlowControl(session),
        session.process,
        true,
      );
      if (flowError) this.failSessionScreenState(session, flowError);
    }
    return result;
  }

  activateSessionRenderer(sessionId, geometry, client) {
    this.assertActiveController(client);
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'renderer-ready-rejected', reason: 'session-unavailable' };
    }
    const controlState = validateTerminalGeometryRendererReady(session, geometry);
    if (controlState.status !== 'renderer-ready-accepted') return controlState;
    if (session.geometryControl.rendererReadyFence === geometry.fence) {
      return { ...controlState, status: 'renderer-ready-accepted', duplicate: true };
    }
    const flowControl = ensureTerminalReducerFlowControl(session);
    const resetError = resetTerminalRendererFlowControl(flowControl, session.process);
    if (resetError) {
      this.failSessionScreenState(session, resetError);
      return { ...controlState, status: 'renderer-ready-rejected', reason: 'flow-control-failed' };
    }
    session.geometryControl.rendererReadyFence = geometry.fence;
    const resumeError = setTerminalExternalFlowControlBlocked(flowControl, session.process, false);
    if (resumeError) {
      session.geometryControl.rendererReadyFence = 0;
      this.failSessionScreenState(session, resumeError);
      return { ...controlState, status: 'renderer-ready-rejected', reason: 'flow-control-failed' };
    }
    return { ...controlState, status: 'renderer-ready-accepted' };
  }

  async getSessionAttachCheckpoint(sessionId, client) {
    this.assertActiveController(client);
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') return null;
    return captureTerminalAttachCheckpoint(session);
  }

  renewSessionGeometry(sessionId, geometry, client) {
    this.assertActiveController(client);
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'rejected', reason: 'session-unavailable' };
    }
    return renewTerminalGeometry(session, geometry);
  }

  releaseSessionGeometry(sessionId, geometry, client) {
    this.assertActiveController(client);
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'unowned', reason: 'session-unavailable' };
    }
    const result = releaseTerminalGeometry(session, geometry);
    if (result.status === 'unowned') {
      const flowControl = ensureTerminalReducerFlowControl(session);
      const flowError = resetTerminalRendererFlowControl(flowControl, session.process)
        || setTerminalExternalFlowControlBlocked(flowControl, session.process, false);
      if (flowError) this.failSessionScreenState(session, flowError);
    }
    return result;
  }

  acknowledgeSessionOutput(sessionId, charCount, geometry, client) {
    this.assertActiveController(client);
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited') {
      return { status: 'output-ack-rejected', reason: 'session-unavailable' };
    }
    const controlState = validateTerminalGeometryOutputAck(session, geometry);
    if (controlState.status !== 'output-ack-accepted') return controlState;
    const flowError = acknowledgeTerminalRendererData(
      ensureTerminalReducerFlowControl(session),
      session.process,
      charCount,
    );
    if (flowError) {
      this.failSessionScreenState(session, flowError);
      return {
        ...controlState,
        status: 'output-ack-rejected',
        reason: 'flow-control-failed',
      };
    }
    return {
      ...controlState,
      acknowledged: Math.max(0, Math.floor(Number(charCount) || 0)),
    };
  }

  async resizeSession(sessionId, cols, rows, geometry, client) {
    this.assertActiveController(client);
    const session = this.sessions.get(sessionId);
    if (!session || !session.process || session.status === 'exited') {
      return { status: 'resize-rejected', reason: 'session-unavailable', resized: false };
    }
    if (session.rotationFrozen === true) {
      return { status: 'resize-rejected', reason: 'runtime-rotation', resized: false };
    }

    const nextCols = normalizePositiveInteger(cols, session.previewCols || DEFAULT_COLS, 1, 1000);
    const nextRows = normalizePositiveInteger(rows, session.previewRows || DEFAULT_ROWS, 1, 1000);
    const resize = beginTerminalGeometryResize(session, geometry);
    if (!resize.accepted) {
      return {
        ...resize.result,
        resized: resize.duplicate === true || resize.result?.status === 'resize-committed',
      };
    }
    if (nextCols === session.previewCols && nextRows === session.previewRows) {
      return commitTerminalGeometryResize(session, resize.requestSeq, {
        resized: true,
        unchanged: true,
      }, resize.token);
    }

    try {
      session.process.resize(nextCols, nextRows);
    } catch (error) {
      return rejectTerminalGeometryResize(session, resize.requestSeq, 'pty-resize-failed', {
        error: error instanceof Error ? error.message : String(error || 'unknown PTY resize failure'),
      }, resize.token);
    }
    session.stateRevision += 1;
    const stateRevision = session.stateRevision;
    const outputSeq = session.outputSeq;
    const runtimeEpoch = session.runtimeEpoch;
    session.previewCols = nextCols;
    session.previewRows = nextRows;

    if (session.screenWorker) {
      const reducerCommit = session.screenWorker.resize(nextCols, nextRows, stateRevision);
      const publishedCommit = session.reducerCommitQueue.then(() => reducerCommit).then((screenState) => {
        if (
          screenState.runtimeEpoch !== runtimeEpoch ||
          screenState.outputSeq !== outputSeq ||
          screenState.stateRevision !== stateRevision
        ) {
          throw new Error('Terminal screen resize returned a non-authoritative state cut');
        }
        session.previewText = screenState.previewText || '';
        session.previewSnapshot = screenState.previewSnapshot || session.previewSnapshot;
        session.renderOutput = typeof screenState.renderOutput === 'string'
          ? screenState.renderOutput
          : session.renderOutput;
        session.previewCols = screenState.cols || nextCols;
        session.previewRows = screenState.rows || nextRows;
        session.title = screenState.title || session.title;
        this.emitSessionEvent('session-transition', {
          sessionId,
          kind: 'resize',
          data: '',
          runtimeEpoch: screenState.runtimeEpoch,
          outputSeq: screenState.outputSeq,
          stateRevision: screenState.stateRevision,
          cols: screenState.cols,
          rows: screenState.rows,
        });
        return screenState;
      });
      session.reducerCommitQueue = publishedCommit.catch(error => {
        this.failSessionScreenState(session, error);
      });
      try {
        await publishedCommit;
      } catch {
        return rejectTerminalGeometryResize(
          session,
          resize.requestSeq,
          'screen-reducer-failed',
          {},
          resize.token,
        );
      }
    }

    return commitTerminalGeometryResize(session, resize.requestSeq, {
      resized: true,
      unchanged: false,
      runtimeEpoch,
      outputSeq,
      stateRevision,
      cols: nextCols,
      rows: nextRows,
    }, resize.token);
  }

  async clearBuffer(sessionId, geometry = null) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { cleared: false };
    }
    if (session.rotationFrozen === true) {
      return { cleared: false, reason: 'runtime-rotation' };
    }
    if (geometry) {
      const controlState = validateTerminalGeometryClear(session, geometry);
      if (controlState.status !== 'clear-accepted') {
        return { cleared: false, ...controlState };
      }
    }

    session.output = '';
    session.stateRevision += 1;
    const stateRevision = session.stateRevision;
    const outputSeq = session.outputSeq;
    const runtimeEpoch = session.runtimeEpoch;
    session.renderOutput = '';
    session.previewText = '';
    session.previewSnapshot = null;
    session.lastActivityAt = Date.now();

    let exactState = {
      renderOutput: '',
      runtimeEpoch,
      outputSeq,
      stateRevision,
      cols: session.previewCols,
      rows: session.previewRows,
    };
    if (session.screenWorker) {
      const reducerCommit = session.screenWorker.clear(stateRevision, outputSeq);
      const publishedCommit = session.reducerCommitQueue.then(() => reducerCommit).then((screenState) => {
        if (
          screenState.runtimeEpoch !== runtimeEpoch ||
          screenState.outputSeq !== outputSeq ||
          screenState.stateRevision !== stateRevision
        ) {
          throw new Error('Terminal screen clear returned a non-authoritative state cut');
        }
        session.renderOutput = typeof screenState.renderOutput === 'string' ? screenState.renderOutput : '';
        session.previewText = screenState.previewText || '';
        session.previewSnapshot = screenState.previewSnapshot || null;
        session.previewCols = screenState.cols || session.previewCols;
        session.previewRows = screenState.rows || session.previewRows;
        exactState = screenState;
        if (screenState.title && screenState.title !== session.title) {
          session.title = screenState.title;
          this.emitSessionEvent('session-title', { sessionId, title: session.title });
        }
        this.emitSessionEvent('session-transition', {
          sessionId,
          kind: 'clear',
          data: '\x1b[2J\x1b[3J\x1b[H',
          runtimeEpoch: screenState.runtimeEpoch,
          outputSeq: screenState.outputSeq,
          stateRevision: screenState.stateRevision,
          cols: screenState.cols,
          rows: screenState.rows,
        });
        return screenState;
      });
      session.reducerCommitQueue = publishedCommit.catch(error => {
        this.failSessionScreenState(session, error);
      });
      try {
        await publishedCommit;
      } catch {
        return { cleared: false };
      }
    }
    this.emitSessionEvent('session-preview', {
      sessionId,
      previewText: session.previewText,
      cols: session.previewCols,
      rows: session.previewRows,
      previewSnapshot: session.previewSnapshot,
      title: session.title,
    });
    this.emitSessionEvent('session-activity', {
      sessionId,
      lastActivityAt: session.lastActivityAt,
    });
    return {
      cleared: true,
      runtimeEpoch: exactState.runtimeEpoch,
      outputSeq: exactState.outputSeq,
      stateRevision: exactState.stateRevision,
      cols: exactState.cols,
      rows: exactState.rows,
      expiresAt: session.geometryControl?.expiresAt || 0,
    };
  }

  async killSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process) return { killed: false };
    if (session.status === 'exited') return { killed: false };
    session.status = 'stopping';
    session.killRequestedAt = Date.now();
    session.process.kill('SIGTERM');
    const timer = setTimeout(() => {
      const latest = this.sessions.get(sessionId);
      if (!latest || latest.status === 'exited' || !latest.process) return;
      latest.process.kill('SIGKILL');
    }, 1500);
    if (typeof timer.unref === 'function') timer.unref();
    return { killed: true };
  }

  async getSessionState(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // Cut the raw output before the async worker request. The screen worker
    // receives every append with its output sequence and reports the exact
    // sequence represented by its serialized terminal state.
    const snapshotOutput = session.output;
    const fallbackPreviewText = session.previewText || snapshotOutput.slice(-2000);
    const fallbackPreviewSnapshot = session.previewSnapshot;
    const fallbackPreviewCols = session.previewCols;
    const fallbackPreviewRows = session.previewRows;
    const fallbackTitle = session.title;
    const checkpoint = await captureTerminalAttachCheckpoint(session);
    const title = checkpoint ? checkpoint.title : fallbackTitle;
    const previewText = checkpoint ? checkpoint.previewText : fallbackPreviewText;

    return {
      sessionId: session.id,
      status: session.status,
      runtimeEpoch: session.runtimeEpoch,
      output: snapshotOutput,
      outputSeq: checkpoint?.outputSeq ?? null,
      stateRevision: checkpoint?.stateRevision ?? null,
      renderOutput: checkpoint ? checkpoint.renderOutput : snapshotOutput,
      previewText,
      previewSnapshot: checkpoint ? checkpoint.previewSnapshot : fallbackPreviewSnapshot,
      previewCols: checkpoint ? checkpoint.cols : fallbackPreviewCols,
      previewRows: checkpoint ? checkpoint.rows : fallbackPreviewRows,
      title,
      lastActivityAt: session.lastActivityAt,
      startedAt: session.startedAt,
      exitedAt: session.exitedAt || null,
      terminalBusy: session.terminalBusy,
      shellCommand: session.shellCommand || '',
      shellLastCommand: session.shellLastCommand || '',
      shellCommandStartedAt: session.shellCommandStartedAt ?? null,
      shellLastCommandStartedAt: session.shellLastCommandStartedAt ?? null,
      shellLastCommandFinishedAt: session.shellLastCommandFinishedAt ?? null,
      shellLastCommandDurationMs: session.shellLastCommandDurationMs ?? null,
      terminalStatus: deriveTerminalStatus({
        command: session.command,
        cwd: session.shellCwd || session.cwd,
        status: session.status,
        title,
        previewText,
        terminalBusy: session.terminalBusy,
        shellLastExitCode: session.shellLastExitCode,
        shellLastEvent: session.shellLastEvent,
        shellCommand: session.shellCommand,
        shellLastCommand: session.shellLastCommand,
        shellCommandStartedAt: session.shellCommandStartedAt,
        shellLastCommandStartedAt: session.shellLastCommandStartedAt,
        shellLastCommandFinishedAt: session.shellLastCommandFinishedAt,
        shellLastCommandDurationMs: session.shellLastCommandDurationMs,
      }),
    };
  }

  async getSessionPreview(sessionId) {
    const state = await this.getSessionState(sessionId);
    return state ? state.previewText || '' : '';
  }

  async recoverSessions() {
    const recovered = [];
    for (const session of this.sessions.values()) {
      if (session.status === 'exited') continue;
      recovered.push({
        agentId: session.id,
        metadata: session.metadata || {},
        state: await this.getSessionState(session.id),
      });
    }
    return recovered;
  }

  serializeTerminalState(client = null) {
    if (client) this.assertActiveController(client);
    if (this.rotationPreparation) {
      if (
        client &&
        this.rotationPreparation.controllerClient &&
        this.rotationPreparation.controllerClient !== client
      ) {
        throw new Error('Native pty host rotation is owned by another controller');
      }
      return this.rotationPreparation.promise;
    }

    const preparation = {
      token: crypto.randomUUID(),
      controllerClient: client,
      phase: 'preparing',
      promise: null,
      serializedTerminalState: '',
    };
    this.rotationPreparation = preparation;
    preparation.promise = this.prepareSerializedTerminalState(preparation);
    return preparation.promise;
  }

  async prepareSerializedTerminalState(preparation) {
    const entries = [];
    try {
      await Promise.allSettled([...this.activeControllerMutations]);
      if (this.rotationPreparation !== preparation) {
        throw new Error('Native pty host rotation preparation was cancelled');
      }

      const liveSessions = [...this.sessions.values()]
        .filter(session => session.status === 'running' && session.stateProofAvailable !== false);
      for (const session of liveSessions) {
        session.rotationFrozen = true;
        const flowError = setTerminalExternalFlowControlBlocked(
          session.reducerFlowControl,
          session.process,
          true,
        );
        if (flowError) throw flowError;
      }

      for (const session of liveSessions) {
        await session.reducerCommitQueue;
        const state = await this.getSessionState(session.id);
        const current = this.sessions.get(session.id);
        if (
          current !== session ||
          session.status !== 'running' ||
          state?.status !== 'running'
        ) {
          continue;
        }
        if (
          !state ||
          typeof state.renderOutput !== 'string' ||
          !Number.isFinite(state.outputSeq) ||
          !Number.isFinite(state.stateRevision)
        ) {
          throw new Error(`Cannot serialize terminal ${session.id} without an exact reducer checkpoint`);
        }
        entries.push({
          id: session.id,
          metadata: session.metadata || {},
          processDetails: {
            cwd: session.shellCwd || session.cwd || '',
            title: state.title || session.title || '',
          },
          processLaunchConfig: {
            command: session.command || '',
            args: session.args || [],
            category: session.metadata?.category || '',
          },
          replayEvent: {
            events: [{
              data: state.renderOutput,
              cols: state.previewCols || session.previewCols || DEFAULT_COLS,
              rows: state.previewRows || session.previewRows || DEFAULT_ROWS,
            }],
          },
          timestamp: Date.now(),
        });
      }
      const serializedTerminalState = serializeTerminalState(entries);
      preparation.phase = 'prepared';
      preparation.serializedTerminalState = serializedTerminalState;
      return {
        preparationToken: preparation.token,
        serializedTerminalState,
      };
    } catch (error) {
      this.resumePreparedTerminalState(preparation.token);
      throw error;
    }
  }

  resumeTerminalState(client = null, preparationToken = '') {
    if (client) this.assertActiveController(client);
    return this.resumePreparedTerminalState(preparationToken);
  }

  resumePreparedTerminalState(preparationToken = '') {
    const preparation = this.rotationPreparation;
    if (!preparation) return { resumed: 0 };
    if (preparationToken && preparation.token !== preparationToken) {
      throw new Error('Native pty rotation preparation token does not match');
    }
    let resumed = 0;
    for (const session of this.sessions.values()) {
      if (session.rotationFrozen !== true) continue;
      session.rotationFrozen = false;
      const flowError = setTerminalExternalFlowControlBlocked(
        session.reducerFlowControl,
        session.process,
        false,
      );
      if (flowError) {
        this.failSessionScreenState(session, flowError);
        continue;
      }
      resumed += 1;
    }
    if (this.rotationPreparation === preparation) {
      this.rotationPreparation = null;
    }
    return { resumed };
  }

  async updateSessionMetadata(sessionId, patch) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.metadata = {
      ...(session.metadata || {}),
      ...(patch || {}),
      agentId: sessionId,
      engineName: 'native',
    };
    return session.metadata;
  }

  shutdownHost(client, rawIdentity = {}, preparationToken = '') {
    const requestedGeneration = Math.floor(Number(rawIdentity.generation));
    const requestedId = typeof rawIdentity.id === 'string' ? rawIdentity.id : '';
    const active = this.activeControllerIdentity;
    const activeClient = client
      && client === this.activeControllerClient
      && active
      && client.controllerId === active.id
      && client.controllerGeneration === active.generation;
    const newerController = requestedId
      && Number.isFinite(requestedGeneration)
      && requestedGeneration > 0
      && (!active || requestedGeneration > active.generation);
    if (!activeClient && !newerController) {
      throw new Error('Native pty shutdown requires the active or a newer controller');
    }
    const preparation = this.rotationPreparation;
    if (preparation) {
      if (
        preparation.phase !== 'prepared' ||
        !preparationToken ||
        preparationToken !== preparation.token
      ) {
        throw new Error('Native pty shutdown requires the prepared rotation token');
      }
      preparation.phase = 'committing';
    } else if (this.hasLiveSessions()) {
      throw new Error('Native pty shutdown requires a prepared terminal checkpoint');
    }
    setImmediate(() => {
      this.dispose().finally(() => {
        if (this.exitOnShutdown) process.exit(0);
      });
    });
    return { shuttingDown: true };
  }

  async disposeSessionProcess(session) {
    if (!session || !session.process || session.status === 'exited') return;
    session.status = 'stopping';
    try {
      session.process.kill('SIGTERM');
    } catch {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, DISPOSE_PTY_GRACE_MS));
    if (session.status === 'exited') return;

    try {
      session.process.kill('SIGKILL');
    } catch {
      // ignore dispose races
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ownerCheckTimer) {
      clearInterval(this.ownerCheckTimer);
      this.ownerCheckTimer = null;
    }
    this.cancelIdleExit();
    await Promise.allSettled([...this.sessions.values()].map(session => this.disposeSessionProcess(session)));
    for (const session of this.sessions.values()) {
      cleanupShellBusyIntegration(session.shellBusyIntegration);
      if (session.screenWorker) {
        await session.screenWorker.dispose().catch(() => {});
      }
    }
    await this.screenWorkerPool.dispose();
    if (this.server) {
      await new Promise(resolve => this.server.close(() => resolve()));
      this.server = null;
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
  }
}

function startNativePtyHostProcess() {
  const host = new NativePtyHost();
  host.start().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    host.dispose().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    host.dispose().finally(() => process.exit(0));
  });

  return host;
}

if (require.main === module) {
  startNativePtyHostProcess();
}

module.exports = NativePtyHost;
module.exports.startNativePtyHostProcess = startNativePtyHostProcess;
