import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { TreeApi } from 'react-arborist'
import {
  ancestorDirectories,
  findWorkspaceFileTreeNode,
  findVisibleWorkspaceTreePath,
  visibleWorkspaceDirectoryPathsForTarget,
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
  refreshTreeLayout: () => void
}

function focusWithoutScrolling(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true })
}

function shouldPreserveMonacoFocus() {
  const activeElement = document.activeElement
  return activeElement instanceof Element && Boolean(activeElement.closest('.code-file-monaco, .monaco-editor'))
}

function revealRowInProjectScroller(row: HTMLElement) {
  const scroller = row.closest<HTMLElement>('.code-project-list')
  if (!scroller) return

  const scrollerRect = scroller.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  scroller.scrollTop += workspaceFileRevealScrollDelta(scrollerRect, rowRect)
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
  const fileTreeRevealFrameRefs = useRef<number[]>([])
  const fileTreeRevealTimeoutsRef = useRef<number[]>([])
  const fileTreeRevealGenerationRef = useRef(0)
  const treeDataRef = useRef(treeData)
  const isDirectoryLoadedRef = useRef(isDirectoryLoaded)

  useEffect(() => {
    treeDataRef.current = treeData
  }, [treeData])

  useEffect(() => {
    isDirectoryLoadedRef.current = isDirectoryLoaded
  }, [isDirectoryLoaded])

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

  const cancelPendingFileTreeFocus = useCallback(() => {
    fileTreeRevealGenerationRef.current += 1
    cancelPendingFileTreeScrollFocus()
    fileTreeRevealFrameRefs.current.forEach(frameId => window.cancelAnimationFrame(frameId))
    fileTreeRevealFrameRefs.current = []
    fileTreeRevealTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId))
    fileTreeRevealTimeoutsRef.current = []
  }, [cancelPendingFileTreeScrollFocus])

  const cancelPendingFileFocus = useCallback(() => {
    cancelPendingFileSearchFocus()
    cancelPendingFileTreeFocus()
  }, [cancelPendingFileSearchFocus, cancelPendingFileTreeFocus])

  const scrollFileTreeToPath = useCallback((filePath: string, focusRow = false) => {
    cancelPendingFileTreeScrollFocus()

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
      revealRowInProjectScroller(row)
      if (shouldFocusTree) focusWithoutScrolling(row.closest<HTMLElement>('[role="tree"]'))
    }

    const scroll = () => {
      const tree = treeRef.current
      if (focusRow) {
        tree?.get(filePath)?.select()
        const scrollPromise = tree?.scrollTo(filePath, 'smart')
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
  }, [cancelPendingFileTreeScrollFocus, fileOperationActiveRef, fileSearchInputRef, treeRef, treeViewportRef])

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
    const visibleAncestors = visibleWorkspaceDirectoryPathsForTarget(currentTreeData, filePath)
    const visibleTargetPath = findVisibleWorkspaceTreePath(currentTreeData, filePath) ?? filePath
    const visibleTargetNode = findWorkspaceFileTreeNode(currentTreeData, visibleTargetPath)
    let ready = Boolean(tree)
    openDirectoriesInLayout(openTargetDirectory ? [...visibleAncestors, visibleTargetPath] : visibleAncestors)

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
      visibleAncestors.forEach(directoryPath => {
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

    if (!ready && attempt < 10) {
      const retryTimeoutId = window.setTimeout(() => {
        fileTreeRevealTimeoutsRef.current = fileTreeRevealTimeoutsRef.current.filter(id => id !== retryTimeoutId)
        if (!revealIsCurrent()) return
        revealFilePathInTree(filePath, attempt + 1, openTargetDirectory, revealGeneration)
      }, 50)
      fileTreeRevealTimeoutsRef.current.push(retryTimeoutId)
      return
    }

    const reveal = () => {
      if (!revealIsCurrent()) return
      visibleAncestors.forEach(directoryPath => treeRef.current?.open(directoryPath))
      if (openTargetDirectory) treeRef.current?.open(visibleTargetPath)
      refreshTreeLayout()
      scrollFileTreeToPath(visibleTargetPath, true)
    }
    const queueRevealFrame = (callback: () => void) => {
      const frameId = window.requestAnimationFrame(() => {
        fileTreeRevealFrameRefs.current = fileTreeRevealFrameRefs.current.filter(id => id !== frameId)
        if (!revealIsCurrent()) return
        callback()
      })
      fileTreeRevealFrameRefs.current.push(frameId)
    }
    queueRevealFrame(() => {
      reveal()
      queueRevealFrame(reveal)
    })
    const timeoutId = window.setTimeout(() => {
      fileTreeRevealTimeoutsRef.current = fileTreeRevealTimeoutsRef.current.filter(id => id !== timeoutId)
      if (!revealIsCurrent()) return
      reveal()
    }, 80)
    fileTreeRevealTimeoutsRef.current.push(timeoutId)
  }, [openDirectoriesInLayout, refreshTreeLayout, scrollFileTreeToPath, treeRef])

  const revealFilePath = useCallback(async (filePath: string) => {
    const ancestors = ancestorDirectories(filePath)
    await loadMissingDirectories(['', ...ancestors])
    revealFilePathInTree(filePath)
  }, [loadMissingDirectories, revealFilePathInTree])

  const revealExplorerPath = useCallback(async (filePath: string, kind: 'directory' | 'file') => {
    const ancestors = ancestorDirectories(filePath)
    await loadMissingDirectories([
      '',
      ...ancestors,
      ...(kind === 'directory' && filePath ? [filePath] : []),
    ])
    revealFilePathInTree(filePath, 0, kind === 'directory')
  }, [loadMissingDirectories, revealFilePathInTree])

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
    const focusTarget = () => {
      if (shouldPreserveMonacoFocus()) return
      if (filePath) {
        treeRef.current?.get(filePath)?.select()
        const row = Array.from(treeViewportRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])
          .find(element => element.dataset.filePath === filePath)
        const targetTree = row?.closest<HTMLElement>('[role="tree"]')
          ?? treeViewportRef.current?.querySelector<HTMLElement>('[role="tree"]')
        focusWithoutScrolling(targetTree)
        if (row) return
      }
      focusWithoutScrolling(treeViewportRef.current?.querySelector<HTMLElement>('[role="tree"]'))
    }
    focusTarget()
    window.requestAnimationFrame(() => {
      focusTarget()
    })
    window.setTimeout(focusTarget, 80)
    window.setTimeout(focusTarget, 180)
    window.setTimeout(focusTarget, 360)
  }, [treeRef, treeViewportRef])

  const focusFileTreeTarget = useCallback((item: WorkspaceFileTreeNode | null) => {
    focusFileTreePath(item?.path ?? null)
  }, [focusFileTreePath])

  useEffect(() => () => {
    cancelPendingFileFocus()
  }, [cancelPendingFileFocus])

  return {
    cancelPendingFileFocus,
    focusFileSearchInput,
    focusFileTreeFromSearch,
    focusFileTreePath,
    focusFileTreeTarget,
    revealExplorerPath,
    revealFilePath,
  }
}
