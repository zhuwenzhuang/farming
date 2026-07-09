import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewFilesToPatchText } from '../src/lib/review/diff-text'
import type { ReviewFile } from '../src/lib/review/state'

test('serializes review files back to patch text', () => {
  const files: ReviewFile[] = [{
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -2,1 +2,1 @@',
        newLines: 1,
        newStart: 2,
        oldLines: 1,
        oldStart: 2,
        rows: [
          { kind: 'context', left: { line: 1, text: 'before();' }, right: { line: 1, text: 'before();' } },
          { kind: 'changed', left: { line: 2, text: 'return files;' }, right: { line: 2, text: 'return reviewedFiles;' } },
        ],
      }],
    },
    kind: 'renamed',
    path: 'src/new.ts',
    previousPath: 'src/old.ts',
    removed: 1,
  }]

  assert.equal(reviewFilesToPatchText(files), [
    'diff --git a/src/old.ts b/src/new.ts',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -2,1 +2,1 @@',
    ' before();',
    '-return files;',
    '+return reviewedFiles;',
  ].join('\n'))
})

test('serializes review files with source diff headers intact', () => {
  const files: ReviewFile[] = [{
    added: 0,
    diff: {
      diffHeader: [
        'diff --git a/src/old.ts b/src/new.ts',
        'similarity index 100%',
        'rename from src/old.ts',
        'rename to src/new.ts',
      ],
      hunks: [],
    },
    kind: 'renamed',
    path: 'src/new.ts',
    previousPath: 'src/old.ts',
    removed: 0,
  }, {
    added: 0,
    binary: true,
    diff: {
      diffHeader: [
        'diff --git a/assets/logo.png b/assets/logo.png',
        'index 1111111..2222222 100644',
        'Binary files a/assets/logo.png and b/assets/logo.png differ',
      ],
      hunks: [],
    },
    kind: 'modified',
    path: 'assets/logo.png',
    removed: 0,
  }]

  assert.equal(reviewFilesToPatchText(files), [
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 100%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    'diff --git a/assets/logo.png b/assets/logo.png',
    'index 1111111..2222222 100644',
    'Binary files a/assets/logo.png and b/assets/logo.png differ',
  ].join('\n'))
})

test('serializes fallback patch headers with mode and sha metadata', () => {
  const files: ReviewFile[] = [{
    added: 0,
    diff: { hunks: [] },
    kind: 'modified',
    newMode: '100755',
    newSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    oldMode: '100644',
    oldSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    path: 'scripts/run.sh',
    removed: 0,
  }, {
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -0,0 +1 @@',
        newLines: 1,
        newStart: 1,
        oldLines: 0,
        oldStart: 0,
        rows: [{ kind: 'added', right: { line: 1, text: '#!/usr/bin/env bash' } }],
      }],
    },
    kind: 'added',
    newMode: '100755',
    newSha: 'cccccccccccccccccccccccccccccccccccccccc',
    path: 'scripts/new.sh',
    removed: 0,
  }, {
    added: 0,
    diff: { hunks: [] },
    kind: 'deleted',
    oldMode: '100644',
    oldSha: 'dddddddddddddddddddddddddddddddddddddddd',
    path: 'scripts/old.sh',
    removed: 0,
  }]

  assert.equal(reviewFilesToPatchText(files), [
    'diff --git a/scripts/run.sh b/scripts/run.sh',
    'old mode 100644',
    'new mode 100755',
    'index aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'diff --git a/scripts/new.sh b/scripts/new.sh',
    'new file mode 100755',
    'index 0000000000000000000000000000000000000000..cccccccccccccccccccccccccccccccccccccccc',
    '--- /dev/null',
    '+++ b/scripts/new.sh',
    '@@ -0,0 +1 @@',
    '+#!/usr/bin/env bash',
    'diff --git a/scripts/old.sh b/scripts/old.sh',
    'deleted file mode 100644',
    'index dddddddddddddddddddddddddddddddddddddddd..0000000000000000000000000000000000000000',
  ].join('\n'))
})
