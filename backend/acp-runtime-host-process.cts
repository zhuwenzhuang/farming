'use strict';

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as net from 'net';
import * as path from 'path';
import { AcpRuntime } from './acp-runtime.cjs';
import { AcpRuntimeHostService } from './acp-runtime-host-service.cjs';
import { acpRuntimeHostIdentity } from './acp-runtime-host-identity.cjs';
import { acpRuntimeHostSocketPath } from './acp-runtime-host-path.cjs';
import { configInstanceFingerprint } from './config-instance.cjs';
import { probeUnixSocket } from './terminal-runtime-cleanup.cjs';

type UnknownRecord = Record<string, unknown>;

interface HostClient {
  buffer: string;
  controller: { id: string; generation: number } | null;
  disconnected: boolean;
  socket: net.Socket;
}

interface HostMessage {
  id?: unknown;
  method?: unknown;
  params?: UnknownRecord;
}

interface AcpRuntimeHostProcessOptions {
  configDir?: string;
  exitOnShutdown?: boolean;
  idleExitMs?: number;
  maxBufferedBytes?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  runtime?: AcpRuntime;
  socketPath?: string;
}

interface SocketIdentity {
  dev: bigint;
  ino: bigint;
}

interface PendingControllerCallback {
  client: HostClient;
  reject(error: Error): void;
  resolve(value: unknown): void;
  timer: NodeJS.Timeout;
}

interface HostForkReservation {
  client: HostClient;
  completion: Promise<unknown>;
  release(): void;
}

interface HostMutationOperation {
  bindingEpoch: string;
  completion: Promise<unknown>;
  signature: string;
  settled: boolean;
  updatedAt: number;
}

const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const DEFAULT_IDLE_EXIT_MS = 60000;

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'ACP runtime host request failed');
}

class AcpRuntimeHostProcess {
  readonly configDir: string;
  readonly socketPath: string;
  readonly runtime: AcpRuntime;
  readonly service: AcpRuntimeHostService;
  readonly exitOnShutdown: boolean;
  readonly maxRequestBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxResponseBytes: number;
  readonly idleExitMs: number;
  readonly clients: Set<HostClient>;
  server: net.Server | null;
  boundSocketIdentity: SocketIdentity | null;
  idleExitTimer: NodeJS.Timeout | null;
  disposed: boolean;
  activeControllerClient: HostClient | null;
  controllerCallbacks: Map<string, PendingControllerCallback>;
  forkReservations: Map<string, HostForkReservation>;
  mutationOperations: Map<string, HostMutationOperation>;

  constructor(options: AcpRuntimeHostProcessOptions = {}) {
    const configDir = String(options.configDir || process.env.FARMING_CONFIG_DIR || '').trim();
    if (!configDir) throw new Error('ACP runtime host requires a config directory');
    this.configDir = path.resolve(configDir);
    this.socketPath = options.socketPath
      || process.env.FARMING_ACP_RUNTIME_HOST_SOCKET
      || acpRuntimeHostSocketPath(this.configDir);
    this.runtime = options.runtime || new AcpRuntime({
      configDir: this.configDir,
      ...(process.env.FARMING_E2E_FAKE_ACP_AGENT === '1'
        ? {
            resolveLaunch: () => ({
              command: process.execPath,
              args: [
                '--import',
                require.resolve('tsx'),
                path.join(__dirname, 'tests', 'fixtures', 'fake-acp-agent.mts'),
              ],
              version: 'e2e',
            }),
          }
        : {}),
    });
    this.service = new AcpRuntimeHostService({ runtime: this.runtime });
    this.exitOnShutdown = options.exitOnShutdown !== false;
    this.maxRequestBytes = Number(options.maxRequestBytes) || DEFAULT_MAX_REQUEST_BYTES;
    this.maxBufferedBytes = Number(options.maxBufferedBytes) || DEFAULT_MAX_BUFFERED_BYTES;
    this.maxResponseBytes = Number(options.maxResponseBytes) || DEFAULT_MAX_REQUEST_BYTES;
    this.idleExitMs = Number.isFinite(Number(options.idleExitMs))
      ? Math.max(0, Math.floor(Number(options.idleExitMs)))
      : DEFAULT_IDLE_EXIT_MS;
    this.clients = new Set();
    this.server = null;
    this.boundSocketIdentity = null;
    this.idleExitTimer = null;
    this.disposed = false;
    this.activeControllerClient = null;
    this.controllerCallbacks = new Map();
    this.forkReservations = new Map();
    this.mutationOperations = new Map();
    this.service.on('event', event => this.broadcast('runtime-event', event));
  }

  async prepareSocket(): Promise<void> {
    if (process.platform === 'win32') return;
    const socketDirectory = path.dirname(this.socketPath);
    if (this.socketPath === acpRuntimeHostSocketPath(this.configDir)) {
      await fs.promises.mkdir(socketDirectory, { mode: 0o700 }).catch(error => {
        if (errorCode(error) !== 'EEXIST') throw error;
      });
    } else {
      await fs.promises.mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    }
    const directoryStat = await fs.promises.lstat(socketDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('ACP runtime host socket directory is not a private directory');
    }
    if (process.getuid && directoryStat.uid !== process.getuid()) {
      throw new Error('ACP runtime host socket directory belongs to another user');
    }
    if (this.socketPath === acpRuntimeHostSocketPath(this.configDir)) {
      await fs.promises.chmod(socketDirectory, 0o700);
    } else if ((directoryStat.mode & 0o077) !== 0) {
      throw new Error('ACP runtime host custom socket directory is accessible to other users');
    }
    if (!fs.existsSync(this.socketPath)) return;
    const probe = await probeUnixSocket(this.socketPath);
    if (probe.active) throw new Error(`ACP runtime host socket is already active: ${this.socketPath}`);
    await fs.promises.unlink(this.socketPath).catch(error => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }

  async start(): Promise<void> {
    await this.prepareSocket();
    const server = net.createServer(socket => this.handleConnection(socket));
    this.server = server;
    const previousUmask = process.platform === 'win32' ? null : process.umask(0o077);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      try {
        server.listen(this.socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      } finally {
        if (previousUmask !== null) process.umask(previousUmask);
      }
    });
    if (process.platform !== 'win32') {
      await fs.promises.chmod(this.socketPath, 0o600);
      const stat = await fs.promises.stat(this.socketPath, { bigint: true });
      this.boundSocketIdentity = { dev: stat.dev, ino: stat.ino };
    }
    this.scheduleIdleExit();
  }

  handleConnection(socket: net.Socket): void {
    if (this.disposed) {
      socket.destroy(new Error('ACP runtime host is shutting down'));
      return;
    }
    this.cancelIdleExit();
    const client: HostClient = { socket, buffer: '', controller: null, disconnected: false };
    this.clients.add(client);
    socket.on('data', chunk => this.handleData(client, chunk));
    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));
  }

  removeClient(client: HostClient): void {
    if (client.disconnected) return;
    client.disconnected = true;
    this.clients.delete(client);
    if (client.controller && this.activeControllerClient === client) {
      this.activeControllerClient = null;
      this.service.disconnectController(client.controller);
    }
    for (const [callbackId, callback] of this.controllerCallbacks) {
      if (callback.client !== client) continue;
      clearTimeout(callback.timer);
      const error = new Error('ACP runtime Host Controller callback outcome is uncertain') as Error & UnknownRecord;
      error.uncertain = true;
      callback.reject(error);
      this.controllerCallbacks.delete(callbackId);
    }
    for (const [token, reservation] of this.forkReservations) {
      if (reservation.client !== client) continue;
      reservation.release();
      this.forkReservations.delete(token);
    }
    this.scheduleIdleExit();
  }

  cancelIdleExit(): void {
    if (!this.idleExitTimer) return;
    clearTimeout(this.idleExitTimer);
    this.idleExitTimer = null;
  }

  scheduleIdleExit(): void {
    const bindingCount = this.runtime.bindings?.size ?? this.service.state.bindings.size;
    if (
      this.disposed
      || this.idleExitMs <= 0
      || this.clients.size > 0
      || bindingCount > 0
      || this.idleExitTimer
    ) return;
    this.idleExitTimer = setTimeout(() => {
      this.idleExitTimer = null;
      const currentBindingCount = this.runtime.bindings?.size ?? this.service.state.bindings.size;
      if (this.clients.size > 0 || currentBindingCount > 0 || this.disposed) return;
      void this.dispose().finally(() => {
        if (this.exitOnShutdown) process.exit(0);
      });
    }, this.idleExitMs);
    this.idleExitTimer.unref?.();
  }

  handleData(client: HostClient, chunk: Buffer | string): void {
    client.buffer += chunk.toString('utf8');
    let newline = client.buffer.indexOf('\n');
    while (newline >= 0) {
      if (newline > this.maxRequestBytes) {
        client.socket.destroy(new Error('ACP runtime host request exceeded limit'));
        return;
      }
      const line = client.buffer.slice(0, newline);
      client.buffer = client.buffer.slice(newline + 1);
      if (line.trim()) void this.handleMessage(client, line);
      newline = client.buffer.indexOf('\n');
    }
    if (client.buffer.length > this.maxRequestBytes) {
      client.socket.destroy(new Error('ACP runtime host request exceeded limit'));
    }
  }

  async handleMessage(client: HostClient, line: string): Promise<void> {
    let message: HostMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const id = Number(message.id);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    try {
      const result = await this.dispatch(client, String(message.method || ''), message.params || {});
      this.send(client, { id, ok: true, result });
    } catch (error) {
      const detail = error && typeof error === 'object' ? error as UnknownRecord : {};
      this.send(client, {
        id,
        ok: false,
        error: {
          message: errorMessage(error),
          ...(detail.code ? { code: String(detail.code) } : {}),
          ...(detail.uncertain === true ? { uncertain: true } : {}),
          ...(detail.retryable === true ? { retryable: true } : {}),
          ...(detail.operationId ? { operationId: String(detail.operationId) } : {}),
        },
      });
    }
  }

  requireController(client: HostClient): { id: string; generation: number } {
    if (this.disposed) throw new Error('ACP runtime host is shutting down');
    if (!client.controller || this.activeControllerClient !== client) {
      throw new Error('ACP runtime host controller is not registered');
    }
    this.service.state.assertController(client.controller);
    return client.controller;
  }

  async dispatch(client: HostClient, method: string, params: UnknownRecord): Promise<unknown> {
    if (this.disposed) throw new Error('ACP runtime host is shutting down');
    if (method === 'ping') {
      return {
        pid: process.pid,
        hostEpoch: this.service.state.hostEpoch,
        eventSeq: this.service.state.eventSeq,
        bindingCount: this.runtime.bindings?.size ?? this.service.state.bindings.size,
        configInstanceFingerprint: configInstanceFingerprint(this.configDir),
        runtimeIdentity: acpRuntimeHostIdentity(),
      };
    }
    if (method === 'registerController') {
      const identity = await this.service.registerController(params.identity as never);
      const previous = this.activeControllerClient;
      if (previous && previous !== client) {
        previous.controller = null;
        previous.socket.destroy(new Error('ACP runtime host controller was replaced'));
      }
      client.controller = identity;
      this.activeControllerClient = client;
      return identity;
    }
    if (method === 'recover') {
      this.requireController(client);
      return this.service.recover(Number(params.afterEventSeq));
    }
    if (method === 'resolveControllerCallback') {
      this.requireController(client);
      const callbackId = String(params.callbackId || '');
      const callback = this.controllerCallbacks.get(callbackId);
      if (!callback || callback.client !== client) throw new Error('ACP runtime Host callback is no longer active');
      this.controllerCallbacks.delete(callbackId);
      clearTimeout(callback.timer);
      if (params.ok === true) callback.resolve(params.result);
      else {
        const error = new Error(String(params.error || 'ACP runtime Host Controller callback failed')) as Error & UnknownRecord;
        if (params.uncertain === true) error.uncertain = true;
        callback.reject(error);
      }
      return { resolved: true };
    }

    const controller = this.requireController(client);
    switch (method) {
      case 'prepareAgent':
        return this.service.prepareAgent(
          controller,
          this.controllerCallbackOptions(client, params.options as UnknownRecord),
        );
      case 'createSessionIdentity':
        return this.runtime.createSessionIdentity(params.options as UnknownRecord);
      case 'submitPrompt':
        return this.service.submitPrompt(controller, params as never);
      case 'cancelTurn':
        return this.service.cancelTurn(controller, params as never);
      case 'getSession':
        return this.runtime.getSession(String(params.agentId || ''), params.options as UnknownRecord);
      case 'getSessionRequestOptions':
        return this.runtime.getSessionRequestOptions(String(params.agentId || ''));
      case 'getSessionForRead':
        return this.runtime.getSessionForRead(String(params.agentId || ''), params.options as UnknownRecord);
      case 'getTranscriptSessionForRead':
        return this.runtime.getTranscriptSessionForRead(String(params.agentId || ''), params.options as UnknownRecord);
      case 'getSubagentTranscriptSessionForRead':
        return this.runtime.getSubagentTranscriptSessionForRead(
          String(params.agentId || ''),
          String(params.sessionId || ''),
          params.options as UnknownRecord,
        );
      case 'getTranscriptEntryForRead':
        return this.runtime.getTranscriptEntryForRead(String(params.agentId || ''), String(params.entryId || ''));
      case 'getToolEntryForRead':
        return this.runtime.getToolEntryForRead(String(params.agentId || ''), String(params.toolCallId || ''));
      case 'respondPermission':
        return this.runtime.respondPermission(
          String(params.agentId || ''),
          String(params.requestId || ''),
          String(params.optionId || ''),
          params.cancelled === true,
        );
      case 'respondElicitation':
        return this.runtime.respondElicitation(
          String(params.agentId || ''),
          String(params.requestId || ''),
          String(params.action || ''),
          params.content,
        );
      case 'authenticate':
        return this.runtime.authenticate(String(params.agentId || ''), String(params.methodId || ''));
      case 'logout':
        return this.runtime.logout(String(params.agentId || ''));
      case 'listSessions':
        return this.runtime.listSessions(String(params.agentId || ''), params.options as UnknownRecord);
      case 'deleteSession':
        return this.runtime.deleteSession(String(params.agentId || ''), String(params.sessionId || ''));
      case 'closeSession':
        return this.runtime.closeSession(String(params.agentId || ''));
      case 'setSessionMode':
        return this.runtime.setSessionMode(String(params.agentId || ''), String(params.modeId || ''));
      case 'setSessionConfigOption':
        return this.runtime.setSessionConfigOption(
          String(params.agentId || ''),
          String(params.configId || ''),
          params.value as never,
        );
      case 'setSessionConfigOptions':
        return this.runtime.setSessionConfigOptions(String(params.agentId || ''), params.changes as never);
      case 'killTerminal':
        return this.runtime.killTerminal(String(params.agentId || ''), String(params.terminalId || ''));
      case 'inputTerminal':
        return this.executeHostMutation(params, () => this.runtime.inputTerminal(
          String(params.agentId || ''),
          String(params.terminalId || ''),
          String(params.input || ''),
        ));
      case 'resizeTerminal':
        return this.runtime.resizeTerminal(
          String(params.agentId || ''),
          String(params.terminalId || ''),
          Number(params.cols),
          Number(params.rows),
        );
      case 'cancelSubagent':
        return this.runtime.cancelSubagent(String(params.agentId || ''), String(params.sessionId || ''));
      case 'decidePatch':
        return this.runtime.decidePatch(
          String(params.agentId || ''),
          String(params.toolCallId || ''),
          String(params.requestedPath || ''),
          params.decision as never,
        );
      case 'forkSession':
        return this.runtime.forkSession(String(params.agentId || ''), params.options as UnknownRecord);
      case 'beginForkReservation':
        return this.beginForkReservation(client, params);
      case 'endForkReservation':
        return this.endForkReservation(client, String(params.token || ''));
      case 'reconnectAgent':
        return this.runtime.reconnectAgent(
          String(params.agentId || ''),
          this.controllerCallbackOptions(client, params.options as UnknownRecord),
        );
      case 'unregisterAgentAndWait':
        return this.service.unregisterAgentAndWait(controller, String(params.agentId || ''));
      case 'shutdownHost':
        setImmediate(() => {
          void this.dispose().finally(() => {
            if (this.exitOnShutdown) process.exit(0);
          });
        });
        return { shuttingDown: true };
      default:
        throw new Error(`Unknown ACP runtime host method: ${method}`);
    }
  }

  send(client: HostClient, message: UnknownRecord): boolean {
    if (client.disconnected || client.socket.destroyed) return false;
    if (client.socket.writableLength > this.maxBufferedBytes) {
      client.socket.destroy(new Error('ACP runtime host client backpressure'));
      return false;
    }
    let serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > this.maxResponseBytes) {
      if (message.id) {
        serialized = JSON.stringify({
          id: message.id,
          ok: false,
          error: { message: 'ACP runtime Host response exceeded the configured limit', code: 'ACP_RUNTIME_HOST_RESPONSE_TOO_LARGE' },
        });
      } else {
        client.socket.destroy(new Error('ACP runtime Host event exceeded the configured limit'));
        return false;
      }
    }
    return client.socket.write(`${serialized}\n`);
  }

  controllerCallbackOptions(client: HostClient, options: UnknownRecord = {}): UnknownRecord {
    const callbackToken = String(options.callbackToken || '');
    if (!callbackToken) return options;
    const callbackNames = new Set(Array.isArray(options.callbackNames)
      ? options.callbackNames.map(value => String(value || ''))
      : []);
    const agentId = String(options.agentId || '');
    const initialBindingEpoch = String(options.capabilityRuntimeEpoch || options.bindingEpoch || '');
    const invoke = (name: string, args: unknown[]) => (
      this.invokeControllerCallback(
        callbackToken,
        agentId,
        String(this.runtime.bindingEpoch(agentId) || initialBindingEpoch),
        name,
        args,
      )
    );
    const sanitized = { ...options };
    delete sanitized.callbackToken;
    delete sanitized.callbackNames;
    return {
      ...sanitized,
      ...(callbackNames.has('onProcessStarted')
        ? { onProcessStarted: (identity: unknown) => invoke('onProcessStarted', [identity]) }
        : {}),
      ...(callbackNames.has('onForkSessionCreated')
        ? { onForkSessionCreated: (sessionId: unknown) => invoke('onForkSessionCreated', [sessionId]) }
        : {}),
      ...(callbackNames.has('refreshMcpServersForRuntime')
        ? {
            refreshMcpServersForRuntime: (mcpServers: unknown) => (
              invoke('refreshMcpServersForRuntime', [mcpServers])
            ),
          }
        : {}),
      ...(callbackNames.has('onProcessStopped')
        ? { onProcessStopped: () => invoke('onProcessStopped', []) }
        : {}),
    };
  }

  invokeControllerCallback(
    callbackToken: string,
    agentId: string,
    bindingEpoch: string,
    name: string,
    args: unknown[],
  ): Promise<unknown> {
    const client = this.activeControllerClient;
    if (!client) {
      const error = new Error('ACP runtime Host has no active Controller for callback') as Error & UnknownRecord;
      error.uncertain = true;
      return Promise.reject(error);
    }
    const controller = this.requireController(client);
    const callbackId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controllerCallbacks.delete(callbackId);
        const error = new Error('ACP runtime Host Controller callback timed out') as Error & UnknownRecord;
        error.uncertain = true;
        reject(error);
      }, 30000);
      timer.unref?.();
      this.controllerCallbacks.set(callbackId, { client, resolve, reject, timer });
      if (!this.send(client, {
        event: 'controller-callback',
        payload: {
          hostEpoch: this.service.state.hostEpoch,
          controllerGeneration: controller.generation,
          agentId,
          bindingEpoch,
          callbackId,
          callbackToken,
          name,
          args,
        },
      })) {
        clearTimeout(timer);
        this.controllerCallbacks.delete(callbackId);
        const error = new Error('ACP runtime Host Controller callback could not be delivered') as Error & UnknownRecord;
        error.uncertain = true;
        reject(error);
      }
    });
  }

  async beginForkReservation(client: HostClient, params: UnknownRecord): Promise<UnknownRecord> {
    const agentId = String(params.agentId || '');
    const token = crypto.randomUUID();
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    let readyResolve!: (value: UnknownRecord) => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<UnknownRecord>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const completion = this.runtime.runWithForkReservation(
      agentId,
      params.options as UnknownRecord,
      async binding => {
        readyResolve({
          token,
          binding: {
            agentId: String(binding.agentId || agentId),
            provider: String(binding.provider || ''),
            sessionId: String(binding.sessionId || ''),
            cwd: String(binding.cwd || ''),
          },
          checkpoint: this.runtime.bindingCheckpoint(binding).exportCheckpoint(),
        });
        await released;
      },
    );
    void completion.catch(readyReject).finally(() => this.forkReservations.delete(token));
    this.forkReservations.set(token, { client, completion, release });
    return ready;
  }

  executeHostMutation(params: UnknownRecord, execute: () => unknown | Promise<unknown>): Promise<unknown> {
    const agentId = String(params.agentId || '');
    const operationId = String(params.operationId || '');
    const bindingEpoch = String(params.bindingEpoch || '');
    const signature = String(params.signature || '');
    if (!agentId || !operationId || !bindingEpoch || !signature) {
      return Promise.reject(new Error('ACP runtime Host mutation identity is required'));
    }
    const key = `${agentId}\0${operationId}`;
    const existing = this.mutationOperations.get(key);
    if (existing) {
      if (existing.bindingEpoch !== bindingEpoch || existing.signature !== signature) {
        return Promise.reject(new Error('ACP runtime Host mutation identity was reused for another operation'));
      }
      return existing.completion;
    }
    const operation: HostMutationOperation = {
      bindingEpoch,
      signature,
      settled: false,
      updatedAt: Date.now(),
      completion: Promise.resolve(),
    };
    const completion = Promise.resolve().then(execute).finally(() => {
      operation.settled = true;
      operation.updatedAt = Date.now();
      const settled = [...this.mutationOperations.entries()]
        .filter(([, candidate]) => candidate.settled)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt);
      for (const [settledKey] of settled.slice(0, Math.max(0, settled.length - 1024))) {
        this.mutationOperations.delete(settledKey);
      }
    });
    operation.completion = completion;
    this.mutationOperations.set(key, operation);
    return completion;
  }

  async endForkReservation(client: HostClient, token: string): Promise<UnknownRecord> {
    const reservation = this.forkReservations.get(token);
    if (!reservation || reservation.client !== client) {
      throw new Error('ACP runtime Host fork reservation is not active');
    }
    reservation.release();
    await reservation.completion;
    this.forkReservations.delete(token);
    return { released: true };
  }

  broadcast(event: string, payload: unknown): void {
    const client = this.activeControllerClient;
    if (!client || !client.controller) return;
    this.send(client, { event, payload });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelIdleExit();
    const server = this.server;
    this.server = null;
    const serverClosed = server
      ? new Promise<void>(resolve => server.close(() => resolve()))
      : Promise.resolve();
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    this.activeControllerClient = null;
    for (const reservation of this.forkReservations.values()) reservation.release();
    this.forkReservations.clear();
    await this.runtime.dispose();
    await serverClosed;
    if (process.platform !== 'win32' && this.boundSocketIdentity) {
      try {
        const stat = await fs.promises.stat(this.socketPath, { bigint: true });
        if (stat.dev === this.boundSocketIdentity.dev && stat.ino === this.boundSocketIdentity.ino) {
          await fs.promises.unlink(this.socketPath);
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      this.boundSocketIdentity = null;
    }
  }
}

async function startAcpRuntimeHostProcess(): Promise<AcpRuntimeHostProcess> {
  const host = new AcpRuntimeHostProcess();
  await host.start();
  process.on('SIGTERM', () => void host.dispose().finally(() => process.exit(0)));
  process.on('SIGINT', () => void host.dispose().finally(() => process.exit(0)));
  return host;
}

if (require.main === module) {
  void startAcpRuntimeHostProcess().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}

export { AcpRuntimeHostProcess, startAcpRuntimeHostProcess };
