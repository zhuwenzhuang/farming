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
  intentLease?: RequestOwnershipLease
  promise: Promise<void>
  target: WorkspaceFileOpenTarget
}

function mergeWorkspaceFileOpenTarget(
  current: WorkspaceFileOpenTarget,
  next: WorkspaceFileOpenTarget | undefined,
) {
  const keepPinned = current.transient === false || next?.transient === false
  // Keep one object so an intent arriving during an asynchronous Project mount
  // updates the target already held by onOpenFile. Replace every other field:
  // the latest click owns editor/diff, cursor, focus, and reveal semantics.
  Object.keys(current).forEach(key => {
    delete current[key as keyof WorkspaceFileOpenTarget]
  })
  if (next) Object.assign(current, next)
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
    intentLease?: RequestOwnershipLease,
  ) => void | Promise<void>
  onBeginOpenFileIntent?: () => RequestOwnershipLease
  onSelectOpenFile?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
}

export function useWorkspaceFileOpenController({
  agentId,
  onClearSearch,
  onOpenFile,
  onBeginOpenFileIntent,
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
    const currentPending = pendingFileOpenRef.current
    if (
      currentPending?.agentId === requestAgentId
      && currentPending.filePath === filePath
      && currentPending.intentLease?.isCurrent() !== false
    ) {
      // Repeated clicks on the same in-flight file are one transaction. Keeping
      // its ownership lease avoids cancelling an open that has already advanced
      // from the file read into an asynchronous Project mount.
      mergeWorkspaceFileOpenTarget(currentPending.target, target)
      return currentPending.promise
    }
    if (onSelectOpenFile?.(agentId, filePath, target)) {
      pendingFileOpenRef.current?.controller.abort()
      pendingFileOpenRef.current = null
      fileOpenRequestFenceRef.current.invalidate()
      clearOpenFilePending()
      onClearSearch()
      return
    }

    currentPending?.controller.abort()
    const controller = new AbortController()
    const lease = fileOpenRequestFenceRef.current.begin()
    const intentLease = onBeginOpenFileIntent?.()
    scheduleOpenFilePending(lease, filePath)
    const pending: PendingWorkspaceFileOpen = {
      agentId: requestAgentId,
      controller,
      filePath,
      intentLease,
      promise: Promise.resolve(),
      target: mergeWorkspaceFileOpenTarget({}, target),
    }
    pending.promise = (async () => {
      try {
        const file = await fetchWorkspaceFile(requestAgentId, filePath, { signal: controller.signal })
        if (!lease.isCurrent() || pending.intentLease?.isCurrent() === false) return
        await onOpenFile(requestAgentId, file, pending.target, controller.signal, pending.intentLease)
        if (!lease.isCurrent() || pending.intentLease?.isCurrent() === false) return
        onClearSearch()
      } catch (error) {
        if (!lease.isCurrent() || pending.intentLease?.isCurrent() === false) return
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
            pending.intentLease,
          )
          if (!lease.isCurrent() || pending.intentLease?.isCurrent() === false) return
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
  }, [agentId, clearOpenFilePending, onBeginOpenFileIntent, onClearSearch, onOpenFile, onSelectOpenFile, scheduleOpenFilePending])

  return {
    openFileError,
    openFilePendingPath,
    openFilePath,
    setOpenFileError,
  }
}
