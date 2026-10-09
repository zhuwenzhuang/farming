import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { WorkspaceFileService } from '../workspace-file-service.cjs';

const exec = promisify(execFile);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'operation did not reach its admission boundary');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function run() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-workspace-concurrency-'));
  const root = await fs.realpath(temporary);
  const child = path.join(root, 'child');
  const other = path.join(root, 'other');
  await fs.mkdir(child); await fs.mkdir(other);
  const service = new WorkspaceFileService({ gitStatusCacheTtlMs: 30_000 });
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args], { timeout: 10000 })).stdout.trim();
  try {
    // Late success and late failure must neither replace nor delete the new
    // cache owner after invalidation. Include nested Project invalidation.
    const originalLoad = service.loadGitStatusByPath.bind(service);
    for (const fail of [false, true]) {
      service.invalidateGitStatus(root);
      const old = deferred<Awaited<ReturnType<typeof originalLoad>>>();
      let count = 0;
      service.loadGitStatusByPath = async () => ++count === 1 ? old.promise
        : new Map([['child/file.txt', { path: 'child/file.txt', kind: 'modified' }]]);
      const oldRead = service.getGitStatusByPath(root);
      const oldSettled = oldRead.catch(error => error);
      service.invalidateGitStatus(child);
      const fresh = await service.getGitStatusByPath(root);
      assert.ok(fresh.has('child/file.txt'));
      if (fail) old.reject(new Error('old Git read failed')); else old.resolve(new Map());
      await oldSettled;
      assert.equal(await service.getGitStatusByPath(root), fresh);
      assert.equal(count, 2);
    }
    service.loadGitStatusByPath = originalLoad;

    // Child -> parent -> child remains ordered across overlapping roots.
    const held = deferred<void>();
    const started = deferred<void>();
    const order: string[] = [];
    const first = service.runWorkspaceMutation(child, async () => { order.push('first'); started.resolve(); await held.promise; });
    await started.promise;
    const second = service.runWorkspaceMutation(root, async () => { order.push('second'); });
    let third: Promise<void> | undefined;
    let failure: unknown;
    try {
      await waitFor(() => service.mutationQueues.size === 2);
      third = service.runWorkspaceMutation(child, async () => { order.push('third'); });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(order, ['first']);
    } catch (error) { failure = error; }
    finally { held.resolve(); await Promise.allSettled([first, second, third]); }
    if (failure) throw failure;
    assert.deepEqual(order, ['first', 'second', 'third']);
    assert.equal(service.mutationQueues.size, 0);

    const heldChild = deferred<void>();
    const childStarted = deferred<void>();
    const holding = service.runWorkspaceMutation(child, async () => { childStarted.resolve(); await heldChild.promise; });
    await childStarted.promise;
    const independent = service.runWorkspaceMutation(other, async () => { order.push('independent'); });
    try { await waitFor(() => order.includes('independent')); }
    finally { heldChild.resolve(); await Promise.allSettled([holding, independent]); }
    await assert.rejects(service.runWorkspaceMutation(root, async () => { throw new Error('fixture mutation failed'); }), /fixture mutation failed/);
    assert.equal(service.mutationQueues.size, 0);

    // Version validation stays inside that overlapping-root admission.
    await fs.writeFile(path.join(child, 'file.txt'), 'base\n');
    const base = await service.readFile(root, 'child/file.txt');
    const writing = deferred<void>();
    const releaseWrite = deferred<void>();
    const originalFlush = service.flushWorkspaceFileHandle.bind(service);
    service.flushWorkspaceFileHandle = async () => { writing.resolve(); await releaseWrite.promise; };
    const parentSave = service.writeFile(root, 'child/file.txt', 'parent edit\n', { baseSha1: base.sha1 });
    await writing.promise;
    const childSave = service.writeFile(child, 'file.txt', 'child edit\n', { baseSha1: base.sha1 });
    const saves = Promise.allSettled([parentSave, childSave]);
    try { await waitFor(() => service.mutationQueues.size === 2); }
    finally { releaseWrite.resolve(); service.flushWorkspaceFileHandle = originalFlush; await saves; }
    const results = await saves;
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    if (results[1].status === 'rejected') assert.equal(results[1].reason.statusCode, 409);
    assert.equal(await fs.readFile(path.join(child, 'file.txt'), 'utf8'), 'parent edit\n');
    assert.equal(service.mutationQueues.size, 0);

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test');
    await git('config', 'core.hooksPath', '/dev/null');
    for (const name of ['A', 'B', 'C', 'D']) {
      await fs.writeFile(path.join(root, 'history.txt'), name);
      await git('add', '.'); await git('commit', '-qm', name);
    }
    await git('tag', '-a', 'annotated', '-m', 'tag', 'HEAD~1');
    const firstPage = await service.gitHistory(root, { limit: 2 });
    const allPage = await service.gitHistory(root, { limit: 2, scope: 'all' });
    assert.ok(firstPage.nextCursor); assert.ok(allPage.nextCursor);
    await git('reset', '--hard', 'HEAD~1');
    await git('tag', '-d', 'annotated');
    await git('checkout', '-qb', 'new-branch');
    await fs.writeFile(path.join(root, 'history.txt'), 'E'); await git('add', '.'); await git('commit', '-qm', 'E');
    for (const [page, scope] of [[firstPage, 'current'], [allPage, 'all']] as const) {
      const next = await service.gitHistory(root, { limit: 2, scope, cursor: page.nextCursor });
      assert.deepEqual([...page.items, ...next.items].map(item => item.subject), ['D', 'C', 'B', 'A']);
      assert.equal(next.head, page.head); assert.equal(next.branch, 'main');
      assert.ok(page.items.find(item => item.subject === 'C')?.references.some(ref => ref.name === 'annotated'));
    }
    await assert.rejects(service.gitHistory(root, { cursor: firstPage.nextCursor, scope: 'all' }), /snapshot expired/);
    await assert.rejects(service.gitHistory(child, { cursor: firstPage.nextCursor }), /snapshot expired/);
    await assert.rejects(service.gitHistory(root, { skip: 2 }), /requires a snapshot cursor/);
    await assert.rejects(service.gitHistory(root, { cursor: 'invalid' }), /Invalid history cursor/);

    // A commit between reference capture and log cannot change the result's
    // head, graph or decorations. A fresh read alone adopts the new commit.
    const originalExec = service.execFile.bind(service);
    for (const failingRead of [1, 2]) {
      let branchReads = 0;
      const snapshotsBefore = service.historySnapshots.size;
      service.execFile = async (command, args, options) => {
        if (args.includes('branch') && ++branchReads === failingRead) {
          throw Object.assign(new Error('fixture branch deadline'), { code: 'ETIMEDOUT' });
        }
        return originalExec(command, args, options);
      };
      try {
        await assert.rejects(service.gitHistory(root), error => {
          const failure = error as { statusCode?: number; message?: string; details?: { reason?: string } };
          assert.equal(failure.statusCode, 504);
          assert.match(failure.message || '', /Git branch timed out/);
          assert.notEqual(failure.details?.reason, 'snapshot-stale');
          return true;
        });
        assert.equal(service.historySnapshots.size, snapshotsBefore);
      } finally { service.execFile = originalExec; }
    }
    const capturedHead = await git('rev-parse', 'HEAD');
    let changed = false;
    service.execFile = async (command, args, options) => {
      if (!changed && args.includes('log')) {
        changed = true;
        await fs.writeFile(path.join(root, 'history.txt'), 'F'); await git('add', '.'); await git('commit', '-qm', 'F');
      }
      return originalExec(command, args, options);
    };
    const captured = await service.gitHistory(root, { limit: 2 });
    service.execFile = originalExec;
    assert.equal(captured.head, capturedHead); assert.equal(captured.items[0].id, capturedHead);
    assert.ok(captured.items[0].references.some(ref => ref.id === 'HEAD'));
    assert.equal((await service.gitHistory(root)).items[0].subject, 'F');
    for (const snapshot of service.historySnapshots.values()) snapshot.expiresAt = 0;
    await assert.rejects(service.gitHistory(root, { cursor: firstPage.nextCursor }), /snapshot expired/);
    for (let i = 0; i < 18; i++) await service.gitHistory(root, { limit: 1 });
    assert.equal(service.historySnapshots.size, 16);
  } finally {
    await service.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
run().then(() => console.log('workspace concurrency passed')).catch(error => { console.error(error); process.exitCode = 1; });
