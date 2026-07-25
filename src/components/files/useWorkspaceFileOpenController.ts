import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deletedWorkspaceDiffPlaceholderFile,
  shouldOpenMissingWorkspaceFileAsDiff,
  shouldRevealSelectedWorkspaceOpenFile,
  type WorkspaceFileOpenTarget,
} from '@/lib/workspace-open-files'
import {
  fetchWorkspaceFile,
  WorkspaceFileApiError,
  type WorkspaceFile,
} from '@/lib/workspace-files'

const FILE_OPEN_PENDING_DELAY_MS = 220

interface UseWorkspaceFileOpenControllerOptions {
  agentId: string | null
  onClearSearch: () => void
  onOpenFile: (agentId: string, file: WorkspaceFile, target?: WorkspaceFileOpenTarget) => void
  onRevealFilePath: (filePath: string) => Promise<void>
  onSelectOpenFile?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
}

export function useWorkspaceFileOpenController({
  agentId,
  onClearSearch,
  onOpenFile,
  onRevealFilePath,
  onSelectOpenFile,
}: UseWorkspaceFileOpenControllerOptions) {
  const fileOpenRequestRef = useRef(0)
  const fileOpenScopeRef = useRef({ agentId, mounted: true })
  const fileOpenPendingTimerRef = useRef<number | null>(null)
  const [openFileError, setOpenFileError] = useState<string | null>(null)
  const [openFilePendingPath, setOpenFilePendingPath] = useState<string | null>(null)
  fileOpenScopeRef.current.agentId = agentId

  const clearOpenFilePending = useCallback(() => {
    if (fileOpenPendingTimerRef.current !== null) {
      window.clearTimeout(fileOpenPendingTimerRef.current)
      fileOpenPendingTimerRef.current = null
    }
    setOpenFilePendingPath(null)
  }, [])

  const scheduleOpenFilePending = useCallback((requestId: number, requestAgentId: string, filePath: string) => {
    clearOpenFilePending()
    fileOpenPendingTimerRef.current = window.setTimeout(() => {
      if (
        fileOpenRequestRef.current === requestId
        && fileOpenScopeRef.current.agentId === requestAgentId
        && fileOpenScopeRef.current.mounted
      ) setOpenFilePendingPath(filePath)
      fileOpenPendingTimerRef.current = null
    }, FILE_OPEN_PENDING_DELAY_MS)
  }, [clearOpenFilePending])

  useEffect(() => {
    fileOpenScopeRef.current.mounted = true
    return () => {
      fileOpenScopeRef.current.mounted = false
      fileOpenRequestRef.current += 1
      if (fileOpenPendingTimerRef.current !== null) {
        window.clearTimeout(fileOpenPendingTimerRef.current)
        fileOpenPendingTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    fileOpenRequestRef.current += 1
    clearOpenFilePending()
    setOpenFileError(null)
  }, [agentId, clearOpenFilePending])

  const openFilePath = useCallback(async (filePath: string, target?: WorkspaceFileOpenTarget) => {
    if (!agentId) return
    const requestAgentId = agentId
    const requestId = fileOpenRequestRef.current + 1
    fileOpenRequestRef.current = requestId
    setOpenFileError(null)
    if (onSelectOpenFile?.(agentId, filePath, target)) {
      clearOpenFilePending()
      onClearSearch()
      if (shouldRevealSelectedWorkspaceOpenFile(target)) void onRevealFilePath(filePath)
      return
    }
    scheduleOpenFilePending(requestId, requestAgentId, filePath)
    try {
      const file = await fetchWorkspaceFile(requestAgentId, filePath)
      if (
        fileOpenRequestRef.current !== requestId
        || fileOpenScopeRef.current.agentId !== requestAgentId
        || !fileOpenScopeRef.current.mounted
      ) return
      clearOpenFilePending()
      onOpenFile(requestAgentId, file, target)
      onClearSearch()
      if (shouldRevealSelectedWorkspaceOpenFile(target)) void onRevealFilePath(filePath)
    } catch (error) {
      if (
        fileOpenRequestRef.current !== requestId
        || fileOpenScopeRef.current.agentId !== requestAgentId
        || !fileOpenScopeRef.current.mounted
      ) return
      clearOpenFilePending()
      if (target && error instanceof WorkspaceFileApiError && error.status === 404 && shouldOpenMissingWorkspaceFileAsDiff(target)) {
        onOpenFile(requestAgentId, deletedWorkspaceDiffPlaceholderFile(filePath, target), target)
        onClearSearch()
        return
      }
      setOpenFileError(error instanceof Error ? error.message : 'Failed to open file')
    }
  }, [agentId, clearOpenFilePending, onClearSearch, onOpenFile, onRevealFilePath, onSelectOpenFile, scheduleOpenFilePending])

  return {
    openFileError,
    openFilePendingPath,
    openFilePath,
    setOpenFileError,
  }
}
