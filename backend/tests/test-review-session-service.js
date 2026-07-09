const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { ReviewSessionService, changedPathsFromNameStatus } = require('../review-session-service');
const { ReviewSessionStore } = require('../review-session-store');
const { ReviewStateStore } = require('../review-state-store');

const execFile = promisify(childProcess.execFile);

async function git(root, ...args) {
  const { stdout } = await execFile('git', ['-C', root, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

async function run() {
  assert.deepStrictEqual(changedPathsFromNameStatus(['M', 'src/a.ts', 'R100', 'old.ts', 'new.ts', ''].join('\0')), [
    'src/a.ts',
    'old.ts',
    'new.ts',
  ]);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-session-'));
  const repository = path.join(temporaryRoot, 'repo');
  const configDir = path.join(temporaryRoot, 'config');
  fs.mkdirSync(repository);
  try {
    await git(repository, 'init');
    await git(repository, 'config', 'user.email', 'review@example.com');
    await git(repository, 'config', 'user.name', 'Review Test');
    fs.writeFileSync(path.join(repository, 'a.txt'), 'a0\n');
    fs.writeFileSync(path.join(repository, 'b.txt'), 'b0\n');
    await git(repository, 'add', 'a.txt', 'b.txt');
    await git(repository, 'commit', '-m', 'base');
    const base = await git(repository, 'rev-parse', 'HEAD');

    fs.writeFileSync(path.join(repository, 'a.txt'), 'a1\n');
    fs.writeFileSync(path.join(repository, 'b.txt'), 'b1\n');
    fs.writeFileSync(path.join(repository, 'untracked.txt'), 'new\n');
    fs.writeFileSync(path.join(repository, 'old-untracked.txt'), 'old\n');
    const oldUntrackedTime = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(repository, 'old-untracked.txt'), oldUntrackedTime, oldUntrackedTime);

    const fileService = {
      diffMaxBuffer: 8 * 1024 * 1024,
      diffTimeoutMs: 10_000,
      gitPath: 'git',
      execFile,
      async changes() {
        return {
          items: [
            { gitStatus: 'modified', path: 'a.txt' },
            { gitStatus: 'modified', path: 'b.txt' },
            { gitStatus: 'untracked', path: 'old-untracked.txt' },
            { gitStatus: 'untracked', path: 'untracked.txt' },
          ],
          truncated: false,
        };
      },
    };
    const sessionStore = new ReviewSessionStore(configDir);
    const stateStore = new ReviewStateStore(configDir);
    const service = new ReviewSessionService(fileService, sessionStore, stateStore);
    const tracked = await service.create({ base: 'HEAD', root: repository, scope: 'tracked' });
    assert.strictEqual(tracked.scope, 'tracked');
    assert.strictEqual(await git(repository, 'show', `${tracked.head}:a.txt`), 'a1');
    await assert.rejects(() => git(repository, 'show', `${tracked.head}:untracked.txt`));
    const untracked = await service.create({ base: 'HEAD', modifiedWithinDays: 3, root: repository, scope: 'untracked' });
    assert.strictEqual(untracked.scope, 'untracked');
    assert.strictEqual(untracked.modifiedWithinDays, 3);
    assert.strictEqual(await git(repository, 'show', `${untracked.head}:a.txt`), 'a0');
    assert.strictEqual(await git(repository, 'show', `${untracked.head}:untracked.txt`), 'new');
    await assert.rejects(() => git(repository, 'show', `${untracked.head}:old-untracked.txt`));
    const first = await service.create({ base: 'HEAD', root: repository });

    assert.strictEqual(first.base, base);
    assert.match(first.reviewId, /^review-[a-f0-9]{32}$/);
    assert.match(first.head, /^[a-f0-9]{40}$/);
    assert.strictEqual(await git(repository, 'show', `${first.head}:a.txt`), 'a1');
    assert.strictEqual(await git(repository, 'show', `${first.head}:untracked.txt`), 'new');
    assert.strictEqual(await git(repository, 'diff', '--cached', '--name-only'), '', 'capture must not modify the real index');
    assert.strictEqual(await git(repository, 'rev-parse', `refs/farming/reviews/${first.reviewId}/1`), first.head);
    service.assertRange(first.reviewId, repository, first.base, first.head);

    stateStore.setFileReviewedGerrit({ reviewId: first.reviewId, patchset: first.head, path: 'a.txt', reviewed: true });
    stateStore.setFileReviewedGerrit({ reviewId: first.reviewId, patchset: first.head, path: 'b.txt', reviewed: true });
    stateStore.saveComment({
      reviewId: first.reviewId,
      patchset: first.head,
      comment: { body: 'Fix a.', id: 'a-note', line: 1, patchset: first.head, path: 'a.txt', side: 'right' },
    });
    stateStore.saveComment({
      reviewId: first.reviewId,
      patchset: first.head,
      comment: { body: 'Keep b.', id: 'b-note', line: 1, patchset: first.head, path: 'b.txt', side: 'right' },
    });

    fs.writeFileSync(path.join(repository, 'a.txt'), 'a2\n');
    const second = await service.refresh(first.reviewId);
    assert.strictEqual(second.unchanged, false);
    assert.deepStrictEqual(second.changedPaths, ['a.txt']);
    assert.strictEqual(second.fixesBase, first.head);
    assert.strictEqual(await git(repository, 'show', `${second.head}:a.txt`), 'a2');
    assert.strictEqual(await git(repository, 'show', `${first.head}:a.txt`), 'a1', 'captured revisions must remain immutable');
    assert.strictEqual(await git(repository, 'diff', '--cached', '--name-only'), '', 'refresh must not modify the real index');
    service.assertRange(first.reviewId, repository, first.head, second.head);
    service.assertRange(first.reviewId, repository, first.base, second.head);

    const inherited = stateStore.getPatchsetState(first.reviewId, second.head);
    assert.deepStrictEqual(inherited.reviewedPaths, ['b.txt']);
    assert.deepStrictEqual(inherited.comments.map(comment => ({ id: comment.id, patchset: comment.patchset, status: comment.status })), [
      { id: 'a-note', patchset: second.head, status: 'outdated' },
      { id: 'b-note', patchset: second.head, status: 'open' },
    ]);

    const unchanged = await service.refresh(first.reviewId);
    assert.strictEqual(unchanged.unchanged, true);
    assert.strictEqual(unchanged.head, second.head);
    assert.strictEqual(service.get(first.reviewId).revisions.length, 2);
    assert.throws(() => service.assertRange(first.reviewId, repository, base, '0'.repeat(40)), /does not belong/);

    console.log('test-review-session-service passed');
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
