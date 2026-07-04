#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const TerminalScreenWorkerPool = require('./terminal-screen-worker-pool');
const { nativePtyHostSocketPath } = require('./native-pty-host-path');
const { terminalInputToPtyString } = require('./input-parts');
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

const OUTPUT_LIMIT = 10000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 30;
const OWNER_CHECK_INTERVAL_MS = 1000;
const DISPOSE_PTY_GRACE_MS = 800;
const DEFAULT_IDLE_EXIT_MS = 60000;

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
  delete next.NO_COLOR;

  if (!next.TERM || String(next.TERM).toLowerCase() === 'dumb') {
    next.TERM = 'xterm-256color';
  }
  next.COLORTERM = 'truecolor';
  next.CLICOLOR = '1';
  next.TERM_PROGRAM = 'farming';
  next.TERM_PROGRAM_VERSION = next.TERM_PROGRAM_VERSION || process.env.npm_package_version || '';
  return next;
}

class NativePtyHost {
  constructor(options = {}) {
    this.configDir = options.configDir || process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');
    this.socketPath = options.socketPath || process.env.FARMING_NATIVE_PTY_HOST_SOCKET || nativePtyHostSocketPath(this.configDir);
    this.ownerPid = Number(options.ownerPid || process.env.FARMING_NATIVE_PTY_HOST_OWNER_PID || 0);
    this.sessions = new Map();
    this.clients = new Set();
    this.ownerCheckTimer = null;
    this.idleExitTimer = null;
    this.hasAcceptedClient = false;
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
      const line = client.buffer.slice(0, newline);
      client.buffer = client.buffer.slice(newline + 1);
      if (line.trim()) {
        this.handleClientMessage(client, line);
      }
      newline = client.buffer.indexOf('\n');
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
      const result = await this.dispatch(message.method, message.params || {});
      this.send(client, { id, ok: true, result });
    } catch (error) {
      this.send(client, {
        id,
        ok: false,
        error: error && error.message ? error.message : 'Native pty host request failed',
      });
    }
  }

  dispatch(method, params) {
    switch (method) {
      case 'ping':
        return { ok: true };
      case 'createSession':
        return this.createSession(params.options || {});
      case 'sendInput':
        return this.sendInput(params.sessionId, params.input);
      case 'resizeSession':
        return this.resizeSession(params.sessionId, params.cols, params.rows);
      case 'killSession':
        return this.killSession(params.sessionId);
      case 'getSessionState':
        return this.getSessionState(params.sessionId);
      case 'getSessionPreview':
        return this.getSessionPreview(params.sessionId);
      case 'recoverSessions':
        return this.recoverSessions();
      case 'updateSessionMetadata':
        return this.updateSessionMetadata(params.sessionId, params.patch || {});
      case 'shutdownHost':
        return this.shutdownHost();
      default:
        throw new Error(`Unknown native pty host method: ${method}`);
    }
  }

  send(client, message) {
    if (!client || !client.socket || client.socket.destroyed) return;
    client.socket.write(`${JSON.stringify(message)}\n`);
  }

  broadcast(event, payload) {
    const message = `${JSON.stringify({ event, payload })}\n`;
    for (const client of this.clients) {
      if (client.socket.destroyed) continue;
      client.socket.write(message);
    }
  }

  emitSessionEvent(event, payload) {
    this.broadcast(event, payload);
  }

  async createSession(options) {
    this.cancelIdleExit();
    const normalized = normalizeShellSessionOptions({
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

    const cols = normalized.cols || DEFAULT_COLS;
    const rows = normalized.rows || DEFAULT_ROWS;
    const screenWorker = await this.screenWorkerPool.acquire({ cols, rows });
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
      output: '',
      outputSeq: 0,
      renderOutput: '',
      previewText: '',
      previewSnapshot: null,
      previewCols: cols,
      previewRows: rows,
      title: '',
      status: 'running',
      terminalBusy: null,
      shellCwd: '',
      shellLastExitCode: null,
      shellLastEvent: '',
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
    });

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
      this.emitSessionEvent('session-error', {
        sessionId: session.id,
        error: `Failed to update terminal screen state: ${error.message}`,
        fatal: false,
      });
    });
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
    if (!current) return;

    const busyState = parseShellBusyMarkers(rawData, current.terminalBusy, current.shellBusyMarkerPending);
    current.shellBusyMarkerPending = busyState.pending;
    if (busyState.markerSeen) {
      current.terminalBusy = busyState.terminalBusy;
      if (busyState.cwd) {
        current.shellCwd = busyState.cwd;
      }
      if (typeof busyState.lastExitCode === 'number') {
        current.shellLastExitCode = busyState.lastExitCode;
      }
      if (busyState.shellEvent) {
        current.shellLastEvent = busyState.shellEvent;
      }
      this.emitSessionEvent('session-busy-state', {
        sessionId,
        terminalBusy: current.terminalBusy,
        cwd: current.shellCwd || current.cwd,
        lastExitCode: current.shellLastExitCode,
        shellEvent: current.shellLastEvent,
      });
    }

    const data = busyState.data;
    if (!data) return;

    current.outputSeq += 1;
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

    this.emitSessionEvent('session-output', {
      sessionId,
      data,
      outputSeq: current.outputSeq,
    });
    this.emitSessionEvent('session-activity', {
      sessionId,
      lastActivityAt: current.lastActivityAt,
    });

    if (current.screenWorker) {
      current.screenWorker.append(data);
    }
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

  async sendInput(sessionId, input) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process || session.status === 'exited') {
      throw new Error('Session not available');
    }
    session.process.write(terminalInputToPtyString(input));
    session.lastActivityAt = Date.now();
    this.emitSessionEvent('session-activity', {
      sessionId,
      lastActivityAt: session.lastActivityAt,
    });
    return { sent: true };
  }

  async resizeSession(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process || session.status === 'exited') {
      return { resized: false };
    }

    const nextCols = normalizePositiveInteger(cols, session.previewCols || DEFAULT_COLS, 1, 1000);
    const nextRows = normalizePositiveInteger(rows, session.previewRows || DEFAULT_ROWS, 1, 1000);
    session.process.resize(nextCols, nextRows);
    session.previewCols = nextCols;
    session.previewRows = nextRows;

    if (session.screenWorker) {
      try {
        const screenState = await session.screenWorker.resize(nextCols, nextRows);
        session.previewText = screenState.previewText || '';
        session.previewSnapshot = screenState.previewSnapshot || session.previewSnapshot;
        session.renderOutput = screenState.renderOutput || session.renderOutput;
        session.previewCols = screenState.cols || nextCols;
        session.previewRows = screenState.rows || nextRows;
        session.title = screenState.title || session.title;
      } catch (error) {
        this.emitSessionEvent('session-error', {
          sessionId,
          error: `Failed to resize terminal screen state: ${error.message}`,
          fatal: false,
        });
      }
    }

    return { resized: true, cols: session.previewCols, rows: session.previewRows };
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
    const screenState = session.screenWorker
      ? await session.screenWorker.getState().catch(() => null)
      : null;

    const title = (screenState && screenState.title) || session.title;
    const previewText = (screenState && screenState.previewText) || session.previewText || session.output.slice(-2000);

    return {
      sessionId: session.id,
      status: session.status,
      output: session.output,
      outputSeq: session.outputSeq || 0,
      renderOutput: (screenState && screenState.renderOutput) || session.renderOutput || session.output,
      previewText,
      previewSnapshot: (screenState && screenState.previewSnapshot) || session.previewSnapshot,
      previewCols: (screenState && screenState.cols) || session.previewCols,
      previewRows: (screenState && screenState.rows) || session.previewRows,
      title,
      lastActivityAt: session.lastActivityAt,
      startedAt: session.startedAt,
      exitedAt: session.exitedAt || null,
      terminalBusy: session.terminalBusy,
      terminalStatus: deriveTerminalStatus({
        command: session.command,
        cwd: session.shellCwd || session.cwd,
        status: session.status,
        title,
        previewText,
        terminalBusy: session.terminalBusy,
        shellLastExitCode: session.shellLastExitCode,
        shellLastEvent: session.shellLastEvent,
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

  shutdownHost() {
    setImmediate(() => {
      this.dispose().finally(() => process.exit(0));
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
