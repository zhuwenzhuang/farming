const assert = require('assert');
const {
  acpActionGroupLabel,
  isAcpProgressUpdate,
} = require('../../src/components/code/acp/acp-progress-timeline.ts');

assert.strictEqual(isAcpProgressUpdate({ type: 'progress' }), true);
assert.strictEqual(isAcpProgressUpdate({ type: 'tool' }), false);
assert.strictEqual(
  acpActionGroupLabel([
    { type: 'patch', kind: 'edit', status: 'completed' },
    { type: 'tool', kind: 'read', status: 'completed' },
    { type: 'tool', kind: 'read', status: 'completed' },
    { type: 'thought', status: 'completed' },
    { type: 'tool', kind: 'execute', status: 'completed' },
  ]),
  'Edited a file, read files, ran a command',
);
assert.strictEqual(
  acpActionGroupLabel([{ type: 'thought', status: 'completed' }]),
  'Reasoning',
);
assert.strictEqual(
  acpActionGroupLabel([{ type: 'tool', kind: 'execute', status: 'failed' }]),
  'Action failed',
);

console.log('test-acp-progress-timeline passed');
