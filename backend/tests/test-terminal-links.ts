const assert = require('assert');
require('tsx/cjs');

async function run() {
  const {
    collectTerminalLinkMatches,
    collectTerminalMultiLinePathLinkMatches,
    collectTerminalPathLinkMatches,
    collectTerminalSearchLinkMatches,
    parseExplicitTerminalUrlAtColumn,
    parseTerminalPathTargetAtColumn,
    parseTerminalUrlAtColumn,
    terminalLinkMatchRange,
    terminalTextColumnAtPixelOffset,
    trimTerminalUrl,
  } = require('../../src/lib/terminal-links.ts');

  const reviewUrl = 'https://code.example.test/maxcompute/odps_src/codereview/28643213';
  const boxedLine = `remote: | ${reviewUrl} |`;
  const matches = collectTerminalLinkMatches(boxedLine, false);
  assert.deepStrictEqual(
    matches.filter(match => match.kind === 'url').map(match => match.text),
    [reviewUrl],
    'terminal link matcher should detect git remote code-review URLs inside boxed output'
  );
  assert.strictEqual(
    parseTerminalUrlAtColumn(boxedLine, boxedLine.indexOf('odps_src') + 3),
    reviewUrl,
    'terminal URL hit testing should keep underscores in code-review paths'
  );
  const filenameThatLooksLikeABareDomain = 'unique-only.log';
  assert.strictEqual(
    parseTerminalUrlAtColumn(filenameThatLooksLikeABareDomain, 2),
    null
  );
  assert.strictEqual(
    parseExplicitTerminalUrlAtColumn(filenameThatLooksLikeABareDomain, 2),
    null,
    'bare-domain-shaped filenames should remain eligible for workspace path resolution'
  );
  assert.strictEqual(
    parseExplicitTerminalUrlAtColumn(reviewUrl, reviewUrl.indexOf('odps_src') + 3),
    reviewUrl,
    'explicit HTTP(S) URLs should retain URL ownership over their path portion'
  );
  assert.strictEqual(trimTerminalUrl(`${reviewUrl}.`), reviewUrl);
  const hyphenatedUrl = `${reviewUrl}----`;
  assert.strictEqual(
    parseTerminalUrlAtColumn(hyphenatedUrl, hyphenatedUrl.indexOf('odps_src') + 3),
    hyphenatedUrl,
    'hyphens in the same terminal token should remain valid URL data'
  );
  const urlWithReservedData = `${reviewUrl}/done!?token=a-b_c&mode=review#summary`;
  assert.strictEqual(
    parseTerminalUrlAtColumn(urlWithReservedData, urlWithReservedData.indexOf('token') + 2),
    urlWithReservedData,
    'valid URI path, query, and fragment delimiters should remain URL data'
  );
  assert.strictEqual(
    parseTerminalUrlAtColumn(`${reviewUrl}，后续说明`, reviewUrl.indexOf('odps_src') + 3),
    reviewUrl,
    'terminal URL parsing should stop at Chinese punctuation'
  );
  assert.strictEqual(
    parseTerminalUrlAtColumn(`*${reviewUrl}*`, reviewUrl.indexOf('odps_src') + 4),
    reviewUrl,
    'terminal URL parsing should exclude matching text wrapper characters'
  );
  assert.strictEqual(
    parseTerminalUrlAtColumn(`(${reviewUrl}/a(b))`, reviewUrl.indexOf('odps_src') + 4),
    `${reviewUrl}/a(b)`,
    'terminal URL parsing should retain balanced URL parentheses and exclude the wrapper'
  );
  assert.strictEqual(
    parseTerminalUrlAtColumn(`[${reviewUrl}/a[b]]`, reviewUrl.indexOf('odps_src') + 4),
    `${reviewUrl}/a[b]`,
    'terminal URL parsing should retain balanced URL brackets and exclude the wrapper'
  );
  assert.strictEqual(
    parseTerminalUrlAtColumn(`${reviewUrl}?next=https://example.test/a`, reviewUrl.indexOf('odps_src') + 3),
    `${reviewUrl}?next=https://example.test/a`,
    'terminal URL parsing should keep nested HTTP data in the same URL'
  );

  const locationCases = [
    {
      text: 'src/compiler.ts:339:12-18',
      target: { path: 'src/compiler.ts', lineNumber: 339, column: 12, endColumn: 18 },
    },
    {
      text: 'src/compiler.ts:339.12',
      target: { path: 'src/compiler.ts', lineNumber: 339, column: 12 },
    },
    {
      text: 'src/compiler.ts#339:12',
      target: { path: 'src/compiler.ts', lineNumber: 339, column: 12 },
    },
    {
      text: 'src/compiler.ts, 339.12',
      target: { path: 'src/compiler.ts', lineNumber: 339, column: 12 },
    },
    {
      text: 'src/compiler.ts(339, 12)',
      target: { path: 'src/compiler.ts', lineNumber: 339, column: 12 },
    },
    {
      text: 'src/compiler.ts: (339:12)',
      target: { path: 'src/compiler.ts', lineNumber: 339, column: 12 },
    },
    {
      text: 'src/compiler.ts[339:12]',
      target: { path: 'src/compiler.ts', lineNumber: 339, column: 12 },
    },
    {
      text: 'File "scripts/check query.py", line 27, column 5',
      target: { path: 'scripts/check query.py', lineNumber: 27, column: 5 },
    },
    {
      text: '"src/compiler.ts" on line 44, character 7',
      target: { path: 'src/compiler.ts', lineNumber: 44, column: 7 },
    },
    {
      text: 'src/compiler.ts line 44 characters 7-11',
      target: { path: 'src/compiler.ts', lineNumber: 44, column: 7, endColumn: 11 },
    },
    {
      text: 'src/compiler.ts:339.12-341.789',
      target: {
        path: 'src/compiler.ts',
        lineNumber: 339,
        column: 12,
        endLineNumber: 341,
        endColumn: 789,
      },
    },
    {
      text: '"src/compiler.ts", lines 339-341, characters 12-789',
      target: {
        path: 'src/compiler.ts',
        lineNumber: 339,
        column: 12,
        endLineNumber: 341,
        endColumn: 789,
      },
    },
    {
      text: 'src/compiler.ts\u00a0339:12',
      target: { path: 'src/compiler.ts', lineNumber: 339, column: 12 },
    },
    {
      text: 'C:\\work\\src\\main.cpp:12:4',
      target: { path: 'C:\\work\\src\\main.cpp', lineNumber: 12, column: 4 },
    },
    {
      text: '\\\\server\\share\\main.ts:4:2',
      target: { path: '\\\\server\\share\\main.ts', lineNumber: 4, column: 2 },
    },
    {
      text: 'file:///Users/me/work/src/main.ts:4:2',
      target: { path: '/Users/me/work/src/main.ts', lineNumber: 4, column: 2 },
    },
  ];
  for (const locationCase of locationCases) {
    const matchesForLocation = collectTerminalPathLinkMatches(locationCase.text);
    assert.strictEqual(
      matchesForLocation.length,
      1,
      `terminal path parsing should expose one high-confidence location for ${locationCase.text}`
    );
    assert.deepStrictEqual(matchesForLocation[0].pathTarget, locationCase.target);
    assert.deepStrictEqual(
      parseTerminalPathTargetAtColumn(locationCase.text, locationCase.text.indexOf('compiler') >= 0
        ? locationCase.text.indexOf('compiler')
        : Math.max(
            locationCase.text.indexOf('check query'),
            locationCase.text.indexOf('main.cpp'),
            locationCase.text.indexOf('main.ts'),
          )),
      locationCase.target,
      `terminal path hit testing should share the location grammar for ${locationCase.text}`
    );
  }
  assert.deepStrictEqual(
    collectTerminalPathLinkMatches('+++ b/src/compiler.ts').map(match => match.pathTarget),
    [{ path: 'src/compiler.ts' }],
    'git diff path prefixes should resolve to workspace-relative paths'
  );
  assert.deepStrictEqual(
    collectTerminalPathLinkMatches('Build failed on line 44'),
    [],
    'line prose without a file-like path should remain plain terminal text'
  );
  assert.deepStrictEqual(
    collectTerminalPathLinkMatches('unique-only.log unique terminal filename')[0]?.pathTarget,
    { path: 'unique-only.log' },
    'a file-like token should be tried before a weaker whole-line path fallback'
  );
  assert.deepStrictEqual(
    collectTerminalPathLinkMatches(`${'x'.repeat(2001)} src/compiler.ts:1`),
    [],
    'excessively long terminal lines should not trigger filesystem link resolution'
  );
  const manyPathTargets = Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts:${index + 1}`).join(' ');
  assert.strictEqual(
    collectTerminalPathLinkMatches(manyPathTargets).length,
    10,
    'terminal path detection should cap filesystem candidates per logical line'
  );
  assert.deepStrictEqual(
    collectTerminalMultiLinePathLinkMatches('  16:5  error  Unexpected token', [
      '  15:3  warning  Previous warning',
      'src/parser with spaces.ts',
    ]).map(match => match.pathTarget),
    [{ path: 'src/parser with spaces.ts', lineNumber: 16, column: 5 }],
    'VS Code-style multiline diagnostics should resolve the first preceding non-numeric line as the file'
  );
  assert.deepStrictEqual(
    collectTerminalMultiLinePathLinkMatches('@@ -8,11 +20,3 @@ function parse()', [
      '+++ b/src/parser.ts',
      '--- a/src/parser.ts',
    ]).map(match => match.pathTarget),
    [{
      path: 'src/parser.ts',
      lineNumber: 20,
      column: 1,
      endLineNumber: 23,
    }],
    'VS Code-style git hunk links should bind to the preceding +++ file path'
  );
  assert.deepStrictEqual(
    collectTerminalSearchLinkMatches('error: parse_result(foo)').map(match => match.text),
    ['error', 'parse_result', 'foo'],
    'VS Code-style terminal word links should honor separators and trim a trailing colon'
  );
  assert.deepStrictEqual(
    collectTerminalLinkMatches(`error ${reviewUrl} src/compiler.ts:4`, true, true)
      .filter(match => match.kind === 'search')
      .map(match => match.text),
    ['error'],
    'terminal search links should remain the lowest-priority layer below URLs and local files'
  );

  const reviewMatch = matches.find(match => match.kind === 'url');
  assert(reviewMatch, 'boxed git-push output should expose the review URL as a link');
  assert.deepStrictEqual(
    terminalLinkMatchRange(reviewMatch, { startRow: 17, cols: 120 }),
    {
      start: { x: boxedLine.indexOf(reviewUrl) + 1, y: 18 },
      end: { x: boxedLine.indexOf(reviewUrl) + reviewUrl.length, y: 18 },
    },
    'terminal link ranges should preserve xterm\'s 1-based buffer contract'
  );

  assert.strictEqual(
    terminalTextColumnAtPixelOffset(35, 10, 8),
    3,
    'terminal DOM fallback should map mouse offsets inside rendered text'
  );
  assert.strictEqual(
    terminalTextColumnAtPixelOffset(85, 10, 8),
    null,
    'terminal DOM fallback should not clamp row-end whitespace onto the final path character'
  );

  console.log('✓ Terminal links detect boxed code-review URLs');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
