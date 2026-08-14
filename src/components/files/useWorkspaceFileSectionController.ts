import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadCodeProjectFilesViewState,
  saveCodeProjectFilesViewState,
} from '@/components/code/workspace-view-state'

interface WorkspaceFileRevealRequest {
  path: string
  kind: 'directory' | 'file'
  requestId: number
}

interface WorkspaceFileSearchFocusRequest {
  requestId: number
  query?: string
}

interface UseWorkspaceFileSectionControllerOptions {
  agentId: string | null
  workspaceKey: string
  cancelPendingFileFocus: () => void
  clearFileMenu: () => void
  clearFileOperation: () => void
  clearFileSearch: () => void
  focusFileSearchInput: () => void
  focusSearchRequest?: WorkspaceFileSearchFocusRequest
  loadRootDirectory: () => void
  openFilesCount: number
  refreshTreeLayout: () => void
  revealExplorerPath: (filePath: string, kind: 'directory' | 'file') => Promise<unknown>
  revealRequest?: WorkspaceFileRevealRequest
  rootDirectoryLoaded: boolean
  setFileSearchQuery: (query: string) => void
  setOpenFileError: (error: string | null) => void
  treeData: unknown
}

export function useWorkspaceFileSectionController({
  agentId,
  workspaceKey,
  cancelPendingFileFocus,
  clearFileMenu,
  clearFileOperation,
  clearFileSearch,
  focusFileSearchInput,
  focusSearchRequest,
  loadRootDirectory,
  openFilesCount,
  refreshTreeLayout,
  revealExplorerPath,
  revealRequest,
  rootDirectoryLoaded,
  setFileSearchQuery,
  setOpenFileError,
  treeData,
}: UseWorkspaceFileSectionControllerOptions) {
  const [filesCollapsed, setFilesCollapsed] = useState(() => (
    loadCodeProjectFilesViewState(workspaceKey).filesCollapsed ?? true
  ))
  const [openEditorsCollapsed, setOpenEditorsCollapsed] = useState(() => (
    loadCodeProjectFilesViewState(workspaceKey).openEditorsCollapsed ?? true
  ))
  const handledRevealRequestIdRef = useRef<number | null>(null)
  const filesCollapsedWorkspaceKeyRef = useRef(workspaceKey)
  const previousOpenFilesCountRef = useRef(openFilesCount)

  const toggleFilesCollapsed = useCallback(() => {
    const nextCollapsed = !filesCollapsed
    if (nextCollapsed) {
      clearFileMenu()
      clearFileOperation()
      clearFileSearch()
    } else if (!rootDirectoryLoaded) {
      loadRootDirectory()
    }
    setFilesCollapsed(nextCollapsed)
  }, [clearFileMenu, clearFileOperation, clearFileSearch, filesCollapsed, loadRootDirectory, rootDirectoryLoaded])

  const toggleOpenEditorsCollapsed = useCallback(() => {
    setOpenEditorsCollapsed(current => !current)
  }, [])

  useEffect(() => {
    setOpenFileError(null)
    clearFileMenu()
    clearFileOperation()
    clearFileSearch()
  }, [agentId, clearFileMenu, clearFileOperation, clearFileSearch, setOpenFileError])

  useEffect(() => {
    if (revealRequest) return
    cancelPendingFileFocus()
  }, [cancelPendingFileFocus, revealRequest])

  useEffect(() => {
    if (!revealRequest) return
    setFilesCollapsed(false)
    if (!rootDirectoryLoaded) {
      loadRootDirectory()
      return
    }
    if (handledRevealRequestIdRef.current === revealRequest.requestId) return
    handledRevealRequestIdRef.current = revealRequest.requestId
    void revealExplorerPath(revealRequest.path, revealRequest.kind)
  }, [loadRootDirectory, revealExplorerPath, revealRequest, rootDirectoryLoaded])

  useEffect(() => {
    if (!focusSearchRequest) return
    setFilesCollapsed(false)
    if (!rootDirectoryLoaded) loadRootDirectory()
    if (typeof focusSearchRequest.query === 'string') {
      setFileSearchQuery(focusSearchRequest.query)
    }
    focusFileSearchInput()
  }, [focusFileSearchInput, focusSearchRequest, loadRootDirectory, rootDirectoryLoaded, setFileSearchQuery])

  useEffect(() => {
    if (previousOpenFilesCountRef.current > 0 && openFilesCount === 0) {
      setOpenEditorsCollapsed(true)
    }
    previousOpenFilesCountRef.current = openFilesCount
  }, [openFilesCount])

  useEffect(() => {
    if (filesCollapsedWorkspaceKeyRef.current !== workspaceKey) return
    saveCodeProjectFilesViewState(workspaceKey, { filesCollapsed, openEditorsCollapsed })
  }, [filesCollapsed, openEditorsCollapsed, workspaceKey])

  useEffect(() => {
    if (filesCollapsedWorkspaceKeyRef.current === workspaceKey) return
    filesCollapsedWorkspaceKeyRef.current = workspaceKey
    const state = loadCodeProjectFilesViewState(workspaceKey)
    setFilesCollapsed(state.filesCollapsed ?? true)
    setOpenEditorsCollapsed(state.openEditorsCollapsed ?? true)
  }, [workspaceKey])

  useEffect(() => {
    if (!filesCollapsed && !rootDirectoryLoaded) loadRootDirectory()
  }, [filesCollapsed, loadRootDirectory, rootDirectoryLoaded])

  useEffect(() => {
    if (filesCollapsed) return
    refreshTreeLayout()
  }, [filesCollapsed, refreshTreeLayout, treeData])

  return {
    filesCollapsed,
    openEditorsCollapsed,
    toggleFilesCollapsed,
    toggleOpenEditorsCollapsed,
  }
}
