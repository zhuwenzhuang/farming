const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_MS = 3000;
const cache = new Map();

function normalizePathValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.resolve(trimmed);
}

function isSameOrDescendantPath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeBranchRef(value) {
  const branch = String(value || '').trim();
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

function parseGitWorktreeList(output) {
  const records = [];
  let current = null;

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

function matchingWorktree(records, target) {
  return records
    .filter(record => isSameOrDescendantPath(record.path, target))
    .sort((a, b) => b.path.length - a.path.length)[0] || null;
}

async function inspectGitWorktreeUncached(workspace, options = {}) {
  const candidate = normalizePathValue(workspace);
  if (!candidate) return null;
  const timeout = Number.isFinite(options.timeoutMs)
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
    const [{ stdout: topLevelOutput }, { stdout: commonDirOutput }, { stdout: listOutput }] = await Promise.all([
      exec('git', ['-C', candidate, 'rev-parse', '--show-toplevel'], {
        timeout,
        maxBuffer: 1024 * 1024,
      }),
      commonDirPromise,
      exec('git', ['-C', candidate, 'worktree', 'list', '--porcelain', '-z'], {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      }),
    ]);

    const topLevel = normalizePathValue(topLevelOutput);
    const commonDir = normalizePathValue(commonDirOutput);
    const worktrees = parseGitWorktreeList(listOutput);
    const worktree = matchingWorktree(worktrees, topLevel || candidate);
    if (!topLevel || !commonDir || !worktree) return null;
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

async function inspectGitWorktree(workspace, options = {}) {
  if (options.execFileAsync) return inspectGitWorktreeUncached(workspace, options);
  const candidate = normalizePathValue(workspace);
  if (!candidate) return null;
  const now = Date.now();
  const maxAgeMs = Number.isFinite(options.cacheMs)
    ? Math.max(0, options.cacheMs)
    : DEFAULT_CACHE_MS;
  const cached = cache.get(candidate);
  if (cached && now - cached.createdAt <= maxAgeMs) return cached.promise;

  const promise = inspectGitWorktreeUncached(candidate, options);
  cache.set(candidate, { createdAt: now, promise });
  promise.catch(() => {
    if (cache.get(candidate)?.promise === promise) cache.delete(candidate);
  });
  return promise;
}

async function isLinkedWorktreeOf(workspace, candidate, options = {}) {
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

module.exports = {
  inspectGitWorktree,
  isLinkedWorktreeOf,
  parseGitWorktreeList,
};
