const assert = require('assert');
const {
  agentActivityClientDelivery,
  normalizeAgentActivityScope,
} = require('../agent-activity-delivery.cjs');

assert.strictEqual(normalizeAgentActivityScope(undefined), 'all');
assert.strictEqual(normalizeAgentActivityScope('invalid'), 'all');
assert.strictEqual(normalizeAgentActivityScope('focused'), 'focused');

assert.strictEqual(
  agentActivityClientDelivery('all', null, false, 0, 100, 'agent-a'),
  'send',
  'an all-scope browser should receive every Agent activity snapshot',
);
assert.strictEqual(
  agentActivityClientDelivery('none', 'agent-a', false, 0, 100, 'agent-a'),
  'skip',
  'a browser outside an activity surface should receive no Agent activity',
);
assert.strictEqual(
  agentActivityClientDelivery('focused', 'agent-a', false, 0, 100, 'agent-a'),
  'send',
  'a focused-scope browser should receive its visible Agent activity',
);
assert.strictEqual(
  agentActivityClientDelivery('focused', 'agent-b', false, 0, 100, 'agent-a'),
  'skip',
  'a focused-scope browser should not receive another Agent activity',
);
assert.strictEqual(
  agentActivityClientDelivery('focused', 'agent-a', false, 101, 100, 'agent-a'),
  'defer',
  'a slow focused browser should defer to one Agent checkpoint marker',
);
assert.strictEqual(
  agentActivityClientDelivery('all', null, true, 0, 100, 'agent-a'),
  'defer',
  'an all-scope browser awaiting an activity checkpoint should not accept partial updates',
);
assert.strictEqual(
  agentActivityClientDelivery('all', null, false, 100, 100, 'agent-a'),
  'send',
  'a browser exactly at the buffer threshold should still receive activity',
);

console.log('Agent activity delivery tests passed');
