const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const workspaceSource = [
    'src/components/CodeWorkspace.tsx',
    'src/components/code/CodeComposer.tsx',
    'src/components/code/CodeMainArea.tsx',
    'src/components/code/CodeOverlays.tsx',
    'src/components/code/CodeSidebar.tsx',
    'src/components/code/HistoryPanel.tsx',
    'src/components/code/SearchPanel.tsx',
    'src/components/code/model.ts',
    'src/components/code/types.ts',
    'src/components/code/workspace-file-view.ts',
  ].map(read).join('\n');
  const appSource = read('src/App.tsx');
  const fileSectionSource = read('src/components/files/ProjectFilesSection.tsx');
  const codeCopySource = read('src/components/code/copy.ts');
  const fileContextMenuSource = read('src/components/files/FileContextMenu.tsx');
  const fileOperationDialogSource = read('src/components/files/FileOperationDialog.tsx');
  const fileSearchResultsSource = read('src/components/files/FileSearchResults.tsx');
  const fileSectionBodySource = read('src/components/files/FileSectionBody.tsx');
  const fileSectionHeaderSource = read('src/components/files/FileSectionHeader.tsx');
  const fileSectionViewModelSource = read('src/components/files/useProjectFilesSectionViewModel.ts');
  const fileSectionOverlaysSource = read('src/components/files/FileSectionOverlays.tsx');
  const fileStickyContextSource = read('src/components/files/FileStickyContext.tsx');
  const fileTreeInlineOperationSource = read('src/components/files/FileTreeInlineOperation.tsx');
  const fileTreeViewSource = read('src/components/files/FileTreeView.tsx');
  const fileTreeRowSource = read('src/components/files/FileTreeRow.tsx');
  const fileTreeRowStatusSource = read('src/components/files/FileTreeRowStatus.tsx');
  const fileTreeRowInteractionsSource = read('src/components/files/useFileTreeRowInteractions.ts');
  const openEditorsSectionSource = read('src/components/files/OpenEditorsSection.tsx');
  const editorSource = read('src/components/files/FileEditorPane.tsx');
  const editorActionsSource = read('src/components/files/FileEditorActions.tsx');
  const editorBreadcrumbsSource = read('src/components/files/FileEditorBreadcrumbs.tsx');
  const editorBlameDetailSource = read('src/components/files/FileEditorBlameDetail.tsx');
  const editorBlameToastSource = read('src/components/files/FileEditorBlameToast.tsx');
  const editorBlameControllerSource = read('src/components/files/useFileEditorBlameController.ts');
  const editorBlameOverlayControllerSource = read('src/components/files/useFileEditorBlameOverlayController.ts');
  const editorContextMenuSource = read('src/components/files/FileEditorContextMenu.tsx');
  const editorContextMenuControllerSource = read('src/components/files/useFileEditorContextMenuController.ts');
  const editorDiffControllerSource = read('src/components/files/useFileEditorDiffController.ts');
  const editorDiffViewSource = read('src/components/files/FileEditorDiffView.tsx');
  const editorHeaderSource = read('src/components/files/FileEditorHeader.tsx');
  const editorInlineBlameLayerSource = read('src/components/files/FileEditorInlineBlameLayer.tsx');
  const editorLineChangesPanelSource = read('src/components/files/FileEditorLineChangesPanel.tsx');
  const editorOverlaysSource = read('src/components/files/FileEditorOverlays.tsx');
  const editorPreviewPanelSource = read('src/components/files/FileEditorPreviewPanel.tsx');
  const editorSaveConfirmDialogSource = read('src/components/files/FileEditorSaveConfirmDialog.tsx');
  const editorShellKeyboardSource = read('src/components/files/useFileEditorShellKeyboard.ts');
  const editorSurfaceSource = read('src/components/files/FileEditorSurface.tsx');
  const editorTabsComponentSource = read('src/components/files/FileEditorTabs.tsx');
  const editorTabContextMenuSource = read('src/components/files/FileEditorTabContextMenu.tsx');
  const editorMonacoSource = read('src/lib/workspace-editor-monaco.ts');
  const editorMonacoControllerSource = read('src/components/files/useFileEditorMonacoController.ts');
  const editorTestBridgeSource = read('src/components/files/useFileEditorTestBridge.ts');
  const editorLineChangesControllerSource = read('src/components/files/useFileEditorLineChangesController.ts');
  const editorTabsControllerSource = read('src/components/files/useFileEditorTabsController.ts');
  const editorWorkingCopyControllerSource = read('src/components/files/useFileEditorWorkingCopyController.ts');
  const workspaceMenuKeyboardSource = read('src/components/files/useWorkspaceMenuKeyboard.ts');
  const editorModelSource = read('src/lib/workspace-editor-model.ts');
  const editorTabsSource = read('src/lib/workspace-editor-tabs.ts');
  const fileSearchSource = read('src/lib/workspace-file-search.ts');
  const fileOperationModelSource = read('src/lib/workspace-file-operation-model.ts');
  const fileViewModelSource = read('src/lib/workspace-file-view-model.ts');
  const fileFocusHookSource = read('src/components/files/useWorkspaceFileFocus.ts');
  const fileMenuControllerSource = read('src/components/files/useWorkspaceFileMenuController.ts');
  const fileOpenControllerSource = read('src/components/files/useWorkspaceFileOpenController.ts');
  const fileOperationControllerSource = read('src/components/files/useWorkspaceFileOperationController.ts');
  const fileTreeKeyboardHookSource = read('src/components/files/useWorkspaceFileTreeKeyboard.ts');
  const fileSearchHookSource = read('src/components/files/useWorkspaceFileSearch.ts');
  const fileSearchControllerHookSource = read('src/components/files/useWorkspaceFileSearchController.ts');
  const fileSectionControllerHookSource = read('src/components/files/useWorkspaceFileSectionController.ts');
  const fileStickyContextHookSource = read('src/components/files/useWorkspaceFileStickyContext.ts');
  const fileTreeControllerHookSource = read('src/components/files/useWorkspaceFileTreeController.ts');
  const treeModelSource = read('src/lib/workspace-file-tree.ts');
  const treeRowModelSource = read('src/lib/workspace-file-tree-row.ts');
  const openFilesSource = read('src/lib/workspace-open-files.ts');
  const openFilesHookSource = read('src/components/code/useWorkspaceOpenFiles.ts');
  const explorerHookSource = read('src/components/files/useWorkspaceFileExplorer.ts');
  const operationSource = read('src/lib/workspace-file-operations.ts');
  const workingCopySource = read('src/lib/workspace-working-copy.ts');
  const terminalPaneSource = read('src/components/AgentTerminalPane.tsx');
  const pooledTerminalHookSource = read('src/hooks/usePooledTerminal.ts');
  const terminalPoolSource = read('src/lib/terminal-session-pool.ts');
  const terminalLinksSource = read('src/lib/terminal-links.ts');
  const fileIconsSource = read('src/lib/file-icons.ts');
  const hookSource = read('src/hooks/useWorkspaceFiles.ts');
  const webSocketSource = read('src/hooks/useWebSocket.ts');
  const apiSource = read('src/lib/workspace-files.ts');
  const messagesSource = read('src/types/messages.ts');
  const serverSource = read('backend/server.js');
  const stylesSource = read('src/styles/main.css');
  const darkStylesSource = read('src/styles/code-dark.css');
  const monacoHostStyle = stylesSource.match(/\.code-file-monaco\s*\{[^}]+\}/)?.[0] || '';
  const singleTerminalGridStyle = stylesSource.match(/\.code-terminal-grid\.panes-1\s*\{[^}]+\}/)?.[0] || '';
  const designSource = read('docs/products/code/project-files-section-design.zh_cn.md');
  const userStoriesSource = read('docs/products/code/files-editor-user-stories.zh_cn.md');
  const fileTreeSurfaceSource = `${fileSectionSource}\n${fileSectionViewModelSource}\n${fileTreeViewSource}`;

  assert(
	      workspaceSource.includes('ProjectFilesSection') &&
	      workspaceSource.includes('FileEditorPane') &&
	      workspaceSource.includes('function loadFileEditorPane') &&
	      workspaceSource.includes('function FileEditorFallback') &&
	      workspaceSource.includes('data-testid="code-file-editor-fallback-textarea"') &&
	      workspaceSource.includes('fallback={') &&
	      workspaceSource.includes('<FileEditorFallback') &&
	      workspaceSource.includes('openFile={openWorkspaceFile}') &&
	      workspaceSource.includes('onChangeDraft={onChangeWorkspaceFileDraft}') &&
	      workspaceSource.includes('isTextEditingShortcutTarget') &&
      workspaceSource.includes("type MainPaneMode = 'terminal' | 'editor'") &&
      workspaceSource.includes('const workspaceOpenFiles = useWorkspaceOpenFiles()') &&
      workspaceSource.includes('const openWorkspaceFile = workspaceOpenFiles.activeFile') &&
      workspaceSource.includes('const openWorkspaceFiles = workspaceOpenFiles.files') &&
      !workspaceSource.includes('const [openWorkspaceFile') &&
      !workspaceSource.includes('const [openWorkspaceFiles') &&
      workspaceSource.includes('setMainPaneMode(\'editor\')') &&
      workspaceSource.includes('setMainPaneMode(\'terminal\')') &&
	      workspaceSource.includes('handleWorkspaceFileMove') &&
	      workspaceSource.includes('handleWorkspaceFileDelete') &&
	      !workspaceSource.includes('handleWorkspaceFileEvent') &&
	      !workspaceSource.includes('recentEditorMoveRef') &&
	      !workspaceSource.includes('matchesWorkspaceMoveEvent') &&
	      workspaceSource.includes('selectOpenWorkspaceFile') &&
	      workspaceSource.includes('WorkspaceFileOpenTarget') &&
	      workspaceSource.includes('workspaceFileCursorRequestRef') &&
	      workspaceSource.includes('workspaceFileRevealRequestRef') &&
	      workspaceSource.includes('workspaceFileSearchFocusRequestRef') &&
	      workspaceSource.includes('fileRevealRequest') &&
	      workspaceSource.includes('fileSearchFocusRequest') &&
	      workspaceSource.includes('projectFileSearchAgent') &&
	      workspaceSource.includes('return activeAgents.find(agent => !agent.isMain) ?? null') &&
	      workspaceSource.includes("event.key.toLowerCase() === 'p'") &&
	      workspaceSource.includes('focusWorkspaceFilesSearch(projectFileSearchAgent.id)') &&
	      workspaceSource.includes("window.addEventListener('keydown', handleKeyDown, true)") &&
	      workspaceSource.includes('revealWorkspaceFileInExplorer') &&
	      workspaceSource.includes('setSidebarCollapsed(false)') &&
	      workspaceSource.includes('focusWorkspaceFilesSearch') &&
	      workspaceSource.includes('setFileRevealRequest({') &&
	      workspaceSource.includes('setFileSearchFocusRequest({') &&
	      workspaceSource.includes('const createWorkspaceOpenFileRequest = useCallback') &&
	      workspaceSource.includes('workspaceOpenFileRequestForTarget(target, {') &&
	      workspaceSource.includes('closeOpenWorkspaceFile') &&
	      workspaceSource.includes('closeOpenWorkspaceFiles') &&
	      !workspaceSource.includes('closedWorkspaceFileCacheRef') &&
	      !workspaceSource.includes('workspaceFileCursorForTarget') &&
	      !workspaceSource.includes('workspaceFileDiffRequestForTarget') &&
	      !workspaceSource.includes('workspaceFileDiffOnlyForTarget') &&
	      workspaceSource.includes('workspaceFileDiffRequestRef') &&
	      workspaceSource.includes('workspaceOpenFiles.openFromRead(agentId, file, openRequest)') &&
	      workspaceSource.includes('workspaceOpenFiles.select(agentId, filePath, openRequest)') &&
	      workspaceSource.includes('workspaceOpenFiles.close(targets)') &&
	      workspaceSource.includes('workspaceOpenFiles.update(nextFile)') &&
	      workspaceSource.includes('workspaceOpenFiles.updateDraft(nextDraft)') &&
	      workspaceSource.includes('workspaceOpenFiles.move(agentId, moves)') &&
	      workspaceSource.includes('workspaceOpenFiles.deleteEntries(agentId, deletions)') &&
	      workspaceSource.includes('workspaceOpenFiles.closedFiles') &&
	      openFilesHookSource.includes('export function useWorkspaceOpenFiles') &&
	      openFilesHookSource.includes('const stateRef = useRef(state)') &&
	      openFilesHookSource.includes('openWorkspaceFileFromRead(stateRef.current, agentId, file, options)') &&
	      openFilesHookSource.includes('selectWorkspaceOpenFile(stateRef.current, agentId, filePath, options)') &&
	      openFilesHookSource.includes('closeWorkspaceOpenFiles(stateRef.current, targets)') &&
	      openFilesHookSource.includes('updateWorkspaceOpenFile(stateRef.current, nextFile)') &&
	      openFilesHookSource.includes('updateWorkspaceOpenFileDraft(activeFile, nextDraft)') &&
	      openFilesHookSource.includes('moveWorkspaceOpenFiles(stateRef.current, agentId, moves)') &&
	      openFilesHookSource.includes('deleteWorkspaceOpenFiles(stateRef.current, agentId, deletions)') &&
	      openFilesHookSource.includes('Array.from(state.closedFileCache.values())') &&
	      openFilesSource.includes('workspaceFileCacheKey') &&
	      openFilesSource.includes('interface WorkspaceFileCursor') &&
	      openFilesSource.includes('function refreshOpenWorkspaceFileFromRead') &&
	      openFilesSource.includes('const existingFile = findOpenWorkspaceFile(state.files, agentId, file.path)') &&
	      openFilesSource.includes('refreshOpenWorkspaceFileFromRead(existingFile, file)') &&
	      openFilesSource.includes("view?: 'editor' | 'diff'") &&
	      openFilesSource.includes('function workspaceOpenFileRequestForTarget') &&
	      openFilesSource.includes('cursor: workspaceFileCursorForTarget(target, requestIds.cursorRequestId)') &&
	      openFilesSource.includes('workspaceFileDiffRequestForTarget') &&
	      openFilesSource.includes('workspaceFileDiffOnlyForTarget') &&
	      openFilesSource.includes('export interface WorkspaceOpenFileRequest') &&
	      openFilesSource.includes('type WorkspaceOpenFileRequestInput = WorkspaceOpenFileRequest | WorkspaceFileCursor') &&
	      openFilesSource.includes('function normalizeWorkspaceOpenFileRequest') &&
	      openFilesSource.includes('diffOnly: request.diffOnly === true') &&
	      openFilesSource.includes('cachedFile.draft !== file.content') &&
	      openFilesSource.includes('if (file.dirty)') &&
	      openFilesSource.includes('const targetKeys = new Set') &&
	      workspaceSource.includes('onCloseOpenWorkspaceFiles={closeOpenWorkspaceFiles}') &&
	      openFilesSource.includes('closedFileCache.delete(workspaceFileCacheKey(nextFile.agentId, nextFile.file.path))') &&
	      openFilesSource.includes('applyWorkspaceFileMovesToOpenFileCache') &&
	      openFilesSource.includes('removeWorkspaceFileDeletionsFromOpenFileCache') &&
	      workspaceSource.includes('editorFileStateByAgent') &&
	      operationSource.includes('const nextCache = new Map<string, T>()') &&
	      workspaceSource.includes('const projectFileAgent = project.agents.find(agent => !agent.isMain) ?? null') &&
	      workspaceSource.includes('const showProjectFiles = project.id !== MAIN_AGENT_PROJECT_ID && projectFileAgent !== null') &&
	      workspaceSource.includes('{showProjectFiles && projectFileAgent && (') &&
	      workspaceSource.includes('revealRequest={fileRevealRequest?.agentId === projectFileAgent.id ? fileRevealRequest : undefined}') &&
	      workspaceSource.includes('focusSearchRequest={fileSearchFocusRequest?.agentId === projectFileAgent.id ? fileSearchFocusRequest : undefined}') &&
	      workspaceSource.includes('editorDirtyFilePaths={editorFileStateByAgent.dirty.get(projectFileAgent.id)}') &&
	      workspaceSource.includes('editorExternalChangedFilePaths={editorFileStateByAgent.externalChanged.get(projectFileAgent.id)}') &&
	      workspaceSource.includes('className="code-project-expanded"') &&
	      !workspaceSource.includes('recentEditorSaveRef') &&
	      !workspaceSource.includes('watchWorkspaceFiles={watchWorkspaceFiles}') &&
	      workspaceSource.includes('onOpenProjectFile={openProjectFile}') &&
	      workspaceSource.includes('onMoveWorkspaceEntries={handleWorkspaceFileMove}') &&
	      workspaceSource.includes('onDeleteWorkspaceEntries={handleWorkspaceFileDelete}') &&
	      workspaceSource.includes('openFiles={openWorkspaceFiles}') &&
	      workspaceSource.includes('onRevealWorkspaceFileInExplorer={revealWorkspaceFileInExplorer}') &&
	      workspaceSource.includes('onFocusWorkspaceFilesSearch={focusWorkspaceFilesSearch}') &&
	      workspaceSource.includes('onRevealInExplorer={onRevealWorkspaceFileInExplorer}') &&
	      workspaceSource.includes('onFocusFilesSearch={onFocusWorkspaceFilesSearch}') &&
	      workspaceSource.includes('const openTerminalPathTarget = useCallback') &&
	      workspaceSource.includes('function terminalTargetFilePath') &&
	      workspaceSource.includes('function relativePathInsideWorkspace') &&
	      workspaceSource.includes('workspaceHomeRoot(workspaceRoot)') &&
	      workspaceSource.includes('activeAgents.find(candidate => candidate.id === agentId)') &&
	      workspaceSource.includes('terminalTargetFilePath(target.path, agent ? projectWorkspaceForAgent(agent) : \'\')') &&
	      workspaceSource.includes('fetchWorkspaceFile') &&
	      workspaceSource.includes('searchWorkspaceFiles') &&
	      workspaceSource.includes('TERMINAL_PATH_SEARCH_LIMIT') &&
	      workspaceSource.includes('uniqueTerminalPathSearchMatches(results.matches)') &&
	      workspaceSource.includes('const openResolvedFile = async (resolvedPath: string, resolvedTarget = openTarget)') &&
	      workspaceSource.includes('openProjectFile(agentId, file, resolvedTarget)') &&
	      workspaceSource.includes('focusWorkspaceFilesSearch(agentId, filePath)') &&
	      !workspaceSource.includes('focusWorkspaceFilesSearch(agentId, `${filePath}${lineSuffix}`)') &&
	      workspaceSource.includes('onBackToAgentFromFile={backToAgentFromFile}') &&
	      workspaceSource.includes('onOpenTerminalPath={openTerminalPathTarget}'),
    'CodeWorkspace should mount the Project Files section, keep lightweight editor tabs, and switch the right pane between terminal and editor modes'
  );

  assert(
    !appSource.includes('watchWorkspaceFiles={ws.watchWorkspaceFiles}'),
    'App should keep Project Files on a no-background-watch path by default'
  );

  assert(
    terminalLinksSource.includes('export interface TerminalPathOpenTarget') &&
	      terminalPoolSource.includes('onPathOpen?: (agentId: string, target: TerminalPathOpenTarget) => void') &&
	      terminalLinksSource.includes('function parseTerminalPathTargetAtColumn') &&
	      terminalPoolSource.includes('function readDomTerminalLineAtMouseEvent') &&
	      terminalPoolSource.includes("target.closest<HTMLElement>('.xterm-rows > div')") &&
	      terminalPoolSource.includes('function findTerminalPathTargetAtMouseEvent') &&
      terminalLinksSource.includes('const TERMINAL_URL_PATTERN') &&
      terminalLinksSource.includes('function parseTerminalUrlAtColumn') &&
      terminalPoolSource.includes('function findTerminalUrlAtMouseEvent') &&
      terminalPoolSource.includes("window.open(url, '_blank', 'noopener,noreferrer')") &&
      terminalLinksSource.includes('isLikelyTerminalPathTarget(filePath)') &&
      terminalLinksSource.includes('(?:\\/|~\\/|\\.{1,2}\\/)?') &&
      terminalPoolSource.includes('while (logicalStartRow > 0 && buffer.getLine(logicalStartRow)?.isWrapped)') &&
      terminalPoolSource.includes('while (buffer.getLine(logicalEndRow + 1)?.isWrapped)') &&
      terminalPoolSource.includes('const logicalCol = ((bufferRow - logicalStartRow) * cols) + cell.col') &&
      terminalPoolSource.includes('getTerminalVisibleBufferBase(record.terminal) + cell.row') &&
      terminalPoolSource.includes("hostEl.addEventListener('click', clickHandler, true)") &&
	      terminalPoolSource.includes('function isTerminalPathOpenClick(event: MouseEvent)') &&
			      terminalPoolSource.includes('function isTerminalOpenModifierActive') &&
			      terminalPoolSource.includes('return isTerminalOpenModifierEvent(event) || record.openModifierActive') &&
			      terminalPoolSource.includes('const openTerminalClickTarget = (event: MouseEvent | PointerEvent)') &&
			      terminalPoolSource.includes('openTerminalClickTarget(event)') &&
			      terminalPoolSource.includes('record.suppressClickUntil = Date.now() + 250') &&
			      terminalPoolSource.includes('const modifierActive = isTerminalOpenModifierActive(record, event)') &&
			      terminalPoolSource.includes('const url = event.button === 0 && modifierActive ? findTerminalUrlAtMouseEvent(record, event) : null') &&
			      terminalPoolSource.includes('openTerminalUrl(url)') &&
			      terminalPoolSource.includes('const pathDirectOpen = match.kind === \'path\' && Boolean(match.pathTarget && record.pathOpenHandler)') &&
				      terminalPoolSource.includes('pointerCursor: pathDirectOpen') &&
				      terminalPoolSource.includes('underline: pathDirectOpen') &&
				      terminalPoolSource.includes("setTerminalLinkDecorations(link, pathDirectOpen)") &&
				      terminalPoolSource.includes('const mouseDownOpenTargetHandler = (event: MouseEvent) =>') &&
				      terminalPoolSource.includes('record.openTargetMouseDown = {') &&
				      terminalPoolSource.includes('Math.hypot(event.clientX - mouseDown.x, event.clientY - mouseDown.y) > 4') &&
				      terminalPoolSource.includes("hostEl.addEventListener('mouseup', mouseUpOpenTargetHandler, true)") &&
			      terminalPoolSource.includes('record.pathOpenHandler && isTerminalPathOpenClick(event)') &&
			      terminalPoolSource.includes('if (record.pathOpenHandler && event.button === 0)') &&
	      terminalPoolSource.includes("hostEl.addEventListener('contextmenu', contextMenuHandler, true)") &&
	      terminalPoolSource.includes('record.pathOpenHandler(agentId, pathTarget)') &&
	      terminalPoolSource.includes('event.stopImmediatePropagation()') &&
      terminalPoolSource.includes('stableTerminalScrollbarOpacity(scrollbarOpacity)') &&
      terminalPoolSource.includes('record.pathOpenHandler = options.onPathOpen ?? null') &&
      terminalPoolSource.includes('record.pathOpenHandler = null') &&
      pooledTerminalHookSource.includes('onPathOpen?: (agentId: string, target: TerminalPathOpenTarget) => void') &&
      pooledTerminalHookSource.includes('onPathOpen,') &&
      terminalPaneSource.includes('onOpenPath?: (agentId: string, target: TerminalPathOpenTarget) => void') &&
      terminalPaneSource.includes('onPathOpen: onOpenPath') &&
      workspaceSource.includes('onOpenTerminalPath: (agentId: string, target: TerminalPathOpenTarget) => void') &&
      workspaceSource.includes('onOpenPath={onOpenTerminalPath}'),
    'Terminal canvas clicks should recognize relative path:line targets and route them into the Project file editor'
  );

  const projectFilesSectionDelegates =
      fileSectionSource.includes('useWorkspaceFileExplorer') &&
      fileSectionSource.includes('useProjectFilesSectionViewModel({') &&
      fileSectionSource.includes('<FileSectionBody {...viewModel.sectionBody} />') &&
      fileSectionViewModelSource.includes('const bodyTree: FileSectionBodyTree = useMemo(() => ({') &&
      explorerHookSource.includes('useWorkspaceFiles') &&
      fileTreeSurfaceSource.includes("from 'react-arborist'") &&
      fileOperationControllerSource.includes('createWorkspaceEntry') &&
      fileOperationControllerSource.includes('renameWorkspaceEntry') &&
      fileOperationControllerSource.includes('deleteWorkspaceEntry') &&
      fileOperationControllerSource.includes('onWorkspaceChange?.()') &&
      !fileSectionSource.includes('createWorkspaceEntry') &&
      !fileSectionSource.includes('renameWorkspaceEntry') &&
      !fileSectionSource.includes('deleteWorkspaceEntry') &&
      fileSectionSource.includes('useWorkspaceFileSearch') &&
      !fileSectionSource.includes('useWorkspaceFileChangesController') &&
      !fileSectionSource.includes('<FileChangesSection') &&
      !fileSectionSource.includes('onWorkspaceChange: refreshFileChanges') &&
      !fileSectionSource.includes('const openFileDirtyStateRef = useRef(new Map<string, boolean>())') &&
      !fileSectionSource.includes("diffOnly: change.gitStatus === 'deleted'") &&
      openFilesSource.includes('function workspaceFileOpenTargetForChange') &&
      openFilesSource.includes("diffOnly: change.gitStatus === 'deleted'") &&
      openFilesSource.includes('function workspaceOpenFileDirtyStateForAgent') &&
      openFilesSource.includes('function shouldRefreshWorkspaceChangesAfterDirtyStateChange') &&
      openFilesSource.includes('function workspaceFileChangePathLabel') &&
      openFilesSource.includes('function workspaceFileChangeRowKey') &&
      openFilesSource.includes('function workspaceFileChangeTitle') &&
      openFilesSource.includes('function deletedWorkspaceDiffPlaceholderFile') &&
      openFilesSource.includes('function shouldOpenMissingWorkspaceFileAsDiff') &&
      openFilesSource.includes('function shouldRevealSelectedWorkspaceOpenFile') &&
      fileOpenControllerSource.includes('deletedWorkspaceDiffPlaceholderFile') &&
      fileOpenControllerSource.includes('shouldOpenMissingWorkspaceFileAsDiff') &&
      fileOpenControllerSource.includes('shouldRevealSelectedWorkspaceOpenFile') &&
      !fileOpenControllerSource.includes('function deletedDiffPlaceholderFile') &&
      !fileOpenControllerSource.includes('function shouldOpenMissingFileAsDiff') &&
      !fileOpenControllerSource.includes('function shouldRevealSelectedOpenFile') &&
      openFilesSource.includes("target?.gitStatus !== 'deleted'") &&
      fileOpenControllerSource.includes('onSelectOpenFile?.(agentId, filePath, target)') &&
      fileOpenControllerSource.includes('if (shouldRevealSelectedWorkspaceOpenFile(target)) void onRevealFilePath(filePath)') &&
	      fileOpenControllerSource.includes('onClearSearch()') &&
	      fileSectionSource.includes('onSelectOpenFile,') &&
	      fileOpenControllerSource.includes('error instanceof WorkspaceFileApiError && error.status === 404') &&
	      fileSearchHookSource.includes('searchWorkspaceFiles') &&
	      fileSearchHookSource.includes('parseWorkspaceFileJumpQuery') &&
	      fileSearchSource.includes('function parseWorkspaceFileJumpQuery') &&
	      fileSearchSource.includes('function targetForWorkspaceFileSearchMatch') &&
	      fileSearchSource.includes('function openRequestForWorkspaceFileJumpQuery') &&
	      fileSearchSource.includes('function openRequestForWorkspaceFileSearchMatch') &&
	      fileSearchSource.includes('function workspaceFileSearchActiveOptionId') &&
	      fileSearchControllerHookSource.includes('openRequestForWorkspaceFileJumpQuery') &&
	      fileSearchControllerHookSource.includes('openRequestForWorkspaceFileSearchMatch') &&
	      fileSearchControllerHookSource.includes('workspaceFileSearchActiveOptionId') &&
	      fileSectionSource.includes('const clearFileSearch = fileSearch.clear') &&
	      fileSectionControllerHookSource.includes('clearFileSearch()') &&
	      !fileSectionSource.includes('clearFileSearch()') &&
	      fileSearchResultsSource.includes('function renderSearchText') &&
	      fileSearchResultsSource.includes('function renderSearchPath') &&
	      !fileSectionSource.includes('function renderSearchText') &&
	      !fileSectionSource.includes('function renderSearchPath') &&
	      fileSearchSource.includes('FUZZY_PATH_HIGHLIGHT_LIMIT = 6') &&
	      fileSearchSource.includes('function fuzzyTextRanges') &&
	      fileSearchSource.includes('function isPathWordBoundary') &&
	      fileSearchSource.includes('function fuzzyPathTextRanges') &&
	      fileSearchResultsSource.includes('pathSearchTextRanges(pathText, query)') &&
	      fileSectionSource.includes('function safeDomIdPart') &&
	      fileSearchResultsSource.includes('code-file-search-highlight') &&
	      fileSectionSource.includes('const fileSearchListboxId = `code-file-search-results-${safeDomIdPart(projectId)}`') &&
	      !fileSearchControllerHookSource.includes('const activeOptionId = fileSearch.active') &&
	      fileSectionHeaderSource.includes('aria-activedescendant={search.activeOptionId}') &&
	      fileSectionHeaderSource.includes('aria-controls={search.active ? search.listboxId : undefined}') &&
	      fileSectionHeaderSource.includes('role="combobox"') &&
	      fileSectionHeaderSource.includes('export interface FileSectionHeaderSearch') &&
	      fileSectionBodySource.includes('export interface FileSectionBodySearch') &&
	      fileSectionBodySource.includes('export interface FileSectionBodySearchActions') &&
	      fileSectionViewModelSource.includes('const headerSearch: FileSectionHeaderSearch = useMemo(() => ({') &&
	      fileSectionViewModelSource.includes('const bodySearch: FileSectionBodySearch = useMemo(() => ({') &&
	      fileSectionViewModelSource.includes('const bodySearchActions: FileSectionBodySearchActions = useMemo(() => ({') &&
	      fileSectionViewModelSource.includes('activeOptionId: activeSearchOptionId') &&
	      fileSectionSource.includes('onSelectSearchMatchIndex: fileSearch.selectMatchIndex') &&
	      !fileSectionSource.includes('fileSearch.setSelectionIndex') &&
	      !fileSearchHookSource.includes('setSelectionIndex,') &&
	      fileSectionViewModelSource.includes('search: headerSearch') &&
	      fileSectionViewModelSource.includes('search: bodySearch') &&
	      fileSectionViewModelSource.includes('searchActions: bodySearchActions') &&
		      fileSectionBodySource.includes('<FileSearchResults') &&
		      fileSectionBodySource.includes('containerRef={search.resultsRef}') &&
		      fileSectionBodySource.includes('onOpenMatch={searchActions.onOpenMatch}') &&
		      !fileSectionSource.includes('<FileSearchResults') &&
	      fileSearchResultsSource.includes('role="listbox"') &&
	      fileSearchResultsSource.includes('role="option"') &&
	      fileSearchResultsSource.includes('aria-selected={index === activeMatchIndex}') &&
	      fileSearchResultsSource.includes('aria-selected="true"') &&
	      fileSectionSource.includes('const fileSearchResultsRef = useRef<HTMLDivElement | null>(null)') &&
	      fileSearchControllerHookSource.includes("querySelector<HTMLElement>('.code-file-search-result.active')") &&
	      fileSearchControllerHookSource.includes("scrollIntoView({ block: 'nearest' })") &&
	      fileSearchResultsSource.includes('onMouseMove={() => onSelectMatchIndex(index)}') &&
	      !fileSearchResultsSource.includes('onMouseEnter={() => onSelectMatchIndex(index)}') &&
	      fileSearchResultsSource.includes('<FileSearchResultPath path={match.path} query={query} />') &&
	      fileSearchResultsSource.includes('renderSearchText(match.lines, match.ranges)') &&
	      fileSearchResultsSource.includes("match.kind === 'path'") &&
	      fileSearchResultsSource.includes('<span className="code-file-search-kind">{copy.file}</span>') &&
	      fileSearchResultsSource.includes('matches.length === 0') &&
	      fileSearchResultsSource.includes('copy.searchIncomplete') &&
	      codeCopySource.includes('searchIncomplete:') &&
      fileFocusHookSource.includes('ancestorDirectories') &&
      fileSectionSource.includes('revealFilePath') &&
      explorerHookSource.includes('const loadMissingDirectories = useCallback') &&
      explorerHookSource.includes('const missingDirectories = directoryPaths.filter(directoryPath => !directories[directoryPath])') &&
	      fileFocusHookSource.includes("await loadMissingDirectories(['', ...ancestors])") &&
      !fileSectionSource.includes('await Promise.all(ancestors.map(directoryPath => loadDirectory(directoryPath)))') &&
      fileSectionSource.includes('revealRequest?: { path: string; kind: \'directory\' | \'file\'; requestId: number }') &&
	      fileSectionSource.includes('focusSearchRequest?: { requestId: number; query?: string }') &&
	      fileSectionSource.includes('openFiles?: OpenProjectFileSummary[]') &&
	      openEditorsSectionSource.includes('export interface OpenProjectFileSummary') &&
		      fileSectionControllerHookSource.includes('const [openEditorsCollapsed, setOpenEditorsCollapsed] = useState(true)') &&
		      fileSectionControllerHookSource.includes('const toggleOpenEditorsCollapsed = useCallback') &&
		      !fileSectionSource.includes('const [openEditorsCollapsed, setOpenEditorsCollapsed] = useState(true)') &&
		      !fileSectionSource.includes('const toggleOpenEditorsCollapsed = useCallback') &&
	      fileSectionSource.includes('<OpenEditorsSection') &&
	      fileSectionSource.includes('files={openFiles}') &&
	      fileSectionSource.includes('{...viewModel.openEditors}') &&
	      fileSectionViewModelSource.includes('collapsed: openEditorsCollapsed') &&
	      fileSectionViewModelSource.includes('onToggleCollapsed: onToggleOpenEditorsCollapsed') &&
	      !fileSectionSource.includes('className={`code-open-editors ${openEditorsCollapsed ? \'collapsed\' : \'\'}`}') &&
	      openEditorsSectionSource.includes('className={`code-open-editors ${collapsed ? \'collapsed\' : \'\'}`}') &&
	      workingCopySource.includes('function workspaceWorkingCopyChangeIndicator') &&
	      openEditorsSectionSource.includes('workspaceWorkingCopyChangeIndicator(file)') &&
	      !openEditorsSectionSource.includes('file.externalChanged ? \'external\' : \'dirty\'') &&
	      openEditorsSectionSource.includes('className="code-open-editors-header"') &&
	      openEditorsSectionSource.includes('aria-expanded={!collapsed}') &&
	      openEditorsSectionSource.includes('{!collapsed && (') &&
	      treeModelSource.includes('displayName: compactedNames.join') &&
	      treeModelSource.includes('function findVisibleWorkspaceTreePath') &&
	      fileFocusHookSource.includes('findVisibleWorkspaceTreePath') &&
	      !fileSectionSource.includes('findVisibleWorkspaceTreePath') &&
	      fileSectionSource.includes('useWorkspaceFileFocus({') &&
	      fileSectionSource.includes('cancelPendingFileFocus,') &&
	      fileSectionSource.includes('focusFileSearchInput,') &&
	      fileSectionSource.includes('focusFileTreeFromSearch,') &&
	      fileSectionSource.includes('focusFileTreePath,') &&
	      fileSectionSource.includes('focusFileTreeTarget,') &&
	      fileSectionSource.includes('revealExplorerPath,') &&
	      fileSectionSource.includes('revealFilePath,') &&
	      fileFocusHookSource.includes('const focusFileSearchInput = useCallback') &&
	      fileFocusHookSource.includes('const cancelPendingFileSearchFocus = useCallback') &&
	      fileFocusHookSource.includes('const cancelPendingFileTreeFocus = useCallback') &&
	      fileFocusHookSource.includes('const cancelPendingFileFocus = useCallback') &&
	      !fileSectionSource.includes('const focusFileSearchInput = useCallback') &&
	      !fileSectionSource.includes('const cancelPendingFileSearchFocus = useCallback') &&
	      !fileSectionSource.includes('const cancelPendingFileTreeFocus = useCallback') &&
	      fileFocusHookSource.includes('shouldSkipWorkspaceFileSearchFocus({') &&
	      !fileFocusHookSource.includes('if (document.activeElement === input && input.value) return') &&
	      fileFocusHookSource.includes('const focusFileTreeFromSearch = useCallback') &&
	      fileFocusHookSource.includes('fileSearchInputRef.current?.blur()') &&
	      fileFocusHookSource.includes('function focusWithoutScrolling') &&
	      fileFocusHookSource.includes('focusWithoutScrolling(targetTree)') &&
	      fileFocusHookSource.includes('WORKSPACE_FILE_TREE_FOCUS_RETRY_DELAYS.forEach(queueFocusRetry)') &&
	      fileViewModelSource.includes('WORKSPACE_FILE_TREE_FOCUS_RETRY_DELAYS = [80, 180, 360]') &&
	      fileFocusHookSource.includes('input.select()') &&
	      fileSectionHeaderSource.includes('onFocus={onCancelPendingFileFocus}') &&
      fileSectionHeaderSource.includes('onPointerDown={onCancelPendingFileFocus}') &&
      fileSectionHeaderSource.includes('onMouseDown={onCancelPendingFileFocus}') &&
      fileSectionHeaderSource.includes('onKeyDownCapture={onFileSearchKeyDown}') &&
      !fileSectionHeaderSource.includes('onKeyDown={onFileSearchKeyDown}') &&
      fileSearchControllerHookSource.includes('focusFileTreeFromSearch()') &&
      fileSearchControllerHookSource.includes('const closeFileSearchOnEscape = (event: KeyboardEvent) =>') &&
      fileSearchControllerHookSource.includes("document.addEventListener('keydown', closeFileSearchOnEscape, true)") &&
      fileSearchControllerHookSource.includes("document.removeEventListener('keydown', closeFileSearchOnEscape, true)") &&
	      fileSectionControllerHookSource.includes('setFilesCollapsed(false)') &&
	      !fileSectionSource.includes('setFilesCollapsed(false)') &&
	      fileSectionSource.includes('revealExplorerPath') &&
      fileFocusHookSource.includes('openTargetDirectory') &&
      fileFocusHookSource.includes('const visibleTargetPath = findVisibleWorkspaceTreePath(treeData, filePath) ?? filePath') &&
      fileFocusHookSource.includes('if (openTargetDirectory) treeRef.current?.open(visibleTargetPath)') &&
	      fileSectionControllerHookSource.includes('void revealExplorerPath(revealRequest.path, revealRequest.kind)') &&
	      !fileSectionSource.includes('void revealExplorerPath(revealRequest.path, revealRequest.kind)') &&
      fileFocusHookSource.includes('if (focusRow) treeRef.current?.get(filePath)?.select()') &&
      fileSectionSource.includes('const fileOperationActiveRef = useRef(false)') &&
      fileFocusHookSource.includes('shouldFocusWorkspaceFileTree({') &&
      fileFocusHookSource.includes('shouldSkipWorkspaceFileSearchFocus({') &&
      fileFocusHookSource.includes('shouldSelectWorkspaceFileSearchText({') &&
      fileFocusHookSource.includes('workspaceFileTreeFocusTargetPath({') &&
      fileViewModelSource.includes('function shouldFocusWorkspaceFileTree') &&
      fileViewModelSource.includes('function shouldSkipWorkspaceFileSearchFocus') &&
      fileViewModelSource.includes('function shouldSelectWorkspaceFileSearchText') &&
      fileViewModelSource.includes('function workspaceFileTreeFocusTargetPath') &&
      fileFocusHookSource.includes("if (shouldFocusTree) focusWithoutScrolling(row.closest<HTMLElement>('[role=\"tree\"]'))") &&
      fileFocusHookSource.includes('scrollFileTreeToPath(visibleTargetPath, true)') &&
	      fileFocusHookSource.includes('treeRef.current?.open(directoryPath)') &&
			      fileTreeControllerHookSource.includes('if (nextOpen) {') &&
			      !fileSectionSource.includes('if (nextOpen) {') &&
		      fileTreeRowInteractionsSource.includes('void onHydrateCompactDirectoryChains(item.path).finally(onRefreshTreeLayout)') &&
	      fileTreeKeyboardHookSource.includes('const openDirectoryNode = useCallback') &&
	      fileTreeKeyboardHookSource.includes('const closeDirectoryNode = useCallback') &&
	      fileTreeKeyboardHookSource.includes('preserveWorkspaceFileScrollPosition(projectScroller())') &&
	      fileTreeKeyboardHookSource.includes('hydrateCompactDirectoryChains(node.data.path).finally(refreshTreeLayout)') &&
	      fileTreeKeyboardHookSource.includes('setDirectoryOpen(node.data.path, true)') &&
	      fileTreeKeyboardHookSource.includes('setDirectoryOpen(filePath, false)') &&
	      fileTreeKeyboardHookSource.includes('shouldCancelPendingWorkspaceFileTreeFocus(event.key)') &&
		      fileTreeKeyboardHookSource.includes('workspaceFileTreeKeyboardTargetPath({') &&
		      fileTreeKeyboardHookSource.includes('shouldCloseWorkspaceFileTreeDirectory({') &&
		      fileTreeKeyboardHookSource.includes('workspaceFileTreeActivationIntent({') &&
		      fileViewModelSource.includes('function shouldCancelPendingWorkspaceFileTreeFocus') &&
		      fileViewModelSource.includes('WORKSPACE_FILE_TREE_FOCUS_CANCEL_KEYS') &&
		      fileViewModelSource.includes('function workspaceFileTreeKeyboardTargetPath') &&
		      fileViewModelSource.includes('function shouldCloseWorkspaceFileTreeDirectory') &&
		      fileViewModelSource.includes('function workspaceFileTreeActivationIntent') &&
	      hookSource.includes('if (!directory || directory.loading || directory.error)') &&
	      hookSource.includes('return loadDirectory(normalizedPath)') &&
	      hookSource.includes('return Promise.resolve({') &&
	      hookSource.includes('items: directory.items') &&
      fileSearchControllerHookSource.includes('openFileSearchMatch') &&
      fileSearchControllerHookSource.includes('openFileJumpQuery') &&
      !fileSearchControllerHookSource.includes('onSelectOpenFile') &&
      !fileSearchControllerHookSource.includes('agentId: string | null') &&
      fileSearchControllerHookSource.includes('handleFileSearchKeyDown') &&
      fileSearchHookSource.includes('WORKSPACE_FILE_SEARCH_LIMIT = 60') &&
      fileSearchHookSource.includes('limit: WORKSPACE_FILE_SEARCH_LIMIT') &&
		      fileTreeViewSource.includes('<Tree<FileExplorerNode>') &&
		      fileSectionBodySource.includes('<FileTreeView') &&
		      fileSectionSource.includes('<FileSectionBody') &&
		      fileSectionBodySource.includes("export type FileSectionBodyTree = Omit<FileTreeViewProps, 'copy'>") &&
		      fileSectionViewModelSource.includes('const bodyTree: FileSectionBodyTree = useMemo(() => ({') &&
		      fileSectionViewModelSource.includes('tree: bodyTree') &&
		      fileSectionBodySource.includes('tree: FileSectionBodyTree') &&
		      !fileSectionBodySource.includes('interface FileSectionBodyProps extends FileTreeViewProps') &&
		      !fileSectionBodySource.includes('...treeViewProps') &&
		      !fileSectionSource.includes('<FileTreeView') &&
	      !fileSectionSource.includes('<Tree<FileExplorerNode>') &&
      explorerHookSource.includes('buildWorkspaceFileTreeNodes') &&
      treeModelSource.includes('function buildWorkspaceFileTreeNodes') &&
      treeModelSource.includes('iconPath: compactedPaths[0] ?? visibleEntry.path') &&
      treeModelSource.includes('iconSignals: directoryIconSignals(visibleEntry.path, directories, iconSignalCache)') &&
      fileSectionSource.includes('editorDirtyFilePaths?: ReadonlySet<string>') &&
	      fileSectionSource.includes('editorExternalChangedFilePaths?: ReadonlySet<string>') &&
	      treeRowModelSource.includes('function hasWorkspaceFileTreeDescendant') &&
	      fileOpenControllerSource.includes('const fileOpenRequestRef = useRef(0)') &&
	      fileOpenControllerSource.includes('const requestId = fileOpenRequestRef.current + 1') &&
	      fileOpenControllerSource.includes('if (fileOpenRequestRef.current !== requestId) return') &&
		      fileTreeControllerHookSource.includes('const renderFileTreeRow = useCallback') &&
		      !fileSectionSource.includes('const renderFileTreeRow = useCallback') &&
		      fileTreeViewSource.includes('renderRow={renderFileTreeRow}') &&
		      !fileSectionSource.includes('renderRow={renderFileTreeRow}') &&
		      fileTreeControllerHookSource.includes("minWidth: '100%'") &&
		      !fileSectionSource.includes("minWidth: '100%'") &&
      fileTreeViewSource.includes('overscanCount={visibleTreeRowCount}') &&
      !fileSectionSource.includes('overscanCount={visibleTreeRowCount}') &&
      !fileSectionSource.includes('selection={activeFilePath}') &&
      !fileSectionSource.includes('FILE_TREE_FALLBACK_HEIGHT') &&
      !fileSectionSource.includes('function useMeasuredHeight') &&
      treeModelSource.includes('function countVisibleWorkspaceTreeRows') &&
      explorerHookSource.includes('const [openDirectoryPaths, setOpenDirectoryPaths] = useState<Set<string>>(() => new Set())') &&
      !fileSectionSource.includes('const [openDirectoryPaths, setOpenDirectoryPaths] = useState<Set<string>>(() => new Set())') &&
      !fileSectionSource.includes('treeVisibleRowCount') &&
      !fileSectionSource.includes('setTreeVisibleRowCount') &&
      !fileSectionSource.includes('treeMeasuredRowCount') &&
      !fileSectionSource.includes('setTreeMeasuredRowCount') &&
      !fileSectionSource.includes('fallbackVisibleTreeRowCount') &&
      explorerHookSource.includes('const visibleTreeRowCount = useMemo(() =>') &&
      explorerHookSource.includes('countVisibleWorkspaceTreeRows(treeData, openDirectoryPaths)') &&
	      fileTreeControllerHookSource.includes('const treeHeight = Math.max(rowHeight, visibleTreeRowCount * rowHeight)') &&
	      !fileSectionSource.includes('const treeHeight = Math.max(FILE_ROW_HEIGHT, visibleTreeRowCount * FILE_ROW_HEIGHT)') &&
	      fileTreeControllerHookSource.includes('const syncTreeStateFromArborist = useCallback') &&
	      !fileSectionSource.includes('const syncTreeStateFromArborist = useCallback') &&
	      fileTreeViewSource.includes('data-visible-row-count={visibleTreeRowCount}') &&
	      fileTreeViewSource.includes('style={{ height: treeHeight }}') &&
	      !fileSectionSource.includes('data-visible-row-count={visibleTreeRowCount}') &&
      explorerHookSource.includes('const setDirectoryOpen = useCallback') &&
      explorerHookSource.includes('const openDirectoriesInLayout = useCallback') &&
	      fileTreeControllerHookSource.includes('const rememberFocusedTreeNode = useCallback') &&
	      fileTreeControllerHookSource.includes('const rememberSelectedTreeNodes = useCallback') &&
	      fileTreeControllerHookSource.includes('lastFocusedFilePathRef.current = lastNode.data.path') &&
	      !fileSectionSource.includes('const rememberFocusedTreeNode = useCallback') &&
	      !fileSectionSource.includes('const rememberSelectedTreeNodes = useCallback') &&
	      fileTreeRowInteractionsSource.includes('workspaceFileTreeRowClickIntent({') &&
	      fileViewModelSource.includes('function workspaceFileTreeRowClickIntent') &&
	      fileViewModelSource.includes("return 'toggle-directory'") &&
	      fileViewModelSource.includes("return 'open-file'") &&
	      !fileTreeRowInteractionsSource.includes('const plainClick = !event.metaKey && !event.ctrlKey && !event.shiftKey') &&
	      fileTreeRowInteractionsSource.includes('const nextOpen = !node.isOpen') &&
	      fileTreeRowInteractionsSource.includes('onSetDirectoryOpen(item.path, nextOpen)') &&
	      fileTreeControllerHookSource.includes('const refreshTreeLayout = useCallback') &&
	      !fileSectionSource.includes('const refreshTreeLayout = useCallback') &&
      fileFocusHookSource.includes('function revealRowInProjectScroller') &&
      fileFocusHookSource.includes("row.closest<HTMLElement>('.code-project-list')") &&
      fileFocusHookSource.includes('const scrollFileTreeToPath = useCallback') &&
      !fileSectionSource.includes('const scrollFileTreeToPath = useCallback') &&
	      fileFocusHookSource.includes("row.scrollIntoView({ block: 'nearest' })") &&
	      fileFocusHookSource.includes('revealRowInProjectScroller(row)') &&
	      !fileSectionSource.includes("treeRef.current?.scrollTo(filePath, 'center')") &&
	      !fileSectionSource.includes('scrollFileTreeToPath(activeFilePath)') &&
		      fileSectionSource.includes('useWorkspaceFileTreeKeyboard({') &&
		      fileSectionSource.includes('handleTreeKeyDownCapture') &&
		      fileTreeKeyboardHookSource.includes('const handleTreeKeyDownCapture = useCallback') &&
      fileTreeKeyboardHookSource.includes('targetElement?.closest(\'input, textarea, [contenteditable="true"], .code-file-inline-operation\')') &&
      fileTreeKeyboardHookSource.includes("event.key === 'ArrowRight'") &&
      fileTreeKeyboardHookSource.includes("event.key === 'ArrowDown' || event.key === 'ArrowUp'") &&
      fileTreeKeyboardHookSource.includes("const nextNode = event.key === 'ArrowDown' ? node.next : node.prev") &&
      fileTreeKeyboardHookSource.includes('lastFocusedFilePathRef.current = nextNode.data.path') &&
      fileSectionSource.includes('lastFocusedFilePathRef') &&
      fileTreeKeyboardHookSource.includes('const focusedNode = tree?.focusedNode && !tree.focusedNode.isRoot ? tree.focusedNode : null') &&
			      fileTreeKeyboardHookSource.includes("treeViewportRef.current?.querySelector<HTMLElement>('[data-file-path].selected')") &&
			      fileTreeKeyboardHookSource.includes('selectedPath: selectedRowState.path') &&
			      fileTreeKeyboardHookSource.includes('focusedPath: focusedNode?.data.path') &&
		      fileTreeKeyboardHookSource.includes('openDirectoryNode(node)') &&
		      fileTreeKeyboardHookSource.includes('node.open()') &&
		      fileTreeRowInteractionsSource.includes('treeRef.current?.open(item.path)') &&
		      fileTreeRowInteractionsSource.includes('treeRef.current?.close(item.path)') &&
	      fileTreeKeyboardHookSource.includes('firstChild.select()') &&
      fileTreeKeyboardHookSource.includes("event.key === 'ArrowLeft'") &&
	      fileTreeKeyboardHookSource.includes('closeDirectoryNode(node.data.path, node)') &&
	      fileTreeKeyboardHookSource.includes('treeRef.current?.close(filePath)') &&
	      fileTreeKeyboardHookSource.includes('node?.close()') &&
	      fileTreeKeyboardHookSource.includes('parent.select()') &&
      fileTreeKeyboardHookSource.includes('firstChild.focus()') &&
      fileTreeRowInteractionsSource.includes('onFocusFileTreeTarget(item)') &&
	      fileTreeKeyboardHookSource.includes("event.key !== 'Enter' && event.key !== ' '") &&
	      !fileTreeKeyboardHookSource.includes("if (node.data.type === 'file')") &&
	      fileTreeKeyboardHookSource.includes('tree?.focusedNode ?? tree?.mostRecentNode') &&
	      fileTreeKeyboardHookSource.includes('const closeSelectedOpenDirectory = (event: KeyboardEvent) =>') &&
	      fileTreeKeyboardHookSource.includes('closeDirectoryNode(filePath, node)') &&
	      !fileTreeKeyboardHookSource.includes('node.toggle()') &&
	      !fileTreeKeyboardHookSource.includes('setDirectoryOpen(node.data.path, nextOpen)') &&
	      fileTreeKeyboardHookSource.includes("window.addEventListener('keydown', closeSelectedOpenDirectory, true)") &&
      fileTreeKeyboardHookSource.includes("window.removeEventListener('keydown', closeSelectedOpenDirectory, true)") &&
      !fileSectionSource.includes('const closeSelectedOpenDirectory = (event: KeyboardEvent) =>') &&
      fileTreeViewSource.includes('onKeyDownCapture={handleTreeKeyDownCapture}') &&
      !fileSectionSource.includes('onKeyDownCapture={handleTreeKeyDownCapture}') &&
	      fileTreeControllerHookSource.includes('const handleTreeToggle = useCallback') &&
	      !fileSectionSource.includes('const handleTreeToggle = useCallback') &&
	      fileTreeViewSource.includes('onToggle={onToggleTreeNode}') &&
	      !fileSectionSource.includes('onToggle={handleTreeToggle}') &&
      fileTreeViewSource.includes('selectionFollowsFocus') &&
      fileTreeViewSource.includes('onFocus={onTreeFocus}') &&
      fileTreeViewSource.includes('onSelect={onTreeSelect}') &&
      !fileSectionSource.includes('selectionFollowsFocus') &&
      !fileSectionSource.includes('onFocus={rememberFocusedTreeNode}') &&
      !fileSectionSource.includes('onSelect={rememberSelectedTreeNodes}') &&
      fileSectionSource.includes('useWorkspaceFileStickyContext({') &&
      fileStickyContextHookSource.includes('const [stickyDirectoryPaths, setStickyDirectoryPaths] = useState<string[]>([])') &&
	      fileStickyContextHookSource.includes('const [stickyContextVisible, setStickyContextVisible] = useState(false)') &&
	      fileStickyContextHookSource.includes('const stickyDirectoryNodes = useMemo(() =>') &&
	      fileStickyContextHookSource.includes('const stickyContextItems = useMemo<FileStickyContextItem[]>') &&
	      fileStickyContextHookSource.includes('workspaceStickyContextItems({') &&
	      fileViewModelSource.includes('function workspaceStickyContextItems') &&
	      !fileStickyContextHookSource.includes("{ kind: 'open-editors' as const, key: '__open-editors', name: openEditorsLabel }") &&
	      !fileSectionSource.includes('shouldShowStickyProjectName') &&
	      treeModelSource.includes('function filePathDepth') &&
	      fileStickyContextHookSource.includes('function stickyContentTop') &&
	      fileStickyContextHookSource.includes("querySelector<HTMLElement>('.code-agents-section')") &&
	      treeModelSource.includes('function findWorkspaceFileTreeNode') &&
	      fileStickyContextHookSource.includes('findWorkspaceFileTreeNode') &&
      fileStickyContextHookSource.includes('const refreshStickyAncestors = useCallback') &&
      fileStickyContextHookSource.includes("viewport?.closest<HTMLElement>('.code-project-list')") &&
      fileStickyContextHookSource.includes('setStickyContextVisible(isWorkspaceStickyContextVisible(viewportRect.top, stickyTop))') &&
      fileStickyContextHookSource.includes('workspaceStickyDirectoryPaths(firstVisiblePath, rowSnapshots, stickyTop)') &&
      fileViewModelSource.includes('function firstVisibleWorkspaceFilePath') &&
      fileViewModelSource.includes('function workspaceStickyDirectoryPaths') &&
      fileStickyContextHookSource.includes('setStickyDirectoryPaths(current =>') &&
	      fileTreeViewSource.includes('<FileStickyContext') &&
	      !fileSectionSource.includes('<FileStickyContext') &&
      fileStickyContextSource.includes('data-testid="code-file-sticky-stack"') &&
      fileStickyContextSource.includes('className="code-file-row directory code-file-sticky-row"') &&
	      treeRowModelSource.includes('function workspaceFileTreeDescendantGitStatusClassName') &&
	      fileStickyContextSource.includes('workspaceFileTreeDescendantGitStatusClassName(item.node.descendantGitStatus)') &&
	      fileStickyContextSource.includes('className={descendantStatusClassName}') &&
	      fileStickyContextSource.includes("workspaceFileTreeStatusTitle('git', copy)") &&
	      !fileStickyContextSource.includes('title={copy.containsUncommittedChanges}') &&
	      !fileStickyContextSource.includes('visibleWorkspaceFileTreeGitStatus(item.node.descendantGitStatus)') &&
	      fileStickyContextSource.includes('code-file-sticky-context') &&
	      fileStickyContextSource.includes("item.kind === 'open-editors'") &&
	      fileStickyContextSource.includes('onToggleOpenEditors()') &&
	      fileStickyContextHookSource.includes('const revealOpenEditorsSection = useCallback') &&
	      fileStickyContextHookSource.includes("querySelector<HTMLElement>('[data-testid=\"code-open-editors\"]')") &&
	      fileStickyContextHookSource.includes('openEditorsRevealScrollDelta(section.getBoundingClientRect().top, stickyTop)') &&
	      fileViewModelSource.includes('function openEditorsRevealScrollDelta') &&
	      fileStickyContextSource.includes('onRevealOpenEditors()') &&
	      fileStickyContextSource.includes('onToggleFiles()') &&
      !workspaceSource.includes('projectName={project.name}') &&
      !fileSectionSource.includes('onToggleProject') &&
      !fileSectionSource.includes('refreshTreeScrollEdges') &&
      !fileSectionSource.includes('treeScrollEdges') &&
	      fileSectionControllerHookSource.includes('const [filesCollapsed, setFilesCollapsed]') &&
		      fileSectionControllerHookSource.includes('useState(true)') &&
		      fileSectionControllerHookSource.includes('const toggleFilesCollapsed = useCallback') &&
		      fileSectionControllerHookSource.includes('loadRootDirectory()') &&
		      fileSectionSource.includes('useWorkspaceFileSectionController({') &&
		      !fileSectionSource.includes('const [filesCollapsed, setFilesCollapsed]') &&
		      !fileSectionSource.includes('const toggleFilesCollapsed = useCallback') &&
		      explorerHookSource.includes("loadDirectory('')") &&
      !fileSectionSource.includes('function preloadFileEditorPane') &&
	      !fileSectionSource.includes("fileEditorPreloadPromise = import('./FileEditorPane')") &&
	      !fileSectionSource.includes('void preloadFileEditorPane()') &&
			      fileSectionControllerHookSource.includes('clearFileMenu()') &&
			      !fileSectionSource.includes('setFileMenu(null)') &&
			      fileSectionControllerHookSource.includes('clearFileOperation()') &&
		      !fileSectionSource.includes('setFileOperation(null)') &&
		      fileSectionControllerHookSource.includes('clearFileSearch()') &&
      fileSectionSource.includes('<FileSectionHeader') &&
      fileSectionHeaderSource.includes('className="code-files-title"') &&
      fileSectionHeaderSource.includes('aria-expanded={!filesCollapsed}') &&
      fileSectionSource.includes('{!filesCollapsed && (') &&
      fileTreeViewSource.includes('key={agentId}') &&
	      fileOperationControllerSource.includes('const fileOperationInputRef = useRef<HTMLInputElement | null>(null)') &&
	      fileSectionSource.includes('fileOperationInputRef,') &&
	      fileOperationModelSource.includes('function workspaceFileOperationSelectionEnd') &&
	      fileOperationModelSource.includes('function workspaceFileOperationSubmitName') &&
	      fileOperationModelSource.includes('function workspaceFileOperationTitle') &&
		      fileOperationModelSource.includes('function workspaceFileContextMenuPosition') &&
		      fileSectionSource.includes('useWorkspaceFileMenuController({') &&
		      fileMenuControllerSource.includes('workspaceFileContextMenuPosition') &&
		      fileMenuControllerSource.includes('workspaceFileOperationTargetDirectory') &&
		      fileMenuControllerSource.includes('navigator.clipboard?.writeText(item.path)') &&
		      fileMenuControllerSource.includes('const startFileMenuOperation = useCallback') &&
		      !fileSectionSource.includes('workspaceFileContextMenuPosition') &&
		      !fileSectionSource.includes('workspaceFileOperationTargetDirectory') &&
		      !fileSectionSource.includes('navigator.clipboard?.writeText(item.path)') &&
		      fileOperationControllerSource.includes('workspaceFileOperationSelectionEnd(fileOperation)') &&
		      !fileSectionSource.includes('workspaceFileOperationSelectionEnd(fileOperation)') &&
		      fileOperationControllerSource.includes('workspaceFileOperationSubmitName(operation)') &&
	      !fileSectionSource.includes('workspaceFileOperationSubmitName(operation)') &&
	      fileOperationDialogSource.includes('workspaceFileOperationTitle(fileOperation, copy)') &&
	      !fileSectionSource.includes('workspaceFileOperationTitle(fileOperation, copy)') &&
	      fileTreeRowSource.includes('const inlineRenameOperation = fileOperation?.kind === \'rename\'') &&
	      fileTreeRowSource.includes('<FileTreeInlineOperation') &&
	      fileTreeInlineOperationSource.includes('data-testid="code-file-inline-operation"') &&
	      fileTreeInlineOperationSource.includes('aria-label={copy.renameEntry(item.name)}') &&
      fileTreeInlineOperationSource.includes('autoComplete="new-password"') &&
      fileTreeInlineOperationSource.includes('aria-autocomplete="none"') &&
	      fileOperationDialogSource.includes("fileOperation.kind === 'rename'") &&
	      fileOperationModelSource.includes('name.endsWith(`${extension}${extension}`)') &&
      fileOperationModelSource.includes("operation.kind !== 'rename' || operation.item?.type !== 'file'") &&
      fileOperationModelSource.includes("const extensionIndex = operation.name.lastIndexOf('.')") &&
	      fileOperationControllerSource.includes('const closeInlineOperationOnEscape = (event: KeyboardEvent) =>') &&
	      !fileSectionSource.includes('const closeInlineOperationOnEscape = (event: KeyboardEvent) =>') &&
	      fileOperationControllerSource.includes('const selectInputName = () =>') &&
	      fileOperationControllerSource.includes('input.setSelectionRange(0, selectionEnd)') &&
	      fileOperationControllerSource.includes('window.setTimeout(selectInputName, 40)') &&
	      !fileSectionSource.includes('const selectInputName = () =>') &&
      fileTreeInlineOperationSource.includes('ref={inputRef}') &&
      !fileSectionSource.includes('startHeaderFileOperation') &&
      !fileSectionSource.includes('focusedOperationItem') &&
      !fileSectionSource.includes('refreshFileTreeRoot') &&
      !fileSectionSource.includes('collapseFileTree') &&
      !fileSectionSource.includes('aria-label="New file"') &&
      !fileSectionSource.includes('aria-label="Refresh files"') &&
      !fileSectionSource.includes('aria-label="Collapse folders"') &&
      !fileSectionSource.includes('MAX_STICKY_ANCESTORS') &&
	      fileTreeViewSource.includes('disableDrag') &&
	      fileTreeViewSource.includes('disableDrop') &&
	      !fileSectionSource.includes('disableDrag') &&
	      !fileSectionSource.includes('disableDrop') &&
	      !fileSectionSource.includes('moveWorkspaceEntry') &&
	      !fileSectionSource.includes('Promise.all(dragNodes.map') &&
	      !fileSectionSource.includes('onMove={handleTreeMove}') &&
		      fileOperationControllerSource.includes('onDeleteEntries(agentId, [deleted])') &&
		      !fileSectionSource.includes('onDeleteEntries(agentId, [deleted])') &&
	      fileTreeKeyboardHookSource.includes("event.key === 'ContextMenu'") &&
	      fileTreeKeyboardHookSource.includes("event.key === 'F2'") &&
		      fileTreeKeyboardHookSource.includes("event.key === 'Delete'") &&
	      !fileSectionSource.includes("event.key === 'ContextMenu'") &&
	      !fileSectionSource.includes("event.key === 'F2'") &&
		      fileTreeViewSource.includes('onContextMenu={handleViewportContextMenu}') &&
	      fileFocusHookSource.includes('const focusFileTreeTarget = useCallback') &&
		      fileFocusHookSource.includes('const focusFileTreePath = useCallback') &&
		      !fileSectionSource.includes('const focusFileTreeTarget = useCallback') &&
		      !fileSectionSource.includes('const focusFileTreePath = useCallback') &&
		      fileOperationControllerSource.includes('const targetItem = fileOperation?.item ?? null') &&
		      fileOperationControllerSource.includes('focusFileTreePath(targetItem?.path ?? null)') &&
		      fileOperationControllerSource.includes('focusFileTreePath(created.entry.path)') &&
	      fileOperationControllerSource.includes('focusFileTreePath(workspaceFileMoveFocusPath(move))') &&
	      fileOperationControllerSource.includes('focusFileTreePath(workspaceFileDeleteFocusPath(deleted))') &&
		      fileOperationControllerSource.includes('refreshDirectories(workspaceFileMoveRefreshDirectories(move))') &&
		      fileOperationControllerSource.includes('refreshDirectories(workspaceFileDeleteRefreshDirectories(deleted))') &&
		      !fileSectionSource.includes('workspaceFileMoveRefreshDirectories(move)') &&
		      !fileSectionSource.includes('workspaceFileDeleteRefreshDirectories(deleted)') &&
	      fileFocusHookSource.includes('treeRef.current?.get(filePath)?.select()') &&
	      fileFocusHookSource.includes("row?.closest<HTMLElement>('[role=\"tree\"]')") &&
	      fileViewModelSource.includes('function preserveWorkspaceFileScrollPosition') &&
	      fileTreeRowInteractionsSource.includes('preserveWorkspaceFileScrollPosition') &&
	      fileTreeControllerHookSource.includes('preserveWorkspaceFileScrollPosition') &&
	      fileTreeKeyboardHookSource.includes('preserveWorkspaceFileScrollPosition') &&
	      !fileSectionSource.includes('preserveWorkspaceFileScrollPosition') &&
      fileFocusHookSource.includes('focusWithoutScrolling(targetTree)') &&
      fileFocusHookSource.includes('window.setTimeout(focusTarget, 80)') &&
      fileFocusHookSource.includes('window.setTimeout(focusTarget, 180)') &&
      fileFocusHookSource.includes('window.setTimeout(focusTarget, 360)') &&
	      !fileSectionSource.includes('const closeFileMenu = useCallback') &&
	      fileMenuControllerSource.includes('const closeFileMenu = useCallback') &&
		      fileSectionBodySource.includes('<FileSectionOverlays') &&
		      fileSectionOverlaysSource.includes('<FileContextMenu') &&
		      fileSectionSource.includes('onStartFileMenuOperation: startFileMenuOperation') &&
		      !fileSectionSource.includes('<FileContextMenu') &&
		      !fileSectionBodySource.includes('<FileContextMenu') &&
      !fileSectionSource.includes('const handleFileMenuKeyDown = useCallback') &&
      fileContextMenuSource.includes('useWorkspaceMenuKeyboard({') &&
      editorContextMenuSource.includes('useWorkspaceMenuKeyboard({') &&
      workspaceMenuKeyboardSource.includes("button[role=\"menuitem\"]:not(:disabled)") &&
      workspaceMenuKeyboardSource.includes("event.key === 'ArrowDown'") &&
      workspaceMenuKeyboardSource.includes("event.key === 'ArrowUp'") &&
      workspaceMenuKeyboardSource.includes("event.key === 'Home'") &&
      workspaceMenuKeyboardSource.includes("event.key === 'End'") &&
      !fileSectionSource.includes('const focusFirstMenuItem = () =>') &&
      workspaceMenuKeyboardSource.includes('const focusFirstMenuItem = () => focusFirstWorkspaceMenuItem(menuRef.current)') &&
      workspaceMenuKeyboardSource.includes('menuRef.current?.querySelector<HTMLButtonElement>') &&
      workspaceMenuKeyboardSource.includes('window.setTimeout(focusFirstMenuItem, 120)') &&
      workspaceMenuKeyboardSource.includes('window.setTimeout(focusFirstMenuItem, 260)') &&
      workspaceMenuKeyboardSource.includes("document.addEventListener('pointerdown', closeMenu)") &&
      workspaceMenuKeyboardSource.includes("document.addEventListener('keydown', closeOnEscape)") &&
      fileContextMenuSource.includes('data-testid="code-file-context-menu"') &&
      fileContextMenuSource.includes('onKeyDown={handleFileMenuKeyDown}') &&
      fileContextMenuSource.includes('{copy.newFile}') &&
      fileContextMenuSource.includes('{copy.newFolder}') &&
      fileContextMenuSource.includes('{copy.copyRelativePath}') &&
		      fileSectionOverlaysSource.includes('<FileOperationDialog') &&
		      fileOperationDialogSource.includes("fileOperation.kind === 'delete' ? 'code-file-operation-shell delete-confirm' : 'code-file-operation-shell'") &&
		      fileOperationDialogSource.includes('data-testid="code-file-operation-dialog"') &&
		      fileOperationDialogSource.includes('code-file-operation-text') &&
	      !fileSectionSource.includes("fileOperation.kind === 'delete' ? 'code-file-operation-shell delete-confirm' : 'code-file-operation-shell'") &&
		      !fileSectionSource.includes('data-testid="code-file-operation-dialog"') &&
		      !fileSectionBodySource.includes('<FileOperationDialog') &&
      !fileSectionSource.includes('className="code-rename-backdrop"') &&
      !fileSectionSource.includes('type DragPreviewProps') &&
      !fileSectionSource.includes('type CursorProps') &&
      !fileSectionSource.includes('function FileDropCursor') &&
      !fileSectionSource.includes('const FileDragPreview') &&
      !fileSectionSource.includes('renderDragPreview=') &&
      !fileSectionSource.includes('renderCursor=') &&
      !fileSectionSource.includes('ref={dragHandle}') &&
      fileOpenControllerSource.includes('fetchWorkspaceFile') &&
      fileTreeRowSource.includes('iconForFilePath') &&
      fileStickyContextSource.includes('iconForDirectoryPath') &&
	      fileTreeRowSource.includes('<img') &&
	      fileTreeRowSource.includes('src={iconUrl}') &&
	      fileSectionSource.includes('data-testid="code-files-section"') &&
	      fileSearchResultsSource.includes('data-testid="code-file-search-results"') &&
	      !fileSectionSource.includes('data-testid="code-file-search-results"') &&
      fileSectionHeaderSource.includes('placeholder={copy.searchOrPathLine}') &&
      fileSearchControllerHookSource.includes("event.key === 'ArrowDown'") &&
      fileSearchControllerHookSource.includes("event.key === 'ArrowUp'") &&
      fileTreeViewSource.includes('<FileTreeRow') &&
      !fileSectionSource.includes('<FileTreeRow') &&
      fileTreeRowSource.includes('data-testid="code-file-row"') &&
      fileTreeRowSource.includes('data-file-type={item.type}') &&
      fileTreeRowSource.includes('aria-expanded={isDirectory ? node.isOpen : undefined}') &&
      fileTreeRowSource.includes('title={item.path}') &&
	      fileSectionBodySource.includes('data-testid="code-file-open-error"') &&
	      !fileSectionSource.includes('data-testid="code-file-open-error"') &&
      !fileSectionSource.includes('window.alert') &&
      fileTreeRowSource.includes('code-file-chevron') &&
      !fileSectionSource.includes('code-files-header-chevron') &&
      treeRowModelSource.includes("isDirectory ? (isOpen ? 'expanded' : 'collapsed') : 'placeholder'") &&
      treeRowModelSource.includes("return status === 'untracked' ? undefined : status") &&
      treeRowModelSource.includes('const visibleGitStatus = visibleWorkspaceFileTreeGitStatus(item.gitStatus)') &&
      treeRowModelSource.includes('const visibleDescendantGitStatus = visibleWorkspaceFileTreeGitStatus(item.descendantGitStatus)') &&
      treeRowModelSource.includes('const visibleGitStatusLabel = visibleGitStatus ? item.gitStatusLabel : undefined') &&
      treeRowModelSource.includes('workspaceFileTreeDescendantGitStatusClassName(visibleDescendantGitStatus)') &&
      treeRowModelSource.includes("const directoryDotTitleKind: WorkspaceFileTreeStatusTitleKind | null = hasDescendantGitStatus") &&
      treeRowModelSource.includes("const fileChangedClassName = fileChangedKind ? `code-file-changed ${fileChangedKind}` : ''") &&
      treeRowModelSource.includes('const visibleGitStatusClassName = visibleGitStatus ? `code-file-git-status ${visibleGitStatus}` : \'\'') &&
      treeRowModelSource.includes('export type WorkspaceFileTreeRowViewState = ReturnType<typeof workspaceFileTreeRowViewState>') &&
      fileTreeRowStatusSource.includes('viewState: WorkspaceFileTreeRowViewState') &&
      treeRowModelSource.includes('item.gitStatusLabel') &&
      fileTreeRowSource.includes('<FileTreeRowStatus') &&
      fileTreeRowStatusSource.includes('className={visibleGitStatusClassName}') &&
      fileTreeRowStatusSource.includes('className={directoryDotClassName}') &&
      fileTreeRowStatusSource.includes('className={fileChangedClassName}') &&
      fileTreeRowStatusSource.includes('workspaceFileTreeStatusTitle(directoryDotTitleKind, copy)') &&
      fileTreeRowStatusSource.includes('workspaceFileTreeStatusTitle(fileChangedTitleKind, copy)') &&
      !fileTreeRowStatusSource.includes('function statusTitle') &&
      treeRowModelSource.includes('function workspaceFileTreeStatusTitle') &&
      !fileTreeRowStatusSource.includes('code-file-git-status ${visibleGitStatus}') &&
      !fileTreeRowStatusSource.includes('code-file-descendant-status ${directoryDotKind}') &&
      !fileTreeRowStatusSource.includes("editorExternalChanged ? 'external' : editorDirty ? 'dirty'") &&
      !treeRowModelSource.includes('changedPaths') &&
      !treeRowModelSource.includes('hasChangedDescendant') &&
      treeRowModelSource.includes('hasDescendantGitStatus || hasEditorDirtyDescendant || hasEditorExternalChangedDescendant') &&
      treeRowModelSource.includes('editorDirtyFilePaths.has(item.path)') &&
      treeRowModelSource.includes('editorExternalChangedFilePaths.has(item.path)') &&
      treeRowModelSource.includes('editor-dirty') &&
      treeRowModelSource.includes('editor-descendant-dirty') &&
      fileTreeRowSource.includes('workspaceFileTreeRowViewState({') &&
	      treeRowModelSource.includes('copy.unsavedChanges') &&
	      fileTreeRowInteractionsSource.includes('onHydrateCompactDirectoryChains(item.path)') &&
		      fileTreeKeyboardHookSource.includes("activationIntent === 'open-directory'") &&
		      fileTreeKeyboardHookSource.includes("activationIntent === 'close-directory'") &&
		      fileTreeKeyboardHookSource.includes("activationIntent === 'open-file'") &&
		      fileTreeKeyboardHookSource.includes('void openFilePath(node.data.path)') &&
	      fileTreeRowInteractionsSource.includes('void onOpenFilePath(item.path)') &&
	      !fileSectionSource.includes('onActivate={node =>') &&
	      fileStickyContextSource.includes('code-file-sticky-row') &&
      !fileSectionSource.includes('aria-expanded="true"') &&
      !fileSectionSource.includes('treeRef.current?.scrollTo(ancestor.id)') &&
      !fileSectionSource.includes('▾') &&
      !fileSectionSource.includes('▸') &&
      fileTreeRowSource.includes('code-file-type-icon') &&
      fileStickyContextSource.includes('iconForDirectoryPath(item.node.iconPath ?? item.node.path, true, item.node.iconSignals)') &&
      !fileSectionSource.includes("isDirectory ? '2 / -1' : '3 / -1'") &&
      treeRowModelSource.includes("'--file-depth': depth") &&
	      fileTreeViewSource.includes('<FileTreeRow') &&
      !fileSectionSource.includes('onFileEvent(event)');

  assert(
    projectFilesSectionDelegates,
    'ProjectFilesSection should delegate Explorer tree behavior to react-arborist while preserving Farming file API wiring and row decorations'
  );

  assert(
	    workspaceSource.includes("projectGroup.style.setProperty(\n        '--code-project-sticky-height'") &&
        workspaceSource.includes("projectGroup.style.setProperty(\n        '--code-agents-sticky-height'") &&
	      workspaceSource.includes('new ResizeObserver(setStickyMetrics)') &&
        workspaceSource.includes('observer?.observe(projectRow)') &&
	      workspaceSource.includes('ref={agentsSectionRef} className="code-agents-section"'),
    'project files sticky context should measure project and agent rows before pinning OPEN EDITORS or FILES headers'
	  );

  assert(
    designSource.includes('文件目录树展示逻辑') &&
      designSource.includes('不是 icon mapping') &&
      designSource.includes('可见行模型') &&
      designSource.includes('按当前可见行数自然撑高') &&
      designSource.includes('滚动交给外层 project list') &&
      designSource.includes('Project 左栏不在 `Files` 内部隐藏内容') &&
	      designSource.includes('active file 和 tree selection 分离') &&
	      designSource.includes('active file 用左侧细条 + 很浅背景') &&
	      designSource.includes('拖拽移动不是当前 P0 验收重点') &&
	      designSource.includes('搜索入口复用 `/api/files/search`') &&
	      designSource.includes('`path:line` / `path:line:column`') &&
		      designSource.includes('Review 场景允许打开整文件 Monaco diff surface') &&
		      designSource.includes('`Changes` 是当前 Project 内的轻量 review 入口') &&
		      designSource.includes('不把 patch 审阅塞进窄的 Agent / chat 栏') &&
		      !designSource.includes('当前 editor 先不暴露 Diff 能力') &&
		      designSource.includes('左右对比') &&
		      designSource.includes('前端交给 Monaco DiffEditor 渲染') &&
		      designSource.includes('行级变化遵循 VS Code dirty diff 的概念边界') &&
		      userStoriesSource.includes('行级变化与 Review Diff') &&
		      userStoriesSource.includes('`Changes` 是当前 Project workspace 的轻量 review 入口') &&
		      userStoriesSource.includes('右侧主区域打开 Monaco 整文件 diff') &&
		      !userStoriesSource.includes('Diff 暂不暴露') &&
		      !userStoriesSource.includes('没有 diff panel') &&
	      designSource.includes('搜索结果的键盘选中态需要暴露给 DOM') &&
	      designSource.includes('`aria-activedescendant` 指向当前结果') &&
	      designSource.includes('轻量 hot-exit 缓存里的草稿仍应同步给左侧 Explorer decoration') &&
	      designSource.includes('decoration slot') &&
	      designSource.includes('父目录名称保持低饱和提示色') &&
	      designSource.includes('Project 展开内容的顺序是具体 Agent 行、可选 `Open Editors`、`Files`') &&
	      designSource.includes('`Open Editors` 只有在当前 Project 至少打开一个文件后才出现，出现时默认折叠') &&
	      designSource.includes('`Files` 只承载搜索/跳转入口和目录树，不承载打开文件列表') &&
	      designSource.includes('独立 section，和 Agent 行处于同一层级缩进') &&
	      designSource.includes('Files section 标题可点击折叠/展开') &&
	      designSource.includes('Main Agent 不展示对应 Files') &&
	      designSource.includes('窄侧栏下 Files header 使用两行布局') &&
	      designSource.includes('`path:line` 搜索入口必须保持可输入宽度') &&
	      designSource.includes('不常驻在 Files header') &&
	      designSource.includes('单一路径目录链应合并成一个可见目录行') &&
	      designSource.includes('Explorer row 文字截断时仍要能 hover 看到完整相对路径') &&
	      designSource.includes('原生 `title` 暴露完整路径') &&
	      designSource.includes('tree behavior engine') &&
      designSource.includes('Farming file adapter') &&
      designSource.includes('Farming row renderer') &&
      designSource.includes('react-arborist') &&
      designSource.includes('@headless-tree/react') &&
      designSource.includes('Theia / code-server'),
    'design doc should define the Explorer display logic as mature tree behavior, not just icon mapping'
  );

  assert(
	      editorWorkingCopyControllerSource.includes('saveWorkspaceFile') &&
	        editorWorkingCopyControllerSource.includes('fetchWorkspaceFile') &&
        editorSource.includes('useFileEditorBlameController({') &&
        editorBlameControllerSource.includes('fetchWorkspaceBlame(openFile.agentId, openFile.file.path)') &&
        editorBlameControllerSource.includes('fetchWorkspaceBlameCapability(openFile.agentId, openFile.file.path)') &&
        editorPreviewPanelSource.includes('rawWorkspaceFileUrl') &&
      editorTabsComponentSource.includes('iconForFilePath(file.file.path)') &&
      editorTabsComponentSource.includes('openFiles.map') &&
      editorTabsComponentSource.includes('role="tablist"') &&
      editorTabsComponentSource.includes('role="tab"') &&
      editorTabsComponentSource.includes('aria-selected={active}') &&
      editorSource.includes('workspaceEditorTabDomId') &&
      editorModelSource.includes('function safeWorkspaceEditorDomIdPart') &&
      editorModelSource.includes('function workspaceEditorTabDomId') &&
      editorModelSource.includes('function workspaceEditorTabLabel') &&
      !editorSource.includes('function fileEditorTabDomId') &&
      !editorSource.includes('function fileEditorTabLabel') &&
      editorModelSource.includes("', changed on disk'") &&
      editorModelSource.includes("', unsaved changes'") &&
      editorSource.includes('const activeTabDomId = fileEditorTabDomId(openFile)') &&
      editorTabsComponentSource.includes('id={fileEditorTabDomId(file)}') &&
      editorTabsComponentSource.includes('aria-controls="code-file-editor-panel"') &&
      editorTabsComponentSource.includes('aria-label={fileEditorTabLabel(file)}') &&
      editorTabsComponentSource.includes('tabIndex={active ? 0 : -1}') &&
		      editorSurfaceSource.includes('id="code-file-editor-panel"') &&
		      editorSurfaceSource.includes('role="tabpanel"') &&
      editorSurfaceSource.includes('aria-labelledby={activeTabDomId}') &&
      editorSource.includes('<FileEditorHeader') &&
      editorSource.includes('<FileEditorOverlays') &&
      editorHeaderSource.includes('<FileEditorTabs') &&
      !editorSource.includes('<FileEditorTabContextMenu') &&
      editorSource.includes('useFileEditorTabsController') &&
      editorSource.includes('useFileEditorShellKeyboard({') &&
      editorSource.includes('handleEditorTabKeyDown') &&
      editorSource.includes('handleEditorTabAuxClick') &&
      editorSource.includes('handleEditorShellKeyDown') &&
      editorSource.includes('onKeyDownCapture={handleEditorShellKeyDown}') &&
      editorSurfaceSource.includes('tabIndex={-1}') &&
      !editorSource.includes('onPointerDownCapture={focusEditor}') &&
      editorSource.includes('onFocusFilesSearch') &&
      editorMonacoControllerSource.includes('onFocusFilesSearchRef') &&
      editorMonacoControllerSource.includes('openFileAgentIdRef') &&
      !editorSource.includes('pendingTabFocusRef') &&
      editorTabsControllerSource.includes('pendingTabFocusRef') &&
      editorTabsControllerSource.includes('tab?.scrollIntoView') &&
      editorTabsControllerSource.includes('tab?.focus()') &&
      editorShellKeyboardSource.includes("event.key === 'PageUp'") &&
		      editorShellKeyboardSource.includes("event.key === 'PageDown'") &&
		      editorShellKeyboardSource.includes("event.key.toLowerCase() === 'w'") &&
	      editorShellKeyboardSource.includes("event.key.toLowerCase() === 'p'") &&
		      editorShellKeyboardSource.includes("event.key.toLowerCase() === 's'") &&
		      editorShellKeyboardSource.includes('onSaveFile(false)') &&
      editorShellKeyboardSource.includes('window.requestAnimationFrame') &&
      editorShellKeyboardSource.includes('window.setTimeout(() => onFocusFilesSearch(agentId), 120)') &&
      !editorSource.includes('saveFileRef') &&
      editorSource.includes('WorkspaceFileOpenTarget') &&
      editorHeaderSource.includes('WorkspaceFileOpenTarget') &&
      editorTabsComponentSource.includes('WorkspaceFileOpenTarget') &&
      editorTabsControllerSource.includes('WorkspaceFileOpenTarget') &&
      !editorSource.includes('lineNumber?: number; column?: number; endColumn?: number') &&
      !editorHeaderSource.includes('lineNumber?: number; column?: number; endColumn?: number') &&
      !editorTabsComponentSource.includes('lineNumber?: number; column?: number; endColumn?: number') &&
	      !editorTabsControllerSource.includes('lineNumber?: number; column?: number; endColumn?: number') &&
			      editorBlameControllerSource.includes('if (disabled) return') &&
		      editorTabsControllerSource.includes("event.key === 'ArrowLeft'") &&
      editorTabsControllerSource.includes("event.key === 'ArrowRight'") &&
      editorTabsControllerSource.includes("event.key === 'Home'") &&
      editorTabsControllerSource.includes("event.key === 'End'") &&
      editorTabsControllerSource.includes("event.key === 'Delete'") &&
      editorTabsControllerSource.includes('event.button !== 1') &&
      editorTabsComponentSource.includes('onAuxClick={event => onTabAuxClick(event, index)}') &&
      editorTabsComponentSource.includes('onContextMenu={event => onOpenTabContextMenu(event, index)}') &&
      editorTabsControllerSource.includes('onSelectOpenFile(file.agentId, file.file.path)') &&
      editorTabsComponentSource.includes('onCloseTab(index)') &&
      editorTabsControllerSource.includes('closeEditorTab(index)') &&
      !editorSource.includes('requestCloseFiles') &&
      editorTabsControllerSource.includes('requestCloseFiles') &&
      editorTabsControllerSource.includes('createWorkspaceEditorCloseIntent(files, nextFocusFile)') &&
      editorTabsControllerSource.includes('setPendingClose(closeIntent.pendingClose)') &&
      editorTabsControllerSource.includes('workspaceEditorNextFocusAfterClosingTab(openFiles, openFile, index)') &&
      editorTabsControllerSource.includes('workspaceEditorNextFocusAfterClosingFiles(openFiles, openFile, files)') &&
      editorTabsControllerSource.includes('workspaceEditorFilesForTabAction(action, openFiles, index)') &&
      editorTabsControllerSource.includes('workspaceEditorPendingCloseNextFocus(pendingClose)') &&
      editorTabsControllerSource.includes('const [pendingClose, setPendingClose] = useState<PendingCloseState | null>(null)') &&
      editorTabsControllerSource.includes('const [pendingCloseSaving, setPendingCloseSaving] = useState(false)') &&
      editorTabsControllerSource.includes('onSaveOpenFile(file, false)') &&
      editorTabsControllerSource.includes('const cancelPendingClose = useCallback') &&
      editorWorkingCopyControllerSource.includes('const saveOpenWorkspaceFile = useCallback') &&
      editorWorkingCopyControllerSource.includes('saveOpenWorkspaceFile,') &&
      !editorWorkingCopyControllerSource.includes('PendingCloseState') &&
      !editorSource.includes('useState<PendingCloseState') &&
      editorTabsSource.includes('function createWorkspaceEditorCloseIntent') &&
      editorTabsSource.includes('function workspaceEditorNextFocusAfterClosingTab') &&
      editorTabsSource.includes('function workspaceEditorNextFocusAfterClosingFiles') &&
      editorTabsSource.includes('function workspaceEditorFilesForTabAction') &&
      editorTabsSource.includes('function workspaceEditorPendingCloseNextFocus') &&
      !editorSource.includes('const dirtyFiles = closeFiles.filter') &&
      !editorSource.includes('const remainingFiles = openFiles.filter(candidate =>') &&
      editorSource.includes('useFileEditorWorkingCopyController') &&
      !editorSource.includes('<FileEditorSaveConfirmDialog') &&
      editorOverlaysSource.includes('<FileEditorSaveConfirmDialog') &&
      editorSaveConfirmDialogSource.includes('data-testid="code-file-save-confirm"') &&
      editorSaveConfirmDialogSource.includes('copy.saveBeforeCloseTitle(label)') &&
      editorSaveConfirmDialogSource.includes('copy.dontSave') &&
      editorSaveConfirmDialogSource.includes("event.key === 'Escape' && !saving") &&
		      editorTabsControllerSource.includes('onCloseOpenFiles(targets)') &&
		      !editorSource.includes("runTabContextAction('save')") &&
		      editorTabContextMenuSource.includes("onRunAction('close-others')") &&
      editorTabContextMenuSource.includes("onRunAction('close-right')") &&
      editorTabContextMenuSource.includes("onRunAction('close-saved')") &&
      editorTabContextMenuSource.includes("onRunAction('close-all')") &&
      workingCopySource.includes('function hasCleanWorkspaceWorkingCopy') &&
      editorTabContextMenuSource.includes('hasCleanWorkspaceWorkingCopy(openFiles)') &&
      !editorTabContextMenuSource.includes('!file.dirty && !file.externalChanged && !file.saving') &&
      editorTabsComponentSource.includes('workspaceWorkingCopyChangeIndicator(file)') &&
      !editorTabsComponentSource.includes('file.externalChanged ? copy.changedOnDisk : copy.unsavedChanges') &&
      editorTabContextMenuSource.includes('data-testid="code-file-tab-context-menu"') &&
      editorSource.includes("import * as monaco from 'monaco-editor'") &&
      editorMonacoSource.includes('MonacoEnvironment') &&
      editorSource.includes('useFileEditorMonacoController({') &&
      editorMonacoControllerSource.includes('useFileEditorTestBridge({') &&
      editorTestBridgeSource.includes('window.__FARMING_E2E__') &&
      editorTestBridgeSource.includes('window.__farmingFileEditorTest = testApi') &&
      editorTestBridgeSource.includes("editor.executeEdits('farming-e2e'") &&
      !editorMonacoControllerSource.includes('window.__farmingFileEditorTest = testApi') &&
      editorMonacoControllerSource.includes('configureWorkspaceEditorMonacoEnvironment()') &&
      editorMonacoControllerSource.includes('monaco.editor.create(host, workspaceEditorCreateOptions({') &&
      editorMonacoSource.includes('export function workspaceEditorCreateOptions') &&
      editorMonacoSource.includes('unicodeHighlight:') &&
      editorMonacoSource.includes('lineNumbersMinChars: 4') &&
      editorMonacoControllerSource.includes('updateWorkspaceEditorResponsiveOptions(editor)') &&
      editorMonacoSource.includes('export function updateWorkspaceEditorResponsiveOptions') &&
      editorMonacoControllerSource.includes('const onSaveShortcutRef = useRef(onSaveShortcut)') &&
      editorMonacoControllerSource.includes('registerWorkspaceEditorCommands(editor, {') &&
      editorMonacoSource.includes('export function registerWorkspaceEditorCommands') &&
      editorMonacoSource.includes('editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP') &&
      editorMonacoSource.includes('editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyP') &&
      editorMonacoSource.includes('editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS') &&
      editorMonacoSource.includes('editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyS') &&
      !editorMonacoControllerSource.includes('editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP') &&
      !editorMonacoControllerSource.includes('editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyP') &&
		      editorMonacoControllerSource.includes('editorViewStatesRef') &&
		      editorMonacoControllerSource.includes('activeEditorModelKeyRef') &&
		      editorMonacoControllerSource.includes('onChangeDraftRef.current(editor.getValue())') &&
		      editorSource.includes('openEditorContextMenuRef') &&
		      editorMonacoControllerSource.includes("host.addEventListener('contextmenu', handleNativeEditorContextMenu, true)") &&
		      editorMonacoControllerSource.includes('host.removeEventListener(\'contextmenu\', handleNativeEditorContextMenu, true)') &&
		      editorMonacoControllerSource.includes('nativeWorkspaceEditorContextMenuEvent(editor, event)') &&
		      editorMonacoSource.includes('export function nativeWorkspaceEditorContextMenuEvent') &&
		      editorMonacoSource.includes('WORKSPACE_EDITOR_CONTEXT_MENU_IGNORE_SELECTOR') &&
		      editorMonacoSource.includes('editor.getTargetAtClientPoint(event.clientX, event.clientY)') &&
		      editorMonacoSource.includes('browserEvent: event') &&
		      editorMonacoSource.includes('rightButton: true') &&
		      !editorMonacoControllerSource.includes('browserEvent: event') &&
		      !editorMonacoControllerSource.includes('rightButton: true') &&
		      editorMonacoControllerSource.includes('updateCursorPosition') &&
		      editorModelSource.includes("WORKSPACE_EDITOR_MODEL_URI_SCHEME = 'farming-file'") &&
	      editorMonacoSource.includes('function workspaceEditorModelUriForFile') &&
	      editorMonacoSource.includes('workspaceEditorModelUriParts(file)') &&
	      editorModelSource.includes('authority: safeWorkspaceEditorDomIdPart(file.agentId)') &&
	      editorModelSource.includes("path: `/${file.file.path.replace(/^\\/+/, '')}`") &&
	      editorMonacoControllerSource.includes('editor.saveViewState()') &&
	      editorMonacoControllerSource.includes('editor.restoreViewState(viewState)') &&
	      editorMonacoControllerSource.includes('const liveFiles = [...openFiles, openFile]') &&
	      editorMonacoControllerSource.includes('pruneWorkspaceEditorModelState(liveFiles, editorViewStatesRef.current)') &&
	      editorMonacoControllerSource.includes('disposeWorkspaceEditorModels()') &&
	      editorMonacoControllerSource.includes('workspaceEditorModelForOpenFile(openFile)') &&
	      editorMonacoSource.includes('export function workspaceEditorModelForOpenFile') &&
	      editorMonacoSource.includes('export function pruneWorkspaceEditorModelState') &&
	      editorMonacoSource.includes('export function disposeWorkspaceEditorModels') &&
	      editorMonacoSource.includes('workspaceEditorLiveModelKeys(liveFiles)') &&
	      editorMonacoSource.includes('shouldKeepWorkspaceEditorViewState(key, openModelKeys)') &&
	      editorMonacoSource.includes('workspaceEditorLiveModelUriStrings(liveFiles') &&
	      editorMonacoSource.includes('shouldDisposeWorkspaceEditorModelUri(model.uri, openModelUris)') &&
	      editorModelSource.includes('function workspaceEditorLiveModelKeys') &&
	      editorModelSource.includes('function shouldKeepWorkspaceEditorViewState') &&
	      editorModelSource.includes('function shouldDisposeWorkspaceEditorModelUri') &&
	      editorMonacoSource.includes('editorViewStates.delete(key)') &&
	      editorMonacoControllerSource.includes('editorViewStatesRef.current.clear()') &&
	      editorMonacoSource.includes('monaco.editor.getModels().forEach(model =>') &&
	      editorMonacoSource.includes('isWorkspaceEditorModelUri(model.uri)') &&
	      editorModelSource.includes('function isWorkspaceEditorModelUri') &&
	      editorMonacoSource.includes('model.dispose()') &&
	      !editorMonacoControllerSource.includes('monaco.editor.getModels().forEach(model =>') &&
	      !editorMonacoControllerSource.includes('isWorkspaceEditorModelUri(model.uri)') &&
		      !editorSource.includes('WorkspaceFileApiError') &&
		      editorBlameControllerSource.includes('WorkspaceFileApiError') &&
		      editorWorkingCopyControllerSource.includes('WorkspaceFileApiError') &&
	      editorSource.includes('WorkspaceFileCursor') &&
	      editorMonacoControllerSource.includes('lastCursorRequestRef') &&
	      editorMonacoControllerSource.includes('workspaceEditorCursorSelection(cursor') &&
	      editorModelSource.includes('function workspaceEditorCursorSelection') &&
	      !editorSource.includes('const lineCount = model?.getLineCount() ?? 1') &&
	      editorMonacoControllerSource.includes('editor.revealLineInCenter(selection.startLineNumber)') &&
	      editorMonacoControllerSource.includes('editor.setSelection') &&
		      editorWorkingCopyControllerSource.includes('status === 409') &&
			      editorWorkingCopyControllerSource.includes('if (fileToSave.saving) return false') &&
			      editorWorkingCopyControllerSource.includes('if (!overwrite && !fileToSave.dirty) return true') &&
      editorMonacoSource.includes('monaco.KeyCode.KeyS') &&
      editorMonacoSource.includes('monaco.KeyCode.KeyP') &&
	      editorSource.includes(': null') &&
	      editorSource.includes('workspaceEditorStatusKind(openFile)') &&
	      !editorSource.includes('workspaceWorkingCopyState(openFile)') &&
	      editorModelSource.includes('function workspaceEditorStatusKind') &&
	      editorActionsSource.includes('{actions.showStatus && statusText && (') &&
	      !editorSource.includes("'Saved'") &&
      !editorSource.includes('const showReloadAction = shouldShowWorkspaceWorkingCopyReloadAction(openFile)') &&
      !editorHeaderSource.includes('const showReloadAction = shouldShowWorkspaceWorkingCopyReloadAction(openFile)') &&
      !editorActionsSource.includes('const showReloadAction = shouldShowWorkspaceWorkingCopyReloadAction(openFile)') &&
      editorModelSource.includes('function workspaceEditorActionState') &&
      editorModelSource.includes('const showReload = !mode.diffOnly && shouldShowWorkspaceWorkingCopyReloadAction(file)') &&
      workingCopySource.includes('function shouldShowWorkspaceWorkingCopyReloadAction') &&
		      editorTabsComponentSource.includes('code-file-editor-tabs') &&
	      editorTabsComponentSource.includes('code-file-editor-tab') &&
	      editorTabsComponentSource.includes('code-file-editor-tab-name') &&
	      editorTabsComponentSource.includes('code-file-editor-tab-tail') &&
      editorModelSource.includes('function workspaceEditorPathSegments') &&
      editorModelSource.includes('function workspaceEditorPathToSegment') &&
      !editorSource.includes('function pathSegments') &&
      editorHeaderSource.includes('<FileEditorBreadcrumbs') &&
      !editorHeaderSource.includes('code-file-editor-breadcrumbs') &&
      editorBreadcrumbsSource.includes('code-file-editor-breadcrumbs') &&
      editorBreadcrumbsSource.includes("const current = index === segments.length - 1") &&
      editorBreadcrumbsSource.includes('code-file-editor-breadcrumb-separator') &&
	      editorTabsComponentSource.includes('code-file-editor-close') &&
	      editorTabsComponentSource.includes('tabIndex={-1}') &&
	      editorTabsComponentSource.includes('aria-label={copy.closeFile(file.file.path)}') &&
		      editorHeaderSource.includes('<FileEditorActions') &&
		      !editorHeaderSource.includes('className="code-file-editor-action reload"') &&
		      editorActionsSource.includes('className="code-file-editor-action reload"') &&
		      editorActionsSource.includes('aria-label={copy.reloadFile}') &&
		      editorActionsSource.includes('{actions.showReload && (') &&
		      editorActionsSource.includes('className="code-file-editor-action save"') &&
		      editorActionsSource.includes('aria-label={copy.saveFile}') &&
		      !editorActionsSource.includes('shouldShowWorkspaceWorkingCopySaveAction(openFile)') &&
		      editorModelSource.includes('const showSave = mode.canEditText && shouldShowWorkspaceWorkingCopySaveAction(file)') &&
		      workingCopySource.includes('file.dirty && !file.externalChanged && !isWorkspaceWorkingCopyPreview(file)') &&
		      editorActionsSource.includes('className="code-file-editor-action overwrite"') &&
	      editorActionsSource.includes('aria-label={copy.overwriteChangedFile}') &&
		      !editorSource.includes('{showSaveAction && (') &&
		      !editorSource.includes("runEditorContextAction('save')") &&
		      editorDiffControllerSource.includes('fetchWorkspaceDiff(openFile.agentId, openFile.file.path)') &&
	      editorDiffControllerSource.includes('diffRequestRef.current !== requestId') &&
      editorDiffControllerSource.includes('const handledDiffRequestRef = useRef<number | undefined>(undefined)') &&
      editorDiffControllerSource.includes('handledDiffRequestRef.current === openFile.diffRequestId') &&
      !editorSource.includes('handledDiffRequestRef') &&
	      editorDiffViewSource.includes('monaco.editor.createDiffEditor') &&
	      editorDiffViewSource.includes('monaco.editor.getModel(uri)?.dispose()') &&
	      editorDiffViewSource.includes('function createDiffTextModel') &&
	      editorDiffViewSource.includes('renderSideBySide: true') &&
		      editorDiffViewSource.includes('data-testid="code-file-diff-view"') &&
	      editorDiffViewSource.includes('data-testid="code-file-diff-monaco"') &&
		      editorSurfaceSource.includes('<FileEditorDiffView') &&
		      editorModelSource.includes('function workspaceEditorSurfaceState') &&
		      editorModelSource.includes('const showDiffView = options.diffOpen && !options.visualPreview') &&
		      editorModelSource.includes('const showDiffOnlyPreview = options.diffOnly && !showDiffView') &&
		      editorModelSource.includes('showEditorOverlays: showMonaco') &&
		      editorSurfaceSource.includes('const surface = workspaceEditorSurfaceState({') &&
		      editorSurfaceSource.includes('editorMode: WorkspaceEditorFileMode') &&
		      editorSurfaceSource.includes('diffOnly: editorMode.diffOnly') &&
		      editorSurfaceSource.includes('visualPreview: editorMode.visualPreview') &&
		      !editorSurfaceSource.includes('diffOnly: openFile.diffOnly === true') &&
		      editorSurfaceSource.includes('surface.showDiffView') &&
		      editorSurfaceSource.includes('surface.showDiffOnlyPreview') &&
		      editorSurfaceSource.includes('surface.showEditorOverlays') &&
		      editorSurfaceSource.includes('copy.deletedFileDiffOnly') &&
	      editorActionsSource.includes('className={`code-file-editor-action diff ${diffOpen ? \'active\' : \'\'}`}') &&
		      !editorSource.includes('className={`code-file-editor-action blame') &&
		      !editorSource.includes('aria-label={blameOpen ? copy.hideGitBlame : copy.showGitBlame}') &&
		      !editorSource.includes('const showBlameToolbarAction = !isPreviewFile') &&
      editorSource.includes('<FileEditorSurface') &&
		      editorSurfaceSource.includes('<FileEditorPreviewPanel') &&
		      editorPreviewPanelSource.includes('data-testid="code-file-preview-panel"') &&
		      editorPreviewPanelSource.includes('data-testid="code-file-image-preview"') &&
		      editorPreviewPanelSource.includes('data-testid="code-file-metadata-preview-icon"') &&
		      editorPreviewPanelSource.includes("filePreview?.kind === 'binary'") &&
		      editorModelSource.includes('function workspaceEditorFileMode') &&
		      editorModelSource.includes('const readOnly = preview || diffOnly') &&
		      editorModelSource.includes('canEditText: !readOnly') &&
		      editorModelSource.includes('canShowDiff: !preview') &&
		      editorModelSource.includes('canShowBlame: canShowSourceHistory') &&
		      editorModelSource.includes('canShowLineChanges: canShowSourceHistory') &&
		      editorSource.includes('const editorMode = workspaceEditorFileMode(openFile)') &&
		      editorSource.includes('const readOnly = !editorMode.canEditText') &&
		      editorSource.includes('const canShowBlame = editorMode.canShowBlame') &&
		      editorSource.includes('const canShowLineChanges = editorMode.canShowLineChanges') &&
		      editorSource.includes('diffDisabled: !editorMode.canShowDiff') &&
		      editorSource.includes('disabled: !canShowBlame') &&
		      editorSource.includes('disabled: !canShowLineChanges') &&
		      editorHeaderSource.includes('editorMode: WorkspaceEditorFileMode') &&
		      editorSource.includes('editorMode={editorMode}') &&
		      editorActionsSource.includes('{actions.showDiff && (') &&
		      !editorSource.includes('visualPreview={editorMode.visualPreview}') &&
		      editorSource.includes('readOnly={readOnly}') &&
		      !editorSource.includes('const isPreviewFile = isWorkspaceWorkingCopyPreview(openFile)') &&
		      !editorSource.includes("const visualPreview = filePreview?.kind === 'image' || filePreview?.kind === 'binary'") &&
			      editorSurfaceSource.includes("className={`code-file-monaco ${surface.showMonaco ? '' : 'hidden'}`}") &&
	      editorMonacoControllerSource.includes('readOnly,') &&
	      editorMonacoControllerSource.includes('domReadOnly: readOnly') &&
      editorPreviewPanelSource.includes('rawWorkspaceFileUrl(openFile.agentId, openFile.file.path, openFile.file.sha1)') &&
      editorMonacoSource.includes('monaco.languages.getLanguages()') &&
      editorMonacoSource.includes('languageForWorkspaceFile(filePath, content, getMonacoLanguageMetadata())') &&
      editorModelSource.includes('language.filenames?.some') &&
      editorModelSource.includes('language.filenamePatterns?.some') &&
      editorModelSource.includes('language.firstLine') &&
      editorModelSource.includes('function languageForWorkspaceFile') &&
      editorModelSource.includes('function workspaceEditorLanguageLookupPath') &&
      editorModelSource.includes("filePath.replace(/~+$/, '')") &&
      editorModelSource.includes('FALLBACK_LANGUAGE_ASSOCIATIONS') &&
	      editorMonacoSource.includes('monaco.editor.setModelLanguage(model, languageId)') &&
	      !editorMonacoControllerSource.includes('monaco.editor.setModelLanguage(model, languageId)') &&
	      editorBlameControllerSource.includes('}, [disabled, openFile.agentId, openFile.file.path, openFile.file.sha1])') &&
      editorSource.includes('checkBlameCapability') &&
      editorBlameControllerSource.includes('fetchWorkspaceBlameCapability(openFile.agentId, openFile.file.path)') &&
      !editorSource.includes('function initialBlameCapability') &&
      !editorSource.includes("file.gitStatus === 'untracked'") &&
	      editorMonacoControllerSource.includes('editor.onContextMenu(event => onOpenContextMenuRef.current(event))') &&
      editorSource.includes('useFileEditorContextMenuController({') &&
      editorContextMenuControllerSource.includes('monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS') &&
      !editorSource.includes('<FileEditorContextMenu') &&
      editorOverlaysSource.includes('<FileEditorContextMenu') &&
      editorContextMenuSource.includes('data-testid="code-editor-context-menu"') &&
      editorContextMenuSource.includes('copy.annotateWithBlame') &&
      editorContextMenuSource.includes("onRunAction('toggle-blame')") &&
      editorContextMenuSource.includes("onRunAction('line-changes-previous')") &&
      editorContextMenuSource.includes("onRunAction('line-changes-working')") &&
	      editorContextMenuControllerSource.includes("const showLineChangesContextActions = Boolean(editorContextMenu && editorContextMenu.kind === 'gutter' && canShowLineChanges)") &&
      editorSource.includes('showLineChangesContextActions={showLineChangesContextActions}') &&
      editorContextMenuControllerSource.includes('navigator.clipboard?.writeText(text)') &&
      editorContextMenuControllerSource.includes('navigator.clipboard?.readText()') &&
      editorContextMenuControllerSource.includes("editor.executeEdits('farming-context-menu'") &&
      editorContextMenuControllerSource.includes("document.addEventListener('mousedown', closeFloatingMenus, true)") &&
      editorContextMenuControllerSource.includes("document.addEventListener('keydown', closeFloatingMenusOnEscape, true)") &&
      editorSource.includes('useFileEditorLineChangesController({') &&
      editorSource.includes('onCloseLineChanges={closeLineChanges}') &&
      editorSurfaceSource.includes('onClose={onCloseLineChanges}') &&
      !editorSource.includes('fetchWorkspaceLineChanges(openFile.agentId, openFile.file.path, lineNumber, mode)') &&
      editorLineChangesControllerSource.includes('fetchWorkspaceLineChanges(openFile.agentId, openFile.file.path, lineNumber, mode)') &&
      editorLineChangesControllerSource.includes('workspaceEditorLineChangesLoadingState(mode, lineNumber)') &&
      editorLineChangesControllerSource.includes('workspaceEditorLineChangesLoadedState(mode, lineNumber, changes)') &&
      editorLineChangesControllerSource.includes('workspaceEditorLineChangesErrorState(mode, lineNumber, error)') &&
      editorModelSource.includes('function workspaceEditorLineChangesPatchLineClassName') &&
      editorLineChangesControllerSource.includes('lineChangesRequestRef.current !== requestId') &&
      editorLineChangesControllerSource.includes('openFileKeyRef.current !== checkedFileKey') &&
      editorLineChangesControllerSource.includes('setLineChanges(null)') &&
      editorSurfaceSource.includes('<FileEditorLineChangesPanel') &&
      editorLineChangesPanelSource.includes('data-testid="code-file-line-changes-panel"') &&
      editorLineChangesPanelSource.includes('copy.openLineChangesWithPreviousRevision') &&
      editorLineChangesPanelSource.includes('copy.openLineChangesWithWorkingFile') &&
      editorLineChangesPanelSource.includes('workspaceEditorLineChangesPatchLineClassName(line)') &&
      !editorLineChangesPanelSource.includes('function patchLineClassName') &&
      editorLineChangesPanelSource.includes('code-file-line-changes-patch') &&
      editorContextMenuSource.includes("onRunAction('select-all')") &&
      !editorSource.includes('Refresh Blame') &&
      !editorSource.includes("'refresh-blame'") &&
      !editorSource.includes("type BlameCapability = 'unknown' | 'available' | 'unavailable'") &&
      editorBlameControllerSource.includes("type BlameCapability = 'unknown' | 'available' | 'unavailable'") &&
      editorSource.includes('showBlameContextAction') &&
      editorSurfaceSource.includes('<FileEditorInlineBlameLayer') &&
      editorInlineBlameLayerSource.includes('code-file-inline-blame') &&
      editorSurfaceSource.includes('<FileEditorBlameDetail') &&
      editorBlameDetailSource.includes('data-testid="code-file-blame-detail"') &&
		      editorSource.includes('workspaceBlameAuthorProfileUrl') &&
		      editorBlameDetailSource.includes('authorProfileUrl ? (') &&
		      editorModelSource.includes('function estimateWorkspaceBlameLabelWidth') &&
			      editorInlineBlameLayerSource.includes('formatBlameInlineLabel(line)') &&
			      editorModelSource.includes('workspaceBlameInlineLabel(line).length') &&
	      editorModelSource.includes('function workspaceEditorVisibleLineWindow') &&
	      editorModelSource.includes('function workspaceEditorBlameOverlayRows') &&
	      editorModelSource.includes('function isPermanentWorkspaceBlameFailureStatus') &&
		      editorBlameControllerSource.includes('const blameLabelWidths = useMemo') &&
      editorSource.includes('useFileEditorBlameOverlayController({') &&
      editorBlameOverlayControllerSource.includes('const labelWidth = compactBlame ? blameLabelWidths.compact : blameLabelWidths.regular') &&
      editorBlameOverlayControllerSource.includes('visibleRanges: editor.getVisibleRanges()') &&
			      editorBlameOverlayControllerSource.includes('workspaceEditorBlameOverlayRows(blame.lines') &&
      editorBlameOverlayControllerSource.includes('editor.onDidScrollChange(refreshBlameOverlay)') &&
      editorBlameOverlayControllerSource.includes('editor.onDidLayoutChange(refreshBlameOverlay)') &&
			      !editorSource.includes('const candidateLines = blame.lines.slice') &&
		      editorSurfaceSource.includes('blameOpen && blameDetailLine') &&
		      editorBlameDetailSource.includes('aria-label={copy.gitBlameDetails}') &&
		      editorBlameDetailSource.includes('className="code-file-blame-detail-close"') &&
		      editorSource.includes('onShowBlameDetail={showBlameDetail}') &&
		      editorSurfaceSource.includes('onShowDetail={onShowBlameDetail}') &&
		      editorMonacoControllerSource.includes('onDidChangeCursorPosition') &&
	      editorMonacoControllerSource.includes('updateCursorPosition') &&
	      editorSurfaceSource.includes('cursorPosition.lineNumber') &&
	      editorSurfaceSource.includes('cursorPosition.column') &&
		      editorSurfaceSource.includes('data-testid="code-file-editor-statusbar"') &&
		      !editorSource.includes('<FileEditorBlameToast') &&
      editorOverlaysSource.includes('<FileEditorBlameToast') &&
		      editorBlameToastSource.includes('copy.loadingBlame') &&
		      editorBlameToastSource.includes('data-testid="code-file-blame-state"') &&
		      !editorSource.includes('const showSaveAction = openFile.dirty || openFile.saving') &&
      editorHeaderSource.includes('const actions = workspaceEditorActionState(openFile, editorMode, {') &&
      editorHeaderSource.includes('{actions.showBar && (') &&
      !editorActionsSource.includes('function shouldShowFileEditorActions') &&
      !editorSource.includes("? 'Unsaved'") &&
	      editorBreadcrumbsSource.includes('title={openFile.file.path}') &&
	      designSource.includes('轻量 breadcrumb 展示') &&
	      designSource.includes('保存状态默认不常驻显示 `Saved`') &&
	      designSource.includes('clean 状态不常驻 disabled 保存按钮') &&
	      designSource.includes('Reload action 只在 external changed / error 时显示') &&
	      designSource.includes('editor tab 使用成熟 tablist 语义') &&
	      designSource.includes('只有 active tab 进入正常 Tab 顺序') &&
	      designSource.includes('`aria-controls` 关联 Monaco `tabpanel`') &&
	      designSource.includes('editor tab 的可访问名称需要包含 basename') &&
	      designSource.includes('close 按钮也使用完整相对路径') &&
	      designSource.includes('保留每个 Monaco model 的 view state') &&
	      designSource.includes('在 editor 左侧非正文 gutter 区域右键打开 Blame') &&
	      designSource.includes('可点击的 Aone 用户入口') &&
	      designSource.includes('editor breadcrumb 是轻量上下文入口') &&
	      editorSource.includes('data-testid="code-file-editor"') &&
      editorSurfaceSource.includes('data-testid="code-file-monaco"') &&
		      editorSource.includes('onRevealInExplorer') &&
		      editorModelSource.includes('function workspaceEditorPathToSegment') &&
		      !editorSource.includes('function pathToSegment') &&
		      !editorSource.includes('const filePathSegments = useMemo') &&
		      !editorHeaderSource.includes('const filePathSegments = useMemo') &&
		      editorBreadcrumbsSource.includes('const filePathSegments = useMemo') &&
		      editorBreadcrumbsSource.includes('onClick={() => onRevealInExplorer(openFile.agentId, segmentPath, current ? \'file\' : \'directory\')}') &&
		      editorBreadcrumbsSource.includes('aria-label={copy.revealInExplorer(segmentPath)}') &&
	      !editorSource.includes('const currentLineBlame = useMemo') &&
	      !editorSource.includes('code-file-editor-line-blame-summary') &&
	      editorSurfaceSource.includes('code-file-editor-cursor-position') &&
      designSource.includes('轻量 hot-exit 缓存'),
    'FileEditorPane should use Monaco inside a VS Code-style tabbed editor shell, save with conflict detection, reload, hot-exit dirty tab recovery, and expose overwrite only for conflicts'
  );

  assert(
    fileIconsSource.includes("material-icon-theme/dist/material-icons.json") &&
      fileIconsSource.includes("import { appPath } from '@/lib/base-path'") &&
      fileIconsSource.includes('/vendor/material-icons/') &&
      fileIconsSource.includes('encodeURIComponent(iconId)') &&
      serverSource.includes("path.join(__dirname, '..', 'node_modules', 'material-icon-theme', 'icons')") &&
      serverSource.includes("routePath(BASE_PATH, '/vendor/material-icons')") &&
      serverSource.includes("routePath(BASE_PATH, '/vendor/material-icons/:iconId.svg')") &&
      serverSource.includes('const fallbackIcon =') &&
      fileIconsSource.includes('fileNames') &&
      fileIconsSource.includes('fileExtensions') &&
      fileIconsSource.includes('folderNamesExpanded') &&
      fileIconsSource.includes('contentSignals: string[] = []') &&
      fileIconsSource.includes('folderIconForSignal(signal, map)') &&
      fileIconsSource.includes('export function iconForFilePath') &&
      fileIconsSource.includes('export function iconForDirectoryPath'),
    'file icon resolver should reuse Material Icon Theme manifest mappings and serve the full icon set as lightweight static vendor assets'
  );

  assert(
	      hookSource.includes('fetchWorkspaceTree') &&
	      hookSource.includes('ensureDirectoryLoaded') &&
	      hookSource.includes('directoriesRef') &&
		      hookSource.includes('const directory = directoriesRef.current[normalizedPath]') &&
		      hookSource.includes('if (!directory || directory.loading || directory.error)') &&
		      !hookSource.includes('expandedDirs') &&
	      !hookSource.includes('let shouldLoad = false') &&
	      !hookSource.includes('watchWorkspaceFiles(agentId') &&
	      !hookSource.includes("loadDirectory('')") &&
	      !hookSource.includes('const FILE_CHANGE_HIGHLIGHT_MS') &&
	      !hookSource.includes('changeHighlightTimersRef') &&
	      !hookSource.includes('changedPaths') &&
	      !hookSource.includes('setChangedPaths'),
	    'useWorkspaceFiles should lazy-load directory data without subscribing to a background workspace watcher'
	  );

  assert(
    webSocketSource.includes('Map<string, Set<(event: WorkspaceFileEventMessage') &&
      webSocketSource.includes("sendMessage({ type: 'watch-workspace-files', agentId })") &&
      webSocketSource.includes("sendMessage({ type: 'unwatch-workspace-files', agentId })") &&
      webSocketSource.includes('workspaceFileListenersRef.current.forEach((listeners, agentId)') &&
      webSocketSource.includes("ws.send(JSON.stringify({ type: 'watch-workspace-files', agentId }))") &&
      webSocketSource.includes('workspaceFileListenersRef.current.get(msg.event.agentId)'),
    'useWebSocket should keep workspace file listeners scoped by agent so multiple Project Files sections can watch in parallel'
  );

	  assert(
	    apiSource.includes('/api/files/tree') &&
	      apiSource.includes('/api/files/file') &&
	      apiSource.includes('/api/files/raw') &&
	      apiSource.includes('/api/files/move') &&
	      apiSource.includes('/api/files/entry') &&
      apiSource.includes('/api/files/search') &&
      apiSource.includes('/api/files/blame') &&
      apiSource.includes('/api/files/blame-capability') &&
      apiSource.includes('/api/files/diff') &&
      apiSource.includes('/api/files/changes') &&
      apiSource.includes('/api/files/line-changes') &&
	      apiSource.includes('moveWorkspaceEntry') &&
	      apiSource.includes('createWorkspaceEntry') &&
	      apiSource.includes('renameWorkspaceEntry') &&
	      apiSource.includes('deleteWorkspaceEntry') &&
      apiSource.includes('new URLSearchParams({ agentId, path: filePath })') &&
	      apiSource.includes('searchWorkspaceFiles') &&
	      apiSource.includes('fetchWorkspaceDiff') &&
	      apiSource.includes('fetchWorkspaceChanges') &&
	      apiSource.includes('WorkspaceFileChanges') &&
	      apiSource.includes('WorkspaceFileDiff') &&
      apiSource.includes('fetchWorkspaceLineChanges') &&
      apiSource.includes('WorkspaceFileLineChanges') &&
      apiSource.includes('WorkspaceFileSearchMatch') &&
      apiSource.includes("kind?: 'content' | 'path'") &&
      apiSource.includes('fetchWorkspaceBlame') &&
      apiSource.includes('fetchWorkspaceBlameCapability') &&
      apiSource.includes('rawWorkspaceFileUrl') &&
	      apiSource.includes("kind: 'image'") &&
	      apiSource.includes("kind: 'binary'") &&
	      apiSource.includes("kind: 'large-text'") &&
	      apiSource.includes('WorkspaceFileApiError') &&
      apiSource.includes('baseSha1') &&
      apiSource.includes('overwrite'),
    'workspace-files API client should wrap the lightweight editing backend'
  );

  assert(
    messagesSource.includes("type: 'watch-workspace-files'") &&
      messagesSource.includes("type: 'workspace-file-event'") &&
      messagesSource.includes('agentId?: string') &&
      messagesSource.includes('WorkspaceFileEventMessage'),
    'WebSocket message types should include workspace file watch and event messages'
  );

  assert(
    serverSource.includes('workspaceFileUnsubscribes') &&
      serverSource.includes('new Map()') &&
      serverSource.includes('clearWorkspaceFileWatch(ws, data.agentId)') &&
      serverSource.includes('ws.workspaceFileUnsubscribes.set(data.agentId, unsubscribe)'),
    'server should keep workspace file watchers per agent instead of one watcher per WebSocket'
  );

  assert(
    monacoHostStyle.includes('overflow: hidden') &&
      !monacoHostStyle.includes('overflow: auto'),
    'Monaco editor host should not create a second scrolling layer around Monaco'
  );

  assert(
    singleTerminalGridStyle.includes('overflow: hidden'),
    'Single-pane terminal grid should not create an outer scrolling layer over the Ghostty viewport'
  );

  assert(
      stylesSource.includes('.code-files-section') &&
      stylesSource.includes('.code-project-expanded') &&
      stylesSource.includes('.code-file-search-box') &&
      stylesSource.includes('.code-file-search-results') &&
      stylesSource.includes('.code-file-search-result') &&
      stylesSource.includes('.code-file-search-preview') &&
      stylesSource.includes('.code-file-search-highlight') &&
      stylesSource.includes('.code-files-title') &&
      stylesSource.includes('.code-file-section-chevron') &&
      stylesSource.includes('.code-open-editors-header,\n.code-files-header {\n  position: sticky') &&
      stylesSource.includes('z-index: 10') &&
      !stylesSource.includes('.code-file-header-actions') &&
      !stylesSource.includes('.code-file-header-action') &&
      stylesSource.includes('grid-template-columns: minmax(0, 1fr)') &&
      stylesSource.includes('.code-file-search-box .code-file-search-icon') &&
      stylesSource.includes('width: 100%;') &&
      !stylesSource.includes('.code-file-action-icon.new-file') &&
      !stylesSource.includes('.code-file-action-icon.new-folder') &&
      !stylesSource.includes('.code-file-action-icon.refresh') &&
      !stylesSource.includes('.code-file-action-icon.collapse') &&
      stylesSource.includes('.code-file-operation-shell') &&
      stylesSource.includes('.code-file-operation-shell.delete-confirm') &&
      stylesSource.includes('.code-file-inline-operation') &&
      stylesSource.includes('.code-file-inline-operation input') &&
      stylesSource.includes('.code-file-operation-dialog') &&
      stylesSource.includes('.code-file-operation-dialog input:focus') &&
      stylesSource.includes('.code-file-operation-dialog .code-rename-actions button') &&
      stylesSource.includes('.code-file-tree-viewport') &&
      stylesSource.includes('flex: 0 0 auto') &&
      !stylesSource.includes('.code-file-tree-viewport::before') &&
      !stylesSource.includes('.code-file-tree-viewport::after') &&
      !stylesSource.includes('has-top-shadow') &&
      !stylesSource.includes('has-bottom-shadow') &&
      stylesSource.includes('.code-file-sticky-shell') &&
      stylesSource.includes('position: sticky') &&
      stylesSource.includes('--code-project-sticky-height: 30px') &&
      stylesSource.includes('min-height: var(--code-project-sticky-height)') &&
      stylesSource.includes('top: var(--code-project-sticky-height)') &&
      stylesSource.includes('box-sizing: border-box;\n  margin-left: 0;\n  margin-right: 2px;\n  padding-left: 14px;') &&
      stylesSource.includes('--code-agents-sticky-height: 0px') &&
      stylesSource.includes('top: calc(var(--code-project-sticky-height) + var(--code-agents-sticky-height, 0px))') &&
      stylesSource.includes('z-index: 11') &&
      stylesSource.includes('.code-file-sticky-stack') &&
      stylesSource.includes('box-shadow: 0 10px 14px -16px') &&
      stylesSource.includes('.code-file-row.code-file-sticky-row') &&
      stylesSource.includes('.code-file-row.code-file-sticky-context') &&
      stylesSource.includes('cursor: pointer') &&
      stylesSource.includes('.code-file-row.code-file-sticky-context.open-editors') &&
      stylesSource.includes('.code-file-row.code-file-sticky-context.files') &&
      !stylesSource.includes('.code-file-row.code-file-sticky-context.project') &&
      !stylesSource.includes('.code-agent-list {\n  position: sticky') &&
      stylesSource.includes('.code-file-tree-row-frame') &&
      stylesSource.includes('.code-file-row') &&
      stylesSource.includes('min-width: 0') &&
	      !stylesSource.includes('margin-left: -14px') &&
	      !stylesSource.includes('margin-left: -6px') &&
	      stylesSource.includes('.code-file-row.active') &&
	      stylesSource.includes('.code-file-row.active::after') &&
	      stylesSource.includes('background: rgba(82, 99, 135, 0.075)') &&
	      stylesSource.includes('border: 0 !important') &&
      stylesSource.includes('.code-file-row:focus-visible') &&
      stylesSource.includes('.code-file-row.focused') &&
      stylesSource.includes('.code-file-row.selected:not(.active)') &&
      !stylesSource.includes('.code-file-row.drop-target') &&
      !stylesSource.includes('.code-file-drop-cursor') &&
      !stylesSource.includes('.code-file-drag-layer') &&
      !stylesSource.includes('.code-file-drag-preview') &&
      !stylesSource.includes('.code-file-drag-count') &&
      stylesSource.includes('.code-file-row.editor-dirty .code-file-name') &&
      !stylesSource.includes('.code-file-row.editor-descendant-dirty .code-file-name') &&
      !stylesSource.includes('.code-file-row.editor-descendant-external-changed .code-file-name') &&
      !stylesSource.includes('.code-file-row.directory .code-file-type-icon') &&
      !stylesSource.includes('grid-template-columns: 14px minmax(0, 1fr) auto') &&
      !stylesSource.includes('.code-files-header-chevron') &&
      stylesSource.includes('.code-file-chevron::before') &&
      stylesSource.includes('.code-file-chevron.expanded::before') &&
      stylesSource.includes('.code-file-chevron.placeholder::before') &&
      stylesSource.includes('--file-guide-width') &&
      stylesSource.includes('.code-file-row::before') &&
      stylesSource.includes('repeating-linear-gradient') &&
      stylesSource.includes('opacity: 0.32') &&
      stylesSource.includes('rgba(97, 105, 94, 0.14) 11px') &&
      stylesSource.includes('.code-file-type-icon') &&
      stylesSource.includes('object-fit: contain') &&
      !stylesSource.includes('.code-file-type-icon.file::before') &&
      !stylesSource.includes('.code-file-type-icon.file::after') &&
      !stylesSource.includes('.code-file-row.git-descendant .code-file-name') &&
      !stylesSource.includes('.code-file-row.git-modified .code-file-name') &&
      !stylesSource.includes('.code-file-row.git-added .code-file-name') &&
      stylesSource.includes('.code-file-row.git-status .code-file-name') &&
      stylesSource.includes('font-weight: 500') &&
      !stylesSource.includes('.code-file-row.git-untracked .code-file-name') &&
      !stylesSource.includes('.code-file-row.git-descendant-deleted .code-file-name') &&
      !stylesSource.includes('.code-file-row.git-descendant-conflicted .code-file-name') &&
      !stylesSource.includes('.code-file-row.git-descendant-untracked .code-file-name') &&
      stylesSource.includes('.code-file-git-status') &&
      !stylesSource.includes('.code-file-git-status.untracked') &&
      stylesSource.includes('.code-file-descendant-status') &&
      !stylesSource.includes('.code-file-descendant-status.untracked') &&
      stylesSource.includes('.code-file-changed.external') &&
      stylesSource.includes('.code-file-descendant-status.dirty') &&
      stylesSource.includes('overflow: visible !important') &&
      stylesSource.includes('scrollbar-width: none') &&
      stylesSource.includes('.code-file-tree-viewport [role="tree"]:focus') &&
      stylesSource.includes('.code-file-tree::-webkit-scrollbar') &&
      !stylesSource.includes('height: min(52vh, 520px)') &&
      !stylesSource.includes('overflow: auto !important') &&
      stylesSource.includes('scroll-behavior: smooth') &&
      !stylesSource.includes("content: '◇'") &&
      stylesSource.includes('.code-file-operation-text') &&
      stylesSource.includes('.code-file-sticky-stack') &&
      stylesSource.includes('.code-file-sticky-row') &&
      stylesSource.includes('@media (min-width: 700px) and (max-width: 980px)') &&
      stylesSource.includes('grid-template-columns: clamp(260px, 40vw, 340px) minmax(0, 1fr);') &&
      stylesSource.includes('.code-file-editor-tabs') &&
      stylesSource.includes('overflow-x: auto') &&
      stylesSource.includes('overscroll-behavior-x: contain') &&
      stylesSource.includes('scrollbar-width: none') &&
      stylesSource.includes('.code-file-editor-tabs::-webkit-scrollbar') &&
      stylesSource.includes('.code-file-editor-tab') &&
      stylesSource.includes('.code-file-editor-tab.active') &&
      !stylesSource.includes('.code-file-editor-tab.dirty') &&
      stylesSource.includes('.code-file-editor-tab:focus-visible') &&
      stylesSource.includes('.code-file-editor-tab-name') &&
      stylesSource.includes('.code-file-editor-tab-tail') &&
      stylesSource.includes('.code-file-editor-breadcrumbs') &&
      stylesSource.includes('.code-file-editor-breadcrumb.current') &&
      stylesSource.includes('.code-file-editor-breadcrumb:hover') &&
      stylesSource.includes('cursor: pointer') &&
      stylesSource.includes('.code-file-editor-breadcrumb-separator::before') &&
      stylesSource.includes('.code-file-editor-close') &&
      stylesSource.includes('.code-file-editor-close::before') &&
      stylesSource.includes('.code-file-editor-close::after') &&
      stylesSource.includes('.code-file-editor-action.diff::before') &&
      stylesSource.includes('.code-file-editor-action.diff::after') &&
      stylesSource.includes('.code-file-editor-action.reload::before') &&
      stylesSource.includes('.code-file-editor-action.reload::after') &&
      !stylesSource.includes('.code-file-editor-action.blame::before') &&
      !stylesSource.includes('.code-file-editor-action.blame::after') &&
      !stylesSource.includes("content: 'B'") &&
      stylesSource.includes('.code-file-editor-action-icon') &&
      stylesSource.includes('.code-file-editor-action.overwrite::before') &&
      stylesSource.includes('.code-file-editor-action.overwrite::after') &&
      !stylesSource.includes('.code-file-row.changed .code-file-name') &&
      !stylesSource.includes('.code-file-row.changed-descendant .code-file-name') &&
      stylesSource.includes('.code-file-editor-tab:hover .code-file-editor-dirty') &&
      !stylesSource.includes('.code-file-blame-panel') &&
      !stylesSource.includes('.code-file-blame-row') &&
      stylesSource.includes('.code-file-inline-blame-layer') &&
      stylesSource.includes('pointer-events: none') &&
      stylesSource.includes('.code-file-inline-blame') &&
      stylesSource.includes('position: absolute') &&
      stylesSource.includes('pointer-events: auto') &&
      stylesSource.includes('.code-file-inline-blame.uncommitted') &&
      stylesSource.includes('.code-file-blame-toast') &&
      stylesSource.includes('.code-file-blame-detail') &&
      stylesSource.includes('.code-file-blame-detail-main') &&
      stylesSource.includes('.code-file-blame-detail-title code') &&
      stylesSource.includes('.code-file-blame-detail-row') &&
      stylesSource.includes('.code-file-blame-detail-close') &&
      stylesSource.includes('.code-editor-context-menu') &&
      stylesSource.includes('.code-editor-context-separator') &&
      stylesSource.includes('.code-file-editor') &&
      stylesSource.includes('.code-file-editor-statusbar') &&
      !stylesSource.includes('.code-file-changes-section') &&
      !stylesSource.includes('.code-file-change-row') &&
      !stylesSource.includes('.code-file-change-status.modified') &&
      stylesSource.includes('.code-file-diff-view') &&
      stylesSource.includes('.code-file-diff-header') &&
      stylesSource.includes('.code-file-diff-monaco') &&
      stylesSource.includes('.code-file-diff-state') &&
      stylesSource.includes('.code-file-preview-panel') &&
      stylesSource.includes('.code-file-image-preview') &&
      stylesSource.includes('.code-file-metadata-preview-icon') &&
      stylesSource.includes('.code-file-line-changes-panel') &&
      stylesSource.includes('.code-file-line-changes-patch') &&
      stylesSource.includes('.code-file-line-changes-line.added') &&
      stylesSource.includes('.code-file-line-changes-line.deleted') &&
      stylesSource.includes('.code-file-monaco.hidden') &&
      stylesSource.includes('.code-file-diff-monaco.hidden') &&
      !stylesSource.includes('.code-file-editor-line-blame') &&
      !stylesSource.includes('.code-file-editor-line-blame-separator') &&
      !stylesSource.includes('.code-file-editor-line-blame-summary') &&
      stylesSource.includes('.code-file-editor-cursor-position') &&
      stylesSource.includes('font-variant-numeric: tabular-nums') &&
      stylesSource.includes('.code-file-monaco'),
    'main.css should style the Files section and editor pane with a clean borderless VS Code-like virtualized Explorer and tab strip'
  );

  assert(
    editorMonacoSource.includes("const CODEX_LIGHT_MONACO_THEME = 'farming-code-light'") &&
      editorMonacoSource.includes("const CODEX_DARK_MONACO_THEME = 'farming-code-dark'") &&
      editorMonacoSource.includes('function defineCodexMonacoThemes') &&
      editorMonacoSource.includes('editor?.updateOptions({ theme })') &&
      editorMonacoSource.includes('window.requestAnimationFrame(() => editor.layout())') &&
      editorMonacoControllerSource.includes('new MutationObserver(() => applyWorkspaceEditorMonacoTheme(editor))') &&
	      darkStylesSource.includes(".code-file-monaco,\nbody.code-mode[data-appearance='dark'] .code-file-diff-view") &&
	      darkStylesSource.includes(".code-file-diff-monaco,\nbody.code-mode[data-appearance='dark'] .code-file-preview-panel") &&
      darkStylesSource.includes('.code-file-inline-blame') &&
      !darkStylesSource.includes('.code-file-changes-section') &&
      !darkStylesSource.includes('.code-file-change-row.active') &&
      !darkStylesSource.includes('.code-file-change-status.modified') &&
      darkStylesSource.includes('.code-file-blame-toast') &&
      darkStylesSource.includes('.code-file-blame-detail') &&
      darkStylesSource.includes('.code-file-line-changes-panel') &&
      darkStylesSource.includes('.code-file-line-changes-line.added') &&
      darkStylesSource.includes('.code-file-line-changes-line.deleted') &&
      darkStylesSource.includes('.code-editor-context-menu') &&
      darkStylesSource.includes('.code-file-save-confirm-dialog'),
    'Project Files editor should keep Monaco and file-operation overlays synchronized with light/dark appearance changes'
  );

  console.log('✓ Project Files section and editor frontend are wired');
}

run();
