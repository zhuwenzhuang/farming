import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceFiles } from '@/hooks/useWorkspaceFiles'
import {
  buildWorkspaceFileTreeNodes,
  countVisibleWorkspaceTreeRows,
  findWorkspaceFileTreeNode,
  type WorkspaceFileTreeNode,
} from '@/lib/workspace-file-tree'
import {
  loadCodeProjectFilesViewState,
  saveCodeProjectFilesViewState,
} from '@/components/code/workspace-view-state'

const COMPACT_DIRECTORY_PRELOAD_MAX_DEPTH = 12

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

export function useWorkspaceFileExplorer(agentId: string | null, workspaceKey = agentId) {
  const normalizedWorkspaceKey = workspaceKey || ''
  const {
    directories,
    loadDirectory,
    ensureDirectoryLoaded,
  } = useWorkspaceFiles(agentId, workspaceKey)
  const [openDirectoryPaths, setOpenDirectoryPaths] = useState<Set<string>>(() => new Set(
    loadCodeProjectFilesViewState(normalizedWorkspaceKey).openDirectoryPaths ?? []
  ))
  const openDirectoryWorkspaceKeyRef = useRef(normalizedWorkspaceKey)
  const restoringOpenDirectoryPathsRef = useRef(openDirectoryPaths.size > 0)
  const compactDirectoryHydrationRef = useRef(new Map<string, Promise<void>>())
  const restoredDirectoryHydrationKeyRef = useRef('')

  const treeData = useMemo<WorkspaceFileTreeNode[]>(() => (
    buildWorkspaceFileTreeNodes(directories['']?.items ?? [], directories)
  ), [directories])
  const visibleTreeRowCount = useMemo(() => (
    Math.max(1, countVisibleWorkspaceTreeRows(treeData, openDirectoryPaths))
  ), [openDirectoryPaths, treeData])

  const syncOpenDirectoryPaths = useCallback((nextOpenPaths: ReadonlySet<string>) => {
    setOpenDirectoryPaths(current => {
      const next = new Set(nextOpenPaths)
      if (restoringOpenDirectoryPathsRef.current) {
        current.forEach(directoryPath => next.add(directoryPath))
      } else {
        current.forEach(directoryPath => {
          if (!findWorkspaceFileTreeNode(treeData, directoryPath)) next.add(directoryPath)
        })
      }
      return sameStringSet(current, next) ? current : next
    })
  }, [treeData])

  const finishRestoringOpenDirectoryPaths = useCallback(() => {
    restoringOpenDirectoryPathsRef.current = false
  }, [])

  const setDirectoryOpen = useCallback((directoryPath: string, open: boolean) => {
    setOpenDirectoryPaths(current => {
      const alreadyOpen = current.has(directoryPath)
      if (alreadyOpen === open) return current
      const next = new Set(current)
      if (open) {
        next.add(directoryPath)
      } else {
        next.delete(directoryPath)
      }
      return next
    })
  }, [])

  const openDirectoriesInLayout = useCallback((directoryPaths: string[]) => {
    if (directoryPaths.length === 0) return
    setOpenDirectoryPaths(current => {
      let changed = false
      const next = new Set(current)
      directoryPaths.forEach(directoryPath => {
        if (!directoryPath || next.has(directoryPath)) return
        next.add(directoryPath)
        changed = true
      })
      return changed ? next : current
    })
  }, [])

  const loadRootDirectory = useCallback(() => (
    loadDirectory('')
  ), [loadDirectory])

  const loadMissingDirectories = useCallback((directoryPaths: string[]) => {
    const missingDirectories = directoryPaths.filter(directoryPath => !directories[directoryPath])
    return Promise.all(missingDirectories.map(directoryPath => loadDirectory(directoryPath)))
  }, [directories, loadDirectory])

  const isDirectoryLoaded = useCallback((directoryPath: string) => {
    const directory = directories[directoryPath]
    return Boolean(directory && !directory.loading && !directory.error)
  }, [directories])

  const refreshDirectories = useCallback((directoryPaths: Array<string | null | undefined>) => {
    Array.from(new Set(directoryPaths.map(path => path ?? ''))).forEach(directoryPath => {
      loadDirectory(directoryPath)
    })
  }, [loadDirectory])

  const hydrateCompactDirectoryChains = useCallback((directoryPath: string) => {
    const existingHydration = compactDirectoryHydrationRef.current.get(directoryPath)
    if (existingHydration) return existingHydration

    let hydration: Promise<void>
    hydration = (async () => {
      let currentPath = directoryPath
      for (let depth = 0; depth < COMPACT_DIRECTORY_PRELOAD_MAX_DEPTH; depth += 1) {
        const currentDirectory = await ensureDirectoryLoaded(currentPath)
        const nextDirectory = currentDirectory?.items.length === 1 && currentDirectory.items[0]?.type === 'directory'
          ? currentDirectory.items[0]
          : null
        if (!nextDirectory) return
        currentPath = nextDirectory.path
      }
    })().finally(() => {
      if (compactDirectoryHydrationRef.current.get(directoryPath) === hydration) {
        compactDirectoryHydrationRef.current.delete(directoryPath)
      }
    })
    compactDirectoryHydrationRef.current.set(directoryPath, hydration)
    return hydration
  }, [ensureDirectoryLoaded])

  useEffect(() => {
    compactDirectoryHydrationRef.current.clear()
  }, [agentId])

  useEffect(() => {
    if (openDirectoryWorkspaceKeyRef.current !== normalizedWorkspaceKey) return
    saveCodeProjectFilesViewState(normalizedWorkspaceKey, {
      openDirectoryPaths: Array.from(openDirectoryPaths),
    })
  }, [normalizedWorkspaceKey, openDirectoryPaths])

  useEffect(() => {
    if (openDirectoryWorkspaceKeyRef.current === normalizedWorkspaceKey) return
    openDirectoryWorkspaceKeyRef.current = normalizedWorkspaceKey
    restoredDirectoryHydrationKeyRef.current = ''
    const restoredPaths = loadCodeProjectFilesViewState(normalizedWorkspaceKey).openDirectoryPaths ?? []
    restoringOpenDirectoryPathsRef.current = restoredPaths.length > 0
    setOpenDirectoryPaths(new Set(restoredPaths))
  }, [normalizedWorkspaceKey])

  useEffect(() => {
    if (openDirectoryPaths.size === 0) return
    const hydrationKey = `${normalizedWorkspaceKey}:${Array.from(openDirectoryPaths).join('\n')}`
    if (restoredDirectoryHydrationKeyRef.current === hydrationKey) return
    restoredDirectoryHydrationKeyRef.current = hydrationKey
    void loadRootDirectory()
    void loadMissingDirectories(Array.from(openDirectoryPaths))
  }, [loadMissingDirectories, loadRootDirectory, normalizedWorkspaceKey, openDirectoryPaths])

  return useMemo(() => ({
    directories,
    treeData,
    openDirectoryPaths,
    visibleTreeRowCount,
    loadRootDirectory,
    ensureDirectoryLoaded,
    isDirectoryLoaded,
    loadMissingDirectories,
    refreshDirectories,
    hydrateCompactDirectoryChains,
    syncOpenDirectoryPaths,
    finishRestoringOpenDirectoryPaths,
    setDirectoryOpen,
    openDirectoriesInLayout,
  }), [
    directories,
    ensureDirectoryLoaded,
    hydrateCompactDirectoryChains,
    isDirectoryLoaded,
    loadMissingDirectories,
    loadRootDirectory,
    openDirectoriesInLayout,
    openDirectoryPaths,
    refreshDirectories,
    setDirectoryOpen,
    syncOpenDirectoryPaths,
    finishRestoringOpenDirectoryPaths,
    treeData,
    visibleTreeRowCount,
  ])
}
