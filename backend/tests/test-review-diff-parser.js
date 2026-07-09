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
    { kind: 'changed', left: { line: 11, text: 'return state.files;' }, right: { line: 11, text: 'return state.reviewedFiles;' } },
    { kind: 'added', right: { line: 12, text: '// keep the reviewed state server-backed' } },
    { kind: 'context', left: { line: 12, text: '}' }, right: { line: 13, text: '}' } },
  ],
}]);

console.log('test-review-diff-parser passed');
