const assert = require('assert');
const { parseUnifiedDiffRows } = require('../workspace-file-service');

const rows = parseUnifiedDiffRows([
  'diff --git a/src/review.ts b/src/review.ts',
  '--- a/src/review.ts',
  '+++ b/src/review.ts',
  '@@ -10,3 +10,4 @@ export function review() {',
  ' const state = load();',
  '-return state.files;',
  '+return state.reviewedFiles;',
  '+// keep the reviewed state server-backed',
  ' }',
].join('\n'));

assert.deepStrictEqual(rows, [{
  header: '@@ -10,3 +10,4 @@ export function review() {',
  oldStart: 10,
  oldLines: 3,
  newStart: 10,
  newLines: 4,
  rows: [
    { kind: 'context', left: { line: 10, text: 'const state = load();' }, right: { line: 10, text: 'const state = load();' } },
    {
      kind: 'changed',
      left: { intraline: [{ start: 13, end: 14 }], line: 11, text: 'return state.files;' },
      right: {
        intraline: [{ start: 13, end: 16 }, { start: 17, end: 23 }],
        line: 11,
        text: 'return state.reviewedFiles;',
      },
    },
    { kind: 'added', right: { line: 12, text: '// keep the reviewed state server-backed' } },
    { kind: 'context', left: { line: 12, text: '}' }, right: { line: 13, text: '}' } },
  ],
}]);

const intralineRows = parseUnifiedDiffRows([
  'diff --git a/src/review.ts b/src/review.ts',
  '--- a/src/review.ts',
  '+++ b/src/review.ts',
  '@@ -8,1 +8,1 @@',
  '-const mode = oldValue;',
  '+const mode = newValue;',
].join('\n'));

assert.deepStrictEqual(intralineRows[0].rows, [{
  kind: 'changed',
  left: { intraline: [{ start: 13, end: 16 }], line: 8, text: 'const mode = oldValue;' },
  right: { intraline: [{ start: 13, end: 16 }], line: 8, text: 'const mode = newValue;' },
}]);

const newlineRows = parseUnifiedDiffRows([
  'diff --git a/OdpsLexer.g4 b/OdpsLexer.g4',
  '--- a/OdpsLexer.g4',
  '+++ b/OdpsLexer.g4',
  '@@ -839,1 +840,1 @@',
  '-;',
  '\\ No newline at end of file',
  '+;',
].join('\n'));

assert.deepStrictEqual(newlineRows[0].rows, [{
  kind: 'changed',
  left: { line: 839, missingNewlineAtEnd: true, text: ';' },
  right: { line: 840, text: ';' },
}]);

console.log('test-review-diff-parser passed');
