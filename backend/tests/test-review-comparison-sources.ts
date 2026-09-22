import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const { ReviewDiffService } = require('../review-diff-service.cjs');
const { WorkspaceFileService } = require('../workspace-file-service.cjs');
const exec = promisify(execFile);

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-sources-'));
  const fileService = new WorkspaceFileService();
  const service = new ReviewDiffService(null, fileService);
  const git = (...args: string[]) => exec('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Review Test');
    await git('config', 'user.email', 'review@example.com');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
    await git('add', '.');
    await git('commit', '-m', 'base');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed\n');
    await git('commit', '-am', 'second');
    const clean = await service.getComparisonSources(undefined, { root });
    assert.equal(clean.uncommittedPathsTruncated, false);
    assert.deepEqual(clean.uncommittedPaths, []);
    assert.equal(clean.staged.available, false);
    assert.equal(clean.unstaged.available, false);

    fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged\n');
    await git('add', 'tracked.txt');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'unstaged\n');
    const unstagedSources = await service.getComparisonSources(undefined, { root });
    const unstagedReview = await service.getGitRange(undefined, {
      root, base: unstagedSources.unstaged.base, head: 'now', metadataOnly: true,
    });
    assert.deepEqual(unstagedReview.comparison, { workingTree: true });
    const embedded = path.join(root, 'embedded');
    fs.mkdirSync(embedded);
    await exec('git', ['-C', embedded, 'init', '-b', 'main']);
    fs.writeFileSync(path.join(embedded, 'child.txt'), 'nested repository\n');
    await exec('git', ['-C', embedded, 'add', '.']);
    await exec('git', ['-C', embedded, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Review Test', '-c', 'user.email=review@example.com', 'commit', '-m', 'nested']);
    assert.ok((await git('ls-files', '--others', '--exclude-standard', '-z')).stdout.includes('embedded/\0'));
    const embeddedSources = await service.getComparisonSources(undefined, { root });
    assert.equal(embeddedSources.unstaged.available, true);
    assert.equal(embeddedSources.uncommittedPathsTruncated, true);
    assert.deepEqual(embeddedSources.uncommittedPaths, ['tracked.txt']);
    const inventory = path.join(root, 'generated');
    fs.mkdirSync(inventory);
    // More than the former 1 MiB buffer, with realistic long generated paths.
    for (let index = 0; index < 7000; index += 1) {
      fs.writeFileSync(path.join(inventory, `${String(index).padStart(5, '0')}-${'x'.repeat(150)}.txt`), '');
    }
    await assert.rejects(
      fileService.execFile('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], {
        maxBuffer: 1024 * 1024, timeout: 5000,
      }),
      (error: { code?: string }) => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    );
    const sources = await service.getComparisonSources(undefined, { root });
    assert.equal(sources.uncommittedPathsTruncated, true);
    assert.equal(sources.staged.available, true);
    assert.equal(sources.unstaged.available, true);
    assert.equal(sources.commits.length, 1);
    assert.ok(sources.uncommittedPaths.includes('tracked.txt'));
    assert.ok(sources.uncommittedPaths.length <= 2000);
    assert.ok(sources.uncommittedPaths.every((entry: string) => fs.existsSync(path.join(root, entry))));
    await assert.rejects(service.getGitRangeChanges(root, sources.unstaged.base, 'now'),
      (error: { statusCode?: number; message?: string }) => error.statusCode === 413 && /narrower review scope/.test(error.message || ''));
    assert.deepEqual((await service.getGitRangeChanges(root, sources.staged.base, sources.staged.head))
      .map((change: { path: string }) => change.path), ['tracked.txt']);
    assert.deepEqual((await service.getGitRangeChanges(root, sources.commits[0].base, sources.commits[0].head))
      .map((change: { path: string }) => change.path), ['tracked.txt']);

    // Validate stdout-only overflow admission and discard its unterminated tail.
    const fake = new ReviewDiffService(null, {
      gitPath: 'git', diffTimeoutMs: 5000,
      async execFile() {
        throw Object.assign(new Error('stdout maxBuffer length exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'complete.txt\0partial-文件',
        });
      },
    });
    assert.deepEqual(await fake.gitComparisonPaths(root, ['ls-files']), {
      available: true, paths: ['complete.txt'], truncated: true,
    });
    for (const failure of [
      Object.assign(new Error('stderr maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', signal: 'SIGTERM', stdout: 'complete.txt\0' }),
      Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '' }),
      Object.assign(new Error('read failed'), { code: 'EIO', stdout: 'complete.txt\0' }),
      Object.assign(new Error('timeout'), { signal: 'SIGTERM', stdout: 'complete.txt\0' }),
    ]) {
      fake.fileService.execFile = async () => { throw failure; };
      await assert.rejects(fake.gitComparisonPaths(root, ['ls-files']),
        (error: { statusCode?: number }) => error.statusCode === (failure.message === 'timeout' ? 504 : 500));
    }
    fake.fileService.execFile = async () => ({ stdout: 'missing-nul' });
    await assert.rejects(fake.gitComparisonPaths(root, ['ls-files']), /output is incomplete/);
    fake.fileService.execFile = async () => {
      throw Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    };
    await assert.rejects(fake.getGitRangeChanges(root, 'HEAD~1', 'HEAD'),
      (error: { statusCode?: number }) => error.statusCode === 413);

    // A short-path inventory can exceed the response count without byte overflow.
    const runRealGit = fileService.execFile.bind(fileService);
    fileService.execFile = async (command: string, args: string[], options: Record<string, unknown>) => {
      if (args.includes('ls-files')) return { stdout: Array.from({ length: 2100 }, (_, index) => `path-${index}\0`).join('') };
      return runRealGit(command, args, options);
    };
    const countLimited = await service.getComparisonSources(undefined, { root });
    assert.equal(countLimited.uncommittedPaths.length, 2000);
    assert.equal(countLimited.uncommittedPathsTruncated, true);
    assert.equal(countLimited.unstaged.available, true);
    await assert.rejects(service.getGitRangeChanges(root, sources.unstaged.base, 'now'),
      (error: { statusCode?: number }) => error.statusCode === 413);
    console.log('Review source inventory passed: real >1MiB repository, bounded paths, availability, strict failure classification');
  } finally {
    await fileService.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
