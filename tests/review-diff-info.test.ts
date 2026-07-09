import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isGerritChangeType,
  reviewIntralineRangesFromGerrit,
  reviewDiffRowsFromGerritContent,
  reviewFileFromGerritFileAndDiffInfo,
  reviewFileFromGerritDiffInfo,
  reviewKindFromGerritChangeType,
  reviewStatusFromGerritChangeType,
} from '../src/lib/review-model'

test('maps Gerrit change types to review kinds and status codes', () => {
  assert.equal(isGerritChangeType('ADDED'), true)
  assert.equal(isGerritChangeType('REWRITE'), true)
  assert.equal(isGerritChangeType('UNKNOWN'), false)
  assert.equal(isGerritChangeType(undefined), false)
  assert.equal(reviewKindFromGerritChangeType('ADDED'), 'added')
  assert.equal(reviewKindFromGerritChangeType('COPIED'), 'copied')
  assert.equal(reviewKindFromGerritChangeType('DELETED'), 'deleted')
  assert.equal(reviewKindFromGerritChangeType('MODIFIED'), 'modified')
  assert.equal(reviewKindFromGerritChangeType('RENAMED'), 'renamed')
  assert.equal(reviewKindFromGerritChangeType('REWRITE'), 'rewritten')
  assert.equal(reviewKindFromGerritChangeType('UNKNOWN'), 'modified')
  assert.equal(reviewStatusFromGerritChangeType('ADDED'), 'A')
  assert.equal(reviewStatusFromGerritChangeType('COPIED'), 'C')
  assert.equal(reviewStatusFromGerritChangeType('DELETED'), 'D')
  assert.equal(reviewStatusFromGerritChangeType('MODIFIED'), 'M')
  assert.equal(reviewStatusFromGerritChangeType('RENAMED'), 'R')
  assert.equal(reviewStatusFromGerritChangeType('REWRITE'), 'W')
  assert.equal(reviewStatusFromGerritChangeType('UNKNOWN'), 'M')
})

test('normalizes Gerrit intraline edits across lines', () => {
  assert.deepEqual(reviewIntralineRangesFromGerrit([
    '      <section class="summary">',
    '        <gr-formatted-text content="' +
      '[[_computeCurrentRevisionMessage(change)]]"></gr-formatted-text>',
    '      </section>',
  ], [
    [31, 34],
    [42, 26],
  ]), [
    [],
    [{ start: 0, end: 33 }, { start: 75, end: 100 }],
    [],
  ])
})

test('combines Gerrit FileInfo statistics with Gerrit DiffInfo content', () => {
  assert.deepEqual(reviewFileFromGerritFileAndDiffInfo('src/new.ts', {
    lines_deleted: 20,
    lines_inserted: 12,
    old_path: 'src/old.ts',
    status: 'R',
  }, {
    change_type: 'RENAMED',
    content: [
      { ab: ['same'] },
      { a: ['old'], b: ['new'] },
    ],
    diff_header: [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 91%',
      'rename from src/old.ts',
      'rename to src/new.ts',
    ],
    intraline_status: 'OK',
  }), {
    added: 12,
    diff: {
      diffHeader: [
        'diff --git a/src/old.ts b/src/new.ts',
        'similarity index 91%',
        'rename from src/old.ts',
        'rename to src/new.ts',
      ],
      hunks: [{
        header: '@@ -1,2 +1,2 @@',
        newLines: 2,
        newStart: 1,
        oldLines: 2,
        oldStart: 1,
        rows: [
          { kind: 'context', left: { line: 1, text: 'same' }, right: { line: 1, text: 'same' } },
          { kind: 'changed', left: { line: 2, text: 'old' }, right: { line: 2, text: 'new' } },
        ],
      }],
      intralineStatus: 'OK',
    },
    diffLoaded: true,
    kind: 'renamed',
    path: 'src/new.ts',
    previousPath: 'src/old.ts',
    removed: 20,
    status: 'R',
  })
})

test('does not let missing Gerrit FileInfo defaults override DiffInfo facts', () => {
  assert.deepEqual(reviewFileFromGerritFileAndDiffInfo('src/new.ts', {
    old_sha: '0000000',
  }, {
    change_type: 'ADDED',
    content: [
      { b: ['one', 'two'] },
    ],
    intraline_status: 'OK',
  }), {
    added: 2,
    diff: {
      hunks: [{
        header: '@@ -0,0 +1,2 @@',
        newLines: 2,
        newStart: 1,
        oldLines: 0,
        oldStart: 0,
        rows: [
          { kind: 'added', right: { line: 1, text: 'one' } },
          { kind: 'added', right: { line: 2, text: 'two' } },
        ],
      }],
      intralineStatus: 'OK',
    },
    diffLoaded: true,
    kind: 'added',
    oldSha: '0000000',
    path: 'src/new.ts',
    removed: 0,
    status: 'A',
  })

  assert.deepEqual(reviewFileFromGerritFileAndDiffInfo('src/new.ts', {
    lines_inserted: 7,
    lines_deleted: 3,
  }, {
    change_type: 'ADDED',
    content: [
      { b: ['one', 'two'] },
    ],
  }), {
    added: 7,
    diff: {
      hunks: [{
        header: '@@ -0,0 +1,2 @@',
        newLines: 2,
        newStart: 1,
        oldLines: 0,
        oldStart: 0,
        rows: [
          { kind: 'added', right: { line: 1, text: 'one' } },
          { kind: 'added', right: { line: 2, text: 'two' } },
        ],
      }],
    },
    diffLoaded: true,
    kind: 'added',
    path: 'src/new.ts',
    removed: 3,
    status: 'A',
  })
})

test('does not let invalid Gerrit FileInfo status override DiffInfo facts', () => {
  assert.deepEqual(reviewFileFromGerritFileAndDiffInfo('src/new.ts', {
    status: 'Z',
  }, {
    change_type: 'ADDED',
    content: [
      { b: ['one'] },
    ],
  }), {
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -0,0 +1,1 @@',
        newLines: 1,
        newStart: 1,
        oldLines: 0,
        oldStart: 0,
        rows: [
          { kind: 'added', right: { line: 1, text: 'one' } },
        ],
      }],
    },
    diffLoaded: true,
    kind: 'added',
    path: 'src/new.ts',
    removed: 0,
    status: 'A',
  })
})

test('uses unified-diff zero side ranges for added and deleted Gerrit DiffInfo files', () => {
  assert.deepEqual(reviewFileFromGerritDiffInfo('src/added.ts', {
    change_type: 'ADDED',
    content: [{ b: ['one', 'two'] }],
  }).diff.hunks[0], {
    header: '@@ -0,0 +1,2 @@',
    newLines: 2,
    newStart: 1,
    oldLines: 0,
    oldStart: 0,
    rows: [
      { kind: 'added', right: { line: 1, text: 'one' } },
      { kind: 'added', right: { line: 2, text: 'two' } },
    ],
  })

  assert.deepEqual(reviewFileFromGerritDiffInfo('src/deleted.ts', {
    change_type: 'DELETED',
    content: [{ a: ['gone'] }],
  }).diff.hunks[0], {
    header: '@@ -1,1 +0,0 @@',
    newLines: 0,
    newStart: 0,
    oldLines: 1,
    oldStart: 1,
    rows: [
      { kind: 'deleted', left: { line: 1, text: 'gone' } },
    ],
  })
})

test('normalizes Gerrit DiffInfo binary flag strictly', () => {
  assert.deepEqual(reviewFileFromGerritDiffInfo('assets/logo.png', {
    binary: 'true',
    change_type: 'MODIFIED',
    content: [],
  }), {
    added: 0,
    diff: { hunks: [] },
    diffLoaded: true,
    kind: 'modified',
    path: 'assets/logo.png',
    removed: 0,
    status: 'M',
  })
})

test('converts Gerrit DiffContent chunks into Farming diff rows', () => {
  assert.deepEqual(reviewDiffRowsFromGerritContent([
    { ab: ['before'] },
    {
      a: ['oldValue'],
      b: ['newValue'],
      due_to_rebase: true,
      edit_a: [[3, 5]],
      edit_b: [[3, 5]],
      move_details: { changed: true, range: { start: 20, end: 24 } },
    },
    { skip: { left: 3, right: 4 } },
    { a: ['x '], b: ['x'], common: true },
    { b: ['added only'] },
    { a: ['invalid move'], move_details: { changed: false, range: { start: 8, end: 7 } } },
  ]), [
    { kind: 'context', left: { line: 1, text: 'before' }, right: { line: 1, text: 'before' } },
    {
      dueToRebase: true,
      kind: 'changed',
      left: { intraline: [{ start: 3, end: 8 }], line: 2, text: 'oldValue' },
      moveDetails: { changed: true, range: { start: 20, end: 24 } },
      right: { intraline: [{ start: 3, end: 8 }], line: 2, text: 'newValue' },
    },
    { kind: 'skipped', leftLines: 3, rightLines: 4 },
    { kind: 'changed', left: { line: 6, text: 'x ' }, right: { line: 7, text: 'x' }, whitespaceOnly: true },
    { kind: 'added', right: { line: 8, text: 'added only' } },
    { kind: 'deleted', left: { line: 7, text: 'invalid move' }, moveDetails: { changed: false } },
  ])
})

test('normalizes malformed Gerrit DiffInfo content before building rows', () => {
  assert.deepEqual(reviewDiffRowsFromGerritContent(undefined), [])
  assert.deepEqual(reviewDiffRowsFromGerritContent([
    null,
    'ignored',
    { a: ['old'], b: ['new'], common: 'true', due_to_rebase: 'true' },
    { a: ['old whitespace'], b: ['new whitespace'], common: true, due_to_rebase: true },
  ]), [
    { kind: 'changed', left: { line: 1, text: 'old' }, right: { line: 1, text: 'new' } },
    { dueToRebase: true, kind: 'changed', left: { line: 2, text: 'old whitespace' }, right: { line: 2, text: 'new whitespace' }, whitespaceOnly: true },
  ])
})

test('treats missing Gerrit DiffInfo content as an empty loaded diff', () => {
  assert.deepEqual(reviewFileFromGerritDiffInfo('src/review.ts', {
    change_type: 'MODIFIED',
  }), {
    added: 0,
    diff: { hunks: [] },
    diffLoaded: true,
    kind: 'modified',
    path: 'src/review.ts',
    removed: 0,
    status: 'M',
  })
})

test('rejects malformed Gerrit DiffInfo objects before building review files', () => {
  assert.throws(
    () => reviewFileFromGerritDiffInfo('src/review.ts', null),
    /invalid Gerrit DiffInfo/
  )
  assert.throws(
    () => reviewFileFromGerritDiffInfo('src/review.ts', []),
    /invalid Gerrit DiffInfo/
  )
  assert.throws(
    () => reviewFileFromGerritFileAndDiffInfo('src/review.ts', {}, null),
    /invalid Gerrit DiffInfo/
  )
})

test('builds a review file from Gerrit DiffInfo', () => {
  assert.deepEqual(reviewFileFromGerritDiffInfo('src/review.ts', {
    change_type: 'RENAMED',
    content: [
      { ab: ['same'] },
      { a: ['old'], b: ['new'] },
    ],
    intraline_status: 'OK',
  }, {
    added: 1,
    previousPath: 'src/old-review.ts',
    removed: 1,
  }), {
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -1,2 +1,2 @@',
        newLines: 2,
        newStart: 1,
        oldLines: 2,
        oldStart: 1,
        rows: [
          { kind: 'context', left: { line: 1, text: 'same' }, right: { line: 1, text: 'same' } },
          { kind: 'changed', left: { line: 2, text: 'old' }, right: { line: 2, text: 'new' } },
        ],
      }],
      intralineStatus: 'OK',
    },
    diffLoaded: true,
    kind: 'renamed',
    path: 'src/review.ts',
    previousPath: 'src/old-review.ts',
    removed: 1,
    status: 'R',
  })
})

test('preserves Gerrit DiffInfo file metadata for future rendering surfaces', () => {
  assert.deepEqual(reviewFileFromGerritDiffInfo('src/review.ts', {
    change_type: 'MODIFIED',
    content: [],
    intraline_status: 'OK',
    meta_a: {
      content_type: 'text/x-typescript',
      language: 'typescript',
      lines: 120,
      name: 'old-review.ts',
      syntax_tree: [{
        children: [{ name: 'inner', range: { start_line: 3, start_column: 5, end_line: 4, end_column: 8 } }],
        name: 'outer',
        range: { start_line: 1, start_column: 1, end_line: 10, end_column: 2 },
      }, {
        name: '',
        range: { start_line: 1, start_column: 1, end_line: 1, end_column: 1 },
      }],
      web_links: [{ name: 'old', url: 'https://example.test/old' }, { name: '', url: 'https://example.test/ignored' }],
    },
    meta_b: {
      content_type: 'text/x-typescript',
      lines: 121,
      name: 'review.ts',
      web_links: [{ name: 'new', url: 'https://example.test/new' }],
    },
  }).diff, {
    hunks: [],
    intralineStatus: 'OK',
    leftMeta: {
      contentType: 'text/x-typescript',
      language: 'typescript',
      lines: 120,
      name: 'old-review.ts',
      syntaxTree: [{
        children: [{ name: 'inner', range: { startColumn: 5, startLine: 3, endColumn: 8, endLine: 4 } }],
        name: 'outer',
        range: { startColumn: 1, startLine: 1, endColumn: 2, endLine: 10 },
      }],
      webLinks: [{ name: 'old', url: 'https://example.test/old' }],
    },
    rightMeta: {
      contentType: 'text/x-typescript',
      lines: 121,
      name: 'review.ts',
      webLinks: [{ name: 'new', url: 'https://example.test/new' }],
    },
  })
})

test('normalizes malformed Gerrit DiffInfo auxiliary metadata before it enters ReviewFile', () => {
  assert.deepEqual(reviewFileFromGerritDiffInfo('src/review.ts', {
    change_type: 'MODIFIED',
    content: [],
    diff_header: ['valid header', 42],
    intraline_status: 'OKAY',
    meta_a: {
      content_type: 'text/plain',
      lines: '12',
      name: 'old.txt',
    },
    meta_b: {
      content_type: 'text/plain',
      lines: 12,
      name: 123,
    },
  }).diff, {
    hunks: [],
  })
})

test('does not count Gerrit whitespace-only common rows as insertions or deletions', () => {
  assert.deepEqual(reviewFileFromGerritDiffInfo('src/review.ts', {
    change_type: 'MODIFIED',
    content: [
      { a: ['x '], b: ['x'], common: true },
      { a: ['old'], b: ['new'] },
    ],
  }), {
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -1,2 +1,2 @@',
        newLines: 2,
        newStart: 1,
        oldLines: 2,
        oldStart: 1,
        rows: [
          { kind: 'changed', left: { line: 1, text: 'x ' }, right: { line: 1, text: 'x' }, whitespaceOnly: true },
          { kind: 'changed', left: { line: 2, text: 'old' }, right: { line: 2, text: 'new' } },
        ],
      }],
    },
    diffLoaded: true,
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
    status: 'M',
  })

  assert.deepEqual(reviewFileFromGerritFileAndDiffInfo('src/review.ts', {
    lines_deleted: 4,
    lines_inserted: 3,
  }, {
    change_type: 'MODIFIED',
    content: [{ a: ['x '], b: ['x'], common: true }],
  }), {
    added: 3,
    diff: {
      hunks: [{
        header: '@@ -1,1 +1,1 @@',
        newLines: 1,
        newStart: 1,
        oldLines: 1,
        oldStart: 1,
        rows: [
          { kind: 'changed', left: { line: 1, text: 'x ' }, right: { line: 1, text: 'x' }, whitespaceOnly: true },
        ],
      }],
    },
    diffLoaded: true,
    kind: 'modified',
    path: 'src/review.ts',
    removed: 4,
    status: 'M',
  })
})

test('preserves Gerrit intraline failure status without inventing ranges', () => {
  assert.equal(reviewFileFromGerritDiffInfo('src/review.ts', {
    change_type: 'MODIFIED',
    content: [
      { a: ['old'], b: ['new'] },
    ],
    intraline_status: 'Timeout',
  }).diff.intralineStatus, 'TIMEOUT')
  assert.equal(reviewFileFromGerritDiffInfo('src/review.ts', {
    change_type: 'MODIFIED',
    content: [
      { a: ['old'], b: ['new'] },
    ],
    intraline_status: 'Error',
  }).diff.intralineStatus, 'ERROR')
})

test('does not count Gerrit context or skipped rows as file insertions/deletions', () => {
  const file = reviewFileFromGerritDiffInfo('src/review.ts', {
    change_type: 'MODIFIED',
    content: [
      { ab: ['same before'] },
      { skip: 10 },
      { a: ['old'], b: ['new'] },
      { ab: ['same after'] },
    ],
    intraline_status: 'OK',
  })

  assert.equal(file.added, 1)
  assert.equal(file.removed, 1)
  assert.equal(file.diff.hunks[0]?.header, '@@ -1,13 +1,13 @@')
  assert.deepEqual(file.diff.hunks[0] && {
    newLines: file.diff.hunks[0].newLines,
    newStart: file.diff.hunks[0].newStart,
    oldLines: file.diff.hunks[0].oldLines,
    oldStart: file.diff.hunks[0].oldStart,
  }, {
    newLines: 13,
    newStart: 1,
    oldLines: 13,
    oldStart: 1,
  })
})
