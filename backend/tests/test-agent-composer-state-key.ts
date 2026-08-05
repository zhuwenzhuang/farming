const assert = require('assert');
const { existingComposerStateUpdateKey } = require('../../src/components/code/agent-composer-state-key.ts');

assert.strictEqual(
  existingComposerStateUpdateKey({ 'acp:agent-id': {} }, 'acp:provider-session', 'acp:agent-id'),
  'acp:agent-id',
  'a fast upload completion must update the existing temporary Composer state before Session-key migration',
);
assert.strictEqual(
  existingComposerStateUpdateKey({ 'acp:provider-session': {} }, 'acp:provider-session', 'acp:agent-id'),
  'acp:provider-session',
  'the authoritative Session-key state wins after Composer migration',
);
assert.strictEqual(
  existingComposerStateUpdateKey({}, 'acp:provider-session', 'acp:agent-id'),
  'acp:provider-session',
  'a missing state keeps the canonical creation target',
);

console.log('Agent Composer state update key tests passed');
