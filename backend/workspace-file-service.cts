const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { diffChars } = require('diff');
const { execFile, spawn } = require('child_process');
const readline = require('readline');
import { isSameOrDescendantPath as isInside } from './path-containment.cjs';
import { assertManagedRipgrep } from './ripgrep-runtime.cjs';

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_WRITE_SIZE = 2 * 1024 * 1024;
const DEFAULT_MAX_PREVIEW_FILE_SIZE = 8 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_GIT_CHANGES_LIMIT = 500;
const DEFAULT_GIT_CHANGES_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_GIT_STATUS_CACHE_TTL_MS = 30000;
const DEFAULT_GIT_STATUS_TIMEOUT_MS = 15000;
const DEFAULT_SEARCH_TIMEOUT_MS = 3000;
const DEFAULT_BLAME_TIMEOUT_MS = 5000;
const DEFAULT_BLAME_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_ISSUE_NAVIGATION_MAX_SIZE = 256 * 1024;
const DEFAULT_DIFF_TIMEOUT_MS = 5000;
const DEFAULT_DIFF_MAX_BUFFER = 1024 * 1024;
const DEFAULT_GIT_HISTORY_LIMIT = 50;
const MAX_GIT_HISTORY_LIMIT = 100;
const DEFAULT_GIT_HISTORY_TIMEOUT_MS = 5000;
const DEFAULT_GIT_HISTORY_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_WATCH_DEPTH = 1;
const MAX_EXACT_WATCH_PATHS_PER_SUBSCRIPTION = 256;
const MAX_EXACT_WATCH_TARGETS_PER_WORKSPACE = 1_024;
const EXACT_WATCH_PATH_RESOLVE_CONCURRENCY = 16;
const SEARCH_FILE_LIST_MAX_BUFFER = 16 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const PATH_SEARCH_MIN_CANDIDATES = 120;
const PATH_SEARCH_CANDIDATE_MULTIPLIER = 8;
const MAX_GIT_CHECK_IGNORE_ARG_BYTES = 128 * 1024;

interface WorkspaceFileErrorDetails {
  [key: string]: unknown;
}

interface CommandExecutionOptions {
  cwd?: string;
  encoding?: BufferEncoding | 'buffer';
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  signal?: AbortSignal;
  timeout?: number;
}

interface CommandResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

interface CommandRunnerOptions {
  disableHelper?: boolean;
  helperPath?: string;
  nodePath?: string;
}

interface WorkspaceCommandRunner {
  run(command: string, args: string[], options?: CommandExecutionOptions): Promise<CommandResult>;
  dispose(): void;
}

interface WorkspaceFileServiceOptions {
  blameTimeoutMs?: number;
  commandRunner?: WorkspaceCommandRunner;
  commandRunnerOptions?: CommandRunnerOptions;
  diffMaxBuffer?: number;
  diffTimeoutMs?: number;
  flushWorkspaceWrites?: boolean;
  gitHistoryMaxBuffer?: number;
  gitHistoryTimeoutMs?: number;
  gitPath?: string;
  gitStatusCacheTtlMs?: number;
  gitStatusTimeoutMs?: number;
  maxFileSize?: number;
  maxPreviewFileSize?: number;
  maxWriteSize?: number;
  /** Explicit native ripgrep injection for tests. Production uses Farming's managed runtime. */
  rgPath?: string;
  searchLimit?: number;
  searchTimeoutMs?: number;
  watchDepth?: number;
  watchOptions?: Record<string, unknown>;
}

interface PathSearchResult {
  matches: PathSearchMatch[];
  truncated: boolean;
}

interface ProcessError extends Error {
  code?: string | number;
  signal?: NodeJS.Signals | string | null;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
}

interface ResolvePathOptions {
  allowMissing?: boolean;
  allowedExternalRoots?: string[];
}

interface ResolvedWorkspacePath {
  actualRelativePath: string;
  external?: boolean;
  readOnly?: boolean;
  relativePath: string;
  root: string;
  symbolicLink?: boolean;
  target: string;
}

interface WorkspaceEntryVersionOptions {
  expectedVersion?: unknown;
}

interface WorkspaceWriteOptions {
  baseSha1?: unknown;
  overwrite?: boolean;
}

interface WorkspaceEntryMutationResult {
  sourceDirectory: string;
  sourcePath: string;
  sourceVersion?: string;
  targetDirectory: string;
  targetPath: string;
  targetVersion?: string;
}

interface WorkspaceDeleteResult {
  parentDirectory: string;
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  version: string;
}

interface WorkspaceFileEvent {
  message?: string;
  path?: string;
  type: string;
}

type WorkspaceFileSubscriber = (event: WorkspaceFileEvent) => void;

interface ChokidarWatcher {
  add(paths: string | string[]): ChokidarWatcher;
  close(): void | Promise<void>;
  getWatched(): Record<string, string[]>;
  on(event: string, callback: (...args: unknown[]) => void): ChokidarWatcher;
  off(event: string, callback: (...args: unknown[]) => void): ChokidarWatcher;
  once(event: string, callback: (...args: unknown[]) => void): ChokidarWatcher;
  unwatch(paths: string | string[]): ChokidarWatcher;
}

interface ChokidarModule {
  watch(path: string | string[], options: Record<string, unknown>): ChokidarWatcher;
}

interface WorkspaceWatcherRecord {
  cancelled: boolean;
  cancelInitialization: (() => void) | null;
  closePromise: Promise<void> | null;
  generation: number;
  ready: Promise<boolean> | null;
  subscribers: Set<WorkspaceFileSubscriber>;
  watcher: ChokidarWatcher | null;
}

interface ExactWorkspaceFileSubscription {
  update(paths: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

interface ExactWorkspaceWatcherRecord {
  closePromise: Promise<void> | null;
  pathSubscribers: Map<string, Set<WorkspaceFileSubscriber>>;
  pathTargets: Map<string, string>;
  ready: Promise<boolean>;
  root: string;
  subscribers: Map<WorkspaceFileSubscriber, Set<string>>;
  targetPaths: Map<string, Set<string>>;
  updateQueue: Promise<void>;
  watcher: ChokidarWatcher | null;
}

interface GitStatusEntry {
  kind: string;
  label?: string;
  path: string;
  previousPath?: string;
  [key: string]: unknown;
}

interface PathSearchMatch {
  entryType: 'directory' | 'file';
  kind?: 'path';
  lineNumber?: number;
  lines?: string;
  path: string;
  ranges?: unknown[];
  score?: number;
}

interface GitHistoryReference {
  category: string;
  id: string;
  name: string;
}

interface BlameEntry {
  author: string;
  authorMail: string;
  authorTime: number | null;
  authorTimeIso: string;
  commit: string;
  content: string;
  lineNumber: number;
  originalLineNumber: number;
  summary: string;
}

interface DiffHunk {
  header: string;
  heading: string;
  newLines: number;
  newStart: number;
  oldLines: number;
  oldStart: number;
  patch?: string;
  patchLines: string[];
}

interface DiffCell {
  intraline?: Array<{ start: number; end: number }>;
  line: number;
  missingNewlineAtEnd?: boolean;
  text: string;
}

interface DiffRow {
  kind: string;
  left?: DiffCell;
  right?: DiffCell;
}

type GitStatusMap = Map<string, GitStatusEntry> & { truncated?: boolean };

interface GitStatusCacheEntry {
  expiresAt: number;
  promise?: Promise<GitStatusMap>;
  value?: GitStatusMap;
}

function processError(value: unknown): ProcessError {
  if (value instanceof Error) return value as ProcessError;
  return Object.assign(new Error(String(value)), { cause: value }) as ProcessError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
const IMAGE_PREVIEW_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
]);
const TEXT_IMAGE_PREVIEW_EXTENSIONS = new Set(['.svg']);
const IGNORED_NAMES = new Set([
  '.git',
  '.farming',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.vite',
]);
const SEARCH_IGNORED_NAMES = new Set([
  ...IGNORED_NAMES,
  '.dolt',
  '.doltcfg',
  '.idea',
  '.vscode',
  '.tmp',
  '.DS_Store',
  'dist-release',
  'reference',
  'test-results',
  'playwright-report',
  'server.log',
  'local-farming.log',
  '.turbo',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
]);
const EXPANDED_SEARCH_IGNORED_NAMES = new Set([
  '.git',
  '.DS_Store',
  'server.log',
  'local-farming.log',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.vite',
  '.turbo',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
  'test-results',
  'playwright-report',
]);
const HIDDEN_NAMES = new Set([
  ...IGNORED_NAMES,
  '.dolt',
  '.doltcfg',
  '.idea',
  '.vscode',
  '.tmp',
  '.DS_Store',
  'dist-release',
  'reference',
  'test-results',
  'playwright-report',
  'server.log',
  'local-farming.log',
  '.turbo',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
]);
const TREE_HIDDEN_NAMES = new Set([
  '.git',
  '.DS_Store',
  'server.log',
  'local-farming.log',
]);

function gitDiffWhitespaceArgs(value: unknown): string[] {
  if (value === 'ALL' || value === 'IGNORE_ALL') return ['--ignore-all-space'];
  if (value === 'TRAILING' || value === 'IGNORE_TRAILING') return ['--ignore-space-at-eol'];
  if (value === 'LEADING_AND_TRAILING' || value === 'IGNORE_LEADING_AND_TRAILING') return ['--ignore-space-change'];
  return [];
}

function gitDiffContextArgs(value: unknown): string[] {
  const context = Number(value);
  if (!Number.isInteger(context) || context < 0) return [];
  return [`--unified=${Math.min(context, 10000)}`];
}

class WorkspaceFileError extends Error {
  details: WorkspaceFileErrorDetails;
  statusCode: number;
  constructor(message: string, statusCode = 400, details: WorkspaceFileErrorDetails = {}) {
    super(message);
    this.name = 'WorkspaceFileError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function resolveCommandRunnerNodePath(options: CommandRunnerOptions = {}) {
  return options.nodePath || process.env.FARMING_NODE_BIN || process.execPath;
}

function isPackagedRuntime() {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg)
    || process.env.FARMING_PACKAGED_RUNTIME === '1';
}

let chokidarPromise: Promise<ChokidarModule> | null = null;

async function loadChokidar(): Promise<ChokidarModule> {
  if (!chokidarPromise) {
    chokidarPromise = import('chokidar').then(module => (module.default || module) as ChokidarModule);
  }
  return await chokidarPromise;
}

function watcherHasTarget(watcher: ChokidarWatcher, target: string): boolean {
  const targetDirectory = path.dirname(target);
  const targetName = path.basename(target);
  return Object.entries(watcher.getWatched()).some(([directory, entries]) => (
    path.resolve(directory) === targetDirectory && entries.includes(targetName)
  ));
}

async function waitForWatcherTargets(watcher: ChokidarWatcher, targets: readonly string[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!targets.every(target => watcherHasTarget(watcher, target))) {
    if (Date.now() >= deadline) {
      throw new WorkspaceFileError('timed out while watching open files', 504);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForWatcherReady(watcher: ChokidarWatcher): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: WorkspaceFileError) => {
      clearTimeout(timeout);
      watcher.off('ready', onReady);
      watcher.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = (caught: unknown) => {
      const error = processError(caught);
      finish(new WorkspaceFileError(`failed to watch open files: ${error.message}`, 503));
    };
    const timeout = setTimeout(() => {
      finish(new WorkspaceFileError('timed out while watching open files', 504));
    }, 2_000);
    watcher.once('ready', onReady);
    watcher.once('error', onError);
  });
}

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}

class CommandRunner implements WorkspaceCommandRunner {
  child: import('child_process').ChildProcessWithoutNullStreams | null;
  helperPath: string;
  nextId: number;
  nodePath: string;
  pending: Map<string, {
    resolve: (value: CommandResult) => void;
    reject: (reason?: unknown) => void;
  }>;
  ready: boolean;
  constructor(options: CommandRunnerOptions = {}) {
    this.helperPath = options.helperPath || path.join(__dirname, 'command-runner-child.cjs');
    this.nodePath = resolveCommandRunnerNodePath(options);
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.ready = false;
    if (!options.disableHelper && !isPackagedRuntime()) {
      this.start();
    }
  }

  start() {
    try {
      this.child = spawn(this.nodePath, [this.helperPath], {
        cwd: __dirname,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.child = null;
      return;
    }

    const child = this.child;
    if (!child) return;
    this.ready = true;
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line: string) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        return;
      }

      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);

      if (response.ok) {
        pending.resolve({
          stdout: response.stdout || '',
          stderr: response.stderr || '',
        });
        return;
      }

      const error = new Error(response.error?.message || 'command failed') as ProcessError;
      error.code = response.error?.code;
      error.signal = response.error?.signal;
      error.stdout = response.error?.stdout || '';
      error.stderr = response.error?.stderr || '';
      pending.reject(error);
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = String(data || '').trim();
      if (text) console.error('Workspace command helper:', text);
    });

    child.on('error', () => {
      this.ready = false;
      this.child = null;
      const pending = Array.from(this.pending.values());
      this.pending.clear();
      pending.forEach(({ reject }) => reject(new Error('workspace command helper failed')));
    });

    child.on('exit', () => {
      this.ready = false;
      this.child = null;
      const pending = Array.from(this.pending.values());
      this.pending.clear();
      pending.forEach(({ reject }) => reject(new Error('workspace command helper exited')));
    });
  }

  run(command: string, args: string[], options: CommandExecutionOptions = {}): Promise<CommandResult> {
    if (!this.ready || !this.child || !this.child.stdin.writable) {
      return execFileAsync(command, args, options);
    }

    const id = String(this.nextId++);
    const child = this.child;
    const request = {
      id,
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
    };

    return new Promise<CommandResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(request)}\n`, (error: Error | null | undefined) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  dispose() {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.ready = false;
  }
}

function isInsideAnyRoot(roots: unknown, target: string): boolean {
  return (Array.isArray(roots) ? roots : []).some((root) => {
    let realRoot = root;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      // Missing allowed roots cannot authorize a resolved target.
    }
    return isInside(realRoot, target);
  });
}

function joinRelativePath(parentPath: unknown, name: unknown): string {
  return [String(parentPath || '').replace(/\/+$/, ''), name]
    .filter(Boolean)
    .join('/')
    .replace(/\\/g, '/');
}

function normalizeUserPath(userPath: unknown = ''): string {
  const value = String(userPath || '').trim();
  if (!value || value === '.') return '';
  if (path.isAbsolute(value)) {
    throw new WorkspaceFileError('absolute paths are not allowed', 400);
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new WorkspaceFileError('path must stay inside the workspace', 403);
  }
  return normalized === '.' ? '' : normalized;
}

function relativeFromRoot(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative.split(path.sep).join('/');
}

function normalizeSearchResultPath(resultPath: unknown): string {
  return String(resultPath || '').replace(/^\.\//, '');
}

function searchIgnoredNames(includeIgnored = false) {
  return includeIgnored ? EXPANDED_SEARCH_IGNORED_NAMES : SEARCH_IGNORED_NAMES;
}

function searchExcludeGlobArgs() {
  const args: string[] = [];
  SEARCH_IGNORED_NAMES.forEach((name) => {
    args.push('--glob', `!${name}/**`);
    args.push('--glob', `!**/${name}/**`);
  });
  return args;
}

function isSearchIgnoredRelativePath(relativePath: unknown, includeIgnored = false): boolean {
  return String(relativePath || '').split(/[\\/]/).some(part => searchIgnoredNames(includeIgnored).has(part));
}

function shouldPruneDirectoryNameSearch(relativePath: unknown): boolean {
  return String(relativePath || '').split(/[\\/]/).some(part => IGNORED_NAMES.has(part));
}

function gitStatusExcludePathspecArgs() {
  const args = ['--', '.'];
  HIDDEN_NAMES.forEach((name) => {
    args.push(`:(exclude)${name}`);
    args.push(`:(exclude)${name}/**`);
    args.push(`:(exclude)**/${name}`);
    args.push(`:(exclude)**/${name}/**`);
  });
  return args;
}

function gitSearchExcludePathspecArgs(includeIgnored = false, searchPath = '.') {
  const args = ['--', searchPath];
  searchIgnoredNames(includeIgnored).forEach((name) => {
    args.push(`:(exclude)${name}`);
    args.push(`:(exclude)${name}/**`);
    args.push(`:(exclude)**/${name}`);
    args.push(`:(exclude)**/${name}/**`);
  });
  return args;
}

function normalizeGitStatusPath(resultPath: unknown): string {
  return normalizeSearchResultPath(resultPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function sha1(buffer: import('crypto').BinaryLike): string {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function previewForPath(filePath: string, options: { includeTextImages?: boolean } = {}) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.pdf') return { kind: 'pdf', mediaType: 'application/pdf' };
  if (!options.includeTextImages && TEXT_IMAGE_PREVIEW_EXTENSIONS.has(extension)) return null;
  const mediaType = IMAGE_PREVIEW_MEDIA_TYPES.get(extension);
  return mediaType ? { kind: 'image', mediaType } : null;
}

function metadataFileVersion(relativePath: string, stat: import('fs').Stats): string {
  return sha1(Buffer.from(`${relativePath}:${stat.size}:${stat.mtimeMs}`, 'utf8'));
}

function workspaceEntryVersion(stat: import('fs').Stats): string {
  return sha1(Buffer.from([
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(':'), 'utf8'));
}

async function readTextPrefix(target: string, maxBytes: number): Promise<string> {
  const handle = await fsp.open(target, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function isProbablyBinaryFile(target: string): Promise<boolean> {
  const handle = await fsp.open(target, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    if (bytesRead === 0) return false;

    let suspiciousControlBytes = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      const byte = buffer[index];
      if (byte === 0) return true;
      const isAllowedControl = byte === 7 || byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 27;
      if (byte < 32 && !isAllowedControl) {
        suspiciousControlBytes += 1;
      }
    }

    return suspiciousControlBytes / bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}

function shouldIgnorePath(filePath: string): boolean {
  return filePath.split(path.sep).some(part => IGNORED_NAMES.has(part));
}

function shouldHidePath(filePath: unknown): boolean {
  return String(filePath || '').split(/[\\/]/).some(part => HIDDEN_NAMES.has(part));
}

function normalizeEntryName(name: unknown): string {
  const value = String(name || '').trim();
  if (!value || value === '.' || value === '..') {
    throw new WorkspaceFileError('name is required', 400);
  }
  if (value.includes('/') || value.includes('\\') || path.basename(value) !== value) {
    throw new WorkspaceFileError('name must be a single path segment', 400);
  }
  if (IGNORED_NAMES.has(value)) {
    throw new WorkspaceFileError('ignored paths cannot be changed', 403);
  }
  return value;
}

function parentDirectory(filePath: unknown): string {
  const normalized = String(filePath || '').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

/**
 * Git translates its diagnostics through gettext, so on a localized machine
 * stderr no longer matches the English phrases that classify a missing
 * repository, a repository without commits, or a path that is absent from a
 * revision. Every Farming git invocation therefore pins the message locale.
 */
const GIT_MESSAGE_LOCALE_ENV: NodeJS.ProcessEnv = {
  LANG: 'C',
  LANGUAGE: 'C',
  LC_ALL: 'C',
  LC_MESSAGES: 'C',
};

/**
 * Git octal-quotes non-ASCII paths in the commands that are not read with `-z`,
 * which would never match the real relative paths Farming compares them to.
 * Reading every path as raw UTF-8 keeps one path identity across git commands.
 */
const GIT_PATH_ENCODING_ARGS = ['-c', 'core.quotepath=false'];

function gitCommandEnvironment(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...env, ...GIT_MESSAGE_LOCALE_ENV };
}

function gitCommandArgs(args: string[]): string[] {
  return [...GIT_PATH_ENCODING_ARGS, ...args];
}

function execFileAsync(command: string, args: string[], options: CommandExecutionOptions = {}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      ...options,
      // The command helper merges request environments onto its own process
      // environment; keep the direct path identical so a packaged runtime does
      // not run commands with a stripped environment.
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    }, (error: ProcessError | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function gitStatusKind(statusCode: unknown): string {
  const code = String(statusCode || '');
  if (code.length < 2) return 'modified';
  if (code === '??') return 'untracked';
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  if (code.includes('M')) return 'modified';
  return 'modified';
}

function gitStatusLabel(kind: unknown): string {
  if (kind === 'added') return 'A';
  if (kind === 'deleted') return 'D';
  if (kind === 'renamed') return 'R';
  if (kind === 'untracked') return 'U';
  if (kind === 'conflicted') return '!';
  return 'M';
}

function gitStatusReviewRank(kind: unknown): number {
  if (kind === 'conflicted') return 0;
  if (kind === 'modified') return 1;
  if (kind === 'added') return 2;
  if (kind === 'deleted') return 3;
  if (kind === 'renamed') return 4;
  if (kind === 'untracked') return 5;
  return 6;
}

function normalizeGitHistoryLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_GIT_HISTORY_LIMIT;
  return Math.min(parsed, MAX_GIT_HISTORY_LIMIT);
}

function normalizeGitHistorySkip(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 1_000_000);
}

function normalizeGitObjectId(value: unknown, fieldName = 'commit'): string {
  const normalized = String(value || '').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(normalized)) {
    throw new WorkspaceFileError(`${fieldName} must be a full git object id`, 400);
  }
  return normalized.toLowerCase();
}

function gitEmptyTreeObjectId(objectFormat: unknown): string {
  const algorithm = objectFormat === 'sha256' ? 'sha256' : 'sha1';
  return crypto.createHash(algorithm).update(Buffer.from('tree 0\0')).digest('hex');
}

function gitHistoryReference(value: unknown): GitHistoryReference | null {
  let id = String(value || '').trim();
  if (!id) return null;
  if (id.startsWith('tag: ')) id = id.slice(5);
  if (id === 'HEAD') return { id, name: id, category: 'head' };
  if (id.startsWith('refs/heads/')) {
    return { id, name: id.slice('refs/heads/'.length), category: 'local-branch' };
  }
  if (id.startsWith('refs/remotes/')) {
    if (/\/HEAD$/.test(id)) return null;
    return { id, name: id.slice('refs/remotes/'.length), category: 'remote-branch' };
  }
  if (id.startsWith('refs/tags/')) {
    return { id, name: id.slice('refs/tags/'.length), category: 'tag' };
  }
  return { id, name: id.replace(/^refs\//, ''), category: 'reference' };
}

function parseGitHistoryReferences(value: unknown): GitHistoryReference[] {
  const references: GitHistoryReference[] = [];
  const seen = new Set<string>();
  const add = (candidate: unknown) => {
    const reference = gitHistoryReference(candidate);
    if (!reference || seen.has(reference.id)) return;
    seen.add(reference.id);
    references.push(reference);
  };

  String(value || '').split(', ').forEach(decoration => {
    const arrowIndex = decoration.indexOf(' -> ');
    if (arrowIndex === -1) {
      add(decoration);
      return;
    }
    add(decoration.slice(0, arrowIndex));
    add(decoration.slice(arrowIndex + 4));
  });
  return references;
}

function parseGitHistoryLog(stdout: unknown) {
  const fields = String(stdout || '').split('\0');
  const items = [];
  for (let index = 0; index + 7 < fields.length; index += 8) {
    const id = fields[index];
    if (!id) continue;
    const timestamp = Date.parse(fields[index + 4]);
    items.push({
      id,
      displayId: id.slice(0, 8),
      parentIds: fields[index + 1].split(' ').filter(Boolean),
      author: fields[index + 2],
      authorEmail: fields[index + 3],
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      subject: fields[index + 5],
      message: String(fields[index + 6] || '').trimEnd(),
      references: parseGitHistoryReferences(fields[index + 7]),
    });
  }
  return items;
}

function gitHistoryChangeKind(statusCode: unknown): string {
  const code = String(statusCode || '');
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  if (code.startsWith('C')) return 'copied';
  if (code.startsWith('T')) return 'type-changed';
  return 'modified';
}

function gitHistoryChangeLabel(kind: unknown): string {
  if (kind === 'added') return 'A';
  if (kind === 'deleted') return 'D';
  if (kind === 'renamed') return 'R';
  if (kind === 'copied') return 'C';
  if (kind === 'type-changed') return 'T';
  return 'M';
}

function parseGitHistoryChanges(stdout: unknown) {
  const fields = String(stdout || '').split('\0');
  const items = [];
  for (let index = 0; index < fields.length;) {
    const statusCode = fields[index++];
    if (!statusCode) continue;
    const kind = gitHistoryChangeKind(statusCode);
    if (kind === 'renamed' || kind === 'copied') {
      const previousPath = fields[index++] || '';
      const filePath = fields[index++] || '';
      if (!filePath) continue;
      items.push({ path: filePath, previousPath, status: kind, statusLabel: gitHistoryChangeLabel(kind) });
      continue;
    }
    const filePath = fields[index++] || '';
    if (!filePath) continue;
    items.push({ path: filePath, status: kind, statusLabel: gitHistoryChangeLabel(kind) });
  }
  return items;
}

async function workspaceEntryTypeForGitChange(root: string, filePath: string): Promise<string> {
  try {
    const stat = await fsp.lstat(path.join(root, filePath.replace(/\/+$/, '')));
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    if (stat.isSymbolicLink()) return 'symlink';
    return 'other';
  } catch {
    return 'file';
  }
}

function gitStatusRank(kind: unknown): number {
  if (kind === 'conflicted') return 6;
  if (kind === 'deleted') return 5;
  if (kind === 'modified') return 4;
  if (kind === 'renamed') return 3;
  if (kind === 'added') return 2;
  if (kind === 'untracked') return 1;
  return 0;
}

function isPathWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1] || '';
  const current = text[index] || '';
  if (/[-_\s./\\]/.test(previous)) return true;
  return /[a-z0-9]/.test(previous) && /[A-Z]/.test(current);
}

function scoreBoundaryMatch(text: string, normalizedQuery: string): number | null {
  if (!text || !normalizedQuery || normalizedQuery.length > 6) return null;
  let queryIndex = 0;
  let score = 0;

  for (let textIndex = 0; textIndex < text.length && queryIndex < normalizedQuery.length; textIndex += 1) {
    if (!isPathWordBoundary(text, textIndex)) continue;
    if (text[textIndex].toLowerCase() !== normalizedQuery[queryIndex]) continue;
    score += textIndex;
    queryIndex += 1;
  }

  return queryIndex === normalizedQuery.length ? score : null;
}

function scorePathMatch(filePath: unknown, query: unknown, options: { allowPathMatch?: boolean } = {}): number | null {
  const pathText = normalizeSearchResultPath(filePath);
  const normalizedPath = pathText.toLowerCase();
  const normalizedQuery = String(query || '').trim().replace(/^\.\/+/, '').toLowerCase();
  if (!normalizedPath || !normalizedQuery) return null;

  const fileNameText = path.posix.basename(pathText);
  const fileName = fileNameText.toLowerCase();
  if (normalizedPath === normalizedQuery) return 0;
  if (fileName === normalizedQuery) return 1;

  const nameBoundaryScore = scoreBoundaryMatch(fileNameText, normalizedQuery);
  if (nameBoundaryScore !== null) return 5 + nameBoundaryScore / 100;

  const nameIndex = fileName.indexOf(normalizedQuery);
  if (nameIndex !== -1) return 10 + nameIndex;

  if (options.allowPathMatch === false) return null;

  const directoryIndex = normalizedPath.slice(0, -(fileName.length + 1)).split('/').indexOf(normalizedQuery);
  if (directoryIndex !== -1) return 30 + directoryIndex;

  const pathIndex = normalizedPath.indexOf(normalizedQuery);
  if (pathIndex !== -1) return 40 + pathIndex;

  if (normalizedQuery.length > 6) return null;

  let queryIndex = 0;
  let score = 80;
  for (let pathIndex = 0; pathIndex < normalizedPath.length && queryIndex < normalizedQuery.length; pathIndex += 1) {
    if (normalizedPath[pathIndex] !== normalizedQuery[queryIndex]) continue;
    score += pathIndex;
    queryIndex += 1;
  }

  return queryIndex === normalizedQuery.length ? score : null;
}

function pathSearchEntryRank(entryType: unknown): number {
  return entryType === 'directory' ? 0 : 1;
}

function pathSearchDepth(filePath: unknown): number {
  return normalizeSearchResultPath(filePath).split('/').filter(Boolean).length;
}

function comparePathSearchMatches(a: PathSearchMatch, b: PathSearchMatch): number {
  return (
    (a.score ?? 0) - (b.score ?? 0) ||
    pathSearchDepth(a.path) - pathSearchDepth(b.path) ||
    pathSearchEntryRank(a.entryType) - pathSearchEntryRank(b.entryType) ||
    a.path.localeCompare(b.path)
  );
}

function pathSearchMatchForPath(
  filePath: unknown,
  query: unknown,
  entryType: 'directory' | 'file',
  allowPathMatch: boolean,
): PathSearchMatch | null {
  const score = scorePathMatch(filePath, query, { allowPathMatch });
  if (score === null) return null;
  return {
    path: normalizeSearchResultPath(filePath),
    entryType,
    score,
  };
}

function directoryNameSearchScore(directoryPath: unknown, query: unknown, allowPathMatch: boolean): number | null {
  const pathText = normalizeSearchResultPath(directoryPath);
  const normalizedPath = pathText.toLowerCase();
  const normalizedQuery = String(query || '').trim().replace(/^\.\/+/, '').toLowerCase();
  if (!normalizedPath || !normalizedQuery) return null;

  const directoryName = path.posix.basename(pathText).toLowerCase();
  if (normalizedPath === normalizedQuery) return 0;
  if (directoryName === normalizedQuery) return 1;
  if (directoryName.startsWith(normalizedQuery)) return 5;
  if (normalizedQuery.length >= 4) {
    const nameIndex = directoryName.indexOf(normalizedQuery);
    if (nameIndex !== -1) return 10 + nameIndex;
  }
  if (!allowPathMatch) return null;
  const pathIndex = normalizedPath.indexOf(normalizedQuery);
  if (pathIndex !== -1) return 40 + pathIndex;
  return null;
}

function directoryNameSearchMatchForPath(directoryPath: unknown, query: unknown, allowPathMatch: boolean): PathSearchMatch | null {
  const score = directoryNameSearchScore(directoryPath, query, allowPathMatch);
  if (score === null) return null;
  return {
    path: normalizeSearchResultPath(directoryPath),
    entryType: 'directory',
    score,
  };
}

function ancestorDirectoryPaths(filePath: unknown): string[] {
  const segments = normalizeSearchResultPath(filePath).split('/').filter(Boolean);
  const ancestors = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/'));
  }
  return ancestors;
}

function pathSearchMatchesForFile(
  filePath: unknown,
  query: unknown,
  includeIgnored = false,
  includeDirectories = true,
  allowPathMatch = isLikelyPathQuery(query),
): PathSearchMatch[] {
  const matches = [];
  const fileMatch = pathSearchMatchForPath(filePath, query, 'file', allowPathMatch);
  if (fileMatch) matches.push(fileMatch);
  if (includeDirectories) {
    ancestorDirectoryPaths(filePath).forEach((directoryPath) => {
      if (isSearchIgnoredRelativePath(directoryPath, includeIgnored)) return;
      const directoryMatch = pathSearchMatchForPath(directoryPath, query, 'directory', allowPathMatch);
      if (directoryMatch) matches.push(directoryMatch);
    });
  }
  return matches;
}

function isLikelyPathQuery(query: unknown): boolean {
  return /[./\\]/.test(String(query || '').trim());
}

function dedupePathMatches(matches: PathSearchMatch[], limit: number): PathSearchMatch[] {
  const seen = new Set();
  const deduped = [];
  for (const match of matches) {
    if (!match || seen.has(match.path)) continue;
    seen.add(match.path);
    deduped.push(match);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function parseGitStatus(stdout: unknown): GitStatusMap {
  const records = String(stdout || '').split('\0').filter(Boolean);
  const statusByPath = new Map();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;

    const statusCode = record.slice(0, 2);
    const filePath = normalizeGitStatusPath(record.slice(3));
    if (!filePath) continue;

    const kind = gitStatusKind(statusCode);
    const previousPath = statusCode.includes('R') || statusCode.includes('C')
      ? normalizeGitStatusPath(records[index + 1])
      : '';
    statusByPath.set(filePath, {
      kind,
      label: gitStatusLabel(kind),
      ...(previousPath ? { previousPath } : {}),
    });

    if (statusCode.includes('R') || statusCode.includes('C')) {
      index += 1;
    }
  }

  return statusByPath;
}

function parseGitBlamePorcelain(stdout: unknown) {
  const lines = String(stdout || '').split('\n');
  const blameLines = [];
  const commits = new Map<string, Pick<BlameEntry, 'author' | 'authorMail' | 'authorTime' | 'authorTimeIso' | 'summary'>>();
  let index = 0;

  while (index < lines.length) {
    const header = lines[index];
    const match = /^(\^?[0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(header || '');
    if (!match) {
      index += 1;
      continue;
    }

    const commit = match[1].replace(/^\^/, '');
    const cachedCommit = commits.get(commit);
    const entry: BlameEntry = {
      commit,
      originalLineNumber: Number(match[2]),
      lineNumber: Number(match[3]),
      author: cachedCommit?.author || '',
      authorMail: cachedCommit?.authorMail || '',
      authorTime: cachedCommit?.authorTime ?? null,
      authorTimeIso: cachedCommit?.authorTimeIso || '',
      summary: cachedCommit?.summary || '',
      content: '',
    };
    index += 1;

    while (index < lines.length) {
      const line = lines[index];
      index += 1;
      if (line.startsWith('\t')) {
        entry.content = line.slice(1);
        break;
      }

      const separator = line.indexOf(' ');
      const fieldName = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1);
      if (fieldName === 'author') entry.author = value;
      if (fieldName === 'author-mail') entry.authorMail = value.replace(/^<|>$/g, '');
      if (fieldName === 'author-time') {
        const time = Number(value);
        entry.authorTime = Number.isFinite(time) ? time : null;
        entry.authorTimeIso = Number.isFinite(time) ? new Date(time * 1000).toISOString() : '';
      }
      if (fieldName === 'summary') entry.summary = value;
    }

    commits.set(commit, {
      author: entry.author,
      authorMail: entry.authorMail,
      authorTime: entry.authorTime,
      authorTimeIso: entry.authorTimeIso,
      summary: entry.summary,
    });
    const uncommitted = /^0+$/.test(entry.commit);
    blameLines.push({
      ...entry,
      shortCommit: uncommitted ? 'uncommitted' : entry.commit.slice(0, 8),
      uncommitted,
    });
  }

  return blameLines;
}

function gitRemoteWebUrl(remoteUrl: unknown) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return '';
  let webUrl = '';
  const scpMatch = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(raw);
  if (scpMatch && !raw.includes('://') && !/^[A-Za-z]:[\\/]/.test(raw)) {
    webUrl = `https://${scpMatch[1]}/${scpMatch[2]}`;
  }
  else {
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return '';
      const protocol = parsed.protocol === 'http:' ? 'http:' : 'https:';
      webUrl = `${protocol}//${parsed.host}${parsed.pathname}`;
    }
    catch {
      return '';
    }
  }
  webUrl = webUrl.replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(webUrl)) return '';
  return webUrl;
}

function gitCommitUrlTemplate(remoteUrl: unknown) {
  const webUrl = gitRemoteWebUrl(remoteUrl);
  if (!webUrl) return '';
  const host = new URL(webUrl).hostname.toLowerCase();
  if (host.includes('gitlab')) return `${webUrl}/-/commit/{commit}`;
  if (host.includes('bitbucket')) return `${webUrl}/commits/{commit}`;
  return `${webUrl}/commit/{commit}`;
}

function gitAuthorUrlTemplate(remoteUrl: unknown) {
  const webUrl = gitRemoteWebUrl(remoteUrl);
  if (!webUrl) return '';
  const url = new URL(webUrl);
  return url.hostname.toLowerCase().includes('gitlab')
    ? `${url.origin}/{author}`
    : '';
}

function decodeXmlAttribute(value: string) {
  return value.replace(/&#(x[0-9a-f]+|\d+);|&(quot|apos|lt|gt|amp);/gi, (entity, numeric, named) => {
    if (numeric) {
      const codePoint = Number.parseInt(numeric.startsWith('x') || numeric.startsWith('X') ? numeric.slice(1) : numeric, numeric.startsWith('x') || numeric.startsWith('X') ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' } as Record<string, string>)[String(named).toLowerCase()] || entity;
  });
}

function xmlTagAttributes(tag: string) {
  const attributes = new Map<string, string>();
  const attributePattern = /([\w:-]+)\s*=\s*(["'])(.*?)\2/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(tag))) {
    attributes.set(match[1], decodeXmlAttribute(match[3]));
  }
  return attributes;
}

function parseIntelliJIssueNavigationLinks(xml: unknown) {
  const source = String(xml || '');
  const component = /<component\b[^>]*\bname\s*=\s*(["'])IssueNavigationConfiguration\1[^>]*>([\s\S]*?)<\/component>/i.exec(source)?.[2] || '';
  if (!component) return [];

  const rules: Array<{ issueRegexp: string; linkRegexp: string }> = [];
  const linkPattern = /<IssueNavigationLink\b[^>]*>([\s\S]*?)<\/IssueNavigationLink>/gi;
  let linkMatch: RegExpExecArray | null;
  while (rules.length < 64 && (linkMatch = linkPattern.exec(component))) {
    let issueRegexp = '';
    let linkRegexp = '';
    const optionPattern = /<option\b[^>]*\/?>/gi;
    let optionMatch: RegExpExecArray | null;
    while ((optionMatch = optionPattern.exec(linkMatch[1]))) {
      const attributes = xmlTagAttributes(optionMatch[0]);
      if (attributes.get('name') === 'issueRegexp') issueRegexp = attributes.get('value') || '';
      if (attributes.get('name') === 'linkRegexp') linkRegexp = attributes.get('value') || '';
    }
    if (!issueRegexp || issueRegexp.length > 2_048 || !/^https?:\/\//i.test(linkRegexp) || linkRegexp.length > 4_096) continue;
    try {
      new RegExp(issueRegexp, 'g');
    }
    catch {
      continue;
    }
    rules.push({ issueRegexp, linkRegexp });
  }
  return rules;
}

async function loadIntelliJIssueNavigationLinks(root: string) {
  const requestedPath = path.join(root, '.idea', 'vcs.xml');
  const actualPath = await fsp.realpath(requestedPath).catch(() => '');
  if (!actualPath || !isInside(root, actualPath)) return [];
  const stat = await fsp.stat(actualPath).catch(() => null);
  if (!stat?.isFile() || stat.size > DEFAULT_ISSUE_NAVIGATION_MAX_SIZE) return [];
  const source = await fsp.readFile(actualPath, 'utf8').catch(() => '');
  return parseIntelliJIssueNavigationLinks(source);
}

function parseUnifiedDiffHunks(patch: unknown): DiffHunk[] {
  const lines = String(patch || '').split('\n');
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;

  const finishHunk = () => {
    if (hunk) {
      hunks.push({
        ...hunk,
        patch: hunk.patchLines.join('\n'),
      });
    }
    hunk = null;
  };

  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (match) {
      finishHunk();
      hunk = {
        header: line,
        oldStart: Number(match[1]),
        oldLines: Number(match[2] || 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] || 1),
        heading: match[5] ? match[5].trim() : '',
        patchLines: [line],
      };
      continue;
    }

    if (hunk) {
      hunk.patchLines.push(line);
    }
  }

  finishHunk();
  return hunks;
}

function intralineRanges(leftText: string, rightText: string) {
  const changes = diffChars(leftText, rightText, { timeout: 100 });
  if (!changes) return {};
  const left = [];
  const right = [];
  let leftOffset = 0;
  let rightOffset = 0;
  for (const change of changes) {
    const length = Array.from(change.value).length;
    if (change.removed) {
      if (length > 0) left.push({ start: leftOffset, end: leftOffset + length });
      leftOffset += length;
      continue;
    }
    if (change.added) {
      if (length > 0) right.push({ start: rightOffset, end: rightOffset + length });
      rightOffset += length;
      continue;
    }
    leftOffset += length;
    rightOffset += length;
  }
  return {
    ...(left.length ? { left } : {}),
    ...(right.length ? { right } : {}),
  };
}

function parseUnifiedDiffRows(patch: unknown) {
  return parseUnifiedDiffHunks(patch).map(hunk => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const rows: DiffRow[] = [];
    let previousCell: DiffCell | null = null;
    for (const line of hunk.patchLines.slice(1)) {
      if (line.startsWith('\\ No newline at end of file')) {
        if (previousCell) previousCell.missingNewlineAtEnd = true;
        continue;
      }
      if (line.startsWith(' ')) {
        const text = line.slice(1);
        const row = {
          kind: 'context',
          left: { line: oldLine, text },
          right: { line: newLine, text },
        };
        rows.push(row);
        previousCell = row.right;
        oldLine++;
        newLine++;
        continue;
      }
      if (line.startsWith('-')) {
        const row = { kind: 'deleted', left: { line: oldLine, text: line.slice(1) } };
        rows.push(row);
        previousCell = row.left;
        oldLine++;
        continue;
      }
      if (line.startsWith('+')) {
        const row = { kind: 'added', right: { line: newLine, text: line.slice(1) } };
        rows.push(row);
        previousCell = row.right;
        newLine++;
      }
    }
    const pairedRows: DiffRow[] = [];
    for (let index = 0; index < rows.length;) {
      if (rows[index].kind !== 'deleted') {
        pairedRows.push(rows[index]);
        index += 1;
        continue;
      }
      const deleted = [];
      while (index < rows.length && rows[index].kind === 'deleted') deleted.push(rows[index++]);
      const added = [];
      while (index < rows.length && rows[index].kind === 'added') added.push(rows[index++]);
      const paired = Math.min(deleted.length, added.length);
      for (let pairIndex = 0; pairIndex < paired; pairIndex += 1) {
        const left = deleted[pairIndex].left;
        const right = added[pairIndex].right;
        if (!left || !right) continue;
        const intraline = intralineRanges(left.text, right.text);
        pairedRows.push({
          kind: 'changed',
          left: { ...left, ...(intraline.left ? { intraline: intraline.left } : {}) },
          right: { ...right, ...(intraline.right ? { intraline: intraline.right } : {}) },
        });
      }
      pairedRows.push(...deleted.slice(paired));
      pairedRows.push(...added.slice(paired));
    }
    return {
      header: hunk.header,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      rows: pairedRows,
    };
  });
}

function lineInUnifiedDiffHunk(hunk: DiffHunk, side: unknown, lineNumber: number): boolean {
  const start = side === 'old' ? hunk.oldStart : hunk.newStart;
  const count = side === 'old' ? hunk.oldLines : hunk.newLines;
  const end = Math.max(start, start + count - 1);
  return lineNumber >= start && lineNumber <= end;
}

function selectUnifiedDiffHunk(patch: unknown, side: unknown, lineNumber: number): DiffHunk | null {
  const hunks = parseUnifiedDiffHunks(patch);
  return hunks.find(hunk => lineInUnifiedDiffHunk(hunk, side, lineNumber)) || null;
}

function createAddedFileLineChangesHunk(content: unknown, lineNumber: number, contextLines = 20) {
  const lines = String(content || '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return null;

  const startIndex = Math.max(0, lineNumber - contextLines - 1);
  const endIndex = Math.min(lines.length, lineNumber + contextLines);
  const newStart = startIndex + 1;
  const newLines = endIndex - startIndex;
  const patchLines = [
    `@@ -0,0 +${newStart},${newLines} @@`,
    ...lines.slice(startIndex, endIndex).map(line => `+${line}`),
  ];

  return {
    header: patchLines[0],
    oldStart: 0,
    oldLines: 0,
    newStart,
    newLines,
    heading: '',
    patch: patchLines.join('\n'),
  };
}

function strongestStatus(current: GitStatusEntry | undefined, next: GitStatusEntry): GitStatusEntry {
  if (!current) return next;
  return gitStatusRank(next.kind) > gitStatusRank(current.kind) ? next : current;
}

function buildDescendantGitStatusByDirectory(statusByPath: GitStatusMap): Map<string, GitStatusEntry> {
  const statusByDirectory = new Map<string, GitStatusEntry>();
  statusByPath.forEach((status, statusPath) => {
    let directory = parentDirectory(statusPath);
    while (directory) {
      statusByDirectory.set(directory, strongestStatus(statusByDirectory.get(directory), status));
      directory = parentDirectory(directory);
    }
  });
  return statusByDirectory;
}

class WorkspaceFileService {
  blameTimeoutMs: number;
  commandRunner: WorkspaceCommandRunner;
  diffMaxBuffer: number;
  diffTimeoutMs: number;
  disposed: boolean;
  exactWatchers: Map<string, ExactWorkspaceWatcherRecord>;
  flushWorkspaceWrites: boolean;
  gitHistoryMaxBuffer: number;
  gitHistoryTimeoutMs: number;
  gitPath: string;
  gitStatusCache: Map<string, GitStatusCacheEntry>;
  gitStatusCacheTtlMs: number;
  gitStatusTimeoutMs: number;
  maxFileSize: number;
  maxPreviewFileSize: number;
  maxWriteSize: number;
  mutationQueues: Map<string, Promise<void>>;
  ownsCommandRunner: boolean;
  rgPath: string;
  searchLimit: number;
  searchTimeoutMs: number;
  watchDepth: number;
  watchOptions: Record<string, unknown>;
  watcherLifecycleGeneration: number;
  watcherSubscriptionGeneration: number;
  watchers: Map<string, WorkspaceWatcherRecord>;
  constructor(options: WorkspaceFileServiceOptions = {}) {
    this.maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this.maxWriteSize = options.maxWriteSize || DEFAULT_MAX_WRITE_SIZE;
    this.maxPreviewFileSize = options.maxPreviewFileSize || DEFAULT_MAX_PREVIEW_FILE_SIZE;
    this.searchLimit = options.searchLimit || DEFAULT_SEARCH_LIMIT;
    this.searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.blameTimeoutMs = options.blameTimeoutMs ?? DEFAULT_BLAME_TIMEOUT_MS;
    this.diffTimeoutMs = options.diffTimeoutMs ?? DEFAULT_DIFF_TIMEOUT_MS;
    this.diffMaxBuffer = options.diffMaxBuffer ?? DEFAULT_DIFF_MAX_BUFFER;
    this.gitHistoryTimeoutMs = options.gitHistoryTimeoutMs ?? DEFAULT_GIT_HISTORY_TIMEOUT_MS;
    this.gitHistoryMaxBuffer = options.gitHistoryMaxBuffer ?? DEFAULT_GIT_HISTORY_MAX_BUFFER;
    this.rgPath = options.rgPath || assertManagedRipgrep();
    this.gitPath = options.gitPath || 'git';
    this.gitStatusCacheTtlMs = options.gitStatusCacheTtlMs ?? DEFAULT_GIT_STATUS_CACHE_TTL_MS;
    this.gitStatusTimeoutMs = options.gitStatusTimeoutMs ?? DEFAULT_GIT_STATUS_TIMEOUT_MS;
    this.gitStatusCache = new Map();
    this.mutationQueues = new Map();
    this.flushWorkspaceWrites = options.flushWorkspaceWrites !== false;
    this.exactWatchers = new Map();
    this.watchers = new Map();
    this.watcherSubscriptionGeneration = 0;
    this.watcherLifecycleGeneration = 0;
    this.disposed = false;
    this.watchOptions = options.watchOptions || {};
    this.watchDepth = Number.isFinite(options.watchDepth) ? Math.max(0, options.watchDepth ?? 0) : DEFAULT_WATCH_DEPTH;
    this.commandRunner = options.commandRunner || new CommandRunner(options.commandRunnerOptions);
    this.ownsCommandRunner = !options.commandRunner;
  }

  execFile(command: string, args: string[], options: CommandExecutionOptions = {}) {
    const git = command === this.gitPath;
    const commandOptions = {
      maxBuffer: 2 * 1024 * 1024,
      ...options,
      ...(git ? { env: gitCommandEnvironment(options.env) } : {}),
    };
    const commandArgs = git ? gitCommandArgs(args) : args;
    return options.signal
      ? execFileAsync(command, commandArgs, commandOptions)
      : this.commandRunner.run(command, commandArgs, commandOptions);
  }

  async runWorkspaceMutation<T>(workspaceRoot: unknown, operation: (root: string) => Promise<T>): Promise<T> {
    const root = await this.resolveRoot(workspaceRoot);
    const previous = this.mutationQueues.get(root) || Promise.resolve();
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.mutationQueues.set(root, tail);
    await previous;
    try {
      return await operation(root);
    } finally {
      release();
      if (this.mutationQueues.get(root) === tail) {
        this.mutationQueues.delete(root);
      }
    }
  }

  async waitForWorkspaceMutations(workspaceRoot: unknown): Promise<string> {
    const root = await this.resolveRoot(workspaceRoot);
    const pending = this.mutationQueues.get(root);
    if (pending) await pending;
    return root;
  }

  async execRipgrep(args: string[], options: CommandExecutionOptions = {}): Promise<CommandResult> {
    return await this.execFile(this.rgPath, args, options);
  }

  async collectGitIgnoredPathMatchCandidates(
    root: string,
    searchPath: string,
    query: unknown,
    limit: number,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<PathSearchResult> {
    const candidateLimit = Math.max(PATH_SEARCH_MIN_CANDIDATES, limit * PATH_SEARCH_CANDIDATE_MULTIPLIER);
    const { stdout } = await this.execFile(this.gitPath, [
      '-C',
      root,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      ...gitSearchExcludePathspecArgs(true, searchPath),
    ], { cwd: root, timeout, maxBuffer: SEARCH_FILE_LIST_MAX_BUFFER, signal });
    const scoredMatches = [];
    const seenMatchPaths = new Set();
    let truncated = false;

    for (const line of String(stdout).split('\n')) {
      const filePath = normalizeSearchResultPath(line);
      if (!filePath || isSearchIgnoredRelativePath(filePath, true)) continue;
      for (const match of pathSearchMatchesForFile(filePath, query, true)) {
        if (seenMatchPaths.has(match.path)) continue;
        seenMatchPaths.add(match.path);
        scoredMatches.push(match);
        if (scoredMatches.length >= candidateLimit) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }

    scoredMatches.sort(comparePathSearchMatches);
    return {
      matches: scoredMatches.slice(0, limit).map(match => ({
        kind: 'path',
        entryType: match.entryType,
        path: match.path,
        lineNumber: 1,
        lines: '',
        ranges: [],
      })),
      truncated,
    };
  }

  streamPathMatches(
    command: string,
    root: string,
    searchPath: string,
    query: unknown,
    limit: number,
    timeout: number,
    stopAtLimit = false,
    signal?: AbortSignal,
    includeDirectories = true,
    allowPathMatch = isLikelyPathQuery(query),
  ): Promise<PathSearchResult> {
    const args = [
      '--files',
      '--hidden',
      ...searchExcludeGlobArgs(),
      searchPath,
    ];
    const candidateLimit = stopAtLimit
      ? limit
      : Math.max(PATH_SEARCH_MIN_CANDIDATES, limit * PATH_SEARCH_CANDIDATE_MULTIPLIER);

    return new Promise<PathSearchResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let pending = '';
      let stderr = '';
      let settled = false;
      let truncated = false;
      const scoredMatches: PathSearchMatch[] = [];
      const seenMatchPaths = new Set();

      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          reject(error);
          return;
        }
        scoredMatches.sort(comparePathSearchMatches);
        resolve({
          matches: scoredMatches.slice(0, limit).map(match => ({
            kind: 'path',
            entryType: match.entryType,
            path: match.path,
            lineNumber: 1,
            lines: '',
            ranges: [],
          })),
          truncated,
        });
      };

      const stopEarly = () => {
        truncated = true;
        child.kill();
        settle();
      };

      const onAbort = () => {
        child.kill();
        settle(signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('Workspace search was cancelled', 'AbortError'));
      };

      const processLine = (line: unknown) => {
        const filePath = normalizeSearchResultPath(line);
        if (!filePath || isSearchIgnoredRelativePath(filePath)) return;
        for (const match of pathSearchMatchesForFile(filePath, query, false, includeDirectories, allowPathMatch)) {
          if (seenMatchPaths.has(match.path)) continue;
          seenMatchPaths.add(match.path);
          scoredMatches.push(match);
          if (scoredMatches.length >= candidateLimit) {
            if (!includeDirectories) {
              // Global file search ranks the complete stream within its deadline.
              // Keep memory bounded without letting an early prefix match hide
              // a later exact directory or filename match.
              truncated = true;
              scoredMatches.sort(comparePathSearchMatches);
              for (const removed of scoredMatches.splice(limit)) seenMatchPaths.delete(removed.path);
              continue;
            }
            stopEarly();
            return;
          }
        }
      };

      const timer = setTimeout(() => {
        truncated = true;
        child.kill();
        settle();
      }, timeout);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        pending += String(chunk || '');
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          processLine(line);
          if (settled) return;
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += String(chunk || '');
      });

      child.on('error', (error: Error) => {
        settle(error);
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        if (pending) processLine(pending);
        if (settled) return;
        // ripgrep exits with 1 when a directory contains no searchable files.
        if (code && code !== 1 && signal !== 'SIGTERM') {
          const error = new Error(stderr || 'path search failed') as ProcessError;
          error.code = code;
          error.signal = signal;
          error.stderr = stderr;
          settle(error);
          return;
        }
        settle();
      });
    });
  }

  async collectPathMatchCandidates(
    root: string,
    searchPath: string,
    query: unknown,
    limit: number,
    timeout: number,
    stopAtLimit = false,
    signal?: AbortSignal,
    includeDirectories = true,
    allowPathMatch = isLikelyPathQuery(query),
  ): Promise<PathSearchResult> {
    return await this.streamPathMatches(
      this.rgPath,
      root,
      searchPath,
      query,
      limit,
      timeout,
      stopAtLimit,
      signal,
      includeDirectories,
      allowPathMatch,
    );
  }

  async collectDirectoryNameMatchCandidates(
    root: string,
    searchPath: string,
    query: unknown,
    limit: number,
    deadline: number,
    signal?: AbortSignal,
    allowPathMatch = isLikelyPathQuery(query),
    pruneDirectory: (relativePath: unknown) => boolean = shouldPruneDirectoryNameSearch,
  ): Promise<PathSearchResult> {
    const candidateLimit = Math.max(PATH_SEARCH_MIN_CANDIDATES, limit * PATH_SEARCH_CANDIDATE_MULTIPLIER);
    const startRelativePath = searchPath === '.' ? '' : normalizeSearchResultPath(searchPath);
    const startDirectory = path.resolve(root, startRelativePath || '.');
    const queue = [{ target: startDirectory, relativePath: startRelativePath }];
    const scoredMatches = [];
    const seenMatchPaths = new Set();
    let visited = 0;
    let truncated = false;

    while (queue.length > 0) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }
      if (visited >= candidateLimit * 4) {
        truncated = true;
        break;
      }

      const current = queue.shift();
      if (!current || pruneDirectory(current.relativePath)) continue;
      visited += 1;

      let entries;
      try {
        entries = await fsp.readdir(current.target, { withFileTypes: true });
      } catch {
        continue;
      }
      signal?.throwIfAborted();

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childRelativePath = normalizeSearchResultPath(
          current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name
        );
        if (!childRelativePath || pruneDirectory(childRelativePath)) continue;
        const childTarget = path.join(current.target, entry.name);
        const match = directoryNameSearchMatchForPath(childRelativePath, query, allowPathMatch);
        if (match && !seenMatchPaths.has(match.path)) {
          seenMatchPaths.add(match.path);
          scoredMatches.push(match);
          if (scoredMatches.length >= candidateLimit) {
            truncated = true;
            break;
          }
        }
        queue.push({ target: childTarget, relativePath: childRelativePath });
      }
      if (truncated) break;
    }

    scoredMatches.sort(comparePathSearchMatches);
    return {
      matches: scoredMatches.slice(0, limit).map(match => ({
        kind: 'path',
        entryType: 'directory',
        path: match.path,
        lineNumber: 1,
        lines: '',
        ranges: [],
      })),
      truncated,
    };
  }

  async directPathMatchCandidate(
    root: string,
    searchPath: string,
    searchRoot: string,
    query: unknown,
    includeIgnored = false,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!isLikelyPathQuery(query)) return null;
    let candidatePath;
    try {
      candidatePath = normalizeUserPath(String(query || '').trim().replace(/^\.\/+/, ''));
    } catch {
      return null;
    }
    if (!candidatePath || candidatePath.includes('\0') || isSearchIgnoredRelativePath(candidatePath, includeIgnored)) return null;
    const scopedCandidatePath = searchPath && searchPath !== '.'
      ? path.join(searchPath, candidatePath)
      : candidatePath;
    try {
      const { target, relativePath } = await this.resolvePath(root, scopedCandidatePath);
      signal?.throwIfAborted();
      if (!isInside(searchRoot, target)) return null;
      if (!relativePath || isSearchIgnoredRelativePath(relativePath, includeIgnored)) return null;
      const stat = await fsp.stat(target);
      signal?.throwIfAborted();
      if (!stat.isFile()) return null;
      return {
        kind: 'path',
        entryType: 'file',
        path: relativePath,
        lineNumber: 1,
        lines: '',
        ranges: [],
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  async resolveRoot(workspaceRoot: unknown): Promise<string> {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      throw new WorkspaceFileError('workspace root is required', 400);
    }

    let stat;
    try {
      stat = await fsp.stat(workspaceRoot);
    } catch {
      throw new WorkspaceFileError('workspace not found', 404);
    }

    if (!stat.isDirectory()) {
      throw new WorkspaceFileError('workspace must be a directory', 400);
    }

    return fsp.realpath(workspaceRoot);
  }

  async resolvePath(
    workspaceRoot: unknown,
    userPath: unknown = '',
    options: ResolvePathOptions = {},
  ): Promise<ResolvedWorkspacePath> {
    const root = await this.resolveRoot(workspaceRoot);
    const normalized = normalizeUserPath(userPath);
    const target = path.resolve(root, normalized);
    const requestedRelativePath = relativeFromRoot(root, target);

    if (!isInside(root, target)) {
      throw new WorkspaceFileError('path must stay inside the workspace', 403);
    }

    if (options.allowMissing) {
      const parent = await fsp.realpath(path.dirname(target)).catch(() => null);
      if (!parent || !isInside(root, parent)) {
        throw new WorkspaceFileError('parent path must stay inside the workspace', 403);
      }
      return {
        root,
        target,
        relativePath: requestedRelativePath,
        actualRelativePath: requestedRelativePath,
        external: false,
        readOnly: false,
        symbolicLink: false,
      };
    }

    let realTarget;
    try {
      realTarget = await fsp.realpath(target);
    } catch {
      throw new WorkspaceFileError('path not found', 404);
    }

    const external = !isInside(root, realTarget);
    if (external && !isInsideAnyRoot(options.allowedExternalRoots, realTarget)) {
      throw new WorkspaceFileError('symlink target is outside allowed workspaces', 403);
    }

    const requestedStat = await fsp.lstat(target).catch(() => null);

    return {
      root,
      target: realTarget,
      relativePath: requestedRelativePath,
      actualRelativePath: external ? '' : relativeFromRoot(root, realTarget),
      external,
      readOnly: external,
      symbolicLink: Boolean(requestedStat && requestedStat.isSymbolicLink()),
    };
  }

  async resolveEntryPath(workspaceRoot: unknown, userPath: unknown): Promise<{
    root: string;
    target: string;
    relativePath: string;
  }> {
    const root = await this.resolveRoot(workspaceRoot);
    const normalized = normalizeUserPath(userPath);
    const target = path.resolve(root, normalized);
    const relativePath = relativeFromRoot(root, target);
    if (!relativePath) {
      throw new WorkspaceFileError('workspace root cannot be changed', 400);
    }
    if (!isInside(root, target)) {
      throw new WorkspaceFileError('path must stay inside the workspace', 403);
    }
    try {
      await fsp.lstat(target);
    } catch {
      throw new WorkspaceFileError('path not found', 404);
    }
    const realParent = await fsp.realpath(path.dirname(target)).catch(() => null);
    if (!realParent || !isInside(root, realParent)) {
      throw new WorkspaceFileError('symlink target is read-only', 403);
    }
    return { root, target, relativePath };
  }

  async listTree(workspaceRoot: unknown, userPath: unknown = '', options: ResolvePathOptions = {}) {
    const root = await this.waitForWorkspaceMutations(workspaceRoot);
    const { target, relativePath, external: parentExternal = false } = await this.resolvePath(root, userPath, options);
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
      throw new WorkspaceFileError('path must be a directory', 400);
    }

    const entries = await fsp.readdir(target, { withFileTypes: true });
    const visibleEntries = entries.filter((entry: import("fs").Dirent) => !TREE_HIDDEN_NAMES.has(entry.name));
    const items = await Promise.all(visibleEntries
      .map(async (entry: import("fs").Dirent) => {
        const absolute = path.join(target, entry.name);
        let entryStat;
        try {
          entryStat = await fsp.lstat(absolute);
        } catch (caught: unknown) {
      const error = processError(caught);
          if (error && error.code === 'ENOENT') return null;
          throw error;
        }
        const itemPath = joinRelativePath(relativePath, entry.name);
        let type = entryStat.isDirectory() ? 'directory' : entryStat.isFile() ? 'file' : 'other';
        let symbolicLink = false;
        let external = parentExternal;
        let readOnly = parentExternal;
        let linkTarget = '';
        let linkError = '';
        let targetStat = entryStat;
        if (entryStat.isSymbolicLink()) {
          symbolicLink = true;
          try {
            linkTarget = await fsp.realpath(absolute);
            external = !isInside(root, linkTarget);
            if (external && !isInsideAnyRoot(options.allowedExternalRoots, linkTarget)) {
              type = 'symlink';
              linkError = 'outside-allowed-roots';
            } else {
              targetStat = await fsp.stat(linkTarget);
              type = targetStat.isDirectory() ? 'directory' : targetStat.isFile() ? 'file' : 'other';
              readOnly = external;
            }
          } catch (caught: unknown) {
      const error = processError(caught);
            type = 'symlink';
            linkError = error && error.code === 'ENOENT' ? 'broken' : 'unavailable';
          }
        }
        return {
          name: entry.name,
          path: itemPath,
          type,
          size: targetStat.size,
          mtimeMs: targetStat.mtimeMs,
          version: workspaceEntryVersion(entryStat),
          ...(symbolicLink ? { symbolicLink: true } : {}),
          ...(external ? { external: true } : {}),
          ...(readOnly ? { readOnly: true } : {}),
          ...(linkTarget ? { linkTarget } : {}),
          ...(linkError ? { linkError } : {}),
        };
      }));
    const visibleItems = items.filter(Boolean);

    visibleItems.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    return {
      path: relativePath,
      items: visibleItems,
    };
  }

  async listTreeDecorations(workspaceRoot: unknown, userPath: unknown = '', entryPaths: unknown[] = []) {
    const root = await this.waitForWorkspaceMutations(workspaceRoot);
    const { target, relativePath } = await this.resolvePath(root, userPath);
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
      throw new WorkspaceFileError('path must be a directory', 400);
    }

    const normalizedEntryPaths = Array.from(new Set(entryPaths.map((entryPath) => {
      const normalizedPath = normalizeGitStatusPath(normalizeUserPath(entryPath));
      if (!normalizedPath || parentDirectory(normalizedPath) !== relativePath) {
        throw new WorkspaceFileError('decoration path must be a direct directory entry', 400);
      }
      return normalizeGitStatusPath(normalizedPath);
    })));
    const [gitStatusByPath, ignoredPaths] = await Promise.all([
      this.getGitStatusByPath(root),
      this.loadGitIgnoredPaths(root, normalizedEntryPaths),
    ]);
    const descendantGitStatusByPath = buildDescendantGitStatusByDirectory(gitStatusByPath);

    return {
      path: relativePath,
      items: normalizedEntryPaths.flatMap((itemPath) => {
        const directGitStatus = gitStatusByPath.get(itemPath);
        const descendantGitStatus = descendantGitStatusByPath.get(itemPath);
        if (!ignoredPaths.has(itemPath) && !directGitStatus && !descendantGitStatus) return [];
        return [{
          path: itemPath,
          ...(ignoredPaths.has(itemPath) ? { ignored: true } : {}),
          ...(directGitStatus ? {
            gitStatus: directGitStatus.kind,
            gitStatusLabel: directGitStatus.label,
          } : {}),
          ...(descendantGitStatus ? {
            descendantGitStatus: descendantGitStatus.kind,
          } : {}),
        }];
      }),
    };
  }

  invalidateGitStatus(root: string) {
    if (root) this.gitStatusCache.delete(root);
  }

  async loadGitStatusByPath(root: string, options: Record<string, unknown> = {}): Promise<GitStatusMap> {
    const untrackedFiles = options.untrackedFiles || 'normal';
    const pathspecArgs = options.excludeHidden === false
      ? ['--', '.']
      : gitStatusExcludePathspecArgs();
    try {
      const { stdout } = await this.execFile(this.gitPath, [
        'status',
        '--porcelain=v1',
        '-z',
        `--untracked-files=${untrackedFiles}`,
        '--ignored=no',
        ...pathspecArgs,
      ], {
        cwd: root,
        timeout: Number(options.timeoutMs) || this.gitStatusTimeoutMs,
        ...(Number(options.maxBuffer) > 0 ? { maxBuffer: Number(options.maxBuffer) } : {}),
      });
      return parseGitStatus(stdout);
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && options.allowPartial === true) {
        const partialOutput = String(error.stdout || '');
        const lastCompleteRecord = partialOutput.lastIndexOf('\0');
        const statusByPath = parseGitStatus(lastCompleteRecord >= 0
          ? partialOutput.slice(0, lastCompleteRecord + 1)
          : '');
        statusByPath.truncated = true;
        return statusByPath;
      }
      if (error.code === 'ENOENT') {
        if (options.throwOnError === true) {
          throw new WorkspaceFileError('git is not installed', 501);
        }
        return new Map() as GitStatusMap;
      }
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        throw new WorkspaceFileError('git status timed out', 504);
      }
      if (error.stderr && /not a git repository/i.test(String(error.stderr))) return new Map() as GitStatusMap;
      if (options.throwOnError === true) {
        throw new WorkspaceFileError(String(error.stderr || 'git status failed'), 500);
      }
      return new Map() as GitStatusMap;
    }
  }

  async loadGitIgnoredPaths(root: string, relativePaths: unknown[]) {
    const paths: string[] = Array.from(new Set<string>(relativePaths
      .map(normalizeGitStatusPath)
      .filter(Boolean)));
    if (paths.length === 0) return new Set();

    const batches: string[][] = [];
    let batch: string[] = [];
    let batchBytes = 0;
    for (const entryPath of paths) {
      const entryBytes = Buffer.byteLength(entryPath, 'utf8') + 1;
      if (batch.length > 0 && batchBytes + entryBytes > MAX_GIT_CHECK_IGNORE_ARG_BYTES) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(entryPath);
      batchBytes += entryBytes;
    }
    if (batch.length > 0) batches.push(batch);

    const ignored = new Set<string>();
    for (const pathBatch of batches) {
      try {
        const { stdout } = await this.execFile(this.gitPath, [
          'check-ignore',
          '--',
          ...pathBatch,
        ], { cwd: root });
        String(stdout)
          .split(/\r?\n/)
          .map(normalizeGitStatusPath)
          .filter(Boolean)
          .forEach(entryPath => ignored.add(entryPath));
      } catch {
        // git check-ignore exits 1 when none of the paths in this batch match.
      }
    }
    return ignored;
  }

  async loadGitStatusForPath(root: string, relativePath: unknown) {
    const normalizedPath = normalizeGitStatusPath(relativePath);
    if (!normalizedPath) return null;

    try {
      const { stdout } = await this.execFile(this.gitPath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
        '--ignored=no',
        '--',
        normalizedPath,
      ], { cwd: root });
      return parseGitStatus(stdout).get(normalizedPath) || null;
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error.code === 'ENOENT') return null;
      if (error.stderr && /not a git repository/i.test(String(error.stderr))) return null;
      return null;
    }
  }

  async getGitStatusByPath(root: string) {
    if (this.gitStatusCacheTtlMs > 0) {
      const now = Date.now();
      const cached = this.gitStatusCache.get(root);
      if (cached?.value && cached.expiresAt > now) {
        return cached.value;
      }
      if (cached?.promise) {
        return cached.promise;
      }

      const promise = this.loadGitStatusByPath(root).then((value) => {
        this.gitStatusCache.set(root, {
          value,
          expiresAt: Date.now() + this.gitStatusCacheTtlMs,
        });
        return value;
      }, (error) => {
        this.gitStatusCache.delete(root);
        throw error;
      });
      this.gitStatusCache.set(root, {
        promise,
        expiresAt: now + this.gitStatusCacheTtlMs,
      });
      return promise;
    }

    return this.loadGitStatusByPath(root);
  }

  async getGitStatusForPath(root: string, relativePath: unknown) {
    const normalizedPath = normalizeGitStatusPath(relativePath);
    if (!normalizedPath) return null;

    const cached = this.gitStatusCache.get(root);
    if (cached?.value) {
      return cached.value.get(normalizedPath) || null;
    }

    return this.loadGitStatusForPath(root, normalizedPath);
  }

  async gitBranch(workspaceRoot: unknown): Promise<string> {
    const root = await this.resolveRoot(workspaceRoot);
    try {
      const { stdout } = await this.execFile(this.gitPath, ['-C', root, 'branch', '--show-current'], {
        timeout: 1500,
        maxBuffer: 64 * 1024,
      });
      return String(stdout || '').trim();
    } catch {
      return '';
    }
  }

  async gitHistory(workspaceRoot: unknown, options: Record<string, unknown> = {}) {
    const root = await this.resolveRoot(workspaceRoot);
    const limit = normalizeGitHistoryLimit(options.limit);
    const skip = normalizeGitHistorySkip(options.skip);
    const scope = options.scope === 'all' ? 'all' : 'current';
    let branch = '';
    try {
      branch = await this.gitBranch(root);
      await this.execFile(this.gitPath, ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
        timeout: 1500,
        maxBuffer: 64 * 1024,
      });
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error.code === 'ENOENT') throw new WorkspaceFileError('git is not installed', 501);
      if (error.stderr && /not a git repository/i.test(String(error.stderr))) {
        return { isGitRepo: false, branch: '', head: '', scope, items: [], hasMore: false, nextSkip: null };
      }
      throw new WorkspaceFileError(String(error.stderr || 'git history failed'), 500);
    }

    let head = '';
    try {
      const result = await this.execFile(this.gitPath, ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
        timeout: 1500,
        maxBuffer: 64 * 1024,
      });
      head = String(result.stdout || '').trim();
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error.stderr && /(needed a single revision|unknown revision|bad revision|ambiguous argument)/i.test(String(error.stderr))) {
        return { isGitRepo: true, branch, head: '', scope, items: [], hasMore: false, nextSkip: null };
      }
      throw new WorkspaceFileError(String(error.stderr || 'git history failed'), 500);
    }

    try {
      const revisionArgs = scope === 'all'
        ? ['HEAD', '--branches', '--tags', '--remotes']
        : ['--first-parent', 'HEAD'];
      const { stdout } = await this.execFile(this.gitPath, [
        '-C', root,
        'log',
        '-z',
        '--date-order',
        '--decorate=full',
        '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%B%x00%D',
        `--max-count=${limit + 1}`,
        `--skip=${skip}`,
        ...revisionArgs,
      ], {
        timeout: this.gitHistoryTimeoutMs,
        maxBuffer: this.gitHistoryMaxBuffer,
      });
      const parsed = parseGitHistoryLog(stdout);
      const hasMore = parsed.length > limit;
      const items = parsed.slice(0, limit);
      return {
        isGitRepo: true,
        branch,
        head,
        scope,
        items,
        hasMore,
        nextSkip: hasMore ? skip + items.length : null,
      };
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error.code === 'ENOENT') throw new WorkspaceFileError('git is not installed', 501);
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        throw new WorkspaceFileError('git history timed out', 504);
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new WorkspaceFileError('git history output is too large', 413);
      }
      if (error.stderr && /not a git repository/i.test(String(error.stderr))) {
        return { isGitRepo: false, branch: '', head: '', scope, items: [], hasMore: false, nextSkip: null };
      }
      throw new WorkspaceFileError(String(error.stderr || 'git history failed'), 500);
    }
  }

  async gitHistoryChanges(
    workspaceRoot: unknown,
    commitValue: unknown,
    parentValue: unknown,
    options: Record<string, unknown> = {},
  ) {
    const root = await this.resolveRoot(workspaceRoot);
    const commit = normalizeGitObjectId(commitValue);
    const requestedParent = parentValue ? normalizeGitObjectId(parentValue, 'parent') : '';
    const limit = Math.max(1, Math.min(2000, Number(options.limit) || DEFAULT_GIT_CHANGES_LIMIT));

    try {
      const { stdout: parentOutput } = await this.execFile(this.gitPath, [
        '-C', root, 'rev-list', '--parents', '-n', '1', commit,
      ], {
        timeout: this.gitHistoryTimeoutMs,
        maxBuffer: 64 * 1024,
      });
      const revision = String(parentOutput || '').trim().split(/\s+/).filter(Boolean);
      if (!revision.length || revision[0].toLowerCase() !== commit) {
        throw new WorkspaceFileError('commit was not found', 404);
      }
      const parentIds = revision.slice(1).map(value => value.toLowerCase());
      if (requestedParent && !parentIds.includes(requestedParent)) {
        throw new WorkspaceFileError('parent is not a parent of commit', 400);
      }
      const parent = requestedParent || parentIds[0] || '';
      let comparisonBase = parent;
      if (!comparisonBase) {
        let objectFormat = 'sha1';
        try {
          const result = await this.execFile(this.gitPath, ['-C', root, 'rev-parse', '--show-object-format'], {
            timeout: 1500,
            maxBuffer: 64 * 1024,
          });
          objectFormat = String(result.stdout || '').trim();
        } catch {
          // Git versions without --show-object-format use SHA-1 repositories.
        }
        comparisonBase = gitEmptyTreeObjectId(objectFormat);
      }
      const args = parent
        ? ['-C', root, 'diff', '--name-status', '-z', '-M', parent, commit, '--']
        : ['-C', root, 'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '-M', commit];
      const { stdout } = await this.execFile(this.gitPath, args, {
        timeout: this.gitHistoryTimeoutMs,
        maxBuffer: this.gitHistoryMaxBuffer,
      });
      const allItems = parseGitHistoryChanges(stdout);
      return {
        commit,
        comparisonBase,
        parent: parent || null,
        parentIds,
        items: allItems.slice(0, limit),
        truncated: allItems.length > limit,
      };
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code === 'ENOENT') throw new WorkspaceFileError('git is not installed', 501);
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        throw new WorkspaceFileError('git commit changes timed out', 504);
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new WorkspaceFileError('git commit changes output is too large', 413);
      }
      if (error.stderr && /(bad object|unknown revision|ambiguous argument|not a valid object name)/i.test(String(error.stderr))) {
        throw new WorkspaceFileError('commit was not found', 404);
      }
      if (error.stderr && /not a git repository/i.test(String(error.stderr))) {
        throw new WorkspaceFileError('workspace is not a git repository', 409);
      }
      throw new WorkspaceFileError(String(error.stderr || 'git commit changes failed'), 500);
    }
  }

  async changes(workspaceRoot: unknown, options: Record<string, unknown> = {}) {
    const root = await this.resolveRoot(workspaceRoot);
    const limit = Math.max(1, Math.min(2000, Number(options.limit) || DEFAULT_GIT_CHANGES_LIMIT));
    const gitStatusByPath = await this.loadGitStatusByPath(root, {
      allowPartial: true,
      excludeHidden: false,
      maxBuffer: DEFAULT_GIT_CHANGES_MAX_BUFFER,
      throwOnError: true,
      untrackedFiles: 'all',
    });
    this.invalidateGitStatus(root);
    const visibleEntries = Array.from(gitStatusByPath.entries())
      .filter(([filePath]) => !shouldHidePath(filePath))
      .sort((left, right) => (
        gitStatusReviewRank(left[1].kind) - gitStatusReviewRank(right[1].kind)
        || left[0].localeCompare(right[0])
      ));
    const allItems = await Promise.all(visibleEntries
      .slice(0, limit)
      .map(async ([filePath, status]) => ({
        path: filePath,
        name: path.posix.basename(filePath),
        type: await workspaceEntryTypeForGitChange(root, filePath),
        gitStatus: status.kind,
        gitStatusLabel: status.label,
        ...(status.previousPath ? { previousPath: status.previousPath } : {}),
      })));

    const typedGitStatusByPath = gitStatusByPath;
    return {
      items: allItems,
      truncated: typedGitStatusByPath.truncated === true || visibleEntries.length > limit,
    };
  }

  async readFile(workspaceRoot: unknown, userPath: unknown, options: ResolvePathOptions = {}) {
    const { target, relativePath, external, readOnly, symbolicLink } = await this.resolvePath(workspaceRoot, userPath, options);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      throw new WorkspaceFileError('path must be a file', 400);
    }
    const preview = previewForPath(relativePath);
    if (preview) {
      if (stat.size > this.maxPreviewFileSize) {
        throw new WorkspaceFileError('file is too large to preview', 413, { size: stat.size });
      }
      const buffer = await fsp.readFile(target);
      return {
        path: relativePath,
        content: '',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha1: sha1(buffer),
        binary: true,
        preview,
        ...(symbolicLink ? { symbolicLink: true } : {}),
        ...(external ? { external: true } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      };
    }
    if (await isProbablyBinaryFile(target)) {
      return {
        path: relativePath,
        content: '',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha1: metadataFileVersion(relativePath, stat),
        binary: true,
        preview: {
          kind: 'binary',
          mediaType: 'application/octet-stream',
        },
        ...(symbolicLink ? { symbolicLink: true } : {}),
        ...(external ? { external: true } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      };
    }
    if (stat.size > this.maxFileSize) {
      return {
        path: relativePath,
        content: await readTextPrefix(target, this.maxFileSize),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha1: metadataFileVersion(relativePath, stat),
        preview: {
          kind: 'large-text',
          mediaType: 'text/plain',
          truncated: true,
        },
        ...(symbolicLink ? { symbolicLink: true } : {}),
        ...(external ? { external: true } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      };
    }

    const buffer = await fsp.readFile(target);
    if (stat.size > this.maxWriteSize) {
      return {
        path: relativePath,
        content: buffer.toString('utf8'),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha1: sha1(buffer),
        preview: {
          kind: 'large-text',
          mediaType: 'text/plain',
          truncated: false,
        },
        ...(symbolicLink ? { symbolicLink: true } : {}),
        ...(external ? { external: true } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      };
    }
    return {
      path: relativePath,
      content: buffer.toString('utf8'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha1: sha1(buffer),
      ...(symbolicLink ? { symbolicLink: true } : {}),
      ...(external ? { external: true } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    };
  }

  async readPreviewFile(workspaceRoot: unknown, userPath: unknown, options: ResolvePathOptions = {}) {
    const { target, relativePath, external, readOnly, symbolicLink } = await this.resolvePath(workspaceRoot, userPath, options);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      throw new WorkspaceFileError('path must be a file', 400);
    }
    const preview = previewForPath(relativePath, { includeTextImages: true });
    if (!preview) {
      throw new WorkspaceFileError('file preview is not available', 415);
    }
    if (stat.size > this.maxPreviewFileSize) {
      throw new WorkspaceFileError('file is too large to preview', 413, { size: stat.size });
    }
    const buffer = await fsp.readFile(target);
    return {
      path: relativePath,
      buffer,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha1: sha1(buffer),
      preview,
      ...(symbolicLink ? { symbolicLink: true } : {}),
      ...(external ? { external: true } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    };
  }

  async readTransportFile(workspaceRoot: unknown, userPath: unknown, options: ResolvePathOptions = {}) {
    const file = await this.readFile(workspaceRoot, userPath, options);
    if (!('binary' in file) || file.binary !== true) {
      const buffer = Buffer.from(file.content, 'utf8');
      return {
        path: file.path,
        buffer,
        size: buffer.byteLength,
        sha1: file.sha1,
        mediaType: ('preview' in file ? file.preview?.mediaType : undefined) || 'text/plain; charset=utf-8',
      };
    }
    try {
      const previewFile = await this.readPreviewFile(workspaceRoot, userPath, options);
      return { ...previewFile, mediaType: previewFile.preview.mediaType };
    } catch (error: unknown) {
      if (!(error instanceof WorkspaceFileError) || error.statusCode !== 415) throw error;
      const resourceFile = await this.readResourceFile(workspaceRoot, userPath, options);
      return { ...resourceFile, mediaType: 'application/octet-stream' };
    }
  }

  async readResourceFile(workspaceRoot: unknown, userPath: unknown, options: ResolvePathOptions = {}) {
    const { target, relativePath } = await this.resolvePath(workspaceRoot, userPath, options);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      throw new WorkspaceFileError('path must be a file', 400);
    }
    if (stat.size > this.maxPreviewFileSize) {
      throw new WorkspaceFileError('file is too large to preview', 413, { size: stat.size });
    }
    const buffer = await fsp.readFile(target);
    return {
      path: relativePath,
      buffer,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha1: sha1(buffer),
    };
  }

  async blameCapability(workspaceRoot: unknown, userPath: unknown, options: ResolvePathOptions = {}) {
    const { root, target, relativePath, actualRelativePath, external } = await this.resolvePath(workspaceRoot, userPath, options);
    const capability = (available: boolean, reason = '') => ({
      isGitRepo: reason !== 'not-git-repo' && reason !== 'git-unavailable',
      path: relativePath,
      available,
      ...(reason ? { reason } : {})
    });
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      throw new WorkspaceFileError('path must be a file', 400);
    }
    if (external) {
      return capability(false, 'external');
    }
    if (stat.size > this.maxFileSize) {
      return capability(false, 'too-large');
    }
    if (await isProbablyBinaryFile(target)) {
      return capability(false, 'binary');
    }

    const gitPath = actualRelativePath || relativePath;
    const directGitStatus = await this.getGitStatusForPath(root, gitPath);
    if (directGitStatus && ['added', 'deleted', 'renamed', 'untracked', 'conflicted'].includes(directGitStatus.kind)) {
      return capability(false, directGitStatus.kind);
    }

    try {
      await this.execFile(this.gitPath, [
        'ls-files',
        '--error-unmatch',
        '--',
        gitPath,
      ], { cwd: root });
      return capability(true);
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error.code === 'ENOENT') return capability(false, 'git-unavailable');
      if (error.stderr && /not a git repository/i.test(String(error.stderr))) return capability(false, 'not-git-repo');
      return capability(false, 'untracked');
    }
  }

  async writeFile(workspaceRoot: unknown, userPath: unknown, content: unknown, options: WorkspaceWriteOptions = {}) {
    return this.runWorkspaceMutation(workspaceRoot, root => this.writeFileUnlocked(root, userPath, content, options));
  }

  async flushWorkspaceFileHandle(handle: import('fs/promises').FileHandle): Promise<void> {
    if (!this.flushWorkspaceWrites) return;
    try {
      await handle.datasync();
    } catch (caught: unknown) {
      const error = processError(caught);
      if (!['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(error.code))) {
        throw error;
      }
      this.flushWorkspaceWrites = false;
      console.warn('Workspace file datasync is unsupported; disabling it for this server process:', error);
    }
  }

  async writeFileUnlocked(
    workspaceRoot: string,
    userPath: unknown,
    content: unknown,
    options: WorkspaceWriteOptions = {},
  ) {
    if (typeof content !== 'string') {
      throw new WorkspaceFileError('content must be a string', 400);
    }
    if (Buffer.byteLength(content, 'utf8') > this.maxWriteSize) {
      throw new WorkspaceFileError('file is too large to save', 413);
    }

    const { root, target, relativePath } = await this.resolvePath(workspaceRoot, userPath, { allowMissing: true });
    let writeTarget = target;
    const baseSha1 = typeof options.baseSha1 === 'string' ? options.baseSha1 : '';
    const overwrite = options.overwrite === true;
    let currentMode = 0o666;
    let currentSha1 = '';
    let currentStat = null;
    let exists = false;
    let symbolicLink = false;

    try {
      const requestedStat = await fsp.lstat(target);
      symbolicLink = requestedStat.isSymbolicLink();
      const realTarget = await fsp.realpath(target);
      if (!isInside(root, realTarget)) {
        throw new WorkspaceFileError('symlinks outside the workspace are not allowed', 403);
      }
      writeTarget = realTarget;
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    try {
      currentStat = await fsp.stat(writeTarget);
      if (!currentStat.isFile()) {
        throw new WorkspaceFileError('path must be a file', 400);
      }
      if (currentStat.size > this.maxFileSize) {
        throw new WorkspaceFileError('existing file is too large to overwrite safely', 413, { size: currentStat.size });
      }
      if (await isProbablyBinaryFile(writeTarget)) {
        throw new WorkspaceFileError('binary files cannot be overwritten as text', 415);
      }
      const currentBuffer = await fsp.readFile(writeTarget);
      currentSha1 = sha1(currentBuffer);
      currentMode = currentStat.mode;
      exists = true;
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    const desiredSha1 = sha1(Buffer.from(content, 'utf8'));
    if (baseSha1 && currentSha1 && baseSha1 !== currentSha1 && !overwrite) {
      if (currentSha1 === desiredSha1) {
        return {
          path: relativePath,
          content,
          size: Buffer.byteLength(content, 'utf8'),
          mtimeMs: currentStat.mtimeMs,
          sha1: desiredSha1,
          ...(symbolicLink ? { symbolicLink: true } : {}),
        };
      }
      throw new WorkspaceFileError('file changed on disk', 409, {
        path: relativePath,
        currentSha1,
      });
    }
    if (baseSha1 && !exists && !overwrite) {
      throw new WorkspaceFileError('file was deleted on disk', 409, { path: relativePath });
    }

    const tempPath = path.join(
      path.dirname(writeTarget),
      `.${path.basename(writeTarget)}.farming-${process.pid}-${crypto.randomUUID()}.tmp`
    );
    let tempHandle = null;
    let committedStat = null;
    try {
      tempHandle = await fsp.open(tempPath, 'wx', currentMode);
      await tempHandle.writeFile(content);
      await this.flushWorkspaceFileHandle(tempHandle);
      committedStat = await tempHandle.stat();
      await tempHandle.close();
      tempHandle = null;
      await fsp.rename(tempPath, writeTarget);
    } catch (caught: unknown) {
      const error = processError(caught);
      if (tempHandle) {
        await tempHandle.close().catch(() => {});
      }
      await fsp.unlink(tempPath).catch((caughtUnlink: unknown) => {
        const unlinkError = processError(caughtUnlink);
        if (unlinkError.code !== 'ENOENT') {
          console.error('Failed to clean up workspace file temporary:', unlinkError);
        }
      });
      throw error;
    }
    this.invalidateGitStatus(root);

    return {
      path: relativePath,
      content,
      size: Buffer.byteLength(content, 'utf8'),
      mtimeMs: committedStat.mtimeMs,
      sha1: desiredSha1,
      ...(symbolicLink ? { symbolicLink: true } : {}),
    };
  }

  async moveEntry(
    workspaceRoot: unknown,
    sourcePath: unknown,
    targetDirectory: unknown = '',
    options: WorkspaceEntryVersionOptions = {},
  ): Promise<WorkspaceEntryMutationResult> {
    return this.runWorkspaceMutation(workspaceRoot, root => this.moveEntryUnlocked(root, sourcePath, targetDirectory, options));
  }

  async moveEntryUnlocked(
    workspaceRoot: string,
    sourcePath: unknown,
    targetDirectory: unknown = '',
    options: WorkspaceEntryVersionOptions = {},
  ): Promise<WorkspaceEntryMutationResult> {
    const root = await this.resolveRoot(workspaceRoot);
    const normalizedSource = normalizeUserPath(sourcePath);
    const normalizedTargetDirectory = normalizeUserPath(targetDirectory);

    if (!normalizedSource) {
      throw new WorkspaceFileError('source path is required', 400);
    }
    if (shouldIgnorePath(normalizedSource) || shouldIgnorePath(normalizedTargetDirectory)) {
      throw new WorkspaceFileError('ignored paths cannot be moved', 403);
    }

    const source = await this.resolveEntryPath(workspaceRoot, normalizedSource);
    const targetDirectoryPath = path.resolve(root, normalizedTargetDirectory);
    let targetDirectoryRealPath;
    try {
      targetDirectoryRealPath = await fsp.realpath(targetDirectoryPath);
    } catch {
      throw new WorkspaceFileError('target directory not found', 404);
    }
    if (!isInside(root, targetDirectoryRealPath)) {
      throw new WorkspaceFileError('target directory must stay inside the workspace', 403);
    }

    const targetDirectoryStat = await fsp.stat(targetDirectoryRealPath);
    if (!targetDirectoryStat.isDirectory()) {
      throw new WorkspaceFileError('target path must be a directory', 400);
    }

    const target = path.join(targetDirectoryRealPath, path.basename(source.target));
    const targetPath = relativeFromRoot(root, target);
    if (shouldIgnorePath(targetPath)) {
      throw new WorkspaceFileError('ignored paths cannot be moved', 403);
    }

    if (target === source.target) {
      return {
        sourcePath: source.relativePath,
        targetPath,
        sourceDirectory: parentDirectory(source.relativePath),
        targetDirectory: normalizedTargetDirectory,
      };
    }

    const sourceStat = await fsp.lstat(source.target);
    const sourceVersion = workspaceEntryVersion(sourceStat);
    if (options.expectedVersion && options.expectedVersion !== sourceVersion) {
      throw new WorkspaceFileError('source changed on disk', 409, {
        path: source.relativePath,
        currentVersion: sourceVersion,
      });
    }
    if (sourceStat.isDirectory() && isInside(source.target, target)) {
      throw new WorkspaceFileError('directory cannot be moved into itself', 400);
    }

    try {
      await fsp.lstat(target);
      throw new WorkspaceFileError('target path already exists', 409, { path: targetPath });
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    await fsp.rename(source.target, target);
    const targetStat = await fsp.lstat(target);
    this.invalidateGitStatus(root);

    return {
      sourcePath: source.relativePath,
      targetPath,
      sourceDirectory: parentDirectory(source.relativePath),
      targetDirectory: normalizedTargetDirectory,
      sourceVersion,
      targetVersion: workspaceEntryVersion(targetStat),
    };
  }

  async createEntry(workspaceRoot: unknown, parentPath: unknown = '', name: unknown, type: unknown = 'file', content: unknown = '') {
    return this.runWorkspaceMutation(workspaceRoot, root => this.createEntryUnlocked(root, parentPath, name, type, content));
  }

  async createEntryUnlocked(workspaceRoot: string, parentPath: unknown = '', name: unknown, type: unknown = 'file', content: unknown = '') {
    const root = await this.resolveRoot(workspaceRoot);
    const normalizedParentPath = normalizeUserPath(parentPath);
    const entryName = normalizeEntryName(name);
    const entryType = type === 'directory' ? 'directory' : 'file';

    if (shouldIgnorePath(normalizedParentPath)) {
      throw new WorkspaceFileError('ignored paths cannot be changed', 403);
    }
    if (entryType === 'file' && Buffer.byteLength(String(content || ''), 'utf8') > this.maxWriteSize) {
      throw new WorkspaceFileError('file is too large to save', 413);
    }

    const parentDirectoryPath = path.resolve(root, normalizedParentPath);
    let parentDirectoryRealPath;
    try {
      parentDirectoryRealPath = await fsp.realpath(parentDirectoryPath);
    } catch {
      throw new WorkspaceFileError('parent directory not found', 404);
    }
    if (!isInside(root, parentDirectoryRealPath)) {
      throw new WorkspaceFileError('parent directory must stay inside the workspace', 403);
    }

    const parentStat = await fsp.stat(parentDirectoryRealPath);
    if (!parentStat.isDirectory()) {
      throw new WorkspaceFileError('parent path must be a directory', 400);
    }

    const target = path.join(parentDirectoryRealPath, entryName);
    const targetPath = relativeFromRoot(root, target);
    if (shouldIgnorePath(targetPath)) {
      throw new WorkspaceFileError('ignored paths cannot be changed', 403);
    }

    if (entryType === 'directory') {
      try {
        await fsp.mkdir(target);
      } catch (caught: unknown) {
      const error = processError(caught);
        if (error.code === 'EEXIST') {
          throw new WorkspaceFileError('target path already exists', 409, { path: targetPath });
        }
        throw error;
      }
      const stat = await fsp.lstat(target);
      this.invalidateGitStatus(root);
      return {
        entry: {
          name: entryName,
          path: targetPath,
          type: 'directory',
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          version: workspaceEntryVersion(stat),
        },
      };
    }

    try {
      await fsp.writeFile(target, String(content || ''), { flag: 'wx' });
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error.code === 'EEXIST') {
        throw new WorkspaceFileError('target path already exists', 409, { path: targetPath });
      }
      throw error;
    }
    const stat = await fsp.lstat(target);
    this.invalidateGitStatus(root);
    return {
      entry: {
        name: entryName,
        path: targetPath,
        type: 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        version: workspaceEntryVersion(stat),
      },
      file: await this.readFile(workspaceRoot, targetPath),
    };
  }

  async renameEntry(
    workspaceRoot: unknown,
    sourcePath: unknown,
    name: unknown,
    options: WorkspaceEntryVersionOptions = {},
  ): Promise<WorkspaceEntryMutationResult> {
    return this.runWorkspaceMutation(workspaceRoot, root => this.renameEntryUnlocked(root, sourcePath, name, options));
  }

  async renameEntryUnlocked(
    workspaceRoot: string,
    sourcePath: unknown,
    name: unknown,
    options: WorkspaceEntryVersionOptions = {},
  ): Promise<WorkspaceEntryMutationResult> {
    const root = await this.resolveRoot(workspaceRoot);
    const normalizedSource = normalizeUserPath(sourcePath);
    const entryName = normalizeEntryName(name);

    if (!normalizedSource) {
      throw new WorkspaceFileError('source path is required', 400);
    }
    if (shouldIgnorePath(normalizedSource)) {
      throw new WorkspaceFileError('ignored paths cannot be changed', 403);
    }

    const source = await this.resolveEntryPath(workspaceRoot, normalizedSource);
    const target = path.join(path.dirname(source.target), entryName);
    const targetPath = relativeFromRoot(root, target);
    if (shouldIgnorePath(targetPath)) {
      throw new WorkspaceFileError('ignored paths cannot be changed', 403);
    }

    if (target === source.target) {
      return {
        sourcePath: source.relativePath,
        targetPath,
        sourceDirectory: parentDirectory(source.relativePath),
        targetDirectory: parentDirectory(targetPath),
      };
    }

    const sourceStat = await fsp.lstat(source.target);
    const sourceVersion = workspaceEntryVersion(sourceStat);
    if (options.expectedVersion && options.expectedVersion !== sourceVersion) {
      throw new WorkspaceFileError('source changed on disk', 409, {
        path: source.relativePath,
        currentVersion: sourceVersion,
      });
    }

    try {
      await fsp.lstat(target);
      throw new WorkspaceFileError('target path already exists', 409, { path: targetPath });
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    await fsp.rename(source.target, target);
    const targetStat = await fsp.lstat(target);
    this.invalidateGitStatus(root);

    return {
      sourcePath: source.relativePath,
      targetPath,
      sourceDirectory: parentDirectory(source.relativePath),
      targetDirectory: parentDirectory(targetPath),
      sourceVersion,
      targetVersion: workspaceEntryVersion(targetStat),
    };
  }

  async deleteEntry(
    workspaceRoot: unknown,
    userPath: unknown,
    options: WorkspaceEntryVersionOptions = {},
  ): Promise<WorkspaceDeleteResult> {
    return this.runWorkspaceMutation(workspaceRoot, root => this.deleteEntryUnlocked(root, userPath, options));
  }

  async deleteEntryUnlocked(
    workspaceRoot: string,
    userPath: unknown,
    options: WorkspaceEntryVersionOptions = {},
  ): Promise<WorkspaceDeleteResult> {
    const { root, target, relativePath } = await this.resolveEntryPath(workspaceRoot, userPath);
    if (!relativePath) {
      throw new WorkspaceFileError('workspace root cannot be deleted', 400);
    }
    if (shouldIgnorePath(relativePath)) {
      throw new WorkspaceFileError('ignored paths cannot be changed', 403);
    }

    const stat = await fsp.lstat(target);
    const version = workspaceEntryVersion(stat);
    if (options.expectedVersion && options.expectedVersion !== version) {
      throw new WorkspaceFileError('entry changed on disk', 409, {
        path: relativePath,
        currentVersion: version,
      });
    }
    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
    if (stat.isDirectory()) {
      await fsp.rm(target, { recursive: true, force: false });
    } else {
      await fsp.unlink(target);
    }
    this.invalidateGitStatus(root);

    return {
      path: relativePath,
      parentDirectory: parentDirectory(relativePath),
      type,
      version,
    };
  }

  async search(workspaceRoot: unknown, query: unknown, options: Record<string, unknown> = {}) {
    if (typeof query !== 'string' || !query.trim()) {
      throw new WorkspaceFileError('query is required', 400);
    }
    const { root, relativePath, target: searchRoot } = await this.resolvePath(workspaceRoot, options.path || '');
    const limit = Math.max(1, Math.min(500, Number(options.limit) || this.searchLimit));
    const searchPath = relativePath || '.';
    const timeout = Math.max(1000, Number(options.timeoutMs) || this.searchTimeoutMs);
    const deadline = Date.now() + timeout;
    const signal = options.signal as AbortSignal | undefined;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    signal?.throwIfAborted();
    const includeIgnored = options.includeIgnored === true;
    const filePathOnly = options.scope === 'file-path';
    const likelyPathQuery = isLikelyPathQuery(query);
    const result = (matches: unknown[], truncated: boolean) => ({
      query,
      path: searchPath,
      matches,
      truncated,
      timeoutMs: timeout
    });
    if (options.scope === 'entries') {
      const entryQuery = query.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
      const pathQuery = entryQuery.includes('/');
      // Explicit paths can select an empty directory (including the root).
      // Do not turn a selected directory into a request for all descendants.
      if (pathQuery || entryQuery === '.') {
        try {
          const scopedPath = path.join(relativePath, entryQuery);
          const resolved = await this.resolvePath(root, scopedPath);
          signal?.throwIfAborted();
          if (isInside(searchRoot, resolved.target) && !isSearchIgnoredRelativePath(resolved.relativePath)) {
            const stat = await fsp.stat(resolved.target);
            signal?.throwIfAborted();
            if (stat.isFile() || stat.isDirectory()) {
              return result([{ kind: 'path', entryType: stat.isDirectory() ? 'directory' : 'file', path: resolved.relativePath }], false);
            }
          }
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
      const [files, directories] = await Promise.all([
        this.collectPathMatchCandidates(root, searchPath, entryQuery, limit, remainingMs(), false, signal, false, pathQuery),
        this.collectDirectoryNameMatchCandidates(root, searchPath, entryQuery, limit, deadline, signal, pathQuery, isSearchIgnoredRelativePath),
      ]);
      signal?.throwIfAborted();
      const rootMatches = !relativePath && !pathQuery
        && directoryNameSearchScore(path.basename(root), entryQuery, false) !== null;
      const directoryMatches = rootMatches
        ? [{ kind: 'path', entryType: 'directory', path: '' }, ...directories.matches]
        : directories.matches;
      return result([...directoryMatches.slice(0, limit), ...files.matches],
        files.truncated || directories.truncated || directoryMatches.length >= limit || files.matches.length >= limit);
    }
    let pathMatchCandidates: PathSearchMatch[] = [];
    let searchOutputTruncated = false;

    if (includeIgnored) {
      try {
        const directPathMatch = likelyPathQuery
          ? await this.directPathMatchCandidate(root, searchPath, searchRoot, query, true, signal)
          : null;
        if (directPathMatch) {
          return result([directPathMatch], false);
        }
        if (Date.now() >= deadline) return result([], true);
        const ignoredPathSearch = await this.collectGitIgnoredPathMatchCandidates(
          root,
          searchPath,
          query,
          limit,
          remainingMs(),
          signal,
        );
        return result(ignoredPathSearch.matches, ignoredPathSearch.truncated);
      } catch (caught: unknown) {
        if (signal?.aborted) throw caught;
        const error = processError(caught);
        if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return result([], true);
        }
        return result([], false);
      }
    }

    try {
      const directPathMatch = likelyPathQuery
        ? await this.directPathMatchCandidate(root, searchPath, searchRoot, query, false, signal)
        : null;
      if (directPathMatch && (!filePathOnly || directPathMatch.entryType === 'file')) {
        return result([directPathMatch], false);
      }
      if (Date.now() >= deadline) return result([], true);
      const pathSearch = await this.collectPathMatchCandidates(
        root,
        searchPath,
        query,
        limit,
        remainingMs(),
        likelyPathQuery && !filePathOnly,
        signal,
        !filePathOnly,
        filePathOnly || likelyPathQuery,
      );
      const directoryNameSearch = filePathOnly
        ? { matches: [], truncated: false }
        : Date.now() >= deadline
        ? { matches: [], truncated: true }
        : await this.collectDirectoryNameMatchCandidates(root, searchPath, query, limit, deadline, signal);
      pathMatchCandidates = dedupePathMatches([
        ...directoryNameSearch.matches,
        ...pathSearch.matches,
      ], limit);
      searchOutputTruncated = pathSearch.truncated || directoryNameSearch.truncated;
    } catch (caught: unknown) {
      if (signal?.aborted) throw caught;
      const error = processError(caught);
      if (error.code === 'ENOENT') {
        throw new WorkspaceFileError('Farming managed ripgrep is missing or not executable', 503);
      }
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        searchOutputTruncated = true;
      }
      pathMatchCandidates = [];
    }

    if (pathMatchCandidates.length >= limit || pathMatchCandidates.length > 0 && likelyPathQuery) {
      return result(pathMatchCandidates, searchOutputTruncated || pathMatchCandidates.length >= limit);
    }
    if (filePathOnly) {
      return result(pathMatchCandidates, searchOutputTruncated || pathMatchCandidates.length >= limit);
    }
    if (Date.now() >= deadline) {
      return result(pathMatchCandidates, true);
    }

    const args = [
      '--json',
      '--color',
      'never',
      '--line-number',
      '--column',
      '--max-count',
      String(Math.min(3, limit)),
      '--hidden',
      ...searchExcludeGlobArgs(),
      '--',
      query,
      searchPath,
    ];

    let stdout;
    try {
      ({ stdout } = await this.execRipgrep(args, { cwd: root, timeout: remainingMs(), signal }));
    } catch (caught: unknown) {
      if (signal?.aborted) throw caught;
      const error = processError(caught);
      if (error.code === 1) {
        stdout = error.stdout || '';
      } else if (error.code === 'ENOENT') {
        throw new WorkspaceFileError('Farming managed ripgrep is missing or not executable', 503);
      } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        stdout = error.stdout || '';
        searchOutputTruncated = true;
      } else if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        stdout = error.stdout || '';
        searchOutputTruncated = true;
      } else {
        console.error('Workspace search command failed:', {
          code: error.code,
          signal: error.signal,
          message: error.message,
          stderr: error.stderr,
        });
        throw new WorkspaceFileError(String(error.stderr || 'search failed'), 500);
      }
    }

    const matches: Array<Record<string, unknown>> = [];
    String(stdout).split('\n').filter(Boolean).forEach((line: string) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(event) || event.type !== 'match') return;
      const data = isRecord(event.data) ? event.data : {};
      const submatches = Array.isArray(data.submatches) ? data.submatches.filter(isRecord) : [];
      const pathData = isRecord(data.path) ? data.path : {};
      const linesData = isRecord(data.lines) ? data.lines : {};
      const resultPath = normalizeSearchResultPath(pathData.text);
      if (!resultPath || isSearchIgnoredRelativePath(resultPath)) return;
      matches.push({
        kind: 'content',
        entryType: 'file',
        path: resultPath,
        lineNumber: data.line_number,
        lines: typeof linesData.text === 'string' ? linesData.text.replace(/\n$/, '') : '',
        ranges: submatches.map(match => ({
          start: match.start,
          end: match.end
        })),
      });
    });

    const combinedMatches: unknown[] = [];
    pathMatchCandidates.forEach(match => {
      combinedMatches.push(match);
    });
    matches.forEach(match => {
      combinedMatches.push(match);
    });

    return result(combinedMatches.slice(0, limit), searchOutputTruncated || combinedMatches.length > limit);
  }

  async diff(workspaceRoot: unknown, userPath: unknown = '', options: Record<string, unknown> = {}) {
    const root = await this.resolveRoot(workspaceRoot);
    const normalized = normalizeUserPath(userPath);
    let target = null;
    let relativePath = normalized;
    let gitRelativePath = normalized;
    let targetMissing = false;
    if (normalized) {
      try {
        const resolved = await this.resolvePath(workspaceRoot, normalized);
        target = resolved.target;
        relativePath = resolved.relativePath;
        gitRelativePath = resolved.actualRelativePath || resolved.relativePath;
      } catch (caught: unknown) {
      const error = processError(caught);
        if (error instanceof WorkspaceFileError && error.statusCode === 404) {
          targetMissing = true;
        } else {
          throw error;
        }
      }
    }
    const args = ['-C', root, 'diff', ...gitDiffWhitespaceArgs(options.ignoreWhitespace), ...gitDiffContextArgs(options.context), 'HEAD', '--'];
    if (normalized) args.push(gitRelativePath);

    try {
      const { stdout } = await this.execFile(this.gitPath, args, {
        cwd: root,
        timeout: this.diffTimeoutMs,
        maxBuffer: this.diffMaxBuffer,
      });
      const result = {
        isGitRepo: true,
        path: relativePath,
        patch: stdout,
      };
      if (!normalized) {
        return result;
      }

      if (targetMissing) {
        const status = await this.getGitStatusForPath(root, gitRelativePath);
        if (status?.kind !== 'deleted') {
          throw new WorkspaceFileError('path not found', 404);
        }
        const original = await this.execFile(this.gitPath, [
          '-C',
          root,
          'show',
          `HEAD:${gitRelativePath}`,
        ], { cwd: root, encoding: 'buffer' });
        const originalContent = Buffer.isBuffer(original.stdout)
          ? original.stdout.toString('utf8')
          : String(original.stdout || '');
        return {
          ...result,
          originalContent,
          modifiedContent: '',
          deleted: true,
        };
      }

      if (!target) return result;
      const stat = await fsp.stat(target);
      if (!stat.isFile()) {
        return result;
      }
      if (stat.size > this.maxFileSize || (await isProbablyBinaryFile(target))) {
        return {
          ...result,
          path: relativePath,
          binary: true,
          size: stat.size,
        };
      }

      const modifiedBuffer = await fsp.readFile(target);
      const gitStatusByPath = await this.loadGitStatusByPath(root);
      if (this.gitStatusCacheTtlMs > 0) {
        this.gitStatusCache.set(root, {
          value: gitStatusByPath,
          expiresAt: Date.now() + this.gitStatusCacheTtlMs,
        });
      }
      const status = gitStatusByPath.get(normalizeGitStatusPath(gitRelativePath)) || null;
      const originalGitPath = status?.kind === 'renamed' && status.previousPath
        ? status.previousPath
        : gitRelativePath;
      let originalContent = '';
      let untracked = false;
      try {
        const original = await this.execFile(this.gitPath, [
          '-C',
          root,
          'show',
          `HEAD:${originalGitPath}`,
        ], { cwd: root, encoding: 'buffer' });
        originalContent = Buffer.isBuffer(original.stdout)
          ? original.stdout.toString('utf8')
          : String(original.stdout || '');
      } catch (caught: unknown) {
      const error = processError(caught);
        if (error.stderr && /(exists on disk, but not in|path .* exists on disk|does not exist in|not in HEAD|invalid object name)/i.test(String(error.stderr))) {
          untracked = true;
        } else {
          throw error;
        }
      }

      return {
        ...result,
        path: relativePath,
        originalContent,
        modifiedContent: modifiedBuffer.toString('utf8'),
        untracked,
      };
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error.code === 'ENOENT') {
        throw new WorkspaceFileError('git is not installed', 501);
      }
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        throw new WorkspaceFileError('git diff timed out', 504);
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return {
          isGitRepo: true,
          path: relativePath,
          patch: error.stdout || '',
          truncated: true,
        };
      }
      if (error.stderr && /not a git repository/i.test(String(error.stderr))) {
        return {
          isGitRepo: false,
          path: normalized,
          patch: '',
        };
      }
      throw new WorkspaceFileError(String(error.stderr || 'git diff failed'), 500);
    }
  }

  async lineChanges(workspaceRoot: unknown, userPath: unknown, lineNumber: unknown, mode: unknown = 'working') {
    const requestedLineNumber = Number(lineNumber);
    if (!Number.isInteger(requestedLineNumber) || requestedLineNumber < 1) {
      throw new WorkspaceFileError('lineNumber must be a positive integer', 400);
    }
    if (mode !== 'working' && mode !== 'previous') {
      throw new WorkspaceFileError('mode must be working or previous', 400);
    }

    const { root, target, relativePath, actualRelativePath } = await this.resolvePath(workspaceRoot, userPath);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      throw new WorkspaceFileError('path must be a file', 400);
    }
    if (stat.size > this.maxFileSize) {
      throw new WorkspaceFileError('file is too large to inspect line changes', 413, { size: stat.size });
    }
    if (await isProbablyBinaryFile(target)) {
      throw new WorkspaceFileError('binary files cannot be inspected as text', 415);
    }

    const gitRelativePath = actualRelativePath || relativePath;
    const baseResult = {
      isGitRepo: true,
      path: relativePath,
      mode,
      lineNumber: requestedLineNumber,
      lookupLineNumber: requestedLineNumber,
      targetSide: mode === 'working' ? 'working' : 'revision',
      available: false,
      reason: '',
      patch: '',
      hunk: null,
    };

    try {
      if (mode === 'working') {
        const directGitStatus = await this.getGitStatusForPath(root, gitRelativePath);
        if (directGitStatus?.kind === 'untracked') {
          const modifiedContent = await fsp.readFile(target, 'utf8');
          const hunk = createAddedFileLineChangesHunk(modifiedContent, requestedLineNumber);
          return {
            ...baseResult,
            available: Boolean(hunk),
            reason: hunk ? '' : 'unchanged',
            patch: hunk ? hunk.patch : '',
            hunk,
          };
        }

        const { stdout } = await this.execFile(this.gitPath, [
          '-C',
          root,
          'diff',
          '--unified=20',
          'HEAD',
          '--',
          gitRelativePath,
        ], {
          cwd: root,
          timeout: this.diffTimeoutMs,
          maxBuffer: this.diffMaxBuffer,
        });
        const hunk = selectUnifiedDiffHunk(stdout, 'new', requestedLineNumber);
        return {
          ...baseResult,
          available: Boolean(hunk),
          reason: hunk ? '' : 'unchanged',
          patch: hunk ? hunk.patch : '',
          hunk,
        };
      }

      const blame = await this.blame(workspaceRoot, userPath);
      if (!blame.isGitRepo) {
        return {
          ...baseResult,
          isGitRepo: false,
          reason: 'not-git-repo',
        };
      }
      const blameLine = blame.lines.find(line => line.lineNumber === requestedLineNumber);
      if (!blameLine) {
        return {
          ...baseResult,
          reason: 'line-not-found',
        };
      }
      if (blameLine.uncommitted) {
        return {
          ...baseResult,
          reason: 'uncommitted',
          commit: {
            hash: blameLine.commit,
            shortHash: blameLine.shortCommit,
            author: blameLine.author,
            authorTimeIso: blameLine.authorTimeIso,
            summary: blameLine.summary,
          },
        };
      }

      const { stdout } = await this.execFile(this.gitPath, [
        '-C',
        root,
        'show',
        '--format=',
        '--unified=20',
        blameLine.commit,
        '--',
        gitRelativePath,
      ], {
        cwd: root,
        timeout: this.diffTimeoutMs,
        maxBuffer: this.diffMaxBuffer,
      });
      const hunk = selectUnifiedDiffHunk(stdout, 'new', blameLine.originalLineNumber);
      return {
        ...baseResult,
        lookupLineNumber: blameLine.originalLineNumber,
        available: Boolean(hunk),
        reason: hunk ? '' : 'not-found',
        patch: hunk ? hunk.patch : '',
        hunk,
        commit: {
          hash: blameLine.commit,
          shortHash: blameLine.shortCommit,
          author: blameLine.author,
          authorTimeIso: blameLine.authorTimeIso,
          summary: blameLine.summary,
        },
      };
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error instanceof WorkspaceFileError) {
        if (mode === 'previous' && error.statusCode === 409) {
          return {
            ...baseResult,
            reason: 'untracked',
          };
        }
        throw error;
      }
      if (error.code === 'ENOENT') {
        throw new WorkspaceFileError('git is not installed', 501);
      }
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        throw new WorkspaceFileError('git line changes timed out', 504);
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return {
          ...baseResult,
          available: false,
          reason: 'truncated',
          patch: error.stdout || '',
          truncated: true,
        };
      }
      if (error.stderr && /not a git repository/i.test(String(error.stderr))) {
        return {
          ...baseResult,
          isGitRepo: false,
          reason: 'not-git-repo',
        };
      }
      if (mode === 'previous' && error.stderr && /(no such path|does not exist in|not in HEAD|path .* exists on disk|invalid object name)/i.test(String(error.stderr))) {
        return {
          ...baseResult,
          reason: 'not-found',
        };
      }
      throw new WorkspaceFileError(String(error.stderr || 'git line changes failed'), 500);
    }
  }

  async blame(workspaceRoot: unknown, userPath: unknown) {
    const { root, target, relativePath, actualRelativePath } = await this.resolvePath(workspaceRoot, userPath);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      throw new WorkspaceFileError('path must be a file', 400);
    }
    if (stat.size > this.maxFileSize) {
      throw new WorkspaceFileError('file is too large to blame', 413, { size: stat.size });
    }
    if (await isProbablyBinaryFile(target)) {
      throw new WorkspaceFileError('binary files cannot be blamed as text', 415);
    }

    try {
      const { stdout } = await this.execFile(this.gitPath, [
        'blame',
        '--porcelain',
        '--',
        actualRelativePath || relativePath,
      ], { cwd: root, timeout: this.blameTimeoutMs, maxBuffer: DEFAULT_BLAME_MAX_BUFFER });
      const [remote, issueLinkRules] = await Promise.all([
        this.execFile(this.gitPath, [
          'config', '--get', 'remote.origin.url',
        ], { cwd: root, timeout: 1_000, maxBuffer: 64 * 1024 }).catch(() => ({ stdout: '' })),
        loadIntelliJIssueNavigationLinks(root),
      ]);
      return {
        isGitRepo: true,
        path: relativePath,
        commitUrlTemplate: gitCommitUrlTemplate(remote.stdout),
        authorUrlTemplate: gitAuthorUrlTemplate(remote.stdout),
        issueLinkRules,
        lines: parseGitBlamePorcelain(stdout),
      };
    } catch (caught: unknown) {
      const error = processError(caught);
      if (error.code === 'ENOENT') {
        throw new WorkspaceFileError('git is not installed', 501);
      }
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        throw new WorkspaceFileError('git blame timed out', 504);
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new WorkspaceFileError('git blame output is too large', 413);
      }
      if (error.stderr && /not a git repository/i.test(String(error.stderr))) {
        return {
          isGitRepo: false,
          path: relativePath,
          lines: [],
        };
      }
      if (error.stderr && /(no such path|no such ref|does not exist in|not in HEAD|no such file)/i.test(String(error.stderr))) {
        throw new WorkspaceFileError('file is not tracked by git', 409, { path: relativePath });
      }
      throw new WorkspaceFileError(String(error.stderr || 'git blame failed'), 500);
    }
  }

  normalizeExactWatchPaths(filePaths: readonly string[]): string[] {
    const normalizedPaths = Array.from(new Set(filePaths.map(filePath => normalizeUserPath(filePath)))).sort();
    if (normalizedPaths.length === 0 || normalizedPaths.length > MAX_EXACT_WATCH_PATHS_PER_SUBSCRIPTION) {
      throw new WorkspaceFileError(
        `between 1 and ${MAX_EXACT_WATCH_PATHS_PER_SUBSCRIPTION} file paths are required`,
        400,
      );
    }
    return normalizedPaths;
  }

  async resolveExactWatchTargets(
    root: string,
    filePaths: readonly string[],
  ): Promise<Map<string, string>> {
    const normalizedPaths = this.normalizeExactWatchPaths(filePaths);
    const entries = await mapWithConcurrency(
      normalizedPaths,
      EXACT_WATCH_PATH_RESOLVE_CONCURRENCY,
      async relativePath => {
      try {
        const resolved = await this.resolvePath(root, relativePath);
        const stat = await fsp.stat(resolved.target);
        if (!stat.isFile()) throw new WorkspaceFileError('watched path must be a file', 400, { path: relativePath });
        return [relativePath, resolved.target] as const;
      } catch (caught: unknown) {
        const error = processError(caught);
        if (!(caught instanceof WorkspaceFileError) || caught.statusCode !== 404) throw caught;
        const missing = await this.resolvePath(root, relativePath, { allowMissing: true });
        const entry = await fsp.lstat(missing.target).catch(() => null);
        if (entry) throw error;
        return [relativePath, missing.target] as const;
      }
      },
    );
    return new Map(entries);
  }

  attachExactWatchPaths(
    record: ExactWorkspaceWatcherRecord,
    subscriber: WorkspaceFileSubscriber,
    targets: ReadonlyMap<string, string>,
  ): string[] {
    const addedTargets: string[] = [];
    targets.forEach((target, relativePath) => {
      let pathSubscribers = record.pathSubscribers.get(relativePath);
      if (!pathSubscribers) {
        pathSubscribers = new Set();
        record.pathSubscribers.set(relativePath, pathSubscribers);
        record.pathTargets.set(relativePath, target);
        let targetPaths = record.targetPaths.get(target);
        if (!targetPaths) {
          targetPaths = new Set();
          record.targetPaths.set(target, targetPaths);
          addedTargets.push(target);
        }
        targetPaths.add(relativePath);
      }
      pathSubscribers.add(subscriber);
    });
    return addedTargets;
  }

  detachExactWatchPaths(
    record: ExactWorkspaceWatcherRecord,
    subscriber: WorkspaceFileSubscriber,
    relativePaths: Iterable<string>,
  ): string[] {
    const removedTargets: string[] = [];
    for (const relativePath of relativePaths) {
      const pathSubscribers = record.pathSubscribers.get(relativePath);
      if (!pathSubscribers) continue;
      pathSubscribers.delete(subscriber);
      if (pathSubscribers.size > 0) continue;
      record.pathSubscribers.delete(relativePath);
      const target = record.pathTargets.get(relativePath);
      record.pathTargets.delete(relativePath);
      if (!target) continue;
      const targetPaths = record.targetPaths.get(target);
      targetPaths?.delete(relativePath);
      if (targetPaths && targetPaths.size === 0) {
        record.targetPaths.delete(target);
        removedTargets.push(target);
      }
    }
    return removedTargets;
  }

  enqueueExactWatchUpdate(record: ExactWorkspaceWatcherRecord, operation: () => Promise<void>): Promise<void> {
    const update = record.updateQueue.then(operation);
    record.updateQueue = update.catch(() => {});
    return update;
  }

  async updateExactWatchSubscription(
    record: ExactWorkspaceWatcherRecord,
    subscriber: WorkspaceFileSubscriber,
    targets: ReadonlyMap<string, string>,
  ): Promise<void> {
    await this.enqueueExactWatchUpdate(record, async () => {
      if (this.exactWatchers.get(record.root) !== record || !record.watcher) {
        throw new WorkspaceFileError('workspace file watcher is no longer active', 409);
      }
      const previousPaths = record.subscribers.get(subscriber) ?? new Set<string>();
      const added = new Map(Array.from(targets).filter(([relativePath, target]) => (
        !previousPaths.has(relativePath) || record.pathTargets.get(relativePath) !== target
      )));
      const removedPaths = Array.from(previousPaths).filter(relativePath => (
        !targets.has(relativePath) || record.pathTargets.get(relativePath) !== targets.get(relativePath)
      ));
      const finalTargetPaths = new Map(Array.from(record.targetPaths, ([target, paths]) => [target, new Set(paths)]));
      removedPaths.forEach(relativePath => {
        if (record.pathSubscribers.get(relativePath)?.size !== 1) return;
        const target = record.pathTargets.get(relativePath);
        if (!target) return;
        const paths = finalTargetPaths.get(target);
        paths?.delete(relativePath);
        if (paths?.size === 0) finalTargetPaths.delete(target);
      });
      added.forEach((target, relativePath) => {
        const paths = finalTargetPaths.get(target) ?? new Set<string>();
        paths.add(relativePath);
        finalTargetPaths.set(target, paths);
      });
      if (finalTargetPaths.size > MAX_EXACT_WATCH_TARGETS_PER_WORKSPACE) {
        throw new WorkspaceFileError(
          `workspace file auto-refresh is limited to ${MAX_EXACT_WATCH_TARGETS_PER_WORKSPACE} open files`,
          413,
        );
      }
      const addedTargets = this.attachExactWatchPaths(record, subscriber, added);
      try {
        if (addedTargets.length > 0) {
          record.watcher.add(addedTargets);
          await waitForWatcherTargets(record.watcher, addedTargets);
        }
      } catch (error: unknown) {
        const rollbackTargets = this.detachExactWatchPaths(record, subscriber, added.keys());
        if (rollbackTargets.length > 0) await record.watcher.unwatch(rollbackTargets);
        throw error;
      }
      const removedTargets = this.detachExactWatchPaths(record, subscriber, removedPaths);
      record.subscribers.set(subscriber, new Set(targets.keys()));
      if (removedTargets.length > 0) await record.watcher.unwatch(removedTargets);
    });
  }

  async subscribeExactFiles(
    root: string,
    filePaths: readonly string[],
    callback: WorkspaceFileSubscriber,
  ): Promise<ExactWorkspaceFileSubscription> {
    if (this.disposed) throw new WorkspaceFileError('workspace file watcher is unavailable', 503);
    const lifecycleGeneration = this.watcherLifecycleGeneration;
    const normalizedPaths = this.normalizeExactWatchPaths(filePaths);
    let record = this.exactWatchers.get(root);
    const observedRecord = record;
    const retainedTargets = new Map<string, string>();
    if (record) {
      normalizedPaths.forEach(relativePath => {
        const target = record?.pathTargets.get(relativePath);
        if (target) retainedTargets.set(relativePath, target);
      });
    }
    const unresolvedPaths = normalizedPaths.filter(relativePath => !retainedTargets.has(relativePath));
    const targets = new Map([
      ...retainedTargets,
      ...(unresolvedPaths.length > 0
        ? await this.resolveExactWatchTargets(root, unresolvedPaths)
        : new Map<string, string>()),
    ]);
    if (this.disposed || this.watcherLifecycleGeneration !== lifecycleGeneration) {
      throw new WorkspaceFileError('workspace file watcher is unavailable', 503);
    }
    if (this.exactWatchers.get(root) !== observedRecord) {
      return await this.subscribeExactFiles(root, filePaths, callback);
    }
    let initialSubscriber = false;
    if (!record) {
      initialSubscriber = true;
      record = {
        closePromise: null,
        pathSubscribers: new Map(),
        pathTargets: new Map(),
        ready: Promise.resolve(false),
        root,
        subscribers: new Map([[callback, new Set(targets.keys())]]),
        targetPaths: new Map(),
        updateQueue: Promise.resolve(),
        watcher: null,
      };
      this.attachExactWatchPaths(record, callback, targets);
      this.exactWatchers.set(root, record);
      const initializingRecord = record;
      record.ready = (async () => {
        const chokidar = await loadChokidar();
        if (this.exactWatchers.get(root) !== initializingRecord) return false;
        const watcher = chokidar.watch(Array.from(initializingRecord.targetPaths.keys()), {
          ignoreInitial: true,
          ...this.watchOptions,
          depth: 0,
          followSymlinks: false,
        });
        initializingRecord.watcher = watcher;
        const emit = (eventType: string, absolutePath: unknown) => {
          const watchedPaths = initializingRecord.targetPaths.get(path.resolve(String(absolutePath)));
          if (!watchedPaths) return;
          this.invalidateGitStatus(root);
          watchedPaths.forEach(relativePath => {
            initializingRecord.pathSubscribers.get(relativePath)?.forEach(subscriber => subscriber({
              type: eventType,
              path: relativePath,
            }));
          });
        };
        ['add', 'change', 'unlink'].forEach(eventType => {
          watcher.on(eventType, (filePath: unknown) => emit(eventType, filePath));
        });
        watcher.on('error', (caught: unknown) => {
          const error = processError(caught);
          initializingRecord.subscribers.forEach((_, subscriber) => subscriber({
            type: 'error',
            message: error.message,
          }));
        });
        await waitForWatcherReady(watcher);
        return this.exactWatchers.get(root) === initializingRecord;
      })();
    }
    try {
      const initialized = await record.ready;
      if (!initialized) throw new WorkspaceFileError('workspace file watcher is no longer active', 409);
      if (!initialSubscriber) {
        await this.updateExactWatchSubscription(record, callback, targets);
      }
    } catch (error: unknown) {
      if (initialSubscriber && this.exactWatchers.get(root) === record) {
        this.exactWatchers.delete(root);
        if (record.watcher) await record.watcher.close();
      }
      if (!initialSubscriber && this.exactWatchers.get(root) !== record) {
        return await this.subscribeExactFiles(root, filePaths, callback);
      }
      throw error;
    }

    const subscriptionRecord = record;
    let closed = false;
    return {
      update: async paths => {
        if (closed) return;
        const normalizedPaths = this.normalizeExactWatchPaths(paths);
        const normalizedPathSet = new Set(normalizedPaths);
        const previousPaths = subscriptionRecord.subscribers.get(callback) ?? new Set<string>();
        const retainedTargets = new Map(Array.from(previousPaths)
          .filter(relativePath => normalizedPathSet.has(relativePath))
          .map(relativePath => [relativePath, subscriptionRecord.pathTargets.get(relativePath)] as const)
          .filter((entry): entry is [string, string] => Boolean(entry[1])));
        const addedPaths = normalizedPaths.filter(relativePath => !retainedTargets.has(relativePath));
        const addedTargets = addedPaths.length > 0
          ? await this.resolveExactWatchTargets(root, addedPaths)
          : new Map<string, string>();
        const nextTargets = new Map([
          ...retainedTargets,
          ...addedTargets,
        ]);
        await this.updateExactWatchSubscription(subscriptionRecord, callback, nextTargets);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await subscriptionRecord.ready.catch(() => false);
        await this.enqueueExactWatchUpdate(subscriptionRecord, async () => {
          const paths = subscriptionRecord.subscribers.get(callback) ?? new Set<string>();
          subscriptionRecord.subscribers.delete(callback);
          const removedTargets = this.detachExactWatchPaths(subscriptionRecord, callback, paths);
          if (subscriptionRecord.watcher && removedTargets.length > 0) {
            await subscriptionRecord.watcher.unwatch(removedTargets);
          }
          if (subscriptionRecord.subscribers.size > 0) return;
          if (this.exactWatchers.get(root) === subscriptionRecord) this.exactWatchers.delete(root);
          if (subscriptionRecord.watcher && !subscriptionRecord.closePromise) {
            subscriptionRecord.closePromise = Promise.resolve(subscriptionRecord.watcher.close()).then(() => {});
          }
          await subscriptionRecord.closePromise;
        });
      },
    };
  }

  async subscribe(
    workspaceRoot: unknown,
    callback: WorkspaceFileSubscriber,
    filePaths?: readonly string[],
  ): Promise<() => Promise<void>> {
    if (this.disposed) return async () => {};
    const lifecycleGeneration = this.watcherLifecycleGeneration;
    const root = await this.resolveRoot(workspaceRoot);
    if (this.disposed || this.watcherLifecycleGeneration !== lifecycleGeneration) return async () => {};
    if (filePaths) {
      const subscription = await this.subscribeExactFiles(root, filePaths, callback);
      return () => subscription.close();
    }
    const watchRoot = root;
    const watcherKey = root;
    let record = this.watchers.get(root);

    if (!record) {
      const subscribers = new Set<WorkspaceFileSubscriber>();
      const generation = this.watcherSubscriptionGeneration + 1;
      this.watcherSubscriptionGeneration = generation;

      const emit = (eventType: string, absolutePath: unknown) => {
        const relative = relativeFromRoot(watchRoot, String(absolutePath));
        if (shouldHidePath(relative)) return;
        this.invalidateGitStatus(root);
        subscribers.forEach((subscriber) => {
          subscriber({
            type: eventType,
            path: relative,
          });
        });
      };

      const emitError = (caught: unknown) => {
        const error = processError(caught);
        subscribers.forEach((subscriber) => {
          subscriber({
            type: 'error',
            message: error.message,
          });
        });
      };

      record = {
        watcher: null,
        subscribers,
        generation,
        cancelled: false,
        cancelInitialization: null,
        closePromise: null,
        ready: null,
      };
      this.watchers.set(watcherKey, record);
      const initializingRecord = record;
      record.ready = (async (): Promise<boolean> => {
        const configuredIgnored = this.watchOptions.ignored;
        const ignored = (candidatePath: unknown) => {
          const candidate = String(candidatePath);
          const relative = path.relative(watchRoot, candidate);
          if (shouldHidePath(relative)) return true;
          if (typeof configuredIgnored === 'function') return Boolean(configuredIgnored(candidate));
          if (configuredIgnored instanceof RegExp) return configuredIgnored.test(candidate);
          if (Array.isArray(configuredIgnored)) {
            return configuredIgnored.some(pattern => (
              pattern instanceof RegExp ? pattern.test(candidate) : candidate.includes(String(pattern))
            ));
          }
          return false;
        };
        const chokidar = await loadChokidar();
        if (
          initializingRecord.cancelled
          || this.watchers.get(watcherKey)?.generation !== generation
        ) return false;
        const watcher = chokidar.watch(watchRoot, {
          ignoreInitial: true,
          depth: this.watchDepth,
          ...this.watchOptions,
          ignored,
        });
        initializingRecord.watcher = watcher;

        ['add', 'change', 'unlink', 'addDir', 'unlinkDir'].forEach((eventType) => {
          watcher.on(eventType, (filePath: unknown) => emit(eventType, filePath));
        });
        watcher.on('error', emitError);
        const initialized = await new Promise<boolean>(resolve => {
          let settled = false;
          const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          watcher.once('ready', () => finish(true));
          initializingRecord.cancelInitialization = () => finish(false);
        });
        initializingRecord.cancelInitialization = null;
        return initialized
          && !initializingRecord.cancelled
          && this.watchers.get(watcherKey)?.generation === generation;
      })();
    }

    record.subscribers.add(callback);
    let initialized = false;
    try {
      initialized = await (record.ready ?? Promise.resolve(false));
    } catch (caught: unknown) {
      const error = processError(caught);
      record.subscribers.delete(callback);
      if (record.subscribers.size === 0 && this.watchers.get(watcherKey)?.generation === record.generation) {
        this.watchers.delete(watcherKey);
        await this.closeWorkspaceWatcherRecord(record);
      }
      throw error;
    }
    if (!initialized) {
      record.subscribers.delete(callback);
      return async () => {};
    }
    return async () => {
      if (!record.subscribers.delete(callback)) return;
      if (
        record.subscribers.size === 0
        && this.watchers.get(watcherKey)?.generation === record.generation
      ) {
        this.watchers.delete(watcherKey);
        await this.closeWorkspaceWatcherRecord(record);
      }
    };
  }

  async closeWorkspaceWatcherRecord(record: WorkspaceWatcherRecord): Promise<void> {
    if (record.closePromise) return record.closePromise;
    record.cancelled = true;
    record.cancelInitialization?.();
    record.closePromise = (async () => {
      await record.ready?.catch(() => false);
      if (!record.watcher) return;
      const closeResult = record.watcher.close();
      if (closeResult && typeof closeResult.then === 'function') await closeResult;
    })();
    return record.closePromise;
  }

  async dispose() {
    const watchers = Array.from(this.watchers.values());
    const exactWatchers = Array.from(this.exactWatchers.values());
    this.watchers.clear();
    this.exactWatchers.clear();
    this.disposed = true;
    this.watcherLifecycleGeneration += 1;
    this.gitStatusCache.clear();
    await Promise.all([
      ...watchers.map(record => this.closeWorkspaceWatcherRecord(record)),
      ...exactWatchers.map(async record => {
        await record.ready.catch(() => false);
        if (record.watcher) await record.watcher.close();
      }),
    ]);
    if (this.ownsCommandRunner) {
      this.commandRunner.dispose();
    }
  }
}

export {
  WorkspaceFileService,
  WorkspaceFileError,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_WRITE_SIZE,
  DEFAULT_WATCH_DEPTH,
  MAX_GIT_CHECK_IGNORE_ARG_BYTES,
  isPackagedRuntime,
  parseGitBlamePorcelain,
  gitCommitUrlTemplate,
  gitAuthorUrlTemplate,
  parseIntelliJIssueNavigationLinks,
  parseUnifiedDiffRows,
  createAddedFileLineChangesHunk,
  parseUnifiedDiffHunks,
  selectUnifiedDiffHunk,
  resolveCommandRunnerNodePath,
  gitCommandArgs,
  gitCommandEnvironment,
  normalizeGitHistoryLimit,
  normalizeGitHistorySkip,
  parseGitHistoryChanges,
  parseGitHistoryLog,
  parseGitHistoryReferences,
};
