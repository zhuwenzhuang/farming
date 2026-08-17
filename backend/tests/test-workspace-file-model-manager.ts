const assert = require('assert');
const {
  WorkspaceFileModelManager,
  workspaceFileModelKey,
} = require('../../src/lib/workspace-file-model-manager.ts');

function workspaceFile(path, content = path) {
  return {
    path,
    content,
    size: content.length,
    mtimeMs: 1,
    sha1: `sha:${content}`,
  };
}

function openFile(path, content = path) {
  const file = workspaceFile(path, content);
  return {
    agentId: 'root-1',
    workspaceRoot: '/repo',
    file,
    draft: content,
    dirty: false,
    revision: 0,
    externalChanged: false,
    saving: false,
    error: null,
  };
}

async function run() {
  assert.strictEqual(
    workspaceFileModelKey('root-1', 'src/App.ts', '/repo'),
    workspaceFileModelKey('root-2', 'src/App.ts', '/repo'),
    'canonical workspace identity should join aliases for the same resource',
  );
  assert.notStrictEqual(
    workspaceFileModelKey('root-1', 'src/App.ts'),
    workspaceFileModelKey('root-2', 'src/App.ts'),
    'unrooted resources must remain isolated by their authorized root id',
  );

  let reads = 0;
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const manager = new WorkspaceFileModelManager({
    readFile: async (_rootId, filePath) => {
      reads += 1;
      await readGate;
      return workspaceFile(filePath, 'shared');
    },
  });
  const cancelledWaiter = new AbortController();
  const first = manager.resolve('root-1', 'src/App.ts', {
    signal: cancelledWaiter.signal,
    workspaceRoot: '/repo',
  });
  const second = manager.resolve('root-2', 'src/App.ts', { workspaceRoot: '/repo' });
  assert.strictEqual(reads, 1, 'same-resource resolves should share one transport read');
  cancelledWaiter.abort();
  await assert.rejects(first, error => error?.name === 'AbortError');
  releaseRead();
  assert.strictEqual((await second).content, 'shared');
  assert.strictEqual(reads, 1, 'cancelling one waiter must not cancel the shared resolve');

  const retained = openFile('src/Retained.ts', 'retained');
  manager.acceptOpenFiles([retained], []);
  assert.strictEqual(
    (await manager.resolve('root-1', retained.file.path, { workspaceRoot: retained.workspaceRoot })).content,
    'retained',
  );
  assert.strictEqual(reads, 1, 'retained models should resolve without transport I/O');
  assert.deepStrictEqual(manager.retainedOpenFiles().map(file => file.file.path), ['src/Retained.ts']);
  manager.dispose();

  let externalReads = 0;
  const externalManager = new WorkspaceFileModelManager({
    readFile: async (_rootId, filePath) => {
      externalReads += 1;
      return workspaceFile(filePath, 'fresh external');
    },
  });
  const external = {
    ...openFile('external.ts', 'retained external'),
    file: {
      ...workspaceFile('external.ts', 'retained external'),
      external: true,
    },
  };
  externalManager.acceptOpenFiles([external], []);
  assert.strictEqual(
    (await externalManager.resolve('root-1', external.file.path, { workspaceRoot: '/repo' })).content,
    'fresh external',
    'resources without exact watches must preserve the authoritative read path',
  );
  assert.strictEqual(externalReads, 1);
  externalManager.dispose();

  let boundedReads = 0;
  const bounded = new WorkspaceFileModelManager({
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxModels: 2,
    readFile: async (_rootId, filePath) => {
      boundedReads += 1;
      return workspaceFile(filePath, 'from disk');
    },
  });
  const one = openFile('one.ts');
  const two = openFile('two.ts');
  const three = openFile('three.ts');
  bounded.acceptOpenFiles([one, two, three], []);
  assert.deepStrictEqual(
    bounded.retainedOpenFiles().map(file => file.file.path),
    ['two.ts', 'three.ts'],
    'retention should evict the least-recent unprotected model',
  );
  await bounded.resolve('root-1', 'three.ts', { workspaceRoot: '/repo' });
  assert.strictEqual(boundedReads, 0);
  await bounded.resolve('root-1', 'one.ts', { workspaceRoot: '/repo' });
  assert.strictEqual(boundedReads, 1, 'an evicted model should use the ordinary authoritative path');
  bounded.dispose();

  console.log('test-workspace-file-model-manager passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
