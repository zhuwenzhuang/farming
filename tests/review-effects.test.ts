import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completeReviewFileDiffLoad,
  failReviewFileDiffLoad,
  type ReviewCatalog,
  type ReviewEffect,
  type ReviewFile,
} from '../src/lib/review-model'

const effect: Extract<ReviewEffect, { type: 'load-file-diff' }> = {
  patchset: 'Patchset 2',
  path: 'src/review.ts',
  type: 'load-file-diff',
}

const catalog: ReviewCatalog = {
  'Patchset 2': [
    {
      added: 1,
      diff: { hunks: [] },
      diffLoaded: false,
      kind: 'modified',
      path: 'src/review.ts',
      removed: 1,
    },
  ],
}

test('completes lazy file diff loading by hydrating the catalog and committing pending state', () => {
  const loadedFile: ReviewFile = {
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -1,1 +1,1 @@',
        newLines: 1,
        newStart: 1,
        oldLines: 1,
        oldStart: 1,
        rows: [{ kind: 'changed', left: { line: 1, text: 'old' }, right: { line: 1, text: 'new' } }],
      }],
    },
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
  }

  assert.deepEqual(completeReviewFileDiffLoad(catalog, effect, loadedFile), {
    action: {
      patchset: 'Patchset 2',
      path: 'src/review.ts',
      type: 'commit-file-diff-load',
    },
    catalog: {
      'Patchset 2': [{
        ...loadedFile,
        diffLoaded: true,
      }],
    },
  })
})

test('rejects lazy file diff completion for the wrong path', () => {
  assert.throws(
    () => completeReviewFileDiffLoad(catalog, effect, {
      added: 1,
      diff: { hunks: [] },
      kind: 'modified',
      path: 'src/other.ts',
      removed: 1,
    }),
    /does not match/
  )
})

test('rejects metadata-only rows as lazy file diff completions', () => {
  assert.throws(
    () => completeReviewFileDiffLoad(catalog, effect, {
      added: 1,
      diff: { hunks: [] },
      diffLoaded: false,
      kind: 'modified',
      path: 'src/review.ts',
      removed: 1,
    }),
    /metadata-only/
  )
})

test('accepts truncated loaded-negative rows as lazy file diff completions', () => {
  const loadedFile: ReviewFile = {
    added: 1,
    diff: { hunks: [], truncated: true },
    diffLoaded: false,
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
  }
  assert.deepEqual(completeReviewFileDiffLoad(catalog, effect, loadedFile), {
    action: {
      patchset: 'Patchset 2',
      path: 'src/review.ts',
      type: 'commit-file-diff-load',
    },
    catalog: {
      'Patchset 2': [{
        ...loadedFile,
        diffLoaded: true,
      }],
    },
  })
})

test('rejects stale lazy file diff completion after the catalog changes', () => {
  const loadedFile: ReviewFile = {
    added: 1,
    diff: { hunks: [] },
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
  }

  assert.throws(
    () => completeReviewFileDiffLoad({}, effect, loadedFile),
    /no longer in the review catalog/
  )
  assert.throws(
    () => completeReviewFileDiffLoad({ 'Patchset 2': [] }, effect, loadedFile),
    /no longer in the review catalog/
  )
})

test('rejects lazy file diff completion for a stale review identity', () => {
  const loadedFile: ReviewFile = {
    added: 1,
    diff: { hunks: [] },
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
  }
  const reviewScopedEffect: ReviewFileDiffLoadEffect = {
    ...effect,
    reviewId: 'review-old',
  }

  assert.throws(
    () => completeReviewFileDiffLoad(catalog, reviewScopedEffect, loadedFile),
    /stale review/
  )
  assert.throws(
    () => completeReviewFileDiffLoad(catalog, reviewScopedEffect, loadedFile, { reviewId: 'review-new' }),
    /stale review/
  )
  assert.equal(
    completeReviewFileDiffLoad(catalog, reviewScopedEffect, loadedFile, { reviewId: 'review-old' }).action.reviewId,
    'review-old'
  )
})

test('turns lazy file diff failures into path-scoped state-machine actions', () => {
  assert.deepEqual(failReviewFileDiffLoad(effect, new Error('network failed')), {
    error: 'network failed',
    patchset: 'Patchset 2',
    path: 'src/review.ts',
    type: 'fail-file-diff-load',
  })
  assert.equal(failReviewFileDiffLoad(effect, '').error, 'review file diff request failed')
  assert.deepEqual(failReviewFileDiffLoad({ ...effect, reviewId: 'review-old' }, 'network failed'), {
    error: 'network failed',
    patchset: 'Patchset 2',
    path: 'src/review.ts',
    reviewId: 'review-old',
    type: 'fail-file-diff-load',
  })
})
