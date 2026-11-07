const assert = require('assert');
const {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  inputPartsFromMessage,
  normalizeTerminalInputParts,
  splitPtyInputChunks,
  terminalInputToPtyString,
} = require('../input-parts.cjs');

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

  const longPayload = terminalInputToPtyString([
    {
      type: 'paste',
      text: '# Migration review\n' + '检查迁移计划、权限与回滚路径。 Keep the entire source.\n'.repeat(30) + 'END_OF_PASTED_DOCUMENT',
    },
    '\r',
  ]);
  const chunks = splitPtyInputChunks(longPayload);
  assert.ok(chunks.length > 1, 'multi-kilobyte PTY input should split into paced chunks');
  assert.strictEqual(chunks.join(''), longPayload, 'chunked PTY input must reconstruct the exact payload');
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 512, 'each PTY chunk must stay within the canonical buffer limit');
    assert.ok(!chunk.includes('\uFFFD'), 'chunking must never split multi-byte UTF-8 characters');
  }

  console.log('test-input-parts passed');
}

run();
