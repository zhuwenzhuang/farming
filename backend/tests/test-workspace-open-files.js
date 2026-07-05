const assert = require('assert');
const {
  closeWorkspaceOpenFiles,
  createWorkspaceOpenFile,
  deleteWorkspaceOpenFiles,
  findOpenWorkspaceFile,
  isSameOpenWorkspaceFile,
  moveWorkspaceOpenFiles,
  openWorkspaceFileFromRead,
  refreshOpenWorkspaceFileFromRead,
  replaceOpenWorkspaceFile,
  selectWorkspaceOpenFile,
  updateWorkspaceOpenFile,
  updateWorkspaceOpenFileDraft,
  workspaceFileCursorForTarget,
} = require('../../src/lib/workspace-open-files.ts');
const { workspaceFileCacheKey } = require('../../src/lib/workspace-working-copy.ts');

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

function state(overrides = {}) {
  return {
    activeFile: null,
    files: [],
    closedFileCache: new Map(),
    ...overrides,
  };
}

function keys(map) {
  return Array.from(map.keys()).sort();
}

function run() {
  const one = openFile('agent-1', 'src/App.tsx');
  const two = openFile('agent-2', 'src/App.tsx');

  assert.strictEqual(isSameOpenWorkspaceFile(one, 'agent-1', 'src/App.tsx'), true);
  assert.strictEqual(isSameOpenWorkspaceFile(one, 'agent-2', 'src/App.tsx'), false);
  assert.strictEqual(findOpenWorkspaceFile([one, two], 'agent-2', 'src/App.tsx'), two);
  assert.strictEqual(findOpenWorkspaceFile([one], 'agent-1', 'missing.ts'), null);
  assert.deepStrictEqual(replaceOpenWorkspaceFile([one], two), [one, two]);
  assert.deepStrictEqual(replaceOpenWorkspaceFile([one, two], { ...one, draft: 'new' }), [{ ...one, draft: 'new' }, two]);

  const sharedOne = openFile('agent-1', 'src/App.tsx', { workspaceRoot: '/repo' });
  const sharedTwo = openFile('agent-2', 'src/App.tsx', { workspaceRoot: '/repo' });
  const otherWorkspace = openFile('agent-2', 'src/App.tsx', { workspaceRoot: '/other' });
  assert.strictEqual(isSameOpenWorkspaceFile(sharedOne, 'agent-2', 'src/App.tsx', '/repo'), true);
  assert.strictEqual(isSameOpenWorkspaceFile(sharedOne, 'agent-2', 'src/App.tsx', '/other'), false);
  assert.strictEqual(findOpenWorkspaceFile([sharedOne], 'agent-2', 'src/App.tsx', '/repo'), sharedOne);
  assert.deepStrictEqual(replaceOpenWorkspaceFile([sharedOne], sharedTwo), [sharedTwo]);
  assert.deepStrictEqual(replaceOpenWorkspaceFile([sharedOne], otherWorkspace), [sharedOne, otherWorkspace]);
  assert.strictEqual(findOpenWorkspaceFile([one], 'agent-1', 'src/App.tsx', '/repo'), one);
  assert.deepStrictEqual(replaceOpenWorkspaceFile([one], { ...one, workspaceRoot: '/repo', draft: 'rooted' }), [{ ...one, workspaceRoot: '/repo', draft: 'rooted' }]);

  assert.deepStrictEqual(workspaceFileCursorForTarget({ lineNumber: 3, column: 2, endColumn: 5 }, 8), {
    lineNumber: 3,
    column: 2,
    endColumn: 5,
    requestId: 8,
  });
  assert.strictEqual(workspaceFileCursorForTarget(undefined, 8), undefined);

  const created = createWorkspaceOpenFile('agent-1', workspaceFile('src/New.tsx', 'new'), { lineNumber: 1, requestId: 10 });
  assert.strictEqual(created.agentId, 'agent-1');
  assert.strictEqual(created.draft, 'new');
  assert.strictEqual(created.cursor.requestId, 10);

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

  const opened = openWorkspaceFileFromRead(state(), 'agent-1', workspaceFile('src/App.tsx', 'server', 'server-sha'));
  assert.strictEqual(opened.activeFile.file.path, 'src/App.tsx');
  assert.strictEqual(opened.activeFile.draft, 'server');
  assert.strictEqual(opened.files.length, 1);

  const deduped = openWorkspaceFileFromRead(openWorkspaceFileFromRead(state(), 'agent-1', workspaceFile('src/App.tsx', 'one', 'sha-1'), {
    workspaceRoot: '/repo',
    sourceAgentId: 'agent-1',
  }), 'agent-2', workspaceFile('src/App.tsx', 'two', 'sha-2'), {
    workspaceRoot: '/repo',
    sourceAgentId: 'agent-2',
  });
  assert.strictEqual(deduped.files.length, 1);
  assert.strictEqual(deduped.activeFile.agentId, 'agent-2');
  assert.strictEqual(deduped.activeFile.sourceAgentId, 'agent-2');
  assert.strictEqual(deduped.activeFile.workspaceRoot, '/repo');
  assert.strictEqual(deduped.activeFile.draft, 'two');

  const separateWorkspaces = openWorkspaceFileFromRead(deduped, 'agent-3', workspaceFile('src/App.tsx', 'three', 'sha-3'), {
    workspaceRoot: '/other',
  });
  assert.strictEqual(separateWorkspaces.files.length, 2);

  const firstTransient = openWorkspaceFileFromRead(state(), 'agent-1', workspaceFile('src/One.tsx', 'one'), {
    workspaceRoot: '/repo',
    transient: true,
  });
  assert.strictEqual(firstTransient.activeFile.transient, true);
  const secondTransient = openWorkspaceFileFromRead(firstTransient, 'agent-1', workspaceFile('src/Two.tsx', 'two'), {
    workspaceRoot: '/repo',
    transient: true,
  });
  assert.deepStrictEqual(secondTransient.files.map(file => file.file.path), ['src/Two.tsx']);
  const pinnedTransient = updateWorkspaceOpenFileDraft(secondTransient.activeFile, 'changed');
  assert.strictEqual(pinnedTransient.transient, false);

  const cachedDirty = openFile('agent-1', 'src/Dirty.tsx', {
    draft: 'local edit',
    dirty: true,
    saving: true,
  });
  const restored = openWorkspaceFileFromRead(state({
    closedFileCache: new Map([[workspaceFileCacheKey('agent-1', 'src/Dirty.tsx'), cachedDirty]]),
  }), 'agent-1', workspaceFile('src/Dirty.tsx', 'server', 'server-sha'));
  assert.strictEqual(restored.activeFile.draft, 'local edit');
  assert.strictEqual(restored.activeFile.saving, false);
  assert.strictEqual(restored.activeFile.externalChanged, true);
  assert.deepStrictEqual(keys(restored.closedFileCache), [workspaceFileCacheKey('agent-1', 'src/Dirty.tsx')]);

  const cachedClean = openFile('agent-1', 'src/Clean.tsx');
  const openedClean = openWorkspaceFileFromRead(state({
    closedFileCache: new Map([[workspaceFileCacheKey('agent-1', 'src/Clean.tsx'), cachedClean]]),
  }), 'agent-1', workspaceFile('src/Clean.tsx', 'old', 'old-sha'));
  assert.deepStrictEqual(keys(openedClean.closedFileCache), []);

  const selected = selectWorkspaceOpenFile(opened, 'agent-1', 'src/App.tsx', { lineNumber: 4, requestId: 9 });
  assert.strictEqual(selected.activeFile.cursor.lineNumber, 4);
  assert.strictEqual(selectWorkspaceOpenFile(opened, 'agent-1', 'missing.ts'), null);

  const first = openFile('agent-1', 'src/First.tsx');
  const second = openFile('agent-1', 'src/Second.tsx', { dirty: true, saving: true, draft: 'changed' });
  const third = openFile('agent-1', 'src/Third.tsx');
  const closed = closeWorkspaceOpenFiles(state({
    activeFile: second,
    files: [first, second, third],
  }), [{ agentId: 'agent-1', filePath: 'src/Second.tsx' }]);
  assert.strictEqual(closed.activeFile, first);
  assert.strictEqual(closed.activeFileClosed, true);
  assert.deepStrictEqual(closed.files, [first, third]);
  assert.strictEqual(closed.closedFileCache.get(workspaceFileCacheKey('agent-1', 'src/Second.tsx')).saving, false);

  const closeClean = closeWorkspaceOpenFiles(state({
    activeFile: third,
    files: [third],
    closedFileCache: new Map([[workspaceFileCacheKey('agent-1', 'src/Third.tsx'), third]]),
  }), [{ agentId: 'agent-1', filePath: 'src/Third.tsx' }]);
  assert.strictEqual(closeClean.activeFile, null);
  assert.deepStrictEqual(keys(closeClean.closedFileCache), []);

  const updatedClean = updateWorkspaceOpenFile(state({
    activeFile: cachedDirty,
    files: [cachedDirty],
    closedFileCache: new Map([[workspaceFileCacheKey('agent-1', 'src/Dirty.tsx'), cachedDirty]]),
  }), { ...cachedDirty, dirty: false, saving: false, draft: cachedDirty.file.content });
  assert.deepStrictEqual(keys(updatedClean.closedFileCache), []);

  const drafted = updateWorkspaceOpenFileDraft(openFile('agent-1', 'src/App.tsx', { error: 'old error' }), 'new draft');
  assert.strictEqual(drafted.dirty, true);
  assert.strictEqual(drafted.error, null);

  const moved = moveWorkspaceOpenFiles(state({
    activeFile: openFile('agent-1', 'src/App.tsx', { externalChanged: true, error: 'stale' }),
    files: [openFile('agent-1', 'src/App.tsx'), openFile('agent-2', 'src/App.tsx')],
    closedFileCache: new Map([[workspaceFileCacheKey('agent-1', 'src/Closed.tsx'), openFile('agent-1', 'src/Closed.tsx')]]),
  }), 'agent-1', [{ sourcePath: 'src', targetPath: 'app', sourceDirectory: '', targetDirectory: '' }]);
  assert.strictEqual(moved.activeFile.file.path, 'app/App.tsx');
  assert.strictEqual(moved.activeFile.externalChanged, false);
  assert.strictEqual(moved.files[0].file.path, 'app/App.tsx');
  assert.strictEqual(moved.files[1].file.path, 'src/App.tsx');
  assert.deepStrictEqual(keys(moved.closedFileCache), [workspaceFileCacheKey('agent-1', 'app/Closed.tsx')]);

  const deleted = deleteWorkspaceOpenFiles(state({
    activeFile: openFile('agent-1', 'src/App.tsx'),
    files: [openFile('agent-1', 'src/App.tsx'), openFile('agent-1', 'scripts/build.js'), openFile('agent-2', 'src/App.tsx')],
    closedFileCache: new Map([[workspaceFileCacheKey('agent-1', 'src/Closed.tsx'), openFile('agent-1', 'src/Closed.tsx')]]),
  }), 'agent-1', [{ path: 'src', parentDirectory: '', type: 'directory' }]);
  assert.strictEqual(deleted.activeFile.file.path, 'scripts/build.js');
  assert.strictEqual(deleted.activeFileDeleted, true);
  assert.deepStrictEqual(deleted.files.map(file => `${file.agentId}:${file.file.path}`), [
    'agent-1:scripts/build.js',
    'agent-2:src/App.tsx',
  ]);
  assert.deepStrictEqual(keys(deleted.closedFileCache), []);

  console.log('test-workspace-open-files passed');
}

run();
