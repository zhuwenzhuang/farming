const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTwoFilesPatch, diffLines } = require('diff') as {
  createTwoFilesPatch(
    oldFileName: string,
    newFileName: string,
    oldText: string,
    newText: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number },
  ): string;
  diffLines(oldText: string, newText: string): Array<{
    added?: boolean;
    count?: number;
    removed?: boolean;
  }>;
};
const { OBJECT_ID_PATTERN, REVIEW_ID_PATTERN } = require('./review-session-store.cjs') as {
  OBJECT_ID_PATTERN: RegExp;
  REVIEW_ID_PATTERN: RegExp;
};
const {
  filterWorkingCopyChangeItems,
  normalizeModifiedWithinDays,
  normalizeWorkingCopyScope,
} = require('./review-diff-service') as {
  filterWorkingCopyChangeItems(
    root: string,
    items: WorkingCopyChange[],
    options: { modifiedWithinDays?: unknown; scope: ReviewScope },
  ): WorkingCopyChange[];
  normalizeModifiedWithinDays(value: unknown): number | undefined;
  normalizeWorkingCopyScope(value: unknown): ReviewScope | undefined;
};

const MAX_CAPTURE_FILES = 2000;
const MAX_CAPTURE_PATHS = 256;
const MAX_HISTORICAL_REVIEW_CHARS = 32 * 1024 * 1024;
const MAX_HISTORICAL_PREVIEW_CHARS = 64 * 1024;

type ReviewScope = 'tracked' | 'untracked';
type HistoricalSide = 'base' | 'head';

interface WorkingCopyChange {
  path: string;
  previousPath?: string;
  [key: string]: unknown;
}

interface HistoricalReviewChange {
  basePresent: boolean;
  displayPath?: string;
  headPresent: boolean;
  newText: string;
  oldText: string;
  path: string;
}

interface ReviewRevision {
  createdAt: string;
  number: number;
  previousTree?: string;
  tree: string;
}

interface ReviewSession {
  base: string;
  id: string;
  modifiedWithinDays?: number;
  paths?: string[];
  revisions: ReviewRevision[];
  root: string;
  scope?: ReviewScope;
}

interface ReviewSessionStore {
  appendRevision(reviewId: string, tree: string): { session: ReviewSession };
  create(input: {
    base: string;
    id: string;
    modifiedWithinDays?: number;
    paths?: string[];
    root: string;
    scope?: ReviewScope;
    tree: string;
  }): ReviewSession;
  get(reviewId: string): ReviewSession | null;
  newId(): string;
}

interface ReviewStateStore {
  inheritPatchset?(input: {
    changedPaths: string[];
    nextPatchset: string;
    previousPatchset: string;
    reviewId: string;
  }): unknown;
}

interface GitResult {
  stderr?: string;
  stdout: string;
}

interface ReviewFileService {
  changes(root: string, options: { limit: number }): Promise<{
    items: WorkingCopyChange[];
    truncated: boolean;
  }>;
  diffMaxBuffer: number;
  diffTimeoutMs: number;
  execFile(
    executable: string,
    args: string[],
    options: Record<string, unknown>,
  ): Promise<GitResult>;
  gitPath: string;
}

interface ReviewSessionServiceOptions {
  resolveAcpReviewChanges?: (agentId: unknown, itemIds: unknown) => unknown | Promise<unknown>;
  resolveAgentRoot?: (agentId: string) => unknown;
}

interface CapturePathOptions {
  modifiedWithinDays?: unknown;
  paths?: unknown;
  scope?: unknown;
}

interface CreateReviewInput extends CapturePathOptions {
  agentId?: unknown;
  base?: unknown;
  root?: unknown;
}

interface AcpReviewInput {
  agentId?: unknown;
  itemIds?: unknown;
}

interface PublicRevision {
  base: string;
  createdAt: string;
  fixesBase: string;
  head: string;
  modifiedWithinDays?: number;
  number: number;
  paths?: string[];
  reviewId: string;
  root: string;
  scope?: ReviewScope;
}

class ReviewSessionError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ReviewSessionError';
    this.statusCode = statusCode;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorField(error: unknown, field: string): unknown {
  return isObject(error) ? error[field] : undefined;
}

function changedPathsFromNameStatus(value: unknown): string[] {
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

function normalizeCapturePaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CAPTURE_PATHS) {
    throw new ReviewSessionError('review file paths are invalid');
  }
  if (value.some(candidate => typeof candidate !== 'string')) {
    throw new ReviewSessionError('review file paths are invalid');
  }
  const paths = value
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map(candidate => candidate.replace(/\\/g, '/').trim());
  if (paths.some(candidate => (
    !candidate
    || candidate.length > 4096
    || candidate.startsWith('/')
    || candidate.includes('\0')
    || candidate.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ))) {
    throw new ReviewSessionError('review file paths are invalid');
  }
  return [...new Set(paths)];
}

function historicalSidePresence(kind: unknown): { base: boolean; head: boolean } {
  const normalized = String(kind || '').trim().toLowerCase();
  return {
    base: !['add', 'added', 'create', 'created'].includes(normalized),
    head: !['delete', 'deleted', 'remove', 'removed'].includes(normalized),
  };
}

function workspaceRelativeReviewPath(root: string, candidate: unknown): string {
  if (typeof candidate !== 'string' || !candidate.trim()) return '';
  const raw = candidate.trim();
  const normalized = raw.replace(/\\/g, '/');
  let workspaceRoot = root;
  try {
    workspaceRoot = fs.realpathSync.native(root);
  } catch {
    // resolveRoot normally supplies an existing canonical workspace.
  }
  let absolute = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(workspaceRoot, normalized);
  const missingSegments = [];
  let existing = absolute;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    missingSegments.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try {
    absolute = path.join(fs.realpathSync.native(existing), ...missingSegments);
  } catch {
    // The normalized path below will reject anything outside the workspace.
  }
  const relative = path.relative(workspaceRoot, absolute).replace(/\\/g, '/');
  if (relative.split('/').includes('.git')) return '';
  try {
    return normalizeCapturePaths([relative])?.[0] || '';
  } catch {
    return '';
  }
}

function normalizeHistoricalReviewChanges(
  root: string,
  value: unknown,
  workspaceRoot = root,
): HistoricalReviewChange[] {
  if (!Array.isArray(value)) throw new ReviewSessionError('ACP review changes are invalid');
  const changesByPath = new Map<string, HistoricalReviewChange>();
  let totalChars = 0;
  for (const rawChange of value) {
    if (!isObject(rawChange)) continue;
    const displayPath = workspaceRelativeReviewPath(workspaceRoot, rawChange.path);
    if (!displayPath) continue;
    const absolutePath = path.resolve(workspaceRoot, displayPath);
    const reviewPath = workspaceRelativeReviewPath(root, absolutePath);
    if (!reviewPath) continue;
    const oldText = rawChange.oldText == null ? '' : String(rawChange.oldText);
    const newText = rawChange.newText == null ? '' : String(rawChange.newText);
    totalChars += Buffer.byteLength(oldText, 'utf8') + Buffer.byteLength(newText, 'utf8');
    if (totalChars > MAX_HISTORICAL_REVIEW_CHARS) {
      throw new ReviewSessionError('ACP review content is too large', 413);
    }
    const presence = historicalSidePresence(rawChange.kind);
    const current = changesByPath.get(reviewPath);
    if (!current) {
      changesByPath.set(reviewPath, {
        basePresent: presence.base,
        headPresent: presence.head,
        newText,
        oldText,
        path: reviewPath,
        ...(displayPath !== reviewPath ? { displayPath } : {}),
      });
      continue;
    }
    current.headPresent = presence.head;
    current.newText = newText;
  }
  const changes = [...changesByPath.values()];
  if (changes.length === 0) throw new ReviewSessionError('ACP review has no files inside this workspace');
  if (changes.length > MAX_CAPTURE_PATHS) throw new ReviewSessionError('ACP review has too many files', 413);
  return changes;
}

function historicalPreviewChange(change: HistoricalReviewChange): {
  added: number;
  diff: string;
  kind: 'added' | 'deleted' | 'updated';
  path: string;
  removed: number;
} {
  const oldText = change.basePresent ? change.oldText : '';
  const newText = change.headPresent ? change.newText : '';
  const stats = diffLines(oldText, newText).reduce((result, part) => {
    const count = Number(part.count || 0);
    if (part.added) result.added += count;
    if (part.removed) result.removed += count;
    return result;
  }, { added: 0, removed: 0 });
  const patch = createTwoFilesPatch(change.path, change.path, oldText, newText, 'before', 'after', { context: 3 });
  return {
    ...stats,
    diff: patch.length <= MAX_HISTORICAL_PREVIEW_CHARS
      ? patch
      : `${patch.slice(0, MAX_HISTORICAL_PREVIEW_CHARS)}\n\n[Diff detail truncated]`,
    kind: !change.basePresent ? 'added' : !change.headPresent ? 'deleted' : 'updated',
    path: change.displayPath || change.path,
  };
}

function publicRevision(session: ReviewSession, revision: ReviewRevision): PublicRevision {
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
    ...(session.paths ? { paths: session.paths } : {}),
  };
}

class ReviewSessionService {
  fileService: ReviewFileService;
  sessionStore: ReviewSessionStore;
  reviewStateStore?: ReviewStateStore;
  resolveAgentRoot?: (agentId: string) => unknown;
  resolveAcpReviewChanges?: (agentId: unknown, itemIds: unknown) => unknown | Promise<unknown>;
  refreshQueues: Map<string, Promise<unknown>>;

  constructor(
    fileService: ReviewFileService,
    sessionStore: ReviewSessionStore,
    reviewStateStore?: ReviewStateStore,
    options: ReviewSessionServiceOptions = {},
  ) {
    this.fileService = fileService;
    this.sessionStore = sessionStore;
    this.reviewStateStore = reviewStateStore;
    this.resolveAgentRoot = options.resolveAgentRoot;
    this.resolveAcpReviewChanges = options.resolveAcpReviewChanges;
    this.refreshQueues = new Map();
  }

  enqueueRefresh<T>(reviewId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.refreshQueues.get(reviewId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.refreshQueues.set(reviewId, next);
    const cleanup = () => {
      if (this.refreshQueues.get(reviewId) === next) this.refreshQueues.delete(reviewId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async git(
    root: string,
    args: string[],
    options: Record<string, unknown> = {},
  ): Promise<GitResult> {
    try {
      return await this.fileService.execFile(this.fileService.gitPath, ['-C', root, ...args], {
        cwd: root,
        maxBuffer: this.fileService.diffMaxBuffer,
        timeout: this.fileService.diffTimeoutMs,
        ...options,
      });
    } catch (error: unknown) {
      if (errorField(error, 'code') === 'ETIMEDOUT') throw new ReviewSessionError('review capture timed out', 504);
      throw new ReviewSessionError(String(
        errorField(error, 'stderr')
        || errorField(error, 'message')
        || 'git review capture failed',
      ).trim(), 400);
    }
  }

  async resolveRoot(requestedRoot: unknown, agentId: unknown): Promise<string> {
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

  async resolveBase(root: string, base: unknown): Promise<string> {
    if (typeof base !== 'string' || !base.trim() || base.trim().startsWith('-')) {
      throw new ReviewSessionError('review base is required');
    }
    const { stdout } = await this.git(root, ['rev-parse', '--verify', `${base.trim()}^{commit}`]);
    const resolved = stdout.trim();
    if (!OBJECT_ID_PATTERN.test(resolved)) throw new ReviewSessionError('review base is invalid');
    return resolved;
  }

  async captureTreeOnce(root: string, paths?: string[]): Promise<string> {
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

  async captureStableTree(root: string, paths?: string[]): Promise<string> {
    const first = await this.captureTreeOnce(root, paths);
    const second = await this.captureTreeOnce(root, paths);
    if (first !== second) {
      throw new ReviewSessionError('workspace changed during review capture; try again when agent writes have settled', 409);
    }
    return first;
  }

  async writeHistoricalTree(
    root: string,
    changes: HistoricalReviewChange[],
    side: HistoricalSide,
    temporaryDir: string,
  ): Promise<string> {
    const temporaryIndex = path.join(temporaryDir, `${side}.index`);
    const contentFile = path.join(temporaryDir, `${side}.content`);
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    await this.git(root, ['read-tree', '--empty'], { env });
    for (const change of changes) {
      const present = side === 'base' ? change.basePresent : change.headPresent;
      if (!present) continue;
      fs.writeFileSync(contentFile, side === 'base' ? change.oldText : change.newText, 'utf8');
      const { stdout: blobOutput } = await this.git(root, ['hash-object', '-w', contentFile]);
      const blob = blobOutput.trim();
      if (!OBJECT_ID_PATTERN.test(blob)) throw new ReviewSessionError('git did not produce a review blob', 500);
      await this.git(root, ['update-index', '--add', '--cacheinfo', '100644', blob, change.path], { env });
    }
    const { stdout } = await this.git(root, ['write-tree'], { env });
    const tree = stdout.trim();
    if (!OBJECT_ID_PATTERN.test(tree)) throw new ReviewSessionError('git did not produce a review tree', 500);
    return tree;
  }

  async captureHistoricalTrees(
    root: string,
    changes: HistoricalReviewChange[],
  ): Promise<{ base: string; head: string }> {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-history-'));
    try {
      const base = await this.writeHistoricalTree(root, changes, 'base', temporaryDir);
      const head = await this.writeHistoricalTree(root, changes, 'head', temporaryDir);
      return { base, head };
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  }

  async keepRevision(root: string, reviewId: string, number: number, tree: string): Promise<void> {
    await this.git(root, ['update-ref', `refs/farming/reviews/${reviewId}/${number}`, tree]);
  }

  async changedPaths(root: string, base: string, head: string): Promise<string[]> {
    const { stdout } = await this.git(root, ['diff', '--name-status', '-z', '--find-renames', base, head]);
    return changedPathsFromNameStatus(stdout);
  }

  async capturePaths(
    root: string,
    options: CapturePathOptions = {},
  ): Promise<string[] | undefined> {
    const requestedPaths = normalizeCapturePaths(options.paths);
    if (requestedPaths !== undefined) return requestedPaths;
    const scope = normalizeWorkingCopyScope(options.scope);
    if (!scope) return undefined;
    const changes = await this.fileService.changes(root, { limit: MAX_CAPTURE_FILES });
    if (changes.truncated) throw new ReviewSessionError('too many workspace files to capture this review', 413);
    const selected = filterWorkingCopyChangeItems(root, changes.items, {
      scope,
      modifiedWithinDays: options.modifiedWithinDays,
    });
    return [...new Set(selected
      .flatMap(change => [change.previousPath, change.path])
      .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0))];
  }

  async create({
    root: requestedRoot,
    agentId,
    base = 'HEAD',
    scope: requestedScope,
    modifiedWithinDays: requestedDays,
    paths: requestedPaths,
  }: CreateReviewInput): Promise<PublicRevision> {
    const root = await this.resolveRoot(requestedRoot, agentId);
    const resolvedBase = await this.resolveBase(root, base);
    const scope = normalizeWorkingCopyScope(requestedScope);
    const explicitPaths = normalizeCapturePaths(requestedPaths);
    if (scope && explicitPaths !== undefined) throw new ReviewSessionError('review scope and file paths cannot be combined');
    const modifiedWithinDays = scope === 'untracked' ? normalizeModifiedWithinDays(requestedDays) : undefined;
    const paths = await this.capturePaths(root, { scope, modifiedWithinDays, paths: explicitPaths });
    const tree = await this.captureStableTree(root, paths);
    const reviewId = this.sessionStore.newId();
    await this.keepRevision(root, reviewId, 1, tree);
    const session = this.sessionStore.create({ base: resolvedBase, id: reviewId, root, tree, scope, modifiedWithinDays, paths: explicitPaths });
    return publicRevision(session, session.revisions[0]);
  }

  async createFromAcp({ agentId, itemIds }: AcpReviewInput): Promise<PublicRevision> {
    if (typeof this.resolveAcpReviewChanges !== 'function') {
      throw new ReviewSessionError('ACP review capture is unavailable', 501);
    }
    const { changes, root } = await this.resolveAcpChanges(agentId, itemIds);
    const { base, head } = await this.captureHistoricalTrees(root, changes);
    if (base === head) throw new ReviewSessionError('ACP review contains no effective file changes');
    const reviewId = this.sessionStore.newId();
    await this.git(root, ['update-ref', `refs/farming/reviews/${reviewId}/base`, base]);
    await this.keepRevision(root, reviewId, 1, head);
    const paths = changes.map(change => change.path);
    const session = this.sessionStore.create({ base, id: reviewId, root, tree: head, paths });
    return publicRevision(session, session.revisions[0]);
  }

  async resolveAcpChanges(
    agentId: unknown,
    itemIds: unknown,
  ): Promise<{ changes: HistoricalReviewChange[]; root: string }> {
    const requestedWorkspace = typeof agentId === 'string' && agentId.trim()
      ? this.resolveAgentRoot?.(agentId.trim())
      : '';
    let workspaceRoot;
    try {
      workspaceRoot = requestedWorkspace ? fs.realpathSync.native(path.resolve(requestedWorkspace)) : '';
    } catch {
      throw new ReviewSessionError('review agent workspace does not exist', 404);
    }
    const root = await this.resolveRoot(undefined, agentId);
    let rawChanges;
    try {
      const resolveAcpReviewChanges = this.resolveAcpReviewChanges;
      if (!resolveAcpReviewChanges) throw new ReviewSessionError('ACP review capture is unavailable', 501);
      rawChanges = await resolveAcpReviewChanges(agentId, itemIds);
    } catch (error: unknown) {
      const message = String(errorField(error, 'message') || 'ACP review changes could not be loaded');
      const status = message === 'Agent not found' || message === 'ACP tool call not found'
        ? 404
        : message.includes('invalid') ? 400 : 409;
      throw new ReviewSessionError(message, status);
    }
    const changes = normalizeHistoricalReviewChanges(root, rawChanges, workspaceRoot || root);
    return { changes, root };
  }

  async previewFromAcp({ agentId, itemIds }: AcpReviewInput): Promise<{
    changes: ReturnType<typeof historicalPreviewChange>[];
  }> {
    const { changes } = await this.resolveAcpChanges(agentId, itemIds);
    return { changes: changes.map(historicalPreviewChange) };
  }

  async refresh(reviewId: unknown): Promise<PublicRevision & {
    changedPaths: string[];
    unchanged: boolean;
  }> {
    if (typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId)) {
      throw new ReviewSessionError('review session id is invalid');
    }
    return this.enqueueRefresh(reviewId, async () => {
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
    });
  }

  get(reviewId: unknown): PublicRevision & { revisions: PublicRevision[] } {
    if (typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId)) {
      throw new ReviewSessionError('review session id is invalid');
    }
    const session = this.sessionStore.get(reviewId);
    if (!session) throw new ReviewSessionError('review session not found', 404);
    const latest = session.revisions[session.revisions.length - 1];
    return {
      ...publicRevision(session, latest),
      revisions: session.revisions.map(revision => publicRevision(session, revision)),
    };
  }

  assertRange(reviewId: unknown, requestedRoot: unknown, base: unknown, head: unknown): void {
    if (!reviewId) return;
    if (typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId)) {
      throw new ReviewSessionError('review session id is invalid');
    }
    const session = this.sessionStore.get(reviewId);
    if (!session) throw new ReviewSessionError('review session not found', 404);
    let root;
    try {
      if (typeof requestedRoot !== 'string') throw new TypeError('invalid root');
      root = fs.realpathSync.native(path.resolve(requestedRoot));
    } catch {
      throw new ReviewSessionError('review root does not exist', 404);
    }
    const revisionTrees = session.revisions.map(revision => revision.tree);
    const validBase = typeof base === 'string'
      && (base === session.base || revisionTrees.includes(base));
    if (
      root !== session.root
      || !validBase
      || typeof head !== 'string'
      || !revisionTrees.includes(head)
    ) {
      throw new ReviewSessionError('review range does not belong to this session', 409);
    }
  }
}

export {
  changedPathsFromNameStatus,
  normalizeHistoricalReviewChanges,
  normalizeCapturePaths,
  ReviewSessionError,
  ReviewSessionService,
};
