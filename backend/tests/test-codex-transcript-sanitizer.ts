const assert = require('assert');

const {
  MAX_CODEX_INLINE_VISUALIZATION_BUFFER_BYTES,
  consumeCodexInlineVisualizationStream,
  createCodexInlineVisualizationStreamState,
  stripCodexInternalContextBlocks,
} = require('../codex-transcript-sanitizer.cjs');

for (const text of [' ', '\n\n', '  select  \n\n\n  value;  ']) {
  assert.strictEqual(stripCodexInternalContextBlocks(text, { preserveWhitespace: true }), text);
}
assert.strictEqual(stripCodexInternalContextBlocks('  visible  '), 'visible');
assert.strictEqual(stripCodexInternalContextBlocks(
  '<codex_internal_context>hidden</codex_internal_context>visible ::created-thread{threadId="private"}',
  { preserveWhitespace: true },
).trim(), 'visible');
assert.strictEqual(
  stripCodexInternalContextBlocks(
    '<system-reminder>a</system-reminder><system-reminder>b</system-reminder>visible',
    { preserveWhitespace: true },
  ),
  'visible',
);
assert.strictEqual(
  stripCodexInternalContextBlocks(
    '<environment_context>a</environment_context>\n<system-reminder>b</system-reminder>\n    const x = 1;',
    { preserveWhitespace: true },
  ),
  '    const x = 1;',
);
assert.strictEqual(
  stripCodexInternalContextBlocks(
    '<system-reminder>a</system-reminder>\n    code',
    { preserveWhitespace: true },
  ),
  '    code',
);
assert.strictEqual(
  stripCodexInternalContextBlocks(
    'before\n<system-reminder>a</system-reminder>\n<oai-mem-citation>b</oai-mem-citation>\n    code',
    { preserveWhitespace: true },
  ),
  'before\n    code',
);
assert.strictEqual(
  stripCodexInternalContextBlocks(
    'paragraph 1\n\n<system-reminder>a</system-reminder>\n\n    indented code\n',
    { preserveWhitespace: true },
  ),
  'paragraph 1\n\n    indented code\n',
);
assert.strictEqual(
  stripCodexInternalContextBlocks(
    'answer\n\n<oai-mem-citation>a</oai-mem-citation>\n<system-reminder>b</system-reminder>\n',
    { preserveWhitespace: true },
  ),
  'answer',
);

const stream = createCodexInlineVisualizationStreamState();
const prefix = '::codex-inline-vis{file="';
const oversized = `${prefix}${'a'.repeat(MAX_CODEX_INLINE_VISUALIZATION_BUFFER_BYTES)}.html`;
const overflow = consumeCodexInlineVisualizationStream(stream, oversized);
assert.strictEqual(stream.buffer, '');
assert.strictEqual(stream.passthroughLine, true);
assert.strictEqual(overflow.text, oversized);
assert.deepStrictEqual(overflow.directives, []);

const newline = consumeCodexInlineVisualizationStream(stream, '\n');
assert.strictEqual(newline.text, '\n');
assert.strictEqual(stream.passthroughLine, false);

const valid = consumeCodexInlineVisualizationStream(
  stream,
  '::codex-inline-vis{file="chart.html"}',
);
assert.deepStrictEqual(valid.directives, [{ file: 'chart.html' }]);
assert.strictEqual(stream.buffer, '');

const visualizePath = '/Users/example/.codex/visualizations/2026/08/19/thread/chart.html';
const reference = `visualize${JSON.stringify({ path: visualizePath })}`;
const referenceStream = createCodexInlineVisualizationStreamState();
const firstReferenceChunk = consumeCodexInlineVisualizationStream(
  referenceStream,
  `Result\n\n${reference.slice(0, -8)}`,
);
assert.strictEqual(firstReferenceChunk.text, 'Result\n\n');
assert.deepStrictEqual(firstReferenceChunk.directives, []);
const completedReference = consumeCodexInlineVisualizationStream(
  referenceStream,
  reference.slice(-8),
);
assert.deepStrictEqual(completedReference.directives, [{ file: visualizePath }]);
assert.strictEqual(referenceStream.buffer, '');

const literalReference = consumeCodexInlineVisualizationStream(
  createCodexInlineVisualizationStreamState(),
  `\`\`\`text\n${reference}\n\`\`\``,
  true,
);
assert.strictEqual(literalReference.text, `\`\`\`text\n${reference}\n\`\`\``);
assert.deepStrictEqual(literalReference.directives, []);

console.log('Codex transcript sanitizer regression test passed.');
