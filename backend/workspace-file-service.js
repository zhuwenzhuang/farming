const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile, spawn } = require('child_process');
const readline = require('readline');
const { pathToFileURL } = require('url');

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
const DEFAULT_MAX_WRITE_SIZE = 2 * 1024 * 1024;
const DEFAULT_MAX_PREVIEW_FILE_SIZE = 8 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_GIT_CHANGES_LIMIT = 500;
const DEFAULT_GIT_STATUS_CACHE_TTL_MS = 30000;
const DEFAULT_GIT_STATUS_INLINE_TIMEOUT_MS = 80;
const DEFAULT_SEARCH_TIMEOUT_MS = 3000;
const DEFAULT_BLAME_TIMEOUT_MS = 5000;
const DEFAULT_DIFF_TIMEOUT_MS = 5000;
const DEFAULT_DIFF_MAX_BUFFER = 1024 * 1024;
const DEFAULT_WATCH_DEPTH = 1;
const SEARCH_FILE_LIST_MAX_BUFFER = 16 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const PATH_SEARCH_MIN_CANDIDATES = 120;
const PATH_SEARCH_CANDIDATE_MULTIPLIER = 8;
const TIMEOUT = Symbol('timeout');
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
const HIDDEN_NAMES = new Set([
  ...SEARCH_IGNORED_NAMES,
]);
const TREE_HIDDEN_NAMES = new Set([
  ...[...HIDDEN_NAMES].filter(name => name !== 'reference'),
]);

function resolveBundledRipgrepPath() {
  const script = path.join(__dirname, '..', 'node_modules', 'ripgrep', 'lib', 'rg.mjs');
  if (fs.existsSync(script)) return script;
  const binaryName = process.platform === 'win32' ? 'rg.cmd' : 'rg';
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', binaryName);
  return fs.existsSync(bin) ? bin : '';
}

function resolveBundledRipgrepModulePath() {
  try {
    return require.resolve('ripgrep');
  } catch {
    const candidate = path.join(__dirname, '..', 'node_modules', 'ripgrep', 'lib', 'index.mjs');
    return fs.existsSync(candidate) ? candidate : '';
  }
}

function isCommandUnavailable(error) {
  return error && (error.code === 'ENOENT' || error.code === 'EACCES');
}

class WorkspaceFileError extends Error {
  constructor(message, statusCode = 400, details = {}) {
    super(message);
    this.name = 'WorkspaceFileError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function resolveCommandRunnerNodePath(options = {}) {
  return options.nodePath || process.env.FARMING_NODE_BIN || process.execPath;
}

function isPackagedRuntime() {
  return Boolean(process.pkg) || process.env.FARMING_PACKAGED_RUNTIME === '1';
}

let chokidarPromise = null;

async function loadChokidar() {
  if (!chokidarPromise) {
    chokidarPromise = import('chokidar').then(module => module.default || module);
  }
  return chokidarPromise;
}

class CommandRunner {
  constructor(options = {}) {
    this.helperPath = options.helperPath || path.join(__dirname, 'command-runner-child.js');
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

    this.ready = true;
    const rl = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', line => {
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

      const error = new Error(response.error?.message || 'command failed');
      error.code = response.error?.code;
      error.signal = response.error?.signal;
      error.stdout = response.error?.stdout || '';
      error.stderr = response.error?.stderr || '';
      pending.reject(error);
    });

    this.child.stderr.on('data', data => {
      const text = String(data || '').trim();
      if (text) console.error('Workspace command helper:', text);
    });

    this.child.on('error', () => {
      this.ready = false;
      this.child = null;
      const pending = Array.from(this.pending.values());
      this.pending.clear();
      pending.forEach(({ reject }) => reject(new Error('workspace command helper failed')));
    });

    this.child.on('exit', () => {
      this.ready = false;
      this.child = null;
      const pending = Array.from(this.pending.values());
      this.pending.clear();
      pending.forEach(({ reject }) => reject(new Error('workspace command helper exited')));
    });
  }

  run(command, args, options = {}) {
    if (!this.ready || !this.child || !this.child.stdin.writable) {
      return execFileAsync(command, args, options);
    }

    const id = String(this.nextId++);
    const request = {
      id,
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, error => {
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

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeUserPath(userPath = '') {
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

function relativeFromRoot(root, target) {
  const relative = path.relative(root, target);
  return relative.split(path.sep).join('/');
}

function normalizeSearchResultPath(resultPath) {
  return String(resultPath || '').replace(/^\.\//, '');
}

function searchExcludeGlobArgs() {
  const args = [];
  SEARCH_IGNORED_NAMES.forEach((name) => {
    args.push('--glob', `!${name}/**`);
    args.push('--glob', `!**/${name}/**`);
  });
  return args;
}

function isSearchIgnoredRelativePath(relativePath) {
  return shouldHidePath(relativePath);
}

function shouldPruneDirectoryNameSearch(relativePath) {
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

function normalizeGitStatusPath(resultPath) {
  return normalizeSearchResultPath(resultPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function previewForPath(filePath, options = {}) {
  const extension = path.extname(filePath).toLowerCase();
  if (!options.includeTextImages && TEXT_IMAGE_PREVIEW_EXTENSIONS.has(extension)) return null;
  const mediaType = IMAGE_PREVIEW_MEDIA_TYPES.get(extension);
  return mediaType ? { kind: 'image', mediaType } : null;
}

function metadataFileVersion(relativePath, stat) {
  return sha1(Buffer.from(`${relativePath}:${stat.size}:${stat.mtimeMs}`, 'utf8'));
}

async function readTextPrefix(target, maxBytes) {
  const handle = await fsp.open(target, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function isProbablyBinaryFile(target) {
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

function shouldIgnorePath(filePath) {
  return filePath.split(path.sep).some(part => IGNORED_NAMES.has(part));
}

function shouldHidePath(filePath) {
  return String(filePath || '').split(/[\\/]/).some(part => HIDDEN_NAMES.has(part));
}

function normalizeEntryName(name) {
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

function parentDirectory(filePath) {
  const normalized = String(filePath || '').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }, (error, stdout, stderr) => {
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

function gitStatusKind(statusCode) {
  if (!statusCode || statusCode.length < 2) return 'modified';
  if (statusCode === '??') return 'untracked';
  if (statusCode.includes('U') || statusCode === 'AA' || statusCode === 'DD') return 'conflicted';
  if (statusCode.includes('D')) return 'deleted';
  if (statusCode.includes('A')) return 'added';
  if (statusCode.includes('R')) return 'renamed';
  if (statusCode.includes('M')) return 'modified';
  return 'modified';
}

function gitStatusLabel(kind) {
  if (kind === 'added') return 'A';
  if (kind === 'deleted') return 'D';
  if (kind === 'renamed') return 'R';
  if (kind === 'untracked') return 'U';
  if (kind === 'conflicted') return '!';
  return 'M';
}

function gitStatusReviewRank(kind) {
  if (kind === 'conflicted') return 0;
  if (kind === 'modified') return 1;
  if (kind === 'added') return 2;
  if (kind === 'deleted') return 3;
  if (kind === 'renamed') return 4;
  if (kind === 'untracked') return 5;
  return 6;
}

async function workspaceEntryTypeForGitChange(root, filePath) {
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

function gitStatusRank(kind) {
  if (kind === 'conflicted') return 6;
  if (kind === 'deleted') return 5;
  if (kind === 'modified') return 4;
  if (kind === 'renamed') return 3;
  if (kind === 'added') return 2;
  if (kind === 'untracked') return 1;
  return 0;
}

function isPathWordBoundary(text, index) {
  if (index === 0) return true;
  const previous = text[index - 1] || '';
  const current = text[index] || '';
  if (/[-_\s./\\]/.test(previous)) return true;
  return /[a-z0-9]/.test(previous) && /[A-Z]/.test(current);
}

function scoreBoundaryMatch(text, normalizedQuery) {
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

function scorePathMatch(filePath, query, options = {}) {
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

function pathSearchEntryRank(entryType) {
  return entryType === 'directory' ? 0 : 1;
}

function pathSearchDepth(filePath) {
  return normalizeSearchResultPath(filePath).split('/').filter(Boolean).length;
}

function comparePathSearchMatches(a, b) {
  return (
    a.score - b.score ||
    pathSearchDepth(a.path) - pathSearchDepth(b.path) ||
    pathSearchEntryRank(a.entryType) - pathSearchEntryRank(b.entryType) ||
    a.path.localeCompare(b.path)
  );
}

function pathSearchMatchForPath(filePath, query, entryType, allowPathMatch) {
  const score = scorePathMatch(filePath, query, { allowPathMatch });
  if (score === null) return null;
  return {
    path: filePath,
    entryType,
    score,
  };
}

function directoryNameSearchScore(directoryPath, query, allowPathMatch) {
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

function directoryNameSearchMatchForPath(directoryPath, query, allowPathMatch) {
  const score = directoryNameSearchScore(directoryPath, query, allowPathMatch);
  if (score === null) return null;
  return {
    path: directoryPath,
    entryType: 'directory',
    score,
  };
}

function ancestorDirectoryPaths(filePath) {
  const segments = normalizeSearchResultPath(filePath).split('/').filter(Boolean);
  const ancestors = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/'));
  }
  return ancestors;
}

function pathSearchMatchesForFile(filePath, query) {
  const allowPathMatch = isLikelyPathQuery(query);
  const matches = [];
  const fileMatch = pathSearchMatchForPath(filePath, query, 'file', allowPathMatch);
  if (fileMatch) matches.push(fileMatch);
  ancestorDirectoryPaths(filePath).forEach((directoryPath) => {
    if (isSearchIgnoredRelativePath(directoryPath)) return;
    const directoryMatch = pathSearchMatchForPath(directoryPath, query, 'directory', allowPathMatch);
    if (directoryMatch) matches.push(directoryMatch);
  });
  return matches;
}

function isLikelyPathQuery(query) {
  return /[./\\]/.test(String(query || '').trim());
}

function dedupePathMatches(matches, limit) {
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

function parseGitStatus(stdout) {
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

function parseGitBlamePorcelain(stdout) {
  const lines = String(stdout || '').split('\n');
  const blameLines = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index];
    const match = /^(\^?[0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(header || '');
    if (!match) {
      index += 1;
      continue;
    }

    const entry = {
      commit: match[1].replace(/^\^/, ''),
      originalLineNumber: Number(match[2]),
      lineNumber: Number(match[3]),
      author: '',
      authorMail: '',
      authorTime: null,
      authorTimeIso: '',
      summary: '',
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

    const uncommitted = /^0+$/.test(entry.commit);
    blameLines.push({
      ...entry,
      shortCommit: uncommitted ? 'uncommitted' : entry.commit.slice(0, 8),
      uncommitted,
    });
  }

  return blameLines;
}

function parseUnifiedDiffHunks(patch) {
  const lines = String(patch || '').split('\n');
  const hunks = [];
  let hunk = null;

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

function lineInUnifiedDiffHunk(hunk, side, lineNumber) {
  const start = side === 'old' ? hunk.oldStart : hunk.newStart;
  const count = side === 'old' ? hunk.oldLines : hunk.newLines;
  const end = Math.max(start, start + count - 1);
  return lineNumber >= start && lineNumber <= end;
}

function selectUnifiedDiffHunk(patch, side, lineNumber) {
  const hunks = parseUnifiedDiffHunks(patch);
  return hunks.find(hunk => lineInUnifiedDiffHunk(hunk, side, lineNumber)) || null;
}

function createAddedFileLineChangesHunk(content, lineNumber, contextLines = 20) {
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

function strongestStatus(current, next) {
  if (!current) return next;
  return gitStatusRank(next.kind) > gitStatusRank(current.kind) ? next : current;
}

function buildDescendantGitStatusByDirectory(statusByPath) {
  const statusByDirectory = new Map();
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
  constructor(options = {}) {
    this.maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this.maxWriteSize = options.maxWriteSize || DEFAULT_MAX_WRITE_SIZE;
    this.maxPreviewFileSize = options.maxPreviewFileSize || DEFAULT_MAX_PREVIEW_FILE_SIZE;
    this.searchLimit = options.searchLimit || DEFAULT_SEARCH_LIMIT;
    this.searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.blameTimeoutMs = options.blameTimeoutMs ?? DEFAULT_BLAME_TIMEOUT_MS;
    this.diffTimeoutMs = options.diffTimeoutMs ?? DEFAULT_DIFF_TIMEOUT_MS;
    this.diffMaxBuffer = options.diffMaxBuffer ?? DEFAULT_DIFF_MAX_BUFFER;
    const bundledRipgrepPath = resolveBundledRipgrepPath();
    this.rgPath = options.rgPath || process.env.FARMING_RG_BIN || bundledRipgrepPath || 'rg';
    this.rgFallbackPath = options.rgFallbackPath ?? (this.rgPath === 'rg' ? bundledRipgrepPath : 'rg');
    this.bundledRipgrepModulePath = options.bundledRipgrepModulePath ?? resolveBundledRipgrepModulePath();
    this.bundledRipgrepModule = null;
    this.gitPath = options.gitPath || 'git';
    this.gitStatusCacheTtlMs = options.gitStatusCacheTtlMs ?? DEFAULT_GIT_STATUS_CACHE_TTL_MS;
    this.gitStatusInlineTimeoutMs = options.gitStatusInlineTimeoutMs ?? DEFAULT_GIT_STATUS_INLINE_TIMEOUT_MS;
    this.gitStatusCache = new Map();
    this.watchers = new Map();
    this.watchOptions = options.watchOptions || {};
    this.watchDepth = Number.isFinite(options.watchDepth) ? Math.max(0, options.watchDepth) : DEFAULT_WATCH_DEPTH;
    this.commandRunner = options.commandRunner || new CommandRunner(options.commandRunnerOptions);
    this.ownsCommandRunner = !options.commandRunner;
  }

  execFile(command, args, options = {}) {
    return this.commandRunner.run(command, args, {
      maxBuffer: 2 * 1024 * 1024,
      ...options,
    });
  }

  async execRipgrep(args, options = {}) {
    try {
      return await this.execFile(this.rgPath, args, options);
    } catch (error) {
      if (!isCommandUnavailable(error) || !this.rgFallbackPath || this.rgFallbackPath === this.rgPath) {
        if (isCommandUnavailable(error)) {
          return this.runBundledRipgrep(args, options);
        }
        throw error;
      }
      this.rgPath = this.rgFallbackPath;
      try {
        return await this.execFile(this.rgPath, args, options);
      } catch (fallbackError) {
        if (isCommandUnavailable(fallbackError)) {
          return this.runBundledRipgrep(args, options);
        }
        throw fallbackError;
      }
    }
  }

  async loadBundledRipgrep() {
    if (!this.bundledRipgrepModulePath) {
      const error = new Error('bundled ripgrep is unavailable');
      error.code = 'ENOENT';
      throw error;
    }
    if (!this.bundledRipgrepModule) {
      this.bundledRipgrepModule = import(pathToFileURL(this.bundledRipgrepModulePath).href);
    }
    return this.bundledRipgrepModule;
  }

  async runBundledRipgrep(args, options = {}) {
    const { ripgrep } = await this.loadBundledRipgrep();
    const cwd = options.cwd || process.cwd();
    const run = ripgrep(args, {
      buffer: true,
      env: options.env || process.env,
      preopens: { '.': cwd },
    });
    const result = await (options.timeout
      ? Promise.race([
        run,
        new Promise((_, reject) => {
          setTimeout(() => {
            const error = new Error('bundled ripgrep timed out');
            error.code = 'ETIMEDOUT';
            reject(error);
          }, options.timeout);
        }),
      ])
      : run);
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    if (result.code && result.code !== 0) {
      const error = new Error(stderr || `ripgrep exited with code ${result.code}`);
      error.code = result.code;
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    }
    return { stdout, stderr };
  }

  async listSearchFiles(root, searchPath, timeout) {
    try {
      return await this.execFile(this.gitPath, [
        '-C',
        root,
        'ls-files',
        '-co',
        '--exclude-standard',
        '--',
        searchPath,
      ], { cwd: root, timeout, maxBuffer: SEARCH_FILE_LIST_MAX_BUFFER });
    } catch {
      return this.execRipgrep([
        '--files',
        '--hidden',
        ...searchExcludeGlobArgs(),
        searchPath,
      ], { cwd: root, timeout, maxBuffer: SEARCH_FILE_LIST_MAX_BUFFER });
    }
  }

  streamPathMatches(command, root, searchPath, query, limit, timeout, stopAtLimit = false) {
    const args = [
      '--files',
      '--hidden',
      ...searchExcludeGlobArgs(),
      searchPath,
    ];
    const candidateLimit = stopAtLimit
      ? limit
      : Math.max(PATH_SEARCH_MIN_CANDIDATES, limit * PATH_SEARCH_CANDIDATE_MULTIPLIER);

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let pending = '';
      let stderr = '';
      let settled = false;
      let truncated = false;
      const scoredMatches = [];
      const seenMatchPaths = new Set();

      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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

      const processLine = (line) => {
        const filePath = normalizeSearchResultPath(line);
        if (!filePath || isSearchIgnoredRelativePath(filePath)) return;
        for (const match of pathSearchMatchesForFile(filePath, query)) {
          if (seenMatchPaths.has(match.path)) continue;
          seenMatchPaths.add(match.path);
          scoredMatches.push(match);
          if (scoredMatches.length >= candidateLimit) {
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

      child.stdout.on('data', chunk => {
        if (settled) return;
        pending += String(chunk || '');
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          processLine(line);
          if (settled) return;
        }
      });

      child.stderr.on('data', chunk => {
        stderr += String(chunk || '');
      });

      child.on('error', error => {
        settle(error);
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        if (pending) processLine(pending);
        if (settled) return;
        if (code && code !== 0 && signal !== 'SIGTERM') {
          const error = new Error(stderr || 'path search failed');
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

  async collectPathMatchCandidates(root, searchPath, query, limit, timeout, stopAtLimit = false) {
    try {
      return await this.streamPathMatches(this.rgPath, root, searchPath, query, limit, timeout, stopAtLimit);
    } catch (error) {
      if (!isCommandUnavailable(error) || !this.rgFallbackPath || this.rgFallbackPath === this.rgPath) {
        if (isCommandUnavailable(error)) {
          return this.collectBundledPathMatchCandidates(root, searchPath, query, limit, timeout, stopAtLimit);
        }
        throw error;
      }
      this.rgPath = this.rgFallbackPath;
      try {
        return await this.streamPathMatches(this.rgPath, root, searchPath, query, limit, timeout, stopAtLimit);
      } catch (fallbackError) {
        if (isCommandUnavailable(fallbackError)) {
          return this.collectBundledPathMatchCandidates(root, searchPath, query, limit, timeout, stopAtLimit);
        }
        throw fallbackError;
      }
    }
  }

  async collectDirectoryNameMatchCandidates(root, searchPath, query, limit, timeout) {
    const startedAt = Date.now();
    const allowPathMatch = isLikelyPathQuery(query);
    const candidateLimit = Math.max(PATH_SEARCH_MIN_CANDIDATES, limit * PATH_SEARCH_CANDIDATE_MULTIPLIER);
    const startRelativePath = searchPath === '.' ? '' : normalizeSearchResultPath(searchPath);
    const startDirectory = path.resolve(root, startRelativePath || '.');
    const queue = [{ target: startDirectory, relativePath: startRelativePath }];
    const scoredMatches = [];
    const seenMatchPaths = new Set();
    let visited = 0;
    let truncated = false;

    while (queue.length > 0) {
      if (Date.now() - startedAt > timeout) {
        truncated = true;
        break;
      }
      if (visited >= candidateLimit * 4) {
        truncated = true;
        break;
      }

      const current = queue.shift();
      if (!current || shouldPruneDirectoryNameSearch(current.relativePath)) continue;
      visited += 1;

      let entries;
      try {
        entries = await fsp.readdir(current.target, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childRelativePath = normalizeSearchResultPath(
          current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name
        );
        if (!childRelativePath || shouldPruneDirectoryNameSearch(childRelativePath)) continue;
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

  async collectBundledPathMatchCandidates(root, searchPath, query, limit, timeout, stopAtLimit = false) {
    const candidateLimit = stopAtLimit
      ? limit
      : Math.max(PATH_SEARCH_MIN_CANDIDATES, limit * PATH_SEARCH_CANDIDATE_MULTIPLIER);
    const { stdout } = await this.runBundledRipgrep([
      '--files',
      '--hidden',
      ...searchExcludeGlobArgs(),
      searchPath,
    ], { cwd: root, timeout, maxBuffer: SEARCH_FILE_LIST_MAX_BUFFER });
    const scoredMatches = [];
    const seenMatchPaths = new Set();
    let truncated = false;
    for (const line of stdout.split('\n')) {
      const filePath = normalizeSearchResultPath(line);
      if (!filePath || isSearchIgnoredRelativePath(filePath)) continue;
      for (const match of pathSearchMatchesForFile(filePath, query)) {
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

  async directPathMatchCandidate(root, query) {
    if (!isLikelyPathQuery(query)) return null;
    const candidatePath = normalizeSearchResultPath(String(query || '').trim().replace(/^\.\/+/, ''));
    if (!candidatePath || candidatePath.includes('\0') || shouldHidePath(candidatePath)) return null;
    try {
      const { target, relativePath } = await this.resolvePath(root, candidatePath);
      if (!relativePath || isSearchIgnoredRelativePath(relativePath)) return null;
      const stat = await fsp.stat(target);
      if (!stat.isFile()) return null;
      return {
        kind: 'path',
        entryType: 'file',
        path: relativePath,
        lineNumber: 1,
        lines: '',
        ranges: [],
      };
    } catch {
      return null;
    }
  }

  async resolveRoot(workspaceRoot) {
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

  async resolvePath(workspaceRoot, userPath = '', options = {}) {
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
      };
    }

    let realTarget;
    try {
      realTarget = await fsp.realpath(target);
    } catch {
      throw new WorkspaceFileError('path not found', 404);
    }

    if (!isInside(root, realTarget)) {
      throw new WorkspaceFileError('symlinks outside the workspace are not allowed', 403);
    }

    return {
      root,
      target: realTarget,
      relativePath: requestedRelativePath,
      actualRelativePath: relativeFromRoot(root, realTarget),
    };
  }

  async listTree(workspaceRoot, userPath = '') {
    const { root, target, relativePath } = await this.resolvePath(workspaceRoot, userPath);
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
      throw new WorkspaceFileError('path must be a directory', 400);
    }

    const entries = await fsp.readdir(target, { withFileTypes: true });
    const { value: gitStatusByPath, pending: gitStatusPending } = await this.getGitStatusForTree(root);
    const descendantGitStatusByPath = buildDescendantGitStatusByDirectory(gitStatusByPath);
    const items = await Promise.all(entries
      .filter(entry => !TREE_HIDDEN_NAMES.has(entry.name))
      .map(async (entry) => {
        const absolute = path.join(target, entry.name);
        let entryStat;
        try {
          entryStat = await fsp.lstat(absolute);
        } catch (error) {
          if (error && error.code === 'ENOENT') return null;
          throw error;
        }
        const type = entryStat.isSymbolicLink()
          ? 'symlink'
          : entryStat.isDirectory()
            ? 'directory'
            : entryStat.isFile()
              ? 'file'
              : 'other';
        const itemPath = relativeFromRoot(root, absolute);
        const directGitStatus = gitStatusByPath.get(itemPath);
        let descendantGitStatus = null;
        if (entryStat.isDirectory()) {
          descendantGitStatus = descendantGitStatusByPath.get(itemPath) || null;
        }

        return {
          name: entry.name,
          path: itemPath,
          type,
          size: entryStat.size,
          mtimeMs: entryStat.mtimeMs,
          ...(directGitStatus ? {
            gitStatus: directGitStatus.kind,
            gitStatusLabel: directGitStatus.label,
          } : {}),
          ...(descendantGitStatus ? {
            descendantGitStatus: descendantGitStatus.kind,
          } : {}),
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
      gitStatusPending,
    };
  }

  invalidateGitStatus(root) {
    if (root) this.gitStatusCache.delete(root);
  }

  async loadGitStatusByPath(root, options = {}) {
    const untrackedFiles = options.untrackedFiles || 'normal';
    try {
      const { stdout } = await this.execFile(this.gitPath, [
        'status',
        '--porcelain=v1',
        '-z',
        `--untracked-files=${untrackedFiles}`,
        '--ignored=no',
        ...gitStatusExcludePathspecArgs(),
      ], { cwd: root });
      return parseGitStatus(stdout);
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      if (error.stderr && /not a git repository/i.test(error.stderr)) return new Map();
      return new Map();
    }
  }

  async loadGitStatusForPath(root, relativePath) {
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
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.stderr && /not a git repository/i.test(error.stderr)) return null;
      return null;
    }
  }

  async getGitStatusByPath(root) {
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

  async getGitStatusForTree(root) {
    const cached = this.gitStatusCache.get(root);
    if (cached?.value) {
      return { value: cached.value, pending: false };
    }

    const promise = this.getGitStatusByPath(root);
    if (this.gitStatusInlineTimeoutMs <= 0) {
      return { value: await promise, pending: false };
    }

    const result = await Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(TIMEOUT), this.gitStatusInlineTimeoutMs)),
    ]);

    if (result === TIMEOUT) {
      return { value: new Map(), pending: true };
    }

    return { value: result, pending: false };
  }

  async getGitStatusForPath(root, relativePath) {
    const normalizedPath = normalizeGitStatusPath(relativePath);
    if (!normalizedPath) return null;

    const cached = this.gitStatusCache.get(root);
    if (cached?.value) {
      return cached.value.get(normalizedPath) || null;
    }

    return this.loadGitStatusForPath(root, normalizedPath);
  }

  async changes(workspaceRoot, options = {}) {
    const root = await this.resolveRoot(workspaceRoot);
    const limit = Math.max(1, Math.min(2000, Number(options.limit) || DEFAULT_GIT_CHANGES_LIMIT));
    const gitStatusByPath = await this.loadGitStatusByPath(root, { untrackedFiles: 'all' });
    const allItems = await Promise.all(Array.from(gitStatusByPath.entries())
      .map(async ([filePath, status]) => ({
        path: filePath,
        name: path.posix.basename(filePath),
        type: await workspaceEntryTypeForGitChange(root, filePath),
        gitStatus: status.kind,
        gitStatusLabel: status.label,
        ...(status.previousPath ? { previousPath: status.previousPath } : {}),
      })))
    allItems
      .sort((left, right) => (
        gitStatusReviewRank(left.gitStatus) - gitStatusReviewRank(right.gitStatus)
        || left.path.localeCompare(right.path)
      ));

    return {
      items: allItems.slice(0, limit),
      truncated: allItems.length > limit,
    };
  }

  async readFile(workspaceRoot, userPath) {
    const { target, relativePath } = await this.resolvePath(workspaceRoot, userPath);
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
      };
    }

    const buffer = await fsp.readFile(target);
    return {
      path: relativePath,
      content: buffer.toString('utf8'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha1: sha1(buffer),
    };
  }

  async readPreviewFile(workspaceRoot, userPath) {
    const { target, relativePath } = await this.resolvePath(workspaceRoot, userPath);
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
    };
  }

  async blameCapability(workspaceRoot, userPath) {
    const { root, target, relativePath, actualRelativePath } = await this.resolvePath(workspaceRoot, userPath);
    const capability = (available, reason = '') => ({
      isGitRepo: reason !== 'not-git-repo' && reason !== 'git-unavailable',
      path: relativePath,
      available,
      ...(reason ? { reason } : {}),
    });
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      throw new WorkspaceFileError('path must be a file', 400);
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
    } catch (error) {
      if (error.code === 'ENOENT') return capability(false, 'git-unavailable');
      if (error.stderr && /not a git repository/i.test(error.stderr)) return capability(false, 'not-git-repo');
      return capability(false, 'untracked');
    }
  }

  async writeFile(workspaceRoot, userPath, content, options = {}) {
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
    let exists = false;

    try {
      const realTarget = await fsp.realpath(target);
      if (!isInside(root, realTarget)) {
        throw new WorkspaceFileError('symlinks outside the workspace are not allowed', 403);
      }
      writeTarget = realTarget;
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    try {
      const stat = await fsp.stat(writeTarget);
      if (!stat.isFile()) {
        throw new WorkspaceFileError('path must be a file', 400);
      }
      if (stat.size > this.maxFileSize) {
        throw new WorkspaceFileError('existing file is too large to overwrite safely', 413, { size: stat.size });
      }
      if (await isProbablyBinaryFile(writeTarget)) {
        throw new WorkspaceFileError('binary files cannot be overwritten as text', 415);
      }
      const currentBuffer = await fsp.readFile(writeTarget);
      currentSha1 = sha1(currentBuffer);
      currentMode = stat.mode;
      exists = true;
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    if (baseSha1 && currentSha1 && baseSha1 !== currentSha1 && !overwrite) {
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
      `.${path.basename(writeTarget)}.farming-${process.pid}-${Date.now()}.tmp`
    );
    await fsp.writeFile(tempPath, content, { mode: currentMode });
    await fsp.rename(tempPath, writeTarget);
    this.invalidateGitStatus(root);

    return this.readFile(workspaceRoot, relativePath);
  }

  async moveEntry(workspaceRoot, sourcePath, targetDirectory = '') {
    const root = await this.resolveRoot(workspaceRoot);
    const normalizedSource = normalizeUserPath(sourcePath);
    const normalizedTargetDirectory = normalizeUserPath(targetDirectory);

    if (!normalizedSource) {
      throw new WorkspaceFileError('source path is required', 400);
    }
    if (shouldIgnorePath(normalizedSource) || shouldIgnorePath(normalizedTargetDirectory)) {
      throw new WorkspaceFileError('ignored paths cannot be moved', 403);
    }

    const source = await this.resolvePath(workspaceRoot, normalizedSource);
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

    const sourceStat = await fsp.stat(source.target);
    if (sourceStat.isDirectory() && isInside(source.target, target)) {
      throw new WorkspaceFileError('directory cannot be moved into itself', 400);
    }

    try {
      await fsp.lstat(target);
      throw new WorkspaceFileError('target path already exists', 409, { path: targetPath });
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    await fsp.rename(source.target, target);
    this.invalidateGitStatus(root);

    return {
      sourcePath: source.relativePath,
      targetPath,
      sourceDirectory: parentDirectory(source.relativePath),
      targetDirectory: normalizedTargetDirectory,
    };
  }

  async createEntry(workspaceRoot, parentPath = '', name, type = 'file', content = '') {
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

    try {
      await fsp.lstat(target);
      throw new WorkspaceFileError('target path already exists', 409, { path: targetPath });
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    if (entryType === 'directory') {
      await fsp.mkdir(target);
      this.invalidateGitStatus(root);
      return {
        entry: {
          name: entryName,
          path: targetPath,
          type: 'directory',
          size: 0,
          mtimeMs: Date.now(),
        },
      };
    }

    await fsp.writeFile(target, String(content || ''));
    this.invalidateGitStatus(root);
    return {
      entry: {
        name: entryName,
        path: targetPath,
        type: 'file',
        size: Buffer.byteLength(String(content || ''), 'utf8'),
        mtimeMs: Date.now(),
      },
      file: await this.readFile(workspaceRoot, targetPath),
    };
  }

  async renameEntry(workspaceRoot, sourcePath, name) {
    const root = await this.resolveRoot(workspaceRoot);
    const normalizedSource = normalizeUserPath(sourcePath);
    const entryName = normalizeEntryName(name);

    if (!normalizedSource) {
      throw new WorkspaceFileError('source path is required', 400);
    }
    if (shouldIgnorePath(normalizedSource)) {
      throw new WorkspaceFileError('ignored paths cannot be changed', 403);
    }

    const source = await this.resolvePath(workspaceRoot, normalizedSource);
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

    try {
      await fsp.lstat(target);
      throw new WorkspaceFileError('target path already exists', 409, { path: targetPath });
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    await fsp.rename(source.target, target);
    this.invalidateGitStatus(root);

    return {
      sourcePath: source.relativePath,
      targetPath,
      sourceDirectory: parentDirectory(source.relativePath),
      targetDirectory: parentDirectory(targetPath),
    };
  }

  async deleteEntry(workspaceRoot, userPath) {
    const { root, target, relativePath } = await this.resolvePath(workspaceRoot, userPath);
    if (!relativePath) {
      throw new WorkspaceFileError('workspace root cannot be deleted', 400);
    }
    if (shouldIgnorePath(relativePath)) {
      throw new WorkspaceFileError('ignored paths cannot be changed', 403);
    }

    const stat = await fsp.lstat(target);
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
    };
  }

  async search(workspaceRoot, query, options = {}) {
    if (typeof query !== 'string' || !query.trim()) {
      throw new WorkspaceFileError('query is required', 400);
    }
    const { root, relativePath } = await this.resolvePath(workspaceRoot, options.path || '');
    const limit = Math.max(1, Math.min(500, Number(options.limit) || this.searchLimit));
    const searchPath = relativePath || '.';
    const timeout = Math.max(1000, Number(options.timeoutMs) || this.searchTimeoutMs);
    const likelyPathQuery = isLikelyPathQuery(query);
    let pathMatchCandidates = [];
    let searchOutputTruncated = false;

    try {
      const directPathMatch = likelyPathQuery ? await this.directPathMatchCandidate(root, query) : null;
      if (directPathMatch) {
        return {
          query,
          path: searchPath,
          matches: [directPathMatch],
          truncated: false,
        };
      }
      const pathSearch = await this.collectPathMatchCandidates(root, searchPath, query, limit, timeout, likelyPathQuery);
      const directoryNameSearch = await this.collectDirectoryNameMatchCandidates(root, searchPath, query, limit, timeout);
      pathMatchCandidates = dedupePathMatches([
        ...directoryNameSearch.matches,
        ...pathSearch.matches,
      ], limit);
      searchOutputTruncated = pathSearch.truncated || directoryNameSearch.truncated;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new WorkspaceFileError('ripgrep is not installed', 501);
      }
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        searchOutputTruncated = true;
      }
      pathMatchCandidates = [];
    }

    if (pathMatchCandidates.length >= limit || pathMatchCandidates.length > 0 && likelyPathQuery) {
      return {
        query,
        path: searchPath,
        matches: pathMatchCandidates,
        truncated: searchOutputTruncated || pathMatchCandidates.length >= limit,
      };
    }

    const args = [
      '--json',
      '--color',
      'never',
      '--line-number',
      '--column',
      '--max-count',
      String(Math.min(3, limit)),
      ...searchExcludeGlobArgs(),
      '--',
      query,
      searchPath,
    ];

    let stdout;
    try {
      ({ stdout } = await this.execRipgrep(args, { cwd: root, timeout }));
    } catch (error) {
      if (error.code === 1) {
        stdout = error.stdout || '';
      } else if (error.code === 'ENOENT') {
        throw new WorkspaceFileError('ripgrep is not installed', 501);
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
        throw new WorkspaceFileError(error.stderr || 'search failed', 500);
      }
    }

    const matches = [];
    stdout.split('\n').filter(Boolean).forEach((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== 'match') return;
      const data = event.data || {};
      const submatches = Array.isArray(data.submatches) ? data.submatches : [];
      const resultPath = normalizeSearchResultPath(data.path && data.path.text ? data.path.text : '');
      if (!resultPath || isSearchIgnoredRelativePath(resultPath)) return;
      matches.push({
        kind: 'content',
        entryType: 'file',
        path: resultPath,
        lineNumber: data.line_number,
        lines: data.lines && data.lines.text ? data.lines.text.replace(/\n$/, '') : '',
        ranges: submatches.map(match => ({
          start: match.start,
          end: match.end,
        })),
      });
    });

    const combinedMatches = [];
    pathMatchCandidates.forEach(match => {
      combinedMatches.push(match);
    });
    matches.forEach(match => {
      combinedMatches.push(match);
    });

    return {
      query,
      path: searchPath,
      matches: combinedMatches.slice(0, limit),
      truncated: searchOutputTruncated || combinedMatches.length > limit,
    };
  }

  async diff(workspaceRoot, userPath = '') {
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
      } catch (error) {
        if (error instanceof WorkspaceFileError && error.statusCode === 404) {
          targetMissing = true;
        } else {
          throw error;
        }
      }
    }
    const args = ['-C', root, 'diff', 'HEAD', '--'];
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

      const stat = await fsp.stat(target);
      if (!stat.isFile()) {
        return result;
      }
      if (stat.size > this.maxFileSize || await isProbablyBinaryFile(target)) {
        return {
          ...result,
          path: relativePath,
          binary: true,
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
      } catch (error) {
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
    } catch (error) {
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
      if (error.stderr && /not a git repository/i.test(error.stderr)) {
        return {
          isGitRepo: false,
          path: normalized,
          patch: '',
        };
      }
      throw new WorkspaceFileError(error.stderr || 'git diff failed', 500);
    }
  }

  async lineChanges(workspaceRoot, userPath, lineNumber, mode = 'working') {
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
    } catch (error) {
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
      if (error.stderr && /not a git repository/i.test(error.stderr)) {
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
      throw new WorkspaceFileError(error.stderr || 'git line changes failed', 500);
    }
  }

  async blame(workspaceRoot, userPath) {
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
        '--line-porcelain',
        '--',
        actualRelativePath || relativePath,
      ], { cwd: root, timeout: this.blameTimeoutMs });
      return {
        isGitRepo: true,
        path: relativePath,
        lines: parseGitBlamePorcelain(stdout),
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new WorkspaceFileError('git is not installed', 501);
      }
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        throw new WorkspaceFileError('git blame timed out', 504);
      }
      if (error.stderr && /not a git repository/i.test(error.stderr)) {
        return {
          isGitRepo: false,
          path: relativePath,
          lines: [],
        };
      }
      if (error.stderr && /(no such path|no such ref|does not exist in|not in HEAD|no such file)/i.test(error.stderr)) {
        throw new WorkspaceFileError('file is not tracked by git', 409, { path: relativePath });
      }
      throw new WorkspaceFileError(error.stderr || 'git blame failed', 500);
    }
  }

  async subscribe(workspaceRoot, callback) {
    const root = await this.resolveRoot(workspaceRoot);
    const watchRoot = path.resolve(workspaceRoot);
    let record = this.watchers.get(root);

    if (!record) {
      const subscribers = new Set();

      const emit = (eventType, absolutePath) => {
        const relative = relativeFromRoot(watchRoot, absolutePath);
        if (shouldHidePath(relative)) return;
        this.invalidateGitStatus(root);
        subscribers.forEach((subscriber) => {
          subscriber({
            type: eventType,
            path: relative,
          });
        });
      };

      const emitError = (error) => {
        subscribers.forEach((subscriber) => {
          subscriber({
            type: 'error',
            message: error.message,
          });
        });
      };

      const configuredIgnored = this.watchOptions.ignored;
      const ignored = (candidatePath) => {
        const relative = path.relative(watchRoot, candidatePath);
        if (shouldHidePath(relative)) return true;
        if (typeof configuredIgnored === 'function') return configuredIgnored(candidatePath);
        if (configuredIgnored instanceof RegExp) return configuredIgnored.test(candidatePath);
        if (Array.isArray(configuredIgnored)) {
          return configuredIgnored.some(pattern => (
            pattern instanceof RegExp ? pattern.test(candidatePath) : String(candidatePath).includes(String(pattern))
          ));
        }
        return false;
      };
      const chokidar = await loadChokidar();
      const watcher = chokidar.watch(watchRoot, {
        ignoreInitial: true,
        depth: this.watchDepth,
        ...this.watchOptions,
        ignored,
      });

      ['add', 'change', 'unlink', 'addDir', 'unlinkDir'].forEach((eventType) => {
        watcher.on(eventType, filePath => emit(eventType, filePath));
      });
      watcher.on('error', emitError);
      const ready = new Promise(resolve => watcher.once('ready', resolve));

      record = { watcher, subscribers, ready };
      this.watchers.set(root, record);
    }

    await record.ready;
    record.subscribers.add(callback);
    return async () => {
      record.subscribers.delete(callback);
      if (record.subscribers.size === 0) {
        this.watchers.delete(root);
        const closeResult = record.watcher.close();
        if (closeResult && typeof closeResult.then === 'function') {
          await closeResult;
        }
      }
    };
  }

  async dispose() {
    const watchers = Array.from(this.watchers.values());
    this.watchers.clear();
    this.gitStatusCache.clear();
    await Promise.all(watchers.map(record => record.watcher.close()));
    if (this.ownsCommandRunner) {
      this.commandRunner.dispose();
    }
  }
}

module.exports = {
  WorkspaceFileService,
  WorkspaceFileError,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_WRITE_SIZE,
  DEFAULT_WATCH_DEPTH,
  isPackagedRuntime,
  parseGitBlamePorcelain,
  createAddedFileLineChangesHunk,
  parseUnifiedDiffHunks,
  selectUnifiedDiffHunk,
  resolveCommandRunnerNodePath,
};
