const assert = require('assert');
require('tsx/cjs');

async function run() {
  const {
    collectTerminalLinkMatches,
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
  assert.strictEqual(trimTerminalUrl(`${reviewUrl}.`), reviewUrl);

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
