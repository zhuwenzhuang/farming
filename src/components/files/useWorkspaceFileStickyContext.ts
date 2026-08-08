import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type MutableRefObject, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { findWorkspaceFileTreeNode, type WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import {
  firstVisibleWorkspaceFilePath,
  isWorkspaceStickyContextVisible,
  workspaceStickyContentTop,
  workspaceStickyContextItems,
  workspaceStickyDirectoryPathsForViewport,
  type WorkspaceFileStickyContextItem,
  type WorkspaceFileRowSnapshot,
} from '@/lib/workspace-file-view-model'

export type FileStickyContextItem = WorkspaceFileStickyContextItem

const FILE_STICKY_CONTEXT_HEIGHT = 40

interface UseWorkspaceFileStickyContextOptions {
  filesCollapsed: boolean
  focusFileTreePath: (path: string) => void
  lastFocusedFilePathRef: MutableRefObject<string | null>
  openDirectoryPaths: ReadonlySet<string>
  refreshTreeLayout: () => void
  resetKey: string | null
  treeData: FileExplorerNode[]
  treeViewportRef: RefObject<HTMLDivElement | null>
}

function stickyContentTop(scroller: HTMLElement, viewport: HTMLElement) {
  const projectGroup = viewport.closest<HTMLElement>('.code-project-group')
  const projectRow = projectGroup?.querySelector<HTMLElement>('.code-project-row')
  const agentsSection = projectGroup?.querySelector<HTMLElement>('.code-agents-section')
  const openEditorsSection = projectGroup?.querySelector<HTMLElement>('[data-testid="code-open-editors"]')
  return workspaceStickyContentTop(
    scroller.getBoundingClientRect().top,
    projectRow?.getBoundingClientRect().height ?? 30,
    (agentsSection?.getBoundingClientRect().height ?? 0) + (openEditorsSection?.getBoundingClientRect().height ?? 0),
    25
  )
}

export function useWorkspaceFileStickyContext({
  filesCollapsed,
  focusFileTreePath,
  lastFocusedFilePathRef,
  openDirectoryPaths,
  refreshTreeLayout,
  resetKey,
  treeData,
  treeViewportRef,
}: UseWorkspaceFileStickyContextOptions) {
  const [stickyDirectoryPaths, setStickyDirectoryPaths] = useState<string[]>([])

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

  const clearStickyContext = useCallback(() => {
    setStickyDirectoryPaths(current => current.length === 0 ? current : [])
  }, [])

  const refreshStickyAncestors = useCallback(() => {
    const viewport = treeViewportRef.current
    const scroller = viewport?.closest<HTMLElement>('.code-project-list')
    if (!viewport || !scroller || filesCollapsed) {
      clearStickyContext()
      return
    }

    const scrollerRect = scroller.getBoundingClientRect()
    const stickyTop = stickyContentTop(scroller, viewport)
    const viewportRect = viewport.getBoundingClientRect()
    if (!isWorkspaceStickyContextVisible(viewportRect.top, stickyTop)) {
      clearStickyContext()
      return
    }

    const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-file-path]'))
    const rowSnapshots: WorkspaceFileRowSnapshot[] = rows.flatMap(row => {
      const path = row.dataset.filePath
      if (!path) return []
      const rect = row.getBoundingClientRect()
      const depth = Number(row.dataset.treeLevel)
      return [{
        path,
        type: row.dataset.fileType,
        depth: Number.isFinite(depth) ? depth : undefined,
        top: rect.top,
        bottom: rect.bottom,
      }]
    })
    const firstVisiblePath = firstVisibleWorkspaceFilePath(rowSnapshots, stickyTop, scrollerRect.bottom)
    if (!firstVisiblePath) {
      clearStickyContext()
      return
    }

    const firstRowHeight = Math.max(1, rows[0]?.getBoundingClientRect().height ?? 24)
    const nextStickyPaths = workspaceStickyDirectoryPathsForViewport({
      rows: rowSnapshots,
      stickyTop,
      scrollerBottom: scrollerRect.bottom,
      rowHeight: Math.max(firstRowHeight, FILE_STICKY_CONTEXT_HEIGHT),
    })

    setStickyDirectoryPaths(current => (
      current.length === nextStickyPaths.length && current.every((path, index) => path === nextStickyPaths[index])
        ? current
        : nextStickyPaths
    ))
  }, [clearStickyContext, filesCollapsed, treeViewportRef])

  const focusStickyDirectory = useCallback((node: FileExplorerNode) => {
    lastFocusedFilePathRef.current = node.path
    focusFileTreePath(node.path)
  }, [focusFileTreePath, lastFocusedFilePathRef])

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
  }, [clearStickyContext, filesCollapsed, openDirectoryPaths, refreshTreeLayout, treeData])

  useLayoutEffect(() => {
    if (filesCollapsed) return undefined
    const scroller = treeViewportRef.current?.closest<HTMLElement>('.code-project-list')
    let frameId = 0
    const refreshBeforePaint = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(() => {
        frameId = 0
        flushSync(refreshStickyAncestors)
      })
    }

    refreshStickyAncestors()
    window.setTimeout(refreshStickyAncestors, 80)
    scroller?.addEventListener('scroll', refreshBeforePaint, { passive: true })
    window.addEventListener('resize', refreshBeforePaint)
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      scroller?.removeEventListener('scroll', refreshBeforePaint)
      window.removeEventListener('resize', refreshBeforePaint)
    }
  }, [filesCollapsed, openDirectoryPaths, refreshStickyAncestors, treeData, treeViewportRef])

  return {
    focusStickyDirectory,
    stickyContextItems,
  }
}
