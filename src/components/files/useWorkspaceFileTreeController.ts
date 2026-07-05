import { createElement, useCallback, useRef } from 'react'
import type { RowRendererProps, TreeApi } from 'react-arborist'
import { preserveWorkspaceFileScrollPosition } from '@/lib/workspace-file-view-model'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'

interface UseWorkspaceFileTreeControllerOptions {
  rowHeight: number
  visibleTreeRowCount: number
  hydrateCompactDirectoryChains: (directoryPath: string) => Promise<unknown>
  setDirectoryOpen: (path: string, open: boolean) => void
  syncOpenDirectoryPaths: (openPaths: Set<string>) => void
}

export function useWorkspaceFileTreeController({
  rowHeight,
  visibleTreeRowCount,
  hydrateCompactDirectoryChains,
  setDirectoryOpen,
  syncOpenDirectoryPaths,
}: UseWorkspaceFileTreeControllerOptions) {
  const treeRef = useRef<TreeApi<WorkspaceFileTreeNode> | undefined>(undefined)
  const treeViewportRef = useRef<HTMLDivElement | null>(null)
  const lastFocusedFilePathRef = useRef<string | null>(null)

  const treeHeight = Math.max(rowHeight, visibleTreeRowCount * rowHeight)

  const syncTreeStateFromArborist = useCallback(() => {
    const tree = treeRef.current
    if (!tree) return

    const nextOpenPaths = new Set<string>()
    tree.visibleNodes.forEach(node => {
      if (node.data.type === 'directory' && node.isOpen) {
        nextOpenPaths.add(node.data.path)
      }
    })
    syncOpenDirectoryPaths(nextOpenPaths)
  }, [syncOpenDirectoryPaths])

  const refreshTreeLayout = useCallback(() => {
    const redrawTree = (syncOpenState = false) => {
      treeRef.current?.redrawList()
      if (syncOpenState) syncTreeStateFromArborist()
    }
    redrawTree()
    window.requestAnimationFrame(() => redrawTree(true))
    window.setTimeout(() => redrawTree(true), 80)
  }, [syncTreeStateFromArborist])

  const renderFileTreeRow = useCallback(({ attrs, innerRef, children }: RowRendererProps<WorkspaceFileTreeNode>) => {
    const { style, className, ...rowAttrs } = attrs

    return createElement('div', {
      ...rowAttrs,
      ref: innerRef,
      style: {
        ...style,
        minWidth: '100%',
        width: '100%',
      },
      className: `code-file-tree-row-frame ${className ?? ''}`.trim(),
    }, children)
  }, [])

  const handleTreeToggle = useCallback((path: string) => {
    preserveWorkspaceFileScrollPosition(treeViewportRef.current?.closest<HTMLElement>('.code-project-list'))

    let lastObservedOpen: boolean | null = null
    const syncObservedToggle = () => {
      const nextOpen = Boolean(treeRef.current?.get(path)?.isOpen)
      if (lastObservedOpen === nextOpen) return
      lastObservedOpen = nextOpen
      setDirectoryOpen(path, nextOpen)
      if (nextOpen) {
        void hydrateCompactDirectoryChains(path).finally(refreshTreeLayout)
      } else {
        refreshTreeLayout()
      }
    }

    syncObservedToggle()
    window.requestAnimationFrame(syncObservedToggle)
    window.setTimeout(syncObservedToggle, 80)
  }, [hydrateCompactDirectoryChains, refreshTreeLayout, setDirectoryOpen])

  const rememberFocusedTreeNode = useCallback((node: { data: WorkspaceFileTreeNode } | null | undefined) => {
    if (!node) return
    lastFocusedFilePathRef.current = node.data.path
  }, [])

  const rememberSelectedTreeNodes = useCallback((nodes: Array<{ data: WorkspaceFileTreeNode }>) => {
    const lastNode = nodes[nodes.length - 1]
    if (!lastNode) return
    lastFocusedFilePathRef.current = lastNode.data.path
  }, [])

  return {
    treeRef,
    treeViewportRef,
    lastFocusedFilePathRef,
    treeHeight,
    handleTreeToggle,
    refreshTreeLayout,
    rememberFocusedTreeNode,
    rememberSelectedTreeNodes,
    renderFileTreeRow,
  }
}
