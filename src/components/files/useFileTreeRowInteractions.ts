import { useCallback, type MouseEvent as ReactMouseEvent, type MutableRefObject, type RefObject } from 'react'
import type { NodeRendererProps } from 'react-arborist'
import {
  preserveWorkspaceFileScrollPosition,
  workspaceFileTreeRowClickIntent,
} from '@/lib/workspace-file-view-model'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'

function focusWithoutScrolling(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true })
}

interface UseFileTreeRowInteractionsOptions {
  isDirectory: boolean
  item: WorkspaceFileTreeNode
  lastFocusedFilePathRef: MutableRefObject<string | null>
  node: NodeRendererProps<WorkspaceFileTreeNode>['node']
  treeViewportRef: RefObject<HTMLDivElement | null>
  onCancelPendingFileFocus: () => void
  onFocusFileTreeTarget: (item: WorkspaceFileTreeNode | null) => void
  onOpenFileContextMenu: (x: number, y: number, item: WorkspaceFileTreeNode | null) => void
  onOpenFilePath: (filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void>
}

export function useFileTreeRowInteractions({
  isDirectory,
  item,
  lastFocusedFilePathRef,
  node,
  treeViewportRef,
  onCancelPendingFileFocus,
  onFocusFileTreeTarget,
  onOpenFileContextMenu,
  onOpenFilePath,
}: UseFileTreeRowInteractionsOptions) {
  const focusTree = useCallback(() => {
    focusWithoutScrolling(treeViewportRef.current?.querySelector<HTMLElement>('[role="tree"]'))
  }, [treeViewportRef])

  const handleRowContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onCancelPendingFileFocus()
    lastFocusedFilePathRef.current = item.path
    node.select()
    onOpenFileContextMenu(event.clientX, event.clientY, item)
  }, [item, lastFocusedFilePathRef, node, onCancelPendingFileFocus, onOpenFileContextMenu])

  const handleRowClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    onCancelPendingFileFocus()
    lastFocusedFilePathRef.current = item.path
    const clickIntent = workspaceFileTreeRowClickIntent({
      nodeType: item.type,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    })
    const restoreProjectScroll = isDirectory
      ? preserveWorkspaceFileScrollPosition(treeViewportRef.current?.closest<HTMLElement>('.code-project-list'))
      : null

    if (clickIntent === 'toggle-directory') {
      event.preventDefault()
      event.stopPropagation()
      const nextOpen = !node.isOpen
      node.select()
      node.focus()
      focusTree()
      if (nextOpen) {
        node.open()
      } else {
        node.close()
      }
      onFocusFileTreeTarget(item)
      restoreProjectScroll?.()
      return
    }

    if (clickIntent === 'open-file') {
      void onOpenFilePath(item.path, { transient: true })
    }
    node.handleClick(event)
    node.focus()
    focusTree()
    if (event.shiftKey) {
      focusWithoutScrolling(event.currentTarget)
      restoreProjectScroll?.()
      return
    }
    onFocusFileTreeTarget(item)
    restoreProjectScroll?.()
  }, [
    focusTree,
    isDirectory,
    item,
    lastFocusedFilePathRef,
    node,
    onCancelPendingFileFocus,
    onFocusFileTreeTarget,
    onOpenFilePath,
    treeViewportRef,
  ])

  return {
    handleRowClick,
    handleRowContextMenu,
  }
}
