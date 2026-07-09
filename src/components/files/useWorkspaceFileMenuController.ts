import { useCallback, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { writeTerminalClipboardText } from '@/lib/terminal-clipboard'
import { workspaceShareAbsolutePath, workspaceShareProjectLabel } from '@/lib/workspace-share-target'
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

  const openFileContextMenu = useCallback((x: number, y: number, item: WorkspaceFileTreeNode | null) => {
    cancelPendingFileFocus()
    setOpenFileError(null)
    clearFileOperation()
    const position = workspaceFileContextMenuPosition(x, y, item, window.innerWidth, window.innerHeight, agentLaunchOptionCount)
    setFileMenu({
      ...position,
      item,
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

  const copyFileMenuShareUrl = useCallback(async () => {
    const item = fileMenu?.item
    if (!agentId || !item || (item.type !== 'file' && item.type !== 'directory')) return
    setFileMenu(null)
    setOpenFileError(null)
    try {
      const target = item.type === 'directory'
        ? { kind: 'folder', agentId, folderPath: item.path, absolutePath: workspaceShareAbsolutePath(projectWorkspace, item.path), projectLabel: workspaceShareProjectLabel(projectWorkspace) }
        : { kind: 'file', agentId, filePath: item.path, absolutePath: workspaceShareAbsolutePath(projectWorkspace, item.path), projectLabel: workspaceShareProjectLabel(projectWorkspace) }
      const response = await fetch(appPath('/api/share/qr-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      })
      const body = await response.json() as { longUrl?: string; error?: string }
      if (!response.ok || !body.longUrl || !await writeTerminalClipboardText(body.longUrl)) {
        throw new Error(body.error || shareLinkFailed)
      }
    } catch (error) {
      setOpenFileError(error instanceof Error ? error.message : shareLinkFailed)
    }
  }, [agentId, fileMenu?.item, projectWorkspace, setOpenFileError, shareLinkFailed])

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
