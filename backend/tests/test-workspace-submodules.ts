import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceFileService } from '../workspace-file-service.cjs';
import { ReviewDiffService } from '../review-diff-service.cjs';
import { ReviewSessionService } from '../review-session-service.cjs';
import { ReviewSessionStore } from '../review-session-store.cjs';
import { ReviewStateStore } from '../review-state-store.cjs';

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function init(root: string) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
}
async function run() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farming-submodules-')));
  const root = path.join(temp, 'project');
  const source = path.join(temp, 'source');
  const files = new WorkspaceFileService({ gitStatusCacheTtlMs: 0 });
  try {
    init(source);
    fs.writeFileSync(path.join(source, 'code.txt'), 'before\ncontext\n');
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'Initial');
    init(root);
    fs.writeFileSync(path.join(root, 'main.txt'), 'main\n');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'lib');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'Parent base');
    const base = git(root, 'rev-parse', 'HEAD');
    const child = path.join(root, 'lib');
    git(child, 'config', 'core.hooksPath', '/dev/null');
    git(child, 'config', 'user.email', 'test@example.test'); git(child, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(child, 'code.txt'), 'committed change\ncontext\n');
    git(child, 'add', '.'); git(child, 'commit', '-qm', 'Child change');
    git(root, 'add', 'lib'); git(root, 'commit', '-qm', 'Parent head');
    const head = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(child, 'code.txt'), 'staged change\ncontext\n');
    git(child, 'add', 'code.txt');
    fs.writeFileSync(path.join(child, 'code.txt'), 'unstaged change\ncontext\n');
    fs.writeFileSync(path.join(child, 'new.txt'), 'new file\n');
    const parentIndex = fs.readFileSync(path.join(root, '.git/index'));
    const childIndexPath = path.resolve(child, git(child, 'rev-parse', '--git-path', 'index'));
    const childIndex = fs.readFileSync(childIndexPath);
    const changes = await files.changes(root, { repositories: true });
    assert.deepEqual(changes.repositories?.map(repo => repo.path), ['', 'lib']);
    const changed = changes.items.find(item => item.path === 'lib/code.txt');
    assert.equal(changed?.repositoryPath, 'lib');
    assert.equal(changed?.indexStatus, 'M'); assert.equal(changed?.workingTreeStatus, 'M');
    assert.equal(changes.items.find(item => item.path === 'lib/new.txt')?.gitStatus, 'untracked');
    assert.equal((await files.blameCapability(root, 'lib/code.txt')).available, true);
    assert.ok((await files.blame(root, 'lib/code.txt')).lines.length);
    assert.match(String((await files.diff(root, 'lib/code.txt')).patch), /unstaged change/);
    const reviews = new ReviewDiffService(null, files);
    const snapshot = await reviews.getGitRange(undefined, { root, base, head, metadataOnly: true });
    assert.deepEqual(snapshot.files.map(file => file.path), ['lib', 'lib/code.txt']);
    assert.equal(snapshot.files[0].submoduleError, undefined);
    const diff = await reviews.getGitRangeFile(undefined, { root, base, head, path: 'lib/code.txt', fileMeta: true });
    assert.match(JSON.stringify(diff), /committed change/);
    assert.doesNotMatch(JSON.stringify(diff), /unstaged change|staged change/);
    assert.equal(diff.path, 'lib/code.txt');
    const config = path.join(temp, 'config'); fs.mkdirSync(config);
    const sessions = new ReviewSessionService(files, new ReviewSessionStore(config), new ReviewStateStore(config));
    const capture = await sessions.create({ root: child, scope: 'tracked' });
    fs.writeFileSync(path.join(child, 'code.txt'), 'later edit\n');
    const captured = await reviews.getGitRangeFile(undefined, { root: child, base: capture.base, head: capture.head, path: 'code.txt' });
    assert.match(JSON.stringify(captured), /unstaged change/);
    assert.doesNotMatch(JSON.stringify(captured), /later edit/);
    assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), parentIndex);
    assert.deepEqual(fs.readFileSync(childIndexPath), childIndex);
    // The exact old/new commits still win after a later child checkout/working edit.
    assert.match(JSON.stringify(await reviews.getGitRangeFile(undefined, { root, base, head, path: 'lib/code.txt' })), /committed change/);
    const absent = '1'.repeat(40);
    git(root, 'update-index', '--cacheinfo', `160000,${absent},lib`);
    const unavailableTree = git(root, 'write-tree');
    const missing = await reviews.getGitRange(undefined, { root, base, head: unavailableTree, metadataOnly: true });
    assert.match(missing.files[0].submoduleError || '', /missing commit/);
    fs.renameSync(child, path.join(temp, 'parked-child')); fs.mkdirSync(child);
    const unavailable = await files.changes(root, { repositories: true });
    assert.match(unavailable.repositories?.find(repo => repo.path === 'lib')?.error || '', /not initialized/);
    console.log('test-workspace-submodules passed');
  } finally {
    await files.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
