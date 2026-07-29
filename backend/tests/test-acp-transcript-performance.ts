const assert = require('assert');
const {
  acpTranscriptEntries,
  acpTranscriptToolEntry,
} = require('../acp-transcript.cjs');

const MESSAGE_ENTRY_COUNT = 197;
const THOUGHT_ENTRY_COUNT = 247;
const TOOL_ENTRY_COUNT = 498;
const TOTAL_ENTRY_COUNT = MESSAGE_ENTRY_COUNT + THOUGHT_ENTRY_COUNT + TOOL_ENTRY_COUNT;
// Synthetic content with the entry counts and media sizes observed in the
// large multi-Agent deployment. No production transcript text is retained.
const OBSERVED_IMAGE_BASE64_LENGTHS = [
  1_789_152,
  2_658_228,
  3_603_020,
  255_560,
];

function productionShapedEntries() {
  const imageByMessage = new Map(
    OBSERVED_IMAGE_BASE64_LENGTHS.map((length, index) => [index * 41, 'A'.repeat(length)])
  );
  const messages = Array.from({ length: MESSAGE_ENTRY_COUNT }, (_, index) => ({
    id: `message-${index}`,
    type: 'message',
    role: index % 3 === 0 ? 'user' : 'assistant',
    content: [
      { type: 'text', text: `Transcript message ${index} ${'m'.repeat(320)}` },
      ...(imageByMessage.has(index)
        ? [{ type: 'image', mimeType: 'image/png', data: imageByMessage.get(index) }]
        : []),
    ],
  }));
  const thoughts = Array.from({ length: THOUGHT_ENTRY_COUNT }, (_, index) => ({
    id: `thought-${index}`,
    type: 'thought',
    role: 'assistant',
    content: [{ type: 'text', text: `Thought ${index} ${'t'.repeat(2_800)}` }],
  }));
  const tools = Array.from({ length: TOOL_ENTRY_COUNT }, (_, index) => ({
    id: `tool-${index}`,
    type: 'tool',
    kind: 'execute',
    title: `Tool ${index}`,
    status: 'completed',
    rawInput: { command: `command-${index}` },
    rawOutput: { stdout: 'o'.repeat(2_780), stderr: '', interrupted: false },
  }));
  return [...messages, ...thoughts, ...tools];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function parseMedianMs(serialized, iterations = 9) {
  const samples = [];
  JSON.parse(serialized);
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = process.hrtime.bigint();
    JSON.parse(serialized);
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
  }
  return median(samples);
}

const entries = productionShapedEntries();
assert.strictEqual(entries.length, TOTAL_ENTRY_COUNT);
assert.strictEqual(entries.filter(entry => entry.type === 'tool').length, TOOL_ENTRY_COUNT);

const legacySerialized = JSON.stringify({
  entries: entries.map(entry => (
    entry.type === 'tool' ? acpTranscriptToolEntry(entry) : entry
  )),
});
const optimizedSerialized = JSON.stringify({
  entries: acpTranscriptEntries(entries, {
    mediaPathPrefix: '/farming/api/agents/production-shaped/acp-media',
  }),
});

const legacyBytes = Buffer.byteLength(legacySerialized);
const optimizedBytes = Buffer.byteLength(optimizedSerialized);
const reductionRatio = 1 - optimizedBytes / legacyBytes;
assert(
  legacyBytes > 10 * 1024 * 1024 && legacyBytes < 12 * 1024 * 1024,
  `fixture should stay close to the observed 10.47 MB transcript, got ${legacyBytes} bytes`
);
assert(
  optimizedBytes < 1.5 * 1024 * 1024,
  `optimized transcript should stay below 1.5 MB, got ${optimizedBytes} bytes`
);
assert(
  reductionRatio > 0.85,
  `optimized transcript should remove more than 85% of response bytes, got ${(reductionRatio * 100).toFixed(1)}%`
);
assert(!optimizedSerialized.includes('"data":"AAAA'), 'negotiated media must not remain inline');
assert.strictEqual(
  optimizedSerialized.match(/\/acp-media\/message-[^/]+\/[a-f0-9]{64}/g)?.length,
  OBSERVED_IMAGE_BASE64_LENGTHS.length,
  'every observed image should become one content-addressed media reference'
);

const legacyParseMedianMs = parseMedianMs(legacySerialized);
const optimizedParseMedianMs = parseMedianMs(optimizedSerialized);
assert(
  optimizedParseMedianMs < legacyParseMedianMs * 0.5,
  `optimized JSON parse should be at least 2x faster; legacy=${legacyParseMedianMs.toFixed(2)}ms optimized=${optimizedParseMedianMs.toFixed(2)}ms`
);

console.log(
  'production-shaped ACP transcript:'
    + ` ${TOTAL_ENTRY_COUNT} entries, ${TOOL_ENTRY_COUNT} tools,`
    + ` ${(legacyBytes / 1024 / 1024).toFixed(2)} MB -> ${(optimizedBytes / 1024 / 1024).toFixed(2)} MB`
    + ` (${(reductionRatio * 100).toFixed(1)}% smaller),`
    + ` JSON.parse p50 ${legacyParseMedianMs.toFixed(2)} ms -> ${optimizedParseMedianMs.toFixed(2)} ms`
);
