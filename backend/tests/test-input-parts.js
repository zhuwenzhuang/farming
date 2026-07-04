const assert = require('assert');
const {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  inputPartsFromMessage,
  normalizeTerminalInputParts,
  terminalInputToPtyString,
} = require('../input-parts');

function run() {
  assert.deepStrictEqual(
    inputPartsFromMessage({ input: 'raw\r' }),
    ['raw\r'],
    'legacy single input messages should remain supported'
  );

  assert.deepStrictEqual(
    inputPartsFromMessage({
      inputParts: [
        'before',
        { type: 'paste', text: 'first\n\nsecond' },
        { type: 'paste', text: 42 },
        { type: 'unknown', text: 'ignored' },
      ],
    }),
    ['before', { type: 'paste', text: 'first\n\nsecond' }],
    'input parts should admit strings and sanitized paste parts only'
  );

  assert.deepStrictEqual(
    normalizeTerminalInputParts([{ type: 'paste', text: 'hello' }, '\r']),
    [{ type: 'paste', text: 'hello' }, '\r']
  );

  assert.strictEqual(
    terminalInputToPtyString([{ type: 'paste', text: 'hello\nworld' }, '\r']),
    `${BRACKETED_PASTE_START}hello\nworld${BRACKETED_PASTE_END}\r`,
    'local PTY fallback should preserve paste text with bracketed paste markers'
  );

  console.log('test-input-parts passed');
}

run();
