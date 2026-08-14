const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

const {
  normalizeCodeWorkspaceViewState,
} = importTsModule('src/components/code/workspace-view-state.ts');

function run() {
  const normalized = normalizeCodeWorkspaceViewState({
    activeTerminalId: 'agent-2',
    openTerminalIds: ['agent-1', 'agent-2', 'agent-1'],
    activeView: 'projects',
    surface: {
      kind: 'file',
      workspace: '/repo',
      filePath: 'docs/design.md',
      view: 'diff',
      lineNumber: 12.4,
      column: 3,
    },
    projectFiles: {
      '/repo': {
        filesCollapsed: false,
        openDirectoryPaths: ['src', 'src/components', 'src'],
      },
    },
    updatedAt: Date.now(),
  });

  assert.deepStrictEqual(normalized.openTerminalIds, ['agent-1', 'agent-2']);
  assert.deepStrictEqual(normalized.surface, {
    kind: 'file',
    workspace: '/repo',
    filePath: 'docs/design.md',
    view: 'diff',
    lineNumber: 12,
    column: 3,
    endLineNumber: undefined,
    endColumn: undefined,
    sourceAgentId: undefined,
  });
  assert.deepStrictEqual(normalized.projectFiles['/repo'], {
    agentsCollapsed: undefined,
    agentVisibleLimit: undefined,
    changesCollapsed: undefined,
    filesCollapsed: false,
    gitHistoryCollapsed: undefined,
    gitHistoryScope: undefined,
    gitHistorySelectedCommitId: undefined,
    gitHistorySelectedParent: undefined,
    gitHistoryVisibleLimit: undefined,
    openChangeDirectoryIds: undefined,
    openEditorsCollapsed: undefined,
    openDirectoryPaths: ['src', 'src/components'],
    sessionVisibleLimit: undefined,
    untrackedChangesCollapsed: undefined,
  });

  assert.strictEqual(normalizeCodeWorkspaceViewState({
    surface: { kind: 'file', workspace: '/repo', filePath: '' },
  }).surface, undefined);
  assert.strictEqual(normalizeCodeWorkspaceViewState({
    updatedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
    surface: { kind: 'agent', agentId: 'stale' },
  }).surface, undefined);
  assert.strictEqual(normalizeCodeWorkspaceViewState({
    activeView: 'plugins',
  }).activeView, 'plugins');

  console.log('test-code-workspace-view-state passed');
}

run();
