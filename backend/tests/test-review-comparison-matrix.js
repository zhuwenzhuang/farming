const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const { ReviewDiffService } = require('../review-diff-service');
const { ReviewSessionService } = require('../review-session-service');
const { ReviewSessionStore } = require('../review-session-store');
const { ReviewStateStore } = require('../review-state-store');
const { WorkspaceFileService } = require('../workspace-file-service');

const execFile = promisify(childProcess.execFile);

async function git(root, ...args) {
  const { stdout } = await execFile('git', ['-C', root, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

function write(root, filePath, content) {
  const absolute = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

async function resetWorkingCopy(root) {
  await git(root, 'reset', '--hard', 'HEAD');
  await git(root, 'clean', '-fd');
}

function sortedPaths(snapshot) {
  return snapshot.files.map(file => file.path).sort();
}

async function run() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-matrix-'));
  const repository = path.join(temporaryRoot, 'repo');
  const configDir = path.join(temporaryRoot, 'config');
  fs.mkdirSync(repository);
  const fileService = new WorkspaceFileService({ gitStatusCacheTtlMs: 0, gitStatusInlineTimeoutMs: 0 });
  const diffService = new ReviewDiffService(null, fileService);
  let caseCount = 0;

  try {
    await git(repository, 'init', '-b', 'main');
    await git(repository, 'config', 'user.email', 'review-matrix@example.com');
    await git(repository, 'config', 'user.name', 'Review Matrix');
    write(repository, 'tracked.txt', 'base\n');
    write(repository, 'delete.txt', 'delete me\n');
    write(repository, 'rename-old.txt', 'rename me\n');
    write(repository, 'mixed.txt', 'base\n');
    write(repository, 'script.sh', '#!/bin/sh\necho base\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'matrix root');

    for (let index = 1; index <= 14; index += 1) {
      write(repository, `history/case-${String(index).padStart(2, '0')}.txt`, `commit ${index}\n`);
      await git(repository, 'add', '.');
      await git(repository, 'commit', '-m', `matrix commit ${index}`);
    }

    await git(repository, 'branch', 'comparison/behind', 'HEAD~3');
    await git(repository, 'branch', 'comparison/older', 'HEAD~8');
    await git(repository, 'branch', 'comparison/same', 'HEAD');
    await git(repository, 'update-ref', 'refs/remotes/origin/main', await git(repository, 'rev-parse', 'HEAD'));
    await git(repository, 'checkout', '-b', 'comparison/diverged', 'HEAD~5');
    write(repository, 'branch-only.txt', 'diverged branch\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'diverged branch only');
    await git(repository, 'checkout', 'main');
    await git(repository, 'checkout', '--orphan', 'comparison/unrelated');
    await git(repository, 'rm', '-rf', '.');
    write(repository, 'unrelated.txt', 'separate history\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'unrelated root');
    await git(repository, 'checkout', 'main');

    const cleanSources = await diffService.getComparisonSources(undefined, { root: repository });
    assert.strictEqual(cleanSources.unstaged.available, false);
    assert.strictEqual(cleanSources.staged.available, false);
    assert.strictEqual(cleanSources.commits.length, 12);
    assert.deepStrictEqual(cleanSources.branches.map(branch => branch.label).sort(), [
      'comparison/behind',
      'comparison/diverged',
      'comparison/older',
    ]);
    caseCount += 3;

    for (const source of cleanSources.commits) {
      const snapshot = await diffService.getGitRange(undefined, {
        base: source.base,
        head: source.head,
        metadataOnly: true,
        root: repository,
      });
      assert.strictEqual(snapshot.basePatchset, source.base);
      assert.strictEqual(snapshot.patchset, source.head);
      assert.strictEqual(snapshot.files.length, 1);
      caseCount += 1;
    }

    for (const source of cleanSources.branches) {
      const snapshot = await diffService.getGitRange(undefined, {
        base: source.base,
        head: source.head,
        metadataOnly: true,
        root: repository,
      });
      assert(snapshot.files.length > 0, `${source.label} must produce a useful comparison`);
      caseCount += 1;
    }

    const stagedCases = [
      ['modified', async () => { write(repository, 'tracked.txt', 'staged modified\n'); await git(repository, 'add', 'tracked.txt'); }, ['tracked.txt']],
      ['added', async () => { write(repository, 'added.txt', 'added\n'); await git(repository, 'add', 'added.txt'); }, ['added.txt']],
      ['deleted', async () => { fs.rmSync(path.join(repository, 'delete.txt')); await git(repository, 'add', '-A', 'delete.txt'); }, ['delete.txt']],
      ['renamed', async () => { await git(repository, 'mv', 'rename-old.txt', 'rename-new.txt'); }, ['rename-new.txt']],
      ['mode', async () => { fs.chmodSync(path.join(repository, 'script.sh'), 0o755); await git(repository, 'add', 'script.sh'); }, ['script.sh']],
      ['unicode', async () => { write(repository, '目录/你好.txt', '你好\n'); await git(repository, 'add', '目录/你好.txt'); }, ['目录/你好.txt']],
      ['spaces', async () => { write(repository, 'space dir/file name.txt', 'space\n'); await git(repository, 'add', 'space dir/file name.txt'); }, ['space dir/file name.txt']],
      ['multiple', async () => { write(repository, 'tracked.txt', 'multi\n'); write(repository, 'multi-new.txt', 'new\n'); await git(repository, 'add', 'tracked.txt', 'multi-new.txt'); }, ['multi-new.txt', 'tracked.txt']],
      ['staged-plus-unstaged', async () => { write(repository, 'mixed.txt', 'staged\n'); await git(repository, 'add', 'mixed.txt'); write(repository, 'mixed.txt', 'unstaged after index\n'); }, ['mixed.txt']],
      ['symlink', async () => { fs.symlinkSync('tracked.txt', path.join(repository, 'tracked-link')); await git(repository, 'add', 'tracked-link'); }, ['tracked-link']],
    ];
    for (const [name, setup, expected] of stagedCases) {
      await resetWorkingCopy(repository);
      await setup();
      const base = await git(repository, 'rev-parse', 'HEAD');
      const head = await git(repository, 'write-tree');
      const snapshot = await diffService.getGitRange(undefined, { base, head, metadataOnly: true, root: repository });
      assert.deepStrictEqual(sortedPaths(snapshot), expected, `${name}: staged paths`);
      if (name === 'modified') {
        const sources = await diffService.getComparisonSources(undefined, { root: repository });
        assert.strictEqual(sources.staged.available, true, `${name}: staged source must be available`);
        assert.strictEqual(sources.staged.base, base);
        assert.strictEqual(sources.staged.head, head);
      }
      caseCount += 1;
    }

    const unstagedCases = [
      ['modified', async () => { write(repository, 'tracked.txt', 'unstaged modified\n'); }, ['tracked.txt'], true],
      ['deleted', async () => { fs.rmSync(path.join(repository, 'delete.txt')); }, ['delete.txt'], true],
      ['untracked', async () => { write(repository, 'untracked.txt', 'new\n'); }, ['untracked.txt'], true],
      ['unicode', async () => { write(repository, '临时/文件.txt', '你好\n'); }, ['临时/文件.txt'], true],
      ['spaces', async () => { write(repository, 'loose dir/file name.txt', 'space\n'); }, ['loose dir/file name.txt'], true],
      ['multiple', async () => { write(repository, 'tracked.txt', 'multi\n'); write(repository, 'loose.txt', 'new\n'); }, ['loose.txt', 'tracked.txt'], true],
      ['after-staged', async () => { write(repository, 'mixed.txt', 'staged\n'); await git(repository, 'add', 'mixed.txt'); write(repository, 'mixed.txt', 'unstaged\n'); }, ['mixed.txt'], true],
      ['staged-add-then-edit', async () => { write(repository, 'new-mixed.txt', 'staged\n'); await git(repository, 'add', 'new-mixed.txt'); write(repository, 'new-mixed.txt', 'unstaged\n'); }, ['new-mixed.txt'], true],
      ['mode', async () => { fs.chmodSync(path.join(repository, 'script.sh'), 0o755); }, ['script.sh'], true],
      ['ignored-only', async () => { write(repository, '.gitignore', 'ignored.tmp\n'); await git(repository, 'add', '.gitignore'); await git(repository, 'commit', '-m', 'add ignore rule'); write(repository, 'ignored.tmp', 'ignored\n'); }, [], false],
    ];
    for (const [name, setup, expected, available] of unstagedCases) {
      await resetWorkingCopy(repository);
      await setup();
      const base = await git(repository, 'write-tree');
      const snapshot = await diffService.getGitRange(undefined, { base, head: 'now', metadataOnly: true, root: repository });
      assert.deepStrictEqual(sortedPaths(snapshot), expected, `${name}: unstaged paths`);
      if (name === 'modified' || !available) {
        const sources = await diffService.getComparisonSources(undefined, { root: repository });
        assert.strictEqual(sources.unstaged.available, available, `${name}: unstaged availability`);
        if (available) assert.strictEqual(sources.unstaged.base, base);
      }
      caseCount += 1;
    }

    await resetWorkingCopy(repository);
    const nestedWorkspace = path.join(repository, 'nested-workspace');
    fs.mkdirSync(nestedWorkspace, { recursive: true });
    const acpCases = new Map([
      ['acp-modified', [{ kind: 'updated', oldText: 'old\n', newText: 'new\n', path: path.join(repository, 'acp-modified.txt') }]],
      ['acp-added', [{ kind: 'added', oldText: '', newText: 'added\n', path: 'acp-added.txt' }]],
      ['acp-deleted', [{ kind: 'deleted', oldText: 'deleted\n', newText: '', path: 'acp-deleted.txt' }]],
      ['acp-repeated', [
        { kind: 'updated', oldText: 'one\n', newText: 'two\n', path: 'acp-repeated.txt' },
        { kind: 'updated', oldText: 'two\n', newText: 'three\n', path: 'acp-repeated.txt' },
      ]],
      ['acp-unicode', [{ kind: 'added', oldText: '', newText: '你好\n', path: '审阅/文件.txt' }]],
      ['acp-spaces', [{ kind: 'updated', oldText: 'a\n', newText: 'b\n', path: 'space dir/file name.txt' }]],
      ['acp-multi', [
        { kind: 'added', oldText: '', newText: 'a\n', path: 'acp-a.txt' },
        { kind: 'added', oldText: '', newText: 'b\n', path: 'acp-b.txt' },
      ]],
      ['acp-external-filtered', [
        { kind: 'updated', oldText: 'outside\n', newText: 'ignored\n', path: path.join(temporaryRoot, 'outside.txt') },
        { kind: 'updated', oldText: 'inside\n', newText: 'kept\n', path: 'acp-inside.txt' },
      ]],
      ['acp-git-filtered', [
        { kind: 'updated', oldText: 'private\n', newText: 'ignored\n', path: path.join(repository, '.git', 'info', 'exclude') },
        { kind: 'updated', oldText: 'inside\n', newText: 'kept\n', path: 'acp-visible.txt' },
      ]],
      ['acp-nested', [{ kind: 'updated', oldText: 'old\n', newText: 'new\n', path: path.join(nestedWorkspace, 'nested.txt') }]],
    ]);
    const sessionStore = new ReviewSessionStore(configDir);
    const stateStore = new ReviewStateStore(configDir);
    const historicalService = new ReviewSessionService(fileService, sessionStore, stateStore, {
      resolveAcpReviewChanges(agentId) { return acpCases.get(agentId) || []; },
      resolveAgentRoot(agentId) { return agentId === 'acp-nested' ? nestedWorkspace : repository; },
    });
    for (const [agentId] of acpCases) {
      const revision = await historicalService.createFromAcp({ agentId, itemIds: ['tool'] });
      const names = (await git(repository, 'diff', '--name-only', revision.base, revision.head)).split('\n').filter(Boolean);
      assert(names.length > 0, `${agentId}: Last Turn must contain a real Git diff`);
      if (agentId === 'acp-external-filtered') assert.deepStrictEqual(names, ['acp-inside.txt']);
      if (agentId === 'acp-git-filtered') assert.deepStrictEqual(names, ['acp-visible.txt']);
      if (agentId === 'acp-nested') assert.deepStrictEqual(names, ['nested-workspace/nested.txt']);
      caseCount += 1;
    }

    assert.strictEqual(caseCount, 48);
    console.log(`test-review-comparison-matrix passed (${caseCount} real-data cases)`);
  } finally {
    await fileService.dispose();
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
