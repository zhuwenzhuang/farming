import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';

import { WorkspaceFileService, WorkspaceFileError } from '../workspace-file-service.cjs';

async function run() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'farming-tree-bounds-')));
  const service = new WorkspaceFileService();
  const originalLstat = fs.lstat;
  try {
    const large = path.join(root, 'large');
    await fs.mkdir(large);
    // Real on-disk directory, beyond the former 4096-entry rejection.
    for (let start = 0; start < 10_000; start += 32) {
      await Promise.all(Array.from({ length: Math.min(32, 10_000 - start) }, (_, i) =>
        fs.writeFile(path.join(large, `entry-${String(start + i).padStart(5, '0')}`), '')));
    }
    await fs.mkdir(path.join(large, 'z-directory'));
    const budget = 32 * 1024;
    const first = await service.listTreePage(root, 'large', { maxPageBytes: budget });
    assert(first.nextCursor);
    assert.equal(first.items[0].name, 'z-directory', 'directories precede files');
    assert(first.items.every(item => item.version), 'mutation identity guards survive pagination');
    await fs.writeFile(path.join(large, 'added-after-first-page'), '');
    const items = [...first.items];
    let cursor = first.nextCursor;
    let lastCursor = cursor;
    while (cursor) {
      lastCursor = cursor;
      const page = await service.listTreePage(root, 'large', { cursor, maxPageBytes: budget });
      assert(Buffer.byteLength(JSON.stringify(page)) <= budget);
      assert(page.items.length <= 4096);
      items.push(...page.items);
      cursor = page.nextCursor;
    }
    assert.equal(items.length, 10_001);
    assert.equal(new Set(items.map(item => item.path)).size, items.length);
    assert(!items.some(item => item.name === 'added-after-first-page'), 'continuations cannot mix snapshots');
    assert.equal(items.at(-1)?.name, 'entry-09999');
    assert.equal((await service.listTreePage(root, 'large', { cursor: lastCursor!, maxPageBytes: budget })).nextCursor, null,
      'a lost final response can be replayed');
    await assert.rejects(service.listTreePage(root, '', { cursor: first.nextCursor! }),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 409);
    await assert.rejects(service.listTreePage(root, 'large', { cursor: 'invalid' }),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 400);
    await service.listTreePage(root, 'large', { cursor: first.nextCursor!, release: true });
    await assert.rejects(service.listTreePage(root, 'large', { cursor: first.nextCursor! }),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 409);
    // Real timers are reclaimed even when a cancelled first response loses its cursor.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const expiring = await service.listTreePage(root, 'large', { maxPageBytes: budget });
      mock.timers.tick(60_001);
      await assert.rejects(service.listTreePage(root, 'large', { cursor: expiring.nextCursor! }),
        (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 409);
    } finally { mock.timers.reset(); }

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
    const oldest = await service.listTreePage(root, 'small', { maxPageBytes: 1024 });
    assert(oldest.nextCursor);
    await assert.rejects(service.listTreePage(root, 'small', { cursor: oldest.nextCursor!, allowedExternalRoots: [root] }),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 409);
    for (let i = 0; i < 8; i++) await service.listTreePage(root, 'small', { maxPageBytes: 1024 });
    await assert.rejects(service.listTreePage(root, 'small', { cursor: oldest.nextCursor! }),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 409,
      'snapshot retention is bounded');
    await fs.symlink(small, path.join(root, 'alias'));
    const linked = await service.listTreePage(root, 'alias', { maxPageBytes: 1024 });
    await fs.unlink(path.join(root, 'alias'));
    await fs.symlink(large, path.join(root, 'alias'));
    await assert.rejects(service.listTreePage(root, 'alias', { cursor: linked.nextCursor! }),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 409,
      'a retargeted symlink cannot reuse the old snapshot');
    console.log('workspace tree bounds tests passed');
  } finally {
    fs.lstat = originalLstat;
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
