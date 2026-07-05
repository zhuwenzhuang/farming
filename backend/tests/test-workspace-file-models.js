const assert = require('assert');
const {
  hasCleanWorkspaceWorkingCopy,
  isWorkspaceWorkingCopyClean,
  shouldPromptBeforeClosingWorkspaceWorkingCopy,
  shouldShowWorkspaceWorkingCopyOverwriteAction,
  shouldShowWorkspaceWorkingCopyReloadAction,
  shouldShowWorkspaceWorkingCopySaveAction,
  workspaceFileCacheKey,
  workspaceWorkingCopyChangeIndicator,
  workspaceWorkingCopyKey,
  workspaceWorkingCopyState,
  workspaceWorkingCopyTabClass,
} = require('../../src/lib/workspace-working-copy.ts');
const {
  ancestorDirectories,
  buildWorkspaceFileTreeNodes,
  countVisibleWorkspaceTreeRows,
  filePathDepth,
  findVisibleWorkspaceTreePath,
  findWorkspaceFileTreeNode,
  isDescendantPath,
  parentDirectory,
  visibleWorkspaceDirectoryPathsForTarget,
} = require('../../src/lib/workspace-file-tree.ts');
const {
  hasWorkspaceFileTreeDescendant,
  visibleWorkspaceFileTreeGitStatus,
  workspaceFileTreeDescendantGitStatusClassName,
  workspaceFileTreeDepthStyle,
  workspaceFileTreeRowViewState,
  workspaceFileTreeStatusTitle,
} = require('../../src/lib/workspace-file-tree-row.ts');
const {
  firstVisibleWorkspaceFilePath,
  isWorkspaceStickyContextVisible,
  openEditorsRevealScrollDelta,
  shouldCancelPendingWorkspaceFileTreeFocus,
  shouldCloseWorkspaceFileTreeDirectory,
  shouldFocusWorkspaceFileTree,
  shouldSelectWorkspaceFileSearchText,
  shouldSkipWorkspaceFileSearchFocus,
  workspaceFileTreeFocusTargetPath,
  workspaceFileTreeKeyboardTargetPath,
  workspaceFileRevealScrollDelta,
  workspaceFileTreeActivationIntent,
  workspaceFileTreeRowClickIntent,
  workspaceStickyContentTop,
  workspaceStickyContextItems,
  workspaceStickyDirectoryPaths,
  WORKSPACE_FILE_SEARCH_FOCUS_RETRY_DELAYS,
  WORKSPACE_FILE_TREE_FOCUS_RETRY_DELAYS,
} = require('../../src/lib/workspace-file-view-model.ts');
const {
  estimateWorkspaceBlameLabelWidth,
  formatWorkspaceBlameTime,
  isWorkspaceMarkdownFile,
  isWorkspaceEditorModelUri,
  isPermanentWorkspaceBlameFailureStatus,
  languageForWorkspaceFile,
  safeWorkspaceEditorDomIdPart,
  shouldDisposeWorkspaceEditorModelUri,
  shouldKeepWorkspaceEditorViewState,
  workspaceBlameAuthorProfileUrl,
  workspaceBlameInlineLabel,
  workspaceEditorBlameOverlayRows,
  workspaceEditorBasename,
  workspaceEditorCursorSelection,
  workspaceEditorLanguageLookupPath,
  workspaceEditorLiveModelKeys,
	  workspaceEditorLiveModelUriStrings,
	  workspaceEditorActionState,
	  workspaceEditorFileMode,
	  workspaceEditorLineChangesErrorState,
	  workspaceEditorLineChangesLoadedState,
	  workspaceEditorLineChangesLoadingState,
	  workspaceEditorLineChangesPatchLineClassName,
	  workspaceEditorModelContentVersion,
  workspaceEditorModelKey,
  workspaceEditorModelUriParts,
	  workspaceEditorPathSegments,
	  workspaceEditorPathToSegment,
	  workspaceEditorStatusKind,
	  workspaceEditorSurfaceState,
	  workspaceEditorTabDomId,
  workspaceEditorTabLabel,
  workspaceEditorVisibleLineWindow,
} = require('../../src/lib/workspace-editor-model.ts');
const {
  createWorkspaceEditorCloseIntent,
  uniqueWorkspaceEditorCloseFiles,
  workspaceEditorFilesForTabAction,
  workspaceEditorNextFocusAfterClosingFiles,
  workspaceEditorNextFocusAfterClosingTab,
  workspaceEditorPendingCloseNextFocus,
  workspaceEditorTabKey,
} = require('../../src/lib/workspace-editor-tabs.ts');
const {
  deletedWorkspaceDiffPlaceholderFile,
  shouldRefreshWorkspaceChangesAfterDirtyStateChange,
  shouldOpenMissingWorkspaceFileAsDiff,
  shouldRevealSelectedWorkspaceOpenFile,
  workspaceFileChangePathLabel,
  workspaceFileChangeRowKey,
  workspaceFileChangeTitle,
  workspaceFileOpenTargetForChange,
  workspaceOpenFileDirtyStateForAgent,
  workspaceOpenFileRequestForTarget,
} = require('../../src/lib/workspace-open-files.ts');
const {
  fuzzyPathTextRanges,
  fuzzyTextRanges,
  normalizeTextRanges,
  openRequestForWorkspaceFileJumpQuery,
  openRequestForWorkspaceFileSearchMatch,
  parseWorkspaceFileJumpQuery,
  pathSearchTextRanges,
  queryTextRange,
  targetForWorkspaceFileSearchMatch,
  workspaceFileSearchActiveOptionId,
} = require('../../src/lib/workspace-file-search.ts');
const {
  createWorkspaceFileOperation,
  workspaceFileContextMenuPosition,
  workspaceFileOperationInitialName,
  workspaceFileOperationSelectionEnd,
  workspaceFileOperationSubmitName,
  workspaceFileOperationTargetDirectory,
  workspaceFileOperationTitle,
} = require('../../src/lib/workspace-file-operation-model.ts');

function workspaceFile(path, overrides = {}) {
  return {
    path,
    name: path.split('/').filter(Boolean).pop() || path,
    type: 'file',
    sha1: 'sha',
    size: 1,
    mtimeMs: 1,
    ...overrides,
  };
}

function directory(path, overrides = {}) {
  return workspaceFile(path, { type: 'directory', ...overrides });
}

function workingCopy(overrides = {}) {
  return {
    agentId: 'agent-1',
    file: workspaceFile('src/App.tsx'),
    dirty: false,
    externalChanged: false,
    saving: false,
    error: null,
    ...overrides,
  };
}

function run() {
  assert.strictEqual(workspaceFileCacheKey('agent-1', 'src/App.tsx'), 'src/App.tsx');
  assert.strictEqual(workspaceFileCacheKey('agent-1', 'src/App.tsx', '/repo'), '/repo/src/App.tsx');
  assert.strictEqual(
    workspaceFileCacheKey('agent-parent', 'packages/a/src/App.tsx', '/repo'),
    workspaceFileCacheKey('agent-child', 'src/App.tsx', '/repo/packages/a')
  );
  assert.strictEqual(workspaceWorkingCopyKey(workingCopy()), 'src/App.tsx');
  assert.strictEqual(workspaceWorkingCopyKey(workingCopy({ workspaceRoot: '/repo' })), '/repo/src/App.tsx');

  assert.strictEqual(workspaceWorkingCopyState(workingCopy()), 'saved');
  assert.strictEqual(workspaceWorkingCopyState(workingCopy({ dirty: true })), 'dirty');
  assert.strictEqual(workspaceWorkingCopyState(workingCopy({ saving: true, dirty: true })), 'saving');
  assert.strictEqual(workspaceWorkingCopyState(workingCopy({ externalChanged: true, dirty: true })), 'conflict');
  assert.strictEqual(workspaceWorkingCopyState(workingCopy({ error: 'failed' })), 'error');
  assert.deepStrictEqual(workspaceOpenFileRequestForTarget({
    lineNumber: 12,
    column: 3,
    endColumn: 8,
  }, { cursorRequestId: 7, diffRequestId: 9 }), {
    cursor: {
      lineNumber: 12,
      column: 3,
      endColumn: 8,
      requestId: 7,
    },
    diffRequestId: undefined,
    diffOnly: undefined,
    transient: undefined,
  });
  assert.deepStrictEqual(workspaceOpenFileRequestForTarget({
    view: 'diff',
    diffOnly: true,
    gitStatus: 'deleted',
  }, { cursorRequestId: 7, diffRequestId: 9 }), {
    cursor: undefined,
    diffRequestId: 9,
    diffOnly: true,
    transient: undefined,
  });
  assert.deepStrictEqual(workspaceOpenFileRequestForTarget({
    transient: true,
  }, { cursorRequestId: 7, diffRequestId: 9 }), {
    cursor: undefined,
    diffRequestId: undefined,
    diffOnly: undefined,
    transient: true,
  });
  assert.deepStrictEqual(deletedWorkspaceDiffPlaceholderFile('src/deleted.ts', {
    view: 'diff',
    diffOnly: true,
    gitStatus: 'deleted',
    gitStatusLabel: 'D',
  }), {
    path: 'src/deleted.ts',
    content: '',
    size: 0,
    mtimeMs: 0,
    sha1: 'deleted:src/deleted.ts',
    gitStatus: 'deleted',
    gitStatusLabel: 'D',
  });
  assert.strictEqual(shouldOpenMissingWorkspaceFileAsDiff({
    view: 'diff',
    diffOnly: true,
    gitStatus: 'deleted',
  }), true);
  assert.strictEqual(shouldOpenMissingWorkspaceFileAsDiff({
    view: 'diff',
    diffOnly: true,
    gitStatus: 'modified',
  }), false);
  assert.strictEqual(shouldRevealSelectedWorkspaceOpenFile({ gitStatus: 'deleted' }), false);
  assert.strictEqual(shouldRevealSelectedWorkspaceOpenFile({ gitStatus: 'modified' }), true);
  assert.deepStrictEqual(workspaceFileOpenTargetForChange({
    path: 'src/App.tsx',
    name: 'App.tsx',
    gitStatus: 'modified',
    gitStatusLabel: 'M',
  }), {
    view: 'diff',
    diffOnly: false,
    gitStatus: 'modified',
    gitStatusLabel: 'M',
  });
  assert.deepStrictEqual(workspaceFileOpenTargetForChange({
    path: 'src/deleted.ts',
    name: 'deleted.ts',
    gitStatus: 'deleted',
    gitStatusLabel: 'D',
  }), {
    view: 'diff',
    diffOnly: true,
    gitStatus: 'deleted',
    gitStatusLabel: 'D',
  });
  assert.strictEqual(workspaceFileChangePathLabel({
    path: 'src/App.tsx',
    name: 'App.tsx',
    gitStatus: 'modified',
    gitStatusLabel: 'M',
  }), 'src/App.tsx');
  assert.strictEqual(workspaceFileChangePathLabel({
    path: 'src/New.tsx',
    name: 'New.tsx',
    previousPath: 'src/Old.tsx',
    gitStatus: 'renamed',
    gitStatusLabel: 'R',
  }), 'src/Old.tsx -> src/New.tsx');
  assert.strictEqual(workspaceFileChangeRowKey({
    path: 'src/New.tsx',
    name: 'New.tsx',
    previousPath: 'src/Old.tsx',
    gitStatus: 'renamed',
    gitStatusLabel: 'R',
  }), 'renamed:src/Old.tsx:src/New.tsx');
  assert.strictEqual(workspaceFileChangeTitle({
    path: 'src/New.tsx',
    name: 'New.tsx',
    previousPath: 'src/Old.tsx',
    gitStatus: 'renamed',
    gitStatusLabel: 'R',
  }, 'Renamed'), 'src/Old.tsx -> src/New.tsx · Renamed');
  assert.deepStrictEqual(Array.from(workspaceOpenFileDirtyStateForAgent([
    { agentId: 'agent-1', path: 'src/App.tsx', dirty: true },
    { agentId: 'agent-1', path: 'src/config.json', externalChanged: true },
    { agentId: 'agent-1', path: 'README.md' },
    { agentId: 'agent-2', path: 'other.ts', dirty: true },
  ], 'agent-1')), [
    ['src/App.tsx', true],
    ['src/config.json', true],
    ['README.md', false],
  ]);
  assert.deepStrictEqual(Array.from(workspaceOpenFileDirtyStateForAgent([
    { agentId: 'agent-1', path: 'src/App.tsx', dirty: true },
  ], null)), []);
  assert.strictEqual(shouldRefreshWorkspaceChangesAfterDirtyStateChange(
    new Map([['src/App.tsx', true]]),
    new Map([['src/App.tsx', false]])
  ), true);
  assert.strictEqual(shouldRefreshWorkspaceChangesAfterDirtyStateChange(
    new Map([['src/App.tsx', true]]),
    new Map([['src/App.tsx', true]])
  ), false);
  assert.strictEqual(shouldRefreshWorkspaceChangesAfterDirtyStateChange(
    new Map([['src/App.tsx', true]]),
    new Map()
  ), false);
	  assert.strictEqual(workspaceWorkingCopyState(workingCopy({ file: { ...workspaceFile('image.png'), preview: { kind: 'image', mediaType: 'image/png' } } })), 'preview');
	  assert.deepStrictEqual(workspaceEditorFileMode(workingCopy()), {
	    preview: false,
	    visualPreview: false,
	    diffOnly: false,
	    readOnly: false,
	    canEditText: true,
	    canShowDiff: true,
	    canShowBlame: true,
	    canShowLineChanges: true,
	  });
	  assert.deepStrictEqual(workspaceEditorFileMode(workingCopy({ file: { ...workspaceFile('image.png'), preview: { kind: 'image', mediaType: 'image/png' } } })), {
	    preview: true,
	    visualPreview: true,
	    diffOnly: false,
	    readOnly: true,
	    canEditText: false,
	    canShowDiff: false,
	    canShowBlame: false,
	    canShowLineChanges: false,
	  });
	  assert.deepStrictEqual(workspaceEditorFileMode(workingCopy({ file: { ...workspaceFile('large.log'), preview: { kind: 'large-text', mediaType: 'text/plain', truncated: true } } })), {
	    preview: true,
	    visualPreview: false,
	    diffOnly: false,
	    readOnly: true,
	    canEditText: false,
	    canShowDiff: false,
	    canShowBlame: false,
	    canShowLineChanges: false,
	  });
	  assert.deepStrictEqual(workspaceEditorFileMode(workingCopy({ diffOnly: true })), {
	    preview: false,
	    visualPreview: false,
	    diffOnly: true,
	    readOnly: true,
	    canEditText: false,
	    canShowDiff: true,
	    canShowBlame: false,
	    canShowLineChanges: false,
	  });
	  assert.strictEqual(isWorkspaceMarkdownFile('README.md'), true);
	  assert.strictEqual(isWorkspaceMarkdownFile('docs/guide.markdown'), true);
	  assert.strictEqual(isWorkspaceMarkdownFile('src/main.ts'), false);
	  assert.deepStrictEqual(workspaceEditorSurfaceState({ diffOnly: false, diffOpen: false, visualPreview: false }), {
	    showDiffView: false,
	    showDiffOnlyPreview: false,
	    showMarkdownPreview: false,
	    showMonaco: true,
	    showEditorOverlays: true,
	  });
	  assert.deepStrictEqual(workspaceEditorSurfaceState({ diffOnly: false, diffOpen: true, visualPreview: false }), {
	    showDiffView: true,
	    showDiffOnlyPreview: false,
	    showMarkdownPreview: false,
	    showMonaco: false,
	    showEditorOverlays: false,
	  });
	  assert.deepStrictEqual(workspaceEditorSurfaceState({ diffOnly: false, diffOpen: true, visualPreview: true }), {
	    showDiffView: false,
	    showDiffOnlyPreview: false,
	    showMarkdownPreview: false,
	    showMonaco: false,
	    showEditorOverlays: false,
	  });
	  assert.deepStrictEqual(workspaceEditorSurfaceState({ diffOnly: true, diffOpen: false, visualPreview: false }), {
	    showDiffView: false,
	    showDiffOnlyPreview: true,
	    showMarkdownPreview: false,
	    showMonaco: false,
	    showEditorOverlays: false,
	  });
	  assert.deepStrictEqual(workspaceEditorSurfaceState({ diffOnly: true, diffOpen: true, visualPreview: false }), {
	    showDiffView: true,
	    showDiffOnlyPreview: false,
	    showMarkdownPreview: false,
	    showMonaco: false,
	    showEditorOverlays: false,
	  });
	  assert.deepStrictEqual(workspaceEditorSurfaceState({ diffOnly: false, diffOpen: false, markdownPreviewOpen: true, visualPreview: false }), {
	    showDiffView: false,
	    showDiffOnlyPreview: false,
	    showMarkdownPreview: true,
	    showMonaco: false,
	    showEditorOverlays: false,
	  });
	  assert.deepStrictEqual(workspaceEditorSurfaceState({ diffOnly: false, diffOpen: true, markdownPreviewOpen: true, visualPreview: false }), {
	    showDiffView: true,
	    showDiffOnlyPreview: false,
	    showMarkdownPreview: false,
	    showMonaco: false,
	    showEditorOverlays: false,
	  });
	  assert.deepStrictEqual(workspaceEditorActionState(workingCopy({ dirty: true }), workspaceEditorFileMode(workingCopy({ dirty: true })), {
	    statusText: null,
	    showBreadcrumbs: false,
	  }), {
	    showBar: true,
	    showStatus: false,
	    showSave: true,
	    showDiff: true,
	    showMarkdownPreview: false,
	    showReload: false,
	    showOverwrite: false,
	  });
	  assert.deepStrictEqual(workspaceEditorActionState(
	    workingCopy({ externalChanged: true }),
	    workspaceEditorFileMode(workingCopy({ externalChanged: true })),
	    { statusText: 'Changed on disk', showBreadcrumbs: true }
	  ), {
	    showBar: true,
	    showStatus: true,
	    showSave: false,
	    showDiff: true,
	    showMarkdownPreview: false,
	    showReload: true,
	    showOverwrite: true,
	  });
	  assert.deepStrictEqual(workspaceEditorActionState(
	    workingCopy({ diffOnly: true, externalChanged: true }),
	    workspaceEditorFileMode(workingCopy({ diffOnly: true, externalChanged: true })),
	    { statusText: 'Changed on disk', showBreadcrumbs: false }
	  ), {
	    showBar: true,
	    showStatus: true,
	    showSave: false,
	    showDiff: true,
	    showMarkdownPreview: false,
	    showReload: false,
	    showOverwrite: false,
	  });
	  assert.deepStrictEqual(workspaceEditorActionState(
	    workingCopy(),
	    workspaceEditorFileMode(workingCopy()),
	    { canPreviewMarkdown: true, statusText: null, showBreadcrumbs: false }
	  ), {
	    showBar: true,
	    showStatus: false,
	    showSave: false,
	    showDiff: true,
	    showMarkdownPreview: true,
	    showReload: false,
	    showOverwrite: false,
	  });
	  assert.strictEqual(workspaceEditorStatusKind(workingCopy()), null);
	  assert.strictEqual(workspaceEditorStatusKind(workingCopy({ dirty: true })), null);
	  assert.strictEqual(workspaceEditorStatusKind(workingCopy({ externalChanged: true })), 'changedOnDisk');
	  assert.deepStrictEqual(workspaceEditorLineChangesLoadingState('previous', 12), {
	    mode: 'previous',
	    lineNumber: 12,
	    loading: true,
	    error: null,
	    changes: null,
	  });
	  const lineChangesFixture = {
	    isGitRepo: true,
	    path: 'src/App.tsx',
	    mode: 'working',
	    lineNumber: 9,
	    lookupLineNumber: 9,
	    targetSide: 'working',
	    available: true,
	    reason: undefined,
	    patch: '@@ -1 +1 @@\n-old\n+new',
	    hunk: null,
	  };
	  assert.deepStrictEqual(workspaceEditorLineChangesLoadedState('working', 9, lineChangesFixture), {
	    mode: 'working',
	    lineNumber: 9,
	    loading: false,
	    error: null,
	    changes: lineChangesFixture,
	  });
	  assert.deepStrictEqual(workspaceEditorLineChangesErrorState('working', 9, new Error('failed')), {
	    mode: 'working',
	    lineNumber: 9,
	    loading: false,
	    error: 'failed',
	    changes: null,
	  });
	  assert.strictEqual(workspaceEditorLineChangesPatchLineClassName('@@ -1 +1 @@'), 'meta');
	  assert.strictEqual(workspaceEditorLineChangesPatchLineClassName('+new'), 'added');
	  assert.strictEqual(workspaceEditorLineChangesPatchLineClassName('-old'), 'deleted');
	  assert.strictEqual(workspaceEditorLineChangesPatchLineClassName(' context'), 'context');

	  assert.strictEqual(isWorkspaceWorkingCopyClean(workingCopy()), true);
  assert.strictEqual(isWorkspaceWorkingCopyClean(workingCopy({ dirty: true })), false);
  assert.strictEqual(hasCleanWorkspaceWorkingCopy([workingCopy({ dirty: true }), workingCopy()]), true);
  assert.strictEqual(hasCleanWorkspaceWorkingCopy([workingCopy({ dirty: true }), workingCopy({ saving: true })]), false);
  assert.strictEqual(workspaceWorkingCopyChangeIndicator(workingCopy()), null);
  assert.strictEqual(workspaceWorkingCopyChangeIndicator(workingCopy({ dirty: true })), 'dirty');
  assert.strictEqual(workspaceWorkingCopyChangeIndicator(workingCopy({ dirty: true, externalChanged: true })), 'external');
  assert.strictEqual(shouldPromptBeforeClosingWorkspaceWorkingCopy(workingCopy({ dirty: true })), true);
  assert.strictEqual(shouldShowWorkspaceWorkingCopySaveAction(workingCopy({ dirty: true })), true);
  assert.strictEqual(shouldShowWorkspaceWorkingCopySaveAction(workingCopy({ dirty: true, externalChanged: true })), false);
  assert.strictEqual(shouldShowWorkspaceWorkingCopyOverwriteAction(workingCopy({ externalChanged: true })), true);
  assert.strictEqual(shouldShowWorkspaceWorkingCopyReloadAction(workingCopy({ error: 'failed' })), true);
  assert.strictEqual(workspaceWorkingCopyTabClass(workingCopy({ dirty: true, externalChanged: true })), 'dirty warning');
  assert.strictEqual(shouldCancelPendingWorkspaceFileTreeFocus('ArrowDown'), true);
  assert.strictEqual(shouldCancelPendingWorkspaceFileTreeFocus('F2'), true);
  assert.strictEqual(shouldCancelPendingWorkspaceFileTreeFocus('a'), false);
  assert.strictEqual(workspaceFileTreeKeyboardTargetPath({
    targetPath: 'clicked.ts',
    selectedPath: 'selected.ts',
    focusedPath: 'focused.ts',
    lastFocusedPath: 'last.ts',
  }), 'selected.ts');
  assert.strictEqual(workspaceFileTreeKeyboardTargetPath({
    selectedPath: 'selected.ts',
    focusedPath: 'focused.ts',
    lastFocusedPath: 'last.ts',
  }), 'selected.ts');
  assert.strictEqual(workspaceFileTreeKeyboardTargetPath({
    focusedPath: 'focused.ts',
    lastFocusedPath: 'last.ts',
  }), 'focused.ts');
  assert.strictEqual(workspaceFileTreeKeyboardTargetPath({
    lastFocusedPath: 'last.ts',
  }), 'last.ts');
  assert.strictEqual(workspaceFileTreeKeyboardTargetPath({}), null);
  assert.strictEqual(shouldCloseWorkspaceFileTreeDirectory({
    nodePath: 'src',
    nodeType: 'directory',
    nodeOpen: false,
    selectedRow: { path: 'src', type: 'directory', expanded: true },
    openDirectoryPaths: new Set(),
  }), true);
  assert.strictEqual(shouldCloseWorkspaceFileTreeDirectory({
    nodePath: 'src',
    nodeType: 'directory',
    nodeOpen: false,
    selectedRow: {},
    openDirectoryPaths: new Set(['src']),
  }), true);
  assert.strictEqual(shouldCloseWorkspaceFileTreeDirectory({
    nodePath: 'src/App.tsx',
    nodeType: 'file',
    nodeOpen: true,
    selectedRow: { path: 'src/App.tsx', type: 'file', expanded: true },
    openDirectoryPaths: new Set(['src/App.tsx']),
  }), false);
  assert.strictEqual(workspaceFileTreeRowClickIntent({
    nodeType: 'directory',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
  }), 'toggle-directory');
  assert.strictEqual(workspaceFileTreeRowClickIntent({
    nodeType: 'file',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
  }), 'open-file');
  assert.strictEqual(workspaceFileTreeRowClickIntent({
    nodeType: 'file',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
  }), 'select');
  assert.strictEqual(workspaceFileTreeRowClickIntent({
    nodeType: 'directory',
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
  }), 'select');
  assert.strictEqual(workspaceFileTreeActivationIntent({ nodeType: 'directory', nodeOpen: false }), 'open-directory');
  assert.strictEqual(workspaceFileTreeActivationIntent({ nodeType: 'directory', nodeOpen: true }), 'close-directory');
  assert.strictEqual(workspaceFileTreeActivationIntent({ nodeType: 'file', nodeOpen: false }), 'open-file');
  assert.strictEqual(workspaceFileTreeActivationIntent({ nodeType: 'unknown', nodeOpen: false }), 'none');

  assert.strictEqual(parentDirectory('src/components/App.tsx'), 'src/components');
  assert.deepStrictEqual(ancestorDirectories('src/components/App.tsx'), ['src', 'src/components']);
  assert.strictEqual(filePathDepth('src/components/App.tsx'), 2);
  assert.strictEqual(isDescendantPath('src', 'src/components/App.tsx'), true);
  assert.strictEqual(isDescendantPath('src', 'src-old/App.tsx'), false);

  const directories = {
    '': { items: [directory('src'), workspaceFile('README.md')] },
    src: { items: [directory('src/components')] },
    'src/components': {
      items: [
        workspaceFile('src/components/App.tsx'),
        workspaceFile('src/components/index.ts'),
      ],
    },
  };
  const tree = buildWorkspaceFileTreeNodes(directories[''].items, directories);
  assert.strictEqual(tree[0].path, 'src/components');
  assert.strictEqual(tree[0].displayName, 'src/components');
  assert.deepStrictEqual(tree[0].compactedPaths, ['src', 'src/components']);
  assert.strictEqual(findWorkspaceFileTreeNode(tree, 'src'), tree[0]);
  assert.strictEqual(findVisibleWorkspaceTreePath(tree, 'src'), 'src/components');
  assert.deepStrictEqual(visibleWorkspaceDirectoryPathsForTarget(tree, 'src/components/App.tsx'), ['src/components']);
  assert.strictEqual(countVisibleWorkspaceTreeRows(tree, new Set()), 2);
  assert.strictEqual(countVisibleWorkspaceTreeRows(tree, new Set(['src/components'])), 4);
  assert.deepStrictEqual(workspaceFileTreeDepthStyle(2), {
    '--file-indent': '28px',
    '--file-status-indent': '46px',
    '--file-guide-width': '24px',
    '--file-depth': 2,
  });
  assert.strictEqual(visibleWorkspaceFileTreeGitStatus('untracked'), undefined);
  assert.strictEqual(visibleWorkspaceFileTreeGitStatus('modified'), 'modified');
  assert.strictEqual(workspaceFileTreeDescendantGitStatusClassName('untracked'), '');
  assert.strictEqual(workspaceFileTreeDescendantGitStatusClassName('deleted'), 'code-file-descendant-status deleted');
  const treeStatusCopy = {
    changedOnDisk: 'Changed on disk',
    containsUncommittedChanges: 'Contains uncommitted changes',
    unsavedChanges: 'Unsaved changes',
  };
  assert.strictEqual(workspaceFileTreeStatusTitle('git', treeStatusCopy), 'Contains uncommitted changes');
  assert.strictEqual(workspaceFileTreeStatusTitle('external', treeStatusCopy), 'Changed on disk');
  assert.strictEqual(workspaceFileTreeStatusTitle('dirty', treeStatusCopy), 'Unsaved changes');
  assert.strictEqual(workspaceFileTreeStatusTitle(null, treeStatusCopy), 'Changed on disk');
  assert.strictEqual(hasWorkspaceFileTreeDescendant(new Set(['src/components/App.tsx']), 'src'), true);
  assert.strictEqual(hasWorkspaceFileTreeDescendant(new Set(['src-old/App.tsx']), 'src'), false);
  const fileRowState = workspaceFileTreeRowViewState({
    activeFilePath: 'src/App.tsx',
    editorDirtyFilePaths: new Set(['src/App.tsx']),
    editorExternalChangedFilePaths: new Set(),
    item: workspaceFile('src/App.tsx', { gitStatus: 'modified', gitStatusLabel: 'M' }),
    isFocused: true,
    isOpen: false,
    isSelected: true,
  });
  assert.strictEqual(fileRowState.isDirectory, false);
  assert.strictEqual(fileRowState.visibleGitStatus, 'modified');
  assert.strictEqual(fileRowState.visibleGitStatusClassName, 'code-file-git-status modified');
  assert.strictEqual(fileRowState.visibleGitStatusLabel, 'M');
  assert.strictEqual(fileRowState.fileChangedClassName, 'code-file-changed dirty');
  assert.strictEqual(fileRowState.fileChangedTitleKind, 'dirty');
  assert.strictEqual(fileRowState.showDirectoryDot, false);
  assert(fileRowState.rowClasses.includes('file'));
  assert(fileRowState.rowClasses.includes('active'));
  assert(fileRowState.rowClasses.includes('editor-dirty'));
  assert(fileRowState.rowClasses.includes('git-status'));
  assert(fileRowState.rowClasses.includes('focused'));
  assert(fileRowState.rowClasses.includes('selected'));
  const directoryRowState = workspaceFileTreeRowViewState({
    editorDirtyFilePaths: new Set(['src/components/App.tsx']),
    editorExternalChangedFilePaths: new Set(['src/components/config.json']),
    item: directory('src', { descendantGitStatus: 'deleted' }),
    isFocused: false,
    isOpen: true,
    isSelected: false,
  });
  assert.strictEqual(directoryRowState.isDirectory, true);
  assert.strictEqual(directoryRowState.chevronState, 'expanded');
  assert.strictEqual(directoryRowState.showDirectoryDot, true);
  assert.strictEqual(directoryRowState.directoryDotKind, 'deleted');
  assert.strictEqual(directoryRowState.directoryDotClassName, 'code-file-descendant-status deleted');
  assert.strictEqual(directoryRowState.directoryDotTitleKind, 'git');
  assert.strictEqual(directoryRowState.hasDescendantGitStatus, true);
  assert.strictEqual(directoryRowState.hasEditorDirtyDescendant, true);
  assert.strictEqual(directoryRowState.hasEditorExternalChangedDescendant, true);
  assert(directoryRowState.rowClasses.includes('directory'));
  assert(!directoryRowState.rowClasses.includes('changed-descendant'));
  assert(directoryRowState.rowClasses.includes('editor-descendant-dirty'));
  assert(directoryRowState.rowClasses.includes('editor-descendant-external-changed'));
  assert(directoryRowState.rowClasses.includes('git-descendant-deleted'));
  assert.deepStrictEqual(workspaceStickyContextItems({
    visible: false,
    directoryNodes: [],
    openFilesCount: 0,
    openEditorsLabel: 'OPEN EDITORS',
    filesLabel: 'FILES',
  }), []);
  assert.deepStrictEqual(workspaceStickyContextItems({
    visible: true,
    directoryNodes: [directory('src')],
    openFilesCount: 2,
    openEditorsLabel: 'OPEN EDITORS',
    filesLabel: 'FILES',
  }).map(item => item.kind === 'directory' ? `${item.kind}:${item.node.path}` : `${item.kind}:${item.name}`), [
    'open-editors:OPEN EDITORS',
    'files:FILES',
    'directory:src',
  ]);
  assert.strictEqual(workspaceFileRevealScrollDelta({ top: 100, bottom: 200 }, { top: 80, bottom: 120 }), -20);
  assert.strictEqual(workspaceFileRevealScrollDelta({ top: 100, bottom: 200 }, { top: 180, bottom: 220 }), 20);
  assert.strictEqual(workspaceFileRevealScrollDelta({ top: 100, bottom: 200 }, { top: 120, bottom: 180 }), 0);
  assert.strictEqual(shouldFocusWorkspaceFileTree({
    focusRow: true,
    operationActive: false,
    activeElementIsSearchInput: false,
    searchInputValue: '',
  }), true);
  assert.strictEqual(shouldFocusWorkspaceFileTree({
    focusRow: true,
    operationActive: true,
    activeElementIsSearchInput: false,
    searchInputValue: '',
  }), false);
  assert.strictEqual(shouldSkipWorkspaceFileSearchFocus({
    activeElementIsSearchInput: true,
    searchInputValue: 'App',
  }), true);
  assert.strictEqual(shouldSkipWorkspaceFileSearchFocus({
    activeElementIsSearchInput: true,
    searchInputValue: '',
  }), false);
  assert.strictEqual(shouldSelectWorkspaceFileSearchText({
    requestedSelect: true,
    searchInputValue: 'App',
  }), true);
  assert.strictEqual(shouldSelectWorkspaceFileSearchText({
    requestedSelect: false,
    searchInputValue: '',
  }), true);
  assert.strictEqual(shouldSelectWorkspaceFileSearchText({
    requestedSelect: false,
    searchInputValue: 'App',
  }), false);
  assert.strictEqual(workspaceFileTreeFocusTargetPath({
    lastFocusedPath: 'src/App.tsx',
    rows: [
      { path: 'README.md', selected: false },
      { path: 'src/App.tsx', selected: false },
      { path: 'src/index.ts', selected: true },
    ],
  }), 'src/App.tsx');
  assert.strictEqual(workspaceFileTreeFocusTargetPath({
    lastFocusedPath: 'missing.ts',
    rows: [
      { path: 'README.md', selected: false },
      { path: 'src/index.ts', selected: true },
    ],
  }), 'src/index.ts');
  assert.strictEqual(workspaceFileTreeFocusTargetPath({
    lastFocusedPath: null,
    rows: [
      { path: 'README.md', selected: false },
      { path: 'src/index.ts', selected: false },
    ],
  }), 'README.md');
  assert.strictEqual(workspaceFileTreeFocusTargetPath({
    lastFocusedPath: null,
    rows: [],
  }), null);
  assert.strictEqual(workspaceStickyContentTop(10, 30, 12), 52);
  assert.strictEqual(isWorkspaceStickyContextVisible(40, 41), true);
  assert.strictEqual(isWorkspaceStickyContextVisible(43, 41), false);
  const rowSnapshots = [
    { path: 'src', top: 20, bottom: 44 },
    { path: 'src/components', top: 52, bottom: 76 },
    { path: 'src/components/App.tsx', top: 80, bottom: 104 },
  ];
  assert.strictEqual(firstVisibleWorkspaceFilePath(rowSnapshots, 50, 120), 'src/components');
  assert.deepStrictEqual(workspaceStickyDirectoryPaths('src/components/App.tsx', rowSnapshots, 70), ['src', 'src/components']);
  assert.strictEqual(openEditorsRevealScrollDelta(180, 64), 116);
  assert.deepStrictEqual(WORKSPACE_FILE_SEARCH_FOCUS_RETRY_DELAYS, [0, 80, 180, 300, 520, 900, 1200]);
  assert.deepStrictEqual(WORKSPACE_FILE_TREE_FOCUS_RETRY_DELAYS, [80, 180, 360]);

  const editorFile = {
    agentId: 'agent 1',
    workspaceRoot: '/repo',
    file: {
      path: 'src/App.tsx',
      sha1: 'abc',
      size: 10,
      mtimeMs: 42,
    },
  };
  const nestedEditorFile = {
    agentId: 'agent 2',
    workspaceRoot: '/repo/src',
    file: {
      path: 'App.tsx',
      sha1: 'abc',
      size: 10,
      mtimeMs: 42,
    },
  };
  assert.strictEqual(workspaceEditorModelKey(editorFile), '/repo/src/App.tsx');
  assert.strictEqual(workspaceEditorModelKey(nestedEditorFile), '/repo/src/App.tsx');
  assert.strictEqual(workspaceEditorModelContentVersion(editorFile), '/repo/src/App.tsx:abc:10:42');
  assert.deepStrictEqual(workspaceEditorModelUriParts(editorFile), {
    scheme: 'farming-file',
    path: '/repo/src/App.tsx',
  });
  assert.strictEqual(isWorkspaceEditorModelUri({ scheme: 'farming-file' }), true);
  assert.strictEqual(isWorkspaceEditorModelUri({ scheme: 'file' }), false);
  assert.strictEqual(safeWorkspaceEditorDomIdPart('/repo/src/App.tsx'), '-repo-src-App-tsx');
  assert.strictEqual(workspaceEditorTabDomId(editorFile), 'code-file-editor-tab--repo-src-App-tsx');
  assert.strictEqual(workspaceEditorBasename('/src/components/App.tsx'), 'App.tsx');
  assert.deepStrictEqual(workspaceEditorPathSegments('src/components/App.tsx'), ['src', 'components', 'App.tsx']);
  assert.strictEqual(workspaceEditorPathToSegment(['src', 'components', 'App.tsx'], 1), 'src/components');
  assert.strictEqual(workspaceEditorTabLabel({ file: { path: 'src/App.tsx' } }), 'App.tsx, src/App.tsx');
  assert.strictEqual(workspaceEditorTabLabel({ file: { path: 'src/App.tsx' }, dirty: true }), 'App.tsx, src/App.tsx, unsaved changes');
  assert.strictEqual(workspaceEditorTabLabel({ file: { path: 'src/App.tsx' }, dirty: true, externalChanged: true }), 'App.tsx, src/App.tsx, changed on disk');
  assert.strictEqual(workspaceEditorLanguageLookupPath('src/App.tsx~'), 'src/App.tsx');
  assert.deepStrictEqual(Array.from(workspaceEditorLiveModelKeys([editorFile])), ['/repo/src/App.tsx']);
  assert.deepStrictEqual(Array.from(workspaceEditorLiveModelUriStrings([editorFile], file => `uri:${file.file.path}`)), ['uri:src/App.tsx']);
  assert.strictEqual(shouldKeepWorkspaceEditorViewState('/repo/src/App.tsx', workspaceEditorLiveModelKeys([editorFile])), true);
  assert.strictEqual(shouldKeepWorkspaceEditorViewState('/repo/src/Other.tsx', workspaceEditorLiveModelKeys([editorFile])), false);
  assert.strictEqual(shouldDisposeWorkspaceEditorModelUri({ scheme: 'farming-file', toString: () => 'farming-file:/repo/src/Other.tsx' }, new Set(['farming-file:/repo/src/App.tsx'])), true);
  assert.strictEqual(shouldDisposeWorkspaceEditorModelUri({ scheme: 'farming-file', toString: () => 'farming-file:/repo/src/App.tsx' }, new Set(['farming-file:/repo/src/App.tsx'])), false);
  assert.strictEqual(shouldDisposeWorkspaceEditorModelUri({ scheme: 'file', toString: () => 'file:///tmp/App.tsx' }, new Set()), false);
  assert.deepStrictEqual(workspaceEditorCursorSelection({
    lineNumber: 99,
    column: -3,
    endColumn: 500,
  }, {
    lineCount: 10,
    getLineMaxColumn: lineNumber => lineNumber === 10 ? 12 : 8,
  }), {
    startLineNumber: 10,
    startColumn: 1,
    endLineNumber: 10,
    endColumn: 12,
  });
  assert.deepStrictEqual(workspaceEditorCursorSelection({
    lineNumber: 2,
    column: 5,
    endColumn: 3,
  }, {
    lineCount: 10,
    getLineMaxColumn: () => 20,
  }), {
    startLineNumber: 2,
    startColumn: 5,
    endLineNumber: 2,
    endColumn: 5,
  });
  assert.deepStrictEqual(workspaceEditorCursorSelection({
    lineNumber: 0,
  }, {
    lineCount: 0,
    getLineMaxColumn: () => 0,
  }), {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
  });

  const languages = [
    { id: 'ignore', filenames: ['.gitignore'] },
    { id: 'typescript-test', extensions: ['.test.ts'] },
    { id: 'typescript', extensions: ['.ts'] },
    { id: 'config-js', filenamePatterns: ['*.config.js'] },
    { id: 'python', firstLine: '^#!.*python' },
  ];
  assert.strictEqual(languageForWorkspaceFile('.gitignore', '', languages), 'ignore');
  assert.strictEqual(languageForWorkspaceFile('src/App.test.ts', '', languages), 'typescript-test');
  assert.strictEqual(languageForWorkspaceFile('src/App.ts~', '', languages), 'typescript');
  assert.strictEqual(languageForWorkspaceFile('vite.config.js', '', languages), 'config-js');
  assert.strictEqual(languageForWorkspaceFile('bin/tool', '#!/usr/bin/env python\nprint(1)', languages), 'python');
  assert.strictEqual(languageForWorkspaceFile('data/events.jsonl', '{}', languages), 'json');
  assert.strictEqual(languageForWorkspaceFile('notes/readme.unknown', '', languages), 'plaintext');
  assert.ok(formatWorkspaceBlameTime(1704067200).includes('2024'));
  assert.strictEqual(workspaceBlameInlineLabel({ author: '', authorTime: null }), 'Unknown');
  assert.ok(workspaceBlameInlineLabel({ author: 'Ada Lovelace', authorTime: 1704067200 }).includes('Ada Lovelace'));
  assert.strictEqual(estimateWorkspaceBlameLabelWidth([], false), 112);
  assert.strictEqual(estimateWorkspaceBlameLabelWidth([{ author: 'A'.repeat(100), authorTime: null }], true), 110);
  assert.deepStrictEqual(workspaceEditorVisibleLineWindow({
    visibleRanges: [
      { startLineNumber: 10, endLineNumber: 20 },
      { startLineNumber: 24, endLineNumber: 30 },
    ],
    scrollTop: 0,
    hostHeight: 300,
    lineHeight: 20,
  }), {
    firstVisibleLine: 9,
    lastVisibleLine: 31,
  });
  assert.deepStrictEqual(workspaceEditorVisibleLineWindow({
    visibleRanges: [],
    scrollTop: 200,
    hostHeight: 100,
    lineHeight: 20,
  }), {
    firstVisibleLine: 10,
    lastVisibleLine: 16,
  });
  const blameOverlayLines = Array.from({ length: 32 }, (_value, index) => ({
    lineNumber: index + 1,
    author: index === 8 ? 'Ada' : index === 9 ? 'Grace' : index === 30 ? 'Linus' : 'Hidden',
    authorTime: null,
  }));
  const blameOverlayRows = workspaceEditorBlameOverlayRows(blameOverlayLines, {
    firstVisibleLine: 9,
    lastVisibleLine: 31,
    hostTop: 100,
    scrollTop: 180,
    hostHeight: 120,
    lineHeight: 20,
    getTopForLineNumber: lineNumber => lineNumber * 20,
  });
  assert.deepStrictEqual(blameOverlayRows.map(row => [row.line.lineNumber, row.top]), [
    [9, 100],
    [10, 120],
    [11, 140],
    [12, 160],
    [13, 180],
    [14, 200],
    [15, 220],
    [16, 240],
  ]);
  assert.strictEqual(blameOverlayRows[0].line.author, 'Ada');
  assert.strictEqual(workspaceBlameAuthorProfileUrl('Ada Lovelace', 'https://example.test/u/{author}'), 'https://example.test/u/Ada%20Lovelace');
  assert.strictEqual(workspaceBlameAuthorProfileUrl('Unknown', 'https://example.test/u/{author}'), '');
  assert.strictEqual(isPermanentWorkspaceBlameFailureStatus(409), true);
  assert.strictEqual(isPermanentWorkspaceBlameFailureStatus(500), false);

  const tabA = workingCopy({ file: workspaceFile('src/A.ts') });
  const tabB = workingCopy({ file: workspaceFile('src/B.ts'), dirty: true });
  const tabC = workingCopy({ file: workspaceFile('src/C.ts') });
  assert.strictEqual(workspaceEditorTabKey(tabA), 'src/A.ts');
  assert.deepStrictEqual(uniqueWorkspaceEditorCloseFiles([tabA, tabA, tabB]), [tabA, tabB]);
  assert.strictEqual(workspaceEditorNextFocusAfterClosingTab([tabA, tabB, tabC], tabB, 1), tabA);
  assert.strictEqual(workspaceEditorNextFocusAfterClosingTab([tabA, tabB, tabC], tabA, 0), tabB);
  assert.strictEqual(workspaceEditorNextFocusAfterClosingTab([tabA, tabB, tabC], tabB, 0), tabB);
  assert.strictEqual(workspaceEditorNextFocusAfterClosingFiles([tabA, tabB, tabC], tabB, [tabB, tabC]), tabA);
  assert.strictEqual(workspaceEditorNextFocusAfterClosingFiles([tabA, tabB, tabC], tabB, [tabA]), tabB);
  assert.strictEqual(workspaceEditorNextFocusAfterClosingFiles([tabA, tabB, tabC], tabB, [tabA, tabB, tabC]), null);
  const closeIntent = createWorkspaceEditorCloseIntent([tabA, tabB, tabB], tabC);
  assert.deepStrictEqual(closeIntent.closeFiles, [tabA, tabB]);
  assert.deepStrictEqual(closeIntent.dirtyFiles, [tabB]);
  assert.deepStrictEqual(closeIntent.pendingClose, {
    files: [tabB],
    closeFiles: [tabA, tabB],
    nextFocusFile: tabC,
  });
  assert.strictEqual(workspaceEditorPendingCloseNextFocus({
    files: [tabB],
    closeFiles: [tabB],
    nextFocusFile: tabB,
  }), null);
  assert.strictEqual(workspaceEditorPendingCloseNextFocus({
    files: [tabB],
    closeFiles: [tabB],
    nextFocusFile: tabC,
  }), tabC);
  assert.deepStrictEqual(workspaceEditorFilesForTabAction('close', [tabA, tabB, tabC], 1), [tabB]);
  assert.deepStrictEqual(workspaceEditorFilesForTabAction('close-others', [tabA, tabB, tabC], 1), [tabA, tabC]);
  assert.deepStrictEqual(workspaceEditorFilesForTabAction('close-right', [tabA, tabB, tabC], 1), [tabC]);
  assert.deepStrictEqual(workspaceEditorFilesForTabAction('close-saved', [tabA, tabB, tabC], 1), [tabA, tabC]);
  assert.deepStrictEqual(workspaceEditorFilesForTabAction('close-all', [tabA, tabB, tabC], 1), [tabA, tabB, tabC]);

  assert.deepStrictEqual(parseWorkspaceFileJumpQuery('./src/App.tsx:12:3'), {
    path: 'src/App.tsx',
    lineNumber: 12,
    column: 3,
  });
  assert.deepStrictEqual(parseWorkspaceFileJumpQuery('src/App.tsx#L7C2'), {
    path: 'src/App.tsx',
    lineNumber: 7,
    column: 2,
  });
  assert.strictEqual(parseWorkspaceFileJumpQuery('src/App.tsx'), null);
  assert.deepStrictEqual(targetForWorkspaceFileSearchMatch({
    path: 'src/App.tsx',
    lineNumber: 9,
    lines: 'const value = 1',
    ranges: [{ start: 6, end: 11 }],
  }), {
    lineNumber: 9,
    column: 7,
    endColumn: 12,
  });
  assert.deepStrictEqual(openRequestForWorkspaceFileJumpQuery('./src/App.tsx:12:3'), {
    path: 'src/App.tsx',
    target: {
      lineNumber: 12,
      column: 3,
    },
  });
  assert.strictEqual(openRequestForWorkspaceFileJumpQuery('src/App.tsx'), null);
  assert.deepStrictEqual(openRequestForWorkspaceFileSearchMatch({
    kind: 'path',
    path: 'src/App.tsx',
    lineNumber: 1,
    lines: '',
    ranges: [],
  }), {
    path: 'src/App.tsx',
  });
  assert.deepStrictEqual(openRequestForWorkspaceFileSearchMatch({
    path: 'src/App.tsx',
    lineNumber: 9,
    lines: 'const value = 1',
    ranges: [{ start: 6, end: 11 }],
  }), {
    path: 'src/App.tsx',
    target: {
      lineNumber: 9,
      column: 7,
      endColumn: 12,
    },
  });
  assert.strictEqual(workspaceFileSearchActiveOptionId({
    active: false,
    activeMatchIndex: 0,
    jumpTarget: { path: 'src/App.tsx', lineNumber: 1 },
    listboxId: 'search',
  }), undefined);
  assert.strictEqual(workspaceFileSearchActiveOptionId({
    active: true,
    activeMatchIndex: -1,
    jumpTarget: { path: 'src/App.tsx', lineNumber: 1 },
    listboxId: 'search',
  }), 'search-jump');
  assert.strictEqual(workspaceFileSearchActiveOptionId({
    active: true,
    activeMatchIndex: 2,
    jumpTarget: null,
    listboxId: 'search',
  }), 'search-2');
  assert.strictEqual(workspaceFileSearchActiveOptionId({
    active: true,
    activeMatchIndex: -1,
    jumpTarget: null,
    listboxId: 'search',
  }), undefined);
  assert.deepStrictEqual(queryTextRange('src/components/App.tsx', './components'), { start: 4, end: 14 });
  assert.deepStrictEqual(fuzzyTextRanges('src/components/App.tsx', 'sca', true), [
    { start: 0, end: 1 },
    { start: 4, end: 5 },
    { start: 15, end: 16 },
  ]);
  assert.deepStrictEqual(fuzzyPathTextRanges('src/components/App.tsx', 'sca'), [
    { start: 0, end: 1 },
    { start: 4, end: 5 },
    { start: 15, end: 16 },
  ]);
  assert.deepStrictEqual(fuzzyPathTextRanges('src/components/App.tsx', 'toolong'), []);
  assert.deepStrictEqual(normalizeTextRanges('abcdef', [
    { start: -2, end: 2 },
    { start: 1, end: 4 },
    { start: 5, end: 9 },
  ]), [
    { start: 0, end: 4 },
    { start: 5, end: 6 },
  ]);
  assert.deepStrictEqual(pathSearchTextRanges('src/components/App.tsx', 'components'), [{ start: 4, end: 14 }]);

  const fileNode = workspaceFile('src/components/App.test.tsx');
  const directoryNode = directory('src/components');
  assert.strictEqual(workspaceFileOperationTargetDirectory(null), '');
  assert.strictEqual(workspaceFileOperationTargetDirectory(fileNode), 'src/components');
  assert.strictEqual(workspaceFileOperationTargetDirectory(directoryNode), 'src/components');
  assert.strictEqual(workspaceFileOperationInitialName('new-file', fileNode), '');
  assert.strictEqual(workspaceFileOperationInitialName('rename', fileNode), 'App.test.tsx');
  assert.deepStrictEqual(createWorkspaceFileOperation('rename', fileNode), {
    kind: 'rename',
    item: fileNode,
    parentPath: 'src/components',
    name: 'App.test.tsx',
  });
  assert.strictEqual(workspaceFileOperationSelectionEnd(createWorkspaceFileOperation('rename', fileNode)), 8);
  assert.strictEqual(workspaceFileOperationSelectionEnd(createWorkspaceFileOperation('delete', fileNode)), 'App.test.tsx'.length);
  assert.strictEqual(workspaceFileOperationSubmitName({
    ...createWorkspaceFileOperation('rename', fileNode),
    name: 'App.test.tsx.tsx',
  }), 'App.test.tsx');
  assert.strictEqual(workspaceFileOperationSubmitName({
    ...createWorkspaceFileOperation('rename', fileNode),
    name: 'Renamed.tsx',
  }), 'Renamed.tsx');
  assert.strictEqual(workspaceFileOperationTitle(createWorkspaceFileOperation('new-file', null), {
    newFile: 'New File',
    newFolder: 'New Folder',
    rename: 'Rename',
    delete: 'Delete',
  }), 'New File');
  assert.deepStrictEqual(workspaceFileContextMenuPosition(500, 500, fileNode, 600, 580), {
    x: 372,
    y: 336,
  });
  assert.deepStrictEqual(workspaceFileContextMenuPosition(500, 500, fileNode, 600, 580, 4), {
    x: 372,
    y: 222,
  });

  console.log('test-workspace-file-models passed');
}

run();
