import { useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react'
import type { NodeApi, TreeApi } from 'react-arborist'
import type {
  WorkspaceFileOperationKind,
  WorkspaceFileOperationState,
} from '@/lib/workspace-file-operation-model'
import {
  preserveWorkspaceFileScrollPosition,
  shouldCancelPendingWorkspaceFileTreeFocus,
  shouldCloseWorkspaceFileTreeDirectory,
  workspaceFileTreeActivationIntent,
  workspaceFileTreeKeyboardTargetPath,
} from '@/lib/workspace-file-view-model'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'

interface UseWorkspaceFileTreeKeyboardOptions {
  treeRef: MutableRefObject<TreeApi<WorkspaceFileTreeNode> | undefined>
  treeViewportRef: MutableRefObject<HTMLDivElement | null>
  lastFocusedFilePathRef: MutableRefObject<string | null>
  fileOperation: WorkspaceFileOperationState | null
  openDirectoryPaths: ReadonlySet<string>
  cancelPendingFileFocus: () => void
  closeFileOperation: () => void
  focusFileSearchInput: () => void
  focusFileTreePath: (filePath: string | null) => void
  focusFileTreeTarget: (item: WorkspaceFileTreeNode | null) => void
  openFileContextMenu: (x: number, y: number, item: WorkspaceFileTreeNode | null) => void
  openFilePath: (filePath: string) => void | Promise<void>
  startFileOperation: (kind: WorkspaceFileOperationKind, item?: WorkspaceFileTreeNode | null) => void
}

export function useWorkspaceFileTreeKeyboard({
  treeRef,
  treeViewportRef,
  lastFocusedFilePathRef,
  fileOperation,
  openDirectoryPaths,
  cancelPendingFileFocus,
  closeFileOperation,
  focusFileSearchInput,
  focusFileTreePath,
  focusFileTreeTarget,
  openFileContextMenu,
  openFilePath,
  startFileOperation,
}: UseWorkspaceFileTreeKeyboardOptions) {
  const projectScroller = useCallback(() => (
    treeViewportRef.current?.closest<HTMLElement>('.code-project-list') ?? null
  ), [treeViewportRef])

  const openDirectoryNode = useCallback((node: NodeApi<WorkspaceFileTreeNode>) => {
    preserveWorkspaceFileScrollPosition(projectScroller())
    node.open()
    lastFocusedFilePathRef.current = node.data.path
    focusFileTreeTarget(node.data)
  }, [
    focusFileTreeTarget,
    lastFocusedFilePathRef,
    projectScroller,
  ])

  const closeDirectoryNode = useCallback((
    filePath: string,
    node: NodeApi<WorkspaceFileTreeNode> | null | undefined,
  ) => {
    preserveWorkspaceFileScrollPosition(projectScroller())
    if (node) {
      node.close()
    } else {
      treeRef.current?.close(filePath)
    }
    lastFocusedFilePathRef.current = filePath
    if (node) {
      focusFileTreeTarget(node.data)
    } else {
      focusFileTreePath(filePath)
    }
  }, [
    focusFileTreePath,
    focusFileTreeTarget,
    lastFocusedFilePathRef,
    projectScroller,
    treeRef,
  ])

  const handleTreeKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey) return
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      event.stopPropagation()
      focusFileSearchInput()
      return
    }
    if (event.ctrlKey || event.metaKey) return

    const tree = treeRef.current
    const targetElement = event.target as HTMLElement | null
    if (fileOperation && event.key === 'Escape' && targetElement?.closest('.code-file-inline-operation')) {
      event.preventDefault()
      event.stopPropagation()
      closeFileOperation()
      return
    }

    if (targetElement?.closest('input, textarea, [contenteditable="true"], .code-file-inline-operation')) return

    if (shouldCancelPendingWorkspaceFileTreeFocus(event.key)) {
      cancelPendingFileFocus()
    }

    const targetPath = targetElement?.closest<HTMLElement>('[data-file-path]')?.dataset.filePath
    const selectedRow = targetPath
      ? undefined
      : treeViewportRef.current?.querySelector<HTMLElement>('[data-file-path].selected')
    const selectedRowState = {
      path: selectedRow?.dataset.filePath,
      type: selectedRow?.dataset.fileType,
      expanded: selectedRow?.getAttribute('aria-expanded') === 'true',
    }
    const focusedNode = tree?.focusedNode && !tree.focusedNode.isRoot ? tree.focusedNode : null
    const focusedPath = workspaceFileTreeKeyboardTargetPath({
      targetPath,
      selectedPath: selectedRowState.path,
      focusedPath: focusedNode?.data.path,
      lastFocusedPath: lastFocusedFilePathRef.current,
    })
    const node = focusedPath ? tree?.get(focusedPath) : tree?.focusedNode ?? tree?.mostRecentNode
    if (!node || node.isRoot) return
    lastFocusedFilePathRef.current = node.data.path

    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      event.stopPropagation()
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-file-path]')
      const rect = row?.getBoundingClientRect()
      openFileContextMenu(rect ? rect.left + 24 : 24, rect ? rect.top + rect.height : 24, node.data)
      return
    }

    if (event.shiftKey) return

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const nextNode = event.key === 'ArrowDown' ? node.next : node.prev
      if (!nextNode || nextNode.isRoot) return
      nextNode.focus()
      nextNode.select()
      lastFocusedFilePathRef.current = nextNode.data.path
      return
    }

    if (event.key === 'F2') {
      event.preventDefault()
      event.stopPropagation()
      startFileOperation('rename', node.data)
      return
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      startFileOperation('delete', node.data)
      return
    }

    if (event.key === 'ArrowRight') {
      if (node.data.type !== 'directory') return

      event.preventDefault()
      event.stopPropagation()
      if (!node.isOpen) {
        openDirectoryNode(node)
        return
      }

      const firstChild = node.children?.[0] ?? null
      if (firstChild) {
        firstChild.select()
        firstChild.focus()
        lastFocusedFilePathRef.current = firstChild.data.path
        focusFileTreeTarget(firstChild.data)
      }
      return
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopPropagation()
      if (shouldCloseWorkspaceFileTreeDirectory({
        nodePath: node.data.path,
        nodeType: node.data.type,
        nodeOpen: node.isOpen,
        selectedRow: selectedRowState,
        openDirectoryPaths,
      })) {
        closeDirectoryNode(node.data.path, node)
        return
      }

      const parent = node.parent
      if (parent && !parent.isRoot) {
        parent.select()
        parent.focus()
        lastFocusedFilePathRef.current = parent.data.path
        focusFileTreeTarget(parent.data)
      }
      return
    }

    if (event.key !== 'Enter' && event.key !== ' ') return

    event.preventDefault()
    event.stopPropagation()

    const activationIntent = workspaceFileTreeActivationIntent({
      nodeType: node.data.type,
      nodeOpen: node.isOpen,
    })
    if (activationIntent === 'close-directory') {
      closeDirectoryNode(node.data.path, node)
      return
    }
    if (activationIntent === 'open-directory') {
      openDirectoryNode(node)
      return
    }
    if (activationIntent === 'open-file') {
      lastFocusedFilePathRef.current = node.data.path
      void openFilePath(node.data.path)
    }
  }, [
    cancelPendingFileFocus,
    closeFileOperation,
    closeDirectoryNode,
    fileOperation,
    focusFileSearchInput,
    focusFileTreeTarget,
    lastFocusedFilePathRef,
    openDirectoryNode,
    openDirectoryPaths,
    openFileContextMenu,
    openFilePath,
    startFileOperation,
    treeRef,
    treeViewportRef,
  ])

  useEffect(() => {
    const closeSelectedOpenDirectory = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' || event.altKey || event.ctrlKey || event.metaKey) return
      const viewport = treeViewportRef.current
      const activeElement = document.activeElement
      if (!viewport || !(activeElement instanceof Element) || !viewport.contains(activeElement)) return

      const selectedRow = viewport.querySelector<HTMLElement>('[data-file-path].selected')
      const filePath = selectedRow?.dataset.filePath
      if (!filePath || selectedRow?.dataset.fileType !== 'directory' || selectedRow.getAttribute('aria-expanded') !== 'true') return

      event.preventDefault()
      event.stopPropagation()
      const node = treeRef.current?.get(filePath)
      closeDirectoryNode(filePath, node)
    }

    window.addEventListener('keydown', closeSelectedOpenDirectory, true)
    return () => {
      window.removeEventListener('keydown', closeSelectedOpenDirectory, true)
    }
  }, [
    closeDirectoryNode,
    treeRef,
    treeViewportRef,
  ])

  return {
    handleTreeKeyDownCapture,
  }
}
