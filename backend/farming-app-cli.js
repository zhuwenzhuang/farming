#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { URLSearchParams } = require('url');
const { execFileSync, spawn } = require('child_process');
const { run: runControlCli } = require('./farming-cli');
const { PACKAGED_CODEX_ACP_ARG, runPackagedCodexAcp } = require('./acp/packaged-codex-acp');
const storageLayout = require('./storage-layout');

const SERVER_MODE_ARG = '--farming-server';
const SERVER_MODE_ENV = 'FARMING_RUN_SERVER';
const NATIVE_PTY_HOST_ARG = '--native-pty-host';
const USAGE_HISTORY_SMOKE_ARG = '--farming-usage-history-smoke';
const DEFAULT_PORT = '6694';
const DEFAULT_BASE_PATH = '/farming';
const DEFAULT_SERVER_START_TIMEOUT_MS = 30_000;
const DEFAULT_SERVER_START_STABILITY_MS = 1_500;
const SERVER_COMMANDS = new Set(['start', 'serve', 'daemon', 'stop', 'status', 'logs', 'url', 'help']);
const CONTROL_COMMANDS = new Set(['skills', 'memory', 'report', 'list', 'spawn', 'output', 'send', 'kill']);
const SERVER_BACKED_CONTROL_COMMANDS = new Set(['list', 'spawn', 'output', 'send', 'kill']);

function defaultConfigDir(env = process.env) {
  return storageLayout.farmingConfigDir(env);
}

function normalizeBasePath(basePath) {
  if (!basePath || basePath === '/') return '';
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

function routePath(basePath, suffix = '') {
  const normalizedBase = normalizeBasePath(basePath);
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return normalizedBase ? `${normalizedBase}${normalizedSuffix}` : normalizedSuffix;
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

function readMemoryLimitBytes() {
  const candidates = [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw && raw !== 'max') {
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0 && value < 9_000_000_000_000_000_000) return value;
      }
    } catch {
      // Ignore missing cgroup files on macOS and non-container Linux hosts.
    }
  }
  return os.totalmem();
}

function computeNodeHeapMb() {
  const limitMb = Math.floor(readMemoryLimitBytes() / 1024 / 1024);
  if (!Number.isFinite(limitMb) || limitMb <= 0) return 4096;
  if (limitMb <= 2048) return Math.max(512, Math.floor(limitMb * 0.75));
  if (limitMb <= 8192) return Math.max(512, limitMb - 1024);
  return Math.max(512, Math.floor(limitMb * 0.9));
}

function appendNodeOption(existing, option) {
  const value = String(existing || '').trim();
  return value ? `${value} ${option}` : option;
}

function buildServerEnv(overrides = {}, baseEnv = process.env) {
  const env = { ...baseEnv, ...overrides };
  delete env.PKG_EXECPATH;
  if (!process.pkg && !env.FARMING_MANAGED_PACKAGE_ROOT) {
    try {
      env.FARMING_MANAGED_PACKAGE_ROOT = fs.realpathSync(path.join(__dirname, '..'));
    } catch {
      // npm update verification will remain unavailable when the package root cannot be proven.
    }
  }
  const cliBinDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..', 'bin');
  env.PORT = String(env.FARMING_PORT || env.PORT || DEFAULT_PORT);
  env.FARMING_BASE_PATH = env.FARMING_BASE_PATH || DEFAULT_BASE_PATH;
  env.FARMING_CONFIG_DIR = env.FARMING_CONFIG_DIR || defaultConfigDir(env);
  if (process.pkg || env.FARMING_PACKAGED_RUNTIME === '1') {
    env.FARMING_PACKAGED_RUNTIME = '1';
  } else {
    delete env.FARMING_PACKAGED_RUNTIME;
  }
  env.FARMING_NODE_BIN = env.FARMING_NODE_BIN || process.execPath;
  env.FARMING_CLI_BIN_DIR = env.FARMING_CLI_BIN_DIR || cliBinDir;

  const heapSetting = env.FARMING_NODE_MAX_OLD_SPACE_SIZE || 'auto';
  const hasHeapOption = /(?:^|\s)--max-old-space-size(?:=|\s|$)/.test(env.NODE_OPTIONS || '');
  if (!hasHeapOption && !['0', 'off', 'false', 'OFF', 'FALSE'].includes(heapSetting)) {
    const heapMb = heapSetting === 'auto' ? computeNodeHeapMb() : Number(heapSetting);
    if (Number.isFinite(heapMb) && heapMb > 0) {
      env.NODE_OPTIONS = appendNodeOption(env.NODE_OPTIONS, `--max-old-space-size=${Math.floor(heapMb)}`);
      env.FARMING_EFFECTIVE_NODE_HEAP_MB = String(Math.floor(heapMb));
    }
  }

  return env;
}

function parseServerArgs(argv) {
  const options = {
    command: argv[0] && SERVER_COMMANDS.has(argv[0]) ? argv[0] : 'start',
    env: {},
    portExplicit: false,
  };
  const rest = options.command === argv[0] ? argv.slice(1) : argv;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const readValue = (name) => {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      i++;
      return value;
    };

    if (arg === '--port') {
      options.env.PORT = readValue(arg);
      options.portExplicit = true;
    } else if (arg.startsWith('--port=')) {
      options.env.PORT = arg.slice('--port='.length);
      options.portExplicit = true;
    } else if (arg === '--base-path') {
      options.env.FARMING_BASE_PATH = readValue(arg);
    } else if (arg.startsWith('--base-path=')) {
      options.env.FARMING_BASE_PATH = arg.slice('--base-path='.length);
    } else if (arg === '--config-dir') {
      options.env.FARMING_CONFIG_DIR = readValue(arg);
    } else if (arg.startsWith('--config-dir=')) {
      options.env.FARMING_CONFIG_DIR = arg.slice('--config-dir='.length);
    } else if (arg === '--home') {
      options.env.HOME = readValue(arg);
    } else if (arg.startsWith('--home=')) {
      options.env.HOME = arg.slice('--home='.length);
    } else if (arg === '--no-auth') {
      options.env.FARMING_DISABLE_AUTH = '1';
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function parseSharedAppOption(arg, rest, index, env) {
  const readValue = (name) => {
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  };

  if (arg === '--port') {
    env.PORT = readValue(arg);
    return 2;
  }
  if (arg.startsWith('--port=')) {
    env.PORT = arg.slice('--port='.length);
    return 1;
  }
  if (arg === '--base-path') {
    env.FARMING_BASE_PATH = readValue(arg);
    return 2;
  }
  if (arg.startsWith('--base-path=')) {
    env.FARMING_BASE_PATH = arg.slice('--base-path='.length);
    return 1;
  }
  if (arg === '--config-dir') {
    env.FARMING_CONFIG_DIR = readValue(arg);
    return 2;
  }
  if (arg.startsWith('--config-dir=')) {
    env.FARMING_CONFIG_DIR = arg.slice('--config-dir='.length);
    return 1;
  }
  if (arg === '--home') {
    env.HOME = readValue(arg);
    return 2;
  }
  if (arg.startsWith('--home=')) {
    env.HOME = arg.slice('--home='.length);
    return 1;
  }
  if (arg === '--no-auth') {
    env.FARMING_DISABLE_AUTH = '1';
    return 1;
  }
  return 0;
}

function isPortOverrideExplicit(overrides = {}, baseEnv = process.env) {
  return Boolean(
    overrides.PORT
    || overrides.FARMING_PORT
    || baseEnv.PORT
    || baseEnv.FARMING_PORT
  );
}

function canListenOnHost(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}

async function canListenOnPort(port) {
  return (await canListenOnHost(port, '127.0.0.1'))
    && (await canListenOnHost(port, '0.0.0.0'));
}

async function findAvailablePort(startPort = Number(DEFAULT_PORT), maxAttempts = 50) {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = startPort + offset;
    if (await canListenOnPort(port)) return port;
  }
  throw new Error(`No available port found from ${startPort} to ${startPort + maxAttempts - 1}`);
}

async function adaptServerPort(env, parsed) {
  if (parsed.portExplicit || isPortOverrideExplicit(parsed.env, process.env)) return env;
  const port = await findAvailablePort(Number(env.PORT || DEFAULT_PORT));
  if (String(port) !== String(env.PORT)) env.PORT = String(port);
  return env;
}

function splitControlArgs(argv) {
  const command = argv[0];
  const env = {};
  const controlArgs = [command];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      controlArgs.push(...argv.slice(i));
      break;
    }

    const consumed = parseSharedAppOption(arg, argv, i, env);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    controlArgs.push(arg);
  }

  return { argv: controlArgs, env };
}

function parseReviewArgs(argv) {
  const options = {
    branch: '',
    env: {},
    noOpen: false,
    portExplicit: false,
    positional: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      index++;
      return value;
    };
    if (arg === '--branch') {
      options.branch = readValue(arg);
      continue;
    }
    if (arg.startsWith('--branch=')) {
      options.branch = arg.slice('--branch='.length);
      continue;
    }
    if (arg === '--no-open') {
      options.noOpen = true;
      continue;
    }
    const consumed = parseSharedAppOption(arg, argv, index, options.env);
    if (consumed > 0) {
      if (arg === '--port' || arg.startsWith('--port=')) options.portExplicit = true;
      index += consumed - 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown review option: ${arg}`);
    options.positional.push(arg);
  }
  if (options.positional.length !== 3) {
    throw new Error('Usage: farming review <git-dir> <old-revision> <new-revision|now> [--branch <branch>]');
  }
  const [gitDir, base, head] = options.positional;
  if (base === 'now') throw new Error('the old revision cannot be now');
  return { ...options, base, gitDir, head };
}

function runGit(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(detail || `git ${args.join(' ')} failed`, { cause: error });
  }
}

function resolveReviewTarget(parsed) {
  const requestedRoot = path.resolve(parsed.gitDir);
  const root = runGit(requestedRoot, ['rev-parse', '--show-toplevel']);
  const branch = parsed.branch || runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  runGit(root, ['rev-parse', '--verify', `${branch}^{commit}`]);
  const resolveRevision = (revision) => {
    if (revision === 'now') return 'now';
    const branchRelative = revision === 'HEAD'
      ? branch
      : revision.startsWith('HEAD~') || revision.startsWith('HEAD^')
        ? `${branch}${revision.slice('HEAD'.length)}`
        : revision;
    return runGit(root, ['rev-parse', '--verify', `${branchRelative}^{commit}`]);
  };
  return {
    base: resolveRevision(parsed.base),
    branch,
    head: resolveRevision(parsed.head),
    root,
  };
}

function reviewUrl(env, target) {
  const params = new URLSearchParams({
    base: target.base,
    head: target.head,
    root: target.root,
  });
  const token = ['1', 'true', 'yes', 'on'].includes(String(env.FARMING_DISABLE_AUTH || '').toLowerCase()) ? '' : readTokenForEnv(env);
  if (token) params.set('token', token);
  return `${entryUrl(env, '127.0.0.1')}/review?${params.toString()}`;
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function runReview(parsed) {
  const target = resolveReviewTarget(parsed);
  const serverParsed = { command: 'daemon', env: parsed.env, portExplicit: parsed.portExplicit };
  const code = await startDaemon(serverParsed);
  if (code) return code;
  const env = buildControlEnv(parsed.env);
  const url = reviewUrl(env, target);
  console.log(url);
  if (!parsed.noOpen) openBrowser(url);
  return 0;
}

function buildControlEnv(overrides = {}, baseEnv = process.env) {
  const env = buildServerEnv(overrides, baseEnv);
  if (!isPortOverrideExplicit(overrides, baseEnv) && !env.FARMING_CONTROL_URL) {
    const state = readServerState(env.FARMING_CONFIG_DIR);
    if (state.port) env.PORT = String(state.port);
    if (state.basePath) env.FARMING_BASE_PATH = state.basePath;
  }
  env.FARMING_CONTROL_URL = env.FARMING_CONTROL_URL || entryUrl(env, '127.0.0.1');
  env.FARMING_TOKEN_FILE = env.FARMING_TOKEN_FILE || storageLayout.sessionTokenFile(env.FARMING_CONFIG_DIR);
  return env;
}

async function runServerBackedControlCli(argv) {
  const parsed = splitControlArgs(argv);
  const env = buildControlEnv(parsed.env);
  const forwardedKeys = [
    'FARMING_CONFIG_DIR',
    'FARMING_CONTROL_URL',
    'FARMING_TOKEN_FILE',
    'FARMING_DISABLE_AUTH',
    'FARMING_BASE_PATH',
    'HOME',
    'PORT',
  ];
  const previous = new Map(forwardedKeys.map(key => [key, process.env[key]]));

  forwardedKeys.forEach((key) => {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  });

  try {
    return await runControlCli(parsed.argv);
  } finally {
    forwardedKeys.forEach((key) => {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

function childInvocation(env = process.env) {
  if (process.pkg) {
    return { command: '/bin/sh', args: ['-c', buildCleanEnvExecCommand(env, process.execPath, ['--'])] };
  }
  const nodePath = env.FARMING_NODE_BIN || process.execPath;
  if (env.FARMING_NODE_LD && env.FARMING_NODE_LIBRARY_PATH) {
    return {
      command: env.FARMING_NODE_LD,
      args: ['--library-path', env.FARMING_NODE_LIBRARY_PATH, nodePath, __filename],
    };
  }
  return { command: nodePath, args: [__filename] };
}

function ensureConfigDir(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
}

function pidFile(configDir) {
  return storageLayout.serverPidFile(configDir);
}

function serverStateFile(configDir) {
  return storageLayout.serverStateFile(configDir);
}

function logFile(configDir) {
  return storageLayout.serverLogFile(configDir);
}

function readServerState(configDir) {
  try {
    return JSON.parse(fs.readFileSync(serverStateFile(configDir), 'utf8'));
  } catch {
    return {};
  }
}

function writeServerState(configDir, env, pid) {
  const state = {
    pid,
    port: Number(env.PORT || DEFAULT_PORT),
    basePath: env.FARMING_BASE_PATH || DEFAULT_BASE_PATH,
    configDir,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(serverStateFile(configDir), `${JSON.stringify(state, null, 2)}\n`);
}

function readPid(configDir) {
  try {
    return Number(fs.readFileSync(pidFile(configDir), 'utf8').trim());
  } catch {
    return 0;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tailFile(file, lineCount = 80) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lineCount).join('\n').trim();
  } catch {
    return '';
  }
}

function entryUrl(env, host = 'localhost') {
  const basePath = normalizeBasePath(env.FARMING_BASE_PATH || DEFAULT_BASE_PATH) || '/';
  return `http://${host}:${env.PORT}${basePath}`;
}

function readTokenForEnv(env) {
  const tokenFile = storageLayout.sessionTokenFile(env.FARMING_CONFIG_DIR || defaultConfigDir(env));
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function serverStartTimeoutMs(env) {
  const parsed = Number(env.FARMING_START_TIMEOUT_MS || env.FARMING_SERVER_START_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_SERVER_START_TIMEOUT_MS;
}

function serverStartStabilityMs(env) {
  const parsed = Number(env.FARMING_START_STABILITY_MS || env.FARMING_SERVER_START_STABILITY_MS);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, 60_000);
  return DEFAULT_SERVER_START_STABILITY_MS;
}

function waitForProcessStability(pid, durationMs = DEFAULT_SERVER_START_STABILITY_MS) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (!isRunning(pid)) {
        reject(new Error('server process exited during startup stability check'));
        return;
      }
      const remainingMs = durationMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(100, remainingMs));
    };
    tick();
  });
}

function cleanupFailedDaemonStart(configDir, childPid) {
  if (isRunning(childPid)) {
    try {
      process.kill(childPid, 'SIGTERM');
    } catch {
      // The child may exit between the liveness check and the signal.
    }
  }
  if (readPid(configDir) !== childPid) return;
  fs.rmSync(pidFile(configDir), { force: true });
  fs.rmSync(serverStateFile(configDir), { force: true });
}

function waitForServer(env, timeoutMs = serverStartTimeoutMs(env), childPid = 0) {
  const startedAt = Date.now();
  const port = Number(env.PORT || DEFAULT_PORT);
  const authDisabled = ['1', 'true', 'yes', 'on'].includes(String(env.FARMING_DISABLE_AUTH || '').toLowerCase());

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (childPid && !isRunning(childPid)) {
        reject(new Error('server process exited before becoming ready'));
        return;
      }
      const token = authDisabled ? '' : readTokenForEnv(env);
      if (!authDisabled && !token) {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error('server did not create its token file before timeout'));
          return;
        }
        setTimeout(tick, 250);
        return;
      }
      const readyPath = authDisabled
        ? routePath(env.FARMING_BASE_PATH || DEFAULT_BASE_PATH, '/api/auth/status')
        : `${routePath(env.FARMING_BASE_PATH || DEFAULT_BASE_PATH, '/')}?token=${encodeURIComponent(token)}`;
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: readyPath,
        method: 'GET',
        timeout: 500,
      }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
          resolve();
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`server did not accept its startup token before timeout (HTTP ${res.statusCode || 0})`));
          return;
        }
        setTimeout(tick, 250);
      });
      req.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error('server did not become ready before timeout'));
          return;
        }
        setTimeout(tick, 250);
      });
      req.on('timeout', () => {
        req.destroy();
      });
      req.end();
    };
    tick();
  });
}

function runServerInCurrentProcess() {
  process.env = buildServerEnv();
  const { startServer } = require('./server');
  startServer();
}

function runNativePtyHostInCurrentProcess() {
  const { startNativePtyHostProcess } = require('./native-pty-host');
  startNativePtyHostProcess();
}

async function startForeground(parsed) {
  const env = await adaptServerPort(buildServerEnv(parsed.env), parsed);
  env[SERVER_MODE_ENV] = '1';
  ensureConfigDir(env.FARMING_CONFIG_DIR);
  const invocation = childInvocation(env);
  const child = spawn(invocation.command, invocation.args, {
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exit(1);
  });
}

async function startDaemon(parsed) {
  const env = await adaptServerPort(buildServerEnv(parsed.env), parsed);
  env[SERVER_MODE_ENV] = '1';
  const configDir = env.FARMING_CONFIG_DIR;
  ensureConfigDir(configDir);

  const existingPid = readPid(configDir);
  if (isRunning(existingPid)) {
    const state = readServerState(configDir);
    if (state.port) env.PORT = String(state.port);
    if (state.basePath) env.FARMING_BASE_PATH = state.basePath;
    console.log(`Farming is already running (PID ${existingPid})`);
    console.log(entryUrl(env));
    return 0;
  }

  const out = fs.openSync(logFile(configDir), 'a');
  const invocation = childInvocation(env);
  if (env.FARMING_DEBUG_CLI === '1') {
    fs.appendFileSync(logFile(configDir), [
      `daemon invocation command=${invocation.command}`,
      `daemon invocation args=${JSON.stringify(invocation.args)}`,
      `daemon parent argv=${JSON.stringify(process.argv)}`,
      `daemon parent execPath=${process.execPath}`,
      `daemon child pkg env=${JSON.stringify(Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('PKG'))))}`,
      '',
    ].join('\n'));
  }
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    env,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(pidFile(configDir), String(child.pid));

  try {
    await waitForServer(env, serverStartTimeoutMs(env), child.pid);
    await waitForProcessStability(child.pid, serverStartStabilityMs(env));
    await waitForServer(env, Math.min(serverStartTimeoutMs(env), 5_000), child.pid);
  } catch (error) {
    cleanupFailedDaemonStart(configDir, child.pid);
    console.error(error.message);
    const logs = tailFile(logFile(configDir), 80);
    if (logs) console.error(logs);
    return 1;
  }

  console.log(`Farming started (PID ${child.pid})`);
  writeServerState(configDir, env, child.pid);
  const logs = tailFile(logFile(configDir), 40);
  const urlLines = logs.split(/\r?\n/).filter(line => /Local:|Network:|Token:|Token style:|Token auth:/.test(line));
  if (urlLines.length > 0) {
    console.log(urlLines.join('\n'));
  } else {
    console.log(entryUrl(env));
  }
  return 0;
}

function stopDaemon(parsed) {
  const env = buildServerEnv(parsed.env);
  const configDir = env.FARMING_CONFIG_DIR;
  const pid = readPid(configDir);
  if (!isRunning(pid)) {
    fs.rmSync(pidFile(configDir), { force: true });
    fs.rmSync(serverStateFile(configDir), { force: true });
    console.log('Farming is not running.');
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  fs.rmSync(pidFile(configDir), { force: true });
  fs.rmSync(serverStateFile(configDir), { force: true });
  console.log(`Stopped Farming (PID ${pid})`);
  return 0;
}

function statusDaemon(parsed) {
  const env = buildServerEnv(parsed.env);
  const configDir = env.FARMING_CONFIG_DIR;
  const pid = readPid(configDir);
  if (!isRunning(pid)) {
    console.log('Farming is not running.');
    return 0;
  }
  console.log(`Farming is running (PID ${pid})`);
  const logs = tailFile(logFile(configDir), 30);
  if (logs) console.log(logs);
  return 0;
}

function showLogs(parsed) {
  const env = buildServerEnv(parsed.env);
  const logs = tailFile(logFile(env.FARMING_CONFIG_DIR), 120);
  console.log(logs || 'No Farming log found.');
  return 0;
}

function showUrl(parsed) {
  const env = buildServerEnv(parsed.env);
  if (!parsed.portExplicit && !isPortOverrideExplicit(parsed.env, process.env)) {
    const state = readServerState(env.FARMING_CONFIG_DIR);
    if (state.port) env.PORT = String(state.port);
    if (state.basePath) env.FARMING_BASE_PATH = state.basePath;
  }
  console.log(entryUrl(env));
  return 0;
}

function usage() {
  return `Usage:
  farming [start] [--port 6694] [--base-path /farming] [--config-dir ~/.farming]
  farming daemon [--port 6694] [--base-path /farming] [--config-dir ~/.farming]
  farming status
  farming stop
  farming logs
  farming url
  farming review <git-dir> <old-revision> <new-revision|now> [--branch <branch>] [--no-open]

Agent control commands are also available:
  farming skills
  farming list [--json] [--parent <agentId>]
  farming spawn --workspace <repo> -- <command...>
  farming output <agentId> [--tail <chars>]
  farming send <agentId> <text...>
  farming kill <agentId>`;
}

async function run(argv = process.argv.slice(2)) {
  if (process.env.FARMING_DEBUG_CLI === '1' && argv[0] === 'debug-argv') {
    console.log(JSON.stringify({
      argv: process.argv,
      execPath: process.execPath,
      pkg: Boolean(process.pkg),
    }, null, 2));
    return 0;
  }

  if (argv[0] === PACKAGED_CODEX_ACP_ARG) {
    runPackagedCodexAcp();
    return 0;
  }

  if (argv[0] === USAGE_HISTORY_SMOKE_ARG) {
    const { runUsageHistorySmoke } = require('./usage-history-smoke');
    const result = await runUsageHistorySmoke();
    console.log(JSON.stringify(result));
    return 0;
  }

  if (argv[0] === NATIVE_PTY_HOST_ARG || process.env.FARMING_RUN_NATIVE_PTY_HOST === '1') {
    runNativePtyHostInCurrentProcess();
    return 0;
  }

  if (process.env[SERVER_MODE_ENV] === '1' || argv[0] === SERVER_MODE_ARG) {
    runServerInCurrentProcess();
    return 0;
  }

  if (SERVER_BACKED_CONTROL_COMMANDS.has(argv[0])) {
    return runServerBackedControlCli(argv);
  }

  if (CONTROL_COMMANDS.has(argv[0])) {
    return runControlCli(argv);
  }

  if (argv[0] === 'review') return runReview(parseReviewArgs(argv.slice(1)));

  const parsed = parseServerArgs(argv);
  if (parsed.command === 'help') {
    console.log(usage());
    return 0;
  }
  if (parsed.command === 'daemon') return startDaemon(parsed);
  if (parsed.command === 'stop') return stopDaemon(parsed);
  if (parsed.command === 'status') return statusDaemon(parsed);
  if (parsed.command === 'logs') return showLogs(parsed);
  if (parsed.command === 'url') return showUrl(parsed);
  await startForeground(parsed);
  return 0;
}

if (require.main === module) {
  run().then(code => {
    if (code) process.exit(code);
  }).catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  SERVER_MODE_ARG,
  NATIVE_PTY_HOST_ARG,
  buildCleanEnvExecCommand,
  childInvocation,
  cleanupFailedDaemonStart,
  buildControlEnv,
  buildServerEnv,
  computeNodeHeapMb,
  defaultConfigDir,
  findAvailablePort,
  parseServerArgs,
  parseReviewArgs,
  resolveReviewTarget,
  reviewUrl,
  readServerState,
  serverStartTimeoutMs,
  serverStartStabilityMs,
  splitControlArgs,
  run,
  serverStateFile,
};
