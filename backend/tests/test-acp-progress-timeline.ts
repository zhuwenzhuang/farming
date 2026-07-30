const assert = require('assert');
const {
  acpActionGroupLabel,
  acpProgressFlowEntries,
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

assert.deepStrictEqual(
  acpProgressFlowEntries([
    { id: 'thought-a', type: 'thought' },
    { id: 'tool-a', type: 'tool', kind: 'read' },
    { id: 'comment-a', type: 'progress' },
    { id: 'thought-b', type: 'thought' },
    { id: 'tool-b', type: 'tool', kind: 'execute' },
    { id: 'steer-a', type: 'user-steer' },
    { id: 'comment-b', type: 'progress' },
    { id: 'plan-a', type: 'plan' },
    { id: 'tool-c', type: 'tool', kind: 'edit' },
  ]).map(entry => (
    entry.kind === 'group'
      ? { kind: entry.kind, id: entry.id, ids: entry.items.map(item => item.id) }
      : { kind: entry.kind, id: entry.item.id }
  )),
  [
    { kind: 'group', id: 'group:thought-a', ids: ['thought-a', 'tool-a'] },
    { kind: 'item', id: 'comment-a' },
    { kind: 'group', id: 'group:thought-b', ids: ['thought-b', 'tool-b'] },
    { kind: 'item', id: 'steer-a' },
    { kind: 'item', id: 'comment-b' },
    { kind: 'group', id: 'group:tool-c', ids: ['tool-c'] },
  ],
);

console.log('test-acp-progress-timeline passed');
