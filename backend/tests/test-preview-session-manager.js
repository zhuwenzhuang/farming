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

console.log('preview session manager assertions passed');
