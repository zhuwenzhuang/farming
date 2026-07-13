import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { TreeApi } from 'react-arborist'
import {
  ancestorDirectories,
  findWorkspaceFileTreeNode,
  findVisibleWorkspaceTreePath,
  visibleWorkspaceDirectoryPathsToOpenForTarget,
  type WorkspaceFileTreeNode,
} from '@/lib/workspace-file-tree'
import {
  shouldSelectWorkspaceFileSearchText,
  shouldFocusWorkspaceFileTree,
  shouldSkipWorkspaceFileSearchFocus,
  workspaceFileTreeFocusTargetPath,
  workspaceFileRevealScrollDelta,
  WORKSPACE_FILE_SEARCH_FOCUS_RETRY_DELAYS,
  WORKSPACE_FILE_TREE_FOCUS_RETRY_DELAYS,
} from '@/lib/workspace-file-view-model'

const FILE_TREE_REVEAL_RETRY_DELAY_MS = 50
const FILE_TREE_REVEAL_MAX_ATTEMPTS = 60
const FILE_TREE_LOCATION_HIGHLIGHT_MS = 6000
const FILE_TREE_LOCATION_STABILITY_CHECK_MS = 80
const FILE_TREE_LOCATION_STABILITY_MAX_ATTEMPTS = 100
const FILE_TREE_LOCATION_STABILITY_REQUIRED_CHECKS = 2

interface UseWorkspaceFileFocusOptions {
  treeRef: MutableRefObject<TreeApi<WorkspaceFileTreeNode> | undefined>
  treeViewportRef: MutableRefObject<HTMLDivElement | null>
  fileSearchInputRef: MutableRefObject<HTMLInputElement | null>
  fileOperationActiveRef: MutableRefObject<boolean>
  lastFocusedFilePathRef: MutableRefObject<string | null>
  treeData: WorkspaceFileTreeNode[]
  isDirectoryLoaded: (directoryPath: string) => boolean
  loadMissingDirectories: (directoryPaths: string[]) => Promise<unknown>
  openDirectoriesInLayout: (directoryPaths: string[]) => void
  refreshTreeLayout: (preserveOpenPaths?: readonly string[]) => void
}

function focusWithoutScrolling(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true })
}

function shouldPreserveMonacoFocus() {
  const activeElement = document.activeElement
  return activeElement instanceof Element && Boolean(activeElement.closest('.code-file-monaco, .monaco-editor'))
}

function visibleFileTreeRectForReveal(scroller: HTMLElement, row: HTMLElement) {
  const scrollerRect = scroller.getBoundingClientRect()
  const projectGroup = row.closest<HTMLElement>('.code-project-group')
  const filesSection = row.closest<HTMLElement>('.code-files-section')
  const stickyElements = [
    projectGroup?.querySelector<HTMLElement>('.code-project-row'),
    projectGroup?.querySelector<HTMLElement>('.code-agents-section'),
    projectGroup?.querySelector<HTMLElement>('[data-testid="code-open-editors"]'),
    filesSection?.querySelector<HTMLElement>('.code-files-header'),
    filesSection?.querySelector<HTMLElement>('.code-file-sticky-stack'),
  ]
  const top = stickyElements.reduce((nextTop, element) => {
    if (!element) return nextTop
    const rect = element.getBoundingClientRect()
    if (rect.height <= 0 || rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) return nextTop
    return Math.max(nextTop, rect.bottom)
  }, scrollerRect.top)

  return {
    top: Math.min(top, scrollerRect.bottom),
    bottom: scrollerRect.bottom,
  }
}

function revealRowInProjectScroller(row: HTMLElement, alignNearTop = false) {
  const scroller = row.closest<HTMLElement>('.code-project-list')
  if (!scroller) return

  const scrollerRect = visibleFileTreeRectForReveal(scroller, row)
  const rowRect = row.getBoundingClientRect()
  scroller.scrollTop += alignNearTop
    ? rowRect.top - scrollerRect.top - 6
    : workspaceFileRevealScrollDelta(scrollerRect, rowRect)
}

export function useWorkspaceFileFocus({
  treeRef,
  treeViewportRef,
  fileSearchInputRef,
  fileOperationActiveRef,
  lastFocusedFilePathRef,
  treeData,
  isDirectoryLoaded,
  loadMissingDirectories,
  openDirectoriesInLayout,
  refreshTreeLayout,
}: UseWorkspaceFileFocusOptions) {
  const fileSearchFocusFrameRef = useRef<number | null>(null)
  const fileSearchFocusTimeoutsRef = useRef<number[]>([])
  const fileTreeFocusFrameRef = useRef<number | null>(null)
  const fileTreeFocusTimeoutsRef = useRef<number[]>([])
  const fileTreeLocationTimeoutsRef = useRef<number[]>([])
  const fileTreeRevealFrameRefs = useRef<number[]>([])
  const fileTreeRevealTimeoutsRef = useRef<number[]>([])
  const fileTreeRevealGenerationRef = useRef(0)
  const [locatedFilePath, setLocatedFilePath] = useState<string | null>(null)
  const locatedFilePathTimeoutRef = useRef<number | null>(null)
  const treeDataRef = useRef(treeData)
  const isDirectoryLoadedRef = useRef(isDirectoryLoaded)

  useEffect(() => {
    treeDataRef.current = treeData
  }, [treeData])

  useEffect(() => {
    isDirectoryLoadedRef.current = isDirectoryLoaded
  }, [isDirectoryLoaded])

  const clearLocatedFilePath = useCallback(() => {
    setLocatedFilePath(null)
    if (locatedFilePathTimeoutRef.current !== null) {
      window.clearTimeout(locatedFilePathTimeoutRef.current)
      locatedFilePathTimeoutRef.current = null
    }
  }, [])

  const highlightLocatedFilePath = useCallback((filePath: string) => {
    if (document.body.classList.contains('code-file-location-dismissed')) return
    clearLocatedFilePath()
    setLocatedFilePath(filePath)
    locatedFilePathTimeoutRef.current = window.setTimeout(clearLocatedFilePath, FILE_TREE_LOCATION_HIGHLIGHT_MS)
  }, [clearLocatedFilePath])

  const cancelPendingFileSearchFocus = useCallback(() => {
    if (fileSearchFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(fileSearchFocusFrameRef.current)
      fileSearchFocusFrameRef.current = null
    }
    fileSearchFocusTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId))
    fileSearchFocusTimeoutsRef.current = []
  }, [])

  const cancelPendingFileTreeScrollFocus = useCallback(() => {
    if (fileTreeFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(fileTreeFocusFrameRef.current)
      fileTreeFocusFrameRef.current = null
    }
    fileTreeFocusTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId))
    fileTreeFocusTimeoutsRef.current = []
  }, [])

  const cancelPendingFileTreeLocationHighlight = useCallback(() => {
    fileTreeLocationTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId))
    fileTreeLocationTimeoutsRef.current = []
  }, [])

  const cancelPendingFileTreeFocus = useCallback(() => {
    fileTreeRevealGenerationRef.current += 1
    cancelPendingFileTreeScrollFocus()
    cancelPendingFileTreeLocationHighlight()
    fileTreeRevealFrameRefs.current.forEach(frameId => window.cancelAnimationFrame(frameId))
    fileTreeRevealFrameRefs.current = []
    fileTreeRevealTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId))
    fileTreeRevealTimeoutsRef.current = []
  }, [cancelPendingFileTreeLocationHighlight, cancelPendingFileTreeScrollFocus])

  const cancelPendingFileFocus = useCallback(() => {
    cancelPendingFileSearchFocus()
    cancelPendingFileTreeFocus()
    clearLocatedFilePath()
  }, [cancelPendingFileSearchFocus, cancelPendingFileTreeFocus, clearLocatedFilePath])

  const scrollFileTreeToPath = useCallback((filePath: string, focusRow = false, emphasizeLocation = false) => {
    cancelPendingFileTreeScrollFocus()
    cancelPendingFileTreeLocationHighlight()
    let treePositionRequested = false

    const scheduleLocationHighlight = () => {
      let stableChecks = 0
      let attempts = 0

      const check = () => {
        attempts += 1
        const row = Array.from(treeViewportRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])
          .find(element => element.dataset.filePath === filePath) ?? null
        const selected = row?.classList.contains('selected') === true
        stableChecks = selected ? stableChecks + 1 : 0

        if (row && stableChecks >= FILE_TREE_LOCATION_STABILITY_REQUIRED_CHECKS) {
          fileTreeLocationTimeoutsRef.current = []
          highlightLocatedFilePath(filePath)
          return
        }
        if (attempts >= FILE_TREE_LOCATION_STABILITY_MAX_ATTEMPTS) return
        const timeoutId = window.setTimeout(check, FILE_TREE_LOCATION_STABILITY_CHECK_MS)
        fileTreeLocationTimeoutsRef.current = [timeoutId]
      }

      check()
    }

    const scrollRenderedRow = () => {
      const searchInput = fileSearchInputRef.current
      const shouldFocusTree = shouldFocusWorkspaceFileTree({
        focusRow,
        operationActive: fileOperationActiveRef.current,
        activeElementIsSearchInput: document.activeElement === searchInput,
        searchInputValue: searchInput?.value,
      })
      const row = Array.from(treeViewportRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])
        .find(element => element.dataset.filePath === filePath)
      if (!row) return
      row.scrollIntoView({ block: 'nearest' })
      revealRowInProjectScroller(row, emphasizeLocation)
      if (shouldFocusTree) focusWithoutScrolling(row.closest<HTMLElement>('[role="tree"]'))
    }

    const scroll = () => {
      const tree = treeRef.current
      if (focusRow && !treePositionRequested) {
        treePositionRequested = true
        tree?.get(filePath)?.select()
        const scrollPromise = tree?.scrollTo(filePath, emphasizeLocation ? 'start' : 'smart')
        if (scrollPromise) {
          void scrollPromise.then(() => {
            window.requestAnimationFrame(scrollRenderedRow)
          })
        }
      }
      scrollRenderedRow()
    }

    scroll()
    fileTreeFocusFrameRef.current = window.requestAnimationFrame(() => {
      scroll()
      fileTreeFocusFrameRef.current = window.requestAnimationFrame(scroll)
    })
    WORKSPACE_FILE_TREE_FOCUS_RETRY_DELAYS.forEach(delay => {
      const timeoutId = window.setTimeout(scroll, delay)
      fileTreeFocusTimeoutsRef.current.push(timeoutId)
    })
    if (emphasizeLocation) scheduleLocationHighlight()
  }, [cancelPendingFileTreeLocationHighlight, cancelPendingFileTreeScrollFocus, fileOperationActiveRef, fileSearchInputRef, highlightLocatedFilePath, treeRef, treeViewportRef])

  const revealFilePathInTree = useCallback((
    filePath: string,
    attempt = 0,
    openTargetDirectory = false,
    generation?: number
  ) => {
    const revealGeneration = generation ?? (fileTreeRevealGenerationRef.current + 1)
    if (generation === undefined) fileTreeRevealGenerationRef.current = revealGeneration
    const revealIsCurrent = () => fileTreeRevealGenerationRef.current === revealGeneration
    const tree = treeRef.current
    const currentTreeData = treeDataRef.current
    const directoryPathsToOpen = visibleWorkspaceDirectoryPathsToOpenForTarget(
      currentTreeData,
      filePath,
      openTargetDirectory
    )
    const visibleTargetPath = findVisibleWorkspaceTreePath(currentTreeData, filePath) ?? filePath
    const visibleTargetNode = findWorkspaceFileTreeNode(currentTreeData, visibleTargetPath)
    let ready = Boolean(tree)
    openDirectoriesInLayout(directoryPathsToOpen)

    if (
      openTargetDirectory
      && (
        visibleTargetNode?.type !== 'directory'
        || !isDirectoryLoadedRef.current(filePath)
      )
    ) {
      ready = false
    }

    if (tree) {
      directoryPathsToOpen.forEach(directoryPath => {
        if (tree.get(directoryPath)) {
          tree.open(directoryPath)
        } else {
          ready = false
        }
      })
      if (openTargetDirectory && tree.get(visibleTargetPath)) {
        tree.open(visibleTargetPath)
      }
      if (!tree.get(visibleTargetPath)) ready = false
    }

    if (!ready && attempt < FILE_TREE_REVEAL_MAX_ATTEMPTS) {
      const retryTimeoutId = window.setTimeout(() => {
        fileTreeRevealTimeoutsRef.current = fileTreeRevealTimeoutsRef.current.filter(id => id !== retryTimeoutId)
        if (!revealIsCurrent()) return
        revealFilePathInTree(filePath, attempt + 1, openTargetDirectory, revealGeneration)
      }, FILE_TREE_REVEAL_RETRY_DELAY_MS)
      fileTreeRevealTimeoutsRef.current.push(retryTimeoutId)
      return
    }

    const reveal = () => {
      if (!revealIsCurrent()) return
      directoryPathsToOpen.forEach(directoryPath => treeRef.current?.open(directoryPath))
      refreshTreeLayout(directoryPathsToOpen)
      scrollFileTreeToPath(visibleTargetPath, true, openTargetDirectory)
    }
    const queueRevealFrame = (callback: () => void) => {
      const frameId = window.requestAnimationFrame(() => {
        fileTreeRevealFrameRefs.current = fileTreeRevealFrameRefs.current.filter(id => id !== frameId)
        if (!revealIsCurrent()) return
        callback()
      })
      fileTreeRevealFrameRefs.current.push(frameId)
    }
    queueRevealFrame(reveal)
  }, [openDirectoriesInLayout, refreshTreeLayout, scrollFileTreeToPath, treeRef])

  const revealFilePath = useCallback(async (filePath: string) => {
    const ancestors = ancestorDirectories(filePath)
    await loadMissingDirectories(['', ...ancestors])
    revealFilePathInTree(filePath)
  }, [loadMissingDirectories, revealFilePathInTree])

  const revealExplorerPath = useCallback(async (filePath: string, kind: 'directory' | 'file') => {
    if (kind === 'directory') {
      document.body.classList.remove('code-file-location-dismissed')
      clearLocatedFilePath()
    }
    const ancestors = ancestorDirectories(filePath)
    await loadMissingDirectories([
      '',
      ...ancestors,
      ...(kind === 'directory' && filePath ? [filePath] : []),
    ])
    revealFilePathInTree(filePath, 0, kind === 'directory')
  }, [clearLocatedFilePath, loadMissingDirectories, revealFilePathInTree])

  const focusFileSearchInput = useCallback(() => {
    cancelPendingFileFocus()
    const focusSearchInput = (selectText = false) => {
      const input = fileSearchInputRef.current
      if (!input) return
      if (shouldSkipWorkspaceFileSearchFocus({
        activeElementIsSearchInput: document.activeElement === input,
        searchInputValue: input.value,
      })) return
      input.focus()
      if (shouldSelectWorkspaceFileSearchText({
        requestedSelect: selectText,
        searchInputValue: input.value,
      })) input.select()
    }
    const queueFocusRetry = (delay: number) => {
      const timeoutId = window.setTimeout(() => focusSearchInput(false), delay)
      fileSearchFocusTimeoutsRef.current.push(timeoutId)
    }

    focusSearchInput(true)
    fileSearchFocusFrameRef.current = window.requestAnimationFrame(() => focusSearchInput(false))
    WORKSPACE_FILE_SEARCH_FOCUS_RETRY_DELAYS.forEach(queueFocusRetry)
  }, [cancelPendingFileFocus, fileSearchInputRef])

  const focusFileTreeFromSearch = useCallback(() => {
    cancelPendingFileFocus()
    const focusTree = () => {
      const searchInput = fileSearchInputRef.current
      if (searchInput?.value) return
      fileSearchInputRef.current?.blur()
      const targetTree = treeViewportRef.current?.querySelector<HTMLElement>('[role="tree"]')
      const rows = Array.from(treeViewportRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])
      const targetPath = workspaceFileTreeFocusTargetPath({
        lastFocusedPath: lastFocusedFilePathRef.current,
        rows: rows.map(element => ({
          path: element.dataset.filePath ?? '',
          selected: element.classList.contains('selected'),
        })).filter(row => row.path),
      })
      const targetRow = targetPath ? rows.find(element => element.dataset.filePath === targetPath) : null
      if (targetRow && targetPath) {
        lastFocusedFilePathRef.current = targetPath
        treeRef.current?.get(targetPath)?.select()
        focusWithoutScrolling(targetTree)
        return
      }
      focusWithoutScrolling(targetTree)
    }

    const queueFocusRetry = (delay: number) => {
      const timeoutId = window.setTimeout(focusTree, delay)
      fileTreeFocusTimeoutsRef.current.push(timeoutId)
    }

    focusTree()
    fileTreeFocusFrameRef.current = window.requestAnimationFrame(focusTree)
    WORKSPACE_FILE_TREE_FOCUS_RETRY_DELAYS.forEach(queueFocusRetry)
  }, [cancelPendingFileFocus, fileSearchInputRef, lastFocusedFilePathRef, treeRef, treeViewportRef])

  const focusFileTreePath = useCallback((filePath: string | null) => {
    cancelPendingFileTreeScrollFocus()
    const focusTarget = () => {
      if (shouldPreserveMonacoFocus()) return
      if (filePath) {
        treeRef.current?.get(filePath)?.select()
        const row = Array.from(treeViewportRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])
          .find(element => element.dataset.filePath === filePath)
        const targetTree = row?.closest<HTMLElement>('[role="tree"]')
          ?? treeViewportRef.current?.querySelector<HTMLElement>('[role="tree"]')
        focusWithoutScrolling(targetTree)
        if (row) {
          row.scrollIntoView({ block: 'nearest' })
          revealRowInProjectScroller(row)
          return
        }
      }
      focusWithoutScrolling(treeViewportRef.current?.querySelector<HTMLElement>('[role="tree"]'))
    }
    focusTarget()
    fileTreeFocusFrameRef.current = window.requestAnimationFrame(() => {
      fileTreeFocusFrameRef.current = null
      focusTarget()
    })
    ;[80, 180, 360].forEach(delay => {
      const timeoutId = window.setTimeout(focusTarget, delay)
      fileTreeFocusTimeoutsRef.current.push(timeoutId)
    })
  }, [cancelPendingFileTreeScrollFocus, treeRef, treeViewportRef])

  const focusFileTreeTarget = useCallback((item: WorkspaceFileTreeNode | null) => {
    focusFileTreePath(item?.path ?? null)
  }, [focusFileTreePath])

  useEffect(() => {
    if (!locatedFilePath) return undefined
    const dismissLocation = (event: PointerEvent | KeyboardEvent) => {
      const target = event.target
      const targetRow = target instanceof Element ? target.closest<HTMLElement>('[data-file-path]') : null
      if (targetRow?.dataset.filePath === locatedFilePath) return
      document.body.classList.add('code-file-location-dismissed')
      clearLocatedFilePath()
    }
    document.addEventListener('pointerdown', dismissLocation, true)
    document.addEventListener('keydown', dismissLocation, true)
    return () => {
      document.removeEventListener('pointerdown', dismissLocation, true)
      document.removeEventListener('keydown', dismissLocation, true)
    }
  }, [clearLocatedFilePath, locatedFilePath])

  useEffect(() => () => {
    cancelPendingFileFocus()
    clearLocatedFilePath()
  }, [cancelPendingFileFocus, clearLocatedFilePath])

  return {
    cancelPendingFileFocus,
    focusFileSearchInput,
    focusFileTreeFromSearch,
    focusFileTreePath,
    focusFileTreeTarget,
    locatedFilePath,
    revealExplorerPath,
    revealFilePath,
  }
}
