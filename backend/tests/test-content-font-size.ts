const assert = require('assert');

const {
  DEFAULT_CODE_CONTENT_FONT_SIZE,
  MAX_CONTENT_FONT_SIZE,
  MIN_CONTENT_FONT_SIZE,
  codeEditorFontSize,
  codeEditorLineHeight,
  codeTerminalFontSize,
  crtTerminalFontSize,
  normalizeContentFontSize,
} = require('../../src/lib/content-font-size');

function run() {
  assert.strictEqual(normalizeContentFontSize(undefined), DEFAULT_CODE_CONTENT_FONT_SIZE);
  assert.strictEqual(normalizeContentFontSize('invalid'), DEFAULT_CODE_CONTENT_FONT_SIZE);
  assert.strictEqual(normalizeContentFontSize(9), MIN_CONTENT_FONT_SIZE);
  assert.strictEqual(normalizeContentFontSize(21), MAX_CONTENT_FONT_SIZE);
  assert.strictEqual(normalizeContentFontSize(15.6), 16);

  assert.strictEqual(codeEditorFontSize(14), 13);
  assert.strictEqual(codeEditorLineHeight(14), 21);
  assert.strictEqual(codeTerminalFontSize(14), 12);
  assert.strictEqual(codeTerminalFontSize(14, true), 11);
  assert.strictEqual(crtTerminalFontSize(14), 15);

  assert.strictEqual(codeEditorFontSize(MIN_CONTENT_FONT_SIZE), MIN_CONTENT_FONT_SIZE);
  assert.strictEqual(codeTerminalFontSize(MIN_CONTENT_FONT_SIZE), MIN_CONTENT_FONT_SIZE);
  assert.strictEqual(crtTerminalFontSize(MAX_CONTENT_FONT_SIZE), MAX_CONTENT_FONT_SIZE);
  console.log('Content font size tests passed');
}

run();
