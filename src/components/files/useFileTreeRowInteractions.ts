import {
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import type { NodeRendererProps } from 'react-arborist'
import { workspaceFileTreeRowClickIntent } from '@/lib/workspace-file-view-model'
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
  onSelectFilePath: (filePath: string) => () => void
  onToggleDirectory: (path: string) => boolean
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
  onSelectFilePath,
  onToggleDirectory,
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

  const handleRowActions = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onCancelPendingFileFocus()
    lastFocusedFilePathRef.current = item.path
    node.select()
    const rect = event.currentTarget.getBoundingClientRect()
    onOpenFileContextMenu(rect.right, rect.bottom, item)
  }, [item, lastFocusedFilePathRef, node, onCancelPendingFileFocus, onOpenFileContextMenu])

  const handleRowPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || (event.target as HTMLElement | null)?.closest('button, input')
    ) return
    // Keep the activation owned by the row where the gesture started. Opening
    // a preview or scrolling a virtualized tree can move the row before
    // pointerup; without capture, the generated click can land on a sticky
    // Agent row and unexpectedly leave the editor.
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const handleRowMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      isDirectory
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
    ) return
    event.preventDefault()
    // Finish the tree-focus transition in this discrete pointer event. Doing
    // it later in click batches treeBlur with the active-file render, so a
    // virtualized row can still observe stale treeFocused state and reclaim
    // focus after Monaco opens.
    node.tree.onBlur()
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && treeViewportRef.current?.contains(activeElement)) {
      activeElement.blur()
    }
  }, [isDirectory, node.tree, treeViewportRef])

  const handleRowClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    onCancelPendingFileFocus()
    lastFocusedFilePathRef.current = item.path
    const clickIntent = workspaceFileTreeRowClickIntent({
      nodeType: item.type,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    })
    if (clickIntent === 'toggle-directory') {
      event.preventDefault()
      event.stopPropagation()
      const nextOpen = onToggleDirectory(item.path)
      node.select()
      node.focus()
      focusTree()
      if (nextOpen) {
        node.open()
      } else {
        node.close()
      }
      return
    }

    if (clickIntent === 'open-file') {
      // Pointer activation hands keyboard ownership to the editor after the
      // file read completes. Selecting through react-arborist here would
      // focus the hidden tree target and steal Ctrl/Cmd shortcuts from Monaco.
      event.preventDefault()
      event.stopPropagation()
      // Publish immediate row feedback through the path-scoped projection,
      // then keep react-arborist's selection authoritative for keyboard,
      // multi-select, and repeated-click intent semantics.
      const reconcileTreeSelection = onSelectFilePath(item.path)
      const opening = onOpenFilePath(item.path, {
        transient: event.detail < 2,
        focusEditor: true,
      })
      // Arborist still owns keyboard and multi-selection state. The shared
      // reconciler waits until this open terminates and coalesces rapid file
      // switches so only the final path pays the large-tree selection cost.
      void opening.then(reconcileTreeSelection, reconcileTreeSelection)
      return
    }

    node.handleClick(event)
    focusTree()
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      // handleClick already owns additive/range selection. TreeApi.focus()
      // selects a single node when selectionFollowsFocus is enabled, which
      // would immediately collapse the multi-selection it just created.
      focusWithoutScrolling(event.currentTarget)
      return
    }
    node.focus()
    onFocusFileTreeTarget(item)
  }, [
    focusTree,
    item,
    lastFocusedFilePathRef,
    node,
    onCancelPendingFileFocus,
    onFocusFileTreeTarget,
    onOpenFilePath,
    onSelectFilePath,
    onToggleDirectory,
  ])

  return {
    handleRowClick,
    handleRowContextMenu,
    handleRowMouseDown,
    handleRowPointerDown,
    handleRowActions,
  }
}
