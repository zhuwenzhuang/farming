import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deletedWorkspaceDiffPlaceholderFile,
  shouldOpenMissingWorkspaceFileAsDiff,
  type WorkspaceFileOpenTarget,
} from '@/lib/workspace-open-files'
import {
  fetchWorkspaceFile,
  WorkspaceFileApiError,
  type WorkspaceFile,
} from '@/lib/workspace-files'
import { RequestOwnershipFence, type RequestOwnershipLease } from '@/lib/request-ownership'

const FILE_OPEN_PENDING_DELAY_MS = 220

interface UseWorkspaceFileOpenControllerOptions {
  agentId: string | null
  onClearSearch: () => void
  onOpenFile: (agentId: string, file: WorkspaceFile, target?: WorkspaceFileOpenTarget) => void | Promise<void>
  onSelectOpenFile?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
}

export function useWorkspaceFileOpenController({
  agentId,
  onClearSearch,
  onOpenFile,
  onSelectOpenFile,
}: UseWorkspaceFileOpenControllerOptions) {
  const fileOpenRequestFenceRef = useRef(new RequestOwnershipFence(agentId))
  const fileOpenPendingTimerRef = useRef<number | null>(null)
  const [openFileError, setOpenFileError] = useState<string | null>(null)
  const [openFilePendingPath, setOpenFilePendingPath] = useState<string | null>(null)
  fileOpenRequestFenceRef.current.setScope(agentId)

  const clearOpenFilePending = useCallback(() => {
    if (fileOpenPendingTimerRef.current !== null) {
      window.clearTimeout(fileOpenPendingTimerRef.current)
      fileOpenPendingTimerRef.current = null
    }
    setOpenFilePendingPath(null)
  }, [])

  const scheduleOpenFilePending = useCallback((lease: RequestOwnershipLease, filePath: string) => {
    clearOpenFilePending()
    fileOpenPendingTimerRef.current = window.setTimeout(() => {
      if (lease.isCurrent()) setOpenFilePendingPath(filePath)
      fileOpenPendingTimerRef.current = null
    }, FILE_OPEN_PENDING_DELAY_MS)
  }, [clearOpenFilePending])

  useEffect(() => {
    const requestFence = fileOpenRequestFenceRef.current
    requestFence.setMounted(true)
    return () => {
      requestFence.setMounted(false)
      if (fileOpenPendingTimerRef.current !== null) {
        window.clearTimeout(fileOpenPendingTimerRef.current)
        fileOpenPendingTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    fileOpenRequestFenceRef.current.invalidate()
    clearOpenFilePending()
    setOpenFileError(null)
  }, [agentId, clearOpenFilePending])

  const openFilePath = useCallback(async (filePath: string, target?: WorkspaceFileOpenTarget) => {
    if (!agentId) return
    const requestAgentId = agentId
    const lease = fileOpenRequestFenceRef.current.begin()
    setOpenFileError(null)
    if (onSelectOpenFile?.(agentId, filePath, target)) {
      clearOpenFilePending()
      onClearSearch()
      return
    }
    scheduleOpenFilePending(lease, filePath)
    try {
      const file = await fetchWorkspaceFile(requestAgentId, filePath)
      if (!lease.isCurrent()) return
      clearOpenFilePending()
      await onOpenFile(requestAgentId, file, target)
      if (!lease.isCurrent()) return
      onClearSearch()
    } catch (error) {
      if (!lease.isCurrent()) return
      clearOpenFilePending()
      if (target && error instanceof WorkspaceFileApiError && error.status === 404 && shouldOpenMissingWorkspaceFileAsDiff(target)) {
        await onOpenFile(requestAgentId, deletedWorkspaceDiffPlaceholderFile(filePath, target), target)
        if (!lease.isCurrent()) return
        onClearSearch()
        return
      }
      setOpenFileError(error instanceof Error ? error.message : 'Failed to open file')
    }
  }, [agentId, clearOpenFilePending, onClearSearch, onOpenFile, onSelectOpenFile, scheduleOpenFilePending])

  return {
    openFileError,
    openFilePendingPath,
    openFilePath,
    setOpenFileError,
  }
}
