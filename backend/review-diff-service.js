const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WorkspaceFileError, parseUnifiedDiffRows } = require('./workspace-file-service');

const MAX_REVIEW_FILES = 200;
const MAX_WORKING_COPY_SCAN_FILES = 2000;
const MAX_UNTRACKED_LINES = 500;
const DIFF_CONCURRENCY = 4;

function reviewKind(gitStatus) {
  if (gitStatus === 'added' || gitStatus === 'untracked') return 'added';
  if (gitStatus === 'copied') return 'copied';
  if (gitStatus === 'deleted') return 'deleted';
  if (gitStatus === 'renamed') return 'renamed';
  if (gitStatus === 'rewritten') return 'rewritten';
  return 'modified';
}

function reviewStatus(kind) {
  if (kind === 'added') return 'A';
  if (kind === 'copied') return 'C';
  if (kind === 'deleted') return 'D';
  if (kind === 'renamed') return 'R';
  if (kind === 'rewritten') return 'W';
  if (kind === 'unmodified') return 'U';
  if (kind === 'reverted') return 'X';
  return 'M';
}

function countRows(hunks) {
  return hunks.reduce((total, hunk) => hunk.rows.reduce((count, row) => ({
    added: count.added + (row.kind === 'added' || row.kind === 'changed' ? 1 : 0),
    removed: count.removed + (row.kind === 'deleted' || row.kind === 'changed' ? 1 : 0),
  }), total), { added: 0, removed: 0 });
}

function metadataOnlyOption(value) {
  return value === true || value === '1' || value === 'true';
}

function normalizeIgnoreWhitespace(value) {
  if (value === 'ALL' || value === 'IGNORE_ALL') return 'ALL';
  if (value === 'TRAILING' || value === 'IGNORE_TRAILING') return 'TRAILING';
  if (value === 'LEADING_AND_TRAILING' || value === 'IGNORE_LEADING_AND_TRAILING') return 'LEADING_AND_TRAILING';
  return 'NONE';
}

function normalizeDiffContext(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const context = Number(value);
  if (!Number.isInteger(context) || context < 0) return undefined;
  return Math.min(context, 10000);
}

function normalizeReviewLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) return MAX_REVIEW_FILES;
  return Math.min(MAX_REVIEW_FILES, limit);
}

function normalizeWorkingCopyScope(value) {
  return value === 'tracked' || value === 'untracked' ? value : undefined;
}

function normalizeModifiedWithinDays(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : undefined;
}

function filterWorkingCopyChangeItems(root, items, options = {}, now = Date.now()) {
  const scope = normalizeWorkingCopyScope(options.scope);
  let filtered = items;
  if (scope === 'tracked') {
    filtered = items.filter(change => change.gitStatus !== 'untracked');
  } else if (scope === 'untracked') {
    filtered = items.filter(change => change.gitStatus === 'untracked');
    const modifiedWithinDays = normalizeModifiedWithinDays(options.modifiedWithinDays);
    if (modifiedWithinDays !== undefined) {
      const modifiedSince = now - modifiedWithinDays * 24 * 60 * 60 * 1000;
      filtered = filtered.filter(change => {
        if (!isSafeReviewPath(change.path)) return false;
        try {
          return fs.statSync(path.join(root, change.path)).mtimeMs >= modifiedSince;
        } catch {
          return false;
        }
      });
    }
  }
  return filtered;
}

function gitWhitespaceArgs(value) {
  const normalized = normalizeIgnoreWhitespace(value);
  if (normalized === 'ALL') return ['--ignore-all-space'];
  if (normalized === 'TRAILING') return ['--ignore-space-at-eol'];
  if (normalized === 'LEADING_AND_TRAILING') return ['--ignore-space-change'];
  return [];
}

function gitContextArgs(value) {
  const context = normalizeDiffContext(value);
  return context === undefined ? [] : [`--unified=${context}`];
}

function diffContentOptions(options = {}) {
  const ignoreWhitespace = normalizeIgnoreWhitespace(options.ignoreWhitespace);
  const context = normalizeDiffContext(options.context);
  return {
    ...(ignoreWhitespace !== 'NONE' ? { ignoreWhitespace } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}

function hasOptions(value) {
  return Object.keys(value).length > 0;
}

function reviewFileIdentity(file) {
  return {
    added: file.added,
    binary: file.binary === true,
    kind: file.kind,
    newMode: file.newMode || '',
    newSha: file.newSha || '',
    oldMode: file.oldMode || '',
    oldSha: file.oldSha || '',
    path: file.path,
    previousPath: file.previousPath || '',
    removed: file.removed,
    size: Number.isInteger(file.size) ? file.size : null,
    sizeDelta: Number.isInteger(file.sizeDelta) ? file.sizeDelta : null,
    status: file.status || reviewStatus(file.kind),
  };
}

function metadataFile(change, options = {}) {
  const kind = change.kind || reviewKind(change.gitStatus);
  return {
    added: Number.isInteger(options.added) && options.added >= 0 ? options.added : 0,
    ...(options.binary === true ? { binary: true } : {}),
    diff: { hunks: [], ...(options.truncated === true ? { truncated: true } : {}) },
    diffLoaded: false,
    ...(options.diffTooExpensive === true ? { diffTooExpensive: true } : {}),
    kind,
    ...(typeof options.newMode === 'string' ? { newMode: options.newMode } : {}),
    ...(typeof options.newSha === 'string' ? { newSha: options.newSha } : {}),
    ...(typeof options.oldMode === 'string' ? { oldMode: options.oldMode } : {}),
    ...(typeof options.oldSha === 'string' ? { oldSha: options.oldSha } : {}),
    path: change.path,
    ...(change.previousPath ? { previousPath: change.previousPath } : {}),
    removed: Number.isInteger(options.removed) && options.removed >= 0 ? options.removed : 0,
    ...(Number.isInteger(options.size) ? { size: options.size } : {}),
    ...(Number.isInteger(options.sizeDelta) ? { sizeDelta: options.sizeDelta } : {}),
    status: change.status || reviewStatus(kind),
  };
}

function assertUniqueReviewPaths(files) {
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.path)) throw new WorkspaceFileError('review snapshot contains duplicate file paths', 500);
    seen.add(file.path);
  }
  return files;
}

function untrackedLines(content) {
  const lines = String(content || '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function untrackedHunks(content) {
  const lines = untrackedLines(content);
  const visibleLines = lines.slice(0, MAX_UNTRACKED_LINES);
  return [{
    header: `@@ -0,0 +1,${visibleLines.length} @@`,
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: visibleLines.length,
    rows: visibleLines.map((text, index) => ({ kind: 'added', right: { line: index + 1, text } })),
  }];
}

function untrackedPatch(filePath, content) {
  const lines = untrackedLines(content);
  const visibleLines = lines.slice(0, MAX_UNTRACKED_LINES);
  const suffix = visibleLines.length ? `${visibleLines.map(line => `+${line}`).join('\n')}\n` : '';
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${visibleLines.length} @@`,
    suffix,
  ].join('\n');
}

function untrackedContentTooLarge(content) {
  return untrackedLines(content).length > MAX_UNTRACKED_LINES;
}

async function mapWithConcurrency(values, mapper) {
  const result = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(DIFF_CONCURRENCY, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await mapper(values[index]);
    }
  }));
  return result;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function reviewRootIdentity(root) {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return root;
  }
}

function workingCopyReviewId(root, options = {}) {
  const scope = normalizeWorkingCopyScope(options.scope);
  if (!scope) return `working-copy-${stableHash(reviewRootIdentity(root)).slice(0, 24)}`;
  const modifiedWithinDays = scope === 'untracked' ? normalizeModifiedWithinDays(options.modifiedWithinDays) : undefined;
  const identity = [reviewRootIdentity(root), scope, modifiedWithinDays || 'all'].join('\n');
  return `working-copy-${stableHash(identity).slice(0, 24)}`;
}

function workingCopyPatchset(files) {
  return `Working copy ${stableHash(JSON.stringify(files.map(reviewFileIdentity))).slice(0, 12)}`;
}

function gitRangeReviewId(root, base, head) {
  return `git-range-${stableHash(`${reviewRootIdentity(root)}\n${base}\n${head}`).slice(0, 24)}`;
}

function isSafeGitRevision(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !value.startsWith('-')
    && !/[\\\0\r\n\t ]/.test(value);
}

function isReviewHead(value) {
  return value === 'now' || isSafeGitRevision(value);
}

function gitRangeRevisionArgs(base, head) {
  return head === 'now' ? [base] : [base, head];
}

function isSafeReviewPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\0')
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && value.split(/[\\/]/).every(segment => segment && segment !== '.' && segment !== '..');
}

function nulFields(stdout) {
  const fields = String(stdout || '').split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

function changeFromStatus(status, path, previousPath) {
  if (status.startsWith('R')) return { kind: 'renamed', path, previousPath, status: 'R' };
  if (status.startsWith('C')) return { kind: 'copied', path, previousPath, status: 'C' };
  if (status === 'A') return { kind: 'added', path, status: 'A' };
  if (status === 'D') return { kind: 'deleted', path, status: 'D' };
  if (status === 'W') return { kind: 'rewritten', path, status: 'W' };
  return { kind: 'modified', path, status: 'M' };
}

function parseNameStatus(stdout) {
  if (String(stdout || '').includes('\0')) {
    const fields = nulFields(stdout);
    const changes = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++] || '';
      if (status.startsWith('R') || status.startsWith('C')) {
        const previousPath = fields[index++];
        const filePath = fields[index++];
        if (filePath) changes.push(changeFromStatus(status, filePath, previousPath));
        continue;
      }
      const filePath = fields[index++];
      if (filePath) changes.push(changeFromStatus(status, filePath));
    }
    return changes;
  }
  return String(stdout || '').split('\n').filter(Boolean).map(line => {
    const fields = line.split('\t');
    const status = fields[0] || '';
    return changeFromStatus(status, status.startsWith('R') || status.startsWith('C') ? fields[2] : fields[1], fields[1]);
  }).filter(file => file.path);
}

function normalizedNumstatPath(pathField) {
  const value = String(pathField || '');
  const braceRename = value.match(/^(.*)\{.* => (.*)\}(.*)$/);
  if (braceRename) return `${braceRename[1]}${braceRename[2]}${braceRename[3]}`;
  return value;
}

function numstatPathForChanges(pathField, changes = []) {
  const value = String(pathField || '');
  if (!value) return '';
  if (changes.some(change => change.path === value)) return value;

  const bracePath = normalizedNumstatPath(value);
  const renamed = changes.find(change => {
    if (!change.previousPath) return false;
    if (bracePath && change.path === bracePath) return true;
    if (value === `${change.previousPath} => ${change.path}`) return true;
    return false;
  });
  if (renamed) return renamed.path;
  return value;
}

function splitNumstatEntry(value) {
  const text = String(value || '');
  const first = text.indexOf('\t');
  const second = first === -1 ? -1 : text.indexOf('\t', first + 1);
  if (first === -1 || second === -1) return ['', '', ''];
  return [text.slice(0, first), text.slice(first + 1, second), text.slice(second + 1)];
}

function parseNumstat(stdout, changes = []) {
  const stats = new Map();
  if (String(stdout || '').includes('\0')) {
    const fields = nulFields(stdout);
    for (let index = 0; index < fields.length;) {
      const counts = fields[index++] || '';
      const [addedText, removedText, inlinePath] = splitNumstatEntry(counts);
      const renameLike = inlinePath === '';
      const pathField = renameLike ? `${fields[index++] || ''} => ${fields[index++] || ''}` : inlinePath;
      const added = Number(addedText);
      const removed = Number(removedText);
      const path = numstatPathForChanges(pathField, changes);
      if (!path) continue;
      stats.set(path, {
        added: Number.isInteger(added) && added >= 0 ? added : 0,
        binary: addedText === '-' || removedText === '-',
        removed: Number.isInteger(removed) && removed >= 0 ? removed : 0,
      });
    }
    return stats;
  }
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const [addedText, removedText, pathText] = splitNumstatEntry(line);
    if (!pathText) continue;
    const added = Number(addedText);
    const removed = Number(removedText);
    const path = numstatPathForChanges(pathText, changes);
    if (!path) continue;
    stats.set(path, {
      added: Number.isInteger(added) && added >= 0 ? added : 0,
      binary: addedText === '-' || removedText === '-',
      removed: Number.isInteger(removed) && removed >= 0 ? removed : 0,
    });
  }
  return stats;
}

function parseRawDiffMetadata(stdout) {
  const metadata = new Map();
  if (String(stdout || '').includes('\0')) {
    const fields = nulFields(stdout);
    for (let index = 0; index < fields.length;) {
      const header = fields[index++] || '';
      const match = header.match(/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/i);
      if (!match) continue;
      const status = match[5] || '';
      const oldPath = fields[index++];
      const filePath = (status.startsWith('R') || status.startsWith('C')) ? fields[index++] : oldPath;
      if (!filePath) continue;
      const fileMetadata = {};
      if (match[1] !== '000000') fileMetadata.oldMode = match[1];
      if (match[2] !== '000000') fileMetadata.newMode = match[2];
      if (!isZeroObjectId(match[3])) fileMetadata.oldSha = match[3];
      if (!isZeroObjectId(match[4])) fileMetadata.newSha = match[4];
      metadata.set(filePath, fileMetadata);
    }
    return metadata;
  }
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const header = fields[0] || '';
    const match = header.match(/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/i);
    if (!match) continue;
    const status = match[5] || '';
    const path = (status.startsWith('R') || status.startsWith('C')) ? fields[2] : fields[1];
    if (!path) continue;
    const fileMetadata = {};
    if (match[1] !== '000000') fileMetadata.oldMode = match[1];
    if (match[2] !== '000000') fileMetadata.newMode = match[2];
    if (!isZeroObjectId(match[3])) fileMetadata.oldSha = match[3];
    if (!isZeroObjectId(match[4])) fileMetadata.newSha = match[4];
    metadata.set(path, fileMetadata);
  }
  return metadata;
}

function patchDiffHeader(patch) {
  const lines = String(patch || '').split('\n');
  const header = [];
  for (const line of lines) {
    if (line.startsWith('@@ ')) break;
    if (!line) continue;
    header.push(line);
    if (line === 'GIT binary patch') break;
  }
  return header;
}

function isZeroObjectId(value) {
  return /^0+$/.test(String(value || ''));
}

function patchMetadata(patchOrHeader) {
  const header = Array.isArray(patchOrHeader) ? patchOrHeader : patchDiffHeader(patchOrHeader);
  const metadata = {};
  for (const line of header) {
    const index = line.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: ([0-7]{6}))?$/i);
    if (index) {
      if (!isZeroObjectId(index[1])) metadata.oldSha = index[1];
      if (!isZeroObjectId(index[2])) metadata.newSha = index[2];
      if (index[3]) {
        metadata.oldMode = metadata.oldMode || index[3];
        metadata.newMode = metadata.newMode || index[3];
      }
      continue;
    }
    const newFileMode = line.match(/^new file mode ([0-7]{6})$/);
    if (newFileMode) {
      metadata.newMode = newFileMode[1];
      continue;
    }
    const deletedFileMode = line.match(/^deleted file mode ([0-7]{6})$/);
    if (deletedFileMode) {
      metadata.oldMode = deletedFileMode[1];
      continue;
    }
    const oldMode = line.match(/^old mode ([0-7]{6})$/);
    if (oldMode) {
      metadata.oldMode = oldMode[1];
      continue;
    }
    const newMode = line.match(/^new mode ([0-7]{6})$/);
    if (newMode) metadata.newMode = newMode[1];
  }
  return metadata;
}

function fileFromPatch(change, patch) {
  const hunks = parseUnifiedDiffRows(patch);
  const totals = countRows(hunks);
  const binary = /(^|\n)(Binary files? |GIT binary patch(?:\n|$))/.test(String(patch || ''));
  const diffHeader = patchDiffHeader(patch);
  const metadata = patchMetadata(diffHeader);
  return {
    added: totals.added,
    ...(binary ? { binary: true } : {}),
    diff: {
      ...(diffHeader.length ? { diffHeader } : {}),
      hunks,
    },
    kind: change.kind,
    ...metadata,
    path: change.path,
    ...(change.previousPath ? { previousPath: change.previousPath } : {}),
    removed: totals.removed,
    status: change.status || reviewStatus(change.kind),
  };
}

function fileWithStats(file, stat) {
  if (!stat) return file;
  return {
    ...file,
    added: stat.added,
    ...(stat.binary === true ? { binary: true } : {}),
    removed: stat.removed,
  };
}

function gitDiffPathArgs(change) {
  return change.previousPath ? [change.previousPath, change.path] : [change.path];
}

function gitDiffPathspecArgs(changes = []) {
  const seen = new Set();
  const paths = [];
  for (const change of changes) {
    for (const filePath of gitDiffPathArgs(change)) {
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      paths.push(filePath);
    }
  }
  return paths;
}

class ReviewDiffService {
  constructor(agentManager, fileService) {
    this.agentManager = agentManager;
    this.fileService = fileService;
  }

  resolveWorkspace(agentId, requestedRoot) {
    if (requestedRoot !== undefined) {
      if (typeof requestedRoot !== 'string' || !requestedRoot.trim() || (typeof agentId === 'string' && agentId.trim())) {
        throw new WorkspaceFileError('exactly one review workspace target is required', 400);
      }
      let root;
      try {
        root = fs.realpathSync.native(path.resolve(requestedRoot));
      } catch {
        throw new WorkspaceFileError('review workspace does not exist', 404);
      }
      if (!fs.statSync(root).isDirectory()) throw new WorkspaceFileError('review workspace must be a directory', 400);
      return root;
    }
    if (typeof agentId !== 'string' || !agentId.trim()) {
      throw new WorkspaceFileError('review workspace target is required', 400);
    }
    const root = this.agentManager?.getAgentWorkspaceRoot?.(agentId);
    if (!root) throw new WorkspaceFileError('agent not found', 404);
    return root;
  }

  async getWorkingCopyChanges(root, options, limit) {
    const scope = normalizeWorkingCopyScope(options.scope);
    const scanLimit = scope ? MAX_WORKING_COPY_SCAN_FILES : limit;
    const changes = await this.fileService.changes(root, { limit: scanLimit });
    const items = filterWorkingCopyChangeItems(root, assertUniqueReviewPaths(changes.items), options);
    return {
      items: items.slice(0, limit),
      truncated: (
        changes.truncated === true
        && (scope !== 'tracked' || changes.items.at(-1)?.gitStatus !== 'untracked')
      ) || items.length > limit,
    };
  }

  async getGitRangeChanges(root, base, head) {
    try {
      const { stdout } = await this.fileService.execFile(this.fileService.gitPath, [
        '-C',
        root,
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        ...gitRangeRevisionArgs(base, head),
        '--',
      ], { cwd: root, timeout: this.fileService.diffTimeoutMs, maxBuffer: this.fileService.diffMaxBuffer });
      const changes = parseNameStatus(stdout);
      if (head !== 'now') return changes;
      const untracked = await this.fileService.execFile(this.fileService.gitPath, [
        '-C',
        root,
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ], { cwd: root, timeout: this.fileService.diffTimeoutMs, maxBuffer: this.fileService.diffMaxBuffer });
      return [...changes, ...nulFields(untracked.stdout).map(path => ({ gitStatus: 'untracked', kind: 'added', path, status: 'A' }))];
    } catch (error) {
      if (error?.code === 'ETIMEDOUT') throw new WorkspaceFileError('git diff timed out', 504);
      throw new WorkspaceFileError(error?.stderr || error?.message || 'git diff failed', 500);
    }
  }

  async getCommitSummary(root, revision) {
    if (!isSafeGitRevision(revision) || revision === 'now') return null;
    try {
      const { stdout } = await this.fileService.execFile(this.fileService.gitPath, [
        '-C',
        root,
        'show',
        '-s',
        '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B',
        revision,
      ], { cwd: root, timeout: this.fileService.diffTimeoutMs, maxBuffer: this.fileService.diffMaxBuffer });
      const [id, authorName, authorEmail, authoredAt, ...messageParts] = String(stdout || '').split('\x1f');
      const message = messageParts.join('\x1f').trim();
      if (!/^[a-f0-9]{40,64}$/i.test(id || '') || !message) return null;
      return { authoredAt: String(authoredAt || '').trim(), authorEmail: String(authorEmail || '').trim(), authorName: String(authorName || '').trim(), id, message };
    } catch {
      return null;
    }
  }

  async getComparison(root, base, head) {
    const [baseCommit, headCommit] = await Promise.all([
      this.getCommitSummary(root, base),
      head === 'now' ? Promise.resolve(null) : this.getCommitSummary(root, head),
    ]);
    if (!baseCommit && !headCommit) return null;
    return {
      ...(baseCommit ? { base: baseCommit } : {}),
      ...(headCommit ? { head: headCommit } : {}),
      workingTree: head === 'now',
    };
  }

  async getGitRangeUntrackedFile(root, change, metadataOnly) {
    const source = await this.fileService.diff(root, change.path);
    const hunks = untrackedHunks(source.modifiedContent);
    const totals = countRows(hunks);
    const truncated = source.truncated === true || untrackedContentTooLarge(source.modifiedContent);
    const metadata = patchMetadata(patchDiffHeader(untrackedPatch(change.path, source.modifiedContent)));
    if (metadataOnly) {
      return metadataFile(change, {
        added: totals.added,
        binary: source.binary === true,
        diffTooExpensive: truncated,
        ...metadata,
        removed: totals.removed,
        size: source.size,
        sizeDelta: source.sizeDelta,
        truncated,
      });
    }
    return {
      added: totals.added,
      ...(source.binary === true ? { binary: true } : {}),
      diff: {
        diffHeader: patchDiffHeader(untrackedPatch(change.path, source.modifiedContent)),
        hunks,
        truncated,
      },
      ...(truncated ? { diffTooExpensive: true } : {}),
      kind: 'added',
      ...metadata,
      path: change.path,
      removed: totals.removed,
      ...(Number.isInteger(source.size) ? { size: source.size } : {}),
      ...(Number.isInteger(source.sizeDelta) ? { sizeDelta: source.sizeDelta } : {}),
      status: 'A',
    };
  }

  async getWorkingCopy(agentId, options = {}) {
    const root = this.resolveWorkspace(agentId, options.root);
    const limit = normalizeReviewLimit(options.limit);
    const metadataOnly = metadataOnlyOption(options.metadataOnly);
    const contentOptions = diffContentOptions(options);
    const changes = await this.getWorkingCopyChanges(root, options, limit);
    const changeItems = changes.items;
    const files = await mapWithConcurrency(changeItems, async change => {
      const source = await this.fileService.diff(root, change.path);
      const diffSource = !metadataOnly && hasOptions(contentOptions)
        ? await this.fileService.diff(root, change.path, contentOptions)
        : source;
      const isUntracked = change.gitStatus === 'untracked';
      const metadataHunks = isUntracked ? untrackedHunks(source.modifiedContent) : parseUnifiedDiffRows(source.patch);
      const hunks = isUntracked ? metadataHunks : parseUnifiedDiffRows(diffSource.patch);
      const totals = countRows(metadataHunks);
      const kind = reviewKind(change.gitStatus);
      const diffHeader = patchDiffHeader(isUntracked ? untrackedPatch(change.path, source.modifiedContent) : (diffSource.patch || source.patch));
      const metadata = patchMetadata(diffHeader);
      const untrackedTooLarge = isUntracked && untrackedContentTooLarge(source.modifiedContent);
      if (metadataOnly) {
        return metadataFile({ ...change, kind }, {
          added: totals.added,
          binary: source.binary === true,
          diffTooExpensive: source.truncated === true || untrackedTooLarge,
          ...metadata,
          removed: totals.removed,
          size: source.size,
          sizeDelta: source.sizeDelta,
          truncated: source.truncated === true || untrackedTooLarge,
        });
      }
      return {
        added: totals.added,
        ...(source.binary === true ? { binary: true } : {}),
        diff: {
          ...(diffHeader.length ? { diffHeader } : {}),
          hunks,
          truncated: source.truncated === true || diffSource.truncated === true || untrackedTooLarge,
        },
        ...(source.truncated === true || diffSource.truncated === true || untrackedTooLarge ? { diffTooExpensive: true } : {}),
        kind,
        ...metadata,
        path: change.path,
        ...(change.previousPath ? { previousPath: change.previousPath } : {}),
        removed: totals.removed,
        ...(Number.isInteger(source.size) ? { size: source.size } : {}),
        ...(Number.isInteger(source.sizeDelta) ? { sizeDelta: source.sizeDelta } : {}),
        status: reviewStatus(kind),
      };
    });

    const comparison = await this.getComparison(root, 'HEAD', 'now');
    return {
      basePatchset: 'HEAD',
      ...(comparison ? { comparison } : {}),
      files,
      isGitRepo: true,
      patchset: workingCopyPatchset(files),
      reviewId: workingCopyReviewId(root, options),
      root,
      source: 'working-copy',
      truncated: changes.truncated,
    };
  }

  async getWorkingCopyFile(agentId, filePath, options = {}) {
    const root = this.resolveWorkspace(agentId, options.root);
    const contentOptions = diffContentOptions(options);
    if (!isSafeReviewPath(filePath)) throw new WorkspaceFileError('file path is required', 400);
    const changes = await this.getWorkingCopyChanges(root, options, MAX_REVIEW_FILES);
    const changeItems = changes.items;
    const change = changeItems.find(item => item.path === filePath);
    if (!change) throw new WorkspaceFileError('review file not found', 404);
    const source = await this.fileService.diff(root, change.path);
    const diffSource = hasOptions(contentOptions)
      ? await this.fileService.diff(root, change.path, contentOptions)
      : source;
    const isUntracked = change.gitStatus === 'untracked';
    const metadataHunks = isUntracked ? untrackedHunks(source.modifiedContent) : parseUnifiedDiffRows(source.patch);
    const hunks = isUntracked ? metadataHunks : parseUnifiedDiffRows(diffSource.patch);
    const totals = countRows(metadataHunks);
    const kind = reviewKind(change.gitStatus);
    const diffHeader = patchDiffHeader(isUntracked ? untrackedPatch(change.path, source.modifiedContent) : (diffSource.patch || source.patch));
    const metadata = patchMetadata(diffHeader);
    const untrackedTooLarge = isUntracked && untrackedContentTooLarge(source.modifiedContent);
    return {
      added: totals.added,
      ...(source.binary === true ? { binary: true } : {}),
      diff: {
        ...(diffHeader.length ? { diffHeader } : {}),
        hunks,
        truncated: source.truncated === true || diffSource.truncated === true || untrackedTooLarge,
      },
      ...(source.truncated === true || diffSource.truncated === true || untrackedTooLarge ? { diffTooExpensive: true } : {}),
      kind,
      ...metadata,
      path: change.path,
      ...(change.previousPath ? { previousPath: change.previousPath } : {}),
      removed: totals.removed,
      ...(Number.isInteger(source.size) ? { size: source.size } : {}),
      ...(Number.isInteger(source.sizeDelta) ? { sizeDelta: source.sizeDelta } : {}),
      status: reviewStatus(kind),
    };
  }

  async getWorkingCopyPatch(agentId, options = {}) {
    const root = this.resolveWorkspace(agentId, options.root);
    const limit = normalizeReviewLimit(options.limit);
    const contentOptions = diffContentOptions(options);
    const changes = await this.getWorkingCopyChanges(root, options, limit);
    const changeItems = changes.items;
    const patchResults = await mapWithConcurrency(changeItems, async change => {
      const source = await this.fileService.diff(root, change.path, contentOptions);
      const untrackedTooLarge = change.gitStatus === 'untracked' && untrackedContentTooLarge(source.modifiedContent);
      return {
        patch: change.gitStatus === 'untracked'
          ? untrackedPatch(change.path, source.modifiedContent)
          : String(source.patch || ''),
        truncated: source.truncated === true || untrackedTooLarge,
      };
    });
    return {
      patch: patchResults.map(result => result.patch).filter(Boolean).join('\n'),
      truncated: changes.truncated || patchResults.some(result => result.truncated),
    };
  }

  async getGitRange(agentId, options = {}) {
    const root = this.resolveWorkspace(agentId, options.root);
    const base = String(options.base || '').trim();
    const head = String(options.head || '').trim();
    if (!isSafeGitRevision(base) || !isReviewHead(head)) {
      throw new WorkspaceFileError('base and head revisions are required', 400);
    }
    const limit = normalizeReviewLimit(options.limit);
    const ignoreWhitespace = normalizeIgnoreWhitespace(options.ignoreWhitespace);
    const context = normalizeDiffContext(options.context);
    const changes = await this.getGitRangeChanges(root, base, head);
    const comparisonPromise = this.getComparison(root, base, head);

    const selected = assertUniqueReviewPaths(changes.slice(0, limit));
    const lineStats = ignoreWhitespace !== 'NONE' && !metadataOnlyOption(options.metadataOnly)
      ? await this.getGitRangeNumstat(root, base, head, ignoreWhitespace, selected)
      : null;
    if (metadataOnlyOption(options.metadataOnly)) {
      const stats = await this.getGitRangeNumstat(root, base, head, 'NONE', selected);
      const rawMetadata = await this.getGitRangeRawMetadata(root, base, head, selected);
      const files = await mapWithConcurrency(selected, async change => {
        if (change.gitStatus === 'untracked') return this.getGitRangeUntrackedFile(root, change, true);
        return metadataFile(change, {
          ...stats.get(change.path),
          ...rawMetadata.get(change.path),
        });
      });
      const comparison = await comparisonPromise;
      return {
        basePatchset: base,
        ...(comparison ? { comparison } : {}),
        files,
        isGitRepo: true,
        patchset: head,
        reviewId: options.reviewId || gitRangeReviewId(root, base, head),
        root,
        source: 'git-range',
        truncated: changes.length > limit,
      };
    }

    const files = await mapWithConcurrency(selected, async change => {
      if (change.gitStatus === 'untracked') return this.getGitRangeUntrackedFile(root, change, false);
      try {
        const { stdout } = await this.fileService.execFile(this.fileService.gitPath, [
          '-C',
          root,
          'diff',
          '--find-renames',
          ...gitWhitespaceArgs(ignoreWhitespace),
          ...gitContextArgs(context),
          ...gitRangeRevisionArgs(base, head),
          '--',
          ...gitDiffPathArgs(change),
        ], { cwd: root, timeout: this.fileService.diffTimeoutMs, maxBuffer: this.fileService.diffMaxBuffer });
        const file = fileFromPatch(change, stdout);
        const stat = lineStats?.get(change.path);
        return fileWithStats(file, stat);
      } catch (error) {
        if (error?.code === 'ETIMEDOUT') throw new WorkspaceFileError('git diff timed out', 504);
        throw new WorkspaceFileError(error?.stderr || error?.message || 'git diff failed', 500);
      }
    });

    const comparison = await comparisonPromise;
    return {
      basePatchset: base,
      ...(comparison ? { comparison } : {}),
      files,
      isGitRepo: true,
      patchset: head,
      reviewId: options.reviewId || gitRangeReviewId(root, base, head),
      root,
      source: 'git-range',
      truncated: changes.length > limit,
    };
  }

  async getGitRangeFile(agentId, options = {}) {
    const root = this.resolveWorkspace(agentId, options.root);
    const base = String(options.base || '').trim();
    const head = String(options.head || '').trim();
    const path = typeof options.path === 'string' ? options.path : '';
    const ignoreWhitespace = normalizeIgnoreWhitespace(options.ignoreWhitespace);
    const context = normalizeDiffContext(options.context);
    if (!isSafeGitRevision(base) || !isReviewHead(head)) {
      throw new WorkspaceFileError('base and head revisions are required', 400);
    }
    if (!isSafeReviewPath(path)) throw new WorkspaceFileError('file path is required', 400);
    const changes = await this.getGitRangeChanges(root, base, head);
    const uniqueChanges = assertUniqueReviewPaths(changes);
    const change = uniqueChanges.find(item => item.path === path);
    if (!change) throw new WorkspaceFileError('review file not found', 404);
    if (change.gitStatus === 'untracked') return this.getGitRangeUntrackedFile(root, change, false);
    const stats = ignoreWhitespace !== 'NONE'
      ? await this.getGitRangeNumstat(root, base, head, ignoreWhitespace, [change])
      : null;
    try {
      const { stdout } = await this.fileService.execFile(this.fileService.gitPath, [
        '-C',
        root,
        'diff',
        '--find-renames',
        ...gitWhitespaceArgs(ignoreWhitespace),
        ...gitContextArgs(context),
        ...gitRangeRevisionArgs(base, head),
        '--',
        ...gitDiffPathArgs(change),
      ], { cwd: root, timeout: this.fileService.diffTimeoutMs, maxBuffer: this.fileService.diffMaxBuffer });
      const file = fileFromPatch(change, stdout);
      const stat = stats?.get(change.path);
      return fileWithStats(file, stat);
    } catch (error) {
      if (error?.code === 'ETIMEDOUT') throw new WorkspaceFileError('git diff timed out', 504);
      throw new WorkspaceFileError(error?.stderr || error?.message || 'git diff failed', 500);
    }
  }

  async getGitRangePatch(agentId, options = {}) {
    const root = this.resolveWorkspace(agentId, options.root);
    const base = String(options.base || '').trim();
    const head = String(options.head || '').trim();
    if (!isSafeGitRevision(base) || !isReviewHead(head)) {
      throw new WorkspaceFileError('base and head revisions are required', 400);
    }
    const limit = normalizeReviewLimit(options.limit);
    const ignoreWhitespace = normalizeIgnoreWhitespace(options.ignoreWhitespace);
    const context = normalizeDiffContext(options.context);
    const changes = await this.getGitRangeChanges(root, base, head);

    const selected = assertUniqueReviewPaths(changes.slice(0, limit));
    const patches = await mapWithConcurrency(selected, async change => {
      if (change.gitStatus === 'untracked') {
        const source = await this.fileService.diff(root, change.path);
        return untrackedPatch(change.path, source.modifiedContent);
      }
      try {
        const { stdout } = await this.fileService.execFile(this.fileService.gitPath, [
          '-C',
          root,
          'diff',
          '--find-renames',
          ...gitWhitespaceArgs(ignoreWhitespace),
          ...gitContextArgs(context),
          ...gitRangeRevisionArgs(base, head),
          '--',
          ...gitDiffPathArgs(change),
        ], { cwd: root, timeout: this.fileService.diffTimeoutMs, maxBuffer: this.fileService.diffMaxBuffer });
        return stdout;
      } catch (error) {
        if (error?.code === 'ETIMEDOUT') throw new WorkspaceFileError('git diff timed out', 504);
        throw new WorkspaceFileError(error?.stderr || error?.message || 'git diff failed', 500);
      }
    });
    return {
      patch: patches.filter(Boolean).join('\n'),
      truncated: changes.length > limit,
    };
  }

  async getGitRangeNumstat(root, base, head, ignoreWhitespace = 'NONE', changes = []) {
    try {
      const { stdout } = await this.fileService.execFile(this.fileService.gitPath, [
        '-C',
        root,
        'diff',
        '--numstat',
        '-z',
        '--find-renames',
        ...gitWhitespaceArgs(ignoreWhitespace),
        ...gitRangeRevisionArgs(base, head),
        '--',
        ...gitDiffPathspecArgs(changes),
      ], { cwd: root, timeout: this.fileService.diffTimeoutMs, maxBuffer: this.fileService.diffMaxBuffer });
      return parseNumstat(stdout, changes);
    } catch (error) {
      if (error?.code === 'ETIMEDOUT') throw new WorkspaceFileError('git diff timed out', 504);
      throw new WorkspaceFileError(error?.stderr || error?.message || 'git diff failed', 500);
    }
  }

  async getGitRangeRawMetadata(root, base, head, changes = []) {
    try {
      const { stdout } = await this.fileService.execFile(this.fileService.gitPath, [
        '-C',
        root,
        'diff',
        '--raw',
        '-z',
        '--find-renames',
        ...gitRangeRevisionArgs(base, head),
        '--',
        ...gitDiffPathspecArgs(changes),
      ], { cwd: root, timeout: this.fileService.diffTimeoutMs, maxBuffer: this.fileService.diffMaxBuffer });
      return parseRawDiffMetadata(stdout);
    } catch (error) {
      if (error?.code === 'ETIMEDOUT') throw new WorkspaceFileError('git diff timed out', 504);
      throw new WorkspaceFileError(error?.stderr || error?.message || 'git diff failed', 500);
    }
  }
}

module.exports = {
  ReviewDiffService,
  filterWorkingCopyChangeItems,
  untrackedPatch,
  untrackedHunks,
  fileFromPatch,
  gitRangeReviewId,
  gitDiffPathspecArgs,
  gitWhitespaceArgs,
  gitContextArgs,
  metadataFile,
  normalizeDiffContext,
  normalizeIgnoreWhitespace,
  normalizeReviewLimit,
  normalizeModifiedWithinDays,
  normalizeWorkingCopyScope,
  patchDiffHeader,
  patchMetadata,
  parseNameStatus,
  parseNumstat,
  parseRawDiffMetadata,
  workingCopyPatchset,
  workingCopyReviewId,
};
