import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchWorkspaceTree, type WorkspaceFileEntry } from '@/lib/workspace-files'

interface DirectoryState {
  items: WorkspaceFileEntry[]
  loading: boolean
  error: string | null
  gitStatusPending?: boolean
}

interface WorkspaceDirectoryTree {
  path: string
  items: WorkspaceFileEntry[]
  gitStatusPending?: boolean
}

function normalizeDirectoryPath(directoryPath: string) {
  return directoryPath.replace(/^\/+|\/+$/g, '')
}

export function useWorkspaceFiles(agentId: string | null) {
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const directoriesRef = useRef<Record<string, DirectoryState>>({})
  const gitStatusRefreshTimersRef = useRef(new Map<string, number>())

  const loadDirectory = useCallback(async (directoryPath = ''): Promise<WorkspaceDirectoryTree | null> => {
    if (!agentId) return null
    const normalizedPath = normalizeDirectoryPath(directoryPath)

    setDirectories(previous => ({
      ...previous,
      [normalizedPath]: {
        items: previous[normalizedPath]?.items ?? [],
        loading: true,
        error: null,
      },
    }))

    try {
      const tree = await fetchWorkspaceTree(agentId, normalizedPath)
      setDirectories(previous => ({
        ...previous,
        [normalizedPath]: {
          items: tree.items,
          loading: false,
          error: null,
          gitStatusPending: tree.gitStatusPending,
        },
      }))
      if (tree.gitStatusPending && !gitStatusRefreshTimersRef.current.has(normalizedPath)) {
        const timer = window.setTimeout(() => {
          gitStatusRefreshTimersRef.current.delete(normalizedPath)
          void loadDirectory(normalizedPath)
        }, 2000)
        gitStatusRefreshTimersRef.current.set(normalizedPath, timer)
      }
      return tree
    } catch (error) {
      setDirectories(previous => ({
        ...previous,
        [normalizedPath]: {
          items: previous[normalizedPath]?.items ?? [],
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load directory',
        },
      }))
      return null
    }
  }, [agentId])

  const ensureDirectoryLoaded = useCallback((directoryPath: string) => {
    const normalizedPath = normalizeDirectoryPath(directoryPath)
    const directory = directoriesRef.current[normalizedPath]
    if (!directory || directory.loading || directory.error) {
      return loadDirectory(normalizedPath)
    }
    return Promise.resolve({
      path: normalizedPath,
      items: directory.items,
      gitStatusPending: directory.gitStatusPending,
    })
  }, [loadDirectory])

  useEffect(() => {
    directoriesRef.current = directories
  }, [directories])

  useEffect(() => {
    setDirectories({})
    directoriesRef.current = {}
    gitStatusRefreshTimersRef.current.forEach(timer => window.clearTimeout(timer))
    gitStatusRefreshTimersRef.current.clear()
  }, [agentId])

  useEffect(() => () => {
    gitStatusRefreshTimersRef.current.forEach(timer => window.clearTimeout(timer))
    gitStatusRefreshTimersRef.current.clear()
  }, [])

  return useMemo(() => ({
    directories,
    loadDirectory,
    ensureDirectoryLoaded,
  }), [directories, ensureDirectoryLoaded, loadDirectory])
}
