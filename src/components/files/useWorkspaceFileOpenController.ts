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

interface PendingWorkspaceFileOpen {
  agentId: string
  controller: AbortController
  filePath: string
  promise: Promise<void>
  target?: WorkspaceFileOpenTarget
}

function mergeWorkspaceFileOpenTarget(
  current: WorkspaceFileOpenTarget | undefined,
  next: WorkspaceFileOpenTarget | undefined,
) {
  if (!current) return next ? { ...next } : undefined
  if (!next) return current
  const keepPinned = current.transient === false || next.transient === false
  // Keep one target object so a second click can upgrade preview to pinned even
  // after the first read has entered an asynchronous Project mount.
  Object.assign(current, next)
  if (keepPinned) current.transient = false
  return current
}

interface UseWorkspaceFileOpenControllerOptions {
  agentId: string | null
  onClearSearch: () => void
  onOpenFile: (
    agentId: string,
    file: WorkspaceFile,
    target?: WorkspaceFileOpenTarget,
    signal?: AbortSignal,
  ) => void | Promise<void>
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
  const pendingFileOpenRef = useRef<PendingWorkspaceFileOpen | null>(null)
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
      pendingFileOpenRef.current?.controller.abort()
      pendingFileOpenRef.current = null
      if (fileOpenPendingTimerRef.current !== null) {
        window.clearTimeout(fileOpenPendingTimerRef.current)
        fileOpenPendingTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    pendingFileOpenRef.current?.controller.abort()
    pendingFileOpenRef.current = null
    fileOpenRequestFenceRef.current.invalidate()
    clearOpenFilePending()
    setOpenFileError(null)
  }, [agentId, clearOpenFilePending])

  const openFilePath = useCallback(async (filePath: string, target?: WorkspaceFileOpenTarget) => {
    if (!agentId) return
    const requestAgentId = agentId
    setOpenFileError(null)
    if (onSelectOpenFile?.(agentId, filePath, target)) {
      pendingFileOpenRef.current?.controller.abort()
      pendingFileOpenRef.current = null
      fileOpenRequestFenceRef.current.invalidate()
      clearOpenFilePending()
      onClearSearch()
      return
    }

    const currentPending = pendingFileOpenRef.current
    if (currentPending?.agentId === requestAgentId && currentPending.filePath === filePath) {
      currentPending.target = mergeWorkspaceFileOpenTarget(currentPending.target, target)
      return currentPending.promise
    }

    currentPending?.controller.abort()
    const controller = new AbortController()
    const lease = fileOpenRequestFenceRef.current.begin()
    scheduleOpenFilePending(lease, filePath)
    const pending: PendingWorkspaceFileOpen = {
      agentId: requestAgentId,
      controller,
      filePath,
      promise: Promise.resolve(),
      target,
    }
    pending.promise = (async () => {
      try {
        const file = await fetchWorkspaceFile(requestAgentId, filePath, { signal: controller.signal })
        if (!lease.isCurrent()) return
        await onOpenFile(requestAgentId, file, pending.target, controller.signal)
        if (!lease.isCurrent()) return
        onClearSearch()
      } catch (error) {
        if (!lease.isCurrent()) return
        if (
          pending.target
          && error instanceof WorkspaceFileApiError
          && error.status === 404
          && shouldOpenMissingWorkspaceFileAsDiff(pending.target)
        ) {
          await onOpenFile(
            requestAgentId,
            deletedWorkspaceDiffPlaceholderFile(filePath, pending.target),
            pending.target,
            controller.signal,
          )
          if (!lease.isCurrent()) return
          onClearSearch()
          return
        }
        setOpenFileError(error instanceof Error ? error.message : 'Failed to open file')
      } finally {
        if (pendingFileOpenRef.current === pending) {
          clearOpenFilePending()
          pendingFileOpenRef.current = null
        }
      }
    })()
    pendingFileOpenRef.current = pending
    return pending.promise
  }, [agentId, clearOpenFilePending, onClearSearch, onOpenFile, onSelectOpenFile, scheduleOpenFilePending])

  return {
    openFileError,
    openFilePendingPath,
    openFilePath,
    setOpenFileError,
  }
}
