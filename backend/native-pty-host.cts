#!/usr/bin/env node

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type {
  NormalizedShellSessionOptions,
  PtyProcess,
  ShellSessionOptions,
} from './local-session-engine.cts';
import type { ServerProcessIdentity } from './server-process-identity.cts';
import {
  TerminalScreenWorkerPool,
  type TerminalScreenWorkerLike as ScreenWorker,
} from './terminal-screen-worker-pool.cjs';
import type { TerminalScreenWorkerState as ScreenState } from './terminal-screen-worker.cjs';
import type { TerminalReducerFlowControl } from './terminal-reducer-flow-control.cjs';
import { TerminalNotificationParser } from './terminal-notification-parser.cjs';

interface RuntimeIdentity {
  buildId?: string;
  protocolVersion?: number;
  version?: string;
}

interface SocketIdentity {
  dev: bigint;
  ino: bigint;
}

interface ControllerIdentity {
  generation: number;
  id: string;
}

interface HostClient {
  [key: symbol]: unknown;
  buffer: string;
  controllerGeneration?: number;
  controllerId?: string;
  disconnected: boolean;
  socket: net.Socket;
}

interface ControllerHandoff {
  fromClient: HostClient | null;
  fromIdentity: ControllerIdentity | null;
  toClient: HostClient | null;
  toIdentity: ControllerIdentity | null;
}

interface SessionMetadata extends Record<string, unknown> {
  agentId?: string;
  category?: string;
  command?: string;
  cwd?: string;
  engineName?: string;
  protocolVersion?: number;
  startedAt?: number;
}

interface TerminalCheckpoint extends ScreenState {
  title: string;
}

interface NativePtySession {
  args: string[];
  command: string;
  cwd?: string;
  exitedAt: number | null;
  exitFinalizationPromise?: Promise<void>;
  exitFinalizing?: boolean;
  finalCheckpoint?: Readonly<TerminalCheckpoint> | null;
  id: string;
  killRequestedAt?: number;
  lastActivityAt: number;
  metadata: SessionMetadata;
  output: string;
  outputSeq: number;
  previewCols: number;
  previewRows: number;
  previewSnapshot: unknown;
  previewText: string;
  process: PtyProcess;
  processIdentity: ServerProcessIdentity | null;
  reducerCommitQueue: Promise<unknown>;
  reducerFlowControl: TerminalReducerFlowControl;
  renderOutput: string;
  rotationFrozen?: boolean;
  runtimeEpoch: string;
  runtimeGeneration: number;
  screenWorker: ScreenWorker | null;
  shellBusyIntegration: unknown;
  shellBusyMarkerPending: string;
  shellCommand: string;
  shellCommandStartedAt: number | null;
  shellCwd: string;
  shellLastCommand: string;
  shellLastCommandDurationMs: number | null;
  shellLastCommandFinishedAt: number | null;
  shellLastCommandStartedAt: number | null;
  shellLastEvent: string;
  shellLastExitCode: number | null;
  startedAt: number;
  stateProofAvailable: boolean;
  stateRevision: number;
  status: string;
  terminalBusy: boolean | null;
  terminalNotificationParser: TerminalNotificationParser;
  title: string;
}

interface ReviveEvent {
  cols?: number;
  data?: string;
  rows?: number;
}

interface ReviveState {
  replayEvent?: {
    events?: ReviveEvent[];
  };
}

interface NativeSessionCreateOptions extends ShellSessionOptions {
  metadata?: SessionMetadata;
  reviveState?: unknown;
  shellIntegrationPrepared?: boolean;
}

interface NormalizedNativeSessionOptions extends NormalizedShellSessionOptions {
  metadata?: SessionMetadata;
}

interface ShellBusyState {
  busyMarkerSeen: boolean;
  commandTextSeen: boolean;
  cwd: string;
  data: string;
  exitCodeSeen: boolean;
  lastExitCode: number | null;
  markerSeen: boolean;
  pending: string;
  shellCommand: string;
  shellEvent: string;
  statusMarkerSeen: boolean;
  terminalBusy: boolean | null;
}

interface RotationPreparation {
  controllerClient: HostClient | null;
  phase: string;
  promise: Promise<SerializedTerminalPreparation> | null;
  serializedTerminalState: string;
  token: string;
}

interface SerializedTerminalPreparation {
  preparationToken: string;
  serializedTerminalState: string;
}

interface NativePtyHostOptions {
  clientMaxBufferedBytes?: unknown;
  clientMaxRequestBytes?: unknown;
  configDir?: string;
  exitOnShutdown?: boolean;
  idleExitMs?: unknown;
  ownerPid?: unknown;
  runtimeIdentity?: RuntimeIdentity;
  socketPath?: string;
  terminalExitDataFlushMs?: number;
}

interface ProtocolMessage {
  id?: unknown;
  method?: unknown;
  params?: ProtocolParams;
}

interface ProtocolParams extends Record<string, unknown> {
  cols?: unknown;
  controller?: Record<string, unknown>;
  expectedRuntimeEpoch?: string;
  identity?: Record<string, unknown>;
  input?: unknown;
  options?: NativeSessionCreateOptions;
  patch?: Record<string, unknown>;
  preparationToken?: string;
  rows?: unknown;
  sessionId?: string;
}

interface ControllerAdmission {
  [key: symbol]: unknown;
  client: HostClient;
  controllerGeneration?: number;
  controllerId?: string;
}

type ControllerAuthority = ControllerAdmission | HostClient;

interface ReducerDelivery {
  bytes: number;
  error: Error | null;
}

import * as nativePtyHostPathModule from './native-pty-host-path.cjs';
const {
  nativePtyHostPrivateSocketPath,
  nativePtyHostSocketPath,
  publishNativePtyHostSocket,
} = nativePtyHostPathModule;
import * as inputPartsModule from './input-parts.cjs';
const { terminalInputToPtyString } = inputPartsModule;
import * as agentEnvModule from './agent-env.cjs';
const { normalizeInteractiveTerminalEnv } = agentEnvModule;
import * as shellBusyIntegrationModule from './shell-busy-integration.cjs';
const {
  cleanupShellBusyIntegration,
  parseShellBusyMarkers,
} = shellBusyIntegrationModule;
import * as localSessionEngineModule from './local-session-engine.cjs';
const {
  extractLatestTerminalTitle,
  normalizeShellSessionOptions,
  createPtyProcess,
} = localSessionEngineModule;
import * as terminalStatusModule from './terminal-status.cjs';
const { deriveTerminalStatus } = terminalStatusModule;
import * as terminalRuntimeCleanupModule from './terminal-runtime-cleanup.cjs';
const { probeUnixSocket } = terminalRuntimeCleanupModule;
import * as nativePtyHostIdentityModule from './native-pty-host-identity.cjs';
import {
  killOwnedProcessGroup,
  registerConfigProcessGroup,
  unregisterConfigProcessGroup,
} from './config-process-ownership.cjs';
import { configInstanceFingerprint } from './config-instance.cjs';
import { readServerProcessIdentity } from './server-process-identity.cjs';
const { nativePtyHostRuntimeIdentity } = nativePtyHostIdentityModule;
import * as runtimeGenerationModule from './native-pty-controller-generation.cjs';
const {
  allocateNativePtyRuntimeGeneration,
  formatNativePtyRuntimeEpoch,
} = runtimeGenerationModule;
import * as reducerFlowControlModule from './terminal-reducer-flow-control.cjs';
const {
  acknowledgeTerminalReducerData,
  createTerminalReducerFlowControl,
  ensureTerminalReducerFlowControl,
  enqueueTerminalReducerData,
  resetTerminalReducerFlowControl,
  setTerminalExternalFlowControlBlocked,
} = reducerFlowControlModule;
import * as terminalStateSerializationModule from './terminal-state-serialization.cjs';
const {
  normalizeTerminalStateEntry,
  serializeTerminalState,
} = terminalStateSerializationModule;
import * as terminalAttachCheckpointModule from './terminal-attach-checkpoint.cjs';
const { captureTerminalAttachCheckpoint } = terminalAttachCheckpointModule;
import * as terminalExitQuiescenceModule from './terminal-exit-quiescence.cjs';
const {
  acceptTerminalExitData,
  waitForTerminalExitDataQuiescence,
} = terminalExitQuiescenceModule;

const OUTPUT_LIMIT = 10000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 30;
const OWNER_CHECK_INTERVAL_MS = 1000;
const DEFAULT_IDLE_EXIT_MS = 60000;
const DEFAULT_CLIENT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const DEFAULT_CLIENT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const HOST_RUNTIME_IDENTITY = nativePtyHostRuntimeIdentity();
const CONTROLLER_MUTATION_ADMISSION = Symbol('controllerMutationAdmission');
const TERMINAL_HISTORY_RESTORED_MESSAGE = '\r\n\x1b[7m History restored \x1b[0m\r\n';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message || '');
  }
  return '';
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code || '')
    : '';
}

function isControllerAdmission(value: ControllerAuthority): value is ControllerAdmission {
  return CONTROLLER_MUTATION_ADMISSION in value
    && value[CONTROLLER_MUTATION_ADMISSION] === true;
}

function trimOutput(output: unknown): string {
  const text = typeof output === 'string' ? output : '';
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sanitizeAgentEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const next = { ...(env || process.env) };
  return normalizeInteractiveTerminalEnv(next, {
    stripRuntimeShims: false,
    stripNodeOptions: false,
  });
}

function socketIdentity(socketPath: string): SocketIdentity {
  const stat = fs.statSync(socketPath, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

function sameSocketIdentity(
  left: SocketIdentity | null,
  right: SocketIdentity | null,
): boolean {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

class NativePtyHost {
  configDir: string;
  socketPath: string;
  ownerPid: number;
  runtimeIdentity: RuntimeIdentity;
  exitOnShutdown: boolean;
  boundSocketPath: string;
  boundSocketIdentity: SocketIdentity | null;
  sessions: Map<string, NativePtySession>;
  clients: Set<HostClient>;
  ownerCheckTimer: NodeJS.Timeout | null;
  idleExitTimer: NodeJS.Timeout | null;
  hasAcceptedClient: boolean;
  activeControllerClient: HostClient | null;
  activeControllerIdentity: ControllerIdentity | null;
  sessionMutationQueues: Map<string, Promise<unknown>>;
  activeControllerMutations: Set<Promise<unknown>>;
  controllerRegistrationQueue: Promise<unknown>;
  controllerHandoff: ControllerHandoff | null;
  rotationPreparation: RotationPreparation | null;
  terminalExitDataFlushMs: number | undefined;
  clientMaxBufferedBytes: number;
  clientMaxRequestBytes: number;
  idleExitMs: number;
  disposed: boolean;
  screenWorkerPool: TerminalScreenWorkerPool;
  server: net.Server | null | undefined;

  constructor(options: NativePtyHostOptions = {}) {
    this.configDir = options.configDir || process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming');
    this.socketPath = options.socketPath || process.env.FARMING_NATIVE_PTY_HOST_SOCKET || nativePtyHostSocketPath(this.configDir);
    this.ownerPid = Number(options.ownerPid || process.env.FARMING_NATIVE_PTY_HOST_OWNER_PID || 0);
    this.runtimeIdentity = options.runtimeIdentity || HOST_RUNTIME_IDENTITY;
    this.exitOnShutdown = options.exitOnShutdown !== false;
    this.boundSocketPath = process.platform === 'win32'
      ? this.socketPath
      : nativePtyHostPrivateSocketPath(this.socketPath);
    this.boundSocketIdentity = null;
    this.sessions = new Map();
    this.clients = new Set();
    this.ownerCheckTimer = null;
    this.idleExitTimer = null;
    this.hasAcceptedClient = false;
    this.activeControllerClient = null;
    this.activeControllerIdentity = null;
    this.sessionMutationQueues = new Map();
    this.activeControllerMutations = new Set();
    this.controllerRegistrationQueue = Promise.resolve();
    this.controllerHandoff = null;
    this.rotationPreparation = null;
    this.terminalExitDataFlushMs = options.terminalExitDataFlushMs;
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

  async start(): Promise<void> {
    await this.prepareSocket();
    const server = net.createServer(socket => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.boundSocketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') {
      this.boundSocketIdentity = socketIdentity(this.boundSocketPath);
      fs.chmodSync(this.boundSocketPath, 0o600);
      try {
        publishNativePtyHostSocket(this.boundSocketPath, this.socketPath);
      } catch (error) {
        await new Promise<void>(resolve => this.server?.close(() => resolve()));
        this.server = null;
        this.boundSocketIdentity = null;
        throw error;
      }
    }
    console.error(`[${new Date().toISOString()}] Native PTY host listening on ${this.socketPath} ownerPid=${this.ownerPid || ''}`);
    this.startOwnerWatch();
  }

  startOwnerWatch(): void {
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

  async prepareSocket(): Promise<void> {
    if (process.platform === 'win32') return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    if (fs.existsSync(this.socketPath)) {
      const probe = await probeUnixSocket(this.socketPath);
      if (probe.active) {
        const error = new Error(`Native PTY host socket is already active: ${this.socketPath}`) as Error & {
          code?: string;
          socketPath?: string;
        };
        error.code = 'EADDRINUSE';
        error.socketPath = this.socketPath;
        throw error;
      }
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    try {
      fs.unlinkSync(this.boundSocketPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  handleConnection(socket: net.Socket): void {
    const client: HostClient = { socket, buffer: '', disconnected: false };
    this.hasAcceptedClient = true;
    this.cancelIdleExit();
    this.clients.add(client);
    socket.on('data', chunk => this.handleClientData(client, chunk));
    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));
  }

  removeClient(client: HostClient | null | undefined): Promise<unknown> {
    if (!client || client.disconnected === true) return Promise.resolve();
    client.disconnected = true;
    this.clients.delete(client);
    let retirement = Promise.resolve();
    if (
      this.activeControllerClient === client
      || this.controllerHandoff?.fromClient === client
      || this.controllerHandoff?.toClient === client
    ) {
      retirement = this.controllerRegistrationQueue
        .catch(() => {})
        .then(() => this.retireControllerClient(client));
      this.controllerRegistrationQueue = retirement;
    }
    this.scheduleIdleExitIfUnused();
    return retirement;
  }

  async retireControllerClient(client: HostClient): Promise<void> {
    if (this.activeControllerClient !== client) return;
    const handoff = {
      fromClient: client,
      fromIdentity: this.activeControllerIdentity,
      toClient: null,
      toIdentity: null,
    };
    this.controllerHandoff = handoff;
    try {
      // A disconnect closes admission immediately, but an operation that was
      // already admitted owns its linearization point until it completes.
      // Retire the server client only after that exact set has drained.
      await Promise.allSettled([...this.activeControllerMutations]);
      if (this.activeControllerClient !== client) return;
      this.activeControllerClient = null;
    } finally {
      if (this.controllerHandoff === handoff) this.controllerHandoff = null;
    }
  }

  hasLiveSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (session && session.status !== 'exited') return true;
    }
    return false;
  }

  cancelIdleExit(): void {
    if (!this.idleExitTimer) return;
    clearTimeout(this.idleExitTimer);
    this.idleExitTimer = null;
  }

  scheduleIdleExitIfUnused(): void {
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

  handleClientData(client: HostClient, chunk: Buffer | string): void {
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

  async handleClientMessage(client: HostClient, line: string): Promise<void> {
    let message: ProtocolMessage;
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
        error: errorMessage(error) || 'Native pty host request failed',
      });
    }
  }

  dispatch(
    method: unknown,
    params: ProtocolParams,
    client: HostClient,
  ): unknown {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    switch (method) {
      case 'ping':
        return {
          ok: true,
          pid: process.pid,
          configInstanceFingerprint: configInstanceFingerprint(this.configDir),
          privateSocketPath: process.platform === 'win32' ? '' : this.boundSocketPath,
          runtimeIdentity: this.runtimeIdentity,
        };
      case 'registerController':
        return this.registerController(client, params.identity || {});
      case 'createSession':
        return this.enqueueControllerMutation(
          params.options?.agentId,
          client,
          () => this.createSession(params.options || { agentId: '', command: '' }),
        );
      case 'sendInput':
        return this.enqueueControllerMutation(
          sessionId,
          client,
          () => this.sendInput(sessionId, params.input, params.expectedRuntimeEpoch || ''),
        );
      case 'resizeSession':
        return this.enqueueControllerMutation(
          sessionId,
          client,
          () => this.resizeSession(sessionId, params.cols, params.rows),
        );
      case 'clearBuffer':
        return this.enqueueControllerMutation(
          sessionId,
          client,
          () => this.clearBuffer(sessionId, params.expectedRuntimeEpoch || ''),
        );
      case 'killSession':
        return this.enqueueControllerMutation(
          sessionId,
          client,
          () => this.killSession(sessionId),
        );
      case 'getSessionState':
        return this.getSessionState(sessionId);
      case 'getSessionAttachCheckpoint':
        return this.getSessionAttachCheckpoint(sessionId, client);
      case 'getSessionPreview':
        return this.getSessionPreview(sessionId);
      case 'recoverSessions':
        return this.recoverSessions();
      case 'serializeTerminalState':
        return this.serializeTerminalState(client);
      case 'resumeTerminalState':
        return this.resumeTerminalState(client, params.preparationToken || '');
      case 'updateSessionMetadata':
        return this.enqueueControllerMutation(
          sessionId,
          client,
          () => this.updateSessionMetadata(sessionId, params.patch || {}),
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

  enqueueControllerMutation(
    sessionId: unknown,
    client: HostClient,
    operation: (admission: ControllerAdmission) => unknown | PromiseLike<unknown>,
  ): Promise<unknown> {
    // Admission is fenced before queueing. Once a newer controller starts its
    // handoff, no additional work from the retiring controller may enter the
    // mutation set; work admitted before that cut is allowed to finish.
    try {
      this.assertActiveController(client);
      if (this.controllerHandoff) {
        throw new Error('Native pty controller handoff is in progress');
      }
      if (this.rotationPreparation) {
        throw new Error('Native pty host is frozen for runtime rotation');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const admission: ControllerAdmission = Object.freeze({
      [CONTROLLER_MUTATION_ADMISSION]: true,
      client,
      controllerId: client.controllerId,
      controllerGeneration: client.controllerGeneration,
    });
    const key = typeof sessionId === 'string' && sessionId ? sessionId : '__host__';
    const previous = this.sessionMutationQueues.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        if (this.rotationPreparation) {
          throw new Error('Native pty host is frozen for runtime rotation');
        }
        return operation(admission);
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

  send(client: HostClient, message: Record<string, unknown>): void {
    this.writeClientMessage(client, `${JSON.stringify(message)}\n`);
  }

  disconnectSlowClient(
    client: HostClient | null | undefined,
    reason: string,
  ): boolean {
    if (!client || !client.socket || client.socket.destroyed) return false;
    client.socket.destroy(new Error(reason));
    return true;
  }

  writeClientMessage(
    client: HostClient | null | undefined,
    message: string,
  ): boolean {
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

  broadcast(event: string, payload: unknown): void {
    const message = `${JSON.stringify({ event, payload })}\n`;
    for (const client of this.clients) {
      this.writeClientMessage(client, message);
    }
  }

  emitSessionEvent(event: string, payload: unknown): void {
    this.broadcast(event, payload);
  }

  registerController(
    client: HostClient,
    rawIdentity: Record<string, unknown>,
  ): Promise<unknown> {
    if (!client || client.disconnected === true) {
      throw new Error('Native pty controller client is disconnected');
    }
    const identity = {
      id: typeof rawIdentity.id === 'string' ? rawIdentity.id : '',
      generation: Math.floor(Number(rawIdentity.generation)),
    };
    if (!identity.id || !Number.isFinite(identity.generation) || identity.generation <= 0) {
      throw new Error('Invalid native pty controller identity');
    }

    const registration = this.controllerRegistrationQueue
      .catch(() => {})
      .then(async () => {
        const current = this.activeControllerIdentity;
        if (
          current &&
          (identity.generation < current.generation ||
            (identity.generation === current.generation && current.id !== identity.id))
        ) {
          throw new Error('Stale native pty controller');
        }

        const replacesController = !current
          || current.id !== identity.id
          || current.generation !== identity.generation
          || this.activeControllerClient !== client;
        if (replacesController && current) {
          const handoff = {
            fromClient: this.activeControllerClient,
            fromIdentity: current,
            toClient: client,
            toIdentity: identity,
          };
          this.controllerHandoff = handoff;
          try {
            // New admissions from the retiring controller are now closed.
            // Drain the exact set admitted before that cut before publishing
            // the new generation as active.
            await Promise.allSettled([...this.activeControllerMutations]);
          } finally {
            if (this.controllerHandoff === handoff) this.controllerHandoff = null;
          }
        }

        if (client.disconnected === true) {
          throw new Error('Native pty controller client is disconnected');
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
      });
    this.controllerRegistrationQueue = registration;
    return registration;
  }

  assertActiveController(client: ControllerAuthority | null): void {
    if (client && isControllerAdmission(client)) return;
    if (
      !client ||
      client.disconnected === true ||
      client !== this.activeControllerClient ||
      !this.activeControllerIdentity ||
      client.controllerId !== this.activeControllerIdentity.id ||
      client.controllerGeneration !== this.activeControllerIdentity.generation
    ) {
      throw new Error(
        'Native PTY control moved to another Farming Server; stop duplicate Servers and restart this Farming instance',
      );
    }
  }

  async createSession(
    options: NativeSessionCreateOptions,
  ): Promise<{ sessionId: string; status: string }> {
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
    let restoredScreenState: ScreenState | null = null;
    if (restoredOutput) {
      try {
        await screenWorker.append(restoredOutput, 1, 1);
        restoredScreenState = await screenWorker.getState();
      } catch (error) {
        await screenWorker.dispose().catch(() => {});
        throw new Error(`Failed to restore serialized terminal history: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    }
    const persistedCommand = normalized.metadata?.command;
    const persistedStartedAt = normalized.metadata?.startedAt;
    const metadata: SessionMetadata = {
      ...(normalized.metadata || {}),
      protocolVersion: 1,
      engineName: 'native',
      agentId,
      command: typeof persistedCommand === 'string' && persistedCommand
        ? persistedCommand
        : normalized.command,
      cwd: normalized.cwd || process.cwd(),
      startedAt: typeof persistedStartedAt === 'number' && Number.isFinite(persistedStartedAt)
        ? persistedStartedAt
        : Date.now(),
    };

    let ptyProcess: PtyProcess;
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

    const session: NativePtySession = {
      id: agentId,
      command: normalized.command,
      args: normalized.args || [],
      cwd: normalized.cwd,
      metadata,
      process: ptyProcess,
      processIdentity: null,
      output: trimOutput(restoredOutput),
      outputSeq: restoredOutput ? 1 : 0,
      stateRevision: restoredOutput ? 1 : 0,
      runtimeEpoch,
      runtimeGeneration,
      stateProofAvailable: true,
      reducerFlowControl: createTerminalReducerFlowControl(),
      reducerCommitQueue: Promise.resolve(),
      renderOutput: restoredScreenState?.renderOutput || restoredOutput,
      previewText: restoredScreenState?.previewText || restoredOutput,
      previewSnapshot: restoredScreenState?.previewSnapshot || null,
      previewCols: restoredScreenState?.cols || cols,
      previewRows: restoredScreenState?.rows || rows,
      title: restoredScreenState?.title || '',
      status: 'running',
      terminalBusy: null,
      terminalNotificationParser: new TerminalNotificationParser(),
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

    if (ptyProcess.pid && process.platform !== 'win32') {
      const processIdentity = readServerProcessIdentity(ptyProcess.pid);
      if (!processIdentity || processIdentity.processGroupId !== ptyProcess.pid) {
        try {
          ptyProcess.kill('SIGKILL');
        } catch {
          // The process may already have exited while ownership was being verified.
        }
        cleanupShellBusyIntegration(normalized.shellBusyIntegration);
        await screenWorker.dispose().catch(() => {});
        throw new Error('Terminal process could not publish its exact process-group ownership');
      }
      session.processIdentity = processIdentity;
      registerConfigProcessGroup(this.configDir, 'terminal', processIdentity);
    }

    this.sessions.set(agentId, session);
    this.bindScreenWorker(session);
    this.bindPty(session);
    this.emitSessionEvent('session-started', {
      sessionId: agentId,
      status: session.status,
      startedAt: session.startedAt,
      runtimeEpoch: session.runtimeEpoch,
      outputSeq: session.outputSeq,
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

  bindScreenWorker(session: NativePtySession): void {
    const screenWorker = session.screenWorker;
    if (!screenWorker) throw new TypeError('Terminal screen worker is unavailable');
    screenWorker.on('preview', ({ previewText, title, cols, rows, previewSnapshot }) => {
      const current = this.sessions.get(session.id);
      if (current !== session) return;

      current.previewText = previewText || '';
      current.previewSnapshot = previewSnapshot || null;
      current.previewCols = cols || current.previewCols;
      current.previewRows = rows || current.previewRows;

      if (title && title !== current.title) {
        current.title = title;
        this.emitSessionEvent('session-title', {
          sessionId: current.id,
          title: current.title,
          runtimeEpoch: current.runtimeEpoch,
        });
      }

      this.emitSessionEvent('session-preview', {
        sessionId: current.id,
        previewText: current.previewText,
        cols: current.previewCols,
        rows: current.previewRows,
        previewSnapshot: current.previewSnapshot,
        runtimeEpoch: current.runtimeEpoch,
      });
    });

    screenWorker.on('error', error => {
      this.failSessionScreenState(session, error);
    });
  }

  failSessionScreenState(session: NativePtySession, error: unknown): void {
    const current = this.sessions.get(session.id);
    if (current !== session || current.stateProofAvailable === false) return;
    current.stateProofAvailable = false;
    const message = error instanceof Error ? error.message : String(error || 'unknown reducer failure');
    this.emitSessionEvent('session-error', {
      sessionId: current.id,
      error: `Terminal state reducer failed: ${message}`,
      fatal: true,
      runtimeEpoch: current.runtimeEpoch,
    });
    try {
      current.process?.kill();
    } catch {
      // The session is already unusable because its authoritative reducer failed.
    }
  }

  bindPty(session: NativePtySession): void {
    session.process.onData(data => this.handleSessionData(session.id, data, session));
    session.process.onExit(({ code }) => {
      this.handleSessionExit(session.id, code, session).catch(error => {
        if (this.sessions.get(session.id) !== session) return;
        this.emitSessionEvent('session-error', {
          sessionId: session.id,
          error: error.message,
          fatal: false,
          runtimeEpoch: session.runtimeEpoch,
        });
      });
    });
  }

  handleSessionData(
    sessionId: string,
    rawData: string,
    expectedSession: NativePtySession | null = null,
  ): void {
    const current = this.sessions.get(sessionId);
    if (
      !current ||
      (expectedSession && current !== expectedSession) ||
      current.stateProofAvailable === false
    ) return;
    if (!acceptTerminalExitData(current)) {
      current.finalCheckpoint = null;
      this.failSessionScreenState(current, new Error('PTY emitted data after its final checkpoint cut'));
      return;
    }

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
        runtimeEpoch: current.runtimeEpoch,
      });
    }

    const data = busyState.data;
    if (!data) return;
    const terminalNotifications = current.terminalNotificationParser.push(data);

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
        runtimeEpoch: current.runtimeEpoch,
      });
    }

    if (current.screenWorker) {
      const commit = current.screenWorker.append(data, stateRevision, outputSeq);
      current.reducerCommitQueue = current.reducerCommitQueue.then(() => commit).then(() => {
        const latest = this.sessions.get(sessionId);
        if (latest !== current || latest.stateProofAvailable === false) return;
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
        terminalNotifications.forEach(notification => {
          this.emitSessionEvent('session-notification', {
            sessionId,
            ...notification,
            runtimeEpoch: latest.runtimeEpoch,
            outputSeq,
          });
        });
        this.emitSessionEvent('session-activity', {
          sessionId,
          lastActivityAt: latest.lastActivityAt,
          runtimeEpoch: latest.runtimeEpoch,
        });
      }).catch(error => this.failSessionScreenState(current, error));
    }
  }

  handleSessionExit(
    sessionId: string,
    code: number,
    expectedSession: NativePtySession | null = null,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      (expectedSession && session !== expectedSession) ||
      session.status === 'exited'
    ) return Promise.resolve();
    if (session.exitFinalizationPromise) return session.exitFinalizationPromise;
    if (session.processIdentity) {
      const cleanup = killOwnedProcessGroup(session.processIdentity);
      if (!cleanup.identityMismatch && !cleanup.identityUnavailable) {
        unregisterConfigProcessGroup(this.configDir, 'terminal', session.processIdentity);
      }
    }
    const finalization = this.finalizeSessionExit(sessionId, code, session);
    session.exitFinalizationPromise = finalization;
    return finalization;
  }

  async finalizeSessionExit(
    sessionId: string,
    code: number,
    session: NativePtySession,
  ): Promise<void> {
    const quiesced = await waitForTerminalExitDataQuiescence(session, {
      flushMs: this.terminalExitDataFlushMs,
      isCurrent: () => this.sessions.get(sessionId) === session,
    });
    if (!quiesced) return;

    await Promise.resolve(session.reducerCommitQueue).catch(() => {});
    if (this.sessions.get(sessionId) !== session) return;
    const finalCheckpoint = await captureTerminalAttachCheckpoint(session, { requireCurrentCut: true });
    if (this.sessions.get(sessionId) !== session) return;
    if (finalCheckpoint) {
      session.finalCheckpoint = Object.freeze({ ...finalCheckpoint });
      session.renderOutput = finalCheckpoint.renderOutput;
      session.previewText = finalCheckpoint.previewText;
      session.previewSnapshot = finalCheckpoint.previewSnapshot;
      session.previewCols = finalCheckpoint.cols;
      session.previewRows = finalCheckpoint.rows;
      session.title = finalCheckpoint.title || session.title;
    } else {
      this.failSessionScreenState(session, new Error('Unable to capture the exact final Terminal checkpoint'));
    }

    session.status = 'exited';
    session.exitedAt = Date.now();
    resetTerminalReducerFlowControl(
      ensureTerminalReducerFlowControl(session),
      session.process,
    );
    cleanupShellBusyIntegration(session.shellBusyIntegration);
    if (session.screenWorker) {
      await session.screenWorker.dispose().catch(() => {});
      session.screenWorker = null;
    }

    this.emitSessionEvent('session-exited', {
      sessionId,
      code: code == null ? 'unknown' : code,
      exitedAt: session.exitedAt,
      runtimeEpoch: session.runtimeEpoch,
      outputSeq: session.outputSeq,
      stateRevision: session.stateRevision,
      stateProofAvailable: session.stateProofAvailable !== false,
    });
    if (finalCheckpoint) {
      this.emitSessionEvent('session-preview', {
        sessionId,
        previewText: session.previewText,
        cols: session.previewCols,
        rows: session.previewRows,
        previewSnapshot: session.previewSnapshot,
        runtimeEpoch: session.runtimeEpoch,
      });
    }
    this.scheduleIdleExitIfUnused();
  }

  async sendInput(
    sessionId: string,
    input: unknown,
    expectedRuntimeEpoch = '',
  ): Promise<Record<string, unknown>> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process || session.status === 'exited' || session.exitFinalizing === true) {
      throw new Error('Session not available');
    }
    if (session.rotationFrozen === true) {
      throw new Error('Terminal session is frozen for native PTY host rotation');
    }
    if (expectedRuntimeEpoch && expectedRuntimeEpoch !== session.runtimeEpoch) {
      return { status: 'input-rejected', reason: 'runtime-epoch-mismatch' };
    }
    session.process.write(terminalInputToPtyString(input));
    session.lastActivityAt = Date.now();
    this.emitSessionEvent('session-activity', {
      sessionId,
      lastActivityAt: session.lastActivityAt,
      runtimeEpoch: session.runtimeEpoch,
    });
    return { sent: true };
  }

  async getSessionAttachCheckpoint(
    sessionId: string,
    client: HostClient | null,
  ): Promise<TerminalCheckpoint | null> {
    this.assertActiveController(client);
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const checkpoint = await captureTerminalAttachCheckpoint(session);
    return this.sessions.get(sessionId) === session ? checkpoint : null;
  }

  async resizeSession(
    sessionId: string,
    cols: unknown,
    rows: unknown,
  ): Promise<Record<string, unknown>> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process || session.status === 'exited' || session.exitFinalizing === true) {
      return { status: 'resize-rejected', reason: 'session-unavailable', resized: false };
    }
    if (session.rotationFrozen === true) {
      return { status: 'resize-rejected', reason: 'runtime-rotation', resized: false };
    }

    const nextCols = normalizePositiveInteger(cols, session.previewCols || DEFAULT_COLS, 1, 1000);
    const nextRows = normalizePositiveInteger(rows, session.previewRows || DEFAULT_ROWS, 1, 1000);
    if (nextCols === session.previewCols && nextRows === session.previewRows) {
      return {
        status: 'resize-committed',
        resized: true,
        unchanged: true,
      };
    }

    const resize = session.process.resize;
    if (!resize) {
      return { status: 'resize-rejected', reason: 'session-unavailable', resized: false };
    }
    try {
      resize.call(session.process, nextCols, nextRows);
    } catch (error) {
      return {
        status: 'resize-rejected',
        reason: 'pty-resize-failed',
        resized: false,
        error: error instanceof Error ? error.message : String(error || 'unknown PTY resize failure'),
      };
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
        if (this.sessions.get(sessionId) !== session) {
          throw new Error('Terminal session was replaced during resize');
        }
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
        return { status: 'resize-rejected', reason: 'screen-reducer-failed', resized: false };
      }
    }
    if (this.sessions.get(sessionId) !== session) {
      return { status: 'resize-rejected', reason: 'session-replaced', resized: false };
    }

    return {
      status: 'resize-committed',
      resized: true,
      unchanged: false,
      runtimeEpoch,
      outputSeq,
      stateRevision,
      cols: nextCols,
      rows: nextRows,
    };
  }

  async clearBuffer(
    sessionId: string,
    expectedRuntimeEpoch = '',
  ): Promise<Record<string, unknown>> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'exited' || session.exitFinalizing === true) {
      return { cleared: false };
    }
    if (session.rotationFrozen === true) {
      return { cleared: false, reason: 'runtime-rotation' };
    }
    if (expectedRuntimeEpoch && expectedRuntimeEpoch !== session.runtimeEpoch) {
      return { cleared: false, reason: 'runtime-epoch-mismatch' };
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
        if (this.sessions.get(sessionId) !== session) {
          throw new Error('Terminal session was replaced during clear');
        }
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
          this.emitSessionEvent('session-title', {
            sessionId,
            title: session.title,
            runtimeEpoch: session.runtimeEpoch,
          });
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
    if (this.sessions.get(sessionId) !== session) return { cleared: false, reason: 'session-replaced' };
    this.emitSessionEvent('session-preview', {
      sessionId,
      previewText: session.previewText,
      cols: session.previewCols,
      rows: session.previewRows,
      previewSnapshot: session.previewSnapshot,
      title: session.title,
      runtimeEpoch: session.runtimeEpoch,
    });
    this.emitSessionEvent('session-activity', {
      sessionId,
      lastActivityAt: session.lastActivityAt,
      runtimeEpoch: session.runtimeEpoch,
    });
    return {
      cleared: true,
      runtimeEpoch: exactState.runtimeEpoch,
      outputSeq: exactState.outputSeq,
      stateRevision: exactState.stateRevision,
      cols: exactState.cols,
      rows: exactState.rows,
    };
  }

  async killSession(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process) return { killed: false };
    if (session.status === 'exited') return { killed: false };
    session.status = 'stopping';
    session.killRequestedAt = Date.now();
    if (session.processIdentity) {
      const cleanup = killOwnedProcessGroup(session.processIdentity);
      if (cleanup.identityMismatch || cleanup.identityUnavailable) {
        session.status = 'running';
        throw new Error('Terminal process-group ownership changed; refusing to signal it');
      }
    } else {
      session.process.kill('SIGKILL');
    }
    return { killed: true };
  }

  async getSessionState(sessionId: string): Promise<Record<string, unknown> | null> {
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
    const stateProofAvailable = session.stateProofAvailable !== false;
    const checkpoint = stateProofAvailable ? await captureTerminalAttachCheckpoint(session) : null;
    if (this.sessions.get(sessionId) !== session) return null;
    const title = checkpoint ? checkpoint.title : fallbackTitle;
    const previewText = checkpoint ? checkpoint.previewText : (stateProofAvailable ? fallbackPreviewText : '');

    return {
      sessionId: session.id,
      status: session.status,
      runtimeEpoch: session.runtimeEpoch,
      output: snapshotOutput,
      outputSeq: checkpoint?.outputSeq ?? null,
      stateRevision: checkpoint?.stateRevision ?? null,
      stateProofAvailable,
      renderOutput: checkpoint ? checkpoint.renderOutput : (stateProofAvailable ? snapshotOutput : ''),
      previewText,
      previewSnapshot: checkpoint ? checkpoint.previewSnapshot : (stateProofAvailable ? fallbackPreviewSnapshot : null),
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

  async getSessionPreview(sessionId: string): Promise<string> {
    const state = await this.getSessionState(sessionId);
    return state && typeof state.previewText === 'string' ? state.previewText : '';
  }

  async recoverSessions(): Promise<Record<string, unknown>[]> {
    const recovered: Record<string, unknown>[] = [];
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

  serializeTerminalState(
    client: HostClient | null = null,
  ): Promise<SerializedTerminalPreparation> | null {
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

    const preparation: RotationPreparation = {
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

  async prepareSerializedTerminalState(
    preparation: RotationPreparation,
  ): Promise<SerializedTerminalPreparation> {
    const entries: unknown[] = [];
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

  resumeTerminalState(
    client: HostClient | null = null,
    preparationToken = '',
  ): { resumed: number } {
    if (client) this.assertActiveController(client);
    return this.resumePreparedTerminalState(preparationToken);
  }

  resumePreparedTerminalState(preparationToken = ''): { resumed: number } {
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

  async updateSessionMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<SessionMetadata | null> {
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

  shutdownHost(
    client: HostClient | null,
    rawIdentity: Record<string, unknown> = {},
    preparationToken = '',
  ): { shuttingDown: true } {
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

  async disposeSessionProcess(
    session: NativePtySession | null | undefined,
  ): Promise<void> {
    if (!session || !session.process || session.status === 'exited') return;
    session.status = 'stopping';
    if (session.processIdentity) {
      const cleanup = killOwnedProcessGroup(session.processIdentity);
      if (cleanup.identityMismatch || cleanup.identityUnavailable) {
        throw new Error('Terminal process-group ownership changed; refusing to signal it');
      }
    } else {
      try {
        session.process.kill('SIGKILL');
      } catch {
        // ignore dispose races
      }
    }
  }

  async dispose(): Promise<void> {
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
    if (this.server && process.platform !== 'win32') {
      try {
        const currentSocketIdentity = socketIdentity(this.socketPath);
        if (sameSocketIdentity(currentSocketIdentity, this.boundSocketIdentity)) {
          // Unlink while this listener is still active. A competing host cannot
          // replace an active socket between the ownership check and unlink.
          fs.unlinkSync(this.socketPath);
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      this.boundSocketIdentity = null;
    }
    if (this.server) {
      await new Promise<void>(resolve => this.server?.close(() => resolve()));
      this.server = null;
    }
  }
}

function startNativePtyHostProcess(): NativePtyHost {
  const host = new NativePtyHost();
  const processIdentity = process.platform === 'win32' ? null : readServerProcessIdentity(process.pid);
  if (process.platform === 'win32') {
    host.start().catch(error => {
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    });
    process.on('SIGTERM', () => { host.dispose().finally(() => process.exit(0)); });
    process.on('SIGINT', () => { host.dispose().finally(() => process.exit(0)); });
    return host;
  }
  if (!processIdentity) {
    throw new Error('Native PTY Host could not publish its exact process ownership');
  }
  registerConfigProcessGroup(host.configDir, 'native-pty-host', processIdentity);
  const dispose = host.dispose.bind(host);
  host.dispose = async () => {
    try {
      await dispose();
    } finally {
      unregisterConfigProcessGroup(host.configDir, 'native-pty-host', processIdentity);
    }
  };
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

export {
  NativePtyHost,
  startNativePtyHostProcess,
};
export type {
  HostClient,
  NativePtyHostOptions,
  NativePtySession,
  RuntimeIdentity,
};
