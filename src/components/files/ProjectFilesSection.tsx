import { useCallback, useEffect, useRef } from 'react'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-file-search'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'
import {
  type WorkspaceFile,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileMove,
} from '@/lib/workspace-files'
import type { AgentLaunchOption } from '../code/agent-launch-options'
import type { CodeCopy } from '../code/copy'
import { FileSectionBody } from './FileSectionBody'
import { FileSectionHeader } from './FileSectionHeader'
import { FileSectionOverlays } from './FileSectionOverlays'
import { OpenEditorsSection, type OpenProjectFileSummary } from './OpenEditorsSection'
import { useProjectFilesSectionViewModel } from './useProjectFilesSectionViewModel'
import { useWorkspaceFileFocus } from './useWorkspaceFileFocus'
import { useWorkspaceFileExplorer } from './useWorkspaceFileExplorer'
import { useWorkspaceFileMenuController } from './useWorkspaceFileMenuController'
import { useWorkspaceFileOpenController } from './useWorkspaceFileOpenController'
import { useWorkspaceFileOperationController } from './useWorkspaceFileOperationController'
import { useWorkspaceFileSearch } from './useWorkspaceFileSearch'
import { useWorkspaceFileSearchController } from './useWorkspaceFileSearchController'
import { useWorkspaceFileSectionController } from './useWorkspaceFileSectionController'
import { useWorkspaceFileStickyContext } from './useWorkspaceFileStickyContext'
import { useWorkspaceFileTreeController } from './useWorkspaceFileTreeController'
import { useWorkspaceFileTreeKeyboard } from './useWorkspaceFileTreeKeyboard'

const FILE_ROW_HEIGHT = 24
const EMPTY_FILE_PATHS = new Set<string>()

interface ProjectFilesSectionProps {
  projectId: string
  projectWorkspace: string
  agentId: string | null
  agentLaunchOptions: AgentLaunchOption[]
  activeFilePath?: string
  revealRequest?: { path: string; kind: 'directory' | 'file'; requestId: number }
  focusSearchRequest?: { requestId: number; query?: string }
  editorDirtyFilePaths?: ReadonlySet<string>
  editorExternalChangedFilePaths?: ReadonlySet<string>
  openFiles?: OpenProjectFileSummary[]
  onOpenFile: (agentId: string, file: WorkspaceFile, target?: WorkspaceFileOpenTarget) => void
  onSelectOpenFile?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onCloseOpenFile?: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onNewAgent?: (workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null) => void
  onStartAgent?: (command: string, workspace: string, options?: { projectWorkspace?: string }) => void
  onMoveEntries: (agentId: string, moves: WorkspaceFileMove[]) => void
  onDeleteEntries: (agentId: string, deletions: WorkspaceFileDeleteResult[]) => void
  copy: CodeCopy
}

function safeDomIdPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'root'
}

function joinWorkspaceDirectory(workspaceRoot: string, relativeDirectory: string) {
  const root = workspaceRoot.replace(/\/+$/, '') || '/'
  const relative = relativeDirectory.replace(/^\/+|\/+$/g, '')
  if (!relative) return root
  return root === '/' ? `/${relative}` : `${root}/${relative}`
}

function filePathBasename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function openEditorFileContextNode(file: OpenProjectFileSummary): WorkspaceFileTreeNode {
  return {
    id: file.path,
    name: filePathBasename(file.path),
    path: file.path,
    type: 'file',
    size: 0,
    mtimeMs: 0,
  }
}

export function ProjectFilesSection({
  projectId,
  projectWorkspace,
  agentId,
  agentLaunchOptions,
  activeFilePath,
  revealRequest,
  focusSearchRequest,
  editorDirtyFilePaths = EMPTY_FILE_PATHS,
  editorExternalChangedFilePaths = EMPTY_FILE_PATHS,
  openFiles = [],
  onOpenFile,
  onSelectOpenFile,
  onCloseOpenFile,
  onNewAgent,
  onStartAgent,
  onMoveEntries,
  onDeleteEntries,
  copy,
}: ProjectFilesSectionProps) {
  const {
    directories,
    treeData,
    openDirectoryPaths,
    visibleTreeRowCount,
    loadRootDirectory,
    ensureDirectoryLoaded,
    isDirectoryLoaded,
    loadMissingDirectories,
    refreshDirectories,
    hydrateCompactDirectoryChains,
    syncOpenDirectoryPaths,
    setDirectoryOpen,
    openDirectoriesInLayout,
  } = useWorkspaceFileExplorer(agentId)

  const fileOperationActiveRef = useRef(false)
  const fileSearchInputRef = useRef<HTMLInputElement | null>(null)
  const fileSearchResultsRef = useRef<HTMLDivElement | null>(null)
  const lastAutoRevealedActivePathRef = useRef<string | null>(null)
  const fileSearch = useWorkspaceFileSearch(agentId)
  const fileSearchListboxId = `code-file-search-results-${safeDomIdPart(projectId)}`

  const {
    treeRef,
    treeViewportRef,
    lastFocusedFilePathRef,
    treeHeight,
    handleTreeToggle,
    refreshTreeLayout,
    rememberFocusedTreeNode,
    rememberSelectedTreeNodes,
    renderFileTreeRow,
  } = useWorkspaceFileTreeController({
    rowHeight: FILE_ROW_HEIGHT,
    visibleTreeRowCount,
    hydrateCompactDirectoryChains,
    setDirectoryOpen,
    syncOpenDirectoryPaths,
  })

  const {
    cancelPendingFileFocus,
    focusFileSearchInput,
    focusFileTreeFromSearch,
    focusFileTreePath,
    focusFileTreeTarget,
    revealExplorerPath,
    revealFilePath,
  } = useWorkspaceFileFocus({
    treeRef,
    treeViewportRef,
    fileSearchInputRef,
    fileOperationActiveRef,
    lastFocusedFilePathRef,
    treeData,
    isDirectoryLoaded,
    loadMissingDirectories,
    openDirectoriesInLayout,
    refreshTreeLayout,
  })

  const clearFileSearch = fileSearch.clear

  const {
    openFileError,
    openFilePath,
    setOpenFileError,
  } = useWorkspaceFileOpenController({
    agentId,
    onClearSearch: clearFileSearch,
    onOpenFile,
    onRevealFilePath: revealFilePath,
    onSelectOpenFile,
  })

  const {
    fileOperation,
    fileOperationInputRef,
    clearFileOperation,
    closeFileOperation,
    rememberFileOperationName,
    startFileOperation: startFileOperationController,
    submitFileOperation,
    updateFileOperationName,
  } = useWorkspaceFileOperationController({
    agentId,
    fileOperationActiveRef,
    ensureDirectoryLoaded,
    focusFileTreePath,
    onDeleteEntries,
    onMoveEntries,
    onOpenFile,
    refreshDirectories,
    setOpenFileError,
  })

  const {
    fileMenu,
    fileMenuRef,
    clearFileMenu,
    closeFileMenuWithFocusRestore,
    closeFileMenuWithoutFocus,
    copyFileMenuPath,
    fileMenuTargetDirectory,
    openFileContextMenu,
    refreshFileMenuTarget,
    startFileMenuOperation,
  } = useWorkspaceFileMenuController({
    agentId,
    agentLaunchOptionCount: agentLaunchOptions.length,
    cancelPendingFileFocus,
    clearFileOperation,
    focusFileTreeTarget,
    refreshDirectories,
    setOpenFileError,
    startFileOperation: startFileOperationController,
  })

  const updateFileSearchQuery = useCallback((query: string) => {
    setOpenFileError(null)
    fileSearch.setQuery(query)
  }, [fileSearch.setQuery, setOpenFileError])

  const fileMenuLaunchWorkspace = useCallback(() => (
    joinWorkspaceDirectory(projectWorkspace, fileMenuTargetDirectory())
  ), [fileMenuTargetDirectory, projectWorkspace])

  const openNewAgentFromFileMenu = useCallback(() => {
    if (!onNewAgent) return
    closeFileMenuWithoutFocus()
    onNewAgent(projectWorkspace)
  }, [closeFileMenuWithoutFocus, onNewAgent, projectWorkspace])

  const startAgentFromFileMenu = useCallback((command: string) => {
    if (!onStartAgent) return
    const workspace = fileMenuLaunchWorkspace()
    closeFileMenuWithoutFocus()
    onStartAgent(command, workspace, workspace === projectWorkspace ? undefined : { projectWorkspace })
  }, [closeFileMenuWithoutFocus, fileMenuLaunchWorkspace, onStartAgent, projectWorkspace])

  const openEditorContextMenu = useCallback((x: number, y: number, file: OpenProjectFileSummary) => {
    openFileContextMenu(x, y, openEditorFileContextNode(file))
  }, [openFileContextMenu])

  const {
    filesCollapsed,
    openEditorsCollapsed,
    toggleFilesCollapsed,
    toggleOpenEditorsCollapsed,
  } = useWorkspaceFileSectionController({
    agentId,
    clearFileMenu,
    clearFileOperation,
    clearFileSearch,
    focusFileSearchInput,
    focusSearchRequest,
    loadRootDirectory,
    openFilesCount: openFiles.length,
    refreshTreeLayout,
    revealExplorerPath,
    revealRequest,
    rootDirectoryLoaded: Boolean(directories['']),
    setFileSearchQuery: fileSearch.setQuery,
    setOpenFileError,
    treeData,
  })

  useEffect(() => {
    if (!activeFilePath || filesCollapsed || !directories['']) return
    if (lastAutoRevealedActivePathRef.current === activeFilePath) return
    lastAutoRevealedActivePathRef.current = activeFilePath
    void revealFilePath(activeFilePath)
  }, [activeFilePath, directories, filesCollapsed, revealFilePath])

  const {
    focusStickyDirectory,
    revealOpenEditorsSection,
    stickyContextItems,
  } = useWorkspaceFileStickyContext({
    filesCollapsed,
    filesLabel: copy.files,
    focusFileTreePath,
    lastFocusedFilePathRef,
    openDirectoryPaths,
    openEditorsLabel: copy.openEditors,
    openFilesCount: openFiles.length,
    refreshTreeLayout,
    resetKey: agentId,
    treeData,
    treeViewportRef,
  })

  const {
    activeOptionId: activeSearchOptionId,
    handleFileSearchKeyDown,
    openFileJumpQuery,
    openFileSearchMatch,
  } = useWorkspaceFileSearchController({
    fileMenuOpen: Boolean(fileMenu),
    fileOperationActive: Boolean(fileOperation),
    fileSearch,
    fileSearchResultsRef,
    filesCollapsed,
    focusFileTreeFromSearch,
    listboxId: fileSearchListboxId,
    onOpenFilePath: openFilePath,
    onRevealDirectoryPath: directoryPath => revealExplorerPath(directoryPath, 'directory'),
  })

  const { handleTreeKeyDownCapture } = useWorkspaceFileTreeKeyboard({
    treeRef,
    treeViewportRef,
    lastFocusedFilePathRef,
    fileOperation,
    openDirectoryPaths,
    cancelPendingFileFocus,
    closeFileOperation,
    focusFileSearchInput,
    focusFileTreePath,
    focusFileTreeTarget,
    openFileContextMenu,
    openFilePath,
    startFileOperation: startFileMenuOperation,
  })

  const viewModel = useProjectFilesSectionViewModel({
    activeFilePath,
    activeSearchOptionId,
    agentId: agentId ?? '',
    agentLaunchOptions,
    copy,
    editorDirtyFilePaths,
    editorExternalChangedFilePaths,
    fileMenu,
    fileMenuRef,
    fileOperation,
    fileOperationInputRef,
    fileSearch,
    fileSearchInputRef,
    fileSearchListboxId,
    fileSearchResultsRef,
    filesCollapsed,
    handleFileSearchKeyDown,
    handleTreeKeyDownCapture,
    lastFocusedFilePathRef,
    openEditorsCollapsed,
    openFileError,
    projectId,
    renderFileTreeRow,
    rootDirectoryError: directories['']?.error ?? null,
    rootDirectoryHasItems: Boolean(directories['']?.items.length),
    rootDirectoryLoading: Boolean(directories['']?.loading),
    rowHeight: FILE_ROW_HEIGHT,
    stickyContextItems,
    treeData,
    treeHeight,
    treeRef,
    treeViewportRef,
    visibleTreeRowCount,
    onCancelPendingFileFocus: cancelPendingFileFocus,
    onCloseFileMenuWithFocusRestore: closeFileMenuWithFocusRestore,
    onCloseFileMenuWithoutFocus: closeFileMenuWithoutFocus,
    onCloseFileOperation: closeFileOperation,
    onCloseOpenFile,
    onCopyFileMenuPath: copyFileMenuPath,
    onFocusFileTreeTarget: focusFileTreeTarget,
    onFocusStickyDirectory: focusStickyDirectory,
    onOpenFileContextMenu: openFileContextMenu,
    onOpenFileJumpQuery: openFileJumpQuery,
    onOpenFilePath: openFilePath,
    onOpenFileSearchMatch: openFileSearchMatch,
    onOpenNewAgentFromFileMenu: openNewAgentFromFileMenu,
    onRefreshFileMenuTarget: refreshFileMenuTarget,
    onRememberFileOperationName: rememberFileOperationName,
    onRevealOpenEditors: revealOpenEditorsSection,
    onSearchQueryChange: updateFileSearchQuery,
    onSelectOpenFile,
    onSelectSearchMatchIndex: fileSearch.selectMatchIndex,
    onStartAgentFromFileMenu: startAgentFromFileMenu,
    onStartFileMenuOperation: startFileMenuOperation,
    onSubmitFileOperation: submitFileOperation,
    onToggleFilesCollapsed: toggleFilesCollapsed,
    onToggleOpenEditorsCollapsed: toggleOpenEditorsCollapsed,
    onToggleTreeNode: handleTreeToggle,
    onTreeFocus: rememberFocusedTreeNode,
    onTreeSelect: rememberSelectedTreeNodes,
    onUpdateFileOperationName: updateFileOperationName,
  })

  if (!agentId) {
    return null
  }

  return (
    <>
      <OpenEditorsSection
        {...viewModel.openEditors}
        files={openFiles}
        onOpenFileContextMenu={openEditorContextMenu}
      />
      <div className={`code-files-section ${filesCollapsed ? 'collapsed' : ''}`} data-testid="code-files-section" data-project-id={projectId}>
        <FileSectionHeader {...viewModel.sectionHeader} />
        {!filesCollapsed && (
          <FileSectionBody {...viewModel.sectionBody} />
        )}
      </div>
      {filesCollapsed && (
        <FileSectionOverlays
          agentId={agentId}
          copy={copy}
          agentLaunchOptions={agentLaunchOptions}
          fileMenu={fileMenu}
          fileOperation={fileOperation}
          fileMenuRef={fileMenuRef}
          fileOperationInputRef={fileOperationInputRef}
          onCloseFileMenu={closeFileMenuWithoutFocus}
          onCloseFileMenuWithFocusRestore={closeFileMenuWithFocusRestore}
          onCloseFileOperation={closeFileOperation}
          onCopyFileMenuPath={copyFileMenuPath}
          onOpenNewAgent={openNewAgentFromFileMenu}
          onRefreshFileMenuTarget={refreshFileMenuTarget}
          onRememberFileOperationName={rememberFileOperationName}
          onStartAgent={startAgentFromFileMenu}
          onStartFileMenuOperation={startFileMenuOperation}
          onSubmitFileOperation={submitFileOperation}
          onUpdateFileOperationName={updateFileOperationName}
        />
      )}
    </>
  )
}
