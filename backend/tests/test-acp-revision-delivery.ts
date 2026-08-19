const assert = require('assert');
const {
  acpRevisionClientDelivery,
} = require('../acp-revision-delivery.cjs');

const session = {
  agentId: 'agent-a',
  sessionId: 'session-a',
  runtimeEpoch: 'epoch-a',
  revision: 12,
};

assert.strictEqual(
  acpRevisionClientDelivery(true, undefined, 0, 100, { ...session, revision: 0 }),
  'send',
  'revision zero should be delivered when the connection has no watermark yet',
);
assert.strictEqual(
  acpRevisionClientDelivery(true, { ...session, revision: 11 }, 0, 100, session),
  'send',
  'the focused client should receive a newer revision',
);
assert.strictEqual(
  acpRevisionClientDelivery(false, { ...session, revision: 0 }, 0, 100, session),
  'skip',
  'an unrelated client must not receive the revision',
);
assert.strictEqual(
  acpRevisionClientDelivery(false, { ...session, revision: 0 }, 0, 100, session),
  'skip',
  'a client without visible Agent interest must not receive the revision',
);
assert.strictEqual(
  acpRevisionClientDelivery(true, session, 0, 100, session),
  'skip',
  'a duplicate revision must not be resent',
);
assert.strictEqual(
  acpRevisionClientDelivery(true, { ...session, revision: 13 }, 0, 100, session),
  'skip',
  'an older revision must not replace a newer delivered checkpoint',
);
assert.strictEqual(
  acpRevisionClientDelivery(true, { ...session, revision: 11 }, 101, 100, session),
  'defer',
  'a slow focused client should retain only a pending checkpoint marker',
);
assert.strictEqual(
  acpRevisionClientDelivery(true, { ...session, revision: 11 }, 0, 100, session),
  'send',
  'the same absolute checkpoint should be deliverable after the transport buffer drains',
);
assert.strictEqual(
  acpRevisionClientDelivery(true, { ...session, revision: 11 }, 100, 100, session),
  'send',
  'a client exactly at the transport threshold should still receive the checkpoint',
);
assert.strictEqual(
  acpRevisionClientDelivery(true, session, 0, 100, {
    ...session,
    sessionId: 'session-b',
    runtimeEpoch: 'epoch-b',
    revision: 1,
  }),
  'send',
  'a replacement Session must be delivered even when its revision is lower',
);

console.log('ACP revision delivery tests passed');
