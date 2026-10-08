import { packWorkspaceBlameLines, unpackWorkspaceBlameLines } from '../../shared/workspace-blame';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { WorkspaceFileService } = require('../workspace-file-service.cjs');
const { ReviewDiffService } = require('../review-diff-service.cjs');
const { resolveReviewTarget } = require('../farming-app-cli.cjs');
const exec = promisify(execFile);

async function run() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-git-reads-'));
  const files = new WorkspaceFileService({ rgPath: 'rg', gitStatusCacheTtlMs: 0 });
  const git = async (root: string, ...args: string[]) => (await exec('git', ['-C', root, ...args], { timeout: 10000 })).stdout.trim();
  const write = async (root: string, name: string, value: string) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), `${value}\n`); };
  const init = async (name: string) => {
    const root = path.join(temporary, name); await fs.mkdir(root);
    await git(root, 'init', '-b', 'main'); await git(root, 'config', 'user.name', 'Test');
    await git(root, 'config', 'user.email', 'test@example.com'); await git(root, 'config', 'core.hooksPath', '/dev/null');
    return root;
  };
  const commit = async (root: string) => { await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'fixture'); };
  try {
    const root = await init('main');
    for (const name of ['z[AB].txt', 'zA.txt', 'inside/a.txt']) await write(root, name, `base ${name}`);
    await commit(root);
    const original = await git(root, 'rev-parse', 'HEAD');
    for (const name of ['z[AB].txt', 'zA.txt', 'inside/a.txt']) await write(root, name, `changed ${name}`);
    const line = await files.lineChanges(root, 'z[AB].txt', 1, 'working');
    assert.match(line.patch, /changed z\[AB\]\.txt/); assert.doesNotMatch(line.patch, /changed zA\.txt/);
    assert.equal((await files.loadGitStatusForPath(path.join(root, 'inside'), 'a.txt')).kind, 'modified');
    assert.equal((await files.listTreeDecorations(path.join(root, 'inside'), '', ['a.txt'])).items[0].gitStatus, 'modified');
    assert.equal((await files.changes(path.join(root, 'inside'))).items[0].path, 'a.txt');
    assert.equal((await files.blameCapability(path.join(root, 'inside'), 'a.txt', { revision: original })).available, true);
    assert.equal((await files.blame(path.join(root, 'inside'), 'a.txt', original)).lines[0].content, 'base inside/a.txt');
    assert.equal((await files.changesPage(path.join(root, 'inside'), { scope: 'tracked' })).items[0].path, 'a.txt');
    await commit(root);
    const previous = await files.lineChanges(root, 'z[AB].txt', 1, 'previous');
    assert.match(previous.patch, /changed z\[AB\]\.txt/); assert.doesNotMatch(previous.patch, /changed zA\.txt/);

    // Staged snapshot generation and all display-only status paths preserve the
    // exact index, including its stat/cache-tree extensions and split format.
    const sources = new ReviewDiffService(null, files);
    for (const split of [false, true]) {
      if (split) await git(root, 'update-index', '--split-index');
      await write(root, 'inside/a.txt', `staged ${split}`); await git(root, 'add', 'inside/a.txt');
      const before = await fs.readFile(path.join(root, '.git/index'));
      const source = await sources.getComparisonSources(undefined, { root });
      assert.equal(await git(root, 'show', `${source.staged.head}:inside/a.txt`), `staged ${split}`);
      assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), before);
      await fs.utimes(path.join(root, 'inside/a.txt'), new Date(100000), new Date(100000));
      await files.changeSnapshot(root); await files.loadGitStatusForPath(root, 'inside/a.txt');
      assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), before);
    }
    await git(root, 'update-index', '--no-split-index');
    await commit(root);
    await git(root, 'checkout', '--detach', 'HEAD');
    assert.equal(resolveReviewTarget({ gitDir: root, base: 'HEAD', head: 'now' }).base, await git(root, 'rev-parse', 'HEAD'));
    assert.equal((await sources.getComparisonSources(undefined, { root })).currentBranch, 'Detached HEAD');
    await git(root, 'checkout', 'main');

    // A concurrent commit cannot splice the old HEAD into the new index tree.
    const originalGit = sources.git.bind(sources);
    let moved = false;
    sources.git = async (directory: string, args: string[], options: Record<string, unknown>) => {
      const result = await originalGit(directory, args, options);
      if (!moved && args.join(' ') === 'rev-parse --verify HEAD') {
        moved = true; await write(root, 'inside/a.txt', 'concurrent'); await commit(root);
      }
      return result;
    };
    await assert.rejects(sources.getComparisonSources(undefined, { root }), (error: { statusCode: number }) => error.statusCode === 409);
    sources.git = originalGit;

    await git(root, 'checkout', '-b', 'other'); await write(root, 'inside/a.txt', 'other'); await commit(root);
    await git(root, 'checkout', 'main'); await write(root, 'inside/a.txt', 'main'); await commit(root);
    await assert.rejects(git(root, 'merge', 'other'));
    const conflicted = await sources.getComparisonSources(undefined, { root });
    assert.equal(conflicted.staged.available, false); assert.equal(conflicted.staged.head, null);
    assert.match(conflicted.staged.unavailableReason, /conflict/); assert.ok(conflicted.commits.length);
    assert.equal(conflicted.unstaged.available, false);
    await git(root, 'merge', '--abort');

    // Fresh Tracked reads never enumerate untracked files. Cursor reads reuse
    // the captured inventory, and explicit invalidation/expiry reject reuse.
    await write(root, 'inside/a.txt', 'pending');
    const realExec = files.execFile.bind(files);
    const calls: string[][] = [];
    files.execFile = async (command: string, args: string[], options: Record<string, unknown>) => { calls.push(args); return realExec(command, args, options); };
    const page = await files.changesPage(root, { scope: 'tracked', limit: 1 });
    assert.ok(calls.some(args => args.includes('--untracked-files=no')));
    assert.ok(!calls.some(args => args.includes('--untracked-files=all')));
    const count = calls.length;
    await files.changesPage(root, { scope: 'tracked', cursor: `${page.revision}:0` });
    assert.equal(calls.length, count);
    const cached = files.changeInventories.get(await fs.realpath(root)); cached.expiresAt = 0;
    await assert.rejects(files.changesPage(root, { scope: 'tracked', cursor: `${page.revision}:0` }), /Refresh/);
    const inventory = await files.changesInventory(root);
    files.invalidateGitStatus(await fs.realpath(root));
    await assert.rejects(files.changesPage(root, { scope: 'tracked', cursor: `${inventory.repositories[0].revision}:0` }), /Refresh/);
    calls.length = 0;
    await files.diff(root, 'inside/a.txt'); await files.diff(root, 'inside/a.txt');
    for (const args of calls.filter(args => args.includes('status'))) assert.ok(args.includes(':(literal)inside/a.txt'));
    files.execFile = realExec;

    const sha256 = path.join(temporary, 'sha256'); await fs.mkdir(sha256);
    await git(sha256, 'init', '--object-format=sha256');
    await git(sha256, 'config', 'user.name', 'Test'); await git(sha256, 'config', 'user.email', 'test@example.com');
    await git(sha256, 'config', 'core.hooksPath', '/dev/null');
    await write(sha256, 'file.txt', 'SHA256 content'); await commit(sha256);
    const sha256Head = await git(sha256, 'rev-parse', 'HEAD');
    assert.equal(sha256Head.length, 64);
    assert.equal((await files.blameCapability(sha256, 'file.txt', { revision: sha256Head })).available, true);
    const sha256Blame = unpackWorkspaceBlameLines(await files.blamePage(sha256, 'file.txt', sha256Head));
    assert.equal(sha256Blame[0].commit, sha256Head); assert.equal(sha256Blame[0].content, 'SHA256 content');

    const unborn = await init('unborn');
    await write(unborn, 'new.txt', 'new'); await git(unborn, 'add', 'new.txt');
    assert.equal((await files.loadGitStatusForPath(unborn, 'new.txt')).kind, 'added');
    const plain = path.join(temporary, 'plain'); await fs.mkdir(plain);
    const plainInventory = await files.changesInventory(plain);
    assert.deepEqual((await files.changesPage(plain, { scope: 'tracked', cursor: `${plainInventory.repositories[0].revision}:0` })).items, []);

    // A complete Project inventory retains every child, beyond eight repos.
    const many = await init('many');
    for (let index = 0; index < 8; index++) {
      await git(many, '-c', 'protocol.file.allow=always', 'submodule', 'add', root, `child-${index}`);
      await write(many, `child-${index}/new.txt`, 'pending');
    }
    const manyInventory = await files.changesInventory(many);
    assert.equal(manyInventory.repositories.length, 9);
    for (const repository of manyInventory.repositories) {
      assert.equal(repository.error, undefined);
      await files.changesPage(many, { repositoryPath: repository.path, scope: 'untracked', cursor: `${repository.revision}:0` });
    }

    // An invalidation between capture and publication cannot resurrect a stale
    // inventory. A newer fresh read also wins over a late older request.
    const realSnapshot = files.changeSnapshot.bind(files);
    files.changeSnapshot = async (...args: [string, 'tracked' | 'untracked' | undefined]) => {
      const snapshot = await realSnapshot(...args);
      files.invalidateGitStatus(await fs.realpath(root));
      return snapshot;
    };
    await assert.rejects(files.changesInventory(root), /Refresh/);
    files.changeSnapshot = realSnapshot;
    let release!: () => void;
    let captured!: () => void;
    const ready = new Promise<void>(resolve => { captured = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let hold = true;
    files.changeSnapshot = async (...args: [string, 'tracked' | 'untracked' | undefined]) => {
      const snapshot = await realSnapshot(...args);
      if (hold) { hold = false; captured(); await gate; }
      return snapshot;
    };
    const older = files.changesPage(root, { scope: 'tracked' });
    try {
      await ready;
      const newer = await files.changesPage(root, { scope: 'tracked' });
      release();
      await assert.rejects(older, /Refresh/);
      await files.changesPage(root, { scope: 'tracked', cursor: `${newer.revision}:0` });
    } finally { release(); files.changeSnapshot = realSnapshot; }

    for (const disableHelper of [false, true]) {
      const service = new WorkspaceFileService({ rgPath: 'rg', commandRunnerOptions: { disableHelper } });
      try {
        await write(root, '.gitignore', '*.ignored'); await write(root, 'with\nnewline.ignored', 'ignored');
        assert.deepEqual([...await service.loadGitIgnoredPaths(root, ['with\nnewline.ignored'])], ['with\nnewline.ignored']);
      } finally { await service.dispose(); }
    }
    // Thousands of lines exceed one WebSocket frame after blame metadata is
    // expanded. Pages preserve the captured version even if disk changes.
    const bigContent = Array.from({ length: 6000 }, (_, index) => `source line ${index} ${'x'.repeat(200)}`).join('\n') + '\n';
    await fs.writeFile(path.join(root, 'big.txt'), bigContent); await commit(root);
    const first = await files.blamePage(root, 'big.txt');
    assert.ok(first.nextCursor); assert.equal(first.total, 6000);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1024 * 1024 - 4096);
    await fs.writeFile(path.join(root, 'big.txt'), 'changed while paging\n');
    const lines = unpackWorkspaceBlameLines(first);
    let wireBytes = Buffer.byteLength(JSON.stringify(first));
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await files.blamePage(root, 'big.txt', undefined, cursor);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024 - 4096);
      lines.push(...unpackWorkspaceBlameLines(page)); cursor = page.nextCursor;
      wireBytes += Buffer.byteLength(JSON.stringify(page));
    }
    assert.equal(lines.map(line => line.content).join('\n') + '\n', bigContent);
    assert.ok(wireBytes < Buffer.byteLength(JSON.stringify(lines)) * 0.5);
    const shortLines = lines.map(line => ({ ...line, content: 'short content' }));
    const packed = packWorkspaceBlameLines(shortLines, 0, 1024 * 1024);
    assert.equal(packed.commits.length, 1); assert.equal(packed.ranges.length, 1);
    assert.deepEqual(unpackWorkspaceBlameLines(packed), shortLines);
    const rawBytes = Buffer.byteLength(JSON.stringify(shortLines));
    const compactBytes = Buffer.byteLength(JSON.stringify(packed));
    assert.ok(compactBytes < rawBytes * 0.1);
    console.log(`blame compact transfer: ${rawBytes} -> ${compactBytes} bytes`);
    await assert.rejects(files.blamePage(root, 'inside/a.txt', undefined, first.nextCursor), (error: { statusCode: number }) => error.statusCode === 409);
    files.blameSnapshots.get(first.nextCursor.split(':')[0]).expiresAt = 0;
    await assert.rejects(files.blamePage(root, 'big.txt', undefined, first.nextCursor), (error: { details: { reason: string } }) => error.details.reason === 'snapshot-stale');

    const failed = new WorkspaceFileService({ commandRunner: { run: async (_command: string, _args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => {
      assert.ok(options.timeout > 0); assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    }, dispose() {} } });
    try {
      await assert.rejects(failed.loadGitStatusForPath(root, 'inside/a.txt'), (error: { statusCode: number }) => error.statusCode === 504);
      await assert.rejects(failed.loadGitIgnoredPaths(root, ['inside/a.txt']), (error: { statusCode: number }) => error.statusCode === 504);
    } finally { await failed.dispose(); }
  } finally { await files.dispose(); await fs.rm(temporary, { recursive: true, force: true }); }
}
run().then(() => console.log('git read boundaries passed')).catch(error => { console.error(error); process.exitCode = 1; });
