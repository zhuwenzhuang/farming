const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  WorkspaceFileService,
  WorkspaceFileError,
  DEFAULT_WATCH_DEPTH,
  resolveCommandRunnerNodePath,
} = require('../workspace-file-service');

function hasCommand(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function assertRejectsWithStatus(promise, statusCode) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof WorkspaceFileError);
  assert.strictEqual(error.statusCode, statusCode);
}

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

async function run() {
  const previousNodeBin = process.env.FARMING_NODE_BIN;
  try {
    process.env.FARMING_NODE_BIN = '/tmp/farming-node-bin';
    assert.strictEqual(resolveCommandRunnerNodePath(), '/tmp/farming-node-bin');
    assert.strictEqual(resolveCommandRunnerNodePath({ nodePath: '/tmp/explicit-node' }), '/tmp/explicit-node');
    delete process.env.FARMING_NODE_BIN;
    assert.strictEqual(resolveCommandRunnerNodePath(), process.execPath);
  } finally {
    if (previousNodeBin === undefined) {
      delete process.env.FARMING_NODE_BIN;
    } else {
      process.env.FARMING_NODE_BIN = previousNodeBin;
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-files-'));
  const workspace = path.join(tmpRoot, 'repo');
  const outside = path.join(tmpRoot, 'outside.txt');
  const srcDir = path.join(workspace, 'src');
  const service = new WorkspaceFileService({
    maxFileSize: 1024 * 32,
    maxWriteSize: 1024 * 32,
    gitStatusCacheTtlMs: 0,
    gitStatusInlineTimeoutMs: 0,
    watchOptions: { usePolling: true, interval: 50 },
  });
  assert.strictEqual(DEFAULT_WATCH_DEPTH, 1);
  assert.strictEqual(service.watchDepth, DEFAULT_WATCH_DEPTH);
  const cacheWorkspace = path.join(tmpRoot, 'cache-repo');

  try {
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(workspace, '.farming'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.dolt'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.idea'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.tmp'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'dist-release'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'reference', 'poem'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'test-results'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'playwright-report'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'poem'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'archive', 'poem', 'bundle'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Farming\n');
    fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'export const label = "Farming";\n');
    fs.writeFileSync(path.join(workspace, 'poem', 'collection.zip'), 'zip\n');
    fs.writeFileSync(path.join(workspace, 'archive', 'poem', 'bundle', 'notes.txt'), 'nested poem folder\n');
    fs.writeFileSync(path.join(workspace, 'node_modules', 'ignored.js'), 'ignored');
    fs.writeFileSync(path.join(workspace, '.farming', 'AGENTS.md'), 'internal');
    fs.writeFileSync(path.join(workspace, '.dolt', 'ignored.db'), 'ignored dolt\n');
    fs.writeFileSync(path.join(workspace, '.idea', 'workspace.xml'), 'ignored idea\n');
    fs.writeFileSync(path.join(workspace, '.tmp', 'ignored.tmp'), 'ignored tmp\n');
    fs.writeFileSync(path.join(workspace, 'dist-release', 'ignored.tgz'), 'ignored release\n');
    fs.writeFileSync(path.join(workspace, 'reference', 'codex-reference.md'), 'codex reference\n');
    fs.writeFileSync(path.join(workspace, 'reference', 'poem', 'hidden.txt'), 'hidden poem content\n');
    fs.writeFileSync(path.join(workspace, 'test-results', 'ignored.txt'), 'ignored test result\n');
    fs.writeFileSync(path.join(workspace, 'playwright-report', 'index.html'), '<html></html>\n');
    fs.writeFileSync(path.join(workspace, '.DS_Store'), 'ignored metadata\n');
    fs.writeFileSync(path.join(workspace, 'server.log'), 'ignored log\n');
    fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0]));
    fs.writeFileSync(path.join(workspace, 'large.log'), `${'large text line\n'.repeat(3000)}`);
    fs.writeFileSync(path.join(workspace, 'preview.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgF/2l2fLwAAAABJRU5ErkJggg==',
      'base64'
    ));
    fs.writeFileSync(outside, 'outside');
    try {
      fs.symlinkSync(outside, path.join(workspace, 'outside-link.txt'));
    } catch {
      // Some environments disallow symlinks; the path traversal assertions still cover the guard.
    }
    try {
      fs.symlinkSync(path.join(workspace, 'README.md'), path.join(workspace, 'readme-link.md'));
    } catch {
      // Some environments disallow symlinks; skip the symlink path-preservation assertion there.
    }

    const tree = await service.listTree(workspace, '');
    const treeNames = tree.items.map(item => item.name);
    assert(treeNames.includes('src'));
    assert(treeNames.includes('README.md'));
    assert(!tree.items.some(item => item.name === '.farming'));
    assert(!tree.items.some(item => item.name === '.dolt'));
    assert(!tree.items.some(item => item.name === '.idea'));
    assert(!tree.items.some(item => item.name === '.tmp'));
    assert(!tree.items.some(item => item.name === 'node_modules'));
    assert(!tree.items.some(item => item.name === 'dist-release'));
    const referenceTreeItem = tree.items.find(item => item.name === 'reference');
    assert(referenceTreeItem);
    assert.strictEqual(referenceTreeItem.type, 'directory');
    assert(!tree.items.some(item => item.name === 'test-results'));
    assert(!tree.items.some(item => item.name === 'playwright-report'));
    assert(!tree.items.some(item => item.name === '.DS_Store'));
    assert(!tree.items.some(item => item.name === 'server.log'));

    const vanishingPath = path.join(workspace, 'vanishing.tmp');
    const vanishingRealPath = fs.realpathSync(workspace);
    const vanishingAbsolutePath = path.join(vanishingRealPath, 'vanishing.tmp');
    fs.writeFileSync(vanishingPath, 'gone soon');
    const originalLstat = fsp.lstat;
    fsp.lstat = async (targetPath, ...args) => {
      if (targetPath === vanishingAbsolutePath) {
        fs.rmSync(vanishingPath, { force: true });
        const error = new Error('vanished');
        error.code = 'ENOENT';
        throw error;
      }
      return originalLstat.call(fsp, targetPath, ...args);
    };
    try {
      const treeWithVanishingEntry = await service.listTree(workspace, '');
      assert(!treeWithVanishingEntry.items.some(item => item.name === 'vanishing.tmp'));
    } finally {
      fsp.lstat = originalLstat;
    }

    const file = await service.readFile(workspace, 'src/App.tsx');
    assert.strictEqual(file.path, 'src/App.tsx');
    assert(file.sha1);
    assert(file.content.includes('Farming'));
    if (fs.existsSync(path.join(workspace, 'readme-link.md'))) {
      const symlinkFile = await service.readFile(workspace, 'readme-link.md');
      assert.strictEqual(symlinkFile.path, 'readme-link.md');
      assert(symlinkFile.content.includes('Farming'));
    }

    await assertRejectsWithStatus(service.readFile(workspace, '../outside.txt'), 403);
    if (fs.existsSync(path.join(workspace, 'outside-link.txt'))) {
      await assertRejectsWithStatus(service.readFile(workspace, 'outside-link.txt'), 403);
    }
    const binaryFile = await service.readFile(workspace, 'binary.bin');
    assert.strictEqual(binaryFile.path, 'binary.bin');
    assert.strictEqual(binaryFile.content, '');
    assert.strictEqual(binaryFile.binary, true);
    assert.strictEqual(binaryFile.preview.kind, 'binary');
    assert.strictEqual(binaryFile.preview.mediaType, 'application/octet-stream');
    assert(binaryFile.sha1);
    const imageFile = await service.readFile(workspace, 'preview.png');
    assert.strictEqual(imageFile.path, 'preview.png');
    assert.strictEqual(imageFile.content, '');
    assert.strictEqual(imageFile.binary, true);
    assert.strictEqual(imageFile.preview.kind, 'image');
    assert.strictEqual(imageFile.preview.mediaType, 'image/png');
    assert(imageFile.sha1);
    const imagePreview = await service.readPreviewFile(workspace, 'preview.png');
    assert.strictEqual(imagePreview.path, 'preview.png');
    assert.strictEqual(imagePreview.preview.mediaType, 'image/png');
    assert(Buffer.isBuffer(imagePreview.buffer));
    assert(imagePreview.buffer.length > 0);
    await assertRejectsWithStatus(service.readPreviewFile(workspace, 'README.md'), 415);
    await assertRejectsWithStatus(service.readPreviewFile(workspace, 'binary.bin'), 415);
    await assertRejectsWithStatus(service.writeFile(workspace, 'binary.bin', 'overwrite\n', {
      baseSha1: binaryFile.sha1,
    }), 415);
    const largeTextFile = await service.readFile(workspace, 'large.log');
    assert.strictEqual(largeTextFile.path, 'large.log');
    assert(largeTextFile.content.startsWith('large text line\n'));
    assert(largeTextFile.content.length < fs.readFileSync(path.join(workspace, 'large.log'), 'utf8').length);
    assert.strictEqual(largeTextFile.preview.kind, 'large-text');
    assert.strictEqual(largeTextFile.preview.mediaType, 'text/plain');
    assert.strictEqual(largeTextFile.preview.truncated, true);
    assert(largeTextFile.size > 1024 * 32);
    assert(largeTextFile.sha1);
    await assertRejectsWithStatus(service.writeFile(workspace, 'large.log', 'overwrite\n', {
      baseSha1: largeTextFile.sha1,
    }), 413);

    const saved = await service.writeFile(workspace, 'src/App.tsx', 'export const label = "Saved";\n', {
      baseSha1: file.sha1,
    });
    assert(saved.sha1 !== file.sha1);
    assert.strictEqual(fs.readFileSync(path.join(srcDir, 'App.tsx'), 'utf8'), 'export const label = "Saved";\n');

    fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'external change\n');
    await assertRejectsWithStatus(service.writeFile(workspace, 'src/App.tsx', 'stale save\n', {
      baseSha1: saved.sha1,
    }), 409);

    const newFile = await service.writeFile(workspace, 'src/NewFile.ts', 'new file\n');
    assert.strictEqual(newFile.path, 'src/NewFile.ts');

    const createdDirectory = await service.createEntry(workspace, '', 'notes', 'directory');
    assert.strictEqual(createdDirectory.entry.path, 'notes');
    assert.strictEqual(fs.existsSync(path.join(workspace, 'notes')), true);
    const createdFile = await service.createEntry(workspace, 'notes', 'todo.md', 'file', '# Todo\n');
    assert.strictEqual(createdFile.entry.path, 'notes/todo.md');
    assert.strictEqual(createdFile.file.content, '# Todo\n');
    await assertRejectsWithStatus(service.createEntry(workspace, 'notes', '../bad.md', 'file'), 400);
    await assertRejectsWithStatus(service.createEntry(workspace, '', '.git', 'directory'), 403);

    const renamedFile = await service.renameEntry(workspace, 'notes/todo.md', 'done.md');
    assert.strictEqual(renamedFile.sourcePath, 'notes/todo.md');
    assert.strictEqual(renamedFile.targetPath, 'notes/done.md');
    assert.strictEqual(fs.existsSync(path.join(workspace, 'notes', 'done.md')), true);
    await assertRejectsWithStatus(service.renameEntry(workspace, 'notes/done.md', '../escape.md'), 400);

    const deletedFile = await service.deleteEntry(workspace, 'notes/done.md');
    assert.strictEqual(deletedFile.path, 'notes/done.md');
    assert.strictEqual(deletedFile.parentDirectory, 'notes');
    assert.strictEqual(fs.existsSync(path.join(workspace, 'notes', 'done.md')), false);
    const deletedDirectory = await service.deleteEntry(workspace, 'notes');
    assert.strictEqual(deletedDirectory.path, 'notes');
    assert.strictEqual(deletedDirectory.type, 'directory');
    assert.strictEqual(fs.existsSync(path.join(workspace, 'notes')), false);
    await assertRejectsWithStatus(service.deleteEntry(workspace, ''), 400);
    await assertRejectsWithStatus(service.deleteEntry(workspace, '.farming'), 403);

    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    const movedFile = await service.moveEntry(workspace, 'src/NewFile.ts', 'docs');
    assert.strictEqual(movedFile.sourcePath, 'src/NewFile.ts');
    assert.strictEqual(movedFile.targetPath, 'docs/NewFile.ts');
    assert.strictEqual(fs.existsSync(path.join(workspace, 'docs', 'NewFile.ts')), true);
    assert.strictEqual(fs.existsSync(path.join(srcDir, 'NewFile.ts')), false);
    fs.mkdirSync(path.join(workspace, 'noise', 'n-e-w-f-i-l-e'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'noise', 'n-e-w-f-i-l-e', 'fixture.ts'), 'noise\n');
    fs.mkdirSync(path.join(workspace, 'noise', 'gc_safepoint'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'noise', 'gc_safepoint', 'controller_test.go'), 'fep noise\n');
    fs.writeFileSync(path.join(workspace, 'noise', 'gc_safepoint_controller_test.go'), 'fep noise\n');
    fs.mkdirSync(path.join(workspace, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'ui', 'FileEditorPane.tsx'), 'pane\n');
    fs.writeFileSync(path.join(srcDir, 'codex-note.md'), 'codex note\n');
    fs.writeFileSync(path.join(workspace, 'docs', 'App.tsx'), 'existing target\n');
    await assertRejectsWithStatus(service.moveEntry(workspace, 'src/App.tsx', 'docs'), 409);
    await assertRejectsWithStatus(service.moveEntry(workspace, 'docs', 'docs'), 400);

    assert(
      service.rgPath.includes(`node_modules${path.sep}ripgrep${path.sep}lib${path.sep}rg.mjs`) ||
        service.rgPath.includes('node_modules/ripgrep/lib/rg.mjs'),
      'workspace file search should prefer the bundled ripgrep entrypoint'
    );

    const bundledOnlyService = new WorkspaceFileService({
      rgPath: 'farming-missing-rg-for-test',
      rgFallbackPath: '',
      commandRunner: {
        run: async () => {
          const error = new Error('external rg is not installed');
          error.code = 'ENOENT';
          throw error;
        },
      },
    });
    try {
      const bundledOnlySearch = await bundledOnlyService.search(workspace, 'external');
      assert(
        bundledOnlySearch.matches.some(match => match.path === 'src/App.tsx'),
        'workspace file search should work through bundled ripgrep when external rg is unavailable'
      );
    } finally {
      await bundledOnlyService.dispose();
    }

    if (hasCommand('rg')) {
      const search = await service.search(workspace, 'external');
      assert(search.matches.some(match => match.path === 'src/App.tsx'));

      const pathSearch = await service.search(workspace, 'NewFile');
      assert.strictEqual(pathSearch.matches[0].kind, 'path');
      assert.strictEqual(pathSearch.matches[0].entryType, 'file');
      assert.strictEqual(pathSearch.matches[0].path, 'docs/NewFile.ts');
      assert.strictEqual(pathSearch.matches[0].lines, '');
      assert(!pathSearch.matches.some(match => match.path.startsWith('node_modules/')));
      assert(!pathSearch.matches.some(match => match.path.startsWith('noise/')));
      const directoryNameSearch = await service.search(workspace, 'poem', { limit: 10 });
      assert.strictEqual(directoryNameSearch.matches[0].kind, 'path');
      assert.strictEqual(directoryNameSearch.matches[0].entryType, 'directory');
      assert.strictEqual(directoryNameSearch.matches[0].path, 'poem');
      assert(directoryNameSearch.matches.some(match => (
        match.path === 'archive/poem' && match.entryType === 'directory'
      )));
      assert(directoryNameSearch.matches.some(match => (
        match.path === 'reference/poem' && match.entryType === 'directory'
      )));
      assert(!directoryNameSearch.matches.some(match => match.path === 'poem/collection.zip'));
      assert(!directoryNameSearch.matches.some(match => match.path === 'reference/poem/hidden.txt'));
      assert(!directoryNameSearch.matches.some(match => (
        match.kind === 'path' && match.path === 'archive/poem/bundle/notes.txt'
      )));
      const directoryPathSearch = await service.search(workspace, 'src/', { limit: 5 });
      assert(directoryPathSearch.matches.some(match => match.path === 'src/App.tsx'));
      assert(!directoryPathSearch.matches.some(match => match.path === 'src'));
      if (fs.existsSync(path.join(workspace, 'readme-link.md'))) {
        const symlinkPathSearch = await service.search(workspace, 'readme-link.md');
        assert.strictEqual(symlinkPathSearch.matches[0].path, 'readme-link.md');
      }

      let contentSearchWasCalled = false;
      const pathOnlyService = new WorkspaceFileService({
        commandRunner: {
          run: async (_command, args) => {
            if (args.includes('--json')) {
              contentSearchWasCalled = true;
              throw new Error('content search should not run when path matches fill the limit');
            }
            return {
              stdout: 'src/App.tsx\nsrc/App.test.tsx\nREADME.md\n',
              stderr: '',
            };
          },
        },
      });
      try {
        const pathOnlySearch = await pathOnlyService.search(workspace, 'App', { limit: 2 });
        assert.strictEqual(pathOnlySearch.matches.length, 2);
        assert(pathOnlySearch.matches.every(match => match.kind === 'path'));
        assert.strictEqual(pathOnlySearch.truncated, true);
        assert.strictEqual(contentSearchWasCalled, false);
      } finally {
        await pathOnlyService.dispose();
      }

      const abbreviationSearch = await service.search(workspace, 'fep');
      assert.strictEqual(abbreviationSearch.matches[0].kind, 'path');
      assert.strictEqual(abbreviationSearch.matches[0].path, 'ui/FileEditorPane.tsx');

      const referenceSearch = await service.search(workspace, 'codex');
      assert(referenceSearch.matches.some(match => match.path === 'src/codex-note.md'));
      assert(!referenceSearch.matches.some(match => match.path.startsWith('reference/')));

      const hiddenSearch = await service.search(workspace, 'ignored');
      assert(!hiddenSearch.matches.some(match => match.path.startsWith('.dolt/')));
      assert(!hiddenSearch.matches.some(match => match.path.startsWith('.idea/')));
      assert(!hiddenSearch.matches.some(match => match.path.startsWith('.tmp/')));
      assert(!hiddenSearch.matches.some(match => match.path.startsWith('dist-release/')));
      assert(!hiddenSearch.matches.some(match => match.path === '.DS_Store'));
      assert(!hiddenSearch.matches.some(match => match.path === 'server.log'));

      const fallbackService = new WorkspaceFileService({
        rgPath: 'farming-missing-rg-for-test',
        rgFallbackPath: 'rg',
      });
      try {
        const fallbackSearch = await fallbackService.search(workspace, 'external');
        assert(fallbackSearch.matches.some(match => match.path === 'src/App.tsx'));
        assert.strictEqual(fallbackService.rgPath, 'rg');
      } finally {
        await fallbackService.dispose();
      }

      const timeoutService = new WorkspaceFileService({
        commandRunner: {
          run: async (_command, args) => {
            const error = new Error('ripgrep timed out');
            error.code = 'ETIMEDOUT';
            error.stdout = args.includes('--json')
              ? `${JSON.stringify({
                type: 'match',
                data: {
                  path: { text: 'src/App.tsx' },
                  line_number: 1,
                  lines: { text: 'external change\n' },
                  submatches: [{ start: 0, end: 8 }],
                },
              })}\n`
              : 'src/App.tsx\n';
            error.stderr = '';
            throw error;
          },
        },
      });
      try {
        const timeoutSearch = await timeoutService.search(workspace, 'external', { timeoutMs: 1000 });
        assert.strictEqual(timeoutSearch.truncated, true);
        assert(timeoutSearch.matches.some(match => match.path === 'src/App.tsx'));
      } finally {
        await timeoutService.dispose();
      }

      const originalExecFile = service.execFile.bind(service);
      service.execFile = async (command, args, options) => {
        if (command === service.rgPath && args.includes('--json')) {
          const error = new Error('stdout maxBuffer length exceeded');
          error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          error.stdout = [
            JSON.stringify({
              type: 'match',
              data: {
                path: { text: 'src/App.tsx' },
                line_number: 1,
                lines: { text: 'external change\n' },
                submatches: [{ start: 0, end: 4 }],
              },
            }),
            JSON.stringify({
              type: 'match',
              data: {
                path: { text: 'reference/codex-reference.md' },
                line_number: 1,
                lines: { text: 'codex reference\n' },
                submatches: [{ start: 0, end: 5 }],
              },
            }),
          ].join('\n');
          error.stderr = '';
          throw error;
        }
        return originalExecFile(command, args, options);
      };
      try {
        const cappedSearch = await service.search(workspace, 'external', { limit: 10 });
        assert.strictEqual(cappedSearch.truncated, true);
        assert(cappedSearch.matches.some(match => match.path === 'src/App.tsx'));
        assert(!cappedSearch.matches.some(match => match.path.startsWith('reference/')));
      } finally {
        service.execFile = originalExecFile;
      }
    }

    if (hasCommand('git')) {
      const nonGitBlame = await service.blame(workspace, 'README.md');
      assert.strictEqual(nonGitBlame.isGitRepo, false);
      assert.deepStrictEqual(nonGitBlame.lines, []);

      execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'farming@example.test'], { cwd: workspace });
      execFileSync('git', ['config', 'user.name', 'Farming Test'], { cwd: workspace });
      execFileSync('git', ['add', '.'], { cwd: workspace });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: workspace, stdio: 'ignore' });

      fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'external change\nsecond line\n');
      execFileSync('git', ['add', 'src/App.tsx'], { cwd: workspace });
      execFileSync('git', ['commit', '-m', 'second app line'], {
        cwd: workspace,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Second Author',
          GIT_AUTHOR_EMAIL: 'second@example.test',
        },
      });
      const blame = await service.blame(workspace, 'src/App.tsx');
      assert.strictEqual(blame.isGitRepo, true);
      assert.strictEqual(blame.path, 'src/App.tsx');
      assert.strictEqual(blame.lines.length, 2);
      assert.strictEqual(blame.lines[1].lineNumber, 2);
      assert.strictEqual(blame.lines[1].author, 'Second Author');
      assert.strictEqual(blame.lines[1].summary, 'second app line');
      assert(blame.lines[1].shortCommit);
      const previousLineChanges = await service.lineChanges(workspace, 'src/App.tsx', 2, 'previous');
      assert.strictEqual(previousLineChanges.isGitRepo, true);
      assert.strictEqual(previousLineChanges.available, true);
      assert.strictEqual(previousLineChanges.commit.shortHash, blame.lines[1].shortCommit);
      assert(previousLineChanges.patch.includes('+second line'));
      assert.strictEqual(previousLineChanges.hunk.newStart, 1);
      const unchangedLineChanges = await service.lineChanges(workspace, 'src/App.tsx', 2, 'working');
      assert.strictEqual(unchangedLineChanges.available, false);
      assert.strictEqual(unchangedLineChanges.reason, 'unchanged');

      fs.writeFileSync(path.join(srcDir, 'DeleteMe.ts'), 'remove me\n');
      execFileSync('git', ['add', 'src/DeleteMe.ts'], { cwd: workspace });
      execFileSync('git', ['commit', '-m', 'delete fixture'], { cwd: workspace, stdio: 'ignore' });
      fs.rmSync(path.join(srcDir, 'DeleteMe.ts'));
      const deletedDiff = await service.diff(workspace, 'src/DeleteMe.ts');
      assert.strictEqual(deletedDiff.isGitRepo, true);
      assert.strictEqual(deletedDiff.path, 'src/DeleteMe.ts');
      assert.strictEqual(deletedDiff.originalContent, 'remove me\n');
      assert.strictEqual(deletedDiff.modifiedContent, '');
      assert.strictEqual(deletedDiff.deleted, true);

      fs.writeFileSync(path.join(srcDir, 'RenameMe.ts'), 'rename me\n');
      execFileSync('git', ['add', 'src/RenameMe.ts'], { cwd: workspace });
      execFileSync('git', ['commit', '-m', 'rename fixture'], { cwd: workspace, stdio: 'ignore' });
      execFileSync('git', ['mv', 'src/RenameMe.ts', 'src/Renamed.ts'], { cwd: workspace });

      const originalBlameExecFile = service.execFile;
      service.execFile = async (command, args, options) => {
        if (command === service.gitPath && args.includes('blame')) {
          assert.strictEqual(options.timeout, service.blameTimeoutMs);
          const error = new Error('git blame timed out');
          error.code = 'ETIMEDOUT';
          throw error;
        }
        return originalBlameExecFile(command, args, options);
      };
      try {
        await assertRejectsWithStatus(service.blame(workspace, 'src/App.tsx'), 504);
      } finally {
        service.execFile = originalBlameExecFile;
      }

      if (fs.existsSync(path.join(workspace, 'readme-link.md'))) {
        const symlinkBlame = await service.blame(workspace, 'readme-link.md');
        assert.strictEqual(symlinkBlame.isGitRepo, true);
        assert.strictEqual(symlinkBlame.path, 'readme-link.md');
        assert.strictEqual(symlinkBlame.lines[0].content, '# Farming');

        const symlinkBeforeSave = await service.readFile(workspace, 'readme-link.md');
        await service.writeFile(workspace, 'readme-link.md', '# Farming\nsaved through link\n', {
          baseSha1: symlinkBeforeSave.sha1,
        });
        assert.strictEqual(fs.lstatSync(path.join(workspace, 'readme-link.md')).isSymbolicLink(), true);
        assert.strictEqual(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), '# Farming\nsaved through link\n');

        const symlinkDiff = await service.diff(workspace, 'readme-link.md');
        assert.strictEqual(symlinkDiff.isGitRepo, true);
        assert.strictEqual(symlinkDiff.path, 'readme-link.md');
        assert.strictEqual(symlinkDiff.originalContent, '# Farming\n');
        assert.strictEqual(symlinkDiff.modifiedContent, '# Farming\nsaved through link\n');
      }

      fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'diff target\n');
      fs.writeFileSync(path.join(srcDir, 'Untracked.ts'), 'untracked\n');
      const rootTreeWithGitStatus = await service.listTree(workspace, '');
      const srcEntryWithGitStatus = rootTreeWithGitStatus.items.find(item => item.path === 'src');
      assert(srcEntryWithGitStatus);
      assert.strictEqual(srcEntryWithGitStatus.descendantGitStatus, 'deleted');
      const srcTreeWithGitStatus = await service.listTree(workspace, 'src');
      const appEntryWithGitStatus = srcTreeWithGitStatus.items.find(item => item.path === 'src/App.tsx');
      const untrackedEntryWithGitStatus = srcTreeWithGitStatus.items.find(item => item.path === 'src/Untracked.ts');
      assert(appEntryWithGitStatus);
      assert.strictEqual(appEntryWithGitStatus.gitStatus, 'modified');
      assert.strictEqual(appEntryWithGitStatus.gitStatusLabel, 'M');
      assert(untrackedEntryWithGitStatus);
      assert.strictEqual(untrackedEntryWithGitStatus.gitStatus, 'untracked');
      assert.strictEqual(untrackedEntryWithGitStatus.gitStatusLabel, 'U');
      const appBlameCapability = await service.blameCapability(workspace, 'src/App.tsx');
      assert.strictEqual(appBlameCapability.available, true);
      const untrackedBlameCapability = await service.blameCapability(workspace, 'src/Untracked.ts');
      assert.strictEqual(untrackedBlameCapability.available, false);
      assert.strictEqual(untrackedBlameCapability.reason, 'untracked');
      await assertRejectsWithStatus(service.blame(workspace, 'src/Untracked.ts'), 409);
      const untrackedWorkingLineChanges = await service.lineChanges(workspace, 'src/Untracked.ts', 1, 'working');
      assert.strictEqual(untrackedWorkingLineChanges.available, true);
      assert(untrackedWorkingLineChanges.patch.includes('+untracked'));
      assert.strictEqual(untrackedWorkingLineChanges.hunk.oldStart, 0);
      const untrackedPreviousLineChanges = await service.lineChanges(workspace, 'src/Untracked.ts', 1, 'previous');
      assert.strictEqual(untrackedPreviousLineChanges.available, false);
      assert.strictEqual(untrackedPreviousLineChanges.reason, 'untracked');
      const diff = await service.diff(workspace, 'src/App.tsx');
      assert.strictEqual(diff.isGitRepo, true);
      assert(diff.patch.includes('diff target'));
      assert.strictEqual(diff.originalContent, 'external change\nsecond line\n');
      assert.strictEqual(diff.modifiedContent, 'diff target\n');
      assert.strictEqual(diff.untracked, false);
      const workingLineChanges = await service.lineChanges(workspace, 'src/App.tsx', 1, 'working');
      assert.strictEqual(workingLineChanges.isGitRepo, true);
      assert.strictEqual(workingLineChanges.available, true);
      assert(workingLineChanges.patch.includes('-external change'));
      assert(workingLineChanges.patch.includes('+diff target'));
      assert.strictEqual(workingLineChanges.hunk.newStart, 1);

      const originalDiffExecFile = service.execFile;
      service.execFile = async (command, args, options) => {
        if (command === service.gitPath && args.includes('diff')) {
          assert.strictEqual(options.timeout, service.diffTimeoutMs);
          assert.strictEqual(options.maxBuffer, service.diffMaxBuffer);
          const error = new Error('stdout maxBuffer length exceeded');
          error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          error.stdout = 'partial diff';
          throw error;
        }
        return originalDiffExecFile(command, args, options);
      };
      try {
        const truncatedDiff = await service.diff(workspace);
        assert.strictEqual(truncatedDiff.truncated, true);
        assert.strictEqual(truncatedDiff.patch, 'partial diff');
      } finally {
        service.execFile = originalDiffExecFile;
      }

      const untrackedDiff = await service.diff(workspace, 'src/Untracked.ts');
      assert.strictEqual(untrackedDiff.isGitRepo, true);
      assert.strictEqual(untrackedDiff.originalContent, '');
      assert.strictEqual(untrackedDiff.modifiedContent, 'untracked\n');
      assert.strictEqual(untrackedDiff.untracked, true);
      const changes = await service.changes(workspace);
      const changeByPath = new Map(changes.items.map(item => [item.path, item]));
      assert.strictEqual(changes.truncated, false);
      assert.strictEqual(changeByPath.get('src/App.tsx')?.gitStatus, 'modified');
      assert.strictEqual(changeByPath.get('src/App.tsx')?.gitStatusLabel, 'M');
      assert.strictEqual(changeByPath.get('src/Untracked.ts')?.gitStatus, 'untracked');
      assert.strictEqual(changeByPath.get('src/Untracked.ts')?.gitStatusLabel, 'U');
      assert.strictEqual(changeByPath.get('src/DeleteMe.ts')?.gitStatus, 'deleted');
      assert.strictEqual(changeByPath.get('src/DeleteMe.ts')?.gitStatusLabel, 'D');
      assert.strictEqual(changeByPath.get('src/Renamed.ts')?.gitStatus, 'renamed');
      assert.strictEqual(changeByPath.get('src/Renamed.ts')?.gitStatusLabel, 'R');
      assert.strictEqual(changeByPath.get('src/Renamed.ts')?.previousPath, 'src/RenameMe.ts');
      const renamedDiff = await service.diff(workspace, 'src/Renamed.ts');
      assert.strictEqual(renamedDiff.isGitRepo, true);
      assert.strictEqual(renamedDiff.path, 'src/Renamed.ts');
      assert.strictEqual(renamedDiff.originalContent, 'rename me\n');
      assert.strictEqual(renamedDiff.modifiedContent, 'rename me\n');
      assert.strictEqual(renamedDiff.untracked, false);

      let capturedGitStatusArgs = null;
      const originalExecFile = service.execFile.bind(service);
      service.execFile = async (command, args, options) => {
        if (command === service.gitPath && args.includes('status')) {
          capturedGitStatusArgs = args;
        }
        return originalExecFile(command, args, options);
      };
      try {
        await service.listTree(workspace, '');
      } finally {
        service.execFile = originalExecFile;
      }
      assert(capturedGitStatusArgs.includes('--untracked-files=normal'));
      assert(capturedGitStatusArgs.includes(':(exclude)reference/**'));
      assert(capturedGitStatusArgs.includes(':(exclude)test-results/**'));
      assert(capturedGitStatusArgs.includes(':(exclude)playwright-report/**'));
      assert(capturedGitStatusArgs.includes(':(exclude).tmp/**'));
      assert(capturedGitStatusArgs.includes(':(exclude)dist-release/**'));
    }

    fs.mkdirSync(cacheWorkspace, { recursive: true });
    fs.writeFileSync(path.join(cacheWorkspace, 'cached.txt'), 'cached\n');
    let gitStatusCalls = 0;
    const cachedService = new WorkspaceFileService({
      gitStatusCacheTtlMs: 5000,
      commandRunner: {
        run: async (command, args) => {
          if (command === 'git' && args.includes('status')) {
            gitStatusCalls += 1;
            return { stdout: '?? cached.txt\0', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      },
    });
    try {
      await Promise.all([
        cachedService.listTree(cacheWorkspace, ''),
        cachedService.listTree(cacheWorkspace, ''),
      ]);
      assert.strictEqual(gitStatusCalls, 1);
      await cachedService.listTree(cacheWorkspace, '');
      assert.strictEqual(gitStatusCalls, 1);
      cachedService.invalidateGitStatus(fs.realpathSync(cacheWorkspace));
      await cachedService.listTree(cacheWorkspace, '');
      assert.strictEqual(gitStatusCalls, 2);
    } finally {
      await cachedService.dispose();
    }

    let slowGitStatusCalls = 0;
    const slowStatusService = new WorkspaceFileService({
      gitStatusCacheTtlMs: 5000,
      gitStatusInlineTimeoutMs: 1,
      commandRunner: {
        run: async (command, args) => {
          if (command === 'git' && args.includes('status')) {
            slowGitStatusCalls += 1;
            await new Promise(resolve => setTimeout(resolve, 30));
            return { stdout: '?? cached.txt\0', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      },
    });
    try {
      const pendingTree = await slowStatusService.listTree(cacheWorkspace, '');
      assert.strictEqual(pendingTree.gitStatusPending, true);
      assert.strictEqual(pendingTree.items.find(item => item.path === 'cached.txt')?.gitStatus, undefined);
      await new Promise(resolve => setTimeout(resolve, 60));
      const readyTree = await slowStatusService.listTree(cacheWorkspace, '');
      assert.strictEqual(readyTree.gitStatusPending, false);
      assert.strictEqual(readyTree.items.find(item => item.path === 'cached.txt')?.gitStatus, 'untracked');
      assert.strictEqual(slowGitStatusCalls, 1);
    } finally {
      await slowStatusService.dispose();
    }

    let readFileGitStatusCalls = 0;
    const readFileService = new WorkspaceFileService({
      commandRunner: {
        run: async (command, args) => {
          if (command === 'git' && args.includes('status')) {
            readFileGitStatusCalls += 1;
          }
          return { stdout: '', stderr: '' };
        },
      },
    });
    try {
      const fileWithoutGitStatus = await readFileService.readFile(cacheWorkspace, 'cached.txt');
      assert.strictEqual(fileWithoutGitStatus.content, 'cached\n');
      assert.strictEqual(fileWithoutGitStatus.gitStatus, undefined);
      assert.strictEqual(readFileGitStatusCalls, 0);
    } finally {
      await readFileService.dispose();
    }

    let singleFileGitStatusArgs = null;
    let singleFileLsFilesArgs = null;
    const singleFileCapabilityService = new WorkspaceFileService({
      commandRunner: {
        run: async (command, args) => {
          if (command === 'git' && args.includes('status')) {
            singleFileGitStatusArgs = args;
            return { stdout: '', stderr: '' };
          }
          if (command === 'git' && args.includes('ls-files')) {
            singleFileLsFilesArgs = args;
            return { stdout: '?? cached.txt\0', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      },
    });
    try {
      const capability = await singleFileCapabilityService.blameCapability(cacheWorkspace, 'cached.txt');
      assert.strictEqual(capability.available, true);
      const pathspecIndex = singleFileGitStatusArgs.lastIndexOf('--');
      assert(pathspecIndex >= 0);
      assert.strictEqual(singleFileGitStatusArgs[pathspecIndex + 1], 'cached.txt');
      const lsFilesPathspecIndex = singleFileLsFilesArgs.lastIndexOf('--');
      assert(lsFilesPathspecIndex >= 0);
      assert.strictEqual(singleFileLsFilesArgs[lsFilesPathspecIndex + 1], 'cached.txt');
    } finally {
      await singleFileCapabilityService.dispose();
    }

    const watchEvents = [];
    const unsubscribe = await service.subscribe(workspace, event => watchEvents.push(event));
    await fsp.writeFile(path.join(srcDir, 'Watched.ts'), 'watched\n');
    await fsp.writeFile(path.join(workspace, 'reference', 'IgnoredWatch.ts'), 'ignored\n');
    await waitFor(() => watchEvents.some(event => event.path === 'src/Watched.ts'));
    await unsubscribe();
    assert(watchEvents.some(event => event.path === 'src/Watched.ts'));
    assert(!watchEvents.some(event => event.path === 'reference/IgnoredWatch.ts'));

    console.log('✓ Workspace file service safely reads, writes, searches, diffs, and watches files');
  } finally {
    await service.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
