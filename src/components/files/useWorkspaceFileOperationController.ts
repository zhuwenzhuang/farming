import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  createWorkspaceFileOperation,
  reconcileWorkspaceFileCreateFromDirectory,
  reconcileWorkspaceFileDeleteFromDirectory,
  reconcileWorkspaceFileRenameFromDirectory,
  workspaceFileOperationSubmitName,
  type WorkspaceFileOperationKind,
  type WorkspaceFileOperationState,
} from '@/lib/workspace-file-operation-model'
import {
  workspaceFileDeleteFocusPath,
  workspaceFileDeleteRefreshDirectories,
  workspaceFileMoveFocusPath,
  workspaceFileMoveRefreshDirectories,
} from '@/lib/workspace-file-operations'
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  fetchWorkspaceFile,
  fetchWorkspaceTree,
  renameWorkspaceEntry,
  WorkspaceFileApiError,
  type WorkspaceFile,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileMove,
} from '@/lib/workspace-files'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'

const WORKSPACE_FILE_OPERATION_TIMEOUT_MS = 15_000

interface WorkspaceFileOperationOwnership {
  generation: number
  operation: WorkspaceFileOperationState
  rootId: string
  submitted: boolean
}

async function withWorkspaceFileOperationTimeout<T>(request: (signal: AbortSignal) => Promise<T>) {
  const abortController = new AbortController()
  let timedOut = false
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, WORKSPACE_FILE_OPERATION_TIMEOUT_MS)
  try {
    return await request(abortController.signal)
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error('File operation timed out')
      timeoutError.name = 'TimeoutError'
      throw timeoutError
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

interface UseWorkspaceFileOperationControllerOptions {
  agentId: string | null
  fileOperationActiveRef: MutableRefObject<boolean>
  ensureDirectoryLoaded: (directoryPath: string) => Promise<unknown>
  focusFileTreePath: (filePath: string | null) => void
  onDeleteEntries: (agentId: string, deletions: WorkspaceFileDeleteResult[]) => void
  onMoveEntries: (agentId: string, moves: WorkspaceFileMove[]) => void
  onOpenFile: (agentId: string, file: WorkspaceFile) => void | Promise<void>
  onWorkspaceChange?: () => void
  openDirectoriesInLayout: (directoryPaths: string[]) => void
  moveOpenDirectories: (moves: readonly WorkspaceFileMove[]) => Promise<unknown>
  refreshDirectories: (directoryPaths: Array<string | null | undefined>) => Promise<boolean>
  setOpenFileError: (error: string | null) => void
}

export function useWorkspaceFileOperationController({
  agentId,
  fileOperationActiveRef,
  ensureDirectoryLoaded,
  focusFileTreePath,
  onDeleteEntries,
  onMoveEntries,
  onOpenFile,
  onWorkspaceChange,
  openDirectoriesInLayout,
  moveOpenDirectories,
  refreshDirectories,
  setOpenFileError,
}: UseWorkspaceFileOperationControllerOptions) {
  const fileOperationInputRef = useRef<HTMLInputElement | null>(null)
  const fileOperationNameRef = useRef('')
  const fileOperationGenerationRef = useRef(0)
  const fileOperationRef = useRef<WorkspaceFileOperationOwnership | null>(null)
  const [fileOperation, setFileOperation] = useState<WorkspaceFileOperationState | null>(null)

  const clearFileOperation = useCallback(() => {
    fileOperationRef.current = null
    fileOperationActiveRef.current = false
    setFileOperation(null)
  }, [fileOperationActiveRef])

  const isCurrentFileOperation = useCallback((operation: WorkspaceFileOperationOwnership) => {
    const current = fileOperationRef.current
    return current?.generation === operation.generation && current.rootId === operation.rootId
  }, [])

  const clearFileOperationIfCurrent = useCallback((operation: WorkspaceFileOperationOwnership) => {
    if (!isCurrentFileOperation(operation)) return false
    fileOperationRef.current = null
    fileOperationActiveRef.current = false
    setFileOperation(current => fileOperationRef.current === null ? null : current)
    return true
  }, [fileOperationActiveRef, isCurrentFileOperation])

  const releaseFileOperationForRetry = useCallback((operation: WorkspaceFileOperationOwnership) => {
    if (!isCurrentFileOperation(operation)) return false
    const retryOperation: WorkspaceFileOperationOwnership = {
      ...operation,
      generation: fileOperationGenerationRef.current + 1,
      operation: { ...operation.operation, submitting: false },
      submitted: false,
    }
    fileOperationGenerationRef.current = retryOperation.generation
    fileOperationRef.current = retryOperation
    setFileOperation(current => fileOperationRef.current === retryOperation
      ? retryOperation.operation
      : current)
    return true
  }, [isCurrentFileOperation])

  const startFileOperation = useCallback((kind: WorkspaceFileOperationKind, item: WorkspaceFileTreeNode | null) => {
    if (!agentId || (item?.readOnly && !(item.symbolicLink && (kind === 'rename' || kind === 'delete')))) return
    const operation = createWorkspaceFileOperation(kind, item)
    if ((kind === 'new-file' || kind === 'new-folder') && operation.parentPath) {
      openDirectoriesInLayout([operation.parentPath])
    }
    const generation = fileOperationGenerationRef.current + 1
    fileOperationGenerationRef.current = generation
    fileOperationRef.current = {
      generation,
      operation,
      rootId: agentId,
      submitted: false,
    }
    fileOperationNameRef.current = operation.name
    fileOperationActiveRef.current = true
    setOpenFileError(null)
    setFileOperation(operation)
  }, [agentId, fileOperationActiveRef, openDirectoriesInLayout, setOpenFileError])

  const closeFileOperation = useCallback(() => {
    const operation = fileOperationRef.current
    if (!operation) return
    if (clearFileOperationIfCurrent(operation)) {
      focusFileTreePath(operation.operation.item?.path ?? null)
    }
  }, [clearFileOperationIfCurrent, focusFileTreePath])

  const rememberFileOperationName = useCallback((name: string) => {
    fileOperationNameRef.current = name
    const operation = fileOperationRef.current
    if (operation && !operation.submitted) {
      operation.operation = { ...operation.operation, name }
    }
  }, [])

  const updateFileOperationName = useCallback((name: string) => {
    fileOperationNameRef.current = name
    const operation = fileOperationRef.current
    if (operation && !operation.submitted) {
      operation.operation = { ...operation.operation, name }
    }
    setFileOperation(current => current
      ? { ...current, name }
      : current)
  }, [])

  const submitFileOperation = useCallback(async () => {
    const ownedOperation = fileOperationRef.current
    if (!agentId || !ownedOperation || ownedOperation.rootId !== agentId || ownedOperation.submitted) return
    const operation = ownedOperation.operation.kind === 'delete'
      ? ownedOperation.operation
      : { ...ownedOperation.operation, name: fileOperationNameRef.current }
    const name = workspaceFileOperationSubmitName(operation)
    if (operation.kind !== 'delete' && !name) return
    const submittedOperation = operation.kind === 'delete'
      ? operation
      : { ...operation, name }
    fileOperationNameRef.current = name
    ownedOperation.operation = { ...submittedOperation, submitting: true }
    ownedOperation.submitted = true
    setFileOperation(current => isCurrentFileOperation(ownedOperation)
      ? ownedOperation.operation
      : current)
    setOpenFileError(null)

    try {
      if (operation.kind === 'new-file' || operation.kind === 'new-folder') {
        const created = await withWorkspaceFileOperationTimeout(signal => createWorkspaceEntry(
          ownedOperation.rootId,
          operation.parentPath,
          name,
          operation.kind === 'new-folder' ? 'directory' : 'file',
          { signal },
        ))
        await refreshDirectories([operation.parentPath])
        onWorkspaceChange?.()
        if (isCurrentFileOperation(ownedOperation)) {
          if (created.entry.type === 'directory') {
            void ensureDirectoryLoaded(created.entry.path)
            focusFileTreePath(created.entry.path)
          }
          if (created.file) {
            await onOpenFile(ownedOperation.rootId, created.file)
          }
          clearFileOperationIfCurrent(ownedOperation)
        }
        return
      }

      if (operation.kind === 'rename' && operation.item) {
        const item = operation.item
        const move = await withWorkspaceFileOperationTimeout(signal => renameWorkspaceEntry(
          ownedOperation.rootId,
          item.path,
          name,
          item.version,
          { signal },
        ))
        await Promise.all([
          refreshDirectories(workspaceFileMoveRefreshDirectories(move)),
          moveOpenDirectories([move]),
        ])
        onMoveEntries(ownedOperation.rootId, [move])
        onWorkspaceChange?.()
        if (clearFileOperationIfCurrent(ownedOperation)) {
          focusFileTreePath(workspaceFileMoveFocusPath(move))
        }
        return
      }

      if (operation.kind === 'delete' && operation.item) {
        const item = operation.item
        const deleted = await withWorkspaceFileOperationTimeout(signal => deleteWorkspaceEntry(
          ownedOperation.rootId,
          item.path,
          item.version,
          { signal },
        ))
        refreshDirectories(workspaceFileDeleteRefreshDirectories(deleted))
        onDeleteEntries(ownedOperation.rootId, [deleted])
        onWorkspaceChange?.()
        if (clearFileOperationIfCurrent(ownedOperation)) {
          focusFileTreePath(workspaceFileDeleteFocusPath(deleted))
        }
      }
    } catch (error) {
      const reconcileDirectories = operation.kind === 'new-file' || operation.kind === 'new-folder'
        ? [operation.parentPath]
        : operation.item
          ? [operation.item.path.includes('/') ? operation.item.path.slice(0, operation.item.path.lastIndexOf('/')) : '']
          : []
      const uncertainOutcome = !(error instanceof WorkspaceFileApiError) || error.status >= 500
      if (
        uncertainOutcome &&
        (operation.kind === 'new-file' || operation.kind === 'new-folder')
      ) {
        try {
          const tree = await withWorkspaceFileOperationTimeout(signal => fetchWorkspaceTree(
            ownedOperation.rootId,
            operation.parentPath,
            { signal },
          ))
          const createdEntry = reconcileWorkspaceFileCreateFromDirectory(operation, name, tree.items)
          if (createdEntry) {
            refreshDirectories([operation.parentPath])
            onWorkspaceChange?.()
            if (createdEntry.type === 'directory' && isCurrentFileOperation(ownedOperation)) {
              void ensureDirectoryLoaded(createdEntry.path)
              focusFileTreePath(createdEntry.path)
              clearFileOperationIfCurrent(ownedOperation)
            } else if (createdEntry.type === 'file' && isCurrentFileOperation(ownedOperation)) {
              focusFileTreePath(createdEntry.path)
              try {
                const createdFile = await withWorkspaceFileOperationTimeout(signal => fetchWorkspaceFile(
                  ownedOperation.rootId,
                  createdEntry.path,
                  { signal },
                ))
                if (isCurrentFileOperation(ownedOperation)) {
                  await onOpenFile(ownedOperation.rootId, createdFile)
                }
              } catch {
                // Creation is already proven; a later click can retry opening the file.
              }
              clearFileOperationIfCurrent(ownedOperation)
            }
            return
          }
        } catch {
          // Preserve the original operation error when authoritative rereading also fails.
        }
      }
      if (
        uncertainOutcome &&
        operation.item &&
        (operation.kind === 'rename' || operation.kind === 'delete')
      ) {
        try {
          const parentPath = reconcileDirectories[0] ?? ''
          const tree = await withWorkspaceFileOperationTimeout(signal => fetchWorkspaceTree(
            ownedOperation.rootId,
            parentPath,
            { signal },
          ))
          if (operation.kind === 'rename') {
            const move = reconcileWorkspaceFileRenameFromDirectory(operation, name, tree.items)
            if (move) {
              await Promise.all([
                refreshDirectories(workspaceFileMoveRefreshDirectories(move)),
                moveOpenDirectories([move]),
              ])
              onMoveEntries(ownedOperation.rootId, [move])
              onWorkspaceChange?.()
              if (clearFileOperationIfCurrent(ownedOperation)) {
                focusFileTreePath(workspaceFileMoveFocusPath(move))
              }
              return
            }
          }
          if (operation.kind === 'delete') {
            const deleted = reconcileWorkspaceFileDeleteFromDirectory(operation, tree.items)
            if (deleted) {
              refreshDirectories(workspaceFileDeleteRefreshDirectories(deleted))
              onDeleteEntries(ownedOperation.rootId, [deleted])
              onWorkspaceChange?.()
              if (clearFileOperationIfCurrent(ownedOperation)) {
                focusFileTreePath(workspaceFileDeleteFocusPath(deleted))
              }
              return
            }
          }
        } catch {
          // Preserve the original operation error when authoritative rereading also fails.
        }
      }
      if (reconcileDirectories.length > 0) {
        refreshDirectories(reconcileDirectories)
        onWorkspaceChange?.()
      }
      if (releaseFileOperationForRetry(ownedOperation)) {
        setOpenFileError(error instanceof Error ? error.message : 'File operation failed')
      }
    }
  }, [
    agentId,
    clearFileOperationIfCurrent,
    ensureDirectoryLoaded,
    focusFileTreePath,
    moveOpenDirectories,
    isCurrentFileOperation,
    onDeleteEntries,
    onMoveEntries,
    onOpenFile,
    onWorkspaceChange,
    refreshDirectories,
    releaseFileOperationForRetry,
    setOpenFileError,
  ])

  useLayoutEffect(() => {
    const operation = fileOperationRef.current
    if (operation && operation.rootId !== agentId) {
      clearFileOperation()
    }
  }, [agentId, clearFileOperation])

  useLayoutEffect(() => () => {
    fileOperationRef.current = null
    fileOperationActiveRef.current = false
  }, [fileOperationActiveRef])

  useEffect(() => {
    if (!fileOperation) return undefined

    const closeInlineOperationOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeFileOperation()
    }

    document.addEventListener('keydown', closeInlineOperationOnEscape, true)
    return () => {
      document.removeEventListener('keydown', closeInlineOperationOnEscape, true)
    }
  }, [closeFileOperation, fileOperation])

  return {
    fileOperation,
    fileOperationActiveRef,
    fileOperationInputRef,
    clearFileOperation,
    closeFileOperation,
    rememberFileOperationName,
    startFileOperation,
    submitFileOperation,
    updateFileOperationName,
  }
}
