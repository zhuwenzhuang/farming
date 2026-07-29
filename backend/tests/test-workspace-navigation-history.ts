const assert = require('assert');

const {
  WORKSPACE_NAVIGATION_MAX_ENTRIES,
  emptyWorkspaceNavigationHistory,
  pushWorkspaceNavigationEntry,
  workspaceNavigationAgentEntry,
  workspaceNavigationFileEntry,
  workspaceNavigationShortcutDirection,
} = require('../../src/lib/workspace-navigation-history.ts');

function entryLabels(state) {
  return state.entries.map(entry => (
    entry.kind === 'agent'
      ? `agent:${entry.agentId}`
      : `file:${entry.agentId}:${entry.filePath}:${entry.lineNumber}`
  ));
}

function push(state, entry) {
  return pushWorkspaceNavigationEntry(state, entry);
}

function run() {
  let state = emptyWorkspaceNavigationHistory();
  state = push(state, workspaceNavigationAgentEntry('agent-a', 1));
  state = push(state, workspaceNavigationFileEntry({
    agentId: 'agent-a',
    filePath: 'src/App.tsx',
    lineNumber: 10,
    column: 2,
  }, 2));
  state = push(state, workspaceNavigationAgentEntry('agent-b', 3));
  state = push(state, workspaceNavigationFileEntry({
    agentId: 'agent-b',
    filePath: 'src/server.ts',
    lineNumber: 80,
    column: 1,
  }, 4));

  assert.deepStrictEqual(entryLabels(state), [
    'agent:agent-a',
    'file:agent-a:src/App.tsx:10',
    'agent:agent-b',
    'file:agent-b:src/server.ts:80',
  ]);
  assert.strictEqual(state.index, 3, 'mixed agent/file navigation should append entries');

  state = { ...state, index: 1 };
  state = push(state, workspaceNavigationAgentEntry('agent-c', 5));
  assert.deepStrictEqual(entryLabels(state), [
    'agent:agent-a',
    'file:agent-a:src/App.tsx:10',
    'agent:agent-c',
  ], 'new navigation from the middle should discard forward history');
  assert.strictEqual(state.index, 2);

  state = push(state, workspaceNavigationAgentEntry('agent-c', 6));
  assert.deepStrictEqual(entryLabels(state), [
    'agent:agent-a',
    'file:agent-a:src/App.tsx:10',
    'agent:agent-c',
  ], 're-entering the same agent should replace instead of duplicating');

  state = push(state, workspaceNavigationFileEntry({
    agentId: 'agent-c',
    filePath: 'src/feature.ts',
    lineNumber: 100,
    column: 1,
  }, 7));
  state = push(state, workspaceNavigationFileEntry({
    agentId: 'agent-c',
    filePath: 'src/feature.ts',
    lineNumber: 108,
    column: 5,
    reason: 'cursor',
  }, 8));
  assert.deepStrictEqual(entryLabels(state).slice(-1), [
    'file:agent-c:src/feature.ts:108',
  ], 'nearby cursor movement in the same file should replace the current file entry');

  state = push(state, workspaceNavigationFileEntry({
    agentId: 'agent-c',
    filePath: 'src/feature.ts',
    lineNumber: 175,
    column: 1,
    reason: 'cursor',
  }, 10_000));
  assert.deepStrictEqual(entryLabels(state).slice(-2), [
    'file:agent-c:src/feature.ts:108',
    'file:agent-c:src/feature.ts:175',
  ], 'far settled cursor movement should become a useful return point');

  state = push(state, workspaceNavigationFileEntry({
    agentId: 'agent-c',
    filePath: 'src/feature.ts',
    view: 'diff',
    lineNumber: 175,
    column: 1,
  }, 10_100));
  assert.deepStrictEqual(entryLabels(state).slice(-2), [
    'file:agent-c:src/feature.ts:175',
    'file:agent-c:src/feature.ts:175',
  ], 'editor and diff views should be distinct navigation locations');
  assert.strictEqual(state.entries.at(-1).view, 'diff');

  let capped = emptyWorkspaceNavigationHistory();
  for (let index = 0; index < WORKSPACE_NAVIGATION_MAX_ENTRIES + 7; index += 1) {
    capped = push(capped, workspaceNavigationAgentEntry(`agent-${index}`, index));
  }
  assert.strictEqual(capped.entries.length, WORKSPACE_NAVIGATION_MAX_ENTRIES, 'history should cap retained entries');
  assert.strictEqual(capped.index, WORKSPACE_NAVIGATION_MAX_ENTRIES - 1, 'index should track the newest retained entry');
  assert.strictEqual(capped.entries[0].agentId, 'agent-7', 'oldest entries should be recycled first');

  assert.strictEqual(workspaceNavigationShortcutDirection({
    key: '-',
    code: 'Minus',
    metaKey: false,
    altKey: false,
    ctrlKey: true,
    shiftKey: false,
  }, 'MacIntel'), -1, 'Ctrl+Minus should go back');
  assert.strictEqual(workspaceNavigationShortcutDirection({
    key: '_',
    code: 'Minus',
    metaKey: false,
    altKey: false,
    ctrlKey: true,
    shiftKey: true,
  }, 'MacIntel'), 1, 'Ctrl+Shift+Minus should go forward');
  assert.strictEqual(workspaceNavigationShortcutDirection({
    key: '-',
    code: 'Minus',
    metaKey: false,
    altKey: false,
    ctrlKey: true,
    shiftKey: false,
  }, 'Linux x86_64'), -1, 'shortcut should not vary by platform');
  assert.strictEqual(workspaceNavigationShortcutDirection({
    key: '-',
    code: 'Minus',
    metaKey: false,
    altKey: true,
    ctrlKey: true,
    shiftKey: false,
  }, 'Linux x86_64'), null, 'Ctrl+Alt+Minus should not be stolen from terminal/editor conventions');
  assert.strictEqual(workspaceNavigationShortcutDirection({
    key: 'ArrowLeft',
    code: 'ArrowLeft',
    metaKey: true,
    altKey: true,
    ctrlKey: false,
    shiftKey: true,
  }, 'MacIntel'), null, 'old browser-level arrow variants should be ignored');

  console.log('✓ Workspace navigation history handles mixed agent/file stacks, cursor dedupe, pruning, and shortcuts');
}

run();
