const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  inspectGitWorktree,
  isLinkedWorktreeOf,
  parseGitWorktreeList,
} = require('../git-worktree-info');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-worktree-info-'));
  const repo = path.join(tmpRoot, 'repo');
  const linked = path.join(tmpRoot, 'repo-topic');
  fs.mkdirSync(repo, { recursive: true });

  try {
    fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'add', 'README.md'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C', repo,
      '-c', 'user.name=Farming Test',
      '-c', 'user.email=farming@example.test',
      'commit', '-m', 'init',
    ], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'topic', linked], { stdio: 'ignore' });
    fs.mkdirSync(path.join(linked, 'src'), { recursive: true });
    const canonicalRepo = fs.realpathSync(repo);
    const canonicalLinked = fs.realpathSync(linked);

    const mainInfo = await inspectGitWorktree(repo, { cacheMs: 0 });
    const linkedInfo = await inspectGitWorktree(path.join(linked, 'src'), { cacheMs: 0 });
    assert(mainInfo);
    assert(linkedInfo);
    assert.strictEqual(mainInfo.workspace, canonicalRepo);
    assert.strictEqual(mainInfo.linked, false);
    assert.strictEqual(linkedInfo.workspace, canonicalLinked);
    assert.strictEqual(linkedInfo.mainWorkspace, canonicalRepo);
    assert.strictEqual(linkedInfo.linked, true);
    assert.strictEqual(linkedInfo.branch, 'topic');
    assert.strictEqual(linkedInfo.commonDir, mainInfo.commonDir);
    assert.strictEqual(mainInfo.worktrees.length, 2);
    assert.deepStrictEqual(mainInfo.worktrees.map(item => ({
      workspace: item.workspace,
      branch: item.branch,
      current: item.current,
      main: item.main,
    })), [
      {
        workspace: canonicalRepo,
        branch: mainInfo.branch,
        current: true,
        main: true,
      },
      {
        workspace: canonicalLinked,
        branch: 'topic',
        current: false,
        main: false,
      },
    ]);
    assert.strictEqual(linkedInfo.worktrees.find(item => item.workspace === canonicalLinked).current, true);
    assert.strictEqual(linkedInfo.worktrees.find(item => item.workspace === canonicalRepo).main, true);
    assert.strictEqual(await isLinkedWorktreeOf(repo, linked, { cacheMs: 0 }), true);
    assert.strictEqual(await isLinkedWorktreeOf(linked, repo, { cacheMs: 0 }), false);

    assert.deepStrictEqual(parseGitWorktreeList([
      `worktree ${repo}`,
      'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'branch refs/heads/main',
      '',
      `worktree ${linked}`,
      'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'detached',
      'locked maintenance',
      'prunable missing',
      '',
    ].join('\0')), [
      {
        path: repo,
        head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        branch: 'main',
      },
      {
        path: linked,
        head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        detached: true,
        locked: true,
        lockReason: 'maintenance',
        prunable: true,
        pruneReason: 'missing',
      },
    ]);

    console.log('test-git-worktree-info passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
