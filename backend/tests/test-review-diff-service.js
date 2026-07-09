const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReviewDiffService, fileFromPatch, gitDiffPathspecArgs, gitRangeReviewId, metadataFile, normalizeReviewLimit, patchMetadata, parseNameStatus, parseNumstat, parseRawDiffMetadata, untrackedPatch, workingCopyPatchset, workingCopyReviewId } = require('../review-diff-service');

function pathspecAfterDoubleDash(args) {
  const index = args.lastIndexOf('--');
  return index === -1 ? [] : args.slice(index + 1);
}

async function run() {
  const identityTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-identity-'));
  const identityRealRoot = path.join(identityTemp, 'repo');
  const identityLinkRoot = path.join(identityTemp, 'repo-link');
  fs.mkdirSync(identityRealRoot);
  try {
    fs.symlinkSync(identityRealRoot, identityLinkRoot, 'dir');
    assert.strictEqual(workingCopyReviewId(identityRealRoot), workingCopyReviewId(identityLinkRoot));
    assert.strictEqual(gitRangeReviewId(identityRealRoot, 'HEAD~1', 'HEAD'), gitRangeReviewId(identityLinkRoot, 'HEAD~1', 'HEAD'));
    assert.notStrictEqual(gitRangeReviewId(identityRealRoot, 'HEAD~2', 'HEAD'), gitRangeReviewId(identityRealRoot, 'HEAD~1', 'HEAD'));
  } finally {
    fs.rmSync(identityTemp, { force: true, recursive: true });
  }

  assert.strictEqual(normalizeReviewLimit(2), 2);
  assert.strictEqual(normalizeReviewLimit('3'), 3);
  assert.strictEqual(normalizeReviewLimit(0), 200);
  assert.strictEqual(normalizeReviewLimit(-1), 200);
  assert.strictEqual(normalizeReviewLimit(1.5), 200);
  assert.strictEqual(normalizeReviewLimit(Number.NaN), 200);
  assert.strictEqual(normalizeReviewLimit(999), 200);

  const scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-scope-'));
  fs.writeFileSync(path.join(scopeRoot, 'recent.txt'), 'recent\n');
  fs.writeFileSync(path.join(scopeRoot, 'old.txt'), 'old\n');
  const oldTime = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(scopeRoot, 'old.txt'), oldTime, oldTime);
  const scopeService = new ReviewDiffService({
    getAgentWorkspaceRoot() { return scopeRoot; },
  }, {
    async changes(_root, options) {
      assert.strictEqual(options.limit, 2000);
      return {
        items: [
          { path: 'tracked.ts', gitStatus: 'modified' },
          { path: 'recent.txt', gitStatus: 'untracked' },
          { path: 'old.txt', gitStatus: 'untracked' },
        ],
        truncated: false,
      };
    },
    async diff(_root, filePath) {
      if (filePath.endsWith('.txt')) return { modifiedContent: `${filePath}\n`, untracked: true };
      return { patch: 'diff --git a/tracked.ts b/tracked.ts\n@@ -1 +1 @@\n-old\n+new' };
    },
  });
  try {
    const trackedScope = await scopeService.getWorkingCopy('agent-scope', { metadataOnly: true, scope: 'tracked' });
    assert.deepStrictEqual(trackedScope.files.map(file => file.path), ['tracked.ts']);
    const untrackedScope = await scopeService.getWorkingCopy('agent-scope', { metadataOnly: true, modifiedWithinDays: 3, scope: 'untracked' });
    assert.deepStrictEqual(untrackedScope.files.map(file => file.path), ['recent.txt']);
    assert.notStrictEqual(trackedScope.reviewId, untrackedScope.reviewId);
    await assert.rejects(
      () => scopeService.getWorkingCopyFile('agent-scope', 'old.txt', { modifiedWithinDays: 3, scope: 'untracked' }),
      /review file not found/
    );
  } finally {
    fs.rmSync(scopeRoot, { force: true, recursive: true });
  }
  assert.deepStrictEqual(gitDiffPathspecArgs([
    { path: 'new/name.ts', previousPath: 'old/name.ts' },
    { path: 'new/name.ts', previousPath: 'old/name.ts' },
    { path: 'src/review.ts' },
  ]), ['old/name.ts', 'new/name.ts', 'src/review.ts']);

  assert.deepStrictEqual(patchMetadata([
    'diff --git a/src/review.ts b/src/review.ts',
    'index 1111111..2222222 100644',
  ]), {
    newMode: '100644',
    newSha: '2222222',
    oldMode: '100644',
    oldSha: '1111111',
  });
  assert.deepStrictEqual(patchMetadata([
    'diff --git a/script.sh b/script.sh',
    'old mode 100644',
    'new mode 100755',
  ]), {
    newMode: '100755',
    oldMode: '100644',
  });
  assert.deepStrictEqual(patchMetadata([
    'diff --git a/created.ts b/created.ts',
    'new file mode 100644',
    'index 0000000..3333333',
  ]), {
    newMode: '100644',
    newSha: '3333333',
  });
  assert.deepStrictEqual(patchMetadata([
    'diff --git a/removed.ts b/removed.ts',
    'deleted file mode 100644',
    'index 4444444..0000000',
  ]), {
    oldMode: '100644',
    oldSha: '4444444',
  });
  assert.notStrictEqual(
    workingCopyPatchset([{ added: 0, kind: 'modified', newMode: '100644', path: 'script.sh', removed: 0 }]),
    workingCopyPatchset([{ added: 0, kind: 'modified', newMode: '100755', path: 'script.sh', removed: 0 }])
  );
  assert.deepStrictEqual([...parseRawDiffMetadata([
    ':100644 100644 1111111 2222222 M\tsrc/review.ts',
    ':100644 100644 3333333 3333333 R100\told/name.ts\tnew/name.ts',
    ':100644 000000 4444444 0000000 D\tremoved.ts',
    ':000000 100644 0000000 5555555 A\tcreated.ts',
  ].join('\n')).entries()], [
    ['src/review.ts', { oldMode: '100644', newMode: '100644', oldSha: '1111111', newSha: '2222222' }],
    ['new/name.ts', { oldMode: '100644', newMode: '100644', oldSha: '3333333', newSha: '3333333' }],
    ['removed.ts', { oldMode: '100644', oldSha: '4444444' }],
    ['created.ts', { newMode: '100644', newSha: '5555555' }],
  ]);
  const nulNameStatus = [
    'R100', 'src/a\tfile.txt', 'src/b\tfile.txt',
    'M', 'src/line\nfile.txt',
    'M', 'src/tab\tmodified.txt',
  ].join('\0') + '\0';
  const nulChanges = parseNameStatus(nulNameStatus);
  assert.deepStrictEqual(nulChanges, [
    { kind: 'renamed', path: 'src/b\tfile.txt', previousPath: 'src/a\tfile.txt', status: 'R' },
    { kind: 'modified', path: 'src/line\nfile.txt', status: 'M' },
    { kind: 'modified', path: 'src/tab\tmodified.txt', status: 'M' },
  ]);
  assert.deepStrictEqual([...parseNumstat([
    '0\t0\t', 'src/a\tfile.txt', 'src/b\tfile.txt',
    '1\t1\tsrc/line\nfile.txt',
    '2\t3\tsrc/tab\tmodified.txt',
  ].join('\0') + '\0', nulChanges).entries()], [
    ['src/b\tfile.txt', { added: 0, binary: false, removed: 0 }],
    ['src/line\nfile.txt', { added: 1, binary: false, removed: 1 }],
    ['src/tab\tmodified.txt', { added: 2, binary: false, removed: 3 }],
  ]);
  assert.deepStrictEqual([...parseRawDiffMetadata([
    ':100644 100644 5626abf 5626abf R100', 'src/a\tfile.txt', 'src/b\tfile.txt',
    ':100644 100644 f719efd 6bff0eb M', 'src/line\nfile.txt',
  ].join('\0') + '\0').entries()], [
    ['src/b\tfile.txt', { oldMode: '100644', newMode: '100644', oldSha: '5626abf', newSha: '5626abf' }],
    ['src/line\nfile.txt', { oldMode: '100644', newMode: '100644', oldSha: 'f719efd', newSha: '6bff0eb' }],
  ]);
  assert.deepStrictEqual([...parseNumstat([
    '1\t1\tsrc/a => b.txt',
    '0\t0\told.txt => new.md',
    '2\t3\tsrc/{old name.ts => new name.ts}',
    '4\t5\t docs/spaced.md ',
  ].join('\n'), [
    { kind: 'modified', path: 'src/a => b.txt' },
    { kind: 'renamed', path: 'new.md', previousPath: 'old.txt' },
    { kind: 'renamed', path: 'src/new name.ts', previousPath: 'src/old name.ts' },
    { kind: 'modified', path: ' docs/spaced.md ' },
  ]).entries()], [
    ['src/a => b.txt', { added: 1, binary: false, removed: 1 }],
    ['new.md', { added: 0, binary: false, removed: 0 }],
    ['src/new name.ts', { added: 2, binary: false, removed: 3 }],
    [' docs/spaced.md ', { added: 4, binary: false, removed: 5 }],
  ]);
  assert.deepStrictEqual(fileFromPatch({ kind: 'modified', path: 'assets/logo.png', status: 'M' }, [
    'diff --git a/assets/logo.png b/assets/logo.png',
    'index aaaaaaa..bbbbbbb 100644',
    'GIT binary patch',
    'literal 4',
    'LcmeZ=00IC2',
  ].join('\n')), {
    added: 0,
    binary: true,
    diff: {
      diffHeader: [
        'diff --git a/assets/logo.png b/assets/logo.png',
        'index aaaaaaa..bbbbbbb 100644',
        'GIT binary patch',
      ],
      hunks: [],
    },
    kind: 'modified',
    newMode: '100644',
    newSha: 'bbbbbbb',
    oldMode: '100644',
    oldSha: 'aaaaaaa',
    path: 'assets/logo.png',
    removed: 0,
    status: 'M',
  });
  assert.deepStrictEqual(fileFromPatch({ kind: 'modified', path: 'src/review.ts', status: 'M' }, [
    'diff --git a/src/review.ts b/src/review.ts',
    'index 1111111..2222222 100644',
    '@@ -1,1 +1,1 @@',
    '-return files;',
    '+return reviewedFiles;',
  ].join('\n')), {
    added: 1,
    diff: {
      diffHeader: [
        'diff --git a/src/review.ts b/src/review.ts',
        'index 1111111..2222222 100644',
      ],
      hunks: [{
        header: '@@ -1,1 +1,1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        rows: [{ kind: 'changed', left: { line: 1, text: 'return files;' }, right: { line: 1, text: 'return reviewedFiles;' } }],
      }],
    },
    kind: 'modified',
    newMode: '100644',
    newSha: '2222222',
    oldMode: '100644',
    oldSha: '1111111',
    path: 'src/review.ts',
    removed: 1,
    status: 'M',
  });
  assert.deepStrictEqual(metadataFile({ kind: 'modified', path: 'src/huge.ts', status: 'M' }, {
    added: 0,
    diffTooExpensive: true,
    removed: 0,
    truncated: true,
  }), {
    added: 0,
    diff: { hunks: [], truncated: true },
    diffLoaded: false,
    diffTooExpensive: true,
    kind: 'modified',
    path: 'src/huge.ts',
    removed: 0,
    status: 'M',
  });

  const diffCalls = [];
  const gitCalls = [];
  const service = new ReviewDiffService({
    getAgentWorkspaceRoot(agentId) {
      return agentId === 'agent-1' ? '/workspace' : '';
    },
  }, {
    diffMaxBuffer: 1024 * 1024,
    diffTimeoutMs: 5000,
    gitPath: 'git',
    async execFile(command, args) {
      assert.strictEqual(command, 'git');
      gitCalls.push(args);
      const joined = args.join(' ');
      if (joined.includes('--name-status')) {
        return {
          stdout: [
            'M\tsrc/review.ts',
            'R100\told/name.ts\tnew/name.ts',
            'D\tremoved.ts',
          ].join('\n'),
        };
      }
      if (joined.includes('--numstat')) {
        return {
          stdout: [
            '1\t1\tsrc/review.ts',
            '0\t0\told/name.ts => new/name.ts',
            '0\t1\tremoved.ts',
          ].join('\n'),
        };
      }
      if (joined.includes('--raw')) {
        return {
          stdout: [
            ':100644 100644 1111111 2222222 M\tsrc/review.ts',
            ':100644 100644 3333333 3333333 R100\told/name.ts\tnew/name.ts',
            ':100644 000000 4444444 0000000 D\tremoved.ts',
          ].join('\n'),
        };
      }
      const filePath = args[args.length - 1];
      if (filePath === 'src/review.ts') return {
        stdout: [
          'diff --git a/src/review.ts b/src/review.ts',
          'index 1111111..2222222 100644',
          '@@ -2,1 +2,1 @@',
          '-return files;',
          '+return reviewedFiles;',
        ].join('\n'),
      };
      if (filePath === 'new/name.ts') return {
        stdout: [
          'diff --git a/old/name.ts b/new/name.ts',
          'similarity index 100%',
          'index 3333333..3333333 100644',
          'rename from old/name.ts',
          'rename to new/name.ts',
        ].join('\n'),
      };
      if (filePath === 'removed.ts') return {
        stdout: [
          'diff --git a/removed.ts b/removed.ts',
          'deleted file mode 100644',
          '@@ -1,1 +0,0 @@',
          '-removed();',
        ].join('\n'),
      };
      throw new Error(`unexpected git args: ${joined}`);
    },
    async changes(root, options) {
      assert.strictEqual(root, '/workspace');
      assert.ok(options.limit === 2 || options.limit === 3 || options.limit === 200);
      return {
        items: [
          { path: 'src/review.ts', gitStatus: 'modified' },
          { path: 'notes.md', gitStatus: 'untracked' },
          { path: 'staged.ts', gitStatus: 'added' },
        ],
        truncated: false,
      };
    },
    async diff(root, filePath, options = {}) {
      assert.strictEqual(root, '/workspace');
      diffCalls.push({ filePath, options });
      if (filePath === 'notes.md') return { untracked: true, modifiedContent: '# Review\n' };
      if (filePath === 'staged.ts') return {
        patch: [
          'diff --git a/staged.ts b/staged.ts',
          'new file mode 100644',
          '@@ -0,0 +1 @@',
          '+export const staged = true;',
        ].join('\n'),
        truncated: true,
        untracked: true,
      };
      return {
        patch: [
          'diff --git a/src/review.ts b/src/review.ts',
          'index 1111111..2222222 100644',
          '@@ -2,1 +2,2 @@',
          '-return files;',
          '+return reviewedFiles;',
          '+return status;',
        ].join('\n'),
      };
    },
  });

  const review = await service.getWorkingCopy('agent-1', { limit: 3 });
  const { patchset, reviewId, ...reviewWithoutIdentity } = review;
  assert.deepStrictEqual(reviewWithoutIdentity, {
    basePatchset: 'HEAD',
    files: [
      {
        added: 2,
        diff: {
          diffHeader: [
            'diff --git a/src/review.ts b/src/review.ts',
            'index 1111111..2222222 100644',
          ],
          hunks: [{
            header: '@@ -2,1 +2,2 @@',
            oldStart: 2,
            oldLines: 1,
            newStart: 2,
            newLines: 2,
            rows: [
              { kind: 'changed', left: { line: 2, text: 'return files;' }, right: { line: 2, text: 'return reviewedFiles;' } },
              { kind: 'added', right: { line: 3, text: 'return status;' } },
            ],
          }],
          truncated: false,
        },
        kind: 'modified',
        newMode: '100644',
        newSha: '2222222',
        oldMode: '100644',
        oldSha: '1111111',
        path: 'src/review.ts',
        removed: 1,
        status: 'M',
      },
      {
        added: 1,
        diff: {
          diffHeader: [
            'diff --git a/notes.md b/notes.md',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/notes.md',
          ],
          hunks: [{
            header: '@@ -0,0 +1,1 @@',
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            rows: [{ kind: 'added', right: { line: 1, text: '# Review' } }],
          }],
          truncated: false,
        },
        kind: 'added',
        newMode: '100644',
        path: 'notes.md',
        removed: 0,
        status: 'A',
      },
      {
        added: 1,
        diff: {
          diffHeader: [
            'diff --git a/staged.ts b/staged.ts',
            'new file mode 100644',
          ],
          hunks: [{
            header: '@@ -0,0 +1 @@',
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            rows: [{ kind: 'added', right: { line: 1, text: 'export const staged = true;' } }],
          }],
          truncated: true,
        },
        diffTooExpensive: true,
        kind: 'added',
        newMode: '100644',
        path: 'staged.ts',
        removed: 0,
        status: 'A',
      },
    ],
    isGitRepo: true,
    root: '/workspace',
    source: 'working-copy',
    truncated: false,
  });
  assert.strictEqual(reviewId, workingCopyReviewId('/workspace'));
  assert.strictEqual(patchset, workingCopyPatchset(review.files));
  const metadataOnlyWorkingCopy = await service.getWorkingCopy('agent-1', { limit: 3, metadataOnly: true });
  assert.strictEqual(metadataOnlyWorkingCopy.reviewId, review.reviewId);
  assert.strictEqual(metadataOnlyWorkingCopy.patchset, review.patchset);
  assert.deepStrictEqual(metadataOnlyWorkingCopy.files.map(file => ({
	    added: file.added,
	    diff: file.diff,
	    diffLoaded: file.diffLoaded,
	    diffTooExpensive: file.diffTooExpensive,
	    newMode: file.newMode,
    newSha: file.newSha,
    oldMode: file.oldMode,
    oldSha: file.oldSha,
    path: file.path,
    removed: file.removed,
  })), [
    { added: 2, diff: { hunks: [] }, diffLoaded: false, diffTooExpensive: undefined, newMode: '100644', newSha: '2222222', oldMode: '100644', oldSha: '1111111', path: 'src/review.ts', removed: 1 },
    { added: 1, diff: { hunks: [] }, diffLoaded: false, diffTooExpensive: undefined, newMode: '100644', newSha: undefined, oldMode: undefined, oldSha: undefined, path: 'notes.md', removed: 0 },
    { added: 1, diff: { hunks: [], truncated: true }, diffLoaded: false, diffTooExpensive: true, newMode: '100644', newSha: undefined, oldMode: undefined, oldSha: undefined, path: 'staged.ts', removed: 0 },
  ]);
  const presentationWorkingCopy = await service.getWorkingCopy('agent-1', { context: '25', ignoreWhitespace: 'ALL', limit: 3 });
  assert.strictEqual(presentationWorkingCopy.reviewId, review.reviewId);
  assert.strictEqual(presentationWorkingCopy.patchset, review.patchset);
  const workingCopyFile = await service.getWorkingCopyFile('agent-1', 'src/review.ts');
  assert.deepStrictEqual(workingCopyFile, review.files[0]);
  diffCalls.length = 0;
  const whitespaceIgnoredWorkingCopyFile = await service.getWorkingCopyFile('agent-1', 'src/review.ts', { ignoreWhitespace: 'ALL' });
  assert.deepStrictEqual(whitespaceIgnoredWorkingCopyFile, review.files[0]);
  assert.deepStrictEqual(diffCalls.map(call => call.options), [{}, { ignoreWhitespace: 'ALL' }]);
  diffCalls.length = 0;
  const contextWorkingCopyFile = await service.getWorkingCopyFile('agent-1', 'src/review.ts', { context: '25' });
  assert.deepStrictEqual(contextWorkingCopyFile, review.files[0]);
  assert.deepStrictEqual(diffCalls.map(call => call.options), [{}, { context: 25 }]);
  await assert.rejects(() => service.getWorkingCopyFile('agent-1', '../bad.ts'), /file path is required/);
  await assert.rejects(() => service.getWorkingCopyFile('agent-1', 'missing.ts'), /review file not found/);
  const downloaded = await service.getWorkingCopyPatch('agent-1', { limit: 3 });
  assert.strictEqual(downloaded.truncated, true);
  assert.match(downloaded.patch, /diff --git a\/src\/review\.ts b\/src\/review\.ts/);
  assert.match(downloaded.patch, /diff --git a\/notes\.md b\/notes\.md/);
  assert.match(downloaded.patch, /\+# Review/);
  assert.match(downloaded.patch, /new file mode 100644/);
  assert.match(downloaded.patch, /\+export const staged = true;/);
  diffCalls.length = 0;
  const contextPatch = await service.getWorkingCopyPatch('agent-1', { context: 10, limit: 3 });
  assert.match(contextPatch.patch, /diff --git a\/src\/review\.ts b\/src\/review\.ts/);
  assert.ok(diffCalls.every(call => call.options.context === 10));
  const limitedWorkingCopy = await service.getWorkingCopy('agent-1', { limit: 2, metadataOnly: true });
  assert.strictEqual(limitedWorkingCopy.truncated, true);
  assert.deepStrictEqual(limitedWorkingCopy.files.map(file => file.path), ['src/review.ts', 'notes.md']);
  const limitedPatch = await service.getWorkingCopyPatch('agent-1', { limit: 2 });
  assert.strictEqual(limitedPatch.truncated, true);
  assert.match(limitedPatch.patch, /diff --git a\/src\/review\.ts b\/src\/review\.ts/);
  assert.match(limitedPatch.patch, /diff --git a\/notes\.md b\/notes\.md/);
  assert.doesNotMatch(limitedPatch.patch, /staged\.ts/);
  const invalidLimitWorkingCopy = await service.getWorkingCopy('agent-1', { limit: 0, metadataOnly: true });
  assert.strictEqual(invalidLimitWorkingCopy.files.length, 3);
  const hugeUntrackedContent = Array.from({ length: 501 }, (_, index) => `line ${index + 1}`).join('\n');
  const hugeUntrackedService = new ReviewDiffService({
    getAgentWorkspaceRoot(agentId) {
      return agentId === 'agent-huge' ? '/huge-workspace' : '';
    },
  }, {
    async changes(root) {
      assert.strictEqual(root, '/huge-workspace');
      return {
        items: [{ path: 'huge.txt', gitStatus: 'untracked' }],
        truncated: false,
      };
    },
    async diff(root, filePath) {
      assert.strictEqual(root, '/huge-workspace');
      assert.strictEqual(filePath, 'huge.txt');
      return {
        modifiedContent: hugeUntrackedContent,
        untracked: true,
      };
    },
  });
  const hugeMetadataOnly = await hugeUntrackedService.getWorkingCopy('agent-huge', { metadataOnly: true });
  assert.strictEqual(hugeMetadataOnly.files[0].added, 500);
  assert.deepStrictEqual(hugeMetadataOnly.files[0].diff, { hunks: [], truncated: true });
  assert.strictEqual(hugeMetadataOnly.files[0].diffLoaded, false);
  assert.strictEqual(hugeMetadataOnly.files[0].diffTooExpensive, true);
  const hugeFull = await hugeUntrackedService.getWorkingCopy('agent-huge');
  assert.strictEqual(hugeFull.files[0].diff.hunks[0].rows.length, 500);
  assert.strictEqual(hugeFull.files[0].diff.truncated, true);
  assert.strictEqual(hugeFull.files[0].diffTooExpensive, true);
  const hugeFile = await hugeUntrackedService.getWorkingCopyFile('agent-huge', 'huge.txt');
  assert.strictEqual(hugeFile.diff.hunks[0].rows.length, 500);
  assert.strictEqual(hugeFile.diff.truncated, true);
  assert.strictEqual(hugeFile.diffTooExpensive, true);
  const hugePatch = await hugeUntrackedService.getWorkingCopyPatch('agent-huge');
  assert.strictEqual(hugePatch.truncated, true);
  assert.match(hugePatch.patch, /\+line 500/);
  assert.doesNotMatch(hugePatch.patch, /\+line 501/);
  const exactUntrackedContent = `${Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n')}\n`;
  const exactUntrackedService = new ReviewDiffService({
    getAgentWorkspaceRoot(agentId) {
      return agentId === 'agent-exact' ? '/exact-workspace' : '';
    },
  }, {
    async changes(root) {
      assert.strictEqual(root, '/exact-workspace');
      return {
        items: [{ path: 'exact.txt', gitStatus: 'untracked' }],
        truncated: false,
      };
    },
    async diff(root, filePath) {
      assert.strictEqual(root, '/exact-workspace');
      assert.strictEqual(filePath, 'exact.txt');
      return {
        modifiedContent: exactUntrackedContent,
        untracked: true,
      };
    },
  });
  const exactMetadataOnly = await exactUntrackedService.getWorkingCopy('agent-exact', { metadataOnly: true });
  assert.strictEqual(exactMetadataOnly.files[0].added, 500);
  assert.deepStrictEqual(exactMetadataOnly.files[0].diff, { hunks: [] });
  assert.strictEqual(exactMetadataOnly.files[0].diffTooExpensive, undefined);
  const exactFull = await exactUntrackedService.getWorkingCopy('agent-exact');
  assert.strictEqual(exactFull.files[0].diff.hunks[0].rows.length, 500);
  assert.strictEqual(exactFull.files[0].diff.truncated, false);
  assert.strictEqual(exactFull.files[0].diffTooExpensive, undefined);
  const exactPatch = await exactUntrackedService.getWorkingCopyPatch('agent-exact');
  assert.strictEqual(exactPatch.truncated, false);
  assert.match(exactPatch.patch, /\+line 500/);
  const truncatedTrackedPatchService = new ReviewDiffService({
    getAgentWorkspaceRoot(agentId) {
      return agentId === 'agent-truncated-patch' ? '/truncated-workspace' : '';
    },
  }, {
    async changes(root) {
      assert.strictEqual(root, '/truncated-workspace');
      return {
        items: [{ path: 'src/truncated.ts', gitStatus: 'modified' }],
        truncated: false,
      };
    },
    async diff(root, filePath) {
      assert.strictEqual(root, '/truncated-workspace');
      assert.strictEqual(filePath, 'src/truncated.ts');
      return {
        patch: [
          'diff --git a/src/truncated.ts b/src/truncated.ts',
          '@@ -1,1 +1,1 @@',
          '-old',
          '+new',
        ].join('\n'),
        truncated: true,
      };
    },
  });
  const truncatedTrackedPatch = await truncatedTrackedPatchService.getWorkingCopyPatch('agent-truncated-patch');
  assert.strictEqual(truncatedTrackedPatch.truncated, true);
  assert.match(truncatedTrackedPatch.patch, /diff --git a\/src\/truncated\.ts b\/src\/truncated\.ts/);
  assert.strictEqual(untrackedPatch('notes.txt', 'one\ntwo\n'), [
    'diff --git a/notes.txt b/notes.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/notes.txt',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    '',
  ].join('\n'));
  assert.strictEqual(untrackedPatch('empty.txt', ''), [
    'diff --git a/empty.txt b/empty.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/empty.txt',
    '@@ -0,0 +1,0 @@',
    '',
  ].join('\n'));
  const range = await service.getGitRange('agent-1', { base: 'HEAD~1', head: 'HEAD', limit: 10 });
  assert.ok(gitCalls.some(args => args.includes('--name-status') && args.includes('-z')));
  assert.deepStrictEqual(range, {
    basePatchset: 'HEAD~1',
    files: [
      {
        added: 1,
        diff: {
          diffHeader: [
            'diff --git a/src/review.ts b/src/review.ts',
            'index 1111111..2222222 100644',
          ],
          hunks: [{
            header: '@@ -2,1 +2,1 @@',
            oldStart: 2,
            oldLines: 1,
            newStart: 2,
            newLines: 1,
            rows: [{ kind: 'changed', left: { line: 2, text: 'return files;' }, right: { line: 2, text: 'return reviewedFiles;' } }],
          }],
        },
        kind: 'modified',
        newMode: '100644',
        newSha: '2222222',
        oldMode: '100644',
        oldSha: '1111111',
        path: 'src/review.ts',
        removed: 1,
        status: 'M',
      },
      {
        added: 0,
        diff: {
          diffHeader: [
            'diff --git a/old/name.ts b/new/name.ts',
            'similarity index 100%',
            'index 3333333..3333333 100644',
            'rename from old/name.ts',
            'rename to new/name.ts',
          ],
          hunks: [],
        },
        kind: 'renamed',
        newMode: '100644',
        newSha: '3333333',
        oldMode: '100644',
        oldSha: '3333333',
        path: 'new/name.ts',
        previousPath: 'old/name.ts',
        removed: 0,
        status: 'R',
      },
      {
        added: 0,
        diff: {
          diffHeader: [
            'diff --git a/removed.ts b/removed.ts',
            'deleted file mode 100644',
          ],
          hunks: [{
            header: '@@ -1,1 +0,0 @@',
            oldStart: 1,
            oldLines: 1,
            newStart: 0,
            newLines: 0,
            rows: [{ kind: 'deleted', left: { line: 1, text: 'removed();' } }],
          }],
        },
        kind: 'deleted',
        oldMode: '100644',
        path: 'removed.ts',
        removed: 1,
        status: 'D',
      },
    ],
    isGitRepo: true,
    patchset: 'HEAD',
    reviewId: gitRangeReviewId('/workspace', 'HEAD~1', 'HEAD'),
    root: '/workspace',
    source: 'git-range',
    truncated: false,
  });
  gitCalls.length = 0;
  const metadataOnlyRange = await service.getGitRange('agent-1', { base: 'HEAD~1', head: 'HEAD', limit: 10, metadataOnly: true });
  assert.strictEqual(metadataOnlyRange.reviewId, range.reviewId);
  assert.strictEqual(metadataOnlyRange.patchset, range.patchset);
  const metadataNumstatCall = gitCalls.find(args => args.includes('--numstat') && args.includes('-z'));
  const metadataRawCall = gitCalls.find(args => args.includes('--raw') && args.includes('-z'));
  assert.ok(metadataNumstatCall);
  assert.ok(metadataRawCall);
  assert.deepStrictEqual(pathspecAfterDoubleDash(metadataNumstatCall), ['src/review.ts', 'old/name.ts', 'new/name.ts', 'removed.ts']);
  assert.deepStrictEqual(pathspecAfterDoubleDash(metadataRawCall), ['src/review.ts', 'old/name.ts', 'new/name.ts', 'removed.ts']);
  assert.deepStrictEqual(metadataOnlyRange.files, [
    {
      added: 1,
      diff: { hunks: [] },
      diffLoaded: false,
      kind: 'modified',
      newMode: '100644',
      newSha: '2222222',
      oldMode: '100644',
      oldSha: '1111111',
      path: 'src/review.ts',
      removed: 1,
      status: 'M',
    },
    {
      added: 0,
      diff: { hunks: [] },
      diffLoaded: false,
      kind: 'renamed',
      newMode: '100644',
      newSha: '3333333',
      oldMode: '100644',
      oldSha: '3333333',
      path: 'new/name.ts',
      previousPath: 'old/name.ts',
      removed: 0,
      status: 'R',
    },
    {
      added: 0,
      diff: { hunks: [] },
      diffLoaded: false,
      kind: 'deleted',
      oldMode: '100644',
      oldSha: '4444444',
      path: 'removed.ts',
      removed: 1,
      status: 'D',
    },
  ]);
  const presentationRange = await service.getGitRange('agent-1', { base: 'HEAD~1', context: '25', head: 'HEAD', ignoreWhitespace: 'ALL', limit: 10 });
  assert.strictEqual(presentationRange.reviewId, range.reviewId);
  assert.strictEqual(presentationRange.patchset, range.patchset);
  const rangeFile = await service.getGitRangeFile('agent-1', { base: 'HEAD~1', head: 'HEAD', path: 'new/name.ts' });
  assert.deepStrictEqual(rangeFile, range.files[1]);

  const nulServiceCalls = [];
  const nulService = new ReviewDiffService({
    getAgentWorkspaceRoot(agentId) {
      return agentId === 'agent-nul' ? '/workspace' : '';
    },
  }, {
    diffMaxBuffer: 1024 * 1024,
    diffTimeoutMs: 5000,
    gitPath: 'git',
    async execFile(command, args) {
      assert.strictEqual(command, 'git');
      nulServiceCalls.push(args);
      const joined = args.join(' ');
      if (joined.includes('--name-status')) {
        assert.ok(args.includes('-z'));
        return {
          stdout: [
            'R100', 'src/a\tfile.txt', 'src/b\tfile.txt',
            'M', 'src/line\nfile.txt',
            'M', ' docs/spaced.md ',
          ].join('\0') + '\0',
        };
      }
      if (joined.includes('--numstat')) {
        assert.ok(args.includes('-z'));
        return {
          stdout: [
            '0\t0\t', 'src/a\tfile.txt', 'src/b\tfile.txt',
            '1\t1\tsrc/line\nfile.txt',
            '4\t5\t docs/spaced.md ',
          ].join('\0') + '\0',
        };
      }
      if (joined.includes('--raw')) {
        assert.ok(args.includes('-z'));
        return {
          stdout: [
            ':100644 100644 5626abf 5626abf R100', 'src/a\tfile.txt', 'src/b\tfile.txt',
            ':100644 100644 f719efd 6bff0eb M', 'src/line\nfile.txt',
            ':100644 100644 aaaaaaa bbbbbbb M', ' docs/spaced.md ',
          ].join('\0') + '\0',
        };
      }
      const filePath = args[args.length - 1];
      if (filePath === 'src/line\nfile.txt') return {
        stdout: [
          'diff --git "a/src/line\\nfile.txt" "b/src/line\\nfile.txt"',
          'index f719efd..6bff0eb 100644',
          '@@ -1,1 +1,1 @@',
          '-old',
          '+new',
        ].join('\n'),
      };
      if (filePath === 'src/b\tfile.txt') return {
        stdout: [
          'diff --git "a/src/a\\tfile.txt" "b/src/b\\tfile.txt"',
          'similarity index 100%',
          'index 5626abf..5626abf 100644',
          'rename from "src/a\\tfile.txt"',
          'rename to "src/b\\tfile.txt"',
        ].join('\n'),
      };
      if (filePath === ' docs/spaced.md ') return {
        stdout: [
          'diff --git "a/ docs/spaced.md " "b/ docs/spaced.md "',
          'index aaaaaaa..bbbbbbb 100644',
          '@@ -1,1 +1,1 @@',
          '-old spaced',
          '+new spaced',
        ].join('\n'),
      };
      throw new Error(`unexpected nul git args: ${joined}`);
    },
  });
  const nulMetadataOnlyRange = await nulService.getGitRange('agent-nul', { base: 'HEAD~1', head: 'HEAD', limit: 10, metadataOnly: true });
  assert.deepStrictEqual(nulMetadataOnlyRange.files, [
    {
      added: 0,
      diff: { hunks: [] },
      diffLoaded: false,
      kind: 'renamed',
      newMode: '100644',
      newSha: '5626abf',
      oldMode: '100644',
      oldSha: '5626abf',
      path: 'src/b\tfile.txt',
      previousPath: 'src/a\tfile.txt',
      removed: 0,
      status: 'R',
    },
    {
      added: 1,
      diff: { hunks: [] },
      diffLoaded: false,
      kind: 'modified',
      newMode: '100644',
      newSha: '6bff0eb',
      oldMode: '100644',
      oldSha: 'f719efd',
      path: 'src/line\nfile.txt',
      removed: 1,
      status: 'M',
    },
    {
      added: 4,
      diff: { hunks: [] },
      diffLoaded: false,
      kind: 'modified',
      newMode: '100644',
      newSha: 'bbbbbbb',
      oldMode: '100644',
      oldSha: 'aaaaaaa',
      path: ' docs/spaced.md ',
      removed: 5,
      status: 'M',
    },
  ]);
  const nulRangeFile = await nulService.getGitRangeFile('agent-nul', { base: 'HEAD~1', head: 'HEAD', path: 'src/line\nfile.txt' });
  assert.deepStrictEqual({
    added: nulRangeFile.added,
    newSha: nulRangeFile.newSha,
    oldSha: nulRangeFile.oldSha,
    path: nulRangeFile.path,
    removed: nulRangeFile.removed,
  }, {
    added: 1,
    newSha: '6bff0eb',
    oldSha: 'f719efd',
    path: 'src/line\nfile.txt',
    removed: 1,
  });
  const spacedRangeFile = await nulService.getGitRangeFile('agent-nul', {
    base: 'HEAD~1',
    head: 'HEAD',
    ignoreWhitespace: 'ALL',
    path: ' docs/spaced.md ',
  });
  assert.deepStrictEqual({
    added: spacedRangeFile.added,
    newSha: spacedRangeFile.newSha,
    oldSha: spacedRangeFile.oldSha,
    path: spacedRangeFile.path,
    removed: spacedRangeFile.removed,
  }, {
    added: 4,
    newSha: 'bbbbbbb',
    oldSha: 'aaaaaaa',
    path: ' docs/spaced.md ',
    removed: 5,
  });
  assert.ok(nulServiceCalls.some(args => args.includes('--name-status') && args.includes('-z')));
  const nulNumstatCall = nulServiceCalls.find(args => args.includes('--numstat') && args.includes('-z'));
  const nulRawCall = nulServiceCalls.find(args => args.includes('--raw') && args.includes('-z'));
  assert.ok(nulNumstatCall);
  assert.ok(nulRawCall);
  assert.deepStrictEqual(pathspecAfterDoubleDash(nulNumstatCall), ['src/a\tfile.txt', 'src/b\tfile.txt', 'src/line\nfile.txt', ' docs/spaced.md ']);
  assert.deepStrictEqual(pathspecAfterDoubleDash(nulRawCall), ['src/a\tfile.txt', 'src/b\tfile.txt', 'src/line\nfile.txt', ' docs/spaced.md ']);

  gitCalls.length = 0;
  await service.getGitRange('agent-1', { base: 'HEAD~1', head: 'HEAD', ignoreWhitespace: 'ALL', limit: 10 });
  assert.ok(gitCalls.some(args => args.includes('--numstat') && args.includes('--ignore-all-space')));
  assert.ok(gitCalls.some(args => args.includes('diff') && !args.includes('--numstat') && args.includes('--ignore-all-space')));
  gitCalls.length = 0;
  const whitespaceIgnoredRangeFile = await service.getGitRangeFile('agent-1', {
    base: 'HEAD~1',
    context: '25',
    head: 'HEAD',
    ignoreWhitespace: 'TRAILING',
    path: 'src/review.ts',
  });
  assert.strictEqual(whitespaceIgnoredRangeFile.added, 1);
  const fileNumstatCall = gitCalls.find(args => args.includes('--numstat') && args.includes('--ignore-space-at-eol'));
  assert.ok(fileNumstatCall);
  assert.deepStrictEqual(pathspecAfterDoubleDash(fileNumstatCall), ['src/review.ts']);
  assert.ok(gitCalls.some(args => args.includes('diff') && !args.includes('--numstat') && args.includes('--ignore-space-at-eol')));
  assert.ok(gitCalls.some(args => args.includes('--unified=25')));
  gitCalls.length = 0;
  const rangePatch = await service.getGitRangePatch('agent-1', { base: 'HEAD~1', head: 'HEAD', limit: 2 });
  assert.strictEqual(rangePatch.truncated, true);
  assert.match(rangePatch.patch, /diff --git a\/src\/review\.ts b\/src\/review\.ts/);
  assert.match(rangePatch.patch, /diff --git a\/old\/name\.ts b\/new\/name\.ts/);
  const rangePatchDiffCalls = gitCalls.filter(args => args.includes('diff') && !args.includes('--name-status'));
  assert.deepStrictEqual(rangePatchDiffCalls.map(pathspecAfterDoubleDash), [
    ['src/review.ts'],
    ['old/name.ts', 'new/name.ts'],
  ]);
  const invalidLimitRangePatch = await service.getGitRangePatch('agent-1', { base: 'HEAD~1', head: 'HEAD', limit: 0 });
  assert.strictEqual(invalidLimitRangePatch.truncated, false);
  assert.match(invalidLimitRangePatch.patch, /diff --git a\/removed\.ts b\/removed\.ts/);
  gitCalls.length = 0;
  const whitespaceIgnoredRangePatch = await service.getGitRangePatch('agent-1', { base: 'HEAD~1', context: '100', head: 'HEAD', ignoreWhitespace: 'LEADING_AND_TRAILING', limit: 2 });
  assert.match(whitespaceIgnoredRangePatch.patch, /diff --git a\/src\/review\.ts b\/src\/review\.ts/);
  assert.ok(gitCalls.some(args => args.includes('--ignore-space-change')));
  assert.ok(gitCalls.some(args => args.includes('--unified=100')));

  const duplicateWorkingCopyService = new ReviewDiffService({
    getAgentWorkspaceRoot(agentId) {
      return agentId === 'agent-duplicate' ? '/workspace' : '';
    },
  }, {
    async changes() {
      return {
        items: [
          { path: 'src/review.ts', gitStatus: 'modified' },
          { path: 'src/review.ts', gitStatus: 'modified' },
        ],
        truncated: false,
      };
    },
    async diff() {
      throw new Error('duplicate working-copy paths should fail before diff loading');
    },
  });
  await assert.rejects(
    () => duplicateWorkingCopyService.getWorkingCopy('agent-duplicate'),
    /duplicate file paths/
  );
  await assert.rejects(
    () => duplicateWorkingCopyService.getWorkingCopyFile('agent-duplicate', 'src/review.ts'),
    /duplicate file paths/
  );
  await assert.rejects(
    () => duplicateWorkingCopyService.getWorkingCopyPatch('agent-duplicate'),
    /duplicate file paths/
  );

  const duplicateGitRangeService = new ReviewDiffService({
    getAgentWorkspaceRoot(agentId) {
      return agentId === 'agent-duplicate' ? '/workspace' : '';
    },
  }, {
    diffMaxBuffer: 1024 * 1024,
    diffTimeoutMs: 5000,
    gitPath: 'git',
    async execFile(command, args) {
      assert.strictEqual(command, 'git');
      if (args.includes('--name-status')) {
        return { stdout: ['M\tsrc/review.ts', 'M\tsrc/review.ts'].join('\n') };
      }
      throw new Error('duplicate git range paths should fail before diff loading');
    },
  });
  await assert.rejects(
    () => duplicateGitRangeService.getGitRange('agent-duplicate', { base: 'HEAD~1', head: 'HEAD' }),
    /duplicate file paths/
  );
  await assert.rejects(
    () => duplicateGitRangeService.getGitRangeFile('agent-duplicate', { base: 'HEAD~1', head: 'HEAD', path: 'src/review.ts' }),
    /duplicate file paths/
  );
  await assert.rejects(
    () => duplicateGitRangeService.getGitRangePatch('agent-duplicate', { base: 'HEAD~1', head: 'HEAD' }),
    /duplicate file paths/
  );

  await assert.rejects(() => service.getGitRange('agent-1', { base: '--bad', head: 'HEAD' }), /base and head revisions are required/);
  await assert.rejects(() => service.getGitRangeFile('agent-1', { base: 'HEAD~1', head: 'HEAD', path: '/bad.ts' }), /file path is required/);
  await assert.rejects(() => service.getGitRangeFile('agent-1', { base: 'HEAD~1', head: 'HEAD', path: 'missing.ts' }), /review file not found/);
  await assert.rejects(() => service.getGitRangePatch('agent-1', { base: '--bad', head: 'HEAD' }), /base and head revisions are required/);
  await assert.rejects(() => service.getWorkingCopy('missing'), /agent not found/);

  const commitMetadataService = new ReviewDiffService(null, {
    diffMaxBuffer: 1024 * 1024,
    diffTimeoutMs: 5000,
    gitPath: 'git',
    async execFile(command, args) {
      assert.strictEqual(command, 'git');
      assert.ok(args.includes('--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B'));
      return { stdout: '2222222222222222222222222222222222222222\x1fReview Author\x1freviewer@example.com\x1f2026-07-11T09:30:00+08:00\x1fMake review context interactive\n\nKeep the diff focused.\n' };
    },
  });
  assert.deepStrictEqual(await commitMetadataService.getCommitSummary('/workspace', 'HEAD'), {
    authoredAt: '2026-07-11T09:30:00+08:00',
    authorEmail: 'reviewer@example.com',
    authorName: 'Review Author',
    id: '2222222222222222222222222222222222222222',
    message: 'Make review context interactive\n\nKeep the diff focused.',
  });
  console.log('test-review-diff-service passed');
}

run();
