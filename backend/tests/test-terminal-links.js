const assert = require('assert');

async function run() {
  const {
    collectTerminalLinkMatches,
    parseTerminalUrlAtColumn,
    terminalTextColumnAtPixelOffset,
    trimTerminalUrl,
  } = await import('../../src/lib/terminal-links.ts');

  const reviewUrl = 'https://code.example.test/odps/meta-warehouse/codereview/new?from=master&to=master_3_tier';
  const boxedLine = `remote: | ${reviewUrl} |`;
  const matches = collectTerminalLinkMatches(boxedLine, false);
  assert.deepStrictEqual(
    matches.filter(match => match.kind === 'url').map(match => match.text),
    [reviewUrl],
    'terminal link matcher should detect git remote code-review URLs inside boxed output'
  );
  assert.strictEqual(
    parseTerminalUrlAtColumn(boxedLine, boxedLine.indexOf('to=master_3_tier') + 3),
    reviewUrl,
    'terminal URL hit testing should keep underscore query parameters'
  );
  assert.strictEqual(trimTerminalUrl(`${reviewUrl}.`), reviewUrl);

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
