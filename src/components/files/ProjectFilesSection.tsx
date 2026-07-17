import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-file-search'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'
import {
  type WorkspaceFile,
  type WorkspaceFileChange,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileMove,
} from '@/lib/workspace-files'
import { workspaceFileOpenTargetForChange } from '@/lib/workspace-open-files'
import type { AgentLaunchOption } from '../code/agent-launch-options'
import type { CodeCopy } from '../code/copy'
import { FileChangesSection } from './FileChangesSection'
import { FileSectionBody } from './FileSectionBody'
import { FileSectionHeader, type FileSectionRefreshStatus } from './FileSectionHeader'
import { FileSectionOverlays } from './FileSectionOverlays'
import { GitHistorySection } from './GitHistorySection'
import {
  OpenEditorsSection,
  OPEN_EDITOR_ROW_HEIGHT,
  OPEN_EDITORS_HEADER_HEIGHT,
  OPEN_EDITORS_VISIBLE_ROW_LIMIT,
  type OpenProjectFileSummary,
} from './OpenEditorsSection'
import { useProjectFilesSectionViewModel } from './useProjectFilesSectionViewModel'
import { useWorkspaceFileChanges } from './useWorkspaceFileChanges'
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
const FILES_REFRESH_MINIMUM_PENDING_MS = 350
const FILES_REFRESH_SUCCESS_VISIBLE_MS = 1400
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
  onRefreshOpenFiles?: (filesId: string, workspaceRoot: string) => Promise<boolean>
  onFilesCollapsedChange?: (collapsed: boolean) => void
  readOnly?: boolean
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
  onRefreshOpenFiles,
  onFilesCollapsedChange,
  readOnly = false,
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
    isDirectoryOpen,
    setDirectoryOpen,
    openDirectoriesInLayout,
  } = useWorkspaceFileExplorer(agentId, projectId)

  const fileOperationActiveRef = useRef(false)
  const fileSearchInputRef = useRef<HTMLInputElement | null>(null)
  const fileSearchResultsRef = useRef<HTMLDivElement | null>(null)
  const lastAutoRevealedActivePathRef = useRef<string | null>(null)
  const filesRefreshInFlightRef = useRef(false)
  const filesRefreshRequestRef = useRef(0)
  const filesRefreshResetTimerRef = useRef<number | null>(null)
  const [filesRefreshStatus, setFilesRefreshStatus] = useState<FileSectionRefreshStatus>('idle')
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
    setTreePathOpen,
    toggleTreePathOpen,
  } = useWorkspaceFileTreeController({
    rowHeight: FILE_ROW_HEIGHT,
    visibleTreeRowCount,
    openDirectoryPaths,
    treeData,
    hydrateCompactDirectoryChains,
    isDirectoryOpen,
    setDirectoryOpen,
  })

  const {
    cancelPendingFileFocus,
    focusFileSearchInput,
    focusFileTreeFromSearch,
    focusFileTreePath,
    focusFileTreeTarget,
    locatedFilePath,
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
    openFilePendingPath,
    openFilePath,
    setOpenFileError,
  } = useWorkspaceFileOpenController({
    agentId,
    onClearSearch: clearFileSearch,
    onOpenFile,
    onRevealFilePath: revealFilePath,
    onSelectOpenFile,
  })

  const fileChanges = useWorkspaceFileChanges(readOnly ? null : agentId, openFiles)
  const [changesCollapsed, setChangesCollapsed] = useState(true)

  const refreshProjectFiles = useCallback(() => {
    if (filesRefreshInFlightRef.current) return
    filesRefreshInFlightRef.current = true
    const requestId = filesRefreshRequestRef.current + 1
    filesRefreshRequestRef.current = requestId
    if (filesRefreshResetTimerRef.current !== null) {
      window.clearTimeout(filesRefreshResetTimerRef.current)
      filesRefreshResetTimerRef.current = null
    }
    setFilesRefreshStatus('refreshing')
    setOpenFileError(null)
    const loadedDirectoryPaths = ['', ...openDirectoryPaths]
    const minimumPending = new Promise<void>(resolve => {
      window.setTimeout(resolve, FILES_REFRESH_MINIMUM_PENDING_MS)
    })
    void (async () => {
      let refreshed = false
      try {
        const changesRefreshed = await fileChanges.refreshChanges()
        const [directoriesRefreshed, openFilesRefreshed] = await Promise.all([
          refreshDirectories(loadedDirectoryPaths),
          agentId && onRefreshOpenFiles
            ? onRefreshOpenFiles(agentId, projectWorkspace)
            : Promise.resolve(true),
        ])
        await minimumPending
        refreshed = changesRefreshed && directoriesRefreshed && openFilesRefreshed
      } catch {
        await minimumPending
      }

      if (filesRefreshRequestRef.current !== requestId) return
      filesRefreshInFlightRef.current = false
      setFilesRefreshStatus(refreshed ? 'success' : 'error')
      if (!refreshed) return
      filesRefreshResetTimerRef.current = window.setTimeout(() => {
        if (filesRefreshRequestRef.current === requestId) {
          setFilesRefreshStatus('idle')
        }
        filesRefreshResetTimerRef.current = null
      }, FILES_REFRESH_SUCCESS_VISIBLE_MS)
    })()
  }, [agentId, fileChanges.refreshChanges, onRefreshOpenFiles, openDirectoryPaths, projectWorkspace, refreshDirectories, setOpenFileError])

  useEffect(() => {
    filesRefreshRequestRef.current += 1
    filesRefreshInFlightRef.current = false
    if (filesRefreshResetTimerRef.current !== null) {
      window.clearTimeout(filesRefreshResetTimerRef.current)
      filesRefreshResetTimerRef.current = null
    }
    setFilesRefreshStatus('idle')
  }, [agentId, projectId])

  useEffect(() => () => {
    filesRefreshRequestRef.current += 1
    if (filesRefreshResetTimerRef.current !== null) {
      window.clearTimeout(filesRefreshResetTimerRef.current)
    }
  }, [])

  useEffect(() => {
    setChangesCollapsed(true)
  }, [agentId])

  const toggleChangesCollapsed = useCallback(() => {
    setChangesCollapsed(current => !current)
  }, [])

  const openFileChange = useCallback((change: WorkspaceFileChange) => {
    void openFilePath(change.path, {
      ...workspaceFileOpenTargetForChange(change),
      transient: true,
    })
  }, [openFilePath])

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
    onWorkspaceChange: fileChanges.refreshChanges,
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
    copyFileMenuShareUrl,
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
    projectWorkspace,
    refreshDirectories,
    shareLinkFailed: copy.shareLinkFailed,
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
    workspaceKey: projectId,
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
    rootDirectoryLoaded: Boolean(directories[''] && !directories[''].loading),
    setFileSearchQuery: fileSearch.setQuery,
    setOpenFileError,
    treeData,
  })

  useEffect(() => {
    onFilesCollapsedChange?.(filesCollapsed)
  }, [filesCollapsed, onFilesCollapsedChange])
  const filesSectionStyle = useMemo(() => {
    if (openFiles.length === 0) {
      return { '--code-open-editors-sticky-height': '0px' } as CSSProperties
    }
    if (openEditorsCollapsed) {
      return { '--code-open-editors-sticky-height': `${OPEN_EDITORS_HEADER_HEIGHT}px` } as CSSProperties
    }
    const visibleOpenEditorRows = Math.min(openFiles.length, OPEN_EDITORS_VISIBLE_ROW_LIMIT)
    return {
      '--code-open-editors-sticky-height': `${OPEN_EDITORS_HEADER_HEIGHT + visibleOpenEditorRows * OPEN_EDITOR_ROW_HEIGHT}px`,
    } as CSSProperties
  }, [openEditorsCollapsed, openFiles.length])

  useEffect(() => {
    if (!activeFilePath || filesCollapsed || !directories['']) return
    if (lastAutoRevealedActivePathRef.current === activeFilePath) return
    lastAutoRevealedActivePathRef.current = activeFilePath
    void revealFilePath(activeFilePath)
  }, [activeFilePath, directories, filesCollapsed, revealFilePath])

  const {
    focusStickyDirectory,
    stickyContextItems,
  } = useWorkspaceFileStickyContext({
    filesCollapsed,
    focusFileTreePath,
    lastFocusedFilePathRef,
    openDirectoryPaths,
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
    setDirectoryOpen: setTreePathOpen,
    startFileOperation: startFileMenuOperation,
    toggleDirectoryOpen: toggleTreePathOpen,
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
    locatedFilePath,
    openEditorsCollapsed,
    openFileError,
    openFilePendingPath,
    projectId,
    renderFileTreeRow,
    rootDirectoryError: directories['']?.error ?? null,
    rootDirectoryHasItems: Boolean(directories['']?.items.length),
    rootDirectoryLoading: Boolean(directories['']?.loading),
    rowHeight: FILE_ROW_HEIGHT,
    readOnly,
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
    onCopyFileMenuShareUrl: copyFileMenuShareUrl,
    onFocusFileTreeTarget: focusFileTreeTarget,
    onFocusStickyDirectory: focusStickyDirectory,
    onOpenFileContextMenu: openFileContextMenu,
    onOpenFileJumpQuery: openFileJumpQuery,
    onOpenFilePath: openFilePath,
    onOpenFileSearchMatch: openFileSearchMatch,
    onOpenNewAgentFromFileMenu: openNewAgentFromFileMenu,
    onRefreshFileMenuTarget: refreshFileMenuTarget,
    onRememberFileOperationName: rememberFileOperationName,
    onSearchQueryChange: updateFileSearchQuery,
    onSelectOpenFile,
    onSelectSearchMatchIndex: fileSearch.selectMatchIndex,
    onToggleDirectory: toggleTreePathOpen,
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
      <div
        className={`code-files-section ${filesCollapsed ? 'collapsed' : ''}`}
        data-testid="code-files-section"
        data-project-id={projectId}
        style={filesSectionStyle}
      >
        <FileSectionHeader
          {...viewModel.sectionHeader}
          refreshStatus={filesRefreshStatus}
          onRefreshFiles={refreshProjectFiles}
        />
        {!filesCollapsed && (
          <>
            {!readOnly && (
              <FileChangesSection
                activeFilePath={activeFilePath}
                agentId={agentId}
                changes={fileChanges}
                collapsed={changesCollapsed}
                copy={copy}
                projectId={projectId}
                refreshing={filesRefreshStatus === 'refreshing'}
                onOpenChange={openFileChange}
                onToggleCollapsed={toggleChangesCollapsed}
              />
            )}
            {!readOnly && (
              <GitHistorySection
                agentId={agentId}
                copy={copy}
                projectId={projectId}
              />
            )}
            <FileSectionBody {...viewModel.sectionBody} />
          </>
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
          onCopyFileMenuShareUrl={copyFileMenuShareUrl}
          onOpenNewAgent={openNewAgentFromFileMenu}
          onRefreshFileMenuTarget={refreshFileMenuTarget}
          onRememberFileOperationName={rememberFileOperationName}
          onStartAgent={startAgentFromFileMenu}
          onStartFileMenuOperation={startFileMenuOperation}
          onSubmitFileOperation={submitFileOperation}
          onUpdateFileOperationName={updateFileOperationName}
          readOnly={readOnly}
        />
      )}
    </>
  )
}
