import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  createWorkspaceFileOperation,
  workspaceFileOperationSelectionEnd,
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
  renameWorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileMove,
} from '@/lib/workspace-files'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'

interface UseWorkspaceFileOperationControllerOptions {
  agentId: string | null
  fileOperationActiveRef: MutableRefObject<boolean>
  ensureDirectoryLoaded: (directoryPath: string) => Promise<unknown>
  focusFileTreePath: (filePath: string | null) => void
  onDeleteEntries: (agentId: string, deletions: WorkspaceFileDeleteResult[]) => void
  onMoveEntries: (agentId: string, moves: WorkspaceFileMove[]) => void
  onOpenFile: (agentId: string, file: WorkspaceFile) => void
  onWorkspaceChange?: () => void
  refreshDirectories: (directoryPaths: Array<string | null | undefined>) => void
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
  refreshDirectories,
  setOpenFileError,
}: UseWorkspaceFileOperationControllerOptions) {
  const fileOperationInputRef = useRef<HTMLInputElement | null>(null)
  const fileOperationNameRef = useRef('')
  const [fileOperation, setFileOperation] = useState<WorkspaceFileOperationState | null>(null)

  const fileOperationFocusKey = useMemo(() => (
    fileOperation
      ? `${fileOperation.kind}:${fileOperation.item?.path ?? ''}:${fileOperation.parentPath}`
      : ''
  ), [fileOperation])

  const clearFileOperation = useCallback(() => {
    fileOperationActiveRef.current = false
    setFileOperation(null)
  }, [])

  const startFileOperation = useCallback((kind: WorkspaceFileOperationKind, item: WorkspaceFileTreeNode | null) => {
    const operation = createWorkspaceFileOperation(kind, item)
    fileOperationNameRef.current = operation.name
    fileOperationActiveRef.current = true
    setOpenFileError(null)
    setFileOperation(operation)
  }, [setOpenFileError])

  const closeFileOperation = useCallback(() => {
    const targetItem = fileOperation?.item ?? null
    clearFileOperation()
    focusFileTreePath(targetItem?.path ?? null)
  }, [clearFileOperation, fileOperation?.item, focusFileTreePath])

  const rememberFileOperationName = useCallback((name: string) => {
    fileOperationNameRef.current = name
  }, [])

  const updateFileOperationName = useCallback((name: string) => {
    fileOperationNameRef.current = name
    setFileOperation(current => current
      ? { ...current, name }
      : current)
  }, [])

  const submitFileOperation = useCallback(async () => {
    if (!agentId || !fileOperation) return
    const operation = fileOperation.kind === 'delete'
      ? fileOperation
      : { ...fileOperation, name: fileOperationNameRef.current }
    const name = workspaceFileOperationSubmitName(operation)
    if (operation.kind !== 'delete' && !name) return
    setOpenFileError(null)

    try {
      if (operation.kind === 'new-file' || operation.kind === 'new-folder') {
        const created = await createWorkspaceEntry(
          agentId,
          operation.parentPath,
          name,
          operation.kind === 'new-folder' ? 'directory' : 'file'
        )
        refreshDirectories([operation.parentPath])
        if (created.entry.type === 'directory') {
          ensureDirectoryLoaded(created.entry.path)
          focusFileTreePath(created.entry.path)
        }
        if (created.file) {
          onOpenFile(agentId, created.file)
        }
        onWorkspaceChange?.()
        clearFileOperation()
        return
      }

      if (operation.kind === 'rename' && operation.item) {
        const move = await renameWorkspaceEntry(agentId, operation.item.path, name)
        refreshDirectories(workspaceFileMoveRefreshDirectories(move))
        onMoveEntries(agentId, [move])
        onWorkspaceChange?.()
        clearFileOperation()
        focusFileTreePath(workspaceFileMoveFocusPath(move))
        return
      }

      if (operation.kind === 'delete' && operation.item) {
        const deleted = await deleteWorkspaceEntry(agentId, operation.item.path)
        refreshDirectories(workspaceFileDeleteRefreshDirectories(deleted))
        onDeleteEntries(agentId, [deleted])
        onWorkspaceChange?.()
        clearFileOperation()
        focusFileTreePath(workspaceFileDeleteFocusPath(deleted))
      }
    } catch (error) {
      setOpenFileError(error instanceof Error ? error.message : 'File operation failed')
    }
  }, [
    agentId,
    clearFileOperation,
    ensureDirectoryLoaded,
    fileOperation,
    focusFileTreePath,
    onDeleteEntries,
    onMoveEntries,
    onOpenFile,
    onWorkspaceChange,
    refreshDirectories,
    setOpenFileError,
  ])

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

  useLayoutEffect(() => {
    if (!fileOperation || fileOperation.kind === 'delete') return undefined
    const selectionEnd = workspaceFileOperationSelectionEnd(fileOperation)
    const selectInputName = () => {
      const input = fileOperationInputRef.current
      if (!input) return
      input.focus({ preventScroll: true })
      if (document.activeElement === input) input.setSelectionRange(0, selectionEnd)
    }

    selectInputName()
    const frameId = window.requestAnimationFrame(() => {
      selectInputName()
    })
    const immediateTimeoutId = window.setTimeout(selectInputName, 0)
    const timeoutId = window.setTimeout(selectInputName, 40)
    const retryTimeoutId = window.setTimeout(selectInputName, 120)
    const lateTimeoutId = window.setTimeout(selectInputName, 260)
    const finalTimeoutId = window.setTimeout(selectInputName, 420)
    const slowerTimeoutId = window.setTimeout(selectInputName, 720)
    const lastTimeoutId = window.setTimeout(selectInputName, 1200)
    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(immediateTimeoutId)
      window.clearTimeout(timeoutId)
      window.clearTimeout(retryTimeoutId)
      window.clearTimeout(lateTimeoutId)
      window.clearTimeout(finalTimeoutId)
      window.clearTimeout(slowerTimeoutId)
      window.clearTimeout(lastTimeoutId)
    }
  }, [fileOperationFocusKey])

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
