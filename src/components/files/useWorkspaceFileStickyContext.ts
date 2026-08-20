import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import type { TreeApi } from 'react-arborist'
import { findWorkspaceFileTreeNode, type WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import { WORKSPACE_FILE_TREE_INDENT } from '@/lib/workspace-file-tree-row'
import {
  workspaceFileStickyProjection,
  workspaceStickyContextItems,
  workspaceVisibleFileTreeRows,
  type WorkspaceFileStickyContextItem,
} from '@/lib/workspace-file-view-model'

export type FileStickyContextItem = WorkspaceFileStickyContextItem

const FILE_CONTEXT_DESKTOP_SHIFT = 14
const FILE_CONTEXT_COMPACT_SHIFT = 6

interface UseWorkspaceFileStickyContextOptions {
  filesCollapsed: boolean
  focusFileTreePath: (path: string) => void
  lastFocusedFilePathRef: MutableRefObject<string | null>
  layoutKey: string
  openDirectoryPaths: ReadonlySet<string>
  rowHeight: number
  refreshTreeLayout: () => void
  resetKey: string | null
  treeData: FileExplorerNode[]
  treeRef: MutableRefObject<TreeApi<FileExplorerNode> | undefined>
  treeViewportRef: RefObject<HTMLDivElement | null>
}

function fileTreeStickyBoundary(viewport: HTMLElement) {
  return viewport.closest<HTMLElement>('.code-files-section')
    ?.querySelector<HTMLElement>('.code-files-header')
    ?.getBoundingClientRect().bottom ?? null
}

export function useWorkspaceFileStickyContext({
  filesCollapsed,
  focusFileTreePath,
  lastFocusedFilePathRef,
  layoutKey,
  openDirectoryPaths,
  rowHeight,
  refreshTreeLayout,
  resetKey,
  treeData,
  treeRef,
  treeViewportRef,
}: UseWorkspaceFileStickyContextOptions) {
  const [stickyDirectoryPaths, setStickyDirectoryPaths] = useState<string[]>([])
  const indentShiftRef = useRef(0)
  const contextShiftRef = useRef(0)

  const visibleRows = useMemo(() => (
    workspaceVisibleFileTreeRows(treeData, openDirectoryPaths)
  ), [openDirectoryPaths, treeData])
  const visibleRowIndexByPath = useMemo(() => (
    new Map(visibleRows.map((row, index) => [row.path, index]))
  ), [visibleRows])

  const stickyDirectoryNodes = useMemo(() => (
    stickyDirectoryPaths
      .map(directoryPath => findWorkspaceFileTreeNode(treeData, directoryPath))
      .filter((node): node is FileExplorerNode => Boolean(node))
  ), [stickyDirectoryPaths, treeData])

  const stickyContextItems = useMemo<FileStickyContextItem[]>(() => (
    workspaceStickyContextItems({
      directoryNodes: stickyDirectoryNodes,
    })
  ), [stickyDirectoryNodes])

  const updateIndentShift = useCallback((shift: number) => {
    const roundedShift = Math.round(Math.max(0, shift) * 100) / 100
    if (roundedShift === indentShiftRef.current) return
    indentShiftRef.current = roundedShift
    treeViewportRef.current?.style.setProperty('--file-indent-shift', `${roundedShift}px`)
  }, [treeViewportRef])

  const updateContextShift = useCallback((visible: boolean) => {
    const shift = visible
      ? (document.body.classList.contains('code-compact-layout')
          ? FILE_CONTEXT_COMPACT_SHIFT
          : FILE_CONTEXT_DESKTOP_SHIFT)
      : 0
    if (shift === contextShiftRef.current) return
    contextShiftRef.current = shift
    treeViewportRef.current?.style.setProperty('--file-context-shift', `${shift}px`)
  }, [treeViewportRef])

  const clearStickyContext = useCallback(() => {
    setStickyDirectoryPaths(current => current.length === 0 ? current : [])
    updateIndentShift(0)
    updateContextShift(false)
  }, [updateContextShift, updateIndentShift])

  const refreshStickyAncestors = useCallback(() => {
    const viewport = treeViewportRef.current
    const scroller = viewport?.closest<HTMLElement>('.code-project-list')
    if (!viewport || !scroller || filesCollapsed) {
      clearStickyContext()
      return
    }

    const scrollerRect = scroller.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const stickyBoundary = fileTreeStickyBoundary(viewport)
    if (stickyBoundary === null) {
      clearStickyContext()
      return
    }

    // This projection is deliberately output-blind. Rendered sticky geometry
    // and prior sticky state are not inputs and cannot feed back into the next
    // visibility decision.
    const projection = workspaceFileStickyProjection({
      rows: visibleRows,
      rowIndexByPath: visibleRowIndexByPath,
      treeTop: viewportRect.top,
      stickyBoundary,
      scrollerBottom: scrollerRect.bottom,
      rowHeight,
    })
    if (projection.directoryPaths.length === 0) {
      clearStickyContext()
      return
    }

    updateContextShift(true)
    updateIndentShift(projection.indentShiftDepth * WORKSPACE_FILE_TREE_INDENT)

    setStickyDirectoryPaths(current => (
      current.length === projection.directoryPaths.length && current.every((path, index) => path === projection.directoryPaths[index])
        ? current
        : projection.directoryPaths
    ))
  }, [clearStickyContext, filesCollapsed, rowHeight, treeViewportRef, updateContextShift, updateIndentShift, visibleRowIndexByPath, visibleRows])

  const focusStickyDirectory = useCallback((node: FileExplorerNode) => {
    lastFocusedFilePathRef.current = node.path
    treeRef.current?.get(node.path)?.select()
    focusFileTreePath(node.path)
  }, [focusFileTreePath, lastFocusedFilePathRef, treeRef])

  useEffect(() => {
    clearStickyContext()
  }, [clearStickyContext, resetKey])

  useEffect(() => {
    if (filesCollapsed) {
      clearStickyContext()
      return undefined
    }

    refreshTreeLayout()
    const frameId = window.requestAnimationFrame(() => refreshTreeLayout())
    const timeoutId = window.setTimeout(refreshTreeLayout, 80)
    const lateTimeoutId = window.setTimeout(refreshTreeLayout, 180)
    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
      window.clearTimeout(lateTimeoutId)
    }
  }, [clearStickyContext, filesCollapsed, layoutKey, openDirectoryPaths, refreshTreeLayout, treeData])

  useLayoutEffect(() => {
    if (filesCollapsed) return undefined
    const scroller = treeViewportRef.current?.closest<HTMLElement>('.code-project-list')
    let frameId = 0
    let settleTimeoutId: number | null = null
    const refreshBeforePaint = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(() => {
        frameId = 0
        flushSync(refreshStickyAncestors)
        if (settleTimeoutId !== null) window.clearTimeout(settleTimeoutId)
        settleTimeoutId = window.setTimeout(() => {
          settleTimeoutId = null
          refreshStickyAncestors()
        }, 80)
      })
    }

    refreshStickyAncestors()
    const earlyTimeoutId = window.setTimeout(refreshStickyAncestors, 80)
    const lateTimeoutId = window.setTimeout(refreshStickyAncestors, 180)
    // Tree mutations are only a liveness signal for the virtual list. The
    // projection above never reads the observed tree or sticky output DOM.
    const treeObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(refreshBeforePaint)
    const treeElement = treeRef.current?.listEl.current
    if (treeElement) {
      treeObserver?.observe(treeElement, {
        attributes: true,
        attributeFilter: ['style'],
        childList: true,
        subtree: true,
      })
    }
    scroller?.addEventListener('scroll', refreshBeforePaint, { passive: true })
    window.addEventListener('resize', refreshBeforePaint)
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      window.clearTimeout(earlyTimeoutId)
      window.clearTimeout(lateTimeoutId)
      if (settleTimeoutId !== null) window.clearTimeout(settleTimeoutId)
      treeObserver?.disconnect()
      scroller?.removeEventListener('scroll', refreshBeforePaint)
      window.removeEventListener('resize', refreshBeforePaint)
    }
  }, [filesCollapsed, layoutKey, openDirectoryPaths, refreshStickyAncestors, treeData, treeRef, treeViewportRef])

  return {
    focusStickyDirectory,
    stickyContextItems,
  }
}
