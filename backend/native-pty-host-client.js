const EventEmitter = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { nativePtyHostSocketPath } = require('./native-pty-host-path');
const storageLayout = require('./storage-layout');

const DEFAULT_CONNECT_RETRIES = 300;
const DEFAULT_CONNECT_RETRY_MS = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const PACKAGED_NATIVE_PTY_HOST_ENV = 'FARMING_RUN_NATIVE_PTY_HOST';
const RECONNECT_RETRYABLE_METHODS = new Set([
  'ping',
  'createSession',
  'resizeSession',
  'clearBuffer',
  'killSession',
  'getSessionState',
  'getSessionPreview',
  'recoverSessions',
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
    this.socket = null;
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
    const allowHostStart = options.startHost !== false;
    let spawned = false;
    let lastError = null;

    for (let attempt = 0; attempt < this.connectRetries; attempt += 1) {
      if (this.disposed) {
        throw new Error('Native pty host client is disposed');
      }
      try {
        await this.connectOnce();
        await this.request('ping', {}, { ensureConnected: false, timeoutMs: 3000 });
        return;
      } catch (error) {
        lastError = error;
        if (this.hostStartError) {
          lastError = this.hostStartError;
        }
        if (!allowHostStart && isConnectRetryable(error)) {
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

  attachSocket(socket) {
    if (this.socket && this.socket !== socket) {
      this.socket.destroy();
    }
    this.socket = socket;
    this.buffer = '';

    socket.on('data', chunk => this.handleData(chunk));
    socket.on('close', () => this.handleDisconnect(socket));
    socket.on('error', error => {
      this.emit('host-error', error);
    });
  }

  handleDisconnect(socket) {
    if (socket && this.socket && this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.buffer = '';
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

  handleData(chunk) {
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
