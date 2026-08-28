import { useCallback, useRef, useState } from 'react'
import { writeClipboardText } from '@/lib/clipboard'
import { requestReadOnlyShareLink } from '@/lib/qr-share-ticket'
import {
  workspaceShareAbsolutePath,
  workspaceShareProjectLabel,
  type WorkspaceShareTarget,
} from '@/lib/workspace-share-target'
import {
  workspaceFileContextMenuPosition,
  workspaceFileOperationTargetDirectory,
  type WorkspaceFileContextMenuState,
  type WorkspaceFileOperationKind,
} from '@/lib/workspace-file-operation-model'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'

interface UseWorkspaceFileMenuControllerOptions {
  agentId: string | null
  agentLaunchOptionCount?: number
  cancelPendingFileFocus: () => void
  clearFileOperation: () => void
  focusFileTreeTarget: (item: WorkspaceFileTreeNode | null) => void
  refreshDirectories: (directoryPaths: Array<string | null | undefined>) => void
  projectWorkspace: string
  shareLinkFailed: string
  setOpenFileError: (error: string | null) => void
  startFileOperation: (kind: WorkspaceFileOperationKind, item: WorkspaceFileTreeNode | null) => void
}

export function useWorkspaceFileMenuController({
  agentId,
  agentLaunchOptionCount = 0,
  cancelPendingFileFocus,
  clearFileOperation,
  focusFileTreeTarget,
  refreshDirectories,
  projectWorkspace,
  shareLinkFailed,
  setOpenFileError,
  startFileOperation,
}: UseWorkspaceFileMenuControllerOptions) {
  const fileMenuRef = useRef<HTMLDivElement | null>(null)
  const [fileMenu, setFileMenu] = useState<WorkspaceFileContextMenuState | null>(null)

  const clearFileMenu = useCallback(() => {
    setFileMenu(null)
  }, [])

  const openFileContextMenu = useCallback((
    x: number,
    y: number,
    item: WorkspaceFileTreeNode | null,
    focusFirstItem = false,
    createTarget: WorkspaceFileTreeNode | null = item,
  ) => {
    cancelPendingFileFocus()
    setOpenFileError(null)
    clearFileOperation()
    const position = workspaceFileContextMenuPosition(x, y, item, window.innerWidth, window.innerHeight, agentLaunchOptionCount)
    setFileMenu({
      ...position,
      item,
      createTarget,
      focusFirstItem,
    })
  }, [agentLaunchOptionCount, cancelPendingFileFocus, clearFileOperation, setOpenFileError])

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
    const operationItem = kind === 'new-file' || kind === 'new-folder'
      ? fileMenu?.createTarget ?? item
      : item
    startFileOperation(kind, operationItem)
  }, [cancelPendingFileFocus, fileMenu?.createTarget, fileMenu?.item, startFileOperation])

  const refreshFileMenuTarget = useCallback(() => {
    if (!agentId) return
    const item = fileMenu?.item ?? null
    const directoryPath = workspaceFileOperationTargetDirectory(item)
    refreshDirectories([directoryPath])
    setFileMenu(null)
    focusFileTreeTarget(item)
  }, [agentId, fileMenu?.item, focusFileTreeTarget, refreshDirectories])

  const copyFileMenuPath = useCallback(async () => {
    const item = fileMenu?.item
    if (!item) return
    setFileMenu(null)
    focusFileTreeTarget(item)
    setOpenFileError(null)
    try {
      if (!await writeClipboardText(item.path)) throw new Error('Copy failed')
    } catch {
      setOpenFileError('Copy failed')
    }
  }, [fileMenu?.item, focusFileTreeTarget, setOpenFileError])

  const copyFileMenuShareUrl = useCallback(async () => {
    const item = fileMenu?.item
    if (!agentId || !item || (item.type !== 'file' && item.type !== 'directory')) return
    setFileMenu(null)
    focusFileTreeTarget(item)
    setOpenFileError(null)
    let shareLink: Awaited<ReturnType<typeof requestReadOnlyShareLink>> | null = null
    try {
      const target: WorkspaceShareTarget = item.type === 'directory'
        ? { kind: 'folder', agentId, folderPath: item.path, absolutePath: workspaceShareAbsolutePath(projectWorkspace, item.path), projectLabel: workspaceShareProjectLabel(projectWorkspace) }
        : { kind: 'file', agentId, filePath: item.path, absolutePath: workspaceShareAbsolutePath(projectWorkspace, item.path), projectLabel: workspaceShareProjectLabel(projectWorkspace) }
      shareLink = await requestReadOnlyShareLink(target, shareLinkFailed)
      if (!await writeClipboardText(shareLink.url)) throw new Error('Copy failed')
    } catch (error) {
      setOpenFileError(error instanceof Error ? error.message : shareLinkFailed)
    } finally {
      await shareLink?.revokeUnusedTicket()
    }
  }, [agentId, fileMenu?.item, focusFileTreeTarget, projectWorkspace, setOpenFileError, shareLinkFailed])

  const fileMenuTargetDirectory = useCallback((item: WorkspaceFileTreeNode | null = fileMenu?.item ?? null) => (
    workspaceFileOperationTargetDirectory(item)
  ), [fileMenu?.item])

  return {
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
  }
}
