const assert = require('assert');
const {
  findOpenWorkspaceFile,
  isSameOpenWorkspaceFile,
  isSameOrDescendantPath,
  movedWorkspacePath,
  normalizeTerminalPathText,
  refreshOpenWorkspaceFileFromRead,
  relativePathInsideWorkspace,
  replaceOpenWorkspaceFile,
  terminalTargetFilePath,
  workspaceFileCacheKey,
  workspaceHomeRoot,
} = require('../../src/components/code/workspace-file-view.ts');

function workspaceFile(path, content = 'old', sha1 = 'old-sha') {
  return {
    path,
    name: path.split('/').pop() || path,
    content,
    size: content.length,
    mtimeMs: 1,
    sha1,
    binary: false,
  };
}

function openFile(agentId, path, overrides = {}) {
  const file = workspaceFile(path, 'old', 'old-sha');
  return {
    agentId,
    file,
    draft: file.content,
    dirty: false,
    externalChanged: false,
    saving: false,
    error: null,
    ...overrides,
  };
}

function run() {
  assert.strictEqual(workspaceFileCacheKey('agent-1', 'src/App.tsx'), 'agent-1:src/App.tsx');
  assert.strictEqual(normalizeTerminalPathText(' src\\App.tsx '), 'src/App.tsx');
  assert.strictEqual(workspaceHomeRoot('/Users/alice/git/farming'), '/Users/alice');

  assert.strictEqual(relativePathInsideWorkspace('/repo/project/src/App.tsx', '/repo/project'), 'src/App.tsx');
  assert.strictEqual(relativePathInsideWorkspace('/repo/project', '/repo/project/'), '');
  assert.strictEqual(relativePathInsideWorkspace('/repo/other/App.tsx', '/repo/project'), null);

  assert.strictEqual(terminalTargetFilePath('./src/App.tsx', '/repo/project'), 'src/App.tsx');
  assert.strictEqual(terminalTargetFilePath('src/App.tsx', '/repo/project'), 'src/App.tsx');
  assert.strictEqual(terminalTargetFilePath('../secret', '/repo/project'), null);
  assert.strictEqual(terminalTargetFilePath('/repo/project/src/App.tsx', '/repo/project'), 'src/App.tsx');
  assert.strictEqual(terminalTargetFilePath('/repo/other/App.tsx', '/repo/project'), null);
  assert.strictEqual(
    terminalTargetFilePath('~/git/farming/src/App.tsx', '/Users/alice/git/farming'),
    'src/App.tsx'
  );

  const one = openFile('agent-1', 'src/App.tsx');
  const two = openFile('agent-2', 'src/App.tsx');
  assert.strictEqual(isSameOpenWorkspaceFile(one, 'agent-1', 'src/App.tsx'), true);
  assert.strictEqual(isSameOpenWorkspaceFile(one, 'agent-2', 'src/App.tsx'), false);
  assert.strictEqual(findOpenWorkspaceFile([one, two], 'agent-2', 'src/App.tsx'), two);
  assert.strictEqual(findOpenWorkspaceFile([one], 'agent-1', 'missing.ts'), null);

  const replacement = openFile('agent-1', 'src/App.tsx', { draft: 'new' });
  assert.deepStrictEqual(replaceOpenWorkspaceFile([one, two], replacement), [replacement, two]);
  const appended = openFile('agent-1', 'src/Other.tsx');
  assert.deepStrictEqual(replaceOpenWorkspaceFile([one], appended), [one, appended]);

  const cleanRefresh = refreshOpenWorkspaceFileFromRead(one, workspaceFile('src/App.tsx', 'server', 'server-sha'));
  assert.strictEqual(cleanRefresh.draft, 'server');
  assert.strictEqual(cleanRefresh.dirty, false);
  assert.strictEqual(cleanRefresh.externalChanged, false);

  const dirty = openFile('agent-1', 'src/App.tsx', {
    draft: 'local edit',
    dirty: true,
    file: workspaceFile('src/App.tsx', 'old', 'old-sha'),
  });
  const dirtyRefresh = refreshOpenWorkspaceFileFromRead(dirty, workspaceFile('src/App.tsx', 'server', 'server-sha'));
  assert.strictEqual(dirtyRefresh.draft, 'local edit');
  assert.strictEqual(dirtyRefresh.dirty, true);
  assert.strictEqual(dirtyRefresh.externalChanged, true);

  const cleanAfterEqualRead = refreshOpenWorkspaceFileFromRead(dirty, workspaceFile('src/App.tsx', 'local edit', 'new-sha'));
  assert.strictEqual(cleanAfterEqualRead.dirty, false);
  assert.strictEqual(cleanAfterEqualRead.externalChanged, false);

  assert.strictEqual(movedWorkspacePath('src/App.tsx', { sourcePath: 'src', targetPath: 'app' }), 'app/App.tsx');
  assert.strictEqual(movedWorkspacePath('src', { sourcePath: 'src', targetPath: 'app' }), 'app');
  assert.strictEqual(movedWorkspacePath('scripts/build.js', { sourcePath: 'src', targetPath: 'app' }), null);
  assert.strictEqual(isSameOrDescendantPath('src/App.tsx', 'src'), true);
  assert.strictEqual(isSameOrDescendantPath('src-old/App.tsx', 'src'), false);

  console.log('test-code-workspace-file-view passed');
}

run();
