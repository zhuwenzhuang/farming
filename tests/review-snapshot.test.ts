import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commentsForFile,
  createReviewState,
  createReviewStateFromSnapshot,
  DEFAULT_REVIEW_PREFERENCES,
  normalizeReviewGitRevision,
  reviewCatalogFromSnapshot,
  reviewCatalogWithFile,
  reviewCatalogWithUnmodifiedPaths,
  reviewFileMapFromFiles,
  reviewFilesWithUnmodifiedPaths,
  reviewPatchRangeLabel,
  reviewSnapshotRequestFromLocation,
  acpReviewCaptureRequestFromSearch,
  reviewSnapshotRequestFromSearch,
  reviewSnapshotLabel,
  reviewSnapshotIdentity,
  reviewSnapshotFileRequestKey,
  reviewSnapshotPatchRequestKey,
  reviewSnapshotRange,
  reviewSnapshotRequestKey,
  reviewSnapshotRequestLabel,
  reviewSnapshotRequestSupportsFileDiff,
  reviewSnapshotRequestSupportsPatchText,
  reviewSnapshotStateKey,
  reviewStateForPatchset,
  type ReviewDiffSnapshot,
} from '../src/lib/review-model'

const snapshot: ReviewDiffSnapshot = {
  basePatchset: 'HEAD~1',
  files: [{
    added: 1,
    diff: { hunks: [] },
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
  }],
  isGitRepo: true,
  patchset: 'HEAD',
  reviewId: 'git-range-test',
  root: '/workspace',
  source: 'git-range',
  truncated: false,
}

test('turns a diff snapshot into reusable review catalog and state', () => {
  assert.deepEqual(reviewCatalogFromSnapshot(snapshot), { HEAD: snapshot.files })
  assert.deepEqual({ ...reviewFileMapFromFiles(snapshot.files) }, { 'src/review.ts': snapshot.files[0] })
  const state = createReviewStateFromSnapshot({
    preferences: DEFAULT_REVIEW_PREFERENCES,
    reviewedPaths: ['src/review.ts'],
    snapshot,
  })
  assert.equal(state.patchRange.basePatchset, 'HEAD~1')
  assert.equal(state.patchRange.patchset, 'HEAD')
  assert.equal(state.reviewId, 'git-range-test')
  assert.deepEqual(reviewStateForPatchset(state, 'HEAD').reviewedPaths, ['src/review.ts'])
  assert.equal(reviewSnapshotLabel(snapshot), 'HEAD~1 -> HEAD')
  assert.deepEqual(reviewSnapshotRange(snapshot), { basePatchset: 'HEAD~1', patchset: 'HEAD' })
  assert.deepEqual(reviewSnapshotIdentity(snapshot), {
    basePatchset: 'HEAD~1',
    patchset: 'HEAD',
    reviewId: 'git-range-test',
    root: '/workspace',
    source: 'git-range',
  })
  assert.equal(reviewSnapshotStateKey(snapshot), ['git-range', 'git-range-test', 'HEAD~1', 'HEAD'].join('\0'))
})

test('preserves Gerrit FileInfo-map semantics at snapshot model boundaries', () => {
  const duplicateSnapshot = {
    ...snapshot,
    files: [
      { added: 1, diff: { hunks: [] }, kind: 'modified' as const, path: 'src/review.ts', removed: 1 },
      { added: 2, diff: { hunks: [] }, kind: 'modified' as const, path: 'src/review.ts', removed: 0 },
    ],
  }

  assert.throws(
    () => reviewFileMapFromFiles(duplicateSnapshot.files),
    /duplicate review file path: src\/review\.ts/
  )
  assert.throws(
    () => reviewCatalogFromSnapshot(duplicateSnapshot),
    /duplicate review file path: src\/review\.ts/
  )
  assert.throws(
    () => createReviewStateFromSnapshot({
      preferences: DEFAULT_REVIEW_PREFERENCES,
      snapshot: duplicateSnapshot,
    }),
    /duplicate review file path: src\/review\.ts/
  )
})

test('keeps same-head commit comparisons isolated by review identity and base range', () => {
  const previousBase = {
    ...snapshot,
    basePatchset: 'HEAD~2',
    reviewId: 'git-range-previous-base',
  }
  const currentBase = {
    ...snapshot,
    basePatchset: 'HEAD~1',
    reviewId: 'git-range-current-base',
  }
  assert.equal(previousBase.patchset, currentBase.patchset)
  assert.notEqual(reviewSnapshotStateKey(previousBase), reviewSnapshotStateKey(currentBase))
  assert.equal(
    reviewSnapshotStateKey({ ...previousBase, root: '/workspace-symlink' }),
    reviewSnapshotStateKey(previousBase)
  )
  assert.notEqual(reviewSnapshotRequestKey({
    agentId: 'agent-1',
    base: 'HEAD~2',
    head: 'HEAD',
    source: 'git-range',
  }), reviewSnapshotRequestKey({
    agentId: 'agent-1',
    base: 'HEAD~1',
    head: 'HEAD',
    source: 'git-range',
  }))
})

test('hydrates one loaded file diff without replacing file-list metadata or changing order', () => {
  const catalog = reviewCatalogFromSnapshot({
    ...snapshot,
    files: [
      { added: 1, diff: { hunks: [] }, diffLoaded: false, kind: 'modified', path: 'src/a.ts', removed: 1 },
      {
        added: 2,
        diff: { hunks: [], truncated: true },
        diffLoaded: false,
        kind: 'modified',
        newMode: '100644',
        newSha: '2222222',
        oldMode: '100644',
        oldSha: '1111111',
        path: 'src/b.ts',
        previousPath: 'src/previous-b.ts',
        removed: 2,
        size: 2048,
        sizeDelta: 32,
        status: 'R',
      },
    ],
  })
  const loaded = {
    added: 99,
    binary: true,
    diff: { hunks: [{ header: '@@ -1,1 +1,1 @@', newLines: 1, newStart: 1, oldLines: 1, oldStart: 1, rows: [] }] },
    diffLoaded: true,
    diffTooExpensive: true,
    kind: 'deleted' as const,
    path: 'src/b.ts',
    previousPath: 'src/wrong-b.ts',
    removed: 88,
    status: 'D' as const,
    truncated: true,
  }
  assert.deepEqual(reviewCatalogWithFile(catalog, 'HEAD', loaded), {
    HEAD: [
      { added: 1, diff: { hunks: [] }, diffLoaded: false, kind: 'modified', path: 'src/a.ts', removed: 1 },
      {
        added: 2,
        binary: true,
        diff: { ...loaded.diff, truncated: true },
        diffLoaded: true,
        diffTooExpensive: true,
        kind: 'modified',
        newMode: '100644',
        newSha: '2222222',
        oldMode: '100644',
        oldSha: '1111111',
        path: 'src/b.ts',
        previousPath: 'src/previous-b.ts',
        removed: 2,
        size: 2048,
        sizeDelta: 32,
        status: 'R',
        truncated: true,
      },
    ],
  })
  assert.equal(reviewCatalogWithFile(catalog, 'HEAD', { ...loaded, path: 'src/c.ts' }), catalog)
})

test('adds Gerrit-style unmodified files for comments and check results without mutating the source catalog', () => {
  const files = [
    { added: 1, diff: { hunks: [] }, kind: 'modified' as const, path: 'src/review.ts', removed: 1, status: 'M' as const },
    { added: 2, diff: { hunks: [] }, kind: 'renamed' as const, path: 'src/new-name.ts', previousPath: 'src/old-name.ts', removed: 1, status: 'R' as const },
  ]
  const withUnmodified = reviewFilesWithUnmodifiedPaths(files, [
    'src/commented.ts',
    'src/old-name.ts',
    'src/review.ts',
    '../bad.ts',
    '/COMMIT_MSG',
  ])
  assert.deepEqual(withUnmodified.map(file => ({
    added: file.added,
    kind: file.kind,
    path: file.path,
    removed: file.removed,
    status: file.status,
  })), [
    { added: 0, kind: 'unmodified', path: '/COMMIT_MSG', removed: 0, status: 'U' },
    { added: 0, kind: 'unmodified', path: 'src/commented.ts', removed: 0, status: 'U' },
    { added: 2, kind: 'renamed', path: 'src/new-name.ts', removed: 1, status: 'R' },
    { added: 1, kind: 'modified', path: 'src/review.ts', removed: 1, status: 'M' },
  ])
  assert.deepEqual(files.map(file => file.path), ['src/review.ts', 'src/new-name.ts'])

  const catalog = { HEAD: files }
  const visibleCatalog = reviewCatalogWithUnmodifiedPaths(catalog, 'HEAD', ['src/commented.ts'])
  assert.notEqual(visibleCatalog, catalog)
  assert.deepEqual(visibleCatalog.HEAD.map(file => file.path), ['src/commented.ts', 'src/new-name.ts', 'src/review.ts'])
  assert.equal(reviewCatalogWithUnmodifiedPaths(catalog, 'Missing', ['src/commented.ts']), catalog)

  const state = createReviewState({
    catalog: visibleCatalog,
    comments: [{
      body: 'Comment on an unchanged file.',
      id: 'comment-unmodified',
      line: 3,
      patchset: 'HEAD',
      path: 'src/commented.ts',
      side: 'right',
    }],
    patchRange: { basePatchset: 'HEAD~1', patchset: 'HEAD' },
    preferences: DEFAULT_REVIEW_PREFERENCES,
    reviewedPathsByPatchset: { HEAD: [] },
  })
  assert.deepEqual(commentsForFile(state, 'src/commented.ts').map(comment => comment.body), ['Comment on an unchanged file.'])
})

test('labels working-copy snapshots without requiring callers to know patchset ids', () => {
  const workingCopy = { ...snapshot, basePatchset: undefined, patchset: 'Working copy abc', source: 'working-copy' as const }
  assert.equal(reviewSnapshotLabel(workingCopy), 'Working copy')
  assert.deepEqual(reviewSnapshotRange(workingCopy), { basePatchset: 'HEAD', patchset: 'Working copy abc' })
})

test('derives stable labels and keys from review snapshot requests', () => {
  const workingCopy = { agentId: 'agent-1', limit: 20, source: 'working-copy' as const }
  const gitRange = { agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', limit: 20, source: 'git-range' as const }
  assert.equal(reviewPatchRangeLabel({ basePatchset: 'Base', patchset: 'Patchset 20' }), 'Base -> Patchset 20')
  assert.equal(reviewSnapshotRequestLabel(workingCopy), 'Working copy')
  assert.equal(reviewSnapshotRequestLabel(gitRange), 'HEAD~1 -> HEAD')
  assert.equal(normalizeReviewGitRevision(' refs/heads/main '), 'refs/heads/main')
  assert.equal(normalizeReviewGitRevision('-bad'), undefined)
  assert.equal(normalizeReviewGitRevision('HEAD bad'), undefined)
  assert.equal(reviewSnapshotRequestKey(workingCopy), ['working-copy', 'agent-1', '20', 'full', '', 'NONE'].join('\0'))
  assert.equal(reviewSnapshotRequestKey(gitRange), ['git-range', 'agent-1', 'HEAD~1', 'HEAD', '20', 'full', '', 'NONE'].join('\0'))
  assert.equal(reviewSnapshotRequestLabel({ ...gitRange, base: ' HEAD~1 ', head: ' HEAD ' }), 'HEAD~1 -> HEAD')
  assert.equal(reviewSnapshotRequestKey({ ...gitRange, base: ' HEAD~1 ', head: ' HEAD ' }), reviewSnapshotRequestKey(gitRange))
  assert.equal(reviewSnapshotRequestKey({ ...workingCopy, metadataOnly: true }), ['working-copy', 'agent-1', '20', 'metadata', '', 'NONE'].join('\0'))
  assert.equal(reviewSnapshotRequestKey({ ...gitRange, metadataOnly: true }), ['git-range', 'agent-1', 'HEAD~1', 'HEAD', '20', 'metadata', '', 'NONE'].join('\0'))
  assert.equal(reviewSnapshotRequestKey({ ...workingCopy, context: 25, ignoreWhitespace: 'ALL' }), ['working-copy', 'agent-1', '20', 'full', '25', 'ALL'].join('\0'))
  assert.equal(
    reviewSnapshotRequestKey({ ...workingCopy, context: 25, ignoreWhitespace: 'ALL', metadataOnly: true }),
    reviewSnapshotRequestKey({ ...workingCopy, metadataOnly: true })
  )
  assert.equal(
    reviewSnapshotRequestKey({ ...gitRange, context: 25, ignoreWhitespace: 'ALL', metadataOnly: true }),
    reviewSnapshotRequestKey({ ...gitRange, metadataOnly: true })
  )
  assert.notEqual(
    reviewSnapshotRequestKey({ ...gitRange, base: 'HEAD~2' }),
    reviewSnapshotRequestKey(gitRange)
  )
  assert.equal(reviewSnapshotFileRequestKey(workingCopy, 'src/review.ts'), ['working-copy-file', 'agent-1', 'src/review.ts', '', 'NONE'].join('\0'))
  assert.equal(reviewSnapshotFileRequestKey({ ...gitRange, context: 10, ignoreWhitespace: 'TRAILING' }, 'src/review.ts'), ['git-range-file', 'agent-1', 'HEAD~1', 'HEAD', 'src/review.ts', '10', 'TRAILING'].join('\0'))
  assert.equal(reviewSnapshotFileRequestKey({ ...gitRange, base: ' HEAD~1 ', head: ' HEAD ' }, 'src/review.ts'), reviewSnapshotFileRequestKey(gitRange, 'src/review.ts'))
  assert.equal(
    reviewSnapshotFileRequestKey({ ...gitRange, context: -1, ignoreWhitespace: 'INVALID' as never }, 'src/review.ts'),
    reviewSnapshotFileRequestKey(gitRange, 'src/review.ts')
  )
  assert.equal(reviewSnapshotPatchRequestKey(workingCopy), ['working-copy-patch', 'agent-1', '20', '', 'NONE'].join('\0'))
  assert.equal(reviewSnapshotPatchRequestKey({ ...workingCopy, context: 25, ignoreWhitespace: 'ALL' }), ['working-copy-patch', 'agent-1', '20', '25', 'ALL'].join('\0'))
  assert.equal(reviewSnapshotPatchRequestKey({ ...workingCopy, context: 25, ignoreWhitespace: 'ALL', metadataOnly: true }), reviewSnapshotPatchRequestKey({ ...workingCopy, context: 25, ignoreWhitespace: 'ALL' }))
  assert.equal(reviewSnapshotPatchRequestKey({ ...gitRange, base: ' HEAD~1 ', head: ' HEAD ' }), reviewSnapshotPatchRequestKey(gitRange))
  assert.equal(
    reviewSnapshotPatchRequestKey({ ...workingCopy, context: 1.5, ignoreWhitespace: 'INVALID' as never }),
    reviewSnapshotPatchRequestKey(workingCopy)
  )
  assert.equal(
    reviewSnapshotRequestKey({ ...workingCopy, limit: 0 }),
    reviewSnapshotRequestKey({ agentId: 'agent-1', source: 'working-copy' })
  )
  assert.equal(
    reviewSnapshotRequestKey({ ...workingCopy, limit: Number.NaN }),
    reviewSnapshotRequestKey({ agentId: 'agent-1', source: 'working-copy' })
  )
  assert.equal(
    reviewSnapshotPatchRequestKey({ ...gitRange, limit: -1 }),
    reviewSnapshotPatchRequestKey({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' })
  )
  assert.equal(reviewSnapshotPatchRequestKey({ ...gitRange, context: 10, ignoreWhitespace: 'TRAILING' }), ['git-range-patch', 'agent-1', 'HEAD~1', 'HEAD', '20', '10', 'TRAILING'].join('\0'))
  assert.equal(
    reviewSnapshotRequestKey({ ...workingCopy, context: -1, ignoreWhitespace: 'INVALID' as never }),
    reviewSnapshotRequestKey(workingCopy)
  )
  assert.notEqual(
    reviewSnapshotPatchRequestKey({ ...gitRange, base: 'HEAD~2' }),
    reviewSnapshotPatchRequestKey(gitRange)
  )
  assert.equal(reviewSnapshotRequestSupportsFileDiff(workingCopy), true)
  assert.equal(reviewSnapshotRequestSupportsFileDiff(gitRange), true)
  assert.equal(reviewSnapshotRequestSupportsPatchText(workingCopy), true)
  assert.equal(reviewSnapshotRequestSupportsPatchText(gitRange), true)
})

test('derives review snapshot requests from route query parameters without page-specific fallback', () => {
  assert.deepEqual(acpReviewCaptureRequestFromSearch('?agentId=agent-1&acpItem=tool-1&acpItem=tool-2&acpItem=tool-1'), {
    agentId: 'agent-1',
    itemIds: ['tool-1', 'tool-2'],
  })
  assert.equal(acpReviewCaptureRequestFromSearch('?agentId=agent-1'), null)
  assert.equal(acpReviewCaptureRequestFromSearch('?acpItem=tool-1'), null)
  assert.deepEqual(reviewSnapshotRequestFromSearch(''), { request: null })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?agentId=agent-1'), {
    request: { agentId: 'agent-1', source: 'working-copy' },
  })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?root=%2Frepo&path=src%2Fa.ts&path=src%2Fb.ts'), {
    request: { root: '/repo', paths: ['src/a.ts', 'src/b.ts'], source: 'working-copy' },
  })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?root=%2Fworkspace%2Frepo&base=HEAD&head=now'), {
    request: { base: 'HEAD', head: 'now', root: '/workspace/repo', source: 'git-range' },
  })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?agentId=agent-1&root=%2Fworkspace%2Frepo'), {
    error: 'only one review workspace target is allowed',
    request: null,
  })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?agentId=agent-1&limit=20&context=0&ignoreWhitespace=IGNORE_ALL&metadataOnly=1'), {
    request: { agentId: 'agent-1', context: 0, ignoreWhitespace: 'ALL', limit: 20, metadataOnly: true, source: 'working-copy' },
  })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?agentId=agent-1&limit=0&context=-1&ignoreWhitespace=BAD&metadataOnly=false'), {
    request: { agentId: 'agent-1', source: 'working-copy' },
  })
  assert.deepEqual(reviewSnapshotRequestFromSearch(new URLSearchParams('agentId=%20agent-1%20')), {
    request: { agentId: 'agent-1', source: 'working-copy' },
  })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?agentId=agent-1&base=%20HEAD~1%20&head=%20HEAD%20'), {
    request: { agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' },
  })
  assert.deepEqual(reviewSnapshotRequestFromLocation({ search: '?agentId=agent-1&base=origin/main&head=refs/heads/topic&limit=2&context=10&ignoreWhitespace=IGNORE_TRAILING&metadataOnly=true' }), {
    request: { agentId: 'agent-1', base: 'origin/main', context: 10, head: 'refs/heads/topic', ignoreWhitespace: 'TRAILING', limit: 2, metadataOnly: true, source: 'git-range' },
  })
  assert.deepEqual(reviewSnapshotRequestFromLocation(null), { request: null })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?agentId=agent-1&base=HEAD~1'), {
    error: 'base and head revisions are invalid',
    request: null,
  })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?agentId=agent-1&head=HEAD'), {
    error: 'base and head revisions are invalid',
    request: null,
  })
  assert.deepEqual(reviewSnapshotRequestFromSearch('?agentId=agent-1&base=-bad&head=HEAD'), {
    error: 'base and head revisions are invalid',
    request: null,
  })
})
