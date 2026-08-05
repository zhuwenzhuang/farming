const assert = require('assert');

const {
  deferAgentStateMessageDuringSnapshot,
  deliverDeferredAgentStateMessage,
} = require('../agent-state-snapshot-delivery.cjs');

interface TestSnapshotQueue {
  stateSnapshotInProgress?: boolean;
  stateSnapshotMessageBytes?: number;
  stateSnapshotMessages?: Array<{
    isRelevant?: () => boolean;
    maxBufferedAmount?: number;
    message: string;
    onDiscard?: () => void;
    onSent?: () => void;
  }>;
  stateSnapshotOverflowed?: boolean;
  stateSnapshotPending?: boolean;
}

const idle: TestSnapshotQueue = {};
assert.strictEqual(
  deferAgentStateMessageDuringSnapshot(idle, { message: 'direct' }, { maxBytes: 100, maxCount: 2 }),
  false,
);
assert.deepStrictEqual(idle, {});

const discarded: string[] = [];
const queued: TestSnapshotQueue = { stateSnapshotInProgress: true };
assert.strictEqual(
  deferAgentStateMessageDuringSnapshot(
    queued,
    { message: 'first', onDiscard: () => discarded.push('first') },
    { maxBytes: 100, maxCount: 2 },
  ),
  true,
);
assert.strictEqual(
  deferAgentStateMessageDuringSnapshot(
    queued,
    {
      message: 'second',
      isRelevant: () => true,
      onDiscard: () => discarded.push('second'),
    },
    { maxBytes: 100, maxCount: 2 },
  ),
  true,
);
assert.deepStrictEqual(queued.stateSnapshotMessages?.map(entry => entry.message), ['first', 'second']);
assert.strictEqual(queued.stateSnapshotMessageBytes, Buffer.byteLength('firstsecond'));

assert.strictEqual(
  deferAgentStateMessageDuringSnapshot(
    queued,
    { message: 'overflow', onDiscard: () => discarded.push('overflow') },
    { maxBytes: 100, maxCount: 2 },
  ),
  true,
);
assert.strictEqual(queued.stateSnapshotPending, true);
assert.strictEqual(queued.stateSnapshotOverflowed, true);
assert.deepStrictEqual(queued.stateSnapshotMessages, []);
assert.strictEqual(queued.stateSnapshotMessageBytes, 0);
assert.deepStrictEqual(discarded, ['first', 'second', 'overflow']);

assert.strictEqual(
  deferAgentStateMessageDuringSnapshot(
    queued,
    { message: 'ignored-after-overflow', onDiscard: () => discarded.push('after-overflow') },
    { maxBytes: 100, maxCount: 2 },
  ),
  true,
);
assert.deepStrictEqual(queued.stateSnapshotMessages, []);
assert.deepStrictEqual(discarded, ['first', 'second', 'overflow', 'after-overflow']);

const byteOverflow: TestSnapshotQueue = { stateSnapshotInProgress: true };
assert.strictEqual(
  deferAgentStateMessageDuringSnapshot(byteOverflow, { message: '12345' }, { maxBytes: 4, maxCount: 5 }),
  true,
);
assert.strictEqual(byteOverflow.stateSnapshotPending, true);
assert.strictEqual(byteOverflow.stateSnapshotOverflowed, true);

const delivered: string[] = [];
const deliveryEvents: string[] = [];
assert.strictEqual(
  deliverDeferredAgentStateMessage({
    message: 'send-me',
    onSent: () => deliveryEvents.push('sent'),
  }, (message: string) => delivered.push(message)),
  true,
);
assert.strictEqual(
  deliverDeferredAgentStateMessage({
    isRelevant: () => false,
    message: 'drop-me',
    onDiscard: () => deliveryEvents.push('discarded'),
  }, (message: string) => delivered.push(message)),
  false,
);
assert.deepStrictEqual(delivered, ['send-me']);
assert.deepStrictEqual(deliveryEvents, ['sent', 'discarded']);

console.log('Agent hot messages share the bounded progressive Snapshot barrier');
