const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

(async () => {
  const {
    buildTerminalPreviewLines,
    calculateTerminalPreviewFontSize,
    normalizeTerminalPreviewSnapshot,
    renderTerminalPreviewLine,
  } = importTsModule('src/lib/terminal-preview.ts');

  const lines = buildTerminalPreviewLines('one\ntwo', 4);
  assert.deepStrictEqual(lines, ['one', 'two']);

  const clipped = buildTerminalPreviewLines('1\n2\n3\n4', 2);
  assert.deepStrictEqual(clipped, ['3', '4']);

  const fontSize = calculateTerminalPreviewFontSize(320, 180, 80, 24);
  assert.ok(fontSize > 4);
  assert.ok(fontSize <= 16);

  const snapshot = normalizeTerminalPreviewSnapshot({
    cols: 4,
    rows: 3,
    viewportY: 0,
    cursorX: 2,
    cursorY: 1,
    cells: [
      [{ char: 'A', width: 1, fg: 1, attributes: 1 }],
      [{ char: 'B', width: 1, fg: 0x010203, bg: 25, attributes: 0x06 }],
    ],
  });
  assert.strictEqual(snapshot.cells.length, 3);
  const html = renderTerminalPreviewLine(snapshot.cells[1], -1);
  assert.ok(html.includes('terminal-char'));
  assert.ok(html.includes('color:rgb(1, 2, 3)'));
  assert.ok(html.includes('background-color:rgb(0, 95, 175)'));

  console.log('✓ terminal preview layout preserves viewport rows, styles, and scale');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
