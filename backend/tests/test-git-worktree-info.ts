const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createGitWorktreeListCache,
  inspectGitWorktree,
  isLinkedWorktreeOf,
  parseGitWorktreeList,
} = require('../git-worktree-info.cjs');

interface FakeRepository {
  commonDir: string;
  linked: string;
  main: string;
}

function fakeWorktreeList(repository: FakeRepository): string {
  return [
    `worktree ${repository.main}`,
    'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'branch refs/heads/main',
    '',
    `worktree ${repository.linked}`,
    'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'branch refs/heads/topic',
    '',
  ].join('\0');
}

function createFakeGitExecutor(
  repositories: FakeRepository[],
  options: { failNextList?: boolean; rejectAbsoluteCommonDir?: boolean } = {},
) {
  const calls: string[][] = [];
  const repositoryForCandidate = (candidate: string) => repositories.find(repository => (
    candidate === repository.main
    || candidate.startsWith(`${repository.main}${path.sep}`)
    || candidate === repository.linked
    || candidate.startsWith(`${repository.linked}${path.sep}`)
  ));
  const repositoryForCommonDir = (commonDir: string) => repositories.find(repository => (
    repository.commonDir === commonDir
  ));
  let failNextList = options.failNextList === true;

  return {
    calls,
    execFileAsync: async (_executable: string, args: string[]) => {
      calls.push([...args]);
      if (args[0] === '-C') {
        const candidate = args[1];
        const repository = repositoryForCandidate(candidate);
        if (!repository) throw new Error(`Unknown fake Git candidate: ${candidate}`);
        if (args.includes('--show-toplevel')) {
          const topLevel = candidate === repository.linked
            || candidate.startsWith(`${repository.linked}${path.sep}`)
            ? repository.linked
            : repository.main;
          return { stdout: `${topLevel}\n` };
        }
        if (args.includes('--git-common-dir')) {
          if (options.rejectAbsoluteCommonDir === true && args.includes('--path-format=absolute')) {
            throw new Error('Synthetic old Git path-format rejection');
          }
          const commonDir = options.rejectAbsoluteCommonDir === true
            ? path.relative(candidate, repository.commonDir)
            : repository.commonDir;
          return { stdout: `${commonDir}\n` };
        }
      }
      if (args[0] === '--git-dir' && args.includes('worktree') && args.includes('list')) {
        const repository = repositoryForCommonDir(args[1]);
        if (!repository) throw new Error(`Unknown fake Git common dir: ${args[1]}`);
        if (failNextList) {
          failNextList = false;
          throw new Error('Synthetic worktree list failure');
        }
        return { stdout: fakeWorktreeList(repository) };
      }
      throw new Error(`Unexpected fake Git command: ${args.join(' ')}`);
    },
  };
}

function listCallCount(calls: string[][]): number {
  return calls.filter(args => args[0] === '--git-dir' && args.includes('worktree')).length;
}

async function assertRepositoryWorktreeListCache() {
  const invalidationCache = createGitWorktreeListCache();
  let invalidationLoads = 0;
  const loadAfterInvalidation = async () => {
    invalidationLoads += 1;
    return [];
  };
  await invalidationCache.get('invalidation-fixture', 3_000, loadAfterInvalidation);
  await invalidationCache.get('invalidation-fixture', 3_000, loadAfterInvalidation);
  assert.strictEqual(invalidationLoads, 1);
  invalidationCache.clear();
  await invalidationCache.get('invalidation-fixture', 3_000, loadAfterInvalidation);
  assert.strictEqual(invalidationLoads, 2, 'Topology mutations must be able to invalidate repository list results');

  const fakeRoot = path.join(path.parse(process.cwd()).root, 'virtual');
  const repositoryA = {
    commonDir: path.join(fakeRoot, 'repo-a', '.git'),
    main: path.join(fakeRoot, 'repo-a'),
    linked: path.join(fakeRoot, 'repo-a-topic'),
  };
  const repositoryB = {
    commonDir: path.join(fakeRoot, 'repo-b', '.git'),
    main: path.join(fakeRoot, 'repo-b'),
    linked: path.join(fakeRoot, 'repo-b-topic'),
  };
  const repositoryC = {
    commonDir: path.join(fakeRoot, 'repo-c', '.git'),
    main: path.join(fakeRoot, 'repo-c'),
    linked: path.join(fakeRoot, 'repo-c-topic'),
  };
  let now = 1_000;
  const sharedCache = createGitWorktreeListCache({ now: () => now, maxEntries: 2 });
  const sharedExecutor = createFakeGitExecutor([repositoryA, repositoryB, repositoryC]);
  const sharedOptions = {
    cacheMs: 3_000,
    execFileAsync: sharedExecutor.execFileAsync,
    worktreeListCache: sharedCache,
  };

  const [mainInfo, linkedInfo] = await Promise.all([
    inspectGitWorktree(path.join(repositoryA.main, 'src'), sharedOptions),
    inspectGitWorktree(path.join(repositoryA.linked, 'src'), sharedOptions),
  ]);
  assert(mainInfo);
  assert(linkedInfo);
  assert.strictEqual(mainInfo.commonDir, repositoryA.commonDir);
  assert.strictEqual(linkedInfo.commonDir, repositoryA.commonDir);
  assert.strictEqual(listCallCount(sharedExecutor.calls), 1);
  assert.strictEqual(
    sharedExecutor.calls.length,
    5,
    'Two Worktrees in one repository should require two candidate checks each and one shared list command',
  );

  await inspectGitWorktree(repositoryB.main, sharedOptions);
  assert.strictEqual(listCallCount(sharedExecutor.calls), 2, 'Different repositories must not share list results');
  await inspectGitWorktree(repositoryA.main, sharedOptions);
  await inspectGitWorktree(repositoryC.main, sharedOptions);
  await inspectGitWorktree(repositoryB.main, sharedOptions);
  assert.strictEqual(
    listCallCount(sharedExecutor.calls),
    4,
    'The least recently used repository list should be evicted at the configured entry bound',
  );

  now += 3_001;
  await inspectGitWorktree(repositoryA.main, sharedOptions);
  assert.strictEqual(listCallCount(sharedExecutor.calls), 5, 'Expired repository lists should be refreshed');

  await inspectGitWorktree(repositoryA.main, { ...sharedOptions, cacheMs: 0 });
  await inspectGitWorktree(repositoryA.main, { ...sharedOptions, cacheMs: 0 });
  assert.strictEqual(
    listCallCount(sharedExecutor.calls),
    7,
    'cacheMs: 0 must perform a fresh repository list read every time',
  );

  const failureCache = createGitWorktreeListCache({ now: () => now, maxEntries: 2 });
  const failureExecutor = createFakeGitExecutor([repositoryA], { failNextList: true });
  const failureOptions = {
    cacheMs: 3_000,
    execFileAsync: failureExecutor.execFileAsync,
    worktreeListCache: failureCache,
  };
  assert.strictEqual(await inspectGitWorktree(repositoryA.main, failureOptions), null);
  assert(await inspectGitWorktree(repositoryA.main, failureOptions));
  assert.strictEqual(listCallCount(failureExecutor.calls), 2, 'A failed list read must not remain cached');

  const oldGitCache = createGitWorktreeListCache({ now: () => now, maxEntries: 2 });
  const oldGitExecutor = createFakeGitExecutor([repositoryA], { rejectAbsoluteCommonDir: true });
  const oldGitOptions = {
    cacheMs: 3_000,
    execFileAsync: oldGitExecutor.execFileAsync,
    worktreeListCache: oldGitCache,
  };
  const oldGitResults = await Promise.all([
    inspectGitWorktree(path.join(repositoryA.main, 'src'), oldGitOptions),
    inspectGitWorktree(path.join(repositoryA.linked, 'src'), oldGitOptions),
  ]);
  assert(oldGitResults.every(Boolean));
  assert.strictEqual(
    listCallCount(oldGitExecutor.calls),
    1,
    'The old-Git relative common-dir fallback should retain repository-level sharing',
  );
}

async function run() {
  await assertRepositoryWorktreeListCache();
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
