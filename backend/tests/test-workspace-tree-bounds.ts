import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceFileService, WorkspaceFileError } from '../workspace-file-service.cjs';

async function run() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'farming-tree-bounds-')));
  const service = new WorkspaceFileService();
  const originalLstat = fs.lstat;
  try {
    const large = path.join(root, 'large');
    await fs.mkdir(large);
    // A real directory exceeds the protocol's 4096-entry decoration budget.
    for (let start = 0; start < 4097; start += 32) {
      await Promise.all(Array.from({ length: Math.min(32, 4097 - start) }, (_, i) =>
        fs.writeFile(path.join(large, `entry-${start + i}`), '')));
    }
    let metadataReads = 0;
    fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).startsWith(`${large}${path.sep}`)) metadataReads += 1;
      return originalLstat(...args);
    }) as typeof fs.lstat;
    await assert.rejects(service.listTree(root, 'large'), (error: unknown) =>
      error instanceof WorkspaceFileError && error.statusCode === 413);
    assert.equal(metadataReads, 0, 'reject oversized enumeration before allocating per-entry metadata work');

    await fs.unlink(path.join(large, 'entry-4096'));
    const boundary = await service.listTree(root, 'large');
    assert.equal(boundary.items.length, 4096, 'the exact boundary remains a complete snapshot');

    const small = path.join(root, 'small');
    await fs.mkdir(small);
    for (let i = 0; i < 64; i++) await fs.writeFile(path.join(small, `file-${i}`), '');
    let active = 0;
    let peak = 0;
    let started = 0;
    const controller = new AbortController();
    fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
      if (!String(args[0]).startsWith(`${small}${path.sep}`)) return originalLstat(...args);
      active += 1;
      started += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (started >= 16) controller.abort(new Error('tree cancelled'));
        return await originalLstat(...args);
      } finally { active -= 1; }
    }) as typeof fs.lstat;
    await assert.rejects(service.listTree(root, 'small', { signal: controller.signal }), /tree cancelled/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert(peak <= 16, `metadata concurrency must be bounded, observed ${peak}`);
    assert(started <= 16, 'cancelled reads cannot keep scheduling metadata work');
    assert.equal(active, 0);
    fs.lstat = originalLstat;
    assert.equal((await service.listTree(root, 'small')).items.length, 64, 'a later explicit read can recover');
    const cancelled = new AbortController();
    cancelled.abort(new Error('already cancelled'));
    await assert.rejects(service.listTree(root, 'small', { signal: cancelled.signal }), /already cancelled/);
    console.log('workspace tree bounds tests passed');
  } finally {
    fs.lstat = originalLstat;
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
