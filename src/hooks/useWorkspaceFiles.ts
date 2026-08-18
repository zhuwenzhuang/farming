import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getBackendConnectionSnapshot } from '@/lib/backend-live-status'
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

interface InFlightDirectoryLoad {
  controller: AbortController
  promise: Promise<WorkspaceDirectoryTree | null>
}

const WORKSPACE_FILE_REQUEST_TIMEOUT_MS = 15_000

function normalizeDirectoryPath(directoryPath: string) {
  return directoryPath.replace(/^\/+|\/+$/g, '')
}

export function useWorkspaceFiles(agentId: string | null, workspaceKey = agentId) {
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const directoriesRef = useRef<Record<string, DirectoryState>>({})
  const inFlightDirectoryLoadsRef = useRef(new Map<string, InFlightDirectoryLoad>())
  const gitStatusRefreshTimersRef = useRef(new Map<string, number>())
  const reconnectDirectoryLoadsRef = useRef(new Set<string>())
  const generationRef = useRef(0)

  const loadDirectory = useCallback((directoryPath = ''): Promise<WorkspaceDirectoryTree | null> => {
    if (!agentId) return Promise.resolve(null)
    const normalizedPath = normalizeDirectoryPath(directoryPath)
    const inFlightLoad = inFlightDirectoryLoadsRef.current.get(normalizedPath)
    if (inFlightLoad) return inFlightLoad.promise
    const generation = generationRef.current
    const abortController = new AbortController()

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
      let timedOut = false
      const timeoutId = window.setTimeout(() => {
        timedOut = true
        abortController.abort()
      }, WORKSPACE_FILE_REQUEST_TIMEOUT_MS)
      try {
        const tree = await fetchWorkspaceTree(agentId, normalizedPath, { signal: abortController.signal })
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
        const recovering = !getBackendConnectionSnapshot().connected
        if (recovering) reconnectDirectoryLoadsRef.current.add(normalizedPath)
        setDirectories(previous => ({
          ...previous,
          [normalizedPath]: {
            items: previous[normalizedPath]?.items ?? [],
            loading: recovering,
            error: recovering
              ? null
              : timedOut
                ? 'File refresh timed out'
                : error instanceof Error ? error.message : 'Failed to load directory',
          },
        }))
        return null
      } finally {
        window.clearTimeout(timeoutId)
        if (request && inFlightDirectoryLoadsRef.current.get(normalizedPath)?.promise === request) {
          inFlightDirectoryLoadsRef.current.delete(normalizedPath)
        }
      }
    })()
    inFlightDirectoryLoadsRef.current.set(normalizedPath, { controller: abortController, promise: request })
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
    inFlightDirectoryLoadsRef.current.forEach(load => load.controller.abort())
    inFlightDirectoryLoadsRef.current.clear()
    reconnectDirectoryLoadsRef.current.clear()
    gitStatusRefreshTimersRef.current.forEach(timer => window.clearTimeout(timer))
    gitStatusRefreshTimersRef.current.clear()
  }, [agentId, workspaceKey])

  useEffect(() => {
    setDirectories({})
    directoriesRef.current = {}
  }, [agentId, workspaceKey])

  useEffect(() => () => {
    generationRef.current += 1
    inFlightDirectoryLoadsRef.current.forEach(load => load.controller.abort())
    inFlightDirectoryLoadsRef.current.clear()
    gitStatusRefreshTimersRef.current.forEach(timer => window.clearTimeout(timer))
    gitStatusRefreshTimersRef.current.clear()
  }, [])

  useEffect(() => {
    const retryRecoverableLoads = () => {
      const directoryPaths = Array.from(reconnectDirectoryLoadsRef.current)
      reconnectDirectoryLoadsRef.current.clear()
      directoryPaths.forEach(directoryPath => {
        void loadDirectory(directoryPath)
      })
    }
    window.addEventListener('farming:backend-connected', retryRecoverableLoads)
    return () => window.removeEventListener('farming:backend-connected', retryRecoverableLoads)
  }, [loadDirectory])

  return useMemo(() => ({
    directories,
    loadDirectory,
    ensureDirectoryLoaded,
  }), [directories, ensureDirectoryLoaded, loadDirectory])
}
