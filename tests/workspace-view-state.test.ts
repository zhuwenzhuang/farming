import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCodeWorkspaceViewState } from '../src/components/code/workspace-view-state'

test('normalizes the complete stable workspace view state', () => {
  const state = normalizeCodeWorkspaceViewState({
    activeView: 'plugins',
    collapsedComputerAgentIds: ['agent-a', 'agent-a', 'agent-b'],
    collapsedProjectIds: ['project-a', 'project-a', '', 'project-b'],
    openFiles: [
      {
        workspace: '/repo',
        filePath: 'src/a.ts',
        view: 'diff',
        lineNumber: 9,
        column: 3,
        sourceAgentId: 'agent-a',
        transient: false,
      },
      { workspace: '/repo', filePath: 'src/a.ts' },
      { workspace: '/repo', filePath: 'src/b.ts' },
    ],
    pinnedCollapsed: true,
    projectListScrollTop: 123.6,
    sidebarCollapsed: false,
    sidebarWidth: 9999,
    usageCollapsed: false,
    pluginsNavigationState: {
      activeTab: 'extensions',
      activeExtensionHomeKey: 'home',
      activeExtensionKind: 'skill',
      extensionQuery: 'browser',
      selectedExtension: { homeKey: 'home', id: 'browser', sourceFile: 'SKILL.md' },
      scrollTop: 88.4,
    },
    projectFiles: {
      'project-a': {
        agentsCollapsed: true,
        agentVisibleLimit: 12.2,
        changesCollapsed: false,
        filesCollapsed: false,
        gitHistoryCollapsed: false,
        gitHistoryScope: 'all',
        gitHistorySelectedCommitId: 'abcdef',
        gitHistorySelectedParent: '123456',
        gitHistoryVisibleLimit: 120,
        openChangeDirectoryIds: ['tracked:src', 'tracked:src'],
        openEditorsCollapsed: false,
        openDirectoryPaths: ['src', 'src', 'src/components'],
        sessionVisibleLimit: 25,
        untrackedChangesCollapsed: false,
      },
    },
    updatedAt: Date.now(),
  })

  assert.deepEqual(state.collapsedProjectIds, ['project-a', 'project-b'])
  assert.deepEqual(state.collapsedComputerAgentIds, ['agent-a', 'agent-b'])
  assert.deepEqual(state.openFiles, [
    {
      workspace: '/repo',
      filePath: 'src/a.ts',
      view: 'diff',
      lineNumber: 9,
      column: 3,
      endLineNumber: undefined,
      endColumn: undefined,
      sourceAgentId: 'agent-a',
      transient: false,
    },
    {
      workspace: '/repo',
      filePath: 'src/b.ts',
      view: 'editor',
      lineNumber: undefined,
      column: undefined,
      endLineNumber: undefined,
      endColumn: undefined,
      sourceAgentId: undefined,
      transient: undefined,
    },
  ])
  assert.equal(state.projectListScrollTop, 124)
  assert.equal(state.sidebarWidth, 840)
  assert.deepEqual(state.pluginsNavigationState, {
    activeTab: 'extensions',
    activeExtensionHomeKey: 'home',
    activeExtensionKind: 'skill',
    extensionQuery: 'browser',
    selectedExtension: { homeKey: 'home', id: 'browser', sourceFile: 'SKILL.md' },
    scrollTop: 88,
  })
  assert.deepEqual(state.projectFiles?.['project-a'], {
    agentsCollapsed: true,
    agentVisibleLimit: 12,
    changesCollapsed: false,
    filesCollapsed: false,
    gitHistoryCollapsed: false,
    gitHistoryScope: 'all',
    gitHistorySelectedCommitId: 'abcdef',
    gitHistorySelectedParent: '123456',
    gitHistoryVisibleLimit: 120,
    openChangeDirectoryIds: ['tracked:src'],
    openEditorsCollapsed: false,
    openDirectoryPaths: ['src', 'src/components'],
    sessionVisibleLimit: 25,
    untrackedChangesCollapsed: false,
  })
})

test('drops expired workspace view state', () => {
  const state = normalizeCodeWorkspaceViewState({
    activeView: 'history',
    collapsedProjectIds: ['project-a'],
    updatedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
  })

  assert.deepEqual(state, {})
})

test('rejects invalid nested view state without rejecting valid siblings', () => {
  const state = normalizeCodeWorkspaceViewState({
    activeView: 'projects',
    pinnedCollapsed: 'yes',
    pluginsNavigationState: {
      activeTab: 'unknown',
      activeExtensionHomeKey: 7,
      activeExtensionKind: null,
      extensionQuery: 42,
      selectedExtension: { homeKey: 'home', id: '', sourceFile: 'SKILL.md' },
      scrollTop: -5,
    },
    projectFiles: {
      project: {
        agentsCollapsed: 'no',
        agentVisibleLimit: Number.NaN,
        filesCollapsed: true,
        openDirectoryPaths: [null, ' src '],
      },
    },
    updatedAt: Date.now(),
  })

  assert.equal(state.activeView, 'projects')
  assert.equal(state.pinnedCollapsed, undefined)
  assert.deepEqual(state.pluginsNavigationState, {
    activeTab: 'farming',
    activeExtensionHomeKey: '',
    activeExtensionKind: '',
    extensionQuery: '',
    selectedExtension: null,
    scrollTop: 0,
  })
  assert.deepEqual(state.projectFiles?.project.openDirectoryPaths, ['src'])
  assert.equal(state.projectFiles?.project.filesCollapsed, true)
  assert.equal(state.projectFiles?.project.agentVisibleLimit, undefined)
})
