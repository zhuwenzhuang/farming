const fs = require('fs');
const { atomicWriteJson } = require('./atomic-json-store.cjs');
const storageLayout = require('./storage-layout.cjs');

const MAX_KEY_LENGTH = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_COMMENT_ID_LENGTH = 256;
const MAX_COMMENT_BODY_LENGTH = 20000;

type ReviewCommentSide = 'left' | 'right' | 'unified';
type ReviewCommentStatus = 'open' | 'resolved' | 'outdated';

interface ReviewCommentRange {
  end_character: number;
  end_line: number;
  start_character: number;
  start_line: number;
}

interface ReviewComment {
  body: string;
  id: string;
  line: number;
  patchset: string;
  path: string;
  range?: ReviewCommentRange;
  side: ReviewCommentSide;
  sourcePatchset?: string;
  status?: ReviewCommentStatus;
}

interface ReviewPatchsetState {
  comments: ReviewComment[];
  reviewedPaths: string[];
  revision: number;
}

interface ReviewStateEntry {
  patchsets: Record<string, ReviewPatchsetState>;
}

type ReviewStateMap = Record<string, ReviewStateEntry>;

interface ReviewState {
  reviews: ReviewStateMap;
}

interface ReviewStateStoreOptions {
  file?: string;
  seedReviews?: unknown;
  writeJson?: (file: string, value: unknown) => void;
}

interface ReviewCommentInput {
  body?: unknown;
  id?: unknown;
  line?: unknown;
  patchset?: unknown;
  path?: unknown;
  range?: unknown;
  side?: unknown;
  sourcePatchset?: unknown;
  status?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue<T>(object: Record<string, T> | null | undefined, key: string): T | undefined {
  return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

function isSafeKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_KEY_LENGTH
    && /^[A-Za-z0-9]/.test(value)
    && !/[\\\0\r\n\t]/.test(value);
}

function isSafeRepositoryPath(value: unknown): value is string {
  if (value === '/COMMIT_MSG' || value === '/MERGE_LIST') return true;
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  return value.split(/[\\/]/).every(segment => segment && segment !== '.' && segment !== '..');
}

function uniquePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.filter(isSafeRepositoryPath))];
}

function isSafeCommentId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_COMMENT_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function normalizeCommentRange(value: unknown): ReviewCommentRange | null {
  if (!isObject(value)) return null;
  const range = {
    end_character: value.end_character,
    end_line: value.end_line,
    start_character: value.start_character,
    start_line: value.start_line,
  };
  if (
    typeof range.start_line !== 'number' || !Number.isInteger(range.start_line) || range.start_line < 1
    || typeof range.end_line !== 'number' || !Number.isInteger(range.end_line) || range.end_line < 1
    || typeof range.start_character !== 'number' || !Number.isInteger(range.start_character) || range.start_character < 0
    || typeof range.end_character !== 'number' || !Number.isInteger(range.end_character) || range.end_character < 0
    || (range.start_line > range.end_line)
    || (range.start_line === range.end_line && range.start_character >= range.end_character)
  ) return null;
  return {
    end_character: range.end_character,
    end_line: range.end_line,
    start_character: range.start_character,
    start_line: range.start_line,
  } as ReviewCommentRange;
}

function normalizeComment(value: unknown, patchset: string): ReviewComment | null {
  if (!isObject(value)) return null;
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  if (
    !isSafeCommentId(value.id)
    || !isSafeRepositoryPath(value.path)
    || typeof value.line !== 'number'
    || !Number.isInteger(value.line)
    || value.line < 1
    || value.line > 100000000
    || !body
    || body.length > MAX_COMMENT_BODY_LENGTH
    || (value.side !== 'left' && value.side !== 'right' && value.side !== 'unified')
    || value.patchset !== patchset
  ) return null;
  const range = value.range === undefined ? undefined : normalizeCommentRange(value.range);
  if (value.range !== undefined && !range) return null;
  const status: ReviewCommentStatus | undefined = value.status === 'open'
    || value.status === 'resolved'
    || value.status === 'outdated'
    ? value.status
    : undefined;
  return {
    body,
    id: value.id,
    line: value.line,
    patchset,
    path: value.path,
    ...(range ? { range } : {}),
    side: value.side,
    ...(status ? { status } : {}),
    ...(isSafeKey(value.sourcePatchset) ? { sourcePatchset: value.sourcePatchset } : {}),
  };
}

function normalizeComments(value: unknown, patchset: string): ReviewComment[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.reduce<ReviewComment[]>((comments, item) => {
    const comment = normalizeComment(item, patchset);
    if (!comment || seen.has(comment.id)) return comments;
    seen.add(comment.id);
    comments.push(comment);
    return comments;
  }, []);
}

function normalizePatchsets(value: unknown): Record<string, ReviewPatchsetState> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([patchset]) => isSafeKey(patchset))
    .map(([patchset, entry]) => {
      const candidate = isObject(entry) ? entry : {};
      const revision = typeof candidate.revision === 'number'
        && Number.isInteger(candidate.revision)
        && candidate.revision >= 0
        ? candidate.revision
        : 0;
      return [patchset, {
        comments: normalizeComments(candidate.comments, patchset),
        reviewedPaths: uniquePaths(candidate.reviewedPaths),
        revision,
      }];
    }));
}

function normalizeReviews(value: unknown): ReviewStateMap {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([reviewId]) => isSafeKey(reviewId))
    .map(([reviewId, entry]) => {
      const candidate = isObject(entry) ? entry : {};
      return [reviewId, { patchsets: normalizePatchsets(candidate.patchsets) }];
    }));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class ReviewStateStore {
  file: string;
  seedReviews: ReviewStateMap;
  writeJson: (file: string, value: unknown) => void;
  state: ReviewState | null;

  constructor(configDir: string, options: ReviewStateStoreOptions = {}) {
    this.file = options.file || storageLayout.reviewStateFile(configDir);
    this.seedReviews = normalizeReviews(options.seedReviews);
    this.writeJson = typeof options.writeJson === 'function'
      ? options.writeJson
      : (file, value) => atomicWriteJson(file, value, { trailingNewline: true });
    this.state = null;
  }

  readState(): ReviewState {
    try {
      if (!fs.existsSync(this.file)) return { reviews: {} };
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { reviews: normalizeReviews(isObject(parsed) ? parsed.reviews : undefined) };
    } catch (error: unknown) {
      console.warn(
        'Failed to read Farming review state:',
        error instanceof Error ? error.message : error,
      );
      return { reviews: {} };
    }
  }

  ensureState(): ReviewState {
    if (!this.state) this.state = this.readState();
    return this.state;
  }

  initialPatchsetState(reviewId: string, patchset: string): ReviewPatchsetState {
    const review = ownValue(this.seedReviews, reviewId);
    const patchsets = review?.patchsets;
    return ownValue(patchsets, patchset) || { comments: [], reviewedPaths: [], revision: 0 };
  }

  getPatchsetState(reviewId: string, patchset: string): ReviewPatchsetState {
    if (!isSafeKey(reviewId) || !isSafeKey(patchset)) throw new TypeError('reviewId and patchset are required');
    const state = this.ensureState();
    const review = ownValue(state.reviews, reviewId);
    const patchsets = review?.patchsets;
    const stored = ownValue(patchsets, patchset);
    return clone(stored || this.initialPatchsetState(reviewId, patchset));
  }

  setFileReviewedGerrit({
    reviewId,
    patchset,
    path: filePath,
    reviewed,
  }: {
    reviewId: string;
    patchset: string;
    path: string;
    reviewed: boolean;
  }): { changed: boolean; state: ReviewPatchsetState } {
    if (!isSafeKey(reviewId) || !isSafeKey(patchset) || !isSafeRepositoryPath(filePath) || typeof reviewed !== 'boolean') {
      throw new TypeError('invalid review status request');
    }

    const current = this.getPatchsetState(reviewId, patchset);
    const reviewedPaths = new Set(current.reviewedPaths);
    const alreadyReviewed = reviewedPaths.has(filePath);
    if (alreadyReviewed === reviewed) return { changed: false, state: current };
    if (reviewed) reviewedPaths.add(filePath);
    else reviewedPaths.delete(filePath);

    const next = {
      comments: current.comments,
      reviewedPaths: [...reviewedPaths],
      revision: current.revision + 1,
    };
    this.writePatchsetState(reviewId, patchset, next);
    return { changed: true, state: clone(next) };
  }

  getComments(reviewId: string, patchset: string): ReviewComment[] {
    return this.getPatchsetState(reviewId, patchset).comments;
  }

  saveComment({
    reviewId,
    patchset,
    comment,
  }: {
    reviewId: string;
    patchset: string;
    comment: ReviewCommentInput;
  }): ReviewComment {
    if (!isSafeKey(reviewId) || !isSafeKey(patchset)) throw new TypeError('reviewId and patchset are required');
    const normalizedComment = normalizeComment(comment, patchset);
    if (!normalizedComment) throw new TypeError('invalid review comment');

    const current = this.getPatchsetState(reviewId, patchset);
    const existing = current.comments.find(item => item.id === normalizedComment.id);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(normalizedComment)) return clone(existing);
      throw new TypeError('review comment id already exists');
    }
    const next = { ...current, comments: [...current.comments, normalizedComment] };
    this.writePatchsetState(reviewId, patchset, next);
    return clone(normalizedComment);
  }

  deleteComment({
    reviewId,
    patchset,
    commentId,
  }: {
    reviewId: string;
    patchset: string;
    commentId: string;
  }): ReviewComment[] {
    if (!isSafeKey(reviewId) || !isSafeKey(patchset) || !isSafeCommentId(commentId)) {
      throw new TypeError('invalid review comment request');
    }
    const current = this.getPatchsetState(reviewId, patchset);
    if (!current.comments.some(comment => comment.id === commentId)) return clone(current.comments);
    const next = { ...current, comments: current.comments.filter(comment => comment.id !== commentId) };
    this.writePatchsetState(reviewId, patchset, next);
    return clone(next.comments);
  }

  updateCommentStatus({
    reviewId,
    patchset,
    commentId,
    status,
  }: {
    reviewId: string;
    patchset: string;
    commentId: string;
    status: unknown;
  }): ReviewComment {
    if (!isSafeKey(reviewId) || !isSafeKey(patchset) || !isSafeCommentId(commentId) || (status !== 'open' && status !== 'resolved')) {
      throw new TypeError('invalid review comment status request');
    }
    const current = this.getPatchsetState(reviewId, patchset);
    const existing = current.comments.find(comment => comment.id === commentId);
    if (!existing) throw new TypeError('review comment not found');
    if ((existing.status || 'open') === status) return clone(existing);
    const comment: ReviewComment = { ...existing, status };
    const next: ReviewPatchsetState = {
      ...current,
      comments: current.comments.map(item => item.id === commentId ? comment : item),
    };
    this.writePatchsetState(reviewId, patchset, next);
    return clone(comment);
  }

  inheritPatchset({
    reviewId,
    previousPatchset,
    nextPatchset,
    changedPaths,
  }: {
    reviewId: string;
    previousPatchset: string;
    nextPatchset: string;
    changedPaths: unknown;
  }): ReviewPatchsetState {
    if (!isSafeKey(reviewId) || !isSafeKey(previousPatchset) || !isSafeKey(nextPatchset) || !Array.isArray(changedPaths)) {
      throw new TypeError('invalid review patchset inheritance');
    }
    const state = this.ensureState();
    const review = ownValue(state.reviews, reviewId);
    const existing = review && ownValue(review.patchsets, nextPatchset);
    if (existing) return clone(existing);
    const previous = this.getPatchsetState(reviewId, previousPatchset);
    const changed = new Set(uniquePaths(changedPaths));
    const next: ReviewPatchsetState = {
      comments: previous.comments.map((comment): ReviewComment => ({
        ...comment,
        patchset: nextPatchset,
        ...(changed.has(comment.path)
          ? { sourcePatchset: previousPatchset, status: 'outdated' }
          : { status: comment.status || 'open' }),
      })),
      reviewedPaths: previous.reviewedPaths.filter(filePath => !changed.has(filePath)),
      revision: 0,
    };
    this.writePatchsetState(reviewId, nextPatchset, next);
    return clone(next);
  }

  writePatchsetState(
    reviewId: string,
    patchset: string,
    patchsetState: ReviewPatchsetState,
  ): void {
    const currentState = this.ensureState();
    const review = ownValue(currentState.reviews, reviewId) || { patchsets: {} };
    const nextState = {
      reviews: { ...currentState.reviews, [reviewId]: {
        ...review,
        patchsets: { ...review.patchsets, [patchset]: patchsetState },
      } },
    };
    this.writeJson(this.file, nextState);
    this.state = nextState;
  }
}

export {
  ReviewStateStore,
  isSafeKey,
  isSafeRepositoryPath,
};
