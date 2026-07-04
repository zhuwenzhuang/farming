import { useCallback, useRef } from 'react'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-file-search'
import {
  type WorkspaceFile,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileMove,
} from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'
import { FileSectionBody } from './FileSectionBody'
import { FileSectionHeader } from './FileSectionHeader'
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
  agentId: string | null
  activeFilePath?: string
  revealRequest?: { path: string; kind: 'directory' | 'file'; requestId: number }
  focusSearchRequest?: { requestId: number; query?: string }
  editorDirtyFilePaths?: ReadonlySet<string>
  editorExternalChangedFilePaths?: ReadonlySet<string>
  openFiles?: OpenProjectFileSummary[]
  onOpenFile: (agentId: string, file: WorkspaceFile, target?: WorkspaceFileOpenTarget) => void
  onSelectOpenFile?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onCloseOpenFile?: (agentId: string, filePath: string) => void
  onMoveEntries: (agentId: string, moves: WorkspaceFileMove[]) => void
  onDeleteEntries: (agentId: string, deletions: WorkspaceFileDeleteResult[]) => void
  copy: CodeCopy
}

function safeDomIdPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'root'
}

export function ProjectFilesSection({
  projectId,
  agentId,
  activeFilePath,
  revealRequest,
  focusSearchRequest,
  editorDirtyFilePaths = EMPTY_FILE_PATHS,
  editorExternalChangedFilePaths = EMPTY_FILE_PATHS,
  openFiles = [],
  onOpenFile,
  onSelectOpenFile,
  onCloseOpenFile,
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
    openFileContextMenu,
    refreshFileMenuTarget,
    startFileMenuOperation,
  } = useWorkspaceFileMenuController({
    agentId,
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
    hydrateCompactDirectoryChains,
    openFileContextMenu,
    openFilePath,
    refreshTreeLayout,
    setDirectoryOpen,
    startFileOperation: startFileMenuOperation,
  })

  const viewModel = useProjectFilesSectionViewModel({
    activeFilePath,
    activeSearchOptionId,
    agentId: agentId ?? '',
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
    onHydrateCompactDirectoryChains: hydrateCompactDirectoryChains,
    onOpenFileContextMenu: openFileContextMenu,
    onOpenFileJumpQuery: openFileJumpQuery,
    onOpenFilePath: openFilePath,
    onOpenFileSearchMatch: openFileSearchMatch,
    onRefreshFileMenuTarget: refreshFileMenuTarget,
    onRefreshTreeLayout: refreshTreeLayout,
    onRememberFileOperationName: rememberFileOperationName,
    onRevealOpenEditors: revealOpenEditorsSection,
    onSearchQueryChange: updateFileSearchQuery,
    onSelectOpenFile,
    onSelectSearchMatchIndex: fileSearch.selectMatchIndex,
    onSetDirectoryOpen: setDirectoryOpen,
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
      />
      <div className={`code-files-section ${filesCollapsed ? 'collapsed' : ''}`} data-testid="code-files-section" data-project-id={projectId}>
        <FileSectionHeader {...viewModel.sectionHeader} />
        {!filesCollapsed && (
          <FileSectionBody {...viewModel.sectionBody} />
        )}
      </div>
    </>
  )
}
