const assert = require('assert');
const {
  applyWorkspaceFileMovesToOpenFile,
  applyWorkspaceFileMovesToOpenFileCache,
  applyWorkspaceFileMovesToOpenFiles,
  isSameOrDescendantPath,
  movedWorkspacePath,
  movedWorkspacePathByAnyMove,
  removeWorkspaceFileDeletionsFromOpenFileCache,
  removeWorkspaceFileDeletionsFromOpenFiles,
  workspaceFileDeleteFocusPath,
  workspaceFileDeleteRefreshDirectories,
  workspaceFileDeletionMatchesOpenFile,
  workspaceFileMoveFocusPath,
  workspaceFileMoveRefreshDirectories,
} = require('../../src/lib/workspace-file-operations.ts');

function workspaceFile(path) {
  return {
    path,
    name: path.split('/').pop() || path,
    content: '',
    size: 0,
    mtimeMs: 1,
    sha1: 'sha',
    binary: false,
  };
}

function openFile(agentId, path, overrides = {}) {
  return {
    agentId,
    file: workspaceFile(path),
    draft: '',
    dirty: false,
    externalChanged: false,
    saving: false,
    error: null,
    ...overrides,
  };
}

function run() {
  const move = {
    sourcePath: 'src',
    targetPath: 'app',
    sourceDirectory: '',
    targetDirectory: '',
  };
  const nestedMove = {
    sourcePath: 'app/components',
    targetPath: 'ui/components',
    sourceDirectory: 'app',
    targetDirectory: 'ui',
  };

  assert.strictEqual(movedWorkspacePath('src/App.tsx', move), 'app/App.tsx');
  assert.strictEqual(movedWorkspacePath('src', move), 'app');
  assert.strictEqual(movedWorkspacePath('src-old/App.tsx', move), null);
  assert.strictEqual(movedWorkspacePathByAnyMove('app/components/Button.tsx', [move, nestedMove]), 'ui/components/Button.tsx');
  assert.deepStrictEqual(workspaceFileMoveRefreshDirectories(nestedMove), ['app', 'ui']);
  assert.strictEqual(workspaceFileMoveFocusPath(nestedMove), 'ui/components');

  const current = openFile('agent-1', 'src/App.tsx', {
    externalChanged: true,
    error: 'stale',
  });
  const moved = applyWorkspaceFileMovesToOpenFile(current, 'agent-1', [move]);
  assert.strictEqual(moved.file.path, 'app/App.tsx');
  assert.strictEqual(moved.externalChanged, false);
  assert.strictEqual(moved.error, null);
  assert.strictEqual(applyWorkspaceFileMovesToOpenFile(current, 'agent-2', [move]), current);

  const files = [
    current,
    openFile('agent-1', 'scripts/build.js'),
    openFile('agent-2', 'src/App.tsx'),
  ];
  const movedFiles = applyWorkspaceFileMovesToOpenFiles(files, 'agent-1', [move]);
  assert.deepStrictEqual(movedFiles.map(file => `${file.agentId}:${file.file.path}`), [
    'agent-1:app/App.tsx',
    'agent-1:scripts/build.js',
    'agent-2:src/App.tsx',
  ]);

  const movedCache = applyWorkspaceFileMovesToOpenFileCache(files, 'agent-1', [move]);
  assert.strictEqual(movedCache.has('app/App.tsx'), true);
  assert.strictEqual(movedCache.has('src/App.tsx'), true);

  const deletion = {
    path: 'src',
    parentDirectory: '',
    type: 'directory',
  };
  assert.strictEqual(isSameOrDescendantPath('src/App.tsx', 'src'), true);
  assert.strictEqual(isSameOrDescendantPath('src-old/App.tsx', 'src'), false);
  assert.deepStrictEqual(workspaceFileDeleteRefreshDirectories(deletion), ['']);
  assert.strictEqual(workspaceFileDeleteFocusPath(deletion), null);
  assert.strictEqual(workspaceFileDeletionMatchesOpenFile(current, 'agent-1', [deletion]), true);
  assert.strictEqual(workspaceFileDeletionMatchesOpenFile(openFile('agent-2', 'src/App.tsx'), 'agent-1', [deletion]), false);

  const remainingFiles = removeWorkspaceFileDeletionsFromOpenFiles(files, 'agent-1', [deletion]);
  assert.deepStrictEqual(remainingFiles.map(file => `${file.agentId}:${file.file.path}`), [
    'agent-1:scripts/build.js',
    'agent-2:src/App.tsx',
  ]);
  const remainingCache = removeWorkspaceFileDeletionsFromOpenFileCache(files, 'agent-1', [deletion]);
  assert.deepStrictEqual(Array.from(remainingCache.keys()).sort(), [
    'scripts/build.js',
    'src/App.tsx',
  ]);

  console.log('test-workspace-file-operations passed');
}

run();
