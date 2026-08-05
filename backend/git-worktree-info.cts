const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');

interface GitWorktreeRecord {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: boolean;
  lockReason?: string;
  prunable?: boolean;
  pruneReason?: string;
}

interface GitWorktreeItem {
  bare: boolean;
  branch: string;
  current: boolean;
  detached: boolean;
  head: string;
  locked: boolean;
  lockReason: string;
  main: boolean;
  prunable: boolean;
  pruneReason: string;
  workspace: string;
}

interface GitWorktreeInfo {
  branch: string;
  commonDir: string;
  detached: boolean;
  head: string;
  linked: boolean;
  locked: boolean;
  lockReason: string;
  mainWorkspace: string;
  prunable: boolean;
  pruneReason: string;
  workspace: string;
  worktrees: GitWorktreeItem[];
}

interface ExecFileResult {
  stdout: string | Buffer;
}

type ExecFileAsync = (
  executable: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<ExecFileResult>;

interface GitWorktreeInspectOptions {
  cacheMs?: number;
  execFileAsync?: ExecFileAsync;
  timeoutMs?: number;
  worktreeListCache?: GitWorktreeListCache;
}

interface GitWorktreeCacheEntry {
  createdAt: number;
  promise: Promise<GitWorktreeInfo | null>;
}

interface GitWorktreeListCacheEntry {
  fetchedAt: number;
  pending: boolean;
  promise: Promise<GitWorktreeRecord[]>;
}

interface GitWorktreeListCacheOptions {
  maxEntries?: number;
  now?: () => number;
}

interface GitWorktreeListCache {
  get(
    commonDir: string,
    maxAgeMs: number,
    load: () => Promise<GitWorktreeRecord[]>,
  ): Promise<GitWorktreeRecord[]>;
}

const execFileAsync = promisify(execFile) as unknown as ExecFileAsync;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_MS = 3000;
const MAX_CANDIDATE_CACHE_ENTRIES = 1024;
const DEFAULT_WORKTREE_LIST_CACHE_ENTRIES = 256;
const cache = new Map<string, GitWorktreeCacheEntry>();

function normalizePathValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.resolve(trimmed);
}

function isSameOrDescendantPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeBranchRef(value: unknown): string {
  const branch = String(value || '').trim();
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

function cacheMaxAge(options: GitWorktreeInspectOptions): number {
  return typeof options.cacheMs === 'number' && Number.isFinite(options.cacheMs)
    ? Math.max(0, options.cacheMs)
    : DEFAULT_CACHE_MS;
}

function createGitWorktreeListCache(
  options: GitWorktreeListCacheOptions = {},
): GitWorktreeListCache {
  const requestedMaxEntries = Number(options.maxEntries ?? DEFAULT_WORKTREE_LIST_CACHE_ENTRIES);
  const maxEntries = Number.isFinite(requestedMaxEntries)
    ? Math.max(1, Math.floor(requestedMaxEntries))
    : DEFAULT_WORKTREE_LIST_CACHE_ENTRIES;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const entries = new Map<string, GitWorktreeListCacheEntry>();

  const touch = (commonDir: string, entry: GitWorktreeListCacheEntry) => {
    entries.delete(commonDir);
    entries.set(commonDir, entry);
  };

  return {
    get(commonDir, maxAgeMs, load) {
      const existing = entries.get(commonDir);
      if (
        maxAgeMs > 0
        && existing
        && (existing.pending || now() - existing.fetchedAt <= maxAgeMs)
      ) {
        touch(commonDir, existing);
        return existing.promise;
      }
      if (existing) entries.delete(commonDir);

      const entry = {} as GitWorktreeListCacheEntry;
      const promise = Promise.resolve()
        .then(load)
        .then(records => {
          entry.fetchedAt = now();
          entry.pending = false;
          return records;
        })
        .catch((error: unknown) => {
          if (entries.get(commonDir) === entry) entries.delete(commonDir);
          throw error;
        });
      entry.fetchedAt = 0;
      entry.pending = true;
      entry.promise = promise;
      entries.set(commonDir, entry);
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (typeof oldestKey !== 'string') break;
        entries.delete(oldestKey);
      }
      return promise;
    },
  };
}

const worktreeListCache = createGitWorktreeListCache();

function parseGitWorktreeList(output: unknown): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | null = null;

  for (const token of String(output || '').split('\0')) {
    if (!token) {
      if (current) records.push(current);
      current = null;
      continue;
    }

    const separator = token.indexOf(' ');
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? '' : token.slice(separator + 1);
    if (key === 'worktree') {
      if (current) records.push(current);
      current = { path: normalizePathValue(value) };
      continue;
    }
    if (!current) continue;

    if (key === 'HEAD') current.head = value;
    if (key === 'branch') current.branch = normalizeBranchRef(value);
    if (key === 'bare') current.bare = true;
    if (key === 'detached') current.detached = true;
    if (key === 'locked') {
      current.locked = true;
      current.lockReason = value || '';
    }
    if (key === 'prunable') {
      current.prunable = true;
      current.pruneReason = value || '';
    }
  }

  if (current) records.push(current);
  return records.filter(record => record.path);
}

function matchingWorktree(
  records: GitWorktreeRecord[],
  target: string,
): GitWorktreeRecord | null {
  return records
    .filter(record => isSameOrDescendantPath(record.path, target))
    .sort((a, b) => b.path.length - a.path.length)[0] || null;
}

async function inspectGitWorktreeUncached(
  workspace: unknown,
  options: GitWorktreeInspectOptions = {},
): Promise<GitWorktreeInfo | null> {
  const candidate = normalizePathValue(workspace);
  if (!candidate) return null;
  const timeout = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.max(250, options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const exec = options.execFileAsync || execFileAsync;

  try {
    const commonDirPromise = exec('git', ['-C', candidate, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      timeout,
      maxBuffer: 1024 * 1024,
    }).catch(async () => {
      const { stdout } = await exec('git', ['-C', candidate, 'rev-parse', '--git-common-dir'], {
        timeout,
        maxBuffer: 1024 * 1024,
      });
      const value = String(stdout || '').trim();
      return { stdout: path.isAbsolute(value) ? value : path.resolve(candidate, value) };
    });
    const [{ stdout: topLevelOutput }, { stdout: commonDirOutput }] = await Promise.all([
      exec('git', ['-C', candidate, 'rev-parse', '--show-toplevel'], {
        timeout,
        maxBuffer: 1024 * 1024,
      }),
      commonDirPromise,
    ]);

    const topLevel = normalizePathValue(topLevelOutput);
    const commonDir = normalizePathValue(commonDirOutput);
    if (!topLevel || !commonDir) return null;
    const loadWorktrees = async () => {
      const { stdout } = await exec('git', [
        '--git-dir', commonDir,
        'worktree', 'list', '--porcelain', '-z',
      ], {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      });
      return parseGitWorktreeList(stdout);
    };
    const repositoryCache = options.worktreeListCache
      || (options.execFileAsync ? null : worktreeListCache);
    const worktrees = repositoryCache
      ? await repositoryCache.get(commonDir, cacheMaxAge(options), loadWorktrees)
      : await loadWorktrees();
    const worktree = matchingWorktree(worktrees, topLevel || candidate);
    if (!worktree) return null;
    const mainWorktree = worktrees.find(record => !record.bare) || null;
    const linked = Boolean(mainWorktree && mainWorktree.path !== worktree.path);
    const mainWorkspace = mainWorktree ? mainWorktree.path : worktree.path;
    const worktreeItems = worktrees.map(record => ({
      workspace: record.path,
      head: record.head || '',
      branch: record.branch || '',
      bare: record.bare === true,
      detached: record.detached === true,
      locked: record.locked === true,
      lockReason: record.lockReason || '',
      prunable: record.prunable === true,
      pruneReason: record.pruneReason || '',
      current: record.path === worktree.path,
      main: record.path === mainWorkspace,
    }));

    return {
      workspace: worktree.path,
      commonDir,
      mainWorkspace,
      linked,
      branch: worktree.branch || '',
      head: worktree.head || '',
      detached: worktree.detached === true,
      locked: worktree.locked === true,
      lockReason: worktree.lockReason || '',
      prunable: worktree.prunable === true,
      pruneReason: worktree.pruneReason || '',
      worktrees: worktreeItems,
    };
  } catch {
    return null;
  }
}

async function inspectGitWorktree(
  workspace: unknown,
  options: GitWorktreeInspectOptions = {},
): Promise<GitWorktreeInfo | null> {
  if (options.execFileAsync) return inspectGitWorktreeUncached(workspace, options);
  const candidate = normalizePathValue(workspace);
  if (!candidate) return null;
  const now = Date.now();
  const maxAgeMs = cacheMaxAge(options);
  const cached = cache.get(candidate);
  if (maxAgeMs > 0 && cached && now - cached.createdAt <= maxAgeMs) {
    cache.delete(candidate);
    cache.set(candidate, cached);
    return cached.promise;
  }
  if (cached) cache.delete(candidate);

  const promise = inspectGitWorktreeUncached(candidate, options);
  cache.set(candidate, { createdAt: now, promise });
  while (cache.size > MAX_CANDIDATE_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    cache.delete(oldestKey);
  }
  promise.then(result => {
    if (result === null && cache.get(candidate)?.promise === promise) cache.delete(candidate);
  });
  return promise;
}

async function isLinkedWorktreeOf(
  workspace: unknown,
  candidate: unknown,
  options: GitWorktreeInspectOptions = {},
): Promise<boolean> {
  const [sourceInfo, candidateInfo] = await Promise.all([
    inspectGitWorktree(workspace, options),
    inspectGitWorktree(candidate, options),
  ]);
  return Boolean(
    sourceInfo
    && candidateInfo
    && sourceInfo.commonDir === candidateInfo.commonDir
    && candidateInfo.linked
  );
}

export {
  createGitWorktreeListCache,
  inspectGitWorktree,
  isLinkedWorktreeOf,
  parseGitWorktreeList,
};
