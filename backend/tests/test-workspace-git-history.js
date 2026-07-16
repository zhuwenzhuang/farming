const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  WorkspaceFileService,
  parseGitHistoryChanges,
  parseGitHistoryReferences,
} = require('../workspace-file-service');

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(root, ...args) {
  return String(execFileSync('git', args, { cwd: root, encoding: 'utf8' }) || '').trim();
}

function commitFile(root, filePath, content, subject, body = '') {
  const absolutePath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  git(root, 'add', filePath);
  const messageArgs = body ? ['-m', subject, '-m', body] : ['-m', subject];
  git(root, 'commit', ...messageArgs);
  return git(root, 'rev-parse', 'HEAD');
}

async function run() {
  assert.deepStrictEqual(parseGitHistoryReferences(
    'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0, refs/remotes/origin/HEAD'
  ), [
    { id: 'HEAD', name: 'HEAD', category: 'head' },
    { id: 'refs/heads/main', name: 'main', category: 'local-branch' },
    { id: 'refs/remotes/origin/main', name: 'origin/main', category: 'remote-branch' },
    { id: 'refs/tags/v1.0', name: 'v1.0', category: 'tag' },
  ]);
  assert.deepStrictEqual(parseGitHistoryChanges('R100\0old.ts\0new.ts\0C087\0a.ts\0b.ts\0M\0src/app.ts\0'), [
    { path: 'new.ts', previousPath: 'old.ts', status: 'renamed', statusLabel: 'R' },
    { path: 'b.ts', previousPath: 'a.ts', status: 'copied', statusLabel: 'C' },
    { path: 'src/app.ts', status: 'modified', statusLabel: 'M' },
  ]);

  if (!hasGit()) {
    console.log('test-workspace-git-history passed (git unavailable, integration skipped)');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-git-history-'));
  const repository = path.join(tmpRoot, 'repository');
  const emptyRepository = path.join(tmpRoot, 'empty');
  const plainDirectory = path.join(tmpRoot, 'plain');
  fs.mkdirSync(repository);
  fs.mkdirSync(emptyRepository);
  fs.mkdirSync(plainDirectory);
  git(repository, 'init', '--quiet');
  git(repository, 'branch', '-m', 'main');
  fs.mkdirSync(path.join(repository, '.empty-hooks'));
  git(repository, 'config', 'core.hooksPath', '.empty-hooks');
  git(repository, 'config', 'user.email', 'history@example.test');
  git(repository, 'config', 'user.name', 'History Test');
  const rootCommit = commitFile(repository, 'base.txt', 'base\n', 'root');

  git(repository, 'checkout', '-b', 'topic');
  const topicCommit = commitFile(repository, 'topic.txt', 'topic\n', 'topic');
  git(repository, 'checkout', 'main');
  const mainCommit = commitFile(repository, 'main.txt', 'main\n', 'main', 'Explain the main-line change.');
  git(repository, 'merge', '--no-ff', 'topic', '-m', 'merge topic');
  const mergeCommit = git(repository, 'rev-parse', 'HEAD');

  git(emptyRepository, 'init', '--quiet');
  git(emptyRepository, 'branch', '-m', 'main');

  const service = new WorkspaceFileService();
  try {
    const pageOne = await service.gitHistory(repository, { limit: 2 });
    assert.strictEqual(pageOne.isGitRepo, true);
    assert.strictEqual(pageOne.branch, 'main');
    assert.strictEqual(pageOne.head, mergeCommit);
    assert.strictEqual(pageOne.scope, 'current');
    assert.strictEqual(pageOne.items.length, 2);
    assert.strictEqual(pageOne.items[0].id, mergeCommit);
    assert.deepStrictEqual(new Set(pageOne.items[0].parentIds), new Set([mainCommit, topicCommit]));
    assert(pageOne.items[0].references.some(reference => reference.id === 'HEAD'));
    assert(pageOne.items[0].references.some(reference => reference.name === 'main'));
    assert(pageOne.items[1].message.includes('Explain the main-line change.'));
    assert.strictEqual(pageOne.hasMore, true);
    assert.strictEqual(pageOne.nextSkip, 2);

    const pageTwo = await service.gitHistory(repository, { limit: 2, skip: pageOne.nextSkip });
    assert.strictEqual(pageTwo.items.length, 1);
    assert.strictEqual(pageTwo.hasMore, false);
    assert.strictEqual(pageTwo.nextSkip, null);
    assert.strictEqual(new Set([...pageOne.items, ...pageTwo.items].map(item => item.id)).size, 3);
    assert([...pageOne.items, ...pageTwo.items].some(item => item.id === rootCommit));
    assert(![...pageOne.items, ...pageTwo.items].some(item => item.id === topicCommit));

    const allBranches = await service.gitHistory(repository, { limit: 10, scope: 'all' });
    assert.strictEqual(allBranches.scope, 'all');
    assert.strictEqual(allBranches.items.length, 4);
    assert(allBranches.items.some(item => item.id === topicCommit));

    const firstParentChanges = await service.gitHistoryChanges(repository, mergeCommit, mainCommit);
    assert(firstParentChanges.items.some(change => change.path === 'topic.txt' && change.status === 'added'));
    const secondParentChanges = await service.gitHistoryChanges(repository, mergeCommit, topicCommit);
    assert(secondParentChanges.items.some(change => change.path === 'main.txt' && change.status === 'added'));

    const rootChanges = await service.gitHistoryChanges(repository, rootCommit);
    assert.strictEqual(rootChanges.parent, null);
    assert.deepStrictEqual(rootChanges.parentIds, []);
    assert.strictEqual(rootChanges.comparisonBase, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    assert(rootChanges.items.some(change => change.path === 'base.txt' && change.status === 'added'));
    assert(git(repository, 'diff', '--name-only', rootChanges.comparisonBase, rootCommit).includes('base.txt'));

    await assert.rejects(
      () => service.gitHistoryChanges(repository, mergeCommit, '0'.repeat(40)),
      error => error.statusCode === 400 && /not a parent/.test(error.message)
    );
    await assert.rejects(
      () => service.gitHistoryChanges(repository, 'f'.repeat(40)),
      error => error.statusCode === 404
    );

    const emptyHistory = await service.gitHistory(emptyRepository);
    assert.strictEqual(emptyHistory.isGitRepo, true);
    assert.strictEqual(emptyHistory.branch, 'main');
    assert.deepStrictEqual(emptyHistory.items, []);

    const plainHistory = await service.gitHistory(plainDirectory);
    assert.strictEqual(plainHistory.isGitRepo, false);
    assert.deepStrictEqual(plainHistory.items, []);
  } finally {
    await service.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('test-workspace-git-history passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
