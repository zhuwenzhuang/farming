import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commentsForFile,
  commentsForFilePaths,
  createReviewState,
  isFileReviewed,
  isReviewFileDiffLoading,
  normalizeReviewDiffMode,
  normalizeReviewPreferences,
  reconcileReviewStateWithCatalog,
  reviewCommentPathForSide,
  reviewCommentSideForUnifiedCell,
  reviewFileDiffLoadError,
  reviewFileState,
  reviewPatchsetSummary,
  reviewStateForPatchset,
  transitionReviewState,
  type ReviewCatalog,
  type ReviewFile,
} from '../src/lib/review/state'

function file(input: Omit<ReviewFile, 'diff'>): ReviewFile {
  return { ...input, diff: { hunks: [] } }
}

const catalog: ReviewCatalog = {
  'Patchset 19': [
    file({ added: 1, kind: 'modified', path: 'clis/dataflow.py', removed: 4 }),
    file({ added: 2, kind: 'modified', path: 'clis/diagnose.py', removed: 1 }),
  ],
  'Patchset 20': [
    file({ added: 3, kind: 'modified', path: 'clis/dataflow.py', removed: 5 }),
    file({ added: 4, kind: 'modified', path: 'clis/diagnose.py', removed: 2 }),
    file({ added: 1, kind: 'added', path: 'docs/review.md', removed: 0 }),
  ],
}

function initialState(autoMarkReviewed = false) {
  return createReviewState({
    catalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: {
      autoMarkReviewed,
      context: 10,
      fitToScreen: true,
      fontSize: 12,
      ignoreWhitespace: 'NONE',
      intralineDifference: true,
      lineLength: 120,
      showTabs: true,
      showTrailingWhitespace: true,
      syntaxHighlighting: true,
      tabSize: 8,
    },
    reviewedPathsByPatchset: {
      'Patchset 19': ['clis/dataflow.py'],
      'Patchset 20': ['docs/review.md'],
    },
  })
}

test('state creation preserves Gerrit FileInfo-map semantics per patchset', () => {
  assert.throws(
    () => createReviewState({
      catalog: {
        'Patchset 20': [
          file({ added: 1, kind: 'modified', path: 'src/review.ts', removed: 0 }),
          file({ added: 2, kind: 'modified', path: 'src/review.ts', removed: 1 }),
        ],
      },
      patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
      preferences: initialState().preferences,
    }),
    /duplicate review file path in Patchset 20: src\/review\.ts/
  )

  assert.throws(
    () => createReviewState({
      catalog: {
        'Patchset 20': [
          file({ added: 1, kind: 'modified', path: 'src/review.ts', removed: 0 }),
        ],
      },
      patchRange: { basePatchset: 'Base', patchset: 'Patchset 21' },
      preferences: initialState().preferences,
    }),
    /review patchset is not present in catalog: Patchset 21/
  )

  const state = createReviewState({
    catalog: {
      'Patchset 19': [file({ added: 1, kind: 'modified', path: 'src/review.ts', removed: 1 })],
      'Patchset 20': [file({ added: 2, kind: 'modified', path: 'src/review.ts', removed: 2 })],
    },
    patchRange: { basePatchset: 'Patchset 19', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
  })
  assert.deepEqual(Object.keys(state.patchsets), ['Patchset 19', 'Patchset 20'])
})

test('reviewed state is scoped to the right-side patchset and writes only meaningful changes', () => {
  const state = initialState()
  assert.equal(isFileReviewed(state, 'clis/dataflow.py'), false)
  assert.equal(isFileReviewed(state, 'clis/dataflow.py', 'Patchset 19'), true)

  const reviewed = transitionReviewState(state, {
    path: 'clis/dataflow.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog)
  assert.equal(isFileReviewed(reviewed.state, 'clis/dataflow.py'), true)
  assert.deepEqual(reviewed.effects, [{
    changes: [{ path: 'clis/dataflow.py', reviewed: true }],
    patchset: 'Patchset 20',
    revision: 0,
    type: 'save-reviewed-status',
  }])

  const repeated = transitionReviewState(reviewed.state, {
    path: 'clis/dataflow.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog)
  assert.strictEqual(repeated.state, reviewed.state)
  assert.deepEqual(repeated.effects, [])
})

test('single-file expansion marks the opened file reviewed', () => {
  const manual = transitionReviewState(initialState(false), {
    path: 'clis/dataflow.py',
    type: 'toggle-file-expanded',
  }, catalog)
  assert.equal(isFileReviewed(manual.state, 'clis/dataflow.py'), true)
  assert.deepEqual(manual.effects, [{
    changes: [{ path: 'clis/dataflow.py', reviewed: true }],
    patchset: 'Patchset 20',
    revision: 0,
    type: 'save-reviewed-status',
  }])

  const automatic = transitionReviewState(initialState(true), {
    path: 'clis/dataflow.py',
    type: 'toggle-file-expanded',
  }, catalog)
  assert.equal(isFileReviewed(automatic.state, 'clis/dataflow.py'), true)
  assert.deepEqual(automatic.effects, [{
    changes: [{ path: 'clis/dataflow.py', reviewed: true }],
    patchset: 'Patchset 20',
    revision: 0,
    type: 'save-reviewed-status',
  }])

  const expandAll = transitionReviewState(initialState(true), {
    expanded: true,
    paths: catalog['Patchset 20'].map(file => file.path),
    type: 'set-all-files-expanded',
  }, catalog)
  assert.equal(isFileReviewed(expandAll.state, 'clis/dataflow.py'), false)
  assert.deepEqual(expandAll.effects, [])
})

test('file expansion requests lazy diff loading for file-list-only entries', () => {
  const lazyCatalog: ReviewCatalog = {
    'Patchset 20': [
      file({ added: 1, diffLoaded: false, kind: 'modified', path: 'src/lazy.ts', removed: 1 }),
      file({ added: 1, diffLoaded: true, kind: 'modified', path: 'src/loaded.ts', removed: 1 }),
      file({ added: 0, binary: true, diffLoaded: false, kind: 'modified', path: 'assets/logo.png', removed: 0 }),
      file({ added: 0, diffLoaded: false, diffTooExpensive: true, kind: 'modified', path: 'src/huge.ts', removed: 0 }),
      { added: 0, diff: { hunks: [], truncated: true }, diffLoaded: false, kind: 'modified', path: 'src/truncated.ts', removed: 0 },
    ],
  }
  const state = createReviewState({
    catalog: lazyCatalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
    reviewId: 'review-lazy',
  })

  const opened = transitionReviewState(state, { path: 'src/lazy.ts', type: 'toggle-file-expanded' }, lazyCatalog)
  assert.deepEqual(opened.effects, [{ patchset: 'Patchset 20', path: 'src/lazy.ts', reviewId: 'review-lazy', type: 'load-file-diff' }])
  assert.equal(isReviewFileDiffLoading(opened.state, 'src/lazy.ts'), true)
  const openedTruncated = transitionReviewState(state, { path: 'src/truncated.ts', type: 'toggle-file-expanded' }, lazyCatalog)
  assert.deepEqual(openedTruncated.effects, [])
  assert.equal(isReviewFileDiffLoading(openedTruncated.state, 'src/truncated.ts'), false)

  const repeated = transitionReviewState(opened.state, { path: 'src/lazy.ts', type: 'toggle-file-expanded' }, lazyCatalog)
  assert.deepEqual(repeated.effects, [])
  assert.equal(isReviewFileDiffLoading(repeated.state, 'src/lazy.ts'), true)

  const committed = transitionReviewState(opened.state, {
    patchset: 'Patchset 20',
    path: 'src/lazy.ts',
    reviewId: 'review-lazy',
    type: 'commit-file-diff-load',
  }, lazyCatalog)
  assert.equal(isReviewFileDiffLoading(committed.state, 'src/lazy.ts'), false)
  assert.equal(reviewFileDiffLoadError(committed.state, 'src/lazy.ts'), undefined)

  const staleCommit = transitionReviewState(opened.state, {
    patchset: 'Patchset 20',
    path: 'src/lazy.ts',
    reviewId: 'review-old',
    type: 'commit-file-diff-load',
  }, lazyCatalog)
  assert.strictEqual(staleCommit.state, opened.state)

  const failed = transitionReviewState(opened.state, {
    error: 'network failed',
    patchset: 'Patchset 20',
    path: 'src/lazy.ts',
    reviewId: 'review-lazy',
    type: 'fail-file-diff-load',
  }, lazyCatalog)
  assert.equal(isReviewFileDiffLoading(failed.state, 'src/lazy.ts'), false)
  assert.equal(reviewFileDiffLoadError(failed.state, 'src/lazy.ts'), 'network failed')

  const staleFail = transitionReviewState(opened.state, {
    error: 'late failure',
    patchset: 'Patchset 20',
    path: 'src/lazy.ts',
    reviewId: 'review-old',
    type: 'fail-file-diff-load',
  }, lazyCatalog)
  assert.strictEqual(staleFail.state, opened.state)

  const expandAll = transitionReviewState(state, {
    expanded: true,
    paths: lazyCatalog['Patchset 20'].map(file => file.path),
    type: 'set-all-files-expanded',
  }, lazyCatalog)
  assert.deepEqual(expandAll.effects, [{ patchset: 'Patchset 20', path: 'src/lazy.ts', reviewId: 'review-lazy', type: 'load-file-diff' }])
  assert.deepEqual(reviewStateForPatchset(expandAll.state, 'Patchset 20').pendingDiffPaths, ['src/lazy.ts'])
})

test('patchset switching retains each patchset review surface and cancels a foreign comment draft', () => {
  let state = initialState()
  state = transitionReviewState(state, { path: 'clis/dataflow.py', type: 'toggle-file-expanded' }, catalog).state
  state = transitionReviewState(state, {
    line: 13,
    path: 'clis/dataflow.py',
    side: 'right',
    type: 'start-comment',
  }, catalog).state
  state = transitionReviewState(state, { body: 'Keep the base range explicit.', type: 'update-comment-draft' }, catalog).state

  const patchset19 = transitionReviewState(state, { patchset: 'Patchset 19', type: 'select-patchset' }, catalog)
  assert.equal(patchset19.state.commentDraft, undefined)
  assert.equal(isFileReviewed(patchset19.state, 'clis/dataflow.py'), true)
  assert.equal(reviewStateForPatchset(patchset19.state, 'Patchset 20').expandedPaths.includes('clis/dataflow.py'), true)

  const patchset20 = transitionReviewState(patchset19.state, { patchset: 'Patchset 20', type: 'select-patchset' }, catalog)
  const draft = transitionReviewState(patchset20.state, {
    line: 13,
    path: 'clis/dataflow.py',
    side: 'right',
    type: 'start-comment',
  }, catalog)
  const withBody = transitionReviewState(draft.state, { body: 'Patchset 20 comment.', type: 'update-comment-draft' }, catalog)
  const saved = transitionReviewState(withBody.state, { id: 'comment-20', type: 'save-comment' }, catalog)
  assert.equal(commentsForFile(saved.state, 'clis/dataflow.py').length, 1)

  const commentCommitted = transitionReviewState(saved.state, {
    id: 'comment-20',
    patchset: 'Patchset 20',
    pendingType: 'save',
    type: 'commit-comment',
  }, catalog)

  const deleted = transitionReviewState(commentCommitted.state, { id: 'comment-20', type: 'delete-comment' }, catalog)
  assert.equal(commentsForFile(deleted.state, 'clis/dataflow.py').length, 0)

  const deleteCommitted = transitionReviewState(deleted.state, {
    id: 'comment-20',
    patchset: 'Patchset 20',
    pendingType: 'delete',
    type: 'commit-comment',
  }, catalog)
  const backTo19 = transitionReviewState(deleteCommitted.state, { patchset: 'Patchset 19', type: 'select-patchset' }, catalog)
  assert.equal(commentsForFile(backTo19.state, 'clis/dataflow.py').length, 0)
})

test('comment mutations are serialized per patchset and restore authoritative comments on failure', () => {
  let state = initialState()
  state = transitionReviewState(state, { line: 13, path: 'clis/dataflow.py', side: 'right', type: 'start-comment' }, catalog).state
  state = transitionReviewState(state, { body: 'Review this branch.', type: 'update-comment-draft' }, catalog).state
  const saved = transitionReviewState(state, { id: 'comment-pending', type: 'save-comment' }, catalog)
  assert.deepEqual(reviewStateForPatchset(saved.state, 'Patchset 20').pendingComment, { id: 'comment-pending', type: 'save' })
  assert.equal(transitionReviewState(saved.state, { id: 'comment-pending', type: 'delete-comment' }, catalog).state, saved.state)

  const restored = transitionReviewState(saved.state, {
    comments: [],
    id: 'comment-pending',
    patchset: 'Patchset 20',
    pendingType: 'save',
    type: 'restore-comments',
  }, catalog)
  assert.equal(commentsForFile(restored.state, 'clis/dataflow.py').length, 0)
  assert.equal(reviewStateForPatchset(restored.state, 'Patchset 20').pendingComment, undefined)
})

test('comment effects and completions are scoped to review identity', () => {
  let state = createReviewState({
    catalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
    reviewId: 'review-comments',
  })
  state = transitionReviewState(state, { line: 13, path: 'clis/dataflow.py', side: 'right', type: 'start-comment' }, catalog).state
  state = transitionReviewState(state, { body: 'Review this branch.', type: 'update-comment-draft' }, catalog).state
  const saved = transitionReviewState(state, { id: 'comment-scoped', type: 'save-comment' }, catalog)
  assert.deepEqual(saved.effects, [{
    comment: {
      body: 'Review this branch.',
      id: 'comment-scoped',
      line: 13,
      patchset: 'Patchset 20',
      path: 'clis/dataflow.py',
      side: 'right',
    },
    reviewId: 'review-comments',
    type: 'save-comment',
  }])

  const staleCommit = transitionReviewState(saved.state, {
    id: 'comment-scoped',
    patchset: 'Patchset 20',
    pendingType: 'save',
    reviewId: 'review-old',
    type: 'commit-comment',
  }, catalog)
  assert.strictEqual(staleCommit.state, saved.state)

  const committed = transitionReviewState(saved.state, {
    id: 'comment-scoped',
    patchset: 'Patchset 20',
    pendingType: 'save',
    reviewId: 'review-comments',
    type: 'commit-comment',
  }, catalog)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').pendingComment, undefined)

  const deleted = transitionReviewState(committed.state, { id: 'comment-scoped', type: 'delete-comment' }, catalog)
  assert.deepEqual(deleted.effects[0] && {
    reviewId: 'reviewId' in deleted.effects[0] ? deleted.effects[0].reviewId : undefined,
    type: deleted.effects[0].type,
  }, { reviewId: 'review-comments', type: 'delete-comment' })

  const staleRestore = transitionReviewState(deleted.state, {
    comments: [],
    id: 'comment-scoped',
    patchset: 'Patchset 20',
    pendingType: 'delete',
    reviewId: 'review-old',
    type: 'restore-comments',
  }, catalog)
  assert.strictEqual(staleRestore.state, deleted.state)

  const restored = transitionReviewState(deleted.state, {
    comments: [],
    id: 'comment-scoped',
    patchset: 'Patchset 20',
    pendingType: 'delete',
    reviewId: 'review-comments',
    type: 'restore-comments',
  }, catalog)
  assert.equal(reviewStateForPatchset(restored.state, 'Patchset 20').pendingComment, undefined)

  const staleHydrate = transitionReviewState(committed.state, {
    comments: [],
    patchset: 'Patchset 20',
    reviewId: 'review-old',
    type: 'hydrate-comments',
  }, catalog)
  assert.strictEqual(staleHydrate.state, committed.state)
})

test('stale comment restore cannot roll back a completed mutation', () => {
  let state = initialState()
  state = transitionReviewState(state, { line: 13, path: 'clis/dataflow.py', side: 'right', type: 'start-comment' }, catalog).state
  state = transitionReviewState(state, { body: 'Keep this comment.', type: 'update-comment-draft' }, catalog).state
  const saved = transitionReviewState(state, { id: 'comment-stable', type: 'save-comment' }, catalog)
  const committed = transitionReviewState(saved.state, {
    id: 'comment-stable',
    patchset: 'Patchset 20',
    pendingType: 'save',
    type: 'commit-comment',
  }, catalog)

  assert.equal(commentsForFile(committed.state, 'clis/dataflow.py').length, 1)

  const staleRestore = transitionReviewState(committed.state, {
    comments: [],
    id: 'comment-stable',
    patchset: 'Patchset 20',
    pendingType: 'save',
    type: 'restore-comments',
  }, catalog)
  assert.strictEqual(staleRestore.state, committed.state)
  assert.equal(commentsForFile(staleRestore.state, 'clis/dataflow.py').length, 1)
})

test('stale comment restore cannot replace a newer pending mutation', () => {
  let state = initialState()
  state = transitionReviewState(state, { line: 13, path: 'clis/dataflow.py', side: 'right', type: 'start-comment' }, catalog).state
  state = transitionReviewState(state, { body: 'First comment.', type: 'update-comment-draft' }, catalog).state
  const firstSaved = transitionReviewState(state, { id: 'comment-first', type: 'save-comment' }, catalog)
  const firstCommitted = transitionReviewState(firstSaved.state, {
    id: 'comment-first',
    patchset: 'Patchset 20',
    pendingType: 'save',
    type: 'commit-comment',
  }, catalog).state

  state = transitionReviewState(firstCommitted, { line: 14, path: 'clis/dataflow.py', side: 'right', type: 'start-comment' }, catalog).state
  state = transitionReviewState(state, { body: 'Second comment.', type: 'update-comment-draft' }, catalog).state
  const secondSaved = transitionReviewState(state, { id: 'comment-second', type: 'save-comment' }, catalog)

  const staleRestore = transitionReviewState(secondSaved.state, {
    comments: [],
    id: 'comment-first',
    patchset: 'Patchset 20',
    pendingType: 'save',
    type: 'restore-comments',
  }, catalog)
  assert.strictEqual(staleRestore.state, secondSaved.state)
  assert.deepEqual(commentsForFile(staleRestore.state, 'clis/dataflow.py').map(comment => comment.id), [
    'comment-first',
    'comment-second',
  ])
})

test('stale comment completion cannot clear a different pending operation type', () => {
  let state = initialState()
  state = transitionReviewState(state, { line: 13, path: 'clis/dataflow.py', side: 'right', type: 'start-comment' }, catalog).state
  state = transitionReviewState(state, { body: 'Comment to delete later.', type: 'update-comment-draft' }, catalog).state
  const saved = transitionReviewState(state, { id: 'comment-operation', type: 'save-comment' }, catalog)
  const committed = transitionReviewState(saved.state, {
    id: 'comment-operation',
    patchset: 'Patchset 20',
    pendingType: 'save',
    type: 'commit-comment',
  }, catalog).state
  const deleted = transitionReviewState(committed, { id: 'comment-operation', type: 'delete-comment' }, catalog)

  const staleSaveCommit = transitionReviewState(deleted.state, {
    id: 'comment-operation',
    patchset: 'Patchset 20',
    pendingType: 'save',
    type: 'commit-comment',
  }, catalog)
  assert.strictEqual(staleSaveCommit.state, deleted.state)
  assert.deepEqual(reviewStateForPatchset(staleSaveCommit.state, 'Patchset 20').pendingComment, {
    id: 'comment-operation',
    type: 'delete',
  })

  const staleSaveRestore = transitionReviewState(deleted.state, {
    comments: [],
    id: 'comment-operation',
    patchset: 'Patchset 20',
    pendingType: 'save',
    type: 'restore-comments',
  }, catalog)
  assert.strictEqual(staleSaveRestore.state, deleted.state)
  assert.deepEqual(reviewStateForPatchset(staleSaveRestore.state, 'Patchset 20').pendingComment, {
    id: 'comment-operation',
    type: 'delete',
  })
})

test('invalid file actions are no-ops', () => {
  const state = initialState()
  const invalid = transitionReviewState(state, { path: 'outside/review.ts', type: 'toggle-file-expanded' }, catalog)
  assert.strictEqual(invalid.state, state)
  assert.deepEqual(invalid.effects, [])

})

test('catalog refresh prunes state that points at removed files', () => {
  const oldCatalog: ReviewCatalog = {
    'Patchset 20': [
      {
        added: 1,
        diff: {
          hunks: [{
            commonContext: [{ kind: 'context', left: { line: 1, text: 'before keep' }, right: { line: 1, text: 'before keep' } }],
            header: '@@ -1,1 +1,2 @@',
            rows: [{ kind: 'added', right: { line: 2, text: 'keep change' } }],
          }],
        },
        kind: 'modified',
        path: 'src/keep.ts',
        removed: 0,
      },
      file({ added: 1, diffLoaded: false, kind: 'modified', path: 'src/pending.ts', removed: 1 }),
      file({ added: 1, diffLoaded: false, kind: 'modified', path: 'src/remove.ts', removed: 1 }),
    ],
  }
  const refreshedCatalog: ReviewCatalog = {
    'Patchset 20': [oldCatalog['Patchset 20'][0]],
  }
  let state = createReviewState({
    catalog: oldCatalog,
    comments: [
      { body: 'keep comment', id: 'comment-keep', line: 2, patchset: 'Patchset 20', path: 'src/keep.ts', side: 'right' },
      { body: 'remove comment', id: 'comment-remove', line: 2, patchset: 'Patchset 20', path: 'src/remove.ts', side: 'right' },
    ],
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
    reviewedPathsByPatchset: { 'Patchset 20': ['src/keep.ts', 'src/remove.ts'] },
    reviewId: 'review-refresh',
  })
  state = transitionReviewState(state, { hunkIndex: 0, path: 'src/keep.ts', type: 'toggle-common-context' }, oldCatalog).state
  state = transitionReviewState(state, { path: 'src/pending.ts', type: 'toggle-file-expanded' }, oldCatalog).state
  state = transitionReviewState(state, { path: 'src/remove.ts', type: 'toggle-file-expanded' }, oldCatalog).state
  state = transitionReviewState(state, {
    error: 'network failed',
    patchset: 'Patchset 20',
    path: 'src/remove.ts',
    reviewId: 'review-refresh',
    type: 'fail-file-diff-load',
  }, oldCatalog).state
  state = transitionReviewState(state, { path: 'src/remove.ts', reviewed: false, type: 'set-file-reviewed' }, oldCatalog).state
  state = transitionReviewState(state, { line: 2, path: 'src/remove.ts', side: 'right', type: 'start-comment' }, oldCatalog).state
  state = transitionReviewState(state, { body: 'draft on removed file', type: 'update-comment-draft' }, oldCatalog).state

  const reconciled = reconcileReviewStateWithCatalog(state, refreshedCatalog)
  const patchset = reviewStateForPatchset(reconciled, 'Patchset 20')
  assert.deepEqual(patchset.expandedPaths, [])
  assert.deepEqual(patchset.pendingDiffPaths, [])
  assert.deepEqual(patchset.diffLoadErrors, {})
  assert.deepEqual(patchset.revealedContextHunks, ['src/keep.ts:0'])
  assert.deepEqual(patchset.reviewedPaths, ['src/keep.ts'])
  assert.equal(patchset.pendingReview, undefined)
  assert.equal(reconciled.commentDraft, undefined)
  assert.deepEqual(reconciled.comments.map(comment => comment.id), ['comment-keep'])
})

test('catalog refresh clears stale lazy diff pending and errors for loaded files', () => {
  const lazyCatalog: ReviewCatalog = {
    'Patchset 20': [
      file({ added: 1, diffLoaded: false, kind: 'modified', path: 'src/lazy.ts', removed: 1 }),
      file({ added: 1, diffLoaded: false, kind: 'modified', path: 'src/still-lazy.ts', removed: 1 }),
    ],
  }
  const refreshedCatalog: ReviewCatalog = {
    'Patchset 20': [
      {
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
        diffLoaded: true,
        kind: 'modified',
        path: 'src/lazy.ts',
        removed: 1,
      },
      file({ added: 1, diffLoaded: false, kind: 'modified', path: 'src/still-lazy.ts', removed: 1 }),
    ],
  }
  let state = createReviewState({
    catalog: lazyCatalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
    reviewId: 'review-refresh-loaded-diff',
  })
  state = transitionReviewState(state, { path: 'src/lazy.ts', type: 'toggle-file-expanded' }, lazyCatalog).state
  state = transitionReviewState(state, { path: 'src/still-lazy.ts', type: 'toggle-file-expanded' }, lazyCatalog).state
  state = transitionReviewState(state, {
    error: 'network failed',
    patchset: 'Patchset 20',
    path: 'src/lazy.ts',
    reviewId: 'review-refresh-loaded-diff',
    type: 'fail-file-diff-load',
  }, lazyCatalog).state

  const reconciled = reconcileReviewStateWithCatalog(state, refreshedCatalog)
  const patchset = reviewStateForPatchset(reconciled, 'Patchset 20')
  assert.deepEqual(patchset.expandedPaths, ['src/lazy.ts', 'src/still-lazy.ts'])
  assert.deepEqual(patchset.pendingDiffPaths, ['src/still-lazy.ts'])
  assert.deepEqual(patchset.diffLoadErrors, {})
})

test('catalog refresh preserves pending comment deletes until completion', () => {
  let state = createReviewState({
    catalog,
    comments: [
      { body: 'Delete me.', id: 'comment-delete-refresh', line: 3, patchset: 'Patchset 20', path: 'clis/dataflow.py', side: 'right' },
    ],
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
    reviewId: 'review-refresh-delete',
  })
  const deleted = transitionReviewState(state, { id: 'comment-delete-refresh', type: 'delete-comment' }, catalog)
  assert.deepEqual(reviewStateForPatchset(deleted.state, 'Patchset 20').pendingComment, {
    id: 'comment-delete-refresh',
    type: 'delete',
  })
  assert.deepEqual(commentsForFile(deleted.state, 'clis/dataflow.py'), [])

  state = reconcileReviewStateWithCatalog(deleted.state, catalog)
  assert.deepEqual(reviewStateForPatchset(state, 'Patchset 20').pendingComment, {
    id: 'comment-delete-refresh',
    type: 'delete',
  })

  const committed = transitionReviewState(state, {
    id: 'comment-delete-refresh',
    patchset: 'Patchset 20',
    pendingType: 'delete',
    reviewId: 'review-refresh-delete',
    type: 'commit-comment',
  }, catalog)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').pendingComment, undefined)
})

test('catalog refresh moves the active patchset when the current one disappears', () => {
  const state = createReviewState({
    catalog: {
      'Patchset 19': [file({ added: 1, kind: 'modified', path: 'src/old.ts', removed: 1 })],
      'Patchset 20': [file({ added: 2, kind: 'modified', path: 'src/current.ts', removed: 1 })],
    },
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
    reviewedPathsByPatchset: { 'Patchset 20': ['src/current.ts'] },
  })
  const refreshed = reconcileReviewStateWithCatalog(state, {
    'Patchset 21': [file({ added: 3, kind: 'modified', path: 'src/next.ts', removed: 1 })],
  })
  assert.equal(refreshed.patchRange.patchset, 'Patchset 21')
  assert.deepEqual(Object.keys(refreshed.patchsets), ['Patchset 21'])
  assert.deepEqual(reviewStateForPatchset(refreshed, 'Patchset 21').reviewedPaths, [])
})

test('common context expands only for the hunk the reader chose', () => {
  const contextCatalog: ReviewCatalog = {
    'Patchset 20': [{
      added: 1,
      diff: {
        hunks: [
          {
            commonContext: [{ kind: 'context', left: { line: 3, text: 'before first change' }, right: { line: 3, text: 'before first change' } }],
            header: '@@ -3,1 +3,2 @@',
            rows: [{ kind: 'added', right: { line: 4, text: 'first change' } }],
          },
          {
            commonContext: [{ kind: 'context', left: { line: 40, text: 'before second change' }, right: { line: 40, text: 'before second change' } }],
            header: '@@ -40,1 +41,2 @@',
            rows: [{ kind: 'added', right: { line: 41, text: 'second change' } }],
          },
        ],
      },
      kind: 'modified',
      path: 'clis/dataflow.py',
      removed: 0,
    }],
  }
  const state = createReviewState({
    catalog: contextCatalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
  })

  const firstOpened = transitionReviewState(state, {
    hunkIndex: 0,
    path: 'clis/dataflow.py',
    type: 'toggle-common-context',
  }, contextCatalog)
  assert.deepEqual(reviewStateForPatchset(firstOpened.state, 'Patchset 20').revealedContextHunks, ['clis/dataflow.py:0'])

  const secondOpened = transitionReviewState(firstOpened.state, {
    hunkIndex: 1,
    path: 'clis/dataflow.py',
    type: 'toggle-common-context',
  }, contextCatalog)
  assert.deepEqual(reviewStateForPatchset(secondOpened.state, 'Patchset 20').revealedContextHunks, ['clis/dataflow.py:0', 'clis/dataflow.py:1'])

  const missingContext = transitionReviewState(state, {
    hunkIndex: 4,
    path: 'clis/dataflow.py',
    type: 'toggle-common-context',
  }, contextCatalog)
  assert.strictEqual(missingContext.state, state)
})

test('preferences are a single state-machine transition before changing review behavior', () => {
  const state = initialState(false)
  const preferences = {
    ...state.preferences,
    autoMarkReviewed: true,
    context: 25,
    fitToScreen: false,
  }
  const updated = transitionReviewState(state, { preferences, type: 'set-preferences' }, catalog)
  assert.deepEqual(updated.effects, [])
  assert.deepEqual(updated.state.preferences, preferences)

  const opened = transitionReviewState(updated.state, { path: 'clis/dataflow.py', type: 'toggle-file-expanded' }, catalog)
  assert.equal(isFileReviewed(opened.state, 'clis/dataflow.py'), true)
})

test('diff mode is normalized before it enters review state', () => {
  assert.equal(normalizeReviewDiffMode('unified'), 'unified')
  assert.equal(normalizeReviewDiffMode('split'), 'split')
  assert.equal(normalizeReviewDiffMode('side-by-side'), 'split')
  assert.equal(createReviewState({
    catalog,
    diffMode: 'side-by-side' as never,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
  }).diffMode, 'split')

  const unified = transitionReviewState(initialState(), {
    mode: 'unified',
    type: 'set-diff-mode',
  }, catalog).state
  assert.equal(unified.diffMode, 'unified')
  assert.equal(transitionReviewState(unified, {
    mode: 'side-by-side' as never,
    type: 'set-diff-mode',
  }, catalog).state.diffMode, 'split')
})

test('review status is optimistic only while one versioned API mutation is pending', () => {
  const requested = transitionReviewState(initialState(), {
    path: 'clis/dataflow.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog)
  assert.deepEqual(reviewStateForPatchset(requested.state, 'Patchset 20').pendingReview, {
    changes: [{ path: 'clis/dataflow.py', reviewed: true }],
  })

  const duplicate = transitionReviewState(requested.state, {
    path: 'clis/diagnose.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog)
  assert.strictEqual(duplicate.state, requested.state)

  const committed = transitionReviewState(requested.state, {
    patchset: 'Patchset 20',
    paths: ['clis/dataflow.py'],
    revision: 1,
    type: 'commit-reviewed-status',
  }, catalog)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').pendingReview, undefined)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').reviewedRevision, 1)

  const unreviewed = transitionReviewState(committed.state, {
    path: 'clis/dataflow.py',
    reviewed: false,
    type: 'set-file-reviewed',
  }, catalog)
  const restored = transitionReviewState(unreviewed.state, {
    patchset: 'Patchset 20',
    reviewedPaths: ['docs/review.md', 'clis/dataflow.py'],
    revision: 1,
    type: 'restore-reviewed-status',
  }, catalog)
  assert.equal(isFileReviewed(restored.state, 'clis/dataflow.py'), true)
  assert.equal(reviewStateForPatchset(restored.state, 'Patchset 20').pendingReview, undefined)
})

test('stale reviewed restore cannot roll back a completed mutation', () => {
  const requested = transitionReviewState(initialState(), {
    path: 'clis/dataflow.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog)
  const committed = transitionReviewState(requested.state, {
    patchset: 'Patchset 20',
    paths: ['clis/dataflow.py'],
    reviewedPaths: ['docs/review.md', 'clis/dataflow.py'],
    revision: 2,
    type: 'commit-reviewed-status',
  }, catalog)
  const staleRestore = transitionReviewState(committed.state, {
    patchset: 'Patchset 20',
    reviewedPaths: ['docs/review.md'],
    revision: 1,
    type: 'restore-reviewed-status',
  }, catalog)

  assert.strictEqual(staleRestore.state, committed.state)
  assert.deepEqual(staleRestore.effects, [])
  assert.equal(isFileReviewed(staleRestore.state, 'clis/dataflow.py'), true)
})

test('review status effects and completions are scoped to review identity', () => {
  const scopedState = createReviewState({
    catalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
    reviewedPathsByPatchset: { 'Patchset 20': ['docs/review.md'] },
    reviewId: 'review-current',
  })
  const requested = transitionReviewState(scopedState, {
    path: 'clis/dataflow.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog)
  assert.deepEqual(requested.effects, [{
    changes: [{ path: 'clis/dataflow.py', reviewed: true }],
    patchset: 'Patchset 20',
    reviewId: 'review-current',
    revision: 0,
    type: 'save-reviewed-status',
  }])

  const staleCommit = transitionReviewState(requested.state, {
    patchset: 'Patchset 20',
    paths: ['clis/dataflow.py'],
    reviewedPaths: ['docs/review.md', 'clis/dataflow.py'],
    reviewId: 'review-old',
    revision: 1,
    type: 'commit-reviewed-status',
  }, catalog)
  assert.strictEqual(staleCommit.state, requested.state)

  const committed = transitionReviewState(requested.state, {
    patchset: 'Patchset 20',
    paths: ['clis/dataflow.py'],
    reviewedPaths: ['docs/review.md', 'clis/dataflow.py'],
    reviewId: 'review-current',
    revision: 1,
    type: 'commit-reviewed-status',
  }, catalog)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').pendingReview, undefined)

  const opened = transitionReviewState(createReviewState({
    catalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState(true).preferences,
    reviewId: 'review-auto',
  }), {
    path: 'clis/dataflow.py',
    type: 'toggle-file-expanded',
  }, catalog)
  const staleHydrate = transitionReviewState(opened.state, {
    patchset: 'Patchset 20',
    reviewedPaths: [],
    reviewId: 'review-old',
    revision: 7,
    type: 'hydrate-reviewed-status',
  }, catalog)
  assert.strictEqual(staleHydrate.state, opened.state)

  const hydrated = transitionReviewState(opened.state, {
    patchset: 'Patchset 20',
    reviewedPaths: [],
    reviewId: 'review-auto',
    revision: 7,
    type: 'hydrate-reviewed-status',
  }, catalog)
  assert.deepEqual(hydrated.effects, [{
    changes: [{ path: 'clis/dataflow.py', reviewed: true }],
    patchset: 'Patchset 20',
    reviewId: 'review-auto',
    revision: 7,
    type: 'save-reviewed-status',
  }])
})

test('review status supports non-atomic mark-all UI convenience for a patchset', () => {
  const requested = transitionReviewState(initialState(), {
    changes: [
      { path: 'clis/dataflow.py', reviewed: true },
      { path: 'clis/diagnose.py', reviewed: true },
      { path: 'docs/review.md', reviewed: true },
      { path: 'outside/review.ts', reviewed: true },
    ],
    type: 'set-files-reviewed',
  }, catalog)

  assert.deepEqual(requested.effects, [{
    changes: [
      { path: 'clis/dataflow.py', reviewed: true },
      { path: 'clis/diagnose.py', reviewed: true },
    ],
    patchset: 'Patchset 20',
    revision: 0,
    type: 'save-reviewed-status',
  }])
  assert.deepEqual(reviewStateForPatchset(requested.state, 'Patchset 20').pendingReview, {
    changes: [
      { path: 'clis/dataflow.py', reviewed: true },
      { path: 'clis/diagnose.py', reviewed: true },
    ],
  })
  assert.deepEqual(reviewFileState(requested.state, 'clis/dataflow.py'), { loaded: true, pending: true, status: 'reviewed' })
  assert.deepEqual(reviewFileState(requested.state, 'clis/diagnose.py'), { loaded: true, pending: true, status: 'reviewed' })

  const committed = transitionReviewState(requested.state, {
    patchset: 'Patchset 20',
    paths: ['clis/dataflow.py', 'clis/diagnose.py'],
    reviewedPaths: ['docs/review.md', 'clis/dataflow.py', 'clis/diagnose.py'],
    revision: 1,
    type: 'commit-reviewed-status',
  }, catalog)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').pendingReview, undefined)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').reviewedRevision, 1)
  assert.deepEqual(reviewPatchsetSummary(committed.state, catalog), {
    additions: 8,
    deletions: 7,
    fileCount: 3,
    reviewedStatusLoaded: true,
    reviewedCount: 3,
    unreviewedCount: 0,
  })
})

test('review status hydration never rolls a newer revision back', () => {
  const hydrated = transitionReviewState(initialState(), {
    patchset: 'Patchset 20',
    reviewedPaths: ['clis/dataflow.py'],
    revision: 4,
    type: 'hydrate-reviewed-status',
  }, catalog)
  assert.equal(reviewStateForPatchset(hydrated.state, 'Patchset 20').reviewedRevision, 4)

  const stale = transitionReviewState(hydrated.state, {
    patchset: 'Patchset 20',
    reviewedPaths: [],
    revision: 3,
    type: 'hydrate-reviewed-status',
  }, catalog)
  assert.strictEqual(stale.state, hydrated.state)
  assert.deepEqual(stale.effects, [])
  assert.equal(isFileReviewed(stale.state, 'clis/dataflow.py'), true)
})

test('committing a review mutation can apply the authoritative reviewed set', () => {
  const requested = transitionReviewState(initialState(), {
    path: 'clis/dataflow.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog)
  const committed = transitionReviewState(requested.state, {
    patchset: 'Patchset 20',
    paths: ['clis/dataflow.py'],
    reviewedPaths: ['clis/dataflow.py', 'clis/diagnose.py'],
    revision: 1,
    type: 'commit-reviewed-status',
  }, catalog)
  assert.equal(isFileReviewed(committed.state, 'clis/dataflow.py'), true)
  assert.equal(isFileReviewed(committed.state, 'clis/diagnose.py'), true)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').pendingReview, undefined)
})

test('comment state rejects malformed or duplicate records', () => {
  const malformed = createReviewState({
    catalog,
    comments: [
      { body: '  Keep this. ', id: 'comment-1', line: 3, patchset: 'Patchset 20', path: 'clis/dataflow.py', side: 'right' },
      { body: 'duplicate', id: 'comment-1', line: 4, patchset: 'Patchset 20', path: 'clis/dataflow.py', side: 'right' },
      { body: 'bad line', id: 'comment-2', line: 1.5, patchset: 'Patchset 20', path: 'clis/dataflow.py', side: 'right' },
    ],
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
  })
  assert.deepEqual(commentsForFile(malformed, 'clis/dataflow.py').map(comment => comment.body), ['Keep this.'])

  let state = initialState()
  state = transitionReviewState(state, { line: 3, path: 'clis/dataflow.py', side: 'right', type: 'start-comment' }, catalog).state
  state = transitionReviewState(state, { body: 'first comment', type: 'update-comment-draft' }, catalog).state
  state = transitionReviewState(state, { id: 'comment-1', type: 'save-comment' }, catalog).state
  state = transitionReviewState(state, { id: 'comment-1', patchset: 'Patchset 20', pendingType: 'save', type: 'commit-comment' }, catalog).state
  const duplicate = transitionReviewState(state, { line: 4, path: 'clis/dataflow.py', side: 'right', type: 'start-comment' }, catalog).state
  const duplicateDraft = transitionReviewState(duplicate, { body: 'should be ignored', type: 'update-comment-draft' }, catalog).state
  const duplicateSave = transitionReviewState(duplicateDraft, { id: 'comment-1', type: 'save-comment' }, catalog)
  assert.strictEqual(duplicateSave.state, duplicateDraft)
  assert.deepEqual(duplicateSave.effects, [])
})

test('comment ids are scoped to the owning patchset', () => {
  const state = createReviewState({
    catalog,
    comments: [
      { body: 'Patchset 20 comment.', id: 'same-comment-id', line: 3, patchset: 'Patchset 20', path: 'clis/dataflow.py', side: 'right' },
      { body: 'Patchset 19 comment.', id: 'same-comment-id', line: 3, patchset: 'Patchset 19', path: 'clis/dataflow.py', side: 'right' },
    ],
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
  })

  assert.deepEqual(commentsForFile(state, 'clis/dataflow.py', 'Patchset 20').map(comment => comment.body), ['Patchset 20 comment.'])
  assert.deepEqual(commentsForFile(state, 'clis/dataflow.py', 'Patchset 19').map(comment => comment.body), ['Patchset 19 comment.'])

  const deleted20 = transitionReviewState(state, { id: 'same-comment-id', type: 'delete-comment' }, catalog)
  assert.deepEqual(commentsForFile(deleted20.state, 'clis/dataflow.py', 'Patchset 20'), [])
  assert.deepEqual(commentsForFile(deleted20.state, 'clis/dataflow.py', 'Patchset 19').map(comment => comment.body), ['Patchset 19 comment.'])

  const patchset19 = transitionReviewState(state, { patchset: 'Patchset 19', type: 'select-patchset' }, catalog).state
  const deleted19 = transitionReviewState(patchset19, { id: 'same-comment-id', type: 'delete-comment' }, catalog)
  assert.deepEqual(commentsForFile(deleted19.state, 'clis/dataflow.py', 'Patchset 20').map(comment => comment.body), ['Patchset 20 comment.'])
  assert.deepEqual(commentsForFile(deleted19.state, 'clis/dataflow.py', 'Patchset 19'), [])
})

test('comment state keeps Gerrit-style previous-path comments for renamed files', () => {
  const renamedCatalog: ReviewCatalog = {
    'Patchset 20': [
      file({ added: 2, kind: 'renamed', path: 'src/new-name.ts', previousPath: 'src/old-name.ts', removed: 1, status: 'R' }),
    ],
  }
  let state = createReviewState({
    catalog: renamedCatalog,
    comments: [
      { body: 'Current path comment.', id: 'comment-current', line: 3, patchset: 'Patchset 20', path: 'src/new-name.ts', side: 'right' },
      { body: 'Previous path comment.', id: 'comment-previous', line: 3, patchset: 'Patchset 20', path: 'src/old-name.ts', side: 'left' },
      { body: 'Wrong old path.', id: 'comment-wrong-old', line: 3, patchset: 'Patchset 20', path: 'src/older-name.ts', side: 'left' },
    ],
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
  })

  assert.deepEqual(commentsForFile(state, 'src/old-name.ts').map(comment => comment.body), ['Previous path comment.'])
  assert.deepEqual(commentsForFilePaths(state, ['src/new-name.ts', 'src/old-name.ts']).map(comment => comment.body), [
    'Current path comment.',
    'Previous path comment.',
  ])

  state = transitionReviewState(state, { line: 4, path: 'src/old-name.ts', side: 'left', type: 'start-comment' }, renamedCatalog).state
  state = transitionReviewState(state, { body: 'Draft on previous path.', type: 'update-comment-draft' }, renamedCatalog).state
  assert.equal(state.commentDraft?.path, 'src/old-name.ts')

  const reconciled = reconcileReviewStateWithCatalog(state, renamedCatalog)
  assert.deepEqual(commentsForFilePaths(reconciled, ['src/new-name.ts', 'src/old-name.ts']).map(comment => comment.id), [
    'comment-current',
    'comment-previous',
  ])
  assert.equal(reconciled.commentDraft?.path, 'src/old-name.ts')

  const renamedAgain: ReviewCatalog = {
    'Patchset 20': [
      file({ added: 2, kind: 'renamed', path: 'src/new-name.ts', previousPath: 'src/another-old-name.ts', removed: 1, status: 'R' }),
    ],
  }
  const pruned = reconcileReviewStateWithCatalog(state, renamedAgain)
  assert.deepEqual(pruned.comments.map(comment => comment.id), ['comment-current'])
  assert.equal(pruned.commentDraft, undefined)
})

test('rename comment path follows Gerrit side semantics', () => {
  const renamedFile = file({
    added: 2,
    kind: 'renamed',
    path: 'src/new-name.ts',
    previousPath: 'src/old-name.ts',
    removed: 1,
    status: 'R',
  })

  assert.equal(reviewCommentPathForSide(renamedFile, 'left'), 'src/old-name.ts')
  assert.equal(reviewCommentPathForSide(renamedFile, 'right'), 'src/new-name.ts')
  assert.equal(reviewCommentPathForSide(renamedFile, 'unified'), 'src/new-name.ts')

  const unsafePreviousPath = file({
    added: 2,
    kind: 'renamed',
    path: 'src/new-name.ts',
    previousPath: '../old-name.ts',
    removed: 1,
    status: 'R',
  })
  assert.equal(reviewCommentPathForSide(unsafePreviousPath, 'left'), 'src/new-name.ts')
})

test('unified diff comments keep Gerrit left/right storage sides', () => {
  assert.equal(reviewCommentSideForUnifiedCell('deleted', false), 'left')
  assert.equal(reviewCommentSideForUnifiedCell('added', true), 'right')
  assert.equal(reviewCommentSideForUnifiedCell('context', true), 'right')
  assert.equal(reviewCommentSideForUnifiedCell('context', false), 'left')
})

test('a review response updates its original patchset after the reader switches patchsets', () => {
  const requested = transitionReviewState(initialState(), {
    path: 'clis/dataflow.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog)
  const switched = transitionReviewState(requested.state, {
    patchset: 'Patchset 19',
    type: 'select-patchset',
  }, catalog)
  const committed = transitionReviewState(switched.state, {
    patchset: 'Patchset 20',
    paths: ['clis/dataflow.py'],
    revision: 1,
    type: 'commit-reviewed-status',
  }, catalog)

  assert.equal(committed.state.patchRange.patchset, 'Patchset 19')
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').reviewedRevision, 1)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 20').pendingReview, undefined)
  assert.equal(reviewStateForPatchset(committed.state, 'Patchset 19').reviewedRevision, 0)
})

test('normalizes persisted and submitted preferences before they influence a diff', () => {
  assert.deepEqual(normalizeReviewPreferences({
    ignoreWhitespace: 'LEADING_AND_TRAILING',
  }).ignoreWhitespace, 'LEADING_AND_TRAILING')

  assert.deepEqual(normalizeReviewPreferences({
    autoMarkReviewed: 'yes',
    context: 87,
    fitToScreen: 'no',
    fontSize: 30,
    ignoreWhitespace: 'unknown',
    intralineDifference: 'yes',
    lineLength: 1,
    showTabs: null,
    showTrailingWhitespace: 1,
    syntaxHighlighting: 'true',
    tabSize: 99,
  }), {
    autoMarkReviewed: false,
    context: 10,
    fitToScreen: true,
    fontSize: 20,
    ignoreWhitespace: 'NONE',
    intralineDifference: true,
    lineLength: 40,
    showTabs: true,
    showTrailingWhitespace: true,
    syntaxHighlighting: true,
    tabSize: 16,
  })

  const state = initialState()
  const transition = transitionReviewState(state, {
    preferences: { ...state.preferences, context: 100 },
    type: 'set-preferences',
  }, catalog)
  assert.equal(transition.state.preferences.context, 100)
})

test('file status selectors expose one consistent row state and patchset summary', () => {
  const state = initialState()
  assert.deepEqual(reviewFileState(state, 'docs/review.md'), { loaded: true, pending: false, status: 'reviewed' })
  assert.deepEqual(reviewFileState(state, 'clis/dataflow.py'), { loaded: true, pending: false, status: 'unreviewed' })
  assert.deepEqual(reviewPatchsetSummary(state, catalog), {
    additions: 8,
    deletions: 7,
    fileCount: 3,
    reviewedStatusLoaded: true,
    reviewedCount: 1,
    unreviewedCount: 2,
  })

  const pending = transitionReviewState(state, {
    path: 'clis/dataflow.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog).state
  assert.deepEqual(reviewFileState(pending, 'clis/dataflow.py'), { loaded: true, pending: true, status: 'reviewed' })
})

test('patchset summary excludes Gerrit magic paths from line totals but keeps them reviewable', () => {
  const catalogWithMagicPaths: ReviewCatalog = {
    'Patchset 20': [
      ...catalog['Patchset 20'],
      {
        added: 4,
        diff: { hunks: [] },
        kind: 'modified',
        path: '/COMMIT_MSG',
        removed: 2,
        status: 'M',
      },
      {
        added: 3,
        diff: { hunks: [] },
        kind: 'modified',
        path: '/MERGE_LIST',
        removed: 1,
        status: 'M',
      },
    ],
  }
  const state = createReviewState({
    catalog: catalogWithMagicPaths,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
    reviewedPathsByPatchset: { 'Patchset 20': ['docs/review.md', '/COMMIT_MSG'] },
  })
  assert.deepEqual(reviewPatchsetSummary(state, catalogWithMagicPaths), {
    additions: 8,
    deletions: 7,
    fileCount: 5,
    reviewedStatusLoaded: true,
    reviewedCount: 2,
    unreviewedCount: 3,
  })
})

test('reviewed state stays unknown until the Gerrit-style reviewed file list is loaded', () => {
  const state = createReviewState({
    catalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState().preferences,
  })
  assert.deepEqual(reviewFileState(state, 'clis/dataflow.py'), { loaded: false, pending: false, status: 'unknown' })
  assert.deepEqual(reviewPatchsetSummary(state, catalog), {
    additions: 8,
    deletions: 7,
    fileCount: 3,
    reviewedStatusLoaded: false,
    reviewedCount: 0,
    unreviewedCount: 0,
  })

  const ignored = transitionReviewState(state, {
    path: 'clis/dataflow.py',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog)
  assert.strictEqual(ignored.state, state)
  assert.deepEqual(ignored.effects, [])

  const hydrated = transitionReviewState(state, {
    patchset: 'Patchset 20',
    reviewedPaths: [],
    revision: 1,
    type: 'hydrate-reviewed-status',
  }, catalog)
  assert.deepEqual(reviewFileState(hydrated.state, 'clis/dataflow.py'), { loaded: true, pending: false, status: 'unreviewed' })
})

test('single-file auto review waits for the Gerrit-style reviewed file list', () => {
  const state = createReviewState({
    catalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState(true).preferences,
  })

  const opened = transitionReviewState(state, {
    path: 'clis/dataflow.py',
    type: 'toggle-file-expanded',
  }, catalog)
  assert.deepEqual(opened.effects, [])
  assert.deepEqual(reviewFileState(opened.state, 'clis/dataflow.py'), { loaded: false, pending: false, status: 'unknown' })
  assert.deepEqual(reviewStateForPatchset(opened.state, 'Patchset 20').autoReviewPaths, ['clis/dataflow.py'])

  const hydrated = transitionReviewState(opened.state, {
    patchset: 'Patchset 20',
    reviewedPaths: [],
    revision: 7,
    type: 'hydrate-reviewed-status',
  }, catalog)
  assert.deepEqual(hydrated.effects, [{
    changes: [{ path: 'clis/dataflow.py', reviewed: true }],
    patchset: 'Patchset 20',
    revision: 7,
    type: 'save-reviewed-status',
  }])
  assert.deepEqual(reviewFileState(hydrated.state, 'clis/dataflow.py'), { loaded: true, pending: true, status: 'reviewed' })
  assert.deepEqual(reviewStateForPatchset(hydrated.state, 'Patchset 20').autoReviewPaths, [])
})

test('expand-all and collapsed files are not auto-reviewed after reviewed files load', () => {
  const state = createReviewState({
    catalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 20' },
    preferences: initialState(true).preferences,
  })
  const expandedAll = transitionReviewState(state, {
    expanded: true,
    paths: catalog['Patchset 20'].map(file => file.path),
    type: 'set-all-files-expanded',
  }, catalog)
  const hydratedAll = transitionReviewState(expandedAll.state, {
    patchset: 'Patchset 20',
    reviewedPaths: [],
    revision: 1,
    type: 'hydrate-reviewed-status',
  }, catalog)
  assert.deepEqual(hydratedAll.effects, [])
  assert.deepEqual(reviewFileState(hydratedAll.state, 'clis/dataflow.py'), { loaded: true, pending: false, status: 'unreviewed' })

  const opened = transitionReviewState(state, { path: 'clis/dataflow.py', type: 'toggle-file-expanded' }, catalog)
  const collapsed = transitionReviewState(opened.state, { path: 'clis/dataflow.py', type: 'toggle-file-expanded' }, catalog)
  assert.deepEqual(reviewStateForPatchset(collapsed.state, 'Patchset 20').autoReviewPaths, [])
  const hydratedCollapsed = transitionReviewState(collapsed.state, {
    patchset: 'Patchset 20',
    reviewedPaths: [],
    revision: 1,
    type: 'hydrate-reviewed-status',
  }, catalog)
  assert.deepEqual(hydratedCollapsed.effects, [])
  assert.deepEqual(reviewFileState(hydratedCollapsed.state, 'clis/dataflow.py'), { loaded: true, pending: false, status: 'unreviewed' })
})

test('review state accepts Gerrit special file paths without allowing arbitrary absolute paths', () => {
  const specialCatalog: ReviewCatalog = {
    'Patchset 2': [
      file({ added: 1, kind: 'modified', path: '/COMMIT_MSG', removed: 1 }),
      file({ added: 1, kind: 'modified', path: 'src/review.ts', removed: 0 }),
    ],
  }
  const state = createReviewState({
    catalog: specialCatalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 2' },
    preferences: initialState().preferences,
    reviewedPathsByPatchset: { 'Patchset 2': ['/COMMIT_MSG', '/etc/passwd'] },
  })
  assert.equal(isFileReviewed(state, '/COMMIT_MSG'), true)
  assert.equal(isFileReviewed(state, '/etc/passwd'), false)

  const transition = transitionReviewState(state, {
    path: '/COMMIT_MSG',
    reviewed: false,
    type: 'set-file-reviewed',
  }, specialCatalog)
  assert.deepEqual(transition.effects, [{
    changes: [{ path: '/COMMIT_MSG', reviewed: false }],
    patchset: 'Patchset 2',
    revision: 0,
    type: 'save-reviewed-status',
  }])
})
