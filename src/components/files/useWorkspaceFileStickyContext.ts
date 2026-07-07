import { useCallback, useEffect, useMemo, useState, type MutableRefObject, type RefObject } from 'react'
import { findWorkspaceFileTreeNode, type WorkspaceFileTreeNode as FileExplorerNode } from '@/lib/workspace-file-tree'
import {
  firstVisibleWorkspaceFilePath,
  isWorkspaceStickyContextVisible,
  openEditorsRevealScrollDelta,
  workspaceStickyContentTop,
  workspaceStickyContextItems,
  workspaceStickyDirectoryPaths,
  type WorkspaceFileStickyContextItem,
  type WorkspaceFileRowSnapshot,
} from '@/lib/workspace-file-view-model'

export type FileStickyContextItem = WorkspaceFileStickyContextItem

interface UseWorkspaceFileStickyContextOptions {
  filesCollapsed: boolean
  filesLabel: string
  focusFileTreePath: (path: string) => void
  lastFocusedFilePathRef: MutableRefObject<string | null>
  openDirectoryPaths: ReadonlySet<string>
  openEditorsLabel: string
  openFilesCount: number
  refreshTreeLayout: () => void
  resetKey: string | null
  treeData: FileExplorerNode[]
  treeViewportRef: RefObject<HTMLDivElement | null>
}

function stickyContentTop(scroller: HTMLElement, viewport: HTMLElement, includeOpenEditors = true) {
  const projectGroup = viewport.closest<HTMLElement>('.code-project-group')
  const projectRow = projectGroup?.querySelector<HTMLElement>('.code-project-row')
  const agentsSection = projectGroup?.querySelector<HTMLElement>('.code-agents-section')
  const openEditorsSection = includeOpenEditors
    ? projectGroup?.querySelector<HTMLElement>('[data-testid="code-open-editors"]')
    : null
  return workspaceStickyContentTop(
    scroller.getBoundingClientRect().top,
    projectRow?.getBoundingClientRect().height ?? 30,
    (agentsSection?.getBoundingClientRect().height ?? 0) + (openEditorsSection?.getBoundingClientRect().height ?? 0)
  )
}

export function useWorkspaceFileStickyContext({
  filesCollapsed,
  filesLabel,
  focusFileTreePath,
  lastFocusedFilePathRef,
  openDirectoryPaths,
  openEditorsLabel,
  openFilesCount,
  refreshTreeLayout,
  resetKey,
  treeData,
  treeViewportRef,
}: UseWorkspaceFileStickyContextOptions) {
  const [stickyDirectoryPaths, setStickyDirectoryPaths] = useState<string[]>([])
  const [stickyContextVisible, setStickyContextVisible] = useState(false)

  const stickyDirectoryNodes = useMemo(() => (
    stickyDirectoryPaths
      .map(directoryPath => findWorkspaceFileTreeNode(treeData, directoryPath))
      .filter((node): node is FileExplorerNode => Boolean(node))
  ), [stickyDirectoryPaths, treeData])

  const stickyContextItems = useMemo<FileStickyContextItem[]>(() => (
    workspaceStickyContextItems({
      visible: stickyContextVisible,
      directoryNodes: stickyDirectoryNodes,
      openFilesCount,
      openEditorsLabel,
      filesLabel,
    })
  ), [filesLabel, openEditorsLabel, openFilesCount, stickyContextVisible, stickyDirectoryNodes])

  const clearStickyContext = useCallback(() => {
    setStickyDirectoryPaths(current => current.length === 0 ? current : [])
    setStickyContextVisible(false)
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
    const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-file-path]'))
    const rowSnapshots: WorkspaceFileRowSnapshot[] = rows.flatMap(row => {
      const path = row.dataset.filePath
      if (!path) return []
      const rect = row.getBoundingClientRect()
      return [{ path, top: rect.top, bottom: rect.bottom }]
    })
    const firstVisiblePath = firstVisibleWorkspaceFilePath(rowSnapshots, stickyTop, scrollerRect.bottom)
    if (!firstVisiblePath) {
      clearStickyContext()
      return
    }

    setStickyContextVisible(isWorkspaceStickyContextVisible(viewportRect.top, stickyTop))

    const nextStickyPaths = workspaceStickyDirectoryPaths(firstVisiblePath, rowSnapshots, stickyTop)

    setStickyDirectoryPaths(current => (
      current.length === nextStickyPaths.length && current.every((path, index) => path === nextStickyPaths[index])
        ? current
        : nextStickyPaths
    ))
  }, [clearStickyContext, filesCollapsed, treeViewportRef])

  const revealOpenEditorsSection = useCallback(() => {
    const reveal = () => {
      const viewport = treeViewportRef.current
      const scroller = viewport?.closest<HTMLElement>('.code-project-list')
      const section = viewport
        ?.closest<HTMLElement>('.code-project-group')
        ?.querySelector<HTMLElement>('[data-testid="code-open-editors"]')
      if (!viewport || !scroller || !section) return

      const stickyTop = stickyContentTop(scroller, viewport, false)
      scroller.scrollTop += openEditorsRevealScrollDelta(section.getBoundingClientRect().top, stickyTop)
      refreshStickyAncestors()
    }

    window.requestAnimationFrame(reveal)
    window.setTimeout(reveal, 80)
  }, [refreshStickyAncestors, treeViewportRef])

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
    const frameId = window.requestAnimationFrame(refreshTreeLayout)
    const timeoutId = window.setTimeout(refreshTreeLayout, 80)
    const lateTimeoutId = window.setTimeout(refreshTreeLayout, 180)
    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
      window.clearTimeout(lateTimeoutId)
    }
  }, [clearStickyContext, filesCollapsed, openDirectoryPaths, refreshTreeLayout, treeData])

  useEffect(() => {
    if (filesCollapsed) return undefined
    const scroller = treeViewportRef.current?.closest<HTMLElement>('.code-project-list')
    let frameId = 0
    const scheduleRefresh = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(() => {
        frameId = 0
        refreshStickyAncestors()
      })
    }

    refreshStickyAncestors()
    window.setTimeout(refreshStickyAncestors, 80)
    scroller?.addEventListener('scroll', scheduleRefresh, { passive: true })
    window.addEventListener('resize', scheduleRefresh)
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      scroller?.removeEventListener('scroll', scheduleRefresh)
      window.removeEventListener('resize', scheduleRefresh)
    }
  }, [filesCollapsed, openDirectoryPaths, refreshStickyAncestors, treeData, treeViewportRef])

  return {
    focusStickyDirectory,
    revealOpenEditorsSection,
    stickyContextItems,
  }
}
