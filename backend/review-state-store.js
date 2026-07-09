const fs = require('fs');
const path = require('path');
const storageLayout = require('./storage-layout');

const MAX_KEY_LENGTH = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_COMMENT_ID_LENGTH = 256;
const MAX_COMMENT_BODY_LENGTH = 20000;

function ownValue(object, key) {
  return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryFile, file);
}

function isSafeKey(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_KEY_LENGTH
    && /^[A-Za-z0-9]/.test(value)
    && !/[\\\0\r\n\t]/.test(value);
}

function isSafeRepositoryPath(value) {
  if (value === '/COMMIT_MSG' || value === '/MERGE_LIST') return true;
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  return value.split(/[\\/]/).every(segment => segment && segment !== '.' && segment !== '..');
}

function uniquePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.filter(isSafeRepositoryPath))];
}

function isSafeCommentId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_COMMENT_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function normalizeCommentRange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const range = {
    end_character: value.end_character,
    end_line: value.end_line,
    start_character: value.start_character,
    start_line: value.start_line,
  };
  if (
    !Number.isInteger(range.start_line) || range.start_line < 1
    || !Number.isInteger(range.end_line) || range.end_line < 1
    || !Number.isInteger(range.start_character) || range.start_character < 0
    || !Number.isInteger(range.end_character) || range.end_character < 0
    || (range.start_line > range.end_line)
    || (range.start_line === range.end_line && range.start_character >= range.end_character)
  ) return null;
  return range;
}

function normalizeComment(value, patchset) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  if (
    !isSafeCommentId(value.id)
    || !isSafeRepositoryPath(value.path)
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
  const status = value.status === 'open' || value.status === 'resolved' || value.status === 'outdated'
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

function normalizeComments(value, patchset) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.reduce((comments, item) => {
    const comment = normalizeComment(item, patchset);
    if (!comment || seen.has(comment.id)) return comments;
    seen.add(comment.id);
    comments.push(comment);
    return comments;
  }, []);
}

function normalizePatchsets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([patchset]) => isSafeKey(patchset))
    .map(([patchset, entry]) => {
      const candidate = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      const revision = Number.isInteger(candidate.revision) && candidate.revision >= 0 ? candidate.revision : 0;
      return [patchset, {
        comments: normalizeComments(candidate.comments, patchset),
        reviewedPaths: uniquePaths(candidate.reviewedPaths),
        revision,
      }];
    }));
}

function normalizeReviews(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([reviewId]) => isSafeKey(reviewId))
    .map(([reviewId, entry]) => {
      const candidate = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      return [reviewId, { patchsets: normalizePatchsets(candidate.patchsets) }];
    }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class ReviewStateStore {
  constructor(configDir, options = {}) {
    this.file = options.file || storageLayout.reviewStateFile(configDir);
    this.seedReviews = normalizeReviews(options.seedReviews);
    this.state = null;
  }

  readState() {
    try {
      if (!fs.existsSync(this.file)) return { reviews: {} };
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { reviews: normalizeReviews(parsed && parsed.reviews) };
    } catch (error) {
      console.warn('Failed to read Farming review state:', error && (error.message || error));
      return { reviews: {} };
    }
  }

  ensureState() {
    if (!this.state) this.state = this.readState();
    return this.state;
  }

  initialPatchsetState(reviewId, patchset) {
    const review = ownValue(this.seedReviews, reviewId);
    const patchsets = review && typeof review === 'object' ? review.patchsets : null;
    return ownValue(patchsets, patchset) || { comments: [], reviewedPaths: [], revision: 0 };
  }

  getPatchsetState(reviewId, patchset) {
    if (!isSafeKey(reviewId) || !isSafeKey(patchset)) throw new TypeError('reviewId and patchset are required');
    const state = this.ensureState();
    const review = ownValue(state.reviews, reviewId);
    const patchsets = review && typeof review === 'object' ? review.patchsets : null;
    const stored = ownValue(patchsets, patchset);
    return clone(stored || this.initialPatchsetState(reviewId, patchset));
  }

  setFileReviewedGerrit({ reviewId, patchset, path: filePath, reviewed }) {
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

  getComments(reviewId, patchset) {
    return this.getPatchsetState(reviewId, patchset).comments;
  }

  saveComment({ reviewId, patchset, comment }) {
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

  deleteComment({ reviewId, patchset, commentId }) {
    if (!isSafeKey(reviewId) || !isSafeKey(patchset) || !isSafeCommentId(commentId)) {
      throw new TypeError('invalid review comment request');
    }
    const current = this.getPatchsetState(reviewId, patchset);
    if (!current.comments.some(comment => comment.id === commentId)) return clone(current.comments);
    const next = { ...current, comments: current.comments.filter(comment => comment.id !== commentId) };
    this.writePatchsetState(reviewId, patchset, next);
    return clone(next.comments);
  }

  updateCommentStatus({ reviewId, patchset, commentId, status }) {
    if (!isSafeKey(reviewId) || !isSafeKey(patchset) || !isSafeCommentId(commentId) || (status !== 'open' && status !== 'resolved')) {
      throw new TypeError('invalid review comment status request');
    }
    const current = this.getPatchsetState(reviewId, patchset);
    const existing = current.comments.find(comment => comment.id === commentId);
    if (!existing) throw new TypeError('review comment not found');
    if ((existing.status || 'open') === status) return clone(existing);
    const comment = { ...existing, status };
    const next = {
      ...current,
      comments: current.comments.map(item => item.id === commentId ? comment : item),
    };
    this.writePatchsetState(reviewId, patchset, next);
    return clone(comment);
  }

  inheritPatchset({ reviewId, previousPatchset, nextPatchset, changedPaths }) {
    if (!isSafeKey(reviewId) || !isSafeKey(previousPatchset) || !isSafeKey(nextPatchset) || !Array.isArray(changedPaths)) {
      throw new TypeError('invalid review patchset inheritance');
    }
    const state = this.ensureState();
    const review = ownValue(state.reviews, reviewId);
    const existing = review && ownValue(review.patchsets, nextPatchset);
    if (existing) return clone(existing);
    const previous = this.getPatchsetState(reviewId, previousPatchset);
    const changed = new Set(uniquePaths(changedPaths));
    const next = {
      comments: previous.comments.map(comment => ({
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

  writePatchsetState(reviewId, patchset, patchsetState) {
    const state = this.ensureState();
    const review = ownValue(state.reviews, reviewId) || { patchsets: {} };
    state.reviews[reviewId] = {
      ...review,
      patchsets: { ...review.patchsets, [patchset]: patchsetState },
    };
    atomicWriteJson(this.file, state);
  }
}

module.exports = {
  ReviewStateStore,
  isSafeKey,
  isSafeRepositoryPath,
};
