import * as fs from 'fs';
import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { URLSearchParams } from 'url';
import { execFileSync, spawn } from 'child_process';
import { createRuntimeDependencyProgressRenderer } from './runtime-dependency-progress.cjs';
import type { RuntimeDependencyProgress } from './runtime-dependency-manager.cjs';
import { canonicalConfigDir } from './config-instance.cjs';
import type { ServerProcessIdentity } from './server-process-identity.cjs';
import {
  applyPackageInstallationEnvironment,
  prunePackageImages,
  readPackageImageRef,
  registerPackageImageUsage,
  releasePackageImageUsage,
  resolvePackageInstallationContext,
} from './package-installation.cjs';

const DESKTOP_COMPAT_GLIBC_PATH = 'FARMING_DESKTOP_COMPAT_GLIBC_PATH';
const DESKTOP_INHERITED_LD_LIBRARY_PATH = 'FARMING_DESKTOP_INHERITED_LD_LIBRARY_PATH';

if (process.env[DESKTOP_COMPAT_GLIBC_PATH]) {
  const inheritedLibraryPath = process.env[DESKTOP_INHERITED_LD_LIBRARY_PATH];
  if (inheritedLibraryPath) process.env.LD_LIBRARY_PATH = inheritedLibraryPath;
  else delete process.env.LD_LIBRARY_PATH;
}

const packagedProcess = process as NodeJS.Process & { pkg?: unknown };

interface ExpectedProcessIdentity {
  format?: unknown;
  pid?: unknown;
  processGroupId?: unknown;
  startedAt?: unknown;
}

interface StorageLayout {
  farmingConfigDir(env?: NodeJS.ProcessEnv): string;
  serverLogFile(configDir: string): string;
  serverOwnerFile(configDir: string): string;
  serverOwnerLockDir(configDir: string): string;
  serverPidFile(configDir: string): string;
  serverStateFile(configDir: string): string;
  sessionTokenFile(configDir: string): string;
}

interface ServerEnv extends NodeJS.ProcessEnv {
  FARMING_BASE_PATH: string;
  FARMING_CLI_BIN_DIR: string;
  FARMING_CONFIG_DIR: string;
  FARMING_NODE_BIN: string;
  PORT: string;
}

interface ParsedServerArgs {
  command: string;
  env: NodeJS.ProcessEnv;
  portExplicit: boolean;
}

interface ParsedServerOperation {
  env: NodeJS.ProcessEnv;
  portExplicit?: boolean;
}

interface ParsedReviewArgs {
  base: string;
  branch: string;
  env: NodeJS.ProcessEnv;
  gitDir: string;
  head: string;
  noOpen: boolean;
  portExplicit: boolean;
  positional: string[];
}

interface ReviewTarget {
  base: string;
  branch: string;
  head: string;
  root: string;
}

interface ChildInvocation {
  args: string[];
  command: string;
}

interface ServerState {
  basePath?: string;
  configDir?: unknown;
  identityMigratedAt?: string;
  phase?: string;
  pid?: unknown;
  port?: unknown;
  processIdentity?: ExpectedProcessIdentity | null;
  updatedAt?: string;
}

interface ServerOwner {
  claimId?: unknown;
  configDir?: unknown;
  phase?: unknown;
  pid?: unknown;
  processIdentity?: ExpectedProcessIdentity | null;
  updatedAt?: unknown;
}

interface WaitForDaemonStopOptions {
  canListenOnPort?: (port: number) => Promise<boolean>;
  isRunning?: (pid: number) => boolean;
  now?: () => number;
  timeoutMs?: number;
  wait?: (durationMs: number) => Promise<void>;
}

interface PrepareStartupOptions {
  activate?: boolean;
  force?: boolean;
}

interface LegacySettings {
  [key: string]: unknown;
}

function errorField(error: unknown, field: string): unknown {
  return error && typeof error === 'object' && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function errorString(error: unknown, field = 'message'): string {
  const value = errorField(error, field);
  return value ? String(value) : '';
}

import { run as runControlCli } from './farming-cli.cjs';
import { PACKAGED_CODEX_ACP_ARG, runPackagedCodexAcp } from './acp/packaged-codex-acp.cjs';
import { PACKAGED_CLAUDE_ACP_ARG, runPackagedClaudeAcp } from './acp/packaged-claude-acp.cjs';
import { SERVER_PROCESS_IDENTITY_FORMAT, matchingProcessIdentity, readServerProcessIdentity } from './server-process-identity.cjs';
import * as storageLayout from './storage-layout.cjs';

const SERVER_MODE_ARG = '--farming-server';
const SERVER_MODE_ENV = 'FARMING_RUN_SERVER';
const NATIVE_PTY_HOST_ARG = '--native-pty-host';
const USAGE_HISTORY_SMOKE_ARG = '--farming-usage-history-smoke';
const DEFAULT_PORT = '6694';
const DEFAULT_BASE_PATH = '/farming';
const DEFAULT_SERVER_START_TIMEOUT_MS = 30_000;
const DEFAULT_SERVER_START_STABILITY_MS = 1_500;
const DEFAULT_SERVER_STOP_TIMEOUT_MS = 30_000;
const SERVER_STOP_POLL_MS = 100;
const SERVER_COMMANDS = new Set(['start', 'serve', 'daemon', 'stop', 'status', 'logs', 'url', 'help']);
const CONTROL_COMMANDS = new Set(['skills', 'capabilities', 'list', 'spawn', 'output', 'send', 'title', 'kill']);
const SERVER_BACKED_CONTROL_COMMANDS = new Set(['capabilities', 'list', 'spawn', 'output', 'send', 'title', 'kill']);

function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return storageLayout.farmingConfigDir(env);
}

function normalizeBasePath(basePath: unknown): string {
  const value = String(basePath || '');
  if (!value || value === '/') return '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function routePath(basePath: unknown, suffix = ''): string {
  const normalizedBase = normalizeBasePath(basePath);
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return normalizedBase ? `${normalizedBase}${normalizedSuffix}` : normalizedSuffix;
}

function quoteShellArg(arg: unknown): string {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function buildCleanEnvExecCommand(
  env: NodeJS.ProcessEnv,
  command: string,
  args: string[] = [],
): string {
  const parts = ['/usr/bin/env', ...buildCleanEnvExecArgs(env, command, args)];
  return parts.map(quoteShellArg).join(' ');
}

function buildCleanEnvExecArgs(
  env: NodeJS.ProcessEnv,
  command: string,
  args: string[] = [],
): string[] {
  const parts = ['-i'];
  Object.entries(env || {}).forEach(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    if (value === undefined || value === null) return;
    parts.push(`${key}=${String(value)}`);
  });
  parts.push(command, ...args);
  return parts;
}

function readMemoryLimitBytes(): number {
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

function computeNodeHeapMb(): number {
  const limitMb = Math.floor(readMemoryLimitBytes() / 1024 / 1024);
  if (!Number.isFinite(limitMb) || limitMb <= 0) return 4096;
  if (limitMb <= 2048) return Math.max(512, Math.floor(limitMb * 0.75));
  if (limitMb <= 8192) return Math.max(512, limitMb - 1024);
  return Math.max(512, Math.floor(limitMb * 0.9));
}

function appendNodeOption(existing: unknown, option: string): string {
  const value = String(existing || '').trim();
  return value ? `${value} ${option}` : option;
}

function buildServerEnv(
  overrides: NodeJS.ProcessEnv = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): ServerEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...overrides };
  delete env.PKG_EXECPATH;
  if (!packagedProcess.pkg) {
    const activePackageRoot = path.resolve(
      String(env.FARMING_ACTIVE_PACKAGE_ROOT || path.join(__dirname, '..')),
    );
    const installation = resolvePackageInstallationContext(activePackageRoot, env);
    if (installation) {
      applyPackageInstallationEnvironment(env, installation, activePackageRoot);
    } else if (!env.FARMING_MANAGED_PACKAGE_ROOT) {
      try {
        env.FARMING_MANAGED_PACKAGE_ROOT = fs.realpathSync(activePackageRoot);
      } catch {
        // Source and non-managed deployments do not participate in package activation.
      }
    }
  }
  const cliBinDir = packagedProcess.pkg
    ? path.dirname(process.execPath)
    : path.join(String(env.FARMING_ACTIVE_PACKAGE_ROOT || path.join(__dirname, '..')), 'bin');
  env.PORT = String(env.FARMING_PORT || env.PORT || DEFAULT_PORT);
  env.FARMING_BASE_PATH = env.FARMING_BASE_PATH || DEFAULT_BASE_PATH;
  env.FARMING_CONFIG_DIR = env.FARMING_CONFIG_DIR || defaultConfigDir(env);
  if (packagedProcess.pkg || env.FARMING_PACKAGED_RUNTIME === '1') {
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

  return env as ServerEnv;
}

function parseServerArgs(argv: string[]): ParsedServerArgs {
  const options: ParsedServerArgs = {
    command: argv[0] && SERVER_COMMANDS.has(argv[0]) ? argv[0] : 'start',
    env: {},
    portExplicit: false,
  };
  const rest = options.command === argv[0] ? argv.slice(1) : argv;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const readValue = (name: string): string => {
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

function parseSharedAppOption(
  arg: string,
  rest: string[],
  index: number,
  env: NodeJS.ProcessEnv,
): number {
  const readValue = (name: string): string => {
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

function isPortOverrideExplicit(
  overrides: NodeJS.ProcessEnv = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    overrides.PORT
    || overrides.FARMING_PORT
    || baseEnv.PORT
    || baseEnv.FARMING_PORT
  );
}

function canListenOnHost(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}

async function canListenOnPort(port: number): Promise<boolean> {
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

async function adaptServerPort(
  env: ServerEnv,
  parsed: ParsedServerOperation,
): Promise<ServerEnv> {
  if (parsed.portExplicit || isPortOverrideExplicit(parsed.env, process.env)) return env;
  const port = await findAvailablePort(Number(env.PORT || DEFAULT_PORT));
  if (String(port) !== String(env.PORT)) env.PORT = String(port);
  return env;
}

function splitControlArgs(argv: string[]): {
  argv: string[];
  env: NodeJS.ProcessEnv;
} {
  const command = argv[0];
  /** @type {NodeJS.ProcessEnv} */
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

function parseReviewArgs(argv: string[]): ParsedReviewArgs {
  const options: Omit<ParsedReviewArgs, 'base' | 'gitDir' | 'head'> = {
    branch: '',
    env: {},
    noOpen: false,
    portExplicit: false,
    positional: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const readValue = (name: string): string => {
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

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error: unknown) {
    const detail = String(errorField(error, 'stderr') || errorString(error) || '').trim();
    throw new Error(detail || `git ${args.join(' ')} failed`, { cause: error });
  }
}

function resolveReviewTarget(parsed: ParsedReviewArgs): ReviewTarget {
  const requestedRoot = path.resolve(parsed.gitDir);
  const root = runGit(requestedRoot, ['rev-parse', '--show-toplevel']);
  const branch = parsed.branch || runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  runGit(root, ['rev-parse', '--verify', `${branch}^{commit}`]);
  const resolveRevision = (revision: string): string => {
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

function reviewUrl(env: ServerEnv, target: ReviewTarget): string {
  const params = new URLSearchParams({
    base: target.base,
    head: target.head,
    root: target.root,
  });
  const token = ['1', 'true', 'yes', 'on'].includes(String(env.FARMING_DISABLE_AUTH || '').toLowerCase()) ? '' : readTokenForEnv(env);
  if (token) params.set('token', token);
  return `${entryUrl(env, '127.0.0.1')}/review?${params.toString()}`;
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function runReview(parsed: ParsedReviewArgs): Promise<number> {
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

function buildControlEnv(
  overrides: NodeJS.ProcessEnv = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): ServerEnv {
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

async function runServerBackedControlCli(argv: string[]): Promise<number> {
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

function childInvocation(env: NodeJS.ProcessEnv = process.env): ChildInvocation {
  if (packagedProcess.pkg) {
    const childEnv = { ...env };
    const compatibilityPath = String(env[DESKTOP_COMPAT_GLIBC_PATH] || '').trim();
    if (compatibilityPath) {
      childEnv.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
        ? `${compatibilityPath}:${env.LD_LIBRARY_PATH}`
        : compatibilityPath;
    }
    // Spawn env directly so it execs the packaged binary in-place. A shell
    // wrapper may keep its own PID while the listener belongs to a child,
    // making daemon ownership impossible to prove on Linux.
    return {
      command: '/usr/bin/env',
      // FARMING_RUN_SERVER selects the embedded server entry. Do not append a
      // sentinel argument: pkg may interpret it as an external script path.
      args: buildCleanEnvExecArgs(childEnv, process.execPath),
    };
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

function ensureConfigDir(configDir: string): void {
  fs.mkdirSync(configDir, { recursive: true });
}

function pidFile(configDir: string): string {
  return storageLayout.serverPidFile(configDir);
}

function serverStateFile(configDir: string): string {
  return storageLayout.serverStateFile(configDir);
}

function logFile(configDir: string): string {
  return storageLayout.serverLogFile(configDir);
}

function readServerState(configDir: string): ServerState {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(serverStateFile(configDir), 'utf8'));
    return value && typeof value === 'object' ? value as ServerState : {};
  } catch {
    return {};
  }
}

function canonicalizeServerConfigDir(env: ServerEnv): ServerEnv {
  ensureConfigDir(env.FARMING_CONFIG_DIR);
  env.FARMING_CONFIG_DIR = canonicalConfigDir(env.FARMING_CONFIG_DIR);
  return env;
}

function matchingCanonicalConfigDir(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !actual) return false;
  try {
    return canonicalConfigDir(actual) === canonicalConfigDir(expected);
  } catch {
    return false;
  }
}

function writeServerState(
  configDir: string,
  env: ServerEnv,
  pid: number,
  processIdentity: ServerProcessIdentity,
  phase = 'running',
): void {
  const state = {
    pid,
    port: Number(env.PORT || DEFAULT_PORT),
    basePath: env.FARMING_BASE_PATH || DEFAULT_BASE_PATH,
    configDir: canonicalConfigDir(configDir),
    processIdentity,
    phase,
    updatedAt: new Date().toISOString(),
  };
  const target = serverStateFile(configDir);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function processLooksLikeFarmingServer(pid: number): boolean {
  let environment = '';
  try {
    environment = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').replace(/\0/g, ' ');
  } catch {
    try {
      environment = execFileSync(
        '/bin/ps',
        ['eww', '-p', String(pid), '-o', 'command='],
        { encoding: 'utf8', timeout: 1_000, maxBuffer: 1024 * 1024 },
      );
    } catch {
      environment = '';
    }
  }
  if (/(?:^|\s)FARMING_RUN_SERVER=1(?:\s|$)/.test(environment)) return true;
  return /(?:^|\s)(?:\S+[/\\])?backend[/\\]server\.js(?:\s|$)/.test(environment);
}

function processHasExactEnvironment(
  pid: number,
  expected: Record<string, unknown>,
): boolean {
  try {
    const entries = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry): [string, string] => {
        const separator = entry.indexOf('=');
        return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
      });
    const environment = new Map(entries);
    return Object.entries(expected).every(([key, value]) => environment.get(key) === String(value));
  } catch {
    if (Object.values(expected).some(value => /\s/.test(String(value)))) return false;
    try {
      const environment = execFileSync(
        '/bin/ps',
        ['eww', '-p', String(pid), '-o', 'command='],
        { encoding: 'utf8', timeout: 1_000, maxBuffer: 1024 * 1024 },
      );
      return Object.entries(expected).every(([key, value]) => {
        const escaped = `${key}=${value}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(environment);
      });
    } catch {
      return false;
    }
  }
}

function processHasCanonicalConfigEnvironment(pid: number, configDir: string): boolean {
  let actualConfigDir = '';
  try {
    const entry = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .find(value => value.startsWith('FARMING_CONFIG_DIR='));
    actualConfigDir = entry?.slice('FARMING_CONFIG_DIR='.length) || '';
  } catch {
    if (/\s/.test(configDir)) return false;
    try {
      const environment = execFileSync(
        '/bin/ps',
        ['eww', '-p', String(pid), '-o', 'command='],
        { encoding: 'utf8', timeout: 1_000, maxBuffer: 1024 * 1024 },
      );
      const match = environment.match(/(?:^|\s)FARMING_CONFIG_DIR=([^\s]+)(?:\s|$)/);
      actualConfigDir = match?.[1] || '';
    } catch {
      return false;
    }
  }
  if (!actualConfigDir) return false;
  try {
    return canonicalConfigDir(actualConfigDir) === canonicalConfigDir(configDir);
  } catch {
    return false;
  }
}

function readLegacyServerSettings(
  configDir: string,
  state: ServerState,
  pid: number,
): Promise<LegacySettings> {
  const authDisabled = processHasExactEnvironment(pid, { FARMING_DISABLE_AUTH: '1' });
  const token = authDisabled ? '' : readTokenForEnv({ FARMING_CONFIG_DIR: configDir });
  if (!authDisabled && !token) {
    return Promise.reject(new Error('legacy Farming server identity probe requires this config directory token'));
  }
  const requestPath = routePath(state.basePath || DEFAULT_BASE_PATH, '/api/settings');
  return new Promise<LegacySettings>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: Number(state.port),
      path: requestPath,
      method: 'GET',
      timeout: 1_000,
      headers: token ? { Cookie: `farming_token=${encodeURIComponent(token)}` } : {},
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        if (body.length <= 64 * 1024) body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`legacy Farming server identity probe returned HTTP ${res.statusCode || 0}`));
          return;
        }
        try {
          const payload: unknown = JSON.parse(body);
          const settings = payload && typeof payload === 'object' && 'settings' in payload
            ? payload.settings
            : null;
          if (!settings || typeof settings !== 'object') {
            reject(new Error('legacy Farming server identity probe did not return Farming settings'));
            return;
          }
          resolve(settings as LegacySettings);
        } catch (error: unknown) {
          reject(new Error(
            `legacy Farming server identity probe was invalid: ${errorString(error) || error}`,
          ));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('legacy Farming server identity probe timed out')));
    req.end();
  });
}

function processOwnsListeningPort(pid: unknown, port: unknown): boolean {
  const processId = Number(pid);
  const portNumber = Number(port);
  if (!Number.isSafeInteger(processId) || processId <= 0 || !Number.isInteger(portNumber) || portNumber <= 0) {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      const socketInodes = new Set<string>(
        fs.readdirSync(`/proc/${processId}/fd`).flatMap(entry => {
        try {
          const target = fs.readlinkSync(`/proc/${processId}/fd/${entry}`);
          const match = target.match(/^socket:\[(\d+)\]$/);
          return match ? [match[1]] : [];
        } catch {
          return [];
        }
        }),
      );
      const portHex = portNumber.toString(16).toUpperCase().padStart(4, '0');
      for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let rows: string[] = [];
        try {
          rows = fs.readFileSync(table, 'utf8').trim().split(/\r?\n/).slice(1);
        } catch {
          continue;
        }
        if (rows.some(row => {
          const fields = row.trim().split(/\s+/);
          const localPort = String(fields[1] || '').split(':').at(-1);
          return localPort === portHex && fields[3] === '0A' && socketInodes.has(fields[9]);
        })) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  try {
    const lsof = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
    const stdout = execFileSync(
      lsof,
      ['-nP', '-a', '-p', String(processId), `-iTCP:${portNumber}`, '-sTCP:LISTEN', '-Fpfn'],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024 },
    );
    return String(stdout || '').split(/\r?\n/).some(line => line.startsWith('n') && line.endsWith(`:${portNumber}`));
  } catch {
    return false;
  }
}

async function assertServerProcessIdentity(
  configDir: string,
  pid: number,
  state: ServerState,
): Promise<ServerProcessIdentity> {
  const expected = state?.processIdentity;
  if (
    Number(state?.pid) !== pid
    || !matchingCanonicalConfigDir(state?.configDir, configDir)
    || !expected
    || Number(expected.pid) !== pid
    || !Number.isSafeInteger(Number(expected.processGroupId))
    || Number(expected.processGroupId) <= 0
    || !String(expected.startedAt || '').trim()
  ) {
    throw new Error(
      `Refusing to stop Farming PID ${pid}: server control metadata does not contain a matching process identity`,
    );
  }
  const current = await readServerProcessIdentity(pid);
  if (!current || !matchingProcessIdentity(expected, current)) {
    throw new Error(
      `Refusing to stop Farming PID ${pid}: the live process identity does not match the server control metadata`,
    );
  }
  if (state.phase !== 'starting' && !processOwnsListeningPort(pid, Number(state.port))) {
    throw new Error(`Refusing to stop Farming PID ${pid}: the process does not own listening port ${state.port}`);
  }
  return current;
}

async function migrateLegacyServerIdentity(
  configDir: string,
  pid: number,
  state: ServerState,
): Promise<ServerProcessIdentity> {
  if (
    Number(state?.pid) !== pid
    || !matchingCanonicalConfigDir(state?.configDir, configDir)
    || !Number.isInteger(Number(state?.port))
    || Number(state.port) <= 0
    || Number(state.port) > 65535
    || !processLooksLikeFarmingServer(pid)
    || !processHasCanonicalConfigEnvironment(pid, configDir)
    || !processHasExactEnvironment(pid, { PORT: String(state.port) })
  ) {
    throw new Error(
      `Refusing to stop Farming PID ${pid}: legacy server control metadata could not prove this process belongs to the config directory`,
    );
  }
  const firstIdentity = await readServerProcessIdentity(pid);
  if (!firstIdentity) {
    throw new Error(`Refusing to stop Farming PID ${pid}: the legacy server process identity could not be read`);
  }
  if (!processOwnsListeningPort(pid, Number(state.port))) {
    throw new Error(`Refusing to stop Farming PID ${pid}: the legacy process does not own listening port ${state.port}`);
  }
  await readLegacyServerSettings(configDir, state, pid);
  const stableIdentity = await readServerProcessIdentity(pid);
  if (
    !stableIdentity
    || !matchingProcessIdentity(firstIdentity, stableIdentity)
    || readPid(configDir) !== pid
  ) {
    throw new Error(`Refusing to stop Farming PID ${pid}: the legacy server process identity changed during verification`);
  }
  fs.writeFileSync(serverStateFile(configDir), `${JSON.stringify({
    ...state,
    pid,
    configDir: canonicalConfigDir(configDir),
    processIdentity: stableIdentity,
    identityMigratedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return stableIdentity;
}

function readPid(configDir: string): number {
  try {
    return Number(fs.readFileSync(pidFile(configDir), 'utf8').trim());
  } catch {
    return 0;
  }
}

function isRunning(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (errorString(error, 'code') === 'EPERM' || errorString(error, 'code') === 'EACCES') {
      return true;
    }
    return false;
  }
}

function assertServerProcessClaimAvailable(
  configDir: string,
  currentPid = process.pid,
): void {
  const existingPid = readPid(configDir);
  if (!existingPid || existingPid === currentPid || !isRunning(existingPid)) return;
  const state = readServerState(configDir);
  if (state.processIdentity?.format === SERVER_PROCESS_IDENTITY_FORMAT) {
    const current = readServerProcessIdentity(existingPid);
    if (!matchingProcessIdentity(state.processIdentity, current)) return;
  }
  throw new Error(
    `Farming config directory is already owned by live Server PID ${existingPid}. `
    + 'Stop that Server before starting another one with the same config directory.',
  );
}

function readServerOwner(configDir: string): ServerOwner {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(storageLayout.serverOwnerFile(configDir), 'utf8'));
    return value && typeof value === 'object' ? value as ServerOwner : {};
  } catch (error: unknown) {
    if (errorString(error, 'code') === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

function exactServerOwnerIdentity(owner: ServerOwner): ServerProcessIdentity | null {
  const identity = owner.processIdentity;
  if (
    identity?.format !== SERVER_PROCESS_IDENTITY_FORMAT
    || Number(identity.pid) !== Number(owner.pid)
    || !Number.isSafeInteger(Number(identity.pid))
    || Number(identity.pid) <= 0
    || !Number.isSafeInteger(Number(identity.processGroupId))
    || Number(identity.processGroupId) <= 0
    || !String(identity.startedAt || '').trim()
  ) return null;
  return {
    format: SERVER_PROCESS_IDENTITY_FORMAT,
    pid: Number(identity.pid),
    processGroupId: Number(identity.processGroupId),
    startedAt: String(identity.startedAt),
  };
}

function writeServerOwnerClaim(
  claimDir: string,
  configDir: string,
  claimId: string,
  processIdentity: ServerProcessIdentity,
): void {
  fs.mkdirSync(claimDir, { mode: 0o700 });
  fs.writeFileSync(path.join(claimDir, 'owner.json'), `${JSON.stringify({
    claimId,
    pid: processIdentity.pid,
    configDir: canonicalConfigDir(configDir),
    processIdentity,
    phase: 'claiming',
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}

function quarantineServerOwnerLock(configDir: string, claimId: string): boolean {
  const lockDir = storageLayout.serverOwnerLockDir(configDir);
  const stale = `${lockDir}.stale-${claimId}`;
  try {
    fs.renameSync(lockDir, stale);
  } catch (error: unknown) {
    if (errorString(error, 'code') === 'ENOENT') return false;
    if (errorString(error, 'code') === 'EEXIST' || errorString(error, 'code') === 'ENOTEMPTY') return false;
    throw error;
  }
  return true;
}

function serverOwnerLockExists(lockDir: string): boolean {
  try {
    fs.lstatSync(lockDir);
    return true;
  } catch (error: unknown) {
    if (errorString(error, 'code') === 'ENOENT') return false;
    throw error;
  }
}

function acquireServerConfigOwner(
  configDir: string,
  currentPid = process.pid,
): ServerProcessIdentity {
  const canonicalDir = canonicalConfigDir(configDir);
  const currentIdentity = readServerProcessIdentity(currentPid);
  if (!currentIdentity) throw new Error('server process identity could not be committed before startup');
  const lockDir = storageLayout.serverOwnerLockDir(canonicalDir);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const claimId = crypto.randomUUID();
    const claimDir = `${lockDir}.claim-${claimId}`;
    let published = false;
    try {
      writeServerOwnerClaim(claimDir, canonicalDir, claimId, currentIdentity);
      if (!serverOwnerLockExists(lockDir)) {
        try {
          fs.renameSync(claimDir, lockDir);
          published = true;
        } catch (error: unknown) {
          if (errorString(error, 'code') !== 'EEXIST' && errorString(error, 'code') !== 'ENOTEMPTY') throw error;
        }
      }
      if (published) {
        try {
          assertServerProcessClaimAvailable(canonicalDir, currentPid);
        } catch (error) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          throw error;
        }
        return currentIdentity;
      }
    } finally {
      fs.rmSync(claimDir, { recursive: true, force: true });
    }

    const owner = readServerOwner(canonicalDir);
    const ownerPid = Number(owner.pid || owner.processIdentity?.pid || 0);
    const ownerIdentity = exactServerOwnerIdentity(owner);
    if (ownerPid === currentPid && ownerIdentity && matchingProcessIdentity(ownerIdentity, currentIdentity)) {
      return currentIdentity;
    }
    if (ownerPid > 0) {
      const liveOwner = readServerProcessIdentity(ownerPid);
      if (liveOwner && !ownerIdentity) {
        throw new Error(
          `Farming config directory owner lock names live PID ${ownerPid}, but its process identity is incomplete. `
          + 'Refusing to replace an owner that cannot be safely verified.',
        );
      }
      if (ownerIdentity && matchingProcessIdentity(ownerIdentity, liveOwner)) {
        throw new Error(
          `Farming config directory is already owned by live Server PID ${ownerPid}. `
          + 'Stop that Server before starting another one with the same config directory.',
        );
      }
    }
    const ownerClaimId = String(owner.claimId || '');
    if (!ownerIdentity || !/^[0-9a-f-]{36}$/i.test(ownerClaimId)) {
      throw new Error(
        'Farming config directory owner lock has no verifiable process identity. '
        + 'Prove that no Server uses this config directory before removing the lock manually.',
      );
    }
    if (!quarantineServerOwnerLock(canonicalDir, ownerClaimId)) continue;
  }
  throw new Error('Farming config directory ownership changed repeatedly during startup');
}

function releaseServerConfigOwner(
  configDir: string,
  expectedPid: number,
  expectedIdentity: ExpectedProcessIdentity | null | undefined,
): void {
  const owner = readServerOwner(configDir);
  const ownerIdentity = exactServerOwnerIdentity(owner);
  const claimId = String(owner.claimId || '');
  if (
    !ownerIdentity
    || Number(owner.pid) !== Number(expectedPid)
    || expectedIdentity?.format !== SERVER_PROCESS_IDENTITY_FORMAT
    || !matchingProcessIdentity(expectedIdentity, ownerIdentity)
    || !/^[0-9a-f-]{36}$/i.test(claimId)
  ) return;
  // Fence the exact published claim instead of deleting the shared path.
  // If a replacement already moved this claim and published a new owner, the
  // claim-specific quarantine path already exists and this rename cannot touch
  // the replacement.
  quarantineServerOwnerLock(configDir, claimId);
}

function clearProvenStaleServerConfigOwner(configDir: string): void {
  const lockDir = storageLayout.serverOwnerLockDir(configDir);
  if (!serverOwnerLockExists(lockDir)) return;
  const owner = readServerOwner(configDir);
  const ownerIdentity = exactServerOwnerIdentity(owner);
  const ownerPid = Number(owner.pid || owner.processIdentity?.pid || 0);
  const liveOwner = ownerPid > 0 ? readServerProcessIdentity(ownerPid) : null;
  if (liveOwner && !ownerIdentity) {
    throw new Error(
      `Farming config directory owner lock names live PID ${ownerPid}, but its process identity is incomplete. `
      + 'Refusing to remove an owner that cannot be safely verified.',
    );
  }
  if (ownerIdentity && matchingProcessIdentity(ownerIdentity, liveOwner)) {
    throw new Error(
      `Farming config directory is still owned by live Server PID ${ownerPid}, but its control metadata is incomplete. `
      + 'Retry after startup finishes or stop that exact process explicitly.',
    );
  }
  const claimId = String(owner.claimId || '');
  if (!ownerIdentity || !/^[0-9a-f-]{36}$/i.test(claimId)) {
    throw new Error(
      'Farming config directory owner lock has no verifiable process identity. '
      + 'Prove that no Server uses this config directory before removing the lock manually.',
    );
  }
  if (!quarantineServerOwnerLock(configDir, claimId)) {
    throw new Error('Farming config directory owner lock changed while stale ownership was being cleared; retry');
  }
}

function tailFile(file: string, lineCount = 80): string {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lineCount).join('\n').trim();
  } catch {
    return '';
  }
}

function entryUrl(env: NodeJS.ProcessEnv, host = 'localhost'): string {
  const basePath = normalizeBasePath(env.FARMING_BASE_PATH || DEFAULT_BASE_PATH) || '/';
  return `http://${host}:${env.PORT}${basePath}`;
}

function readTokenForEnv(env: NodeJS.ProcessEnv): string {
  const tokenFile = storageLayout.sessionTokenFile(env.FARMING_CONFIG_DIR || defaultConfigDir(env));
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function serverStartTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.FARMING_START_TIMEOUT_MS || env.FARMING_SERVER_START_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_SERVER_START_TIMEOUT_MS;
}

function serverStartStabilityMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.FARMING_START_STABILITY_MS || env.FARMING_SERVER_START_STABILITY_MS);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, 60_000);
  return DEFAULT_SERVER_START_STABILITY_MS;
}

function serverStopTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.FARMING_STOP_TIMEOUT_MS || env.FARMING_SERVER_STOP_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 120_000);
  return DEFAULT_SERVER_STOP_TIMEOUT_MS;
}

async function waitForDaemonStop(
  pid: number,
  port: number,
  options: WaitForDaemonStopOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs || DEFAULT_SERVER_STOP_TIMEOUT_MS;
  const processRunning = options.isRunning || isRunning;
  const portAvailable = options.canListenOnPort || canListenOnPort;
  const now = options.now || Date.now;
  const wait = options.wait || (durationMs => new Promise(resolve => setTimeout(resolve, durationMs)));
  const startedAt = now();
  let running = true;
  let released = false;

  while (true) {
    running = processRunning(pid);
    released = await portAvailable(port);
    if (!running && released) return;
    if (now() - startedAt >= timeoutMs) {
      throw new Error(
        `Farming server PID ${pid} did not stop and release port ${port} within ${timeoutMs}ms`
        + ` (process ${running ? 'still running' : 'exited'}, port ${released ? 'released' : 'still in use'})`,
      );
    }
    await wait(SERVER_STOP_POLL_MS);
  }
}

function waitForProcessStability(
  pid: number,
  durationMs = DEFAULT_SERVER_START_STABILITY_MS,
): Promise<void> {
  const startedAt = Date.now();
  return new Promise<void>((resolve, reject) => {
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

async function cleanupFailedDaemonStart(
  configDir: string,
  childPid: number,
  expectedIdentity: ExpectedProcessIdentity | null = null,
): Promise<void> {
  if (isRunning(childPid)) {
    const expected = expectedIdentity || readServerState(configDir).processIdentity;
    const current = readServerProcessIdentity(childPid);
    if (!matchingProcessIdentity(expected, current)) {
      throw new Error(`Failed Farming startup left live PID ${childPid} with an unproved identity; refusing to signal it`);
    }
    try {
      process.kill(childPid, 'SIGKILL');
    } catch (error: unknown) {
      if (errorString(error, 'code') === 'EPERM' || errorString(error, 'code') === 'EACCES') {
        throw new Error(
          `Failed Farming startup left Server PID ${childPid} running because cleanup lacks permission. `
          + 'Stop it as the operating-system user that owns the process, then retry.',
          { cause: error },
        );
      }
      if (errorString(error, 'code') !== 'ESRCH') throw error;
    }
    const startedAt = Date.now();
    while (matchingProcessIdentity(expected, readServerProcessIdentity(childPid))) {
      if (Date.now() - startedAt >= 5_000) {
        throw new Error(`Failed Farming startup left Server PID ${childPid} running after SIGKILL`);
      }
      await new Promise(resolve => setTimeout(resolve, SERVER_STOP_POLL_MS));
    }
  }
  if (readPid(configDir) === childPid) fs.rmSync(pidFile(configDir), { force: true });
  if (Number(readServerState(configDir).pid) === childPid) {
    fs.rmSync(serverStateFile(configDir), { force: true });
  }
  const activePackageRoot = String(process.env.FARMING_ACTIVE_PACKAGE_ROOT || '').trim();
  if (activePackageRoot) {
    const installation = resolvePackageInstallationContext(activePackageRoot, process.env);
    if (installation) {
      releasePackageImageUsage(
        installation,
        configDir,
        expectedIdentity?.format === SERVER_PROCESS_IDENTITY_FORMAT
          ? expectedIdentity as ServerProcessIdentity
          : null,
      );
    }
  }
  releaseServerConfigOwner(configDir, childPid, expectedIdentity);
}

function serverReadinessPath(
  env: ServerEnv,
  authDisabled: boolean,
  token = '',
): string {
  const basePath = env.FARMING_BASE_PATH || DEFAULT_BASE_PATH;
  if (authDisabled) return routePath(basePath, '/api/auth/status');
  return `${routePath(basePath, '/api/executables')}?token=${encodeURIComponent(token)}`;
}

function waitForServer(
  env: ServerEnv,
  timeoutMs = serverStartTimeoutMs(env),
  childPid = 0,
): Promise<void> {
  const startedAt = Date.now();
  const port = Number(env.PORT || DEFAULT_PORT);
  const authDisabled = ['1', 'true', 'yes', 'on'].includes(String(env.FARMING_DISABLE_AUTH || '').toLowerCase());

  return new Promise<void>((resolve, reject) => {
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
      const readyPath = serverReadinessPath(env, authDisabled, token);
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

async function runServerInCurrentProcess(): Promise<void> {
  const env = canonicalizeServerConfigDir(buildServerEnv());
  process.env = env;
  const processIdentity = acquireServerConfigOwner(env.FARMING_CONFIG_DIR);
  const activePackageRoot = String(env.FARMING_ACTIVE_PACKAGE_ROOT || '').trim();
  const packageInstallation = activePackageRoot
    ? resolvePackageInstallationContext(activePackageRoot, env)
    : null;
  const packageImage = activePackageRoot ? readPackageImageRef(activePackageRoot) : null;
  if (packageInstallation && packageImage) {
    registerPackageImageUsage(
      packageInstallation,
      env.FARMING_CONFIG_DIR,
      packageImage,
      processIdentity,
    );
  }
  fs.writeFileSync(pidFile(env.FARMING_CONFIG_DIR), String(process.pid), { mode: 0o600 });
  writeServerState(env.FARMING_CONFIG_DIR, env, process.pid, processIdentity, 'starting');
  const { startServer } = require('./server.cjs') as {
    startServer(): {
      once(event: 'listening', callback: () => void): void;
    };
  };
  const server = startServer();
  server.once('listening', () => {
    writeServerState(
      env.FARMING_CONFIG_DIR,
      env,
      process.pid,
      processIdentity,
      'running',
    );
    const { pruneRuntimeDependencies } = require('./runtime-dependency-manager.cjs') as {
      pruneRuntimeDependencies(options: {
        configDir: string;
        env: NodeJS.ProcessEnv;
      }): Promise<unknown>;
    };
    void pruneRuntimeDependencies({
      configDir: env.FARMING_CONFIG_DIR,
      env,
    }).catch((error: unknown) => {
      console.warn(`Startup dependency cache cleanup failed: ${errorString(error) || error}`);
    });
    if (packageInstallation) {
      try {
        prunePackageImages(packageInstallation);
      } catch (error: unknown) {
        console.warn(`Farming package image cleanup failed: ${errorString(error) || error}`);
      }
    }
  });
}

function runNativePtyHostInCurrentProcess(): void {
  const { startNativePtyHostProcess } = require('./native-pty-host.cjs') as {
    startNativePtyHostProcess(): void;
  };
  startNativePtyHostProcess();
}

async function prepareStartupDependencies(
  env: ServerEnv,
  options: PrepareStartupOptions = {},
): Promise<unknown> {
  if (
    options.force !== true
    && (env.FARMING_SKIP_RUNTIME_PREPARE === '1' || env.NODE_ENV === 'test')
  ) {
    return { skipped: true };
  }
  const { prepareRuntimeDependencies } = require('./runtime-dependency-manager.cjs') as {
    prepareRuntimeDependencies(options: {
      activate?: boolean;
      configDir: string;
      env: NodeJS.ProcessEnv;
      onProgress?: (progress: RuntimeDependencyProgress) => void;
    }): Promise<unknown>;
  };
  const progress = createRuntimeDependencyProgressRenderer({ env, stream: process.stderr });
  try {
    const result = await prepareRuntimeDependencies({
      activate: options.activate,
      configDir: env.FARMING_CONFIG_DIR,
      env,
      onProgress: progress.report,
    });
    progress.finish();
    return result;
  } catch (error: unknown) {
    progress.abort();
    throw error;
  }
}

async function startForeground(parsed: ParsedServerOperation): Promise<void> {
  const env = canonicalizeServerConfigDir(buildServerEnv(parsed.env));
  await prepareStartupDependencies(env);
  await adaptServerPort(env, parsed);
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

async function startDaemon(parsed: ParsedServerOperation): Promise<number> {
  const env = await adaptServerPort(canonicalizeServerConfigDir(buildServerEnv(parsed.env)), parsed);
  env[SERVER_MODE_ENV] = '1';
  const configDir = env.FARMING_CONFIG_DIR;
  ensureConfigDir(configDir);

  const existingPid = readPid(configDir);
  if (isRunning(existingPid)) {
    const state = readServerState(configDir);
    try {
      if (state.processIdentity?.format === SERVER_PROCESS_IDENTITY_FORMAT) {
        await assertServerProcessIdentity(configDir, existingPid, state);
      } else {
        await migrateLegacyServerIdentity(configDir, existingPid, state);
      }
    } catch (error: unknown) {
      console.error(
        `Farming PID ${existingPid} is live, but this config directory does not prove that it owns the Server: `
        + `${errorString(error) || error}`,
      );
      return 1;
    }
    if (state.phase === 'starting') {
      console.log(`Farming is already starting (PID ${existingPid})`);
      return 0;
    } else {
      if (state.port) env.PORT = String(state.port);
      if (state.basePath) env.FARMING_BASE_PATH = state.basePath;
      console.log(`Farming is already running (PID ${existingPid})`);
      console.log(entryUrl(env));
      return 0;
    }
  }

  await prepareStartupDependencies(env);
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
  const childPid = child.pid;
  if (!childPid) throw new Error('server process did not report its PID after launch');
  child.unref();
  let processIdentity = null;
  try {
    processIdentity = await readServerProcessIdentity(childPid);
    if (!processIdentity) throw new Error('server process identity could not be verified after launch');
    await waitForServer(env, serverStartTimeoutMs(env), childPid);
    await waitForProcessStability(childPid, serverStartStabilityMs(env));
    await waitForServer(env, Math.min(serverStartTimeoutMs(env), 5_000), childPid);
    const stableIdentity = await readServerProcessIdentity(childPid);
    if (
      !stableIdentity
      || stableIdentity.processGroupId !== processIdentity.processGroupId
      || stableIdentity.startedAt !== processIdentity.startedAt
    ) {
      throw new Error('server process identity changed during startup');
    }
    writeServerState(configDir, env, childPid, stableIdentity, 'running');
  } catch (error: unknown) {
    try {
      await cleanupFailedDaemonStart(configDir, childPid, processIdentity);
    } catch (cleanupError: unknown) {
      console.error(
        `${errorString(error)}; cleanup failed: ${errorString(cleanupError) || cleanupError}`,
      );
      return 1;
    }
    console.error(errorString(error));
    const logs = tailFile(logFile(configDir), 80);
    if (logs) console.error(logs);
    return 1;
  }

  console.log(`Farming started (PID ${childPid})`);
  const logs = tailFile(logFile(configDir), 40);
  const urlLines = logs.split(/\r?\n/).filter(line => /Local:|Network:|Token:|Token style:|Token auth:/.test(line));
  if (urlLines.length > 0) {
    console.log(urlLines.join('\n'));
  } else {
    console.log(entryUrl(env));
  }
  return 0;
}

async function stopDaemon(parsed: ParsedServerOperation): Promise<number> {
  const env = canonicalizeServerConfigDir(buildServerEnv(parsed.env));
  const configDir = env.FARMING_CONFIG_DIR;
  const pid = readPid(configDir);
  if (!isRunning(pid)) {
    clearProvenStaleServerConfigOwner(configDir);
    fs.rmSync(pidFile(configDir), { force: true });
    fs.rmSync(serverStateFile(configDir), { force: true });
    console.log('Farming is not running.');
    return 0;
  }
  const state = readServerState(configDir);
  const port = Number(state.port || env.PORT || DEFAULT_PORT);
  if (state.processIdentity?.format === SERVER_PROCESS_IDENTITY_FORMAT) {
    await assertServerProcessIdentity(configDir, pid, state);
  } else {
    await migrateLegacyServerIdentity(configDir, pid, state);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error: unknown) {
    if (errorString(error, 'code') === 'EPERM' || errorString(error, 'code') === 'EACCES') {
      throw new Error(
        `Farming cannot stop server ${pid} because this command lacks permission. `
        + 'Run it as the operating-system user that owns the process (or as an administrator), then start Farming again.',
        { cause: error },
      );
    }
    if (errorString(error, 'code') !== 'ESRCH') throw error;
  }
  await waitForDaemonStop(pid, port, { timeoutMs: serverStopTimeoutMs(env) });
  if (readPid(configDir) === pid) fs.rmSync(pidFile(configDir), { force: true });
  if (Number(readServerState(configDir).pid) === pid) fs.rmSync(serverStateFile(configDir), { force: true });
  const activePackageRoot = String(env.FARMING_ACTIVE_PACKAGE_ROOT || '').trim();
  if (activePackageRoot) {
    const installation = resolvePackageInstallationContext(activePackageRoot, env);
    if (installation) {
      releasePackageImageUsage(installation, configDir, state.processIdentity as ServerProcessIdentity);
    }
  }
  releaseServerConfigOwner(configDir, pid, state.processIdentity);
  console.log(`Stopped Farming (PID ${pid})`);
  return 0;
}

async function statusDaemon(parsed: ParsedServerOperation): Promise<number> {
  const env = canonicalizeServerConfigDir(buildServerEnv(parsed.env));
  const configDir = env.FARMING_CONFIG_DIR;
  const pid = readPid(configDir);
  if (!isRunning(pid)) {
    console.log('Farming is not running.');
    return 0;
  }
  const state = readServerState(configDir);
  try {
    if (state.processIdentity?.format === SERVER_PROCESS_IDENTITY_FORMAT) {
      await assertServerProcessIdentity(configDir, pid, state);
    } else {
      await migrateLegacyServerIdentity(configDir, pid, state);
    }
  } catch (error: unknown) {
    console.error(
      `Farming PID ${pid} is live, but this config directory does not prove that it owns the Server: `
      + `${errorString(error) || error}`,
    );
    return 1;
  }
  if (state.phase === 'starting') {
    console.log(`Farming is starting (PID ${pid}). Run 'farming start' to replace an interrupted startup.`);
    return 1;
  }
  console.log(`Farming is running (PID ${pid})`);
  const logs = tailFile(logFile(configDir), 30);
  if (logs) console.log(logs);
  return 0;
}

function showLogs(parsed: ParsedServerOperation): number {
  const env = buildServerEnv(parsed.env);
  const logs = tailFile(logFile(env.FARMING_CONFIG_DIR), 120);
  console.log(logs || 'No Farming log found.');
  return 0;
}

function showUrl(parsed: ParsedServerOperation): number {
  const env = buildServerEnv(parsed.env);
  if (!parsed.portExplicit && !isPortOverrideExplicit(parsed.env, process.env)) {
    const state = readServerState(env.FARMING_CONFIG_DIR);
    if (state.port) env.PORT = String(state.port);
    if (state.basePath) env.FARMING_BASE_PATH = state.basePath;
  }
  console.log(entryUrl(env));
  return 0;
}

function usage(): string {
  return `Usage:
  farming [start] [--port 6694] [--base-path /farming] [--config-dir ~/.farming]
  farming daemon [--port 6694] [--base-path /farming] [--config-dir ~/.farming]
  farming status
  farming stop
  farming logs
  farming url
  farming runtime prepare [--config-dir ~/.farming] [--no-activate]
  farming review <git-dir> <old-revision> <new-revision|now> [--branch <branch>] [--no-open]

Agent control commands are also available:
  farming skills
  farming capabilities [--json]
  farming browser ...
  farming computer ...
  farming list [--json] [--parent <agentId>]
  farming spawn --workspace <repo> -- <command...>
  farming output <agentId> [--tail <chars>]
  farming send <agentId> <text...>
  farming title <concise-title...>
  farming kill <agentId>`;
}

async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (process.env.FARMING_DEBUG_CLI === '1' && argv[0] === 'debug-argv') {
    console.log(JSON.stringify({
      argv: process.argv,
      execPath: process.execPath,
      pkg: Boolean(packagedProcess.pkg),
    }, null, 2));
    return 0;
  }

  if (argv[0] === PACKAGED_CODEX_ACP_ARG) {
    await runPackagedCodexAcp();
    return 0;
  }

  if (argv[0] === PACKAGED_CLAUDE_ACP_ARG) {
    await runPackagedClaudeAcp();
    return 0;
  }

  if (argv[0] === USAGE_HISTORY_SMOKE_ARG) {
    const { runUsageHistorySmoke } = require('./usage-history-smoke.cjs');
    const result = await runUsageHistorySmoke();
    console.log(JSON.stringify(result));
    return 0;
  }

  if (
    argv[0] === NATIVE_PTY_HOST_ARG
    || (argv.length === 0 && process.env.FARMING_RUN_NATIVE_PTY_HOST === '1')
  ) {
    runNativePtyHostInCurrentProcess();
    return 0;
  }

  if (
    argv[0] === SERVER_MODE_ARG
    || (argv.length === 0 && process.env[SERVER_MODE_ENV] === '1')
  ) {
    await runServerInCurrentProcess();
    return 0;
  }

  if (argv[0] === 'browser') {
    const { run: runBrowserCli } = require('../extensions/browser/bin/farming-browser');
    return runBrowserCli(argv.slice(1));
  }

  if (argv[0] === 'computer') {
    const { run: runComputerCli } = require('../extensions/computer/bin/farming-computer');
    return runComputerCli(argv.slice(1));
  }

  if (argv[0] === 'runtime' && argv[1] === 'prepare') {
    const activate = !argv.slice(2).includes('--no-activate');
    const parsed = parseServerArgs([
      'start',
      ...argv.slice(2).filter(arg => arg !== '--no-activate'),
    ]);
    const env = buildServerEnv(parsed.env);
    const result = await prepareStartupDependencies(env, { activate, force: true });
    console.log(JSON.stringify(result, null, 2));
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
  }).catch((error: unknown) => {
    console.error(errorString(error) || error);
    process.exit(1);
  });
}

export {
  SERVER_MODE_ARG,
  NATIVE_PTY_HOST_ARG,
  buildCleanEnvExecArgs,
  buildCleanEnvExecCommand,
  childInvocation,
  cleanupFailedDaemonStart,
  buildControlEnv,
  buildServerEnv,
  acquireServerConfigOwner,
  assertServerProcessClaimAvailable,
  canonicalizeServerConfigDir,
  computeNodeHeapMb,
  defaultConfigDir,
  findAvailablePort,
  parseServerArgs,
  parseReviewArgs,
  resolveReviewTarget,
  reviewUrl,
  readServerState,
  readServerProcessIdentity,
  releaseServerConfigOwner,
  serverReadinessPath,
  serverStartTimeoutMs,
  serverStartStabilityMs,
  serverStopTimeoutMs,
  splitControlArgs,
  stopDaemon,
  run,
  serverStateFile,
  waitForDaemonStop,
};
