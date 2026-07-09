import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareReviewFilePaths,
  isGerritReviewFileStatus,
  normalizeGerritFileInfo,
  reviewFileFromGerritFileInfo,
  reviewFilesFromGerritFileInfoMap,
  reviewKindFromGerritStatus,
} from '../src/lib/review-model'

test('normalizes Gerrit FileInfo defaults before building review files', () => {
  assert.deepEqual(normalizeGerritFileInfo({}, 'src/review.ts'), {
    lines_deleted: 0,
    lines_inserted: 0,
    path: 'src/review.ts',
    size: 0,
    size_delta: 0,
  })
  assert.deepEqual(normalizeGerritFileInfo({
    lines_deleted: -1,
    lines_inserted: 2,
    new_mode: 100755,
    old_mode: '100644',
    size: 2048,
    size_delta: -512,
  }, 'assets/logo.png'), {
    lines_deleted: 0,
    lines_inserted: 2,
    new_mode: '100755',
    old_mode: '100644',
    path: 'assets/logo.png',
    size: 2048,
    size_delta: -512,
  })
  assert.deepEqual(normalizeGerritFileInfo({
    new_mode: 755,
    old_mode: '100888',
  }, 'script.sh'), {
    lines_deleted: 0,
    lines_inserted: 0,
    new_mode: '000755',
    path: 'script.sh',
    size: 0,
    size_delta: 0,
  })
})

test('normalizes Gerrit FileInfo numeric and identity metadata strictly', () => {
  assert.deepEqual(normalizeGerritFileInfo({
    lines_deleted: '4',
    lines_inserted: 3.5,
    new_sha: 123,
    old_sha: '',
    size: -5,
    size_delta: '7',
  }, 'src/review.ts'), {
    lines_deleted: 0,
    lines_inserted: 0,
    path: 'src/review.ts',
    size: 0,
    size_delta: 0,
  })

  assert.deepEqual(reviewFileFromGerritFileInfo('src/new.ts', {
    lines_deleted: 1,
    lines_inserted: 2,
    new_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    old_path: 'src/old.ts',
    old_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }), {
    added: 2,
    diff: { hunks: [] },
    diffLoaded: false,
    kind: 'modified',
    newSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    oldSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    path: 'src/new.ts',
    previousPath: 'src/old.ts',
    removed: 1,
    status: 'M',
  })
})

test('rejects non-string Gerrit FileInfo old paths before they enter ReviewFile', () => {
  assert.throws(
    () => normalizeGerritFileInfo({ old_path: 123 }, 'src/new.ts'),
    /invalid previous review file path/
  )
})

test('rejects malformed Gerrit FileInfo objects before they enter ReviewFile', () => {
  assert.throws(
    () => normalizeGerritFileInfo(null, 'src/review.ts'),
    /invalid Gerrit FileInfo/
  )
  assert.throws(
    () => reviewFileFromGerritFileInfo('src/review.ts', []),
    /invalid Gerrit FileInfo/
  )
})

test('maps Gerrit file status codes onto Farming review file kinds', () => {
  assert.equal(isGerritReviewFileStatus('A'), true)
  assert.equal(isGerritReviewFileStatus('X'), true)
  assert.equal(isGerritReviewFileStatus('Z'), false)
  assert.equal(isGerritReviewFileStatus(undefined), false)
  assert.equal(reviewKindFromGerritStatus('A'), 'added')
  assert.equal(reviewKindFromGerritStatus('C'), 'copied')
  assert.equal(reviewKindFromGerritStatus('D'), 'deleted')
  assert.equal(reviewKindFromGerritStatus('R'), 'renamed')
  assert.equal(reviewKindFromGerritStatus('U'), 'unmodified')
  assert.equal(reviewKindFromGerritStatus('W'), 'rewritten')
  assert.equal(reviewKindFromGerritStatus('X'), 'reverted')
  assert.equal(reviewKindFromGerritStatus(undefined), 'modified')
})

test('normalizes unknown Gerrit file status before it enters ReviewFile', () => {
  assert.deepEqual(reviewFileFromGerritFileInfo('src/review.ts', {
    lines_deleted: 1,
    lines_inserted: 2,
    status: 'Z',
  }), {
    added: 2,
    diff: { hunks: [] },
    diffLoaded: false,
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
    status: 'M',
  })
})

test('builds review files from Gerrit FileInfo without losing binary or rename metadata', () => {
  assert.deepEqual(reviewFileFromGerritFileInfo('assets/logo.png', {
    binary: true,
    diffs_too_expensive_to_compute: true,
    new_mode: 100755,
    new_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    old_mode: 100644,
    old_path: 'assets/old-logo.png',
    old_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    size: 2048,
    size_delta: 512,
    status: 'C',
  }), {
    added: 0,
    binary: true,
    diff: { hunks: [], truncated: true },
    diffLoaded: false,
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
})

test('normalizes Gerrit FileInfo boolean flags strictly', () => {
  assert.deepEqual(reviewFileFromGerritFileInfo('assets/logo.png', {
    binary: 'true',
    diffs_too_expensive_to_compute: 'true',
    lines_deleted: 1,
    lines_inserted: 2,
  }), {
    added: 2,
    diff: { hunks: [] },
    diffLoaded: false,
    kind: 'modified',
    path: 'assets/logo.png',
    removed: 1,
    status: 'M',
  })
})

test('sorts Gerrit special files before normal paths', () => {
  assert.equal(compareReviewFilePaths('/COMMIT_MSG', 'src/review.ts') < 0, true)
  assert.deepEqual(reviewFilesFromGerritFileInfoMap({
    'src/review.ts': { lines_inserted: 2 },
    '/MERGE_LIST': { status: 'M' },
    '/COMMIT_MSG': { status: 'M' },
    'assets/logo.png': { binary: true, size_delta: 512 },
  }).map(file => file.path), [
    '/COMMIT_MSG',
    '/MERGE_LIST',
    'assets/logo.png',
    'src/review.ts',
  ])
})

test('rejects malformed Gerrit FileInfo maps before building review files', () => {
  assert.throws(
    () => reviewFilesFromGerritFileInfoMap(null),
    /invalid Gerrit FileInfo map/
  )
  assert.throws(
    () => reviewFilesFromGerritFileInfoMap([]),
    /invalid Gerrit FileInfo map/
  )
  assert.throws(
    () => reviewFilesFromGerritFileInfoMap({ 'src/review.ts': 'not an object' }),
    /invalid Gerrit FileInfo/
  )
})

test('rejects malformed Gerrit FileInfo paths before they enter the review model', () => {
  assert.deepEqual(normalizeGerritFileInfo({}, '/COMMIT_MSG'), {
    lines_deleted: 0,
    lines_inserted: 0,
    path: '/COMMIT_MSG',
    size: 0,
    size_delta: 0,
  })
  assert.throws(
    () => normalizeGerritFileInfo({}, '../outside.ts'),
    /invalid review file path/
  )
  assert.throws(
    () => reviewFileFromGerritFileInfo('src/new.ts', { old_path: '../old.ts', status: 'R' }),
    /invalid previous review file path/
  )
  assert.throws(
    () => reviewFilesFromGerritFileInfoMap({ '/absolute.ts': {} }),
    /invalid review file path/
  )
})

test('marks Gerrit FileInfo-only review files as diff metadata without inline rows', () => {
  const file = reviewFileFromGerritFileInfo('src/review.ts', { lines_inserted: 2, lines_deleted: 1 })
  assert.equal(file.diffLoaded, false)
  assert.deepEqual(file.diff, { hunks: [] })
})
