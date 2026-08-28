const assert = require('assert');

const { PreviewSessionManager } = require('../preview-session-manager.cjs');

let now = 1_000;
let nextId = 1;
const manager = new PreviewSessionManager({
  ttlMs: 1_000,
  maxSessions: 2,
  now: () => now,
  randomUUID: () => `preview-${nextId++}`,
});

const first = manager.createStatic({
  rootId: 'root-1',
  workspaceRoot: '/workspace',
  authorizedRoot: '/workspace',
  entryPath: 'docs/index.html',
  baseDirectory: 'docs',
});
assert.strictEqual(first.id, 'preview-1');
assert.strictEqual(manager.get(first.id), first);

now = 2_100;
assert.strictEqual(manager.get(first.id), null, 'expired sessions should disappear on lookup');

now = 2_000;
const second = manager.createStatic({
  rootId: 'root-1',
  workspaceRoot: '/workspace',
  authorizedRoot: '/workspace',
  entryPath: 'a.html',
  baseDirectory: '',
});
const third = manager.createStatic({
  rootId: 'root-1',
  workspaceRoot: '/workspace',
  authorizedRoot: '/workspace',
  entryPath: 'b.html',
  baseDirectory: '',
});
const fourth = manager.createStatic({
  rootId: 'root-1',
  workspaceRoot: '/workspace',
  authorizedRoot: '/workspace',
  entryPath: 'c.html',
  baseDirectory: '',
});
assert.strictEqual(manager.get(second.id), null, 'capacity eviction should remove the oldest session');
assert.strictEqual(manager.get(third.id), third);
assert.strictEqual(manager.delete(third.id), true);
assert.strictEqual(manager.get(third.id), null);
assert.strictEqual(manager.get(fourth.id), fourth);

manager.dispose();
assert.strictEqual(manager.get(fourth.id), null);

let partitionedId = 1;
const partitionedManager = new PreviewSessionManager({
  maxSessions: 2,
  maxReadOnlySessions: 3,
  maxReadOnlySessionsPerScope: 2,
  now: () => 5_000,
  randomUUID: () => `partitioned-${partitionedId++}`,
});
const previewInput = {
  rootId: 'root-1',
  workspaceRoot: '/workspace',
  authorizedRoot: '/workspace',
  entryPath: 'index.html',
  baseDirectory: '',
};
const ownerA = partitionedManager.createStatic(previewInput);
const ownerB = partitionedManager.createStatic(previewInput);
const viewerA1 = partitionedManager.createStatic({
  ...previewInput,
  accessMode: 'read-only',
  scopeId: 'viewer-a',
});
const viewerA2 = partitionedManager.createStatic({
  ...previewInput,
  accessMode: 'read-only',
  scopeId: 'viewer-a',
});
const viewerA3 = partitionedManager.createStatic({
  ...previewInput,
  accessMode: 'read-only',
  scopeId: 'viewer-a',
});
assert.strictEqual(
  partitionedManager.get(viewerA1.id, { accessMode: 'read-only' }),
  null,
  'a read-only scope may evict only its own oldest preview',
);
assert.strictEqual(partitionedManager.get(viewerA2.id, { accessMode: 'read-only' }), viewerA2);
assert.strictEqual(partitionedManager.get(viewerA3.id, { accessMode: 'read-only' }), viewerA3);
const viewerB1 = partitionedManager.createStatic({
  ...previewInput,
  accessMode: 'read-only',
  scopeId: 'viewer-b',
});
assert.throws(
  () => partitionedManager.createStatic({
    ...previewInput,
    accessMode: 'read-only',
    scopeId: 'viewer-c',
  }),
  (error: Error & { statusCode?: number }) => error.statusCode === 503 && /capacity/.test(error.message),
  'a new read-only scope must not evict another viewer when the shared read-only reserve is full',
);
assert.strictEqual(partitionedManager.get(ownerA.id), ownerA);
assert.strictEqual(partitionedManager.get(ownerB.id), ownerB);
assert.strictEqual(partitionedManager.get(viewerB1.id, { accessMode: 'read-only' }), viewerB1);
assert.strictEqual(
  partitionedManager.delete(ownerB.id, { accessMode: 'read-only', scopeId: 'viewer-a' }),
  false,
  'a read-only viewer must not delete an Owner preview',
);
assert.strictEqual(
  partitionedManager.delete(viewerB1.id, { accessMode: 'read-only', scopeId: 'viewer-a' }),
  false,
  'one read-only scope must not delete another viewer preview',
);
const ownerC = partitionedManager.createStatic(previewInput);
assert.strictEqual(partitionedManager.get(ownerA.id), null, 'Owner capacity remains an independent FIFO');
assert.strictEqual(partitionedManager.get(ownerB.id), ownerB);
assert.strictEqual(partitionedManager.get(ownerC.id), ownerC);
assert.strictEqual(partitionedManager.get(viewerA2.id, { accessMode: 'read-only' }), viewerA2);

console.log('preview session manager assertions passed');
