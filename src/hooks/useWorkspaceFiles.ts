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
  const inFlightDirectoryLoadsRef = useRef(new Map<string, Promise<WorkspaceDirectoryTree | null>>())
  const gitStatusRefreshTimersRef = useRef(new Map<string, number>())
  const generationRef = useRef(0)

  const loadDirectory = useCallback((directoryPath = ''): Promise<WorkspaceDirectoryTree | null> => {
    if (!agentId) return Promise.resolve(null)
    const normalizedPath = normalizeDirectoryPath(directoryPath)
    const inFlightLoad = inFlightDirectoryLoadsRef.current.get(normalizedPath)
    if (inFlightLoad) return inFlightLoad
    const generation = generationRef.current

    setDirectories(previous => ({
      ...previous,
      [normalizedPath]: {
        items: previous[normalizedPath]?.items ?? [],
        loading: true,
        error: null,
      },
    }))

    let request: Promise<WorkspaceDirectoryTree | null> | null = null
    request = (async () => {
      try {
        const tree = await fetchWorkspaceTree(agentId, normalizedPath)
        if (generationRef.current !== generation) return null
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
        if (generationRef.current !== generation) return null
        setDirectories(previous => ({
          ...previous,
          [normalizedPath]: {
            items: previous[normalizedPath]?.items ?? [],
            loading: false,
            error: error instanceof Error ? error.message : 'Failed to load directory',
          },
        }))
        return null
      } finally {
        if (request && inFlightDirectoryLoadsRef.current.get(normalizedPath) === request) {
          inFlightDirectoryLoadsRef.current.delete(normalizedPath)
        }
      }
    })()
    inFlightDirectoryLoadsRef.current.set(normalizedPath, request)
    return request
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
    generationRef.current += 1
    setDirectories({})
    directoriesRef.current = {}
    inFlightDirectoryLoadsRef.current.clear()
    gitStatusRefreshTimersRef.current.forEach(timer => window.clearTimeout(timer))
    gitStatusRefreshTimersRef.current.clear()
  }, [agentId])

  useEffect(() => () => {
    inFlightDirectoryLoadsRef.current.clear()
    gitStatusRefreshTimersRef.current.forEach(timer => window.clearTimeout(timer))
    gitStatusRefreshTimersRef.current.clear()
  }, [])

  return useMemo(() => ({
    directories,
    loadDirectory,
    ensureDirectoryLoaded,
  }), [directories, ensureDirectoryLoaded, loadDirectory])
}
