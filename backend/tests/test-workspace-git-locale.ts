const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  WorkspaceFileService,
  WorkspaceFileError,
  gitCommandArgs,
  gitCommandEnvironment,
} = require('../workspace-file-service.cjs');

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Git octal-quotes non-ASCII paths unless `core.quotepath` is disabled, so an
 * ignored file keeps its ignored state in the tree only when Farming reads the
 * same path identity git was asked about.
 */
async function assertNonAsciiIgnoreStateSurvives(tmpRoot: string): Promise<void> {
  if (!hasGit()) return;
  const repository = path.join(tmpRoot, 'quotepath-repository');
  fs.mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { stdio: 'ignore' });
  git('init', '--quiet');
  fs.writeFileSync(path.join(repository, '.gitignore'), '*.log\n');
  fs.writeFileSync(path.join(repository, 'ascii.log'), 'ignored\n');
  fs.writeFileSync(path.join(repository, '忽略中文.log'), 'ignored\n');
  fs.writeFileSync(path.join(repository, '普通中文.txt'), 'tracked\n');

  const service = new WorkspaceFileService({ workspace: repository, gitStatusCacheTtlMs: 0 });
  try {
    const tree = await service.listTree(repository, '');
    const decorations = await service.listTreeDecorations(
      repository,
      '',
      tree.items.map((item: { path: string }) => item.path),
    );
    const decorationByPath = new Map<string, { ignored?: boolean }>(
      decorations.items.map((item: { path: string; ignored?: boolean }) => [item.path, item]),
    );
    const ignoredByName = new Map<string, boolean>(
      tree.items.map((item: { name: string; path: string }) => [
        item.name,
        Boolean(decorationByPath.get(item.path)?.ignored),
      ]),
    );
    assert.strictEqual(ignoredByName.get('ascii.log'), true, 'an ignored ASCII file must be reported as ignored');
    assert.strictEqual(
      ignoredByName.get('忽略中文.log'),
      true,
      'an ignored non-ASCII file must be reported as ignored, not treated as an ordinary file',
    );
    assert.strictEqual(ignoredByName.get('普通中文.txt'), false, 'a non-ignored non-ASCII file must stay visible');
  } finally {
    await service.dispose();
  }
}

/**
 * Git localizes its diagnostics, and Farming classifies git failures by their
 * English wording. This stub only speaks English when the message locale is
 * pinned, so it fails exactly like a real localized git installation would.
 */
const LOCALIZED_GIT_STUB = [
  '#!/bin/sh',
  'if [ "$LC_ALL" = "C" ] || [ "$LC_MESSAGES" = "C" ]; then',
  '  echo "fatal: not a git repository (or any of the parent directories): .git" >&2',
  'else',
  '  echo "致命错误：不是 Git 仓库（或者任何父目录）：.git" >&2',
  'fi',
  'exit 128',
  '',
].join('\n');

/** Reports the environment git actually receives. */
const ENVIRONMENT_GIT_STUB = [
  '#!/bin/sh',
  'echo "LC_ALL=$LC_ALL PATH=$PATH FARMING_GIT_LOCALE_PROBE=$FARMING_GIT_LOCALE_PROBE" >&2',
  'exit 128',
  '',
].join('\n');

/**
 * Packaged runtimes run commands without the helper process, so that direct
 * path must inherit the server environment instead of replacing it with the
 * per-command overrides. Otherwise a pinned locale would strip PATH and no git
 * invocation could resolve at all.
 */
async function assertPackagedRuntimeKeepsServerEnvironment(tmpRoot: string): Promise<void> {
  const workspace = path.join(tmpRoot, 'packaged-workspace');
  const gitStub = path.join(tmpRoot, 'git-environment-stub');
  fs.mkdirSync(workspace);
  fs.writeFileSync(gitStub, ENVIRONMENT_GIT_STUB, { mode: 0o755 });

  const service = new WorkspaceFileService({
    workspace,
    gitPath: gitStub,
    commandRunnerOptions: { disableHelper: true },
  });
  const previousProbe = process.env.FARMING_GIT_LOCALE_PROBE;
  process.env.FARMING_GIT_LOCALE_PROBE = 'inherited';
  try {
    await service.execFile(gitStub, ['status'], { cwd: workspace });
    assert.fail('the environment stub must fail so its report can be inspected');
  } catch (error: unknown) {
    const stderr = String((error as { stderr?: string }).stderr || '');
    assert.match(stderr, /LC_ALL=C/, 'packaged runtimes must still pin the git message locale');
    assert.match(
      stderr,
      /FARMING_GIT_LOCALE_PROBE=inherited/,
      'packaged runtimes must inherit the server environment for git',
    );
    assert(
      /PATH=\S/.test(stderr),
      'a pinned git locale must not strip PATH from the command environment',
    );
  } finally {
    if (previousProbe === undefined) delete process.env.FARMING_GIT_LOCALE_PROBE;
    else process.env.FARMING_GIT_LOCALE_PROBE = previousProbe;
    await service.dispose();
  }
}

async function run() {
  assert.deepStrictEqual(
    gitCommandEnvironment({ LANG: 'zh_CN.UTF-8', PATH: '/usr/bin' }),
    { LANG: 'C', LANGUAGE: 'C', LC_ALL: 'C', LC_MESSAGES: 'C', PATH: '/usr/bin' },
    'git invocations must pin every message locale variable without dropping the caller environment',
  );
  assert.deepStrictEqual(
    gitCommandArgs(['-C', '/repository', 'status', '--porcelain=v1']),
    ['-c', 'core.quotepath=false', '-C', '/repository', 'status', '--porcelain=v1'],
    'git invocations must read paths as raw UTF-8 before the requested subcommand',
  );

  if (process.platform === 'win32') {
    console.log('test-workspace-git-locale passed (POSIX git stub unsupported)');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-git-locale-'));
  const workspace = path.join(tmpRoot, 'workspace');
  const gitStub = path.join(tmpRoot, 'git-stub');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'app.ts'), 'export const value = 1\n');
  fs.writeFileSync(gitStub, LOCALIZED_GIT_STUB, { mode: 0o755 });

  const service = new WorkspaceFileService({
    workspace,
    gitPath: gitStub,
    gitStatusCacheTtlMs: 0,
  });
  const previousLanguage = process.env.LANGUAGE;
  const previousLocale = process.env.LANG;
  process.env.LANGUAGE = 'zh_CN';
  process.env.LANG = 'zh_CN.UTF-8';
  try {
    assert.deepStrictEqual(
      await service.gitHistory(workspace),
      { isGitRepo: false, branch: '', head: '', scope: 'current', items: [], hasMore: false, nextSkip: null },
      'git history must report a non-repository workspace instead of a localized failure',
    );
    assert.deepStrictEqual(
      await service.blame(workspace, 'app.ts'),
      { isGitRepo: false, path: 'app.ts', lines: [] },
      'blame must report a non-repository workspace instead of a localized failure',
    );
    assert.strictEqual(
      (await service.getGitStatusByPath(workspace)).size,
      0,
      'git status must degrade to an empty map outside a repository',
    );
    const capability = await service.lineChanges(workspace, 'app.ts', 1);
    assert.strictEqual(capability.isGitRepo, false);
    assert.strictEqual(capability.reason, 'not-git-repo');
    assert(
      !(capability instanceof WorkspaceFileError),
      'line changes must not surface a localized git failure as a server error',
    );
    await assertPackagedRuntimeKeepsServerEnvironment(tmpRoot);
    await assertNonAsciiIgnoreStateSurvives(tmpRoot);
  } finally {
    if (previousLanguage === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = previousLanguage;
    if (previousLocale === undefined) delete process.env.LANG;
    else process.env.LANG = previousLocale;
    await service.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('test-workspace-git-locale passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
