import { type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type RefObject, useMemo } from 'react'
import type {
  WorkspaceFileContextMenuState,
  WorkspaceFileOperationKind,
  WorkspaceFileOperationState,
} from '@/lib/workspace-file-operation-model'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-file-search'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'
import type { AgentLaunchOption } from '../code/agent-launch-options'
import type { CodeCopy } from '../code/copy'
import type {
  FileSectionBodySearch,
  FileSectionBodySearchActions,
  FileSectionBodyTree,
} from './FileSectionBody'
import type { FileSectionHeaderSearch } from './FileSectionHeader'
import type { FileStickyContextItem } from './useWorkspaceFileStickyContext'
import type { WorkspaceFileSearchState } from './useWorkspaceFileSearch'
import type { Tree, TreeApi } from 'react-arborist'

interface UseProjectFilesSectionViewModelOptions {
  activeFilePath?: string
  activeSearchOptionId?: string
  agentId: string
  agentLaunchOptions: AgentLaunchOption[]
  copy: CodeCopy
  editorDirtyFilePaths: ReadonlySet<string>
  editorExternalChangedFilePaths: ReadonlySet<string>
  fileMenu: WorkspaceFileContextMenuState | null
  fileMenuRef: RefObject<HTMLDivElement | null>
  fileOperation: WorkspaceFileOperationState | null
  fileOperationInputRef: RefObject<HTMLInputElement | null>
  fileSearch: WorkspaceFileSearchState
  fileSearchInputRef: RefObject<HTMLInputElement | null>
  fileSearchListboxId: string
  fileSearchResultsRef: RefObject<HTMLDivElement | null>
  filesCollapsed: boolean
  handleFileSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  handleTreeKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  lastFocusedFilePathRef: MutableRefObject<string | null>
  locatedFilePath?: string | null
  openEditorsCollapsed: boolean
  openFileError: string | null
  openFilePendingPath: string | null
  projectId: string
  renderFileTreeRow: NonNullable<Parameters<typeof Tree<WorkspaceFileTreeNode>>[0]['renderRow']>
  rootDirectoryError: string | null
  rootDirectoryHasItems: boolean
  rootDirectoryLoading: boolean
  rowHeight: number
  readOnly?: boolean
  stickyContextItems: FileStickyContextItem[]
  treeData: WorkspaceFileTreeNode[]
  treeHeight: number
  treeRef: MutableRefObject<TreeApi<WorkspaceFileTreeNode> | undefined>
  treeViewportRef: RefObject<HTMLDivElement | null>
  visibleTreeRowCount: number
  onCancelPendingFileFocus: () => void
  onCloseFileMenuWithFocusRestore: () => void
  onCloseFileMenuWithoutFocus: () => void
  onCloseFileOperation: () => void
  onCloseOpenFile?: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onCopyFileMenuPath: () => void
  onCopyFileMenuShareUrl: () => void
  onFocusFileTreeTarget: (item: WorkspaceFileTreeNode | null) => void
  onFocusStickyDirectory: (node: WorkspaceFileTreeNode) => void
  onOpenFileContextMenu: (x: number, y: number, item: WorkspaceFileTreeNode | null) => void
  onOpenFileJumpQuery: (query: string) => void
  onOpenFilePath: (filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void>
  onOpenFileSearchMatch: FileSectionBodySearchActions['onOpenMatch']
  onOpenNewAgentFromFileMenu: () => void
  onRefreshFileMenuTarget: () => void
  onRememberFileOperationName: (name: string) => void
  onSearchQueryChange: (query: string) => void
  onSelectOpenFile?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onStartAgentFromFileMenu: (command: string) => void
  onSelectSearchMatchIndex: (index: number) => void
  onStartFileMenuOperation: (kind: WorkspaceFileOperationKind) => void
  onSubmitFileOperation: () => Promise<void>
  onToggleFilesCollapsed: () => void
  onToggleOpenEditorsCollapsed: () => void
  onToggleTreeNode: (path: string) => void
  onTreeFocus: (node: { data: WorkspaceFileTreeNode } | null | undefined) => void
  onTreeSelect: (nodes: Array<{ data: WorkspaceFileTreeNode }>) => void
  onUpdateFileOperationName: (name: string) => void
}

export function useProjectFilesSectionViewModel({
  activeFilePath,
  activeSearchOptionId,
  agentId,
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
  rootDirectoryError,
  rootDirectoryHasItems,
  rootDirectoryLoading,
  rowHeight,
  readOnly = false,
  stickyContextItems,
  treeData,
  treeHeight,
  treeRef,
  treeViewportRef,
  visibleTreeRowCount,
  onCancelPendingFileFocus,
  onCloseFileMenuWithFocusRestore,
  onCloseFileMenuWithoutFocus,
  onCloseFileOperation,
  onCloseOpenFile,
  onCopyFileMenuPath,
  onCopyFileMenuShareUrl,
  onFocusFileTreeTarget,
  onFocusStickyDirectory,
  onOpenFileContextMenu,
  onOpenFileJumpQuery,
  onOpenFilePath,
  onOpenFileSearchMatch,
  onOpenNewAgentFromFileMenu,
  onRefreshFileMenuTarget,
  onRememberFileOperationName,
  onSearchQueryChange,
  onSelectOpenFile,
  onSelectSearchMatchIndex,
  onStartAgentFromFileMenu,
  onStartFileMenuOperation,
  onSubmitFileOperation,
  onToggleFilesCollapsed,
  onToggleOpenEditorsCollapsed,
  onToggleTreeNode,
  onTreeFocus,
  onTreeSelect,
  onUpdateFileOperationName,
}: UseProjectFilesSectionViewModelOptions) {
  const headerSearch: FileSectionHeaderSearch = useMemo(() => ({
    active: fileSearch.active,
    activeOptionId: activeSearchOptionId,
    inputRef: fileSearchInputRef,
    listboxId: fileSearchListboxId,
    query: fileSearch.query,
  }), [
    activeSearchOptionId,
    fileSearch.active,
    fileSearch.query,
    fileSearchInputRef,
    fileSearchListboxId,
  ])

  const bodySearch: FileSectionBodySearch = useMemo(() => ({
    active: fileSearch.active,
    activeMatchIndex: fileSearch.activeMatchIndex,
    anchorRef: fileSearchInputRef,
    error: fileSearch.error,
    includeIgnored: fileSearch.includeIgnored,
    jumpTarget: fileSearch.jumpTarget,
    listboxId: fileSearchListboxId,
    loading: fileSearch.loading,
    matches: fileSearch.matches,
    query: fileSearch.query,
    resultsRef: fileSearchResultsRef,
    timeoutMs: fileSearch.timeoutMs,
    truncated: fileSearch.truncated,
  }), [
    fileSearch.active,
    fileSearch.activeMatchIndex,
    fileSearch.error,
    fileSearch.includeIgnored,
    fileSearchInputRef,
    fileSearch.jumpTarget,
    fileSearch.loading,
    fileSearch.matches,
    fileSearch.query,
    fileSearch.timeoutMs,
    fileSearch.truncated,
    fileSearchListboxId,
    fileSearchResultsRef,
  ])

  const bodySearchActions: FileSectionBodySearchActions = useMemo(() => ({
    onOpenJumpQuery: onOpenFileJumpQuery,
    onOpenMatch: onOpenFileSearchMatch,
    onSearchIgnored: fileSearch.searchIgnored,
    onSelectMatchIndex: onSelectSearchMatchIndex,
  }), [
    onOpenFileJumpQuery,
    onOpenFileSearchMatch,
    fileSearch.searchIgnored,
    onSelectSearchMatchIndex,
  ])

  const bodyTree: FileSectionBodyTree = useMemo(() => ({
    activeFilePath,
    agentId,
    editorDirtyFilePaths,
    editorExternalChangedFilePaths,
    fileOperation,
    fileOperationInputRef,
    handleTreeKeyDownCapture,
    lastFocusedFilePathRef,
    locatedFilePath,
    openFilePendingPath,
    renderFileTreeRow,
    rowHeight,
    stickyContextItems,
    treeData,
    treeHeight,
    treeRef,
    treeViewportRef,
    visibleTreeRowCount,
    onCancelPendingFileFocus,
    onCloseFileOperation,
    onFocusFileTreeTarget,
    onFocusStickyDirectory,
    onOpenFileContextMenu,
    onOpenFilePath,
    onRememberFileOperationName,
    onSubmitFileOperation,
    onToggleTreeNode,
    onTreeFocus,
    onTreeSelect,
    onUpdateFileOperationName,
  }), [
    activeFilePath,
    agentId,
    editorDirtyFilePaths,
    editorExternalChangedFilePaths,
    fileOperation,
    fileOperationInputRef,
    handleTreeKeyDownCapture,
    lastFocusedFilePathRef,
    locatedFilePath,
    openFilePendingPath,
    renderFileTreeRow,
    rowHeight,
    stickyContextItems,
    treeData,
    treeHeight,
    treeRef,
    treeViewportRef,
    visibleTreeRowCount,
    onCancelPendingFileFocus,
    onCloseFileOperation,
    onFocusFileTreeTarget,
    onFocusStickyDirectory,
    onOpenFileContextMenu,
    onOpenFilePath,
    onRememberFileOperationName,
    onSubmitFileOperation,
    onToggleTreeNode,
    onTreeFocus,
    onTreeSelect,
    onUpdateFileOperationName,
  ])

  return {
    bodySearch,
    bodySearchActions,
    bodyTree,
    fileMenu,
    fileMenuRef,
    filesCollapsed,
    headerSearch,
    openEditors: {
      activeFilePath,
      collapsed: openEditorsCollapsed,
      copy,
      projectId,
      onCloseOpenFile,
      onSelectOpenFile,
      onToggleCollapsed: onToggleOpenEditorsCollapsed,
    },
    sectionBody: {
      copy,
      agentLaunchOptions,
      fileMenu,
      fileMenuRef,
      openFileError,
      rootDirectoryError,
      rootDirectoryHasItems,
      rootDirectoryLoading,
      search: bodySearch,
      searchActions: bodySearchActions,
      tree: bodyTree,
      onCloseFileMenu: onCloseFileMenuWithoutFocus,
      onCloseFileMenuWithFocusRestore,
      onCopyFileMenuPath,
      onCopyFileMenuShareUrl,
      onOpenNewAgentFromFileMenu,
      onRefreshFileMenuTarget,
      onStartAgentFromFileMenu,
      onStartFileMenuOperation,
      readOnly,
    },
    sectionHeader: {
      copy,
      filesCollapsed,
      search: headerSearch,
      onCancelPendingFileFocus,
      onFileSearchKeyDown: handleFileSearchKeyDown,
      onSearchQueryChange,
      onToggleFilesCollapsed,
    },
  }
}
