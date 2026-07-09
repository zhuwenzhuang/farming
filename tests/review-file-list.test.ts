import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createReviewState,
  DEFAULT_REVIEW_PREFERENCES,
  reviewFileListDisplayFiles,
  reviewFileListReviewableFiles,
  reviewFileListSections,
  reviewFileListStats,
  reviewFileListToolbarModel,
  reviewAdjacentFilePath,
  reviewFileCommentPaths,
  reviewFileRowModel,
  reviewAdjacentUnreviewedFilePath,
  reviewMarkReviewedAndNavigateIntent,
  reviewStatusChangesForFiles,
  reviewUnreviewedFilePaths,
  transitionReviewState,
  type ReviewCatalog,
  type ReviewFile,
} from '../src/lib/review-model'

function file(input: Omit<ReviewFile, 'diff'>): ReviewFile {
  return { ...input, diff: { hunks: [] } }
}

const catalog: ReviewCatalog = {
  'Patchset 2': [
    file({ added: 2, kind: 'modified', path: 'src/review.ts', removed: 1 }),
    file({ added: 1, kind: 'added', path: 'docs/review.md', removed: 0 }),
  ],
}

function state() {
  return createReviewState({
    catalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 2' },
    preferences: DEFAULT_REVIEW_PREFERENCES,
    reviewedPathsByPatchset: { 'Patchset 2': ['docs/review.md'] },
  })
}

test('derives Gerrit-style file row review controls from one state source', () => {
  const reviewState = state()
  assert.deepEqual(reviewFileRowModel(reviewState, catalog['Patchset 2'][0]), {
    action: { ariaLabel: 'Mark as reviewed', disabled: false, label: 'MARK REVIEWED', nextReviewed: true, visibility: 'on-row-interaction' },
    added: 2,
    binary: false,
    changeLabel: 'M',
    commentPaths: ['src/review.ts'],
    deleted: 1,
    diffLoadPending: false,
    diffStatus: 'loaded',
    diffTooExpensive: false,
    expanded: false,
    path: 'src/review.ts',
    pending: false,
    reviewed: false,
    reviewStatusLoaded: true,
    reviewedLabel: null,
  })
  assert.deepEqual(reviewFileRowModel(reviewState, catalog['Patchset 2'][1], { mutationPending: true }), {
    action: { ariaLabel: 'Mark as unreviewed', disabled: true, label: 'MARK UNREVIEWED', nextReviewed: false, visibility: 'on-row-interaction' },
    added: 1,
    binary: false,
    changeLabel: 'A',
    commentPaths: ['docs/review.md'],
    deleted: 0,
    diffLoadPending: false,
    diffStatus: 'loaded',
    diffTooExpensive: false,
    expanded: false,
    path: 'docs/review.md',
    pending: false,
    reviewed: true,
    reviewStatusLoaded: true,
    reviewedLabel: 'Reviewed',
  })
})

test('file row model preserves Gerrit-style file metadata', () => {
  const reviewState = state()
  const copiedBinary = file({
    added: 0,
    binary: true,
    diffTooExpensive: true,
    kind: 'copied',
    newMode: '100755',
    newSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    oldMode: '100644',
    oldSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    path: 'assets/logo.png',
    previousPath: 'assets/old-logo.png',
    removed: 0,
    size: 2048,
    sizeDelta: 512,
    status: 'C',
  })
  assert.deepEqual(reviewFileRowModel(reviewState, copiedBinary), {
    action: { ariaLabel: 'Mark as reviewed', disabled: false, label: 'MARK REVIEWED', nextReviewed: true, visibility: 'on-row-interaction' },
    added: 0,
    binary: true,
    changeLabel: 'C',
    commentPaths: ['assets/logo.png', 'assets/old-logo.png'],
    deleted: 0,
    diffLoadPending: false,
    diffStatus: 'binary',
    diffTooExpensive: true,
    expanded: false,
    newMode: '100755',
    newSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    oldMode: '100644',
    oldSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    path: 'assets/logo.png',
    pending: false,
    previousPath: 'assets/old-logo.png',
    reviewed: false,
    reviewStatusLoaded: true,
    reviewedLabel: null,
    size: 2048,
    sizeDelta: 512,
  })
})

test('file row model exposes lazy diff loading status explicitly', () => {
  const reviewState = state()
  assert.equal(reviewFileRowModel(reviewState, file({
    added: 1,
    diffLoaded: false,
    kind: 'modified',
    path: 'src/lazy.ts',
    removed: 1,
  })).diffStatus, 'not-loaded')
  assert.equal(reviewFileRowModel(reviewState, file({
    added: 1,
    diffLoaded: true,
    kind: 'modified',
    path: 'src/loaded.ts',
    removed: 1,
  })).diffStatus, 'loaded')
  assert.equal(reviewFileRowModel(reviewState, file({
    added: 0,
    diffLoaded: false,
    diffTooExpensive: true,
    kind: 'modified',
    path: 'src/huge.ts',
    removed: 0,
  })).diffStatus, 'too-expensive')
  assert.deepEqual(reviewFileRowModel(reviewState, {
    added: 0,
    diff: { hunks: [], truncated: true },
    diffLoaded: false,
    kind: 'modified',
    path: 'src/truncated.ts',
    removed: 0,
  }), {
    action: { ariaLabel: 'Mark as reviewed', disabled: false, label: 'MARK REVIEWED', nextReviewed: true, visibility: 'on-row-interaction' },
    added: 0,
    binary: false,
    changeLabel: 'M',
    commentPaths: ['src/truncated.ts'],
    deleted: 0,
    diffLoadPending: false,
    diffStatus: 'too-expensive',
    diffTooExpensive: true,
    expanded: false,
    path: 'src/truncated.ts',
    pending: false,
    reviewed: false,
    reviewStatusLoaded: true,
    reviewedLabel: null,
  })
})

test('file row model exposes lazy diff pending and failure state', () => {
  const lazyCatalog: ReviewCatalog = {
    'Patchset 2': [
      file({ added: 1, diffLoaded: false, kind: 'modified', path: 'src/lazy.ts', removed: 1 }),
    ],
  }
  const initial = createReviewState({
    catalog: lazyCatalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 2' },
    preferences: DEFAULT_REVIEW_PREFERENCES,
    reviewedPathsByPatchset: { 'Patchset 2': [] },
  })
  const loading = transitionReviewState(initial, { path: 'src/lazy.ts', type: 'toggle-file-expanded' }, lazyCatalog).state
  assert.deepEqual(reviewFileRowModel(loading, lazyCatalog['Patchset 2'][0]), {
    action: { ariaLabel: 'Mark as unreviewed', disabled: false, label: 'MARK UNREVIEWED', nextReviewed: false, visibility: 'on-row-interaction' },
    added: 1,
    binary: false,
    changeLabel: 'M',
    commentPaths: ['src/lazy.ts'],
    deleted: 1,
    diffLoadPending: true,
    diffStatus: 'not-loaded',
    diffTooExpensive: false,
    expanded: true,
    path: 'src/lazy.ts',
    pending: true,
    reviewed: true,
    reviewStatusLoaded: true,
    reviewedLabel: 'Reviewed',
  })

  const failed = transitionReviewState(loading, {
    error: 'network failed',
    patchset: 'Patchset 2',
    path: 'src/lazy.ts',
    type: 'fail-file-diff-load',
  }, lazyCatalog).state
  assert.deepEqual(reviewFileRowModel(failed, lazyCatalog['Patchset 2'][0]), {
    action: { ariaLabel: 'Mark as unreviewed', disabled: false, label: 'MARK UNREVIEWED', nextReviewed: false, visibility: 'on-row-interaction' },
    added: 1,
    binary: false,
    changeLabel: 'M',
    commentPaths: ['src/lazy.ts'],
    deleted: 1,
    diffLoadError: 'network failed',
    diffLoadPending: false,
    diffStatus: 'not-loaded',
    diffTooExpensive: false,
    expanded: true,
    path: 'src/lazy.ts',
    pending: true,
    reviewed: true,
    reviewStatusLoaded: true,
    reviewedLabel: 'Reviewed',
  })
})

test('file row model tracks optimistic pending state and multi-file UI status changes', () => {
  const pending = transitionReviewState(state(), {
    path: 'src/review.ts',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog).state

  const row = reviewFileRowModel(pending, catalog['Patchset 2'][0])
  assert.equal(row.pending, true)
  assert.equal(row.reviewed, true)
  assert.notEqual(row.action, null)
  if (!row.action) throw new Error('expected loaded review action')
  assert.equal(row.action.label, 'MARK UNREVIEWED')
  assert.deepEqual(reviewStatusChangesForFiles(pending, catalog['Patchset 2'], true), [])
  assert.deepEqual(reviewStatusChangesForFiles(pending, catalog['Patchset 2'], false), [
    { path: 'src/review.ts', reviewed: false },
    { path: 'docs/review.md', reviewed: false },
  ])
})

test('derives Gerrit-style mark-all review toolbar actions', () => {
  const reviewState = state()
  assert.deepEqual(reviewFileListToolbarModel(reviewState, catalog['Patchset 2']), {
    markAllReviewed: {
      changes: [{ path: 'src/review.ts', reviewed: true }],
      disabled: false,
      label: 'MARK ALL REVIEWED',
    },
    markAllUnreviewed: {
      changes: [{ path: 'docs/review.md', reviewed: false }],
      disabled: false,
      label: 'MARK ALL UNREVIEWED',
    },
    reviewedStatusLoaded: true,
    reviewableCount: 2,
  })

  const pending = transitionReviewState(reviewState, {
    path: 'src/review.ts',
    reviewed: true,
    type: 'set-file-reviewed',
  }, catalog).state
  const pendingToolbar = reviewFileListToolbarModel(pending, catalog['Patchset 2'], { mutationPending: true })
  assert.equal(pendingToolbar.markAllReviewed.disabled, true)
  assert.equal(pendingToolbar.markAllUnreviewed.disabled, true)
})

test('derives Gerrit-style file list display and unreviewed navigation order', () => {
  const files = [
    file({ added: 0, kind: 'unmodified', path: 'src/commented.ts', removed: 0, status: 'U' }),
    file({ added: 1, kind: 'modified', path: 'src/review.ts', removed: 1, status: 'M' }),
    file({ added: 0, binary: true, kind: 'modified', path: 'assets/logo.png', removed: 0, status: 'M' }),
    file({ added: 2, kind: 'added', path: 'docs/new.md', removed: 0, status: 'A' }),
    file({ added: 0, diffLoaded: false, diffTooExpensive: true, kind: 'modified', path: 'src/huge.ts', removed: 0, status: 'M' }),
    file({ added: 0, kind: 'unmodified', path: 'src/check-result.ts', removed: 0 }),
  ]
  const sections = reviewFileListSections(files)
  assert.equal(sections.showUnmodifiedSeparator, true)
  assert.deepEqual(sections.modifiedFiles.map(file => file.path), [
    'src/review.ts',
    'assets/logo.png',
    'docs/new.md',
    'src/huge.ts',
  ])
  assert.deepEqual(sections.unmodifiedFiles.map(file => file.path), [
    'src/commented.ts',
    'src/check-result.ts',
  ])
  const displayFiles = reviewFileListDisplayFiles(files)
  assert.deepEqual(displayFiles.map(file => file.path), [
    'src/review.ts',
    'assets/logo.png',
    'docs/new.md',
    'src/huge.ts',
    'src/commented.ts',
    'src/check-result.ts',
  ])
  assert.deepEqual(reviewFileListReviewableFiles(files).map(file => file.path), displayFiles.map(file => file.path))
  assert.equal(reviewAdjacentFilePath(files, 'src/review.ts'), 'assets/logo.png')
  assert.equal(reviewAdjacentFilePath(files, 'src/huge.ts'), 'src/commented.ts')
  assert.equal(reviewAdjacentFilePath(files, 'src/commented.ts', 'previous'), 'src/huge.ts')
  assert.equal(reviewAdjacentFilePath(files, 'src/check-result.ts'), null)
  assert.equal(reviewAdjacentFilePath(files, 'missing.ts'), null)
  assert.deepEqual(reviewFileCommentPaths(file({
    added: 1,
    kind: 'renamed',
    path: 'src/current.ts',
    previousPath: 'src/previous.ts',
    removed: 1,
    status: 'R',
  })), ['src/current.ts', 'src/previous.ts'])
  assert.deepEqual(reviewFileCommentPaths(file({
    added: 1,
    kind: 'renamed',
    path: 'src/current.ts',
    previousPath: '../outside.ts',
    removed: 1,
    status: 'R',
  })), ['src/current.ts'])
  assert.deepEqual(files.map(file => file.path), [
    'src/commented.ts',
    'src/review.ts',
    'assets/logo.png',
    'docs/new.md',
    'src/huge.ts',
    'src/check-result.ts',
  ])
  assert.equal(reviewFileListSections(files.filter(file => file.kind !== 'unmodified')).showUnmodifiedSeparator, false)
  assert.equal(reviewFileListSections(files.filter(file => file.kind === 'unmodified')).showUnmodifiedSeparator, false)

  const localCatalog: ReviewCatalog = { 'Patchset 2': files }
  const unknownState = createReviewState({
    catalog: localCatalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 2' },
    preferences: DEFAULT_REVIEW_PREFERENCES,
  })
  assert.deepEqual(reviewUnreviewedFilePaths(unknownState, files), [])

  const loadedState = createReviewState({
    catalog: localCatalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 2' },
    preferences: DEFAULT_REVIEW_PREFERENCES,
    reviewedPathsByPatchset: { 'Patchset 2': ['src/review.ts'] },
  })
  assert.deepEqual(reviewStatusChangesForFiles(loadedState, files, true), [
    { path: 'assets/logo.png', reviewed: true },
    { path: 'docs/new.md', reviewed: true },
    { path: 'src/huge.ts', reviewed: true },
    { path: 'src/commented.ts', reviewed: true },
    { path: 'src/check-result.ts', reviewed: true },
  ])
  assert.equal(reviewFileListToolbarModel(loadedState, files).reviewableCount, 6)
  assert.deepEqual(reviewUnreviewedFilePaths(loadedState, files), [
    'assets/logo.png',
    'docs/new.md',
    'src/huge.ts',
    'src/commented.ts',
    'src/check-result.ts',
  ])
  assert.deepEqual(reviewUnreviewedFilePaths(loadedState, files, { currentPath: 'src/review.ts' }), [
    'src/review.ts',
    'assets/logo.png',
    'docs/new.md',
    'src/huge.ts',
    'src/commented.ts',
    'src/check-result.ts',
  ])
  assert.equal(reviewAdjacentUnreviewedFilePath(loadedState, files, 'src/review.ts'), 'assets/logo.png')
  assert.equal(reviewAdjacentUnreviewedFilePath(loadedState, files, 'src/commented.ts'), 'src/check-result.ts')
  assert.equal(reviewAdjacentUnreviewedFilePath(loadedState, files, 'src/commented.ts', 'previous'), 'src/huge.ts')
  assert.equal(reviewAdjacentUnreviewedFilePath(loadedState, files, 'src/check-result.ts'), null)
  assert.equal(reviewAdjacentUnreviewedFilePath(loadedState, files, 'missing.ts'), null)
  assert.deepEqual(reviewMarkReviewedAndNavigateIntent(loadedState, files, 'docs/new.md'), {
    changes: [{ path: 'docs/new.md', reviewed: true }],
    mutationPending: false,
    nextPath: 'src/huge.ts',
    reviewedStatusLoaded: true,
  })
  assert.deepEqual(reviewMarkReviewedAndNavigateIntent(loadedState, files, 'src/review.ts'), {
    changes: [],
    mutationPending: false,
    nextPath: null,
    reviewedStatusLoaded: true,
  })
  assert.deepEqual(reviewMarkReviewedAndNavigateIntent(loadedState, files, 'missing.ts'), {
    changes: [],
    mutationPending: false,
    nextPath: null,
    reviewedStatusLoaded: true,
  })
  assert.deepEqual(reviewMarkReviewedAndNavigateIntent(unknownState, files, 'src/review.ts'), {
    changes: [],
    mutationPending: false,
    nextPath: null,
    reviewedStatusLoaded: false,
  })
  const pendingState = transitionReviewState(loadedState, {
    path: 'docs/new.md',
    reviewed: true,
    type: 'set-file-reviewed',
  }, localCatalog).state
  assert.deepEqual(reviewMarkReviewedAndNavigateIntent(pendingState, files, 'assets/logo.png'), {
    changes: [],
    mutationPending: true,
    nextPath: null,
    reviewedStatusLoaded: true,
  })
})

test('derives Gerrit-style file list stats without mixing magic paths and binary byte totals', () => {
  const files = [
    file({ added: 10, kind: 'modified', path: 'src/review.ts', removed: 2 }),
    file({ added: 3, kind: 'modified', path: 'src/small.ts', removed: 8 }),
    file({ added: 0, binary: true, kind: 'modified', path: 'assets/new-logo.png', removed: 0, size: 4000, sizeDelta: 1200 }),
    file({ added: 0, binary: true, kind: 'deleted', path: 'assets/old-logo.png', removed: 0, size: 2000, sizeDelta: -700 }),
    file({ added: 99, kind: 'modified', path: '/COMMIT_MSG', removed: 88, status: 'M' }),
    file({ added: 77, kind: 'modified', path: '/MERGE_LIST', removed: 66, status: 'M' }),
  ]
  assert.deepEqual(reviewFileListStats(files), {
    additions: 13,
    binarySizeDeltaDeleted: -700,
    binarySizeDeltaInserted: 1200,
    binaryTotalSize: 6000,
    deletions: 10,
    maxAdded: 10,
    maxDeleted: 8,
  })
})

test('file row model keeps reviewed controls unknown until reviewed files are loaded', () => {
  const unknownState = createReviewState({
    catalog,
    patchRange: { basePatchset: 'Base', patchset: 'Patchset 2' },
    preferences: DEFAULT_REVIEW_PREFERENCES,
  })
  assert.deepEqual(reviewFileRowModel(unknownState, catalog['Patchset 2'][0]), {
    action: null,
    added: 2,
    binary: false,
    changeLabel: 'M',
    commentPaths: ['src/review.ts'],
    deleted: 1,
    diffLoadPending: false,
    diffStatus: 'loaded',
    diffTooExpensive: false,
    expanded: false,
    path: 'src/review.ts',
    pending: false,
    reviewed: null,
    reviewStatusLoaded: false,
    reviewedLabel: null,
  })
  assert.deepEqual(reviewStatusChangesForFiles(unknownState, catalog['Patchset 2'], true), [])
  assert.deepEqual(reviewFileListToolbarModel(unknownState, catalog['Patchset 2']), {
    markAllReviewed: {
      changes: [],
      disabled: true,
      label: 'MARK ALL REVIEWED',
    },
    markAllUnreviewed: {
      changes: [],
      disabled: true,
      label: 'MARK ALL UNREVIEWED',
    },
    reviewedStatusLoaded: false,
    reviewableCount: 2,
  })
})
