const assert = require('assert');
const {
  acpRevisionClientDelivery,
} = require('../acp-revision-delivery.cjs');

const session = { agentId: 'agent-a', revision: 12 };

assert.strictEqual(
  acpRevisionClientDelivery('agent-a', undefined, 0, 100, { agentId: 'agent-a', revision: 0 }),
  'send',
  'revision zero should be delivered when the connection has no watermark yet',
);
assert.strictEqual(
  acpRevisionClientDelivery('agent-a', 11, 0, 100, session),
  'send',
  'the focused client should receive a newer revision',
);
assert.strictEqual(
  acpRevisionClientDelivery('agent-b', 0, 0, 100, session),
  'skip',
  'an unrelated client must not receive the revision',
);
assert.strictEqual(
  acpRevisionClientDelivery(null, 0, 0, 100, session),
  'skip',
  'a client without visible Agent interest must not receive the revision',
);
assert.strictEqual(
  acpRevisionClientDelivery('agent-a', 12, 0, 100, session),
  'skip',
  'a duplicate revision must not be resent',
);
assert.strictEqual(
  acpRevisionClientDelivery('agent-a', 13, 0, 100, session),
  'skip',
  'an older revision must not replace a newer delivered checkpoint',
);
assert.strictEqual(
  acpRevisionClientDelivery('agent-a', 11, 101, 100, session),
  'defer',
  'a slow focused client should retain only a pending checkpoint marker',
);
assert.strictEqual(
  acpRevisionClientDelivery('agent-a', 11, 0, 100, session),
  'send',
  'the same absolute checkpoint should be deliverable after the transport buffer drains',
);
assert.strictEqual(
  acpRevisionClientDelivery('agent-a', 11, 100, 100, session),
  'send',
  'a client exactly at the transport threshold should still receive the checkpoint',
);

console.log('ACP revision delivery tests passed');
