import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceFiles } from '@/hooks/useWorkspaceFiles'
import {
  buildWorkspaceFileTreeNodes,
  countVisibleWorkspaceTreeRows,
  type WorkspaceFileTreeNode,
} from '@/lib/workspace-file-tree'
import {
  loadCodeProjectFilesViewState,
  saveCodeProjectFilesViewState,
} from '@/components/code/workspace-view-state'

const COMPACT_DIRECTORY_PRELOAD_MAX_DEPTH = 12
const WORKSPACE_DIRECTORY_REFRESH_CONCURRENCY = 6

function parentDirectoryPath(directoryPath: string) {
  const separatorIndex = directoryPath.lastIndexOf('/')
  return separatorIndex < 0 ? '' : directoryPath.slice(0, separatorIndex)
}

function directoryPathDepth(directoryPath: string) {
  return directoryPath.split('/').filter(Boolean).length
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
  const openDirectoryPathsRef = useRef(openDirectoryPaths)
  const openDirectoryWorkspaceKeyRef = useRef(normalizedWorkspaceKey)
  const compactDirectoryHydrationRef = useRef(new Map<string, Promise<void>>())
  const restoredDirectoryHydrationKeyRef = useRef('')

  const treeData = useMemo<WorkspaceFileTreeNode[]>(() => (
    buildWorkspaceFileTreeNodes(directories['']?.items ?? [], directories)
  ), [directories])
  const visibleTreeRowCount = useMemo(() => (
    Math.max(1, countVisibleWorkspaceTreeRows(treeData, openDirectoryPaths))
  ), [openDirectoryPaths, treeData])

  const setDirectoryOpen = useCallback((directoryPath: string, open: boolean) => {
    const current = openDirectoryPathsRef.current
    if (current.has(directoryPath) === open) return
    const next = new Set(current)
    if (open) {
      next.add(directoryPath)
    } else {
      next.delete(directoryPath)
    }
    openDirectoryPathsRef.current = next
    setOpenDirectoryPaths(next)
  }, [])

  const isDirectoryOpen = useCallback((directoryPath: string) => (
    openDirectoryPathsRef.current.has(directoryPath)
  ), [])

  const openDirectoriesInLayout = useCallback((directoryPaths: string[]) => {
    if (directoryPaths.length === 0) return
    const next = new Set(openDirectoryPathsRef.current)
    let changed = false
    directoryPaths.forEach(directoryPath => {
      if (!directoryPath || next.has(directoryPath)) return
      next.add(directoryPath)
      changed = true
    })
    if (!changed) return
    openDirectoryPathsRef.current = next
    setOpenDirectoryPaths(next)
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
    const requestedPaths = new Set<string>([''])
    directoryPaths.forEach(candidatePath => {
      let directoryPath = String(candidatePath ?? '').replace(/^\/+|\/+$/g, '')
      requestedPaths.add(directoryPath)
      while (directoryPath) {
        directoryPath = parentDirectoryPath(directoryPath)
        requestedPaths.add(directoryPath)
      }
    })
    const sortedPaths = Array.from(requestedPaths).sort((left, right) => (
      directoryPathDepth(left) - directoryPathDepth(right) || left.localeCompare(right)
    ))

    return (async () => {
      const refreshedDirectories = new Map<string, Awaited<ReturnType<typeof loadDirectory>>>()
      const staleDirectoryPaths = new Set<string>()
      let successful = true
      let index = 0

      while (index < sortedPaths.length) {
        const depth = directoryPathDepth(sortedPaths[index]!)
        const sameDepthPaths: string[] = []
        while (index < sortedPaths.length && directoryPathDepth(sortedPaths[index]!) === depth) {
          sameDepthPaths.push(sortedPaths[index]!)
          index += 1
        }

        const pathsToLoad = sameDepthPaths.filter(directoryPath => {
          if (!directoryPath) return true
          if (Array.from(staleDirectoryPaths).some(stalePath => (
            directoryPath === stalePath || directoryPath.startsWith(`${stalePath}/`)
          ))) return false

          const parentPath = parentDirectoryPath(directoryPath)
          const parentDirectory = refreshedDirectories.get(parentPath)
          if (parentDirectory === null) {
            successful = false
            return false
          }
          if (parentDirectory && !parentDirectory.items.some(item => (
            item.type === 'directory' && item.path === directoryPath
          ))) {
            staleDirectoryPaths.add(directoryPath)
            return false
          }
          return true
        })

        let nextPathIndex = 0
        const workers = Array.from({ length: Math.min(WORKSPACE_DIRECTORY_REFRESH_CONCURRENCY, pathsToLoad.length) }, async () => {
          while (nextPathIndex < pathsToLoad.length) {
            const directoryPath = pathsToLoad[nextPathIndex]!
            nextPathIndex += 1
            const result = await loadDirectory(directoryPath)
            refreshedDirectories.set(directoryPath, result)
            if (!result) successful = false
          }
        })
        await Promise.all(workers)
      }

      if (staleDirectoryPaths.size > 0) {
        const stalePaths = Array.from(staleDirectoryPaths)
        const next = new Set(Array.from(openDirectoryPathsRef.current).filter(directoryPath => (
          !stalePaths.some(stalePath => directoryPath === stalePath || directoryPath.startsWith(`${stalePath}/`))
        )))
        openDirectoryPathsRef.current = next
        setOpenDirectoryPaths(next)
      }

      return successful
    })()
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
    const next = new Set(restoredPaths)
    openDirectoryPathsRef.current = next
    setOpenDirectoryPaths(next)
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
    isDirectoryOpen,
    setDirectoryOpen,
    openDirectoriesInLayout,
  }), [
    directories,
    ensureDirectoryLoaded,
    hydrateCompactDirectoryChains,
    isDirectoryOpen,
    isDirectoryLoaded,
    loadMissingDirectories,
    loadRootDirectory,
    openDirectoriesInLayout,
    openDirectoryPaths,
    refreshDirectories,
    setDirectoryOpen,
    treeData,
    visibleTreeRowCount,
  ])
}
