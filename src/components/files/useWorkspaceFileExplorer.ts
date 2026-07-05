import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceFiles } from '@/hooks/useWorkspaceFiles'
import {
  buildWorkspaceFileTreeNodes,
  countVisibleWorkspaceTreeRows,
  type WorkspaceFileTreeNode,
} from '@/lib/workspace-file-tree'
import type { WorkspaceFileEntry } from '@/lib/workspace-files'

const COMPACT_DIRECTORY_PRELOAD_MAX_DEPTH = 12
const COMPACT_DIRECTORY_PRELOAD_MAX_CHILDREN = 48

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

export function useWorkspaceFileExplorer(agentId: string | null) {
  const {
    directories,
    loadDirectory,
    ensureDirectoryLoaded,
  } = useWorkspaceFiles(agentId)
  const [openDirectoryPaths, setOpenDirectoryPaths] = useState<Set<string>>(() => new Set())
  const compactDirectoryHydrationRef = useRef(new Map<string, Promise<void>>())

  const treeData = useMemo<WorkspaceFileTreeNode[]>(() => (
    buildWorkspaceFileTreeNodes(directories['']?.items ?? [], directories)
  ), [directories])
  const visibleTreeRowCount = useMemo(() => (
    Math.max(1, countVisibleWorkspaceTreeRows(treeData, openDirectoryPaths))
  ), [openDirectoryPaths, treeData])

  const syncOpenDirectoryPaths = useCallback((nextOpenPaths: ReadonlySet<string>) => {
    setOpenDirectoryPaths(current => sameStringSet(current, nextOpenPaths) ? current : new Set(nextOpenPaths))
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
      const directory = await ensureDirectoryLoaded(directoryPath)
      const childDirectories = (directory?.items ?? [])
        .filter((item): item is WorkspaceFileEntry & { type: 'directory' } => item.type === 'directory')
        .slice(0, COMPACT_DIRECTORY_PRELOAD_MAX_CHILDREN)

      await Promise.all(childDirectories.map(async childDirectory => {
        let currentPath = childDirectory.path

        for (let depth = 0; depth < COMPACT_DIRECTORY_PRELOAD_MAX_DEPTH; depth += 1) {
          const currentDirectory = await ensureDirectoryLoaded(currentPath)
          const nextDirectory = currentDirectory?.items.length === 1 && currentDirectory.items[0]?.type === 'directory'
            ? currentDirectory.items[0]
            : null
          if (!nextDirectory) return
          currentPath = nextDirectory.path
        }
      }))
    })().finally(() => {
      if (compactDirectoryHydrationRef.current.get(directoryPath) === hydration) {
        compactDirectoryHydrationRef.current.delete(directoryPath)
      }
    })
    compactDirectoryHydrationRef.current.set(directoryPath, hydration)
    return hydration
  }, [ensureDirectoryLoaded])

  useEffect(() => {
    setOpenDirectoryPaths(new Set())
    compactDirectoryHydrationRef.current.clear()
  }, [agentId])

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
    treeData,
    visibleTreeRowCount,
  ])
}
