const assert = require('assert');
const {
  normalizeSessionPreviewScope,
  sessionPreviewScopeCheckpointRequired,
  sessionPreviewScopeIncludesAgent,
} = require('../session-preview-delivery.cjs');

assert.strictEqual(normalizeSessionPreviewScope(undefined), 'all');
assert.strictEqual(normalizeSessionPreviewScope('invalid'), 'all');
assert.strictEqual(normalizeSessionPreviewScope('focused'), 'focused');

assert.strictEqual(
  sessionPreviewScopeIncludesAgent('all', null, 'agent-a'),
  true,
  'legacy and all-scope browsers should receive every Agent preview',
);
assert.strictEqual(
  sessionPreviewScopeIncludesAgent('none', 'agent-a', 'agent-a'),
  false,
  'a browser outside a preview surface should receive no Agent preview',
);
assert.strictEqual(
  sessionPreviewScopeIncludesAgent('focused', 'agent-a', 'agent-a'),
  true,
  'a focused preview scope should include its focused Agent',
);
assert.strictEqual(
  sessionPreviewScopeIncludesAgent('focused', 'agent-b', 'agent-a'),
  false,
  'a focused preview scope should exclude unrelated Agents',
);
assert.strictEqual(
  sessionPreviewScopeIncludesAgent('focused', null, 'agent-a'),
  false,
  'a focused preview scope without a target should include no Agent',
);
assert.strictEqual(
  sessionPreviewScopeCheckpointRequired('none', null, 'all', null),
  true,
  'widening from none to all should hydrate absolute previews',
);
assert.strictEqual(
  sessionPreviewScopeCheckpointRequired('none', 'agent-a', 'focused', 'agent-a'),
  true,
  'widening from none to focused should hydrate the focused Agent preview',
);
assert.strictEqual(
  sessionPreviewScopeCheckpointRequired('focused', 'agent-a', 'focused', 'agent-b'),
  true,
  'changing the focused preview target should hydrate the new Agent',
);
assert.strictEqual(
  sessionPreviewScopeCheckpointRequired('all', null, 'focused', 'agent-a'),
  false,
  'narrowing an all-scope client should not duplicate an existing preview',
);
assert.strictEqual(
  sessionPreviewScopeCheckpointRequired('focused', 'agent-a', 'none', null),
  false,
  'narrowing to none should not send a preview checkpoint',
);

console.log('Session preview delivery tests passed');
