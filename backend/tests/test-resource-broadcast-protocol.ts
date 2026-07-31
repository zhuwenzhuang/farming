const assert = require('assert');
const {
  coalesceResourceBroadcast,
  drainResourceBroadcasts,
  resourceClientDelivery,
} = require('../resource-broadcast-protocol.cjs');

const pending = new Map();
const event = (domain, id, collectionRevision, kind = 'updated') => ({
  domain,
  id,
  collectionRevision,
  kind,
  message: { type: `${domain}-resource-${kind}`, id, collectionRevision },
});

coalesceResourceBroadcast(pending, event('browser', 'a', 1));
coalesceResourceBroadcast(pending, event('browser', 'b', 2));
coalesceResourceBroadcast(pending, event('browser', 'a', 3));
coalesceResourceBroadcast(pending, event('browser', 'a', 2));
coalesceResourceBroadcast(pending, event('computer', 'c', 2));
coalesceResourceBroadcast(pending, event('computer', 'c', 2, 'deleted'));
coalesceResourceBroadcast(pending, event('computer', 'c', 2));

assert.strictEqual(pending.size, 3, 'The queue must retain at most one event per domain and Resource id');
const drained = drainResourceBroadcasts(pending);
assert.deepStrictEqual(
  drained.filter(item => item.domain === 'browser').map(item => [item.id, item.collectionRevision]),
  [['b', 2], ['a', 3]],
  'Coalesced events must be delivered in collection-revision order within a domain',
);
assert.strictEqual(
  drained.find(item => item.domain === 'computer')?.kind,
  'deleted',
  'Deletion must win when update and delete have the same collection revision',
);
assert.strictEqual(pending.size, 0, 'Draining must release the bounded pending queue');
assert.strictEqual(resourceClientDelivery(0, false, 100), 'delta');
assert.strictEqual(resourceClientDelivery(0, true, 100), 'snapshot');
assert.strictEqual(resourceClientDelivery(101, false, 100), 'defer');
assert.strictEqual(resourceClientDelivery(101, true, 100), 'defer');

console.log('resource broadcast protocol tests passed');
