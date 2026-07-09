const fs = require('fs');
const os = require('os');
const path = require('path');
const { OBJECT_ID_PATTERN, REVIEW_ID_PATTERN } = require('./review-session-store');
const { filterWorkingCopyChangeItems, normalizeModifiedWithinDays, normalizeWorkingCopyScope } = require('./review-diff-service');

const MAX_CAPTURE_FILES = 2000;

class ReviewSessionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ReviewSessionError';
    this.statusCode = statusCode;
  }
}

function changedPathsFromNameStatus(value) {
  const tokens = String(value || '').split('\0');
  const paths = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    const firstPath = tokens[index++];
    if (firstPath) paths.push(firstPath);
    if (status.startsWith('R') || status.startsWith('C')) {
      const secondPath = tokens[index++];
      if (secondPath) paths.push(secondPath);
    }
  }
  return [...new Set(paths)];
}

function publicRevision(session, revision) {
  const previous = revision.previousTree;
  return {
    base: session.base,
    createdAt: revision.createdAt,
    fixesBase: previous || session.base,
    head: revision.tree,
    number: revision.number,
    reviewId: session.id,
    root: session.root,
    ...(session.scope ? { scope: session.scope } : {}),
    ...(session.modifiedWithinDays ? { modifiedWithinDays: session.modifiedWithinDays } : {}),
  };
}

class ReviewSessionService {
  constructor(fileService, sessionStore, reviewStateStore, options = {}) {
    this.fileService = fileService;
    this.sessionStore = sessionStore;
    this.reviewStateStore = reviewStateStore;
    this.resolveAgentRoot = options.resolveAgentRoot;
  }

  async git(root, args, options = {}) {
    try {
      return await this.fileService.execFile(this.fileService.gitPath, ['-C', root, ...args], {
        cwd: root,
        maxBuffer: this.fileService.diffMaxBuffer,
        timeout: this.fileService.diffTimeoutMs,
        ...options,
      });
    } catch (error) {
      if (error?.code === 'ETIMEDOUT') throw new ReviewSessionError('review capture timed out', 504);
      throw new ReviewSessionError(String(error?.stderr || error?.message || 'git review capture failed').trim(), 400);
    }
  }

  async resolveRoot(requestedRoot, agentId) {
    if (requestedRoot && agentId) throw new ReviewSessionError('only one review workspace target is allowed');
    let candidate = requestedRoot;
    if (!candidate && typeof agentId === 'string' && agentId.trim()) {
      candidate = this.resolveAgentRoot?.(agentId.trim());
      if (!candidate) throw new ReviewSessionError('review agent was not found', 404);
    }
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new ReviewSessionError('review workspace target is required');
    }
    let root;
    try {
      root = fs.realpathSync.native(path.resolve(candidate));
    } catch {
      throw new ReviewSessionError('review root does not exist', 404);
    }
    const { stdout } = await this.git(root, ['rev-parse', '--show-toplevel']);
    try {
      return fs.realpathSync.native(stdout.trim());
    } catch {
      throw new ReviewSessionError('review root is not a git repository');
    }
  }

  async resolveBase(root, base) {
    if (typeof base !== 'string' || !base.trim() || base.trim().startsWith('-')) {
      throw new ReviewSessionError('review base is required');
    }
    const { stdout } = await this.git(root, ['rev-parse', '--verify', `${base.trim()}^{commit}`]);
    const resolved = stdout.trim();
    if (!OBJECT_ID_PATTERN.test(resolved)) throw new ReviewSessionError('review base is invalid');
    return resolved;
  }

  async captureTreeOnce(root, paths) {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-capture-'));
    const temporaryIndex = path.join(temporaryDir, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    try {
      await this.git(root, ['read-tree', 'HEAD'], { env });
      if (paths === undefined) {
        await this.git(root, ['add', '-A', '--', '.'], { env });
      } else if (paths.length > 0) {
        await this.git(root, ['add', '-A', '--', ...paths], { env });
      }
      const { stdout } = await this.git(root, ['write-tree'], { env });
      const tree = stdout.trim();
      if (!OBJECT_ID_PATTERN.test(tree)) throw new ReviewSessionError('git did not produce a review tree', 500);
      return tree;
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  }

  async captureStableTree(root, paths) {
    const first = await this.captureTreeOnce(root, paths);
    const second = await this.captureTreeOnce(root, paths);
    if (first !== second) {
      throw new ReviewSessionError('workspace changed during review capture; try again when agent writes have settled', 409);
    }
    return first;
  }

  async keepRevision(root, reviewId, number, tree) {
    await this.git(root, ['update-ref', `refs/farming/reviews/${reviewId}/${number}`, tree]);
  }

  async changedPaths(root, base, head) {
    const { stdout } = await this.git(root, ['diff', '--name-status', '-z', '--find-renames', base, head]);
    return changedPathsFromNameStatus(stdout);
  }

  async capturePaths(root, options = {}) {
    const scope = normalizeWorkingCopyScope(options.scope);
    if (!scope) return undefined;
    const changes = await this.fileService.changes(root, { limit: MAX_CAPTURE_FILES });
    if (changes.truncated) throw new ReviewSessionError('too many workspace files to capture this review', 413);
    const selected = filterWorkingCopyChangeItems(root, changes.items, {
      scope,
      modifiedWithinDays: options.modifiedWithinDays,
    });
    return [...new Set(selected.flatMap(change => [change.previousPath, change.path]).filter(Boolean))];
  }

  async create({ root: requestedRoot, agentId, base = 'HEAD', scope: requestedScope, modifiedWithinDays: requestedDays }) {
    const root = await this.resolveRoot(requestedRoot, agentId);
    const resolvedBase = await this.resolveBase(root, base);
    const scope = normalizeWorkingCopyScope(requestedScope);
    const modifiedWithinDays = scope === 'untracked' ? normalizeModifiedWithinDays(requestedDays) : undefined;
    const paths = await this.capturePaths(root, { scope, modifiedWithinDays });
    const tree = await this.captureStableTree(root, paths);
    const reviewId = this.sessionStore.newId();
    await this.keepRevision(root, reviewId, 1, tree);
    const session = this.sessionStore.create({ base: resolvedBase, id: reviewId, root, tree, scope, modifiedWithinDays });
    return publicRevision(session, session.revisions[0]);
  }

  async refresh(reviewId) {
    if (!REVIEW_ID_PATTERN.test(reviewId)) throw new ReviewSessionError('review session id is invalid');
    const current = this.sessionStore.get(reviewId);
    if (!current) throw new ReviewSessionError('review session not found', 404);
    const paths = await this.capturePaths(current.root, current);
    const tree = await this.captureStableTree(current.root, paths);
    const previous = current.revisions[current.revisions.length - 1];
    if (previous.tree === tree) return { ...publicRevision(current, previous), changedPaths: [], unchanged: true };
    const nextNumber = previous.number + 1;
    const changedPaths = await this.changedPaths(current.root, previous.tree, tree);
    await this.keepRevision(current.root, reviewId, nextNumber, tree);
    const result = this.sessionStore.appendRevision(reviewId, tree);
    const next = result.session.revisions[result.session.revisions.length - 1];
    this.reviewStateStore?.inheritPatchset?.({
      changedPaths,
      nextPatchset: tree,
      previousPatchset: previous.tree,
      reviewId,
    });
    return { ...publicRevision(result.session, next), changedPaths, unchanged: false };
  }

  get(reviewId) {
    if (!REVIEW_ID_PATTERN.test(reviewId)) throw new ReviewSessionError('review session id is invalid');
    const session = this.sessionStore.get(reviewId);
    if (!session) throw new ReviewSessionError('review session not found', 404);
    const latest = session.revisions[session.revisions.length - 1];
    return {
      ...publicRevision(session, latest),
      revisions: session.revisions.map(revision => publicRevision(session, revision)),
    };
  }

  assertRange(reviewId, requestedRoot, base, head) {
    if (!reviewId) return;
    if (!REVIEW_ID_PATTERN.test(reviewId)) throw new ReviewSessionError('review session id is invalid');
    const session = this.sessionStore.get(reviewId);
    if (!session) throw new ReviewSessionError('review session not found', 404);
    let root;
    try {
      root = fs.realpathSync.native(path.resolve(requestedRoot));
    } catch {
      throw new ReviewSessionError('review root does not exist', 404);
    }
    const revisionTrees = session.revisions.map(revision => revision.tree);
    const validBase = base === session.base || revisionTrees.includes(base);
    if (root !== session.root || !validBase || !revisionTrees.includes(head)) {
      throw new ReviewSessionError('review range does not belong to this session', 409);
    }
  }
}

module.exports = {
  changedPathsFromNameStatus,
  ReviewSessionError,
  ReviewSessionService,
};
