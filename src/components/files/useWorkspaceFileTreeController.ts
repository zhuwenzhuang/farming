import { createElement, useCallback, useEffect, useRef } from 'react'
import type { RowRendererProps, TreeApi } from 'react-arborist'
import { preserveWorkspaceFileScrollPosition } from '@/lib/workspace-file-view-model'
import type { WorkspaceFileTreeNode } from '@/lib/workspace-file-tree'

interface UseWorkspaceFileTreeControllerOptions {
  rowHeight: number
  visibleTreeRowCount: number
  openDirectoryPaths: ReadonlySet<string>
  treeData: WorkspaceFileTreeNode[]
  hydrateCompactDirectoryChains: (directoryPath: string) => Promise<unknown>
  isDirectoryOpen: (path: string) => boolean
  setDirectoryOpen: (path: string, open: boolean) => void
}

export function useWorkspaceFileTreeController({
  rowHeight,
  visibleTreeRowCount,
  openDirectoryPaths,
  treeData,
  hydrateCompactDirectoryChains,
  isDirectoryOpen,
  setDirectoryOpen,
}: UseWorkspaceFileTreeControllerOptions) {
  const treeRef = useRef<TreeApi<WorkspaceFileTreeNode> | undefined>(undefined)
  const treeViewportRef = useRef<HTMLDivElement | null>(null)
  const lastFocusedFilePathRef = useRef<string | null>(null)
  const manuallyClosedPathsRef = useRef(new Set<string>())
  const appliedManualClosuresRef = useRef(new Set<string>())

  const treeHeight = Math.max(rowHeight, visibleTreeRowCount * rowHeight)

  const openTreePaths = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return false
    const tree = treeRef.current
    if (!tree) return false
    let opened = false
    paths.forEach(path => {
      if (!path || !tree.get(path)) return
      if (manuallyClosedPathsRef.current.has(path)) return
      if (tree.isOpen(path)) return
      tree.open(path, false)
      opened = true
    })
    return opened
  }, [])

  const refreshTreeLayout = useCallback((preserveOpenPaths: readonly string[] = []) => {
    const redrawTree = () => {
      openTreePaths(preserveOpenPaths)
      treeRef.current?.redrawList()
    }
    redrawTree()
    window.requestAnimationFrame(redrawTree)
    window.setTimeout(redrawTree, 80)
  }, [openTreePaths])

  const setTreePathOpen = useCallback((path: string, open: boolean) => {
    if (open) {
      manuallyClosedPathsRef.current.delete(path)
      appliedManualClosuresRef.current.delete(path)
    } else {
      manuallyClosedPathsRef.current.add(path)
      appliedManualClosuresRef.current.delete(path)
    }
    setDirectoryOpen(path, open)
  }, [setDirectoryOpen])

  const toggleTreePathOpen = useCallback((path: string) => {
    const nextOpen = !isDirectoryOpen(path)
    setTreePathOpen(path, nextOpen)
    return nextOpen
  }, [isDirectoryOpen, setTreePathOpen])

  useEffect(() => {
    manuallyClosedPathsRef.current.forEach(path => {
      if (!openDirectoryPaths.has(path)) {
        appliedManualClosuresRef.current.add(path)
        return
      }
      if (!appliedManualClosuresRef.current.has(path)) return
      manuallyClosedPathsRef.current.delete(path)
      appliedManualClosuresRef.current.delete(path)
    })
  }, [openDirectoryPaths])

  useEffect(() => {
    const pathsToOpen = Array.from(openDirectoryPaths)
    if (pathsToOpen.length === 0) return undefined
    const reconcileTreeOpenState = () => {
      if (openTreePaths(pathsToOpen)) {
        treeRef.current?.redrawList()
      }
    }
    reconcileTreeOpenState()
    const frameId = window.requestAnimationFrame(reconcileTreeOpenState)
    const timeoutId = window.setTimeout(reconcileTreeOpenState, 80)
    const lateTimeoutId = window.setTimeout(reconcileTreeOpenState, 180)
    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
      window.clearTimeout(lateTimeoutId)
    }
  }, [openDirectoryPaths, openTreePaths, treeData])

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

    if (isDirectoryOpen(path)) {
      void hydrateCompactDirectoryChains(path).finally(() => refreshTreeLayout([path]))
    } else {
      refreshTreeLayout()
    }
  }, [hydrateCompactDirectoryChains, isDirectoryOpen, refreshTreeLayout])

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
    setTreePathOpen,
    toggleTreePathOpen,
  }
}
