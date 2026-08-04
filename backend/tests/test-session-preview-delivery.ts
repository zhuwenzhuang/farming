const assert = require('assert');
const {
  cancelSessionPreviewHydration,
  declareSessionPreviewScope,
  normalizeSessionPreviewScope,
  queueSessionPreviewHydration,
  sessionPreviewScopeCheckpointRequired,
  sessionPreviewScopeIncludesAgent,
} = require('../session-preview-delivery.cjs');

type HydrationState = {
  previewHydrationPending?: boolean;
  previewHydrationTimer?: ReturnType<typeof setTimeout> | null;
  previewScopeDeclared?: boolean;
};

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

async function runHydrationStateTests() {
  const waitForTimer = () => new Promise(resolve => setTimeout(resolve, 20));

  const legacy: HydrationState = {};
  let legacyHydrations = 0;
  queueSessionPreviewHydration(legacy, 5, () => { legacyHydrations += 1; });
  assert.strictEqual(legacy.previewHydrationPending, true);
  await waitForTimer();
  assert.strictEqual(legacyHydrations, 1, 'an undeclared legacy Client should hydrate once at the deadline');
  assert.strictEqual(legacy.previewHydrationPending, false);
  assert.strictEqual(legacy.previewHydrationTimer, null);
  assert.strictEqual(declareSessionPreviewScope(legacy), false, 'a late declaration must not replay hydration');
  assert.strictEqual(legacyHydrations, 1);

  const closed: HydrationState = {};
  let closedHydrations = 0;
  queueSessionPreviewHydration(closed, 5, () => { closedHydrations += 1; });
  cancelSessionPreviewHydration(closed);
  await waitForTimer();
  assert.strictEqual(closedHydrations, 0, 'closing during the declaration window must cancel hydration');

  const replacedSnapshot: HydrationState = {};
  let replacementHydrations = 0;
  queueSessionPreviewHydration(replacedSnapshot, 5, () => { replacementHydrations += 1; });
  cancelSessionPreviewHydration(replacedSnapshot);
  queueSessionPreviewHydration(replacedSnapshot, 5, () => { replacementHydrations += 1; });
  await waitForTimer();
  assert.strictEqual(replacementHydrations, 1, 'a replacement Snapshot should own exactly one hydration deadline');

  const pendingDeclaration: HydrationState = {};
  let pendingHydrations = 0;
  queueSessionPreviewHydration(pendingDeclaration, 50, () => { pendingHydrations += 1; });
  assert.strictEqual(declareSessionPreviewScope(pendingDeclaration), true);
  await waitForTimer();
  assert.strictEqual(pendingHydrations, 0, 'scope declaration should cancel the legacy fallback timer');

  const declaredDuringSnapshot: HydrationState = {};
  assert.strictEqual(declareSessionPreviewScope(declaredDuringSnapshot), false);
  let declaredHydrations = 0;
  queueSessionPreviewHydration(declaredDuringSnapshot, 50, () => { declaredHydrations += 1; });
  assert.strictEqual(declaredHydrations, 1, 'Snapshot completion should hydrate an already declared Client immediately');
  assert.strictEqual(declaredDuringSnapshot.previewHydrationTimer, null);

  console.log('Session preview delivery tests passed');
}

runHydrationStateTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
