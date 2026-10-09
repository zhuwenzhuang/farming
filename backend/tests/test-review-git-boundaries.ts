import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { WorkspaceFileService } = require('../workspace-file-service.cjs');
const { ReviewDiffService } = require('../review-diff-service.cjs');
const { ReviewSessionService } = require('../review-session-service.cjs');
const { ReviewSessionStore } = require('../review-session-store.cjs');
const { ReviewStateStore } = require('../review-state-store.cjs');
const exec = promisify(execFile);

async function run() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-review-boundaries-'));
  const files = new WorkspaceFileService({ rgPath: 'rg', gitStatusCacheTtlMs: 0 });
  const diffs = new ReviewDiffService(null, files);
  let sequence = 0;
  const sessions = () => {
    const config = path.join(temporary, `config-${++sequence}`);
    return new ReviewSessionService(files, new ReviewSessionStore(config), new ReviewStateStore(config));
  };
  const git = async (root: string, ...args: string[]) => (await exec('git', ['-C', root, ...args], { timeout: 10000 })).stdout.trim();
  const write = async (root: string, file: string, value: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), `${value}\n`);
  };
  const init = async (name: string) => {
    const root = path.join(temporary, name);
    await fs.mkdir(root);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.name', 'Review Test');
    await git(root, 'config', 'user.email', 'review@example.com');
    await git(root, 'config', 'core.hooksPath', '/dev/null');
    return root;
  };
  const commit = async (root: string) => { await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Fixture'); };
  const changed = async (root: string, base: string, head: string) => (await git(root, 'diff', '--name-only', base, head)).split('\n').filter(Boolean);
  const conflict = (error: { statusCode?: number }) => error.statusCode === 409;
  try {
    const main = await init('main');
    await write(main, 'a.txt', 'base'); await commit(main);
    const linked = path.join(temporary, 'linked');
    await git(main, 'worktree', 'add', '--detach', linked, 'HEAD');
    await write(main, 'a.txt', 'main staged'); await git(main, 'add', 'a.txt');
    await write(linked, 'a.txt', 'linked staged'); await git(linked, 'add', 'a.txt');
    await write(linked, 'a.txt', 'linked working');
    const indexPath = await git(linked, 'rev-parse', '--git-path', 'index');
    const originalIndex = await fs.readFile(indexPath);
    const originalMainIndex = await fs.readFile(path.join(main, '.git', 'index'));
    const linkedSession = await sessions().create({ root: linked });
    assert.equal(await git(linked, 'show', `${linkedSession.head}:a.txt`), 'linked working');
    assert.deepEqual(await fs.readFile(indexPath), originalIndex);
    assert.deepEqual(await fs.readFile(path.join(main, '.git', 'index')), originalMainIndex);
    const sources = await diffs.getComparisonSources(undefined, { root: linked });
    assert.equal(await git(linked, 'show', `${sources.staged.head}:a.txt`), 'linked staged');

    const root = await init('paths');
    for (const file of ['inside/a.txt', 'outside.txt', '[a].txt', 'a.txt']) await write(root, file, 'base');
    await commit(root);
    for (const file of ['inside/a.txt', 'outside.txt', '[a].txt', 'a.txt']) await write(root, file, file);
    const service = sessions();
    const fromDirectory = await service.create({ root: path.join(root, 'inside') });
    assert.equal(fromDirectory.root, await fs.realpath(root));
    const live = await diffs.getWorkingCopy(undefined, { root: path.join(root, 'inside'), metadataOnly: true });
    assert.equal(live.root, fromDirectory.root);
    assert.deepEqual(live.files.map((file: { path: string }) => file.path).sort(), ['[a].txt', 'a.txt', 'inside/a.txt', 'outside.txt'].sort());
    const alias = path.join(temporary, 'alias'); await fs.symlink(root, alias);
    assert.equal((await diffs.getWorkingCopy(undefined, { root: alias, metadataOnly: true })).reviewId, live.reviewId);
    const scoped = await service.create({ root, paths: ['inside'] });
    assert.deepEqual(await changed(root, scoped.base, scoped.head), ['inside/a.txt']);
    const inline = await files.diff(path.join(root, 'inside'), 'a.txt');
    assert.equal(inline.originalContent, 'base\n');
    assert.equal(inline.modifiedContent, 'inside/a.txt\n');
    const literal = await service.create({ root, paths: ['[a].txt'] });
    assert.deepEqual(await changed(root, literal.base, literal.head), ['[a].txt']);
    const literalDiff = await diffs.getGitRangeFile(undefined, { root, base: fromDirectory.base, head: fromDirectory.head, path: '[a].txt' });
    assert.equal(literalDiff.diff.hunks.length, 1, 'single-file diff cannot include a second wildcard-matched file');
    assert.match(JSON.stringify(literalDiff), /\[a\]\.txt/);

    // Exact index updates cannot recurse into ignored content, and staged-only
    // files that vanished from disk have no net HEAD-to-working-tree change.
    const transitions = await init('file-transitions');
    await write(transitions, '.gitignore', '*.secret');
    await write(transitions, 'file-to-directory', 'base file');
    await write(transitions, 'directory-to-file/child', 'base child');
    await write(transitions, 'rename-source', 'rename me');
    await write(transitions, 'executable', 'base executable');
    await commit(transitions);
    await write(transitions, 'staged-only', 'temporary');
    await git(transitions, 'add', 'staged-only');
    await fs.unlink(path.join(transitions, 'staged-only'));
    await git(transitions, 'mv', 'rename-source', 'rename-target');
    await fs.unlink(path.join(transitions, 'rename-target'));
    await fs.unlink(path.join(transitions, 'file-to-directory'));
    await write(transitions, 'file-to-directory/visible', 'visible');
    await write(transitions, 'file-to-directory/hidden.secret', 'ignored');
    await fs.rm(path.join(transitions, 'directory-to-file'), { recursive: true });
    await write(transitions, 'directory-to-file', 'replacement file');
    await fs.chmod(path.join(transitions, 'executable'), 0o755);
    await fs.symlink('executable', path.join(transitions, 'link'));
    const transitionReview = await sessions().create({ root: transitions });
    const transitionPaths = await changed(transitions, transitionReview.base, transitionReview.head);
    assert.deepEqual(transitionPaths, ['directory-to-file', 'directory-to-file/child', 'executable', 'file-to-directory', 'file-to-directory/visible', 'link', 'rename-source']);
    assert.match(await git(transitions, 'ls-tree', transitionReview.head, 'executable'), /^100755 /);
    assert.match(await git(transitions, 'ls-tree', transitionReview.head, 'link'), /^120000 /);
    assert.equal(await git(transitions, 'ls-tree', '-r', '--name-only', transitionReview.head, 'file-to-directory'), 'file-to-directory/visible');

    const names = await init('literal-names');
    const literalNames = [' spaced ', 'a\\b', '\\leading', 'with\nnewline'];
    for (const name of [...literalNames, 'spaced', 'a/b']) await write(names, name, 'base');
    await commit(names);
    for (const name of literalNames) await write(names, name, `changed ${name}`);
    const namesReview = await sessions().create({ root: names });
    const namesCatalog = await diffs.getGitRange(undefined, { root: names, base: namesReview.base, head: namesReview.head, metadataOnly: true });
    assert.deepEqual(namesCatalog.files.map((file: { path: string }) => file.path).sort(), [...literalNames].sort());
    for (const name of literalNames) {
      const one = await sessions().create({ root: names, paths: [name] });
      assert.equal((await exec('git', ['-C', names, 'show', `${one.head}:${name}`])).stdout, `changed ${name}\n`);
      const oneDiff = await diffs.getGitRangeFile(undefined, { root: names, base: one.base, head: one.head, path: name });
      assert.equal(oneDiff.diff.hunks.length, 1);
      const workingDiff = await files.diff(names, name);
      assert.equal(workingDiff.originalContent, 'base\n');
      assert.equal(workingDiff.modifiedContent, `changed ${name}\n`);
    }

    const nested = await init('nested-parent');
    await write(nested, 'base', 'base'); await commit(nested);
    const child = path.join(nested, 'child');
    await fs.mkdir(child);
    await git(child, 'init', '-b', 'main');
    await git(child, 'config', 'user.name', 'Review Test');
    await git(child, 'config', 'user.email', 'review@example.com');
    await git(child, 'config', 'core.hooksPath', '/dev/null');
    await write(child, 'child.txt', 'child'); await commit(child);
    await assert.rejects(sessions().create({ root: nested }), conflict);
    await write(child, 'child.txt', 'changed child');
    const childReview = await sessions().create({ root: child });
    assert.equal(childReview.root, await fs.realpath(child));
    assert.deepEqual(await changed(child, childReview.base, childReview.head), ['child.txt']);

    const rename = await init('scoped-rename');
    await write(rename, 'old/source.txt', 'rename across directories'); await commit(rename);
    await fs.mkdir(path.join(rename, 'new'));
    await git(rename, 'mv', 'old/source.txt', 'new/target.txt');
    await write(rename, 'unrelated.txt', 'unrelated');
    for (const statusRenames of ['true', 'false']) {
      await git(rename, 'config', 'status.renames', statusRenames);
      for (const selectedPath of ['old/source.txt', 'new/target.txt', 'old', 'new']) {
        const renamed = await sessions().create({ root: rename, paths: [selectedPath] });
        assert.equal(await git(rename, 'diff', '--name-status', renamed.base, renamed.head), 'R100\told/source.txt\tnew/target.txt');
      }
    }

    // Explorer-hidden paths are not Git exclusions. An explicit capture is
    // bounded after its path selection, even with an oversized unrelated area.
    await write(root, '.vscode/settings.json', '{}');
    const hidden = await service.create({ root });
    assert.ok((await changed(root, hidden.base, hidden.head)).includes('.vscode/settings.json'));
    await fs.mkdir(path.join(root, 'generated'));
    for (let i = 0; i < 2001; i++) await write(root, `generated/${i}.txt`, 'generated');
    assert.deepEqual(await changed(root, scoped.base, (await service.create({ root, paths: ['inside'] })).head), ['inside/a.txt']);
    await assert.rejects(service.create({ root }), (error: { statusCode?: number }) => error.statusCode === 413);
    const emptySelection = await service.create({ root, paths: [] });
    assert.deepEqual(await changed(root, emptySelection.base, emptySelection.head), []);

    // A scoped capture must re-enumerate membership, not just reread old paths.
    for (const scope of ['tracked', 'untracked']) {
      const race = await init(`race-${scope}`);
      await write(race, 'a.txt', 'base'); await write(race, 'b.txt', 'base'); await commit(race);
      await write(race, scope === 'tracked' ? 'a.txt' : 'new.txt', 'before');
      const captureService = sessions();
      const capture = captureService.captureTreeOnce.bind(captureService);
      let captures = 0;
      captureService.captureTreeOnce = async (...args: unknown[]) => {
        const tree = await capture(...args);
        if (++captures === 1) await write(race, scope === 'tracked' ? 'b.txt' : 'late.txt', 'late');
        return tree;
      };
      await assert.rejects(captureService.create({ root: race, scope }), conflict);
      assert.equal(await git(race, 'for-each-ref', '--format=%(refname)', 'refs/farming/reviews'), '');
    }

    const indexRace = sessions();
    const captureIndex = indexRace.captureTreeOnce.bind(indexRace);
    let staged = false;
    indexRace.captureTreeOnce = async (...args: unknown[]) => {
      const tree = await captureIndex(...args);
      if (!staged) { staged = true; await git(linked, 'add', 'a.txt'); }
      return tree;
    };
    await assert.rejects(indexRace.create({ root: linked }), conflict);
    const refreshService = sessions();
    const initial = await refreshService.create({ root: linked });
    await write(linked, 'new-after-review.txt', 'new file');
    const refreshed = await refreshService.refresh(initial.reviewId);
    assert.ok((await changed(linked, refreshed.base, refreshed.head)).includes('new-after-review.txt'));

    const move = await init('head-moves');
    await write(move, 'a.txt', 'old'); await commit(move); const old = await git(move, 'rev-parse', 'HEAD');
    await write(move, 'a.txt', 'new'); await commit(move); const head = await git(move, 'rev-parse', 'HEAD');
    const symbolic = await diffs.getGitRange(undefined, { root: move, base: 'HEAD~1', head: 'HEAD', metadataOnly: true });
    assert.equal(symbolic.basePatchset, old); assert.equal(symbolic.patchset, head);
    await write(move, 'b.txt', 'new commit'); await commit(move);
    const next = await diffs.getGitRange(undefined, { root: move, base: 'HEAD~1', head: 'HEAD', metadataOnly: true });
    assert.notEqual(next.reviewId, symbolic.reviewId);
    const pinned = await diffs.getGitRange(undefined, { root: move, base: symbolic.basePatchset, head: symbolic.patchset, metadataOnly: true });
    assert.equal(pinned.reviewId, symbolic.reviewId);
    assert.deepEqual(pinned.files, symbolic.files);
    const headRace = sessions();
    const resolveBase = headRace.resolveBase.bind(headRace);
    let moved = false;
    headRace.resolveBase = async (...args: unknown[]) => {
      const base = await resolveBase(...args);
      if (!moved) { moved = true; await git(move, 'reset', '--hard', old); }
      return base;
    };
    await assert.rejects(headRace.create({ root: move }), conflict);
    assert.equal(await git(move, 'for-each-ref', '--format=%(refname)', 'refs/farming/reviews'), '');

    // Large source metadata and expandable context use a separate budget from
    // patch output. This is a real repository, not a mocked command response.
    const large = await init('large-source');
    const source = Array.from({ length: 35000 }, (_, index) => `// unchanged source line ${index} with ordinary Java context`).join('\n');
    await write(large, 'Large.java', source); await commit(large);
    const largeBase = await git(large, 'rev-parse', 'HEAD');
    await write(large, 'Large.java', `${source}\n// one added line`); await commit(large);
    const largeHead = await git(large, 'rev-parse', 'HEAD');
    const largeDiff = await diffs.getGitRangeFile(undefined, { root: large, base: largeBase, head: largeHead, path: 'Large.java', fileMeta: true });
    assert.equal(largeDiff.added, 1);
    assert.equal(largeDiff.diff.leftMeta.lines, 35000);
    assert.equal(largeDiff.diff.rightMeta.lines, 35001);
    const largeContext = await diffs.getGitRangeFileContext(undefined, { root: large, path: 'Large.java', base: largeBase, head: largeHead, oldStart: 1, newStart: 1, lines: 10 });
    assert.equal(largeContext.rows.length, 10);
    await write(large, 'Huge.java', 'x'.repeat(16 * 1024 * 1024)); await commit(large);
    await assert.rejects(diffs.readGitTextFile(large, 'HEAD', 'Huge.java'),
      (error: { statusCode?: number; message?: string }) => error.statusCode === 413 && /16 MiB/.test(error.message ?? ''));
    await assert.rejects(diffs.readWorkingTreeTextFile(large, 'Huge.java'),
      (error: { statusCode?: number }) => error.statusCode === 413);

    // The real command-runner timeout shape carries SIGTERM, not ETIMEDOUT.
    const timeoutService = new ReviewSessionService({ ...files, execFile: async () => {
      throw Object.assign(new Error('Command failed'), { signal: 'SIGTERM', code: null });
    } }, new ReviewSessionStore(path.join(temporary, 'timeout')));
    await assert.rejects(timeoutService.git(root, ['diff']), (error: { statusCode?: number }) => error.statusCode === 504);
    console.log('test-review-git-boundaries passed');
  } finally {
    await files.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
