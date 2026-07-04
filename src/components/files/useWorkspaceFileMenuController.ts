import { useCallback, useRef, useState } from 'react'
import {
  workspaceFileContextMenuPosition,
  workspaceFileOperationTargetDirectory,
  type WorkspaceFileContextMenuState,
  type WorkspaceFileOperationKind,
} from '@/lib/workspace-file-operation-model'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'

interface UseWorkspaceFileMenuControllerOptions {
  agentId: string | null
  cancelPendingFileFocus: () => void
  clearFileOperation: () => void
  focusFileTreeTarget: (item: WorkspaceFileTreeNode | null) => void
  refreshDirectories: (directoryPaths: Array<string | null | undefined>) => void
  setOpenFileError: (error: string | null) => void
  startFileOperation: (kind: WorkspaceFileOperationKind, item: WorkspaceFileTreeNode | null) => void
}

export function useWorkspaceFileMenuController({
  agentId,
  cancelPendingFileFocus,
  clearFileOperation,
  focusFileTreeTarget,
  refreshDirectories,
  setOpenFileError,
  startFileOperation,
}: UseWorkspaceFileMenuControllerOptions) {
  const fileMenuRef = useRef<HTMLDivElement | null>(null)
  const [fileMenu, setFileMenu] = useState<WorkspaceFileContextMenuState | null>(null)

  const clearFileMenu = useCallback(() => {
    setFileMenu(null)
  }, [])

  const openFileContextMenu = useCallback((x: number, y: number, item: WorkspaceFileTreeNode | null) => {
    setOpenFileError(null)
    clearFileOperation()
    const position = workspaceFileContextMenuPosition(x, y, item, window.innerWidth, window.innerHeight)
    setFileMenu({
      ...position,
      item,
    })
  }, [clearFileOperation, setOpenFileError])

  const closeFileMenu = useCallback((restoreFocus = false) => {
    const menuItem = fileMenu?.item ?? null
    setFileMenu(null)
    if (restoreFocus) focusFileTreeTarget(menuItem)
  }, [fileMenu?.item, focusFileTreeTarget])

  const closeFileMenuWithoutFocus = useCallback(() => {
    closeFileMenu(false)
  }, [closeFileMenu])

  const closeFileMenuWithFocusRestore = useCallback(() => {
    closeFileMenu(true)
  }, [closeFileMenu])

  const startFileMenuOperation = useCallback((kind: WorkspaceFileOperationKind, item: WorkspaceFileTreeNode | null = fileMenu?.item ?? null) => {
    cancelPendingFileFocus()
    setFileMenu(null)
    startFileOperation(kind, item)
  }, [cancelPendingFileFocus, fileMenu?.item, startFileOperation])

  const refreshFileMenuTarget = useCallback(() => {
    if (!agentId) return
    const directoryPath = workspaceFileOperationTargetDirectory(fileMenu?.item ?? null)
    refreshDirectories([directoryPath])
    setFileMenu(null)
  }, [agentId, fileMenu?.item, refreshDirectories])

  const copyFileMenuPath = useCallback(async () => {
    const item = fileMenu?.item
    if (!item) return
    setFileMenu(null)
    setOpenFileError(null)
    try {
      await navigator.clipboard?.writeText(item.path)
    } catch {
      setOpenFileError('Copy failed')
    }
  }, [fileMenu?.item, setOpenFileError])

  return {
    fileMenu,
    fileMenuRef,
    clearFileMenu,
    closeFileMenuWithFocusRestore,
    closeFileMenuWithoutFocus,
    copyFileMenuPath,
    openFileContextMenu,
    refreshFileMenuTarget,
    startFileMenuOperation,
  }
}
