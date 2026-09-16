import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFileService, WorkspaceFileError } from '../workspace-file-service.cjs';

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-watch-isolation-'));
  const service = new WorkspaceFileService({ watchOptions: { usePolling: true, interval: 20 } });
  const events: Array<{ type: string; path?: string; message?: string }> = [];
  try {
    const workspace = await fs.realpath(root);
    await fs.writeFile(path.join(root, 'current.md'), '# Current');
    await fs.mkdir(path.join(root, 'directory'));
    const subscription = await service.subscribeExactFiles(workspace, [
      'current.md', 'removed/deep/old.md', 'missing.md', 'directory',
    ], event => events.push(event));
    assert.deepEqual(subscription.paths, ['current.md']);
    assert.deepEqual(events.filter(event => event.type === 'error').map(event => event.path).sort(), [
      'directory', 'missing.md', 'removed/deep/old.md',
    ]);
    assert(!events.some(event => event.message?.includes('stay inside')));
    await fs.writeFile(path.join(root, 'current.md'), '# Changed');
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.type === 'change' && event.path === 'current.md')) {
      assert(Date.now() < deadline, 'a missing peer must not disable a valid watch');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await fs.mkdir(path.join(root, 'removed/deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'removed/deep/old.md'), '# Restored');
    await subscription.update(['current.md', 'removed/deep/old.md']);
    assert.deepEqual([...subscription.paths].sort(), ['current.md', 'removed/deep/old.md']);
    await subscription.close();
    await assert.rejects(service.writeFile(workspace, 'missing-parent/file.md', 'draft'),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 404);
    for (const invalid of ['', 'current.md/child.md']) {
      await assert.rejects(service.writeFile(workspace, invalid, 'draft'),
        (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 400);
    }
    await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
    await assert.rejects(service.resolvePath(workspace, 'outside/new.md', { allowMissing: true }),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 403);
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('workspace watch isolation passed');
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
