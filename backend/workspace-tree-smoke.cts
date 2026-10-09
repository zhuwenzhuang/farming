import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFileService, WorkspaceFileError } from './workspace-file-service.cjs';

async function runWorkspaceTreeSmoke() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'farming-workspace-tree-smoke-')));
  let service: WorkspaceFileService | undefined;
  try {
    // Directory pagination never invokes search. Use the service's explicit
    // test dependency input so this Worker smoke does not prepare ripgrep.
    service = new WorkspaceFileService({ rgPath: process.execPath });
    await fs.mkdir(path.join(root, 'folder'));
    const names = Array.from({ length: 64 }, (_, index) => `item-${String(index).padStart(3, '0')}.txt`);
    await Promise.all(names.map(name => fs.writeFile(path.join(root, name), 'fixture')));
    const maxPageBytes = 4096;
    const first = await service.listTreePage(root, '', { maxPageBytes });
    assert(first.nextCursor, 'Files smoke must cross a real Worker pagination boundary');
    assert.equal(first.items[0].name, 'folder', 'directories must precede files');
    await fs.writeFile(path.join(root, 'added-after-capture.txt'), 'excluded');
    const items = [...first.items];
    let cursor: string | null = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const page: typeof first = await service.listTreePage(root, '', { cursor, maxPageBytes });
      assert(Buffer.byteLength(JSON.stringify(page)) <= maxPageBytes, 'Files pages must remain byte bounded');
      items.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    }
    assert.deepEqual(items.map(item => item.name), ['folder', ...names], 'continuations must retain exact snapshot membership and order');
    await service.listTreePage(root, '', { cursor: first.nextCursor, release: true });
    await assert.rejects(service.listTreePage(root, '', { cursor: first.nextCursor }),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 409);
    return { entries: items.length, pages, snapshotStable: true, packaged: Boolean(process.pkg) };
  } finally {
    try { await service?.dispose(); }
    finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

export { runWorkspaceTreeSmoke };
