const { EventEmitter } = require('events') as typeof import('events');
const { spawn } = require('child_process') as typeof import('child_process');
const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const net = require('net') as typeof import('net');
const path = require('path') as typeof import('path');
import { nativePtyHostPrivateSocketNamePattern, nativePtyHostSocketPath, publishNativePtyHostSocket } from './native-pty-host-path.cjs';
import { nativePtyHostRuntimeIdentity, nativePtyHostRuntimeIdentityMatches, normalizeNativePtyHostRuntimeIdentity } from './native-pty-host-identity.cjs';
import { allocateNativePtyControllerGeneration, positiveGeneration } from './native-pty-controller-generation.cjs';
import { isTemporaryProviderSessionId } from './provider-session-id.cjs';
import { providerRequiresStableTerminalSessionAfterInput } from './provider-adapters.cjs';
import * as storageLayout from './storage-layout.cjs';
import { deserializeTerminalState } from './terminal-state-serialization.cjs';
import { probeUnixSocket } from './terminal-runtime-cleanup.cjs';

interface NativePtyHostRuntimeIdentity {
  protocolVersion: number;
  buildId: string;
  version: string;
}

interface SerializedTerminalStateEntry {
  id: string;
  metadata: Record<string, unknown>;
}

interface UnixSocketProbe {
  active: boolean;
  code?: string;
}

interface NativePtyHostError extends Error {
  code?: string | number;
  socketPaths?: string[];
  socketPath?: string;
  hostLogPath?: string;
  /**
   * Explicit uncertainty signal for mutation requests (sendInput, resize):
   * the request timed out or the transport failed after dispatch, so the
   * mutation may or may not have reached the PTY. A host-answered rejection
   * never carries this marker; it is proven by the host response.
   */
  terminalMutationUncertain?: boolean;
}

interface NativePtyControllerIdentity {
  id: string;
  generation: number;
}

interface NativePtyControllerIdentityInput {
  id?: unknown;
  generation?: unknown;
}

interface NativePtyHostClientOptions {
  configDir?: string;
  socketPath?: string;
  hostScript?: string;
  preserveHostOnDisconnect?: boolean;
  connectRetries?: number;
  connectRetryMs?: number;
  requestTimeoutMs?: number;
  hostLogPath?: string;
  expectedRuntimeIdentity?: unknown;
  controllerIdentity?: NativePtyControllerIdentityInput;
  hostRotationTimeoutMs?: number;
}

interface NativePtyHostSpawnCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface NativePtyHostInfo {
  [key: string]: unknown;
  pid?: unknown;
  privateSocketPath?: unknown;
  runtimeIdentity?: unknown;
}

interface NativePtyRuntimeRotationInfo {
  rotatedAt: number;
  previous: NativePtyHostRuntimeIdentity | null;
  current: NativePtyHostRuntimeIdentity | null;
  previousPid: number | null;
  serializedTerminalState: string;
}

interface NativePtyHostRequestOptions {
  ensureConnected?: boolean;
  retryOnDisconnect?: boolean;
  timeoutMs?: number;
  startHost?: boolean;
}

interface NativePtyHostConnectOptions {
  startHost?: boolean;
}

interface NativePtyHostDisconnectOptions {
  preserveHost?: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

interface NativePtyHostProtocolMessage {
  event?: string;
  payload?: unknown;
  id?: number;
  ok?: boolean;
  error?: string;
  result?: unknown;
}

const DEFAULT_CONNECT_RETRIES = 300;
const DEFAULT_CONNECT_RETRY_MS = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_HOST_ROTATION_TIMEOUT_MS = 10000;
const PACKAGED_NATIVE_PTY_HOST_ENV = 'FARMING_RUN_NATIVE_PTY_HOST';
const RECONNECT_RETRYABLE_METHODS = new Set([
  'ping',
  'createSession',
  'claimSessionController',
  'renewSessionController',
  'resizeSession',
  'killSession',
  'getSessionAttachCheckpoint',
  'getSessionState',
  'getSessionPreview',
  'recoverSessions',
  'serializeTerminalState',
  'updateSessionMetadata',
]);
const PACKAGED_NATIVE_HOST_ENV_KEYS = new Set([
  'CLICOLOR',
  'COLORTERM',
  'FARMING_CLI_BIN_DIR',
  'FARMING_CONFIG_DIR',
  'FARMING_EFFECTIVE_NODE_HEAP_MB',
  'FARMING_NATIVE_PTY_HOST_IDLE_EXIT_MS',
  'FARMING_NATIVE_PTY_HOST_OWNER_PID',
  'FARMING_NATIVE_PTY_HOST_SOCKET',
  'FARMING_NATIVE_PTY_SCREEN_WORKERS',
  'FARMING_NODE_BIN',
  'FARMING_NODE_LD',
  'FARMING_NODE_LIBRARY_PATH',
  'FARMING_PACKAGED_RUNTIME',
  'FARMING_RUN_NATIVE_PTY_HOST',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NODE_OPTIONS',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
]);

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  const code = error.code;
  return code === undefined || code === null ? '' : String(code);
}

function errorStack(error: unknown): string {
  if (error && typeof error === 'object' && 'stack' in error && error.stack) {
    return String(error.stack);
  }
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isConnectRetryable(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

function isRequestRetryable(method: string, options: NativePtyHostRequestOptions = {}): boolean {
  return options.ensureConnected !== false &&
    options.retryOnDisconnect !== false &&
    RECONNECT_RETRYABLE_METHODS.has(method);
}

function quoteShellArg(arg: unknown): string {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function buildCleanEnvExecCommand(
  env: Record<string, unknown>,
  command: string,
  args: string[] = [],
): string {
  const parts = ['/usr/bin/env', '-i'];
  Object.entries(env || {}).forEach(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    if (value === undefined || value === null) return;
    parts.push(`${key}=${String(value)}`);
  });
  parts.push(command, ...args);
  return parts.map(quoteShellArg).join(' ');
}

function packagedNativeHostEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  Object.entries(env).forEach(([key, value]) => {
    if (!PACKAGED_NATIVE_HOST_ENV_KEYS.has(key)) return;
    if (value === undefined || value === null) return;
    next[key] = value;
  });
  return next;
}

function redactCommandArg(arg: unknown): string {
  const value = String(arg);
  const match = value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!match) return value;
  const key = match[1].toUpperCase();
  if (/(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|KEY|AUTH|CREDENTIAL|COOKIE)/.test(key)) {
    return `${match[1]}=<redacted>`;
  }
  return value;
}

function hostConnectErrorMessage(error: unknown, spawned: boolean, logPath: string): string {
  const rawCode = errorCode(error);
  const code = rawCode ? ` ${rawCode}` : '';
  const logHint = logPath ? ` See ${logPath}.` : '';
  if (spawned) {
    return `Native PTY host failed to start or connect${code}. Check that Farming can run its native PTY host on this machine.${logHint}`;
  }
  return `Native PTY host is not reachable${code}.${logHint}`;
}

function runtimeIdentityLabel(value: unknown): string {
  const identity = normalizeNativePtyHostRuntimeIdentity(value);
  if (!identity) return 'legacy/unknown';
  const version = identity.version ? `v${identity.version} ` : '';
  return `${version}protocol ${identity.protocolVersion} build ${identity.buildId.slice(0, 12)}`;
}

function nativeHostSpawnCommand(hostScript: string, env: NodeJS.ProcessEnv): NativePtyHostSpawnCommand {
  const nodeBin = env.FARMING_NODE_BIN || process.execPath;
  const ldPath = env.FARMING_NODE_LD || '';
  const libraryPath = env.FARMING_NODE_LIBRARY_PATH || '';
  const isPackagedRuntime = env.FARMING_PACKAGED_RUNTIME === '1';
  if (isPackagedRuntime) {
    env[PACKAGED_NATIVE_PTY_HOST_ENV] = '1';
    const hostEnv = packagedNativeHostEnv(env);
    const command = ldPath && libraryPath ? ldPath : nodeBin;
    const args = ldPath && libraryPath
      ? ['--library-path', libraryPath, nodeBin]
      : [];
    return { command, args, env: hostEnv };
  }
  if (ldPath && libraryPath) {
    return {
      command: ldPath,
      args: ['--library-path', libraryPath, nodeBin, hostScript],
    };
  }
  return {
    command: nodeBin,
    args: [hostScript],
  };
}

class NativePtyHostClient extends EventEmitter {
  configDir: string;
  socketPath: string;
  hostScript: string;
  preserveHostOnDisconnect: boolean;
  connectRetries: number;
  connectRetryMs: number;
  requestTimeoutMs: number;
  hostLogPath: string;
  expectedRuntimeIdentity: unknown;
  controllerIdentity: NativePtyControllerIdentity;
  controllerIdentityReady: Promise<NativePtyControllerIdentity> | null;
  hostRotationTimeoutMs: number;
  connectedHostInfo: NativePtyHostInfo | null;
  connectedSocketPath: string;
  runtimeRotationInfo: NativePtyRuntimeRotationInfo | null;
  socket: import('net').Socket | null;
  socketGeneration: number;
  buffer: string;
  nextRequestId: number;
  pending: Map<number, PendingRequest>;
  connecting: Promise<void> | null;
  disposed: boolean;
  hostChild: import('child_process').ChildProcess | null;
  hostStartError: NativePtyHostError | null;
  hostLogStream: import('fs').WriteStream | null;
  suppressedDisconnectSockets: WeakSet<import('net').Socket>;

  constructor(options: NativePtyHostClientOptions = {}) {
    super();
    this.configDir = options.configDir || process.env.FARMING_CONFIG_DIR || '';
    this.socketPath = options.socketPath || nativePtyHostSocketPath(this.configDir);
    this.hostScript = options.hostScript || path.join(__dirname, 'native-pty-host.cjs');
    this.preserveHostOnDisconnect = options.preserveHostOnDisconnect === true;
    this.connectRetries = options.connectRetries || DEFAULT_CONNECT_RETRIES;
    this.connectRetryMs = options.connectRetryMs || DEFAULT_CONNECT_RETRY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.hostLogPath = options.hostLogPath || this.defaultHostLogPath();
    this.expectedRuntimeIdentity = options.expectedRuntimeIdentity || nativePtyHostRuntimeIdentity();
    this.controllerIdentity = options.controllerIdentity
      ? {
        id: String(options.controllerIdentity.id || ''),
        generation: positiveGeneration(options.controllerIdentity.generation),
      }
      : {
        id: crypto.randomUUID(),
        generation: 0,
      };
    this.controllerIdentityReady = null;
    this.hostRotationTimeoutMs = options.hostRotationTimeoutMs || DEFAULT_HOST_ROTATION_TIMEOUT_MS;
    this.connectedHostInfo = null;
    this.connectedSocketPath = '';
    this.runtimeRotationInfo = null;
    this.socket = null;
    this.socketGeneration = 0;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.connecting = null;
    this.disposed = false;
    this.hostChild = null;
    this.hostStartError = null;
    this.hostLogStream = null;
    this.suppressedDisconnectSockets = new WeakSet();
  }

  defaultHostLogPath(): string {
    const root = this.configDir || path.dirname(this.socketPath);
    return storageLayout.nativePtyHostLogFile(root);
  }

  openHostLogStream(spawnCommand: NativePtyHostSpawnCommand): import('fs').WriteStream | null {
    try {
      fs.mkdirSync(path.dirname(this.hostLogPath), { recursive: true });
      const stream = fs.createWriteStream(this.hostLogPath, { flags: 'a' });
      stream.write([
        `[${new Date().toISOString()}] Starting native PTY host`,
        `  command: ${spawnCommand.command}`,
        `  args: ${spawnCommand.args.map(redactCommandArg).join(' ')}`,
        `  socket: ${this.socketPath}`,
        `  ownerPid: ${process.pid}`,
        '',
      ].join('\n'));
      return stream;
    } catch (error) {
      this.emit('host-error', error);
      return null;
    }
  }

  closeHostLogStream(): void {
    if (!this.hostLogStream) return;
    this.hostLogStream.end();
    this.hostLogStream = null;
  }

  writeHostLog(label: string, chunk: Buffer | string): void {
    if (!this.hostLogStream) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk.toString();
    this.hostLogStream.write(`[${new Date().toISOString()}] ${label}: ${text}`);
  }

  canConnectWithoutStartingHost(): boolean {
    if (process.platform === 'win32') return true;
    return fs.existsSync(this.socketPath) || this.privateSocketCandidates().length > 0;
  }

  privateSocketCandidates(): string[] {
    if (process.platform === 'win32') return [];
    const directory = path.dirname(this.socketPath);
    const pattern = nativePtyHostPrivateSocketNamePattern(this.socketPath);
    try {
      return fs.readdirSync(directory)
        .filter(name => pattern.test(name))
        .map(name => path.join(directory, name));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  connectedPrivateSocketPath(hostInfo: NativePtyHostInfo = {}): string {
    if (process.platform === 'win32') return '';
    if (typeof hostInfo.privateSocketPath === 'string' && hostInfo.privateSocketPath) {
      return hostInfo.privateSocketPath;
    }
    if (!this.connectedSocketPath || this.connectedSocketPath !== this.socketPath) {
      return this.connectedSocketPath;
    }

    let publicIdentity;
    try {
      const stat = fs.statSync(this.socketPath, { bigint: true });
      publicIdentity = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return '';
      throw error;
    }

    const matching = this.privateSocketCandidates().filter((candidate) => {
      try {
        const stat = fs.statSync(candidate, { bigint: true });
        return stat.dev === publicIdentity.dev && stat.ino === publicIdentity.ino;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
      }
    });
    return matching.length === 1 ? matching[0] : '';
  }

  async resolveConnectSocketPath(): Promise<string> {
    if (process.platform === 'win32' || fs.existsSync(this.socketPath)) {
      return this.socketPath;
    }
    const active = [];
    for (const candidate of this.privateSocketCandidates()) {
      const probe = await probeUnixSocket(candidate);
      if (probe.active) active.push(candidate);
    }
    if (active.length > 1) {
      const error = new Error('Multiple live native PTY hosts were found for this Farming config') as NativePtyHostError;
      error.code = 'FARMING_NATIVE_HOST_AMBIGUOUS';
      error.socketPaths = active;
      throw error;
    }
    return active[0] || this.socketPath;
  }

  restorePublicSocketPath(connectedPath: string): void {
    if (
      process.platform === 'win32'
      || !connectedPath
      || connectedPath === this.socketPath
    ) {
      return;
    }
    publishNativePtyHostSocket(connectedPath, this.socketPath);
  }

  spawnHost(): void {
    if (this.disposed) return;
    if (this.hostChild && this.hostChild.exitCode === null && this.hostChild.signalCode === null) return;
    this.hostStartError = null;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FARMING_CONFIG_DIR: this.configDir || process.env.FARMING_CONFIG_DIR || '',
      FARMING_NATIVE_PTY_HOST_SOCKET: this.socketPath,
      FARMING_NATIVE_PTY_HOST_OWNER_PID: this.preserveHostOnDisconnect ? '' : String(process.pid),
    };
    const spawnCommand = nativeHostSpawnCommand(this.hostScript, env);
    this.closeHostLogStream();
    this.hostLogStream = this.openHostLogStream(spawnCommand);
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnCommand.env || env,
      windowsHide: true,
    });
    this.hostChild = child;
    if (this.preserveHostOnDisconnect && typeof child.unref === 'function') {
      child.unref();
    }
    if (child.stdout) {
      child.stdout.on('data', chunk => this.writeHostLog('stdout', chunk));
    }
    if (child.stderr) {
      child.stderr.on('data', chunk => this.writeHostLog('stderr', chunk));
    }
    child.once('error', error => {
      this.hostStartError = error;
      this.writeHostLog('error', `${errorStack(error)}\n`);
      if (this.hostChild === child) {
        this.hostChild = null;
      }
      this.closeHostLogStream();
      this.emit('host-error', error);
    });
    child.once('exit', (code, signal) => {
      this.writeHostLog('exit', `code=${code == null ? '' : code} signal=${signal || ''}\n`);
      if (this.hostChild === child) {
        this.hostChild = null;
      }
      this.closeHostLogStream();
      if (!this.disposed && !this.socket) {
        this.emit('host-exit', { code, signal });
      }
    });
  }

  async connectOnce(): Promise<void> {
    const connectedPath = await this.resolveConnectSocketPath();
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(connectedPath);
      const onError = (error: unknown) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        try {
          this.restorePublicSocketPath(connectedPath);
        } catch (error) {
          onError(error);
          return;
        }
        socket.off('error', onError);
        this.connectedSocketPath = connectedPath;
        this.attachSocket(socket);
        resolve();
      });
    });
  }

  async ensureConnected(options: NativePtyHostConnectOptions = {}): Promise<void> {
    if (this.disposed) {
      throw new Error('Native pty host client is disposed');
    }
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.connectWithRetries(options)
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  async connectWithRetries(options: NativePtyHostConnectOptions = {}): Promise<void> {
    await this.ensureControllerIdentity();
    const allowHostStart = options.startHost !== false;
    let spawned = false;
    let rotatedMismatchedHost = false;
    let pendingRotationInfo: NativePtyRuntimeRotationInfo | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < this.connectRetries; attempt += 1) {
      if (this.disposed) {
        throw new Error('Native pty host client is disposed');
      }
      try {
        await this.connectOnce();
        const hostInfo = await this.request<NativePtyHostInfo>(
          'ping',
          {},
          { ensureConnected: false, timeoutMs: 3000 },
        );
        if (!nativePtyHostRuntimeIdentityMatches(this.expectedRuntimeIdentity, hostInfo?.runtimeIdentity)) {
          if (rotatedMismatchedHost) {
            const error = new Error(
              `Native PTY host runtime still mismatches after rotation: expected ` +
              `${runtimeIdentityLabel(this.expectedRuntimeIdentity)}, got ${runtimeIdentityLabel(hostInfo?.runtimeIdentity)}`
            ) as NativePtyHostError;
            error.code = 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH';
            throw error;
          }
          const serializedTerminalState = await this.rotateMismatchedHost(hostInfo);
          pendingRotationInfo = {
            rotatedAt: Date.now(),
            previous: normalizeNativePtyHostRuntimeIdentity(hostInfo?.runtimeIdentity),
            current: normalizeNativePtyHostRuntimeIdentity(this.expectedRuntimeIdentity),
            previousPid: Number(hostInfo?.pid) || null,
            serializedTerminalState: typeof serializedTerminalState === 'string'
              ? serializedTerminalState
              : '',
          };
          rotatedMismatchedHost = true;
          spawned = true;
          continue;
        }
        await this.requestOnce('registerController', {
          identity: this.controllerIdentity,
        }, {
          ensureConnected: false,
          retryOnDisconnect: false,
          timeoutMs: 3000,
        });
        this.connectedHostInfo = hostInfo || null;
        if (pendingRotationInfo) {
          this.runtimeRotationInfo = pendingRotationInfo;
        }
        return;
      } catch (error) {
        lastError = error;
        if (errorCode(error) === 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH') {
          throw error;
        }
        if (errorCode(error) === 'FARMING_NATIVE_HOST_AMBIGUOUS' || errorCode(error) === 'EEXIST') {
          throw error;
        }
        if (this.hostStartError) {
          lastError = this.hostStartError;
        }
        if (!allowHostStart && !rotatedMismatchedHost && isConnectRetryable(error)) {
          throw error;
        }
        if (allowHostStart && !spawned && isConnectRetryable(error)) {
          spawned = true;
          this.spawnHost();
        }
        await delay(this.connectRetryMs);
      }
    }

    if (this.hostStartError) {
      const wrapped = new Error(
        hostConnectErrorMessage(this.hostStartError, spawned, this.hostLogPath),
      ) as NativePtyHostError;
      wrapped.code = this.hostStartError.code;
      wrapped.socketPath = this.socketPath;
      wrapped.hostLogPath = this.hostLogPath;
      wrapped.cause = this.hostStartError;
      throw wrapped;
    }

    if (lastError && isConnectRetryable(lastError)) {
      const wrapped = new Error(
        hostConnectErrorMessage(lastError, spawned, this.hostLogPath),
      ) as NativePtyHostError;
      wrapped.code = errorCode(lastError);
      wrapped.socketPath = this.socketPath;
      wrapped.hostLogPath = this.hostLogPath;
      wrapped.cause = lastError;
      throw wrapped;
    }

    throw lastError || new Error('Failed to connect to native pty host');
  }

  async ensureControllerIdentity(): Promise<NativePtyControllerIdentity> {
    if (this.controllerIdentity.generation > 0) {
      return this.controllerIdentity;
    }
    if (!this.controllerIdentityReady) {
      const configRoot = this.configDir || path.dirname(this.socketPath);
      this.controllerIdentityReady = allocateNativePtyControllerGeneration(configRoot)
        .then((generation) => {
          this.controllerIdentity.generation = generation;
          return this.controllerIdentity;
        })
        .catch((error) => {
          this.controllerIdentityReady = null;
          throw error;
        });
    }
    return this.controllerIdentityReady;
  }

  async waitForHostRelease(privateSocketPath = ''): Promise<void> {
    const deadline = Date.now() + this.hostRotationTimeoutMs;
    if (process.platform === 'win32') {
      await delay(Math.min(250, this.hostRotationTimeoutMs));
      return;
    }
    while (Date.now() < deadline) {
      const childReleased = !this.hostChild ||
        this.hostChild.exitCode !== null ||
        this.hostChild.signalCode !== null;
      const privateReleased = !privateSocketPath || !fs.existsSync(privateSocketPath);
      if (!fs.existsSync(this.socketPath) && privateReleased && childReleased) return;
      await delay(50);
    }
    const error = new Error(
      'Timed out waiting for the previous native PTY host to stop',
    ) as NativePtyHostError;
    error.code = 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH';
    throw error;
  }

  async resumePreparedHostRotation(preparationToken = ''): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) {
      await this.connectOnce();
      await this.requestOnce('registerController', {
        identity: this.controllerIdentity,
      }, {
        ensureConnected: false,
        retryOnDisconnect: false,
        timeoutMs: 1000,
      });
    }
    return this.requestOnce('resumeTerminalState', {
      preparationToken,
    }, {
      ensureConnected: false,
      retryOnDisconnect: false,
      timeoutMs: 1000,
    });
  }

  async requirePreparedHostRotationResume(
    preparationToken: string,
    actual: string,
    primaryError: unknown,
  ): Promise<void> {
    if (!preparationToken) return;
    try {
      await this.resumePreparedHostRotation(preparationToken);
    } catch (resumeError) {
      const recoveryError = new Error(
        `Cannot confirm recovery of incompatible native PTY host (${actual}) after aborting rotation`
      ) as NativePtyHostError;
      recoveryError.code = 'FARMING_NATIVE_HOST_ROTATION_RECOVERY_FAILED';
      recoveryError.cause = new AggregateError(
        [primaryError, resumeError].filter(Boolean),
        'Native PTY rotation failed and the prepared host could not be resumed'
      );
      throw recoveryError;
    }
  }

  async rotateMismatchedHost(hostInfo: NativePtyHostInfo): Promise<string> {
    const expected = runtimeIdentityLabel(this.expectedRuntimeIdentity);
    const actual = runtimeIdentityLabel(hostInfo && hostInfo.runtimeIdentity);
    console.warn(`Rotating native PTY host runtime: expected ${expected}, connected to ${actual}`);
    this.emit('host-runtime-mismatch', {
      expected: this.expectedRuntimeIdentity,
      actual: hostInfo && hostInfo.runtimeIdentity || null,
      pid: Number(hostInfo && hostInfo.pid) || null,
    });

    await this.requestOnce('registerController', {
      identity: this.controllerIdentity,
    }, {
      ensureConnected: false,
      retryOnDisconnect: false,
      timeoutMs: 3000,
    });

    let serializedTerminalState = '';
    let preparationToken = '';
    try {
      const preparation = await this.requestOnce<unknown>('serializeTerminalState', {}, {
        ensureConnected: false,
        retryOnDisconnect: false,
        timeoutMs: Math.min(5000, this.hostRotationTimeoutMs),
      });
      const preparationRecord = preparation && typeof preparation === 'object'
        ? preparation as Record<string, unknown>
        : null;
      if (
        preparationRecord &&
        typeof preparationRecord.preparationToken === 'string' &&
        preparationRecord.preparationToken &&
        typeof preparationRecord.serializedTerminalState === 'string'
      ) {
        preparationToken = preparationRecord.preparationToken;
        serializedTerminalState = preparationRecord.serializedTerminalState;
      } else if (typeof preparation === 'string') {
        const recovered = await this.requestOnce<unknown>('recoverSessions', {}, {
          ensureConnected: false,
          retryOnDisconnect: false,
          timeoutMs: Math.min(3000, this.hostRotationTimeoutMs),
        });
        if (Array.isArray(recovered) && recovered.length === 0) {
          serializedTerminalState = preparation;
        } else {
          throw new Error('The old native PTY host cannot commit a transactional terminal checkpoint');
        }
      } else {
        throw new Error('The native PTY host returned an invalid rotation checkpoint');
      }
    } catch (error) {
      if (preparationToken) {
        await this.requirePreparedHostRotationResume(preparationToken, actual, error);
      } else {
        await this.resumePreparedHostRotation('').catch(() => {});
      }
      const recovered = await this.requestOnce<unknown>('recoverSessions', {}, {
        ensureConnected: false,
        retryOnDisconnect: false,
        timeoutMs: Math.min(3000, this.hostRotationTimeoutMs),
      }).catch(() => null);
      if (Array.isArray(recovered) && recovered.length === 0) {
        serializedTerminalState = '';
        preparationToken = '';
      } else {
        const mismatchError = new Error(
          `Cannot rotate incompatible native PTY host (${actual}) without a committed terminal checkpoint`
        ) as NativePtyHostError;
        mismatchError.code = 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH';
        mismatchError.cause = error;
        throw mismatchError;
      }
    }

    let unresumableCodex;
    try {
      unresumableCodex = deserializeTerminalState(serializedTerminalState).find(entry => {
        const metadata = entry.metadata;
        const provider = String(metadata.providerSessionProvider || metadata.provider || '').trim();
        return providerRequiresStableTerminalSessionAfterInput(provider)
          && metadata.terminalInputReceived === true
          && (
            metadata.providerSessionTemporary === true
            || isTemporaryProviderSessionId(metadata.providerSessionId)
          );
      });
    } catch (error) {
      await this.requirePreparedHostRotationResume(preparationToken, actual, error);
      const mismatchError = new Error(
        `Cannot rotate incompatible native PTY host (${actual}) with an invalid terminal checkpoint`
      ) as NativePtyHostError;
      mismatchError.code = 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH';
      mismatchError.cause = error;
      throw mismatchError;
    }
    if (unresumableCodex) {
      const unresumableError = new Error(
        `Codex session ${unresumableCodex.id} has user input but no exact resume id`
      );
      await this.requirePreparedHostRotationResume(preparationToken, actual, unresumableError);
      const mismatchError = new Error(
        `Cannot rotate incompatible native PTY host (${actual}) while Codex session ${unresumableCodex.id} has user input but no exact resume id`
      ) as NativePtyHostError;
      mismatchError.code = 'FARMING_NATIVE_HOST_UNRESUMABLE_SESSION';
      mismatchError.cause = unresumableError;
      throw mismatchError;
    }

    const privateSocketPath = this.connectedPrivateSocketPath(hostInfo);
    const socket = this.socket;
    if (socket) this.suppressedDisconnectSockets.add(socket);
    let shutdownUncertain = false;
    try {
      await this.requestOnce('shutdownHost', {
        controller: this.controllerIdentity,
        preparationToken,
      }, {
        ensureConnected: false,
        retryOnDisconnect: false,
        timeoutMs: Math.min(5000, this.hostRotationTimeoutMs),
      });
    } catch (error) {
      if (!isConnectRetryable(error)) {
        await this.requirePreparedHostRotationResume(preparationToken, actual, error);
        const mismatchError = new Error(
          `Cannot rotate incompatible native PTY host (${actual}); stop the old host and restart Farming`
        ) as NativePtyHostError;
        mismatchError.code = 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH';
        mismatchError.cause = error;
        throw mismatchError;
      }
      shutdownUncertain = true;
    } finally {
      if (this.socket === socket) {
        this.socket = null;
        this.buffer = '';
      }
      if (socket && !socket.destroyed) socket.destroy();
      this.connectedHostInfo = null;
    }

    try {
      await this.waitForHostRelease(privateSocketPath || this.connectedSocketPath);
    } catch (error) {
      if (shutdownUncertain) {
        try {
          await this.resumePreparedHostRotation(preparationToken);
        } catch {
          // The old host may have exited after the release timeout. Do not
          // start a second host until the socket and child are actually gone.
        }
      }
      const mismatchError = new Error(
        `Cannot confirm shutdown of incompatible native PTY host (${actual}); restart Farming after the old host exits`
      ) as NativePtyHostError;
      mismatchError.code = 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH';
      mismatchError.cause = error;
      throw mismatchError;
    }
    this.spawnHost();
    return serializedTerminalState;
  }

  consumeRuntimeRotation(): NativePtyRuntimeRotationInfo | null {
    const rotation = this.runtimeRotationInfo;
    this.runtimeRotationInfo = null;
    return rotation;
  }

  attachSocket(socket: import('net').Socket): void {
    if (this.socket && this.socket !== socket) {
      this.socket.destroy();
    }
    const generation = this.socketGeneration + 1;
    this.socketGeneration = generation;
    this.socket = socket;
    this.buffer = '';

    socket.on('data', chunk => this.handleData(chunk, socket, generation));
    socket.on('close', () => this.handleDisconnect(socket, generation));
    socket.on('error', error => {
      if (this.socket !== socket || this.socketGeneration !== generation) return;
      this.emit('host-error', error);
    });
  }

  handleDisconnect(
    socket: import('net').Socket | null,
    generation = this.socketGeneration,
  ): void {
    if (socket && this.socket && this.socket !== socket) {
      return;
    }
    if (generation !== this.socketGeneration) return;
    this.socket = null;
    this.buffer = '';
    this.connectedHostInfo = null;
    this.connectedSocketPath = '';
    if (this.disposed) return;
    const error = new Error('Native pty host disconnected') as NativePtyHostError;
    error.code = 'ECONNRESET';
    // Pending mutation requests were dispatched without a host answer.
    error.terminalMutationUncertain = true;
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(error);
    });
    this.pending.clear();
    if (socket && this.suppressedDisconnectSockets.has(socket)) {
      return;
    }
    this.emit('host-disconnect');
  }

  resetSocketAfterRequestError(): void {
    const socket = this.socket;
    this.socket = null;
    this.buffer = '';
    if (socket && !socket.destroyed) {
      this.suppressedDisconnectSockets.add(socket);
      socket.destroy();
    }
  }

  handleData(
    chunk: Buffer | string,
    socket = this.socket,
    generation = this.socketGeneration,
  ): void {
    if (!socket || socket !== this.socket || generation !== this.socketGeneration) return;
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        this.handleMessage(line);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  handleMessage(line: string): void {
    let message: NativePtyHostProtocolMessage;
    try {
      message = JSON.parse(line) as NativePtyHostProtocolMessage;
    } catch {
      return;
    }

    if (message.event) {
      this.emit(message.event, message.payload || {});
      return;
    }

    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.ok === false) {
      pending.reject(new Error(message.error || 'Native pty host request failed'));
      return;
    }

    pending.resolve(message.result);
  }

  async request<Result = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: NativePtyHostRequestOptions = {},
  ): Promise<Result> {
    const retryOnDisconnect = isRequestRetryable(method, options);
    try {
      return await this.requestOnce<Result>(method, params, options);
    } catch (error) {
      if (!retryOnDisconnect || !isConnectRetryable(error)) throw error;
      await this.ensureConnected({ startHost: options.startHost });
      return this.requestOnce<Result>(method, params, {
        ...options,
        ensureConnected: false,
        retryOnDisconnect: false,
      });
    }
  }

  async requestOnce<Result = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: NativePtyHostRequestOptions = {},
  ): Promise<Result> {
    if (options.ensureConnected !== false) {
      await this.ensureConnected({ startHost: options.startHost });
    }
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Native pty host is not connected');
    }
    const socket = this.socket;

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(
          `Native pty host request timed out: ${method}`,
        ) as NativePtyHostError;
        error.code = 'ETIMEDOUT';
        // The request was dispatched and never answered; a mutation may or
        // may not have reached the PTY.
        error.terminalMutationUncertain = true;
        this.resetSocketAfterRequestError();
        reject(error);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, {
        resolve: value => resolve(value as Result),
        reject,
        timer,
      });
      socket.write(payload, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        if (isConnectRetryable(error)) {
          this.resetSocketAfterRequestError();
        }
        // The payload write failed or the socket went away after dispatch:
        // the mutation outcome is uncertain.
        (error as NativePtyHostError).terminalMutationUncertain = true;
        pending.reject(error);
      });
    });
  }

  terminateSpawnedHost(): void {
    const child = this.hostChild;
    this.hostChild = null;
    if (!child || child.killed) return;

    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }

    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore shutdown races
      }
    }, 1500);
    if (typeof timer.unref === 'function') timer.unref();
  }

  disconnect(options: NativePtyHostDisconnectOptions = {}): void {
    const preserveHost = options.preserveHost === true || this.preserveHostOnDisconnect;
    this.disposed = true;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    const error = new Error('Native pty host client disconnected');
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(error);
    });
    this.pending.clear();
    if (!preserveHost) {
      this.terminateSpawnedHost();
    } else {
      this.hostChild = null;
    }
    this.closeHostLogStream();
  }
}

export {
  NativePtyHostClient,
  buildCleanEnvExecCommand,
  nativeHostSpawnCommand,
};
