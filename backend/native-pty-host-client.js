const EventEmitter = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { nativePtyHostSocketPath } = require('./native-pty-host-path');
const {
  nativePtyHostRuntimeIdentity,
  nativePtyHostRuntimeIdentityMatches,
  normalizeNativePtyHostRuntimeIdentity,
} = require('./native-pty-host-identity');
const {
  allocateNativePtyControllerGeneration,
  positiveGeneration,
} = require('./native-pty-controller-generation');
const storageLayout = require('./storage-layout');

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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isConnectRetryable(error) {
  const code = error && error.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

function isRequestRetryable(method, options = {}) {
  return options.ensureConnected !== false &&
    options.retryOnDisconnect !== false &&
    RECONNECT_RETRYABLE_METHODS.has(method);
}

function quoteShellArg(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function buildCleanEnvExecCommand(env, command, args = []) {
  const parts = ['/usr/bin/env', '-i'];
  Object.entries(env || {}).forEach(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    if (value === undefined || value === null) return;
    parts.push(`${key}=${String(value)}`);
  });
  parts.push(command, ...args);
  return parts.map(quoteShellArg).join(' ');
}

function packagedNativeHostEnv(env = {}) {
  const next = {};
  Object.entries(env).forEach(([key, value]) => {
    if (!PACKAGED_NATIVE_HOST_ENV_KEYS.has(key)) return;
    if (value === undefined || value === null) return;
    next[key] = value;
  });
  return next;
}

function redactCommandArg(arg) {
  const value = String(arg);
  const match = value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!match) return value;
  const key = match[1].toUpperCase();
  if (/(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|KEY|AUTH|CREDENTIAL|COOKIE)/.test(key)) {
    return `${match[1]}=<redacted>`;
  }
  return value;
}

function hostConnectErrorMessage(error, spawned, logPath) {
  const code = error && error.code ? ` ${error.code}` : '';
  const logHint = logPath ? ` See ${logPath}.` : '';
  if (spawned) {
    return `Native PTY host failed to start or connect${code}. Check that Farming can run its native PTY host on this machine.${logHint}`;
  }
  return `Native PTY host is not reachable${code}.${logHint}`;
}

function runtimeIdentityLabel(value) {
  const identity = normalizeNativePtyHostRuntimeIdentity(value);
  if (!identity) return 'legacy/unknown';
  const version = identity.version ? `v${identity.version} ` : '';
  return `${version}protocol ${identity.protocolVersion} build ${identity.buildId.slice(0, 12)}`;
}

function nativeHostSpawnCommand(hostScript, env) {
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
  constructor(options = {}) {
    super();
    this.configDir = options.configDir || process.env.FARMING_CONFIG_DIR || '';
    this.socketPath = options.socketPath || nativePtyHostSocketPath(this.configDir);
    this.hostScript = options.hostScript || path.join(__dirname, 'native-pty-host.js');
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

  defaultHostLogPath() {
    const root = this.configDir || path.dirname(this.socketPath);
    return storageLayout.nativePtyHostLogFile(root);
  }

  openHostLogStream(spawnCommand) {
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

  closeHostLogStream() {
    if (!this.hostLogStream) return;
    this.hostLogStream.end();
    this.hostLogStream = null;
  }

  writeHostLog(label, chunk) {
    if (!this.hostLogStream) return;
    this.hostLogStream.write(`[${new Date().toISOString()}] ${label}: ${chunk.toString('utf8')}`);
  }

  canConnectWithoutStartingHost() {
    if (process.platform === 'win32') return true;
    return fs.existsSync(this.socketPath);
  }

  spawnHost() {
    if (this.disposed) return;
    if (this.hostChild && this.hostChild.exitCode === null && this.hostChild.signalCode === null) return;
    this.hostStartError = null;
    const env = {
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
      this.writeHostLog('error', `${error && error.stack ? error.stack : error}\n`);
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

  connectOnce() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const onError = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        this.attachSocket(socket);
        resolve();
      });
    });
  }

  async ensureConnected(options = {}) {
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

  async connectWithRetries(options = {}) {
    await this.ensureControllerIdentity();
    const allowHostStart = options.startHost !== false;
    let spawned = false;
    let rotatedMismatchedHost = false;
    let pendingRotationInfo = null;
    let lastError = null;

    for (let attempt = 0; attempt < this.connectRetries; attempt += 1) {
      if (this.disposed) {
        throw new Error('Native pty host client is disposed');
      }
      try {
        await this.connectOnce();
        const hostInfo = await this.request('ping', {}, { ensureConnected: false, timeoutMs: 3000 });
        if (!nativePtyHostRuntimeIdentityMatches(this.expectedRuntimeIdentity, hostInfo?.runtimeIdentity)) {
          if (rotatedMismatchedHost) {
            const error = new Error(
              `Native PTY host runtime still mismatches after rotation: expected ` +
              `${runtimeIdentityLabel(this.expectedRuntimeIdentity)}, got ${runtimeIdentityLabel(hostInfo?.runtimeIdentity)}`
            );
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
        if (error && error.code === 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH') {
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
      const wrapped = new Error(hostConnectErrorMessage(this.hostStartError, spawned, this.hostLogPath));
      wrapped.code = this.hostStartError.code;
      wrapped.socketPath = this.socketPath;
      wrapped.hostLogPath = this.hostLogPath;
      wrapped.cause = this.hostStartError;
      throw wrapped;
    }

    if (lastError && isConnectRetryable(lastError)) {
      const wrapped = new Error(hostConnectErrorMessage(lastError, spawned, this.hostLogPath));
      wrapped.code = lastError.code;
      wrapped.socketPath = this.socketPath;
      wrapped.hostLogPath = this.hostLogPath;
      wrapped.cause = lastError;
      throw wrapped;
    }

    throw lastError || new Error('Failed to connect to native pty host');
  }

  async ensureControllerIdentity() {
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

  async waitForHostRelease() {
    const deadline = Date.now() + this.hostRotationTimeoutMs;
    if (process.platform === 'win32') {
      await delay(Math.min(250, this.hostRotationTimeoutMs));
      return;
    }
    while (Date.now() < deadline) {
      const childReleased = !this.hostChild ||
        this.hostChild.exitCode !== null ||
        this.hostChild.signalCode !== null;
      if (!fs.existsSync(this.socketPath) && childReleased) return;
      await delay(50);
    }
    const error = new Error('Timed out waiting for the previous native PTY host to stop');
    error.code = 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH';
    throw error;
  }

  async resumePreparedHostRotation(preparationToken = '') {
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

  async rotateMismatchedHost(hostInfo) {
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
      const preparation = await this.requestOnce('serializeTerminalState', {}, {
        ensureConnected: false,
        retryOnDisconnect: false,
        timeoutMs: Math.min(5000, this.hostRotationTimeoutMs),
      });
      if (
        preparation &&
        typeof preparation === 'object' &&
        typeof preparation.preparationToken === 'string' &&
        preparation.preparationToken &&
        typeof preparation.serializedTerminalState === 'string'
      ) {
        preparationToken = preparation.preparationToken;
        serializedTerminalState = preparation.serializedTerminalState;
      } else if (typeof preparation === 'string') {
        const recovered = await this.requestOnce('recoverSessions', {}, {
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
      await this.resumePreparedHostRotation(preparationToken).catch(() => {});
      const recovered = await this.requestOnce('recoverSessions', {}, {
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
        );
        mismatchError.code = 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH';
        mismatchError.cause = error;
        throw mismatchError;
      }
    }

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
        await this.resumePreparedHostRotation(preparationToken).catch(() => {});
        const mismatchError = new Error(
          `Cannot rotate incompatible native PTY host (${actual}); stop the old host and restart Farming`
        );
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
      await this.waitForHostRelease();
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
      );
      mismatchError.code = 'FARMING_NATIVE_HOST_RUNTIME_MISMATCH';
      mismatchError.cause = error;
      throw mismatchError;
    }
    this.spawnHost();
    return serializedTerminalState;
  }

  consumeRuntimeRotation() {
    const rotation = this.runtimeRotationInfo;
    this.runtimeRotationInfo = null;
    return rotation;
  }

  attachSocket(socket) {
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

  handleDisconnect(socket, generation = this.socketGeneration) {
    if (socket && this.socket && this.socket !== socket) {
      return;
    }
    if (generation !== this.socketGeneration) return;
    this.socket = null;
    this.buffer = '';
    this.connectedHostInfo = null;
    if (this.disposed) return;
    const error = new Error('Native pty host disconnected');
    error.code = 'ECONNRESET';
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

  resetSocketAfterRequestError() {
    const socket = this.socket;
    this.socket = null;
    this.buffer = '';
    if (socket && !socket.destroyed) {
      this.suppressedDisconnectSockets.add(socket);
      socket.destroy();
    }
  }

  handleData(chunk, socket = this.socket, generation = this.socketGeneration) {
    if (!socket || socket !== this.socket || generation !== this.socketGeneration) return;
    this.buffer += chunk.toString('utf8');
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

  handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
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

  async request(method, params = {}, options = {}) {
    const retryOnDisconnect = isRequestRetryable(method, options);
    try {
      return await this.requestOnce(method, params, options);
    } catch (error) {
      if (!retryOnDisconnect || !isConnectRetryable(error)) throw error;
      await this.ensureConnected({ startHost: options.startHost });
      return this.requestOnce(method, params, {
        ...options,
        ensureConnected: false,
        retryOnDisconnect: false,
      });
    }
  }

  async requestOnce(method, params = {}, options = {}) {
    if (options.ensureConnected !== false) {
      await this.ensureConnected({ startHost: options.startHost });
    }
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Native pty host is not connected');
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Native pty host request timed out: ${method}`);
        error.code = 'ETIMEDOUT';
        this.resetSocketAfterRequestError();
        reject(error);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(payload, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        if (isConnectRetryable(error)) {
          this.resetSocketAfterRequestError();
        }
        pending.reject(error);
      });
    });
  }

  terminateSpawnedHost() {
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

  disconnect(options = {}) {
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

module.exports = NativePtyHostClient;
module.exports.buildCleanEnvExecCommand = buildCleanEnvExecCommand;
module.exports.nativeHostSpawnCommand = nativeHostSpawnCommand;
