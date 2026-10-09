import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ReviewSessionService } from '../review-session-service.cjs';
import { ReviewSessionStore } from '../review-session-store.cjs';
import { ReviewStateStore } from '../review-state-store.cjs';
import { WorkspaceFileService } from '../workspace-file-service.cjs';
const exec = promisify(execFile);

async function run() {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'farming-review-reopen-')));
  const root = path.join(temporary, 'repo'), config = path.join(temporary, 'config');
  const files = new WorkspaceFileService({ rgPath: 'rg', gitStatusCacheTtlMs: 0 });
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args], { timeout: 10000 })).stdout.trim();
  try {
    await fs.mkdir(root);
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Review Test');
    await git('config', 'user.email', 'review@example.com');
    await git('config', 'core.hooksPath', '/dev/null');
    await fs.writeFile(path.join(root, 'a.txt'), 'base a\n');
    await fs.writeFile(path.join(root, 'b.txt'), 'base b\n');
    await git('add', '.'); await git('commit', '-m', 'Base');
    const base = await git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(root, 'a.txt'), 'candidate a\n');
    await fs.writeFile(path.join(root, 'b.txt'), 'candidate b\n');
    let sessions = new ReviewSessionStore(config), state = new ReviewStateStore(config);
    let service = new ReviewSessionService(files, sessions, state);
    const [first, simultaneous] = await Promise.all([service.create({ root }), service.create({ root })]);
    assert.equal(first.reviewId, simultaneous.reviewId, 'concurrent opens must converge');
    assert.equal(service.get(first.reviewId).revisions.length, 1);
    for (const file of ['a.txt', 'b.txt']) state.setFileReviewedGerrit({ reviewId: first.reviewId, patchset: first.head, path: file, reviewed: true });
    state.saveComment({ reviewId: first.reviewId, patchset: first.head, comment: {
      id: 'original-comment', body: 'Keep the original anchor', path: 'a.txt', line: 1, side: 'right', patchset: first.head,
    } });
    // Fresh store/service instances must reconcile from durable state alone.
    sessions = new ReviewSessionStore(config); state = new ReviewStateStore(config);
    service = new ReviewSessionService(files, sessions, state);
    const alias = path.join(temporary, 'alias'); await fs.symlink(root, alias);
    const reopened = await service.create({ root: alias });
    assert.equal(reopened.reviewId, first.reviewId);
    assert.equal(reopened.head, first.head);
    assert.deepEqual(state.getPatchsetState(reopened.reviewId, reopened.head).reviewedPaths, ['a.txt', 'b.txt']);
    await fs.writeFile(path.join(root, 'a.txt'), 'fixed a\n');
    const [second, refreshed] = await Promise.all([service.create({ root }), service.refresh(first.reviewId)]);
    assert.equal(second.reviewId, first.reviewId);
    assert.equal(second.number, 2);
    assert.equal(refreshed.head, second.head);
    assert.equal(service.get(first.reviewId).revisions.length, 2);
    assert.deepEqual(state.getPatchsetState(first.reviewId, second.head).reviewedPaths, ['b.txt']);
    assert.equal(state.getComments(first.reviewId, second.head)[0].outdated, true);
    const tracked = await service.create({ root, scope: 'tracked' });
    assert.notEqual(tracked.reviewId, first.reviewId, 'scope is part of lineage identity');
    const selected = await service.create({ root, paths: ['a.txt', 'b.txt'] });
    assert.equal((await service.create({ root, paths: ['b.txt', 'a.txt', 'a.txt'] })).reviewId, selected.reviewId);
    assert.notEqual((await service.create({ root, paths: [] })).reviewId, selected.reviewId);
    assert.notEqual((await service.create({ root, base: await git('rev-parse', 'HEAD^{tree}') })).reviewId, first.reviewId);

    // A failed inheritance write must never publish a revision.
    await fs.writeFile(path.join(root, 'a.txt'), 'third a\n');
    const writeState = state.writeJson;
    state.writeJson = () => { throw new Error('injected inheritance failure'); };
    await assert.rejects(service.create({ root }), /injected inheritance failure/);
    assert.equal(service.get(first.reviewId).head, second.head);
    state.writeJson = writeState;
    // A later manifest failure leaves prepared state. Retry recomputes it from
    // the still-published revision, including comments written after failure.
    const append = sessions.appendRevision.bind(sessions);
    sessions.appendRevision = () => { throw new Error('injected manifest failure'); };
    await assert.rejects(service.create({ root }), /injected manifest failure/);
    assert.equal(service.get(first.reviewId).head, second.head);
    sessions.appendRevision = append;
    state.saveComment({ reviewId: first.reviewId, patchset: second.head, comment: {
      id: 'after-failure', body: 'Do not lose this comment', path: 'b.txt', line: 1, side: 'right', patchset: second.head,
    } });
    sessions = new ReviewSessionStore(config); state = new ReviewStateStore(config);
    service = new ReviewSessionService(files, sessions, state);
    const third = await service.create({ root });
    assert.equal(third.number, 3);
    assert.equal(third.reviewId, first.reviewId);
    assert.ok(state.getComments(first.reviewId, third.head).some(comment => comment.id === 'after-failure'));
    assert.equal(state.getComments(first.reviewId, third.head)[0].sourcePatchset, first.head);
    assert.equal(await git('diff', '--cached', '--name-only'), '');

    // Old unrestricted captures are unambiguous; old explicit-path captures
    // could be ACP evidence and must not be guessed into workspace lineages.
    const legacyStore = new ReviewSessionStore(path.join(temporary, 'legacy'));
    const legacy = legacyStore.create({ id: legacyStore.newId(), root, base, tree: third.head });
    const legacyService = new ReviewSessionService(files, legacyStore);
    assert.equal((await legacyService.create({ root })).reviewId, legacy.id);
    const legacyPaths = legacyStore.create({ id: legacyStore.newId(), root, base, tree: third.head, paths: ['a.txt'] });
    assert.notEqual((await legacyService.create({ root, paths: ['a.txt'] })).reviewId, legacyPaths.id);
    console.log('test-review-reopen passed');
  } finally {
    await files.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
