const assert = require('assert');

const {
  MAX_CODEX_INLINE_VISUALIZATION_BUFFER_BYTES,
  consumeCodexInlineVisualizationStream,
  createCodexInlineVisualizationStreamState,
} = require('../codex-transcript-sanitizer.cjs');

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
