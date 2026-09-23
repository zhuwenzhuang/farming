import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getBackendConnectionSnapshot } from '@/lib/backend-live-status'
import {
  fetchWorkspaceTree,
  fetchWorkspaceTreeDecorations,
  WorkspaceFileApiError,
  type WorkspaceFileEntry,
} from '@/lib/workspace-files'
import { isDescendantPath, parentDirectory } from '@/lib/workspace-file-tree'
import { WorkspaceFileDecorationStore } from '@/lib/workspace-file-decorations'

interface DirectoryState {
  items: WorkspaceFileEntry[]
  loading: boolean
  error: string | null
  tooLarge?: boolean
}

interface WorkspaceDirectoryTree {
  path: string
  items: WorkspaceFileEntry[]
}

interface InFlightDirectoryLoad {
  controller: AbortController
  promise: Promise<WorkspaceDirectoryTree | null>
}

interface InFlightDecorationLoad {
  controller: AbortController
}

const WORKSPACE_FILE_REQUEST_TIMEOUT_MS = 15_000

function normalizeDirectoryPath(directoryPath: string) {
  return directoryPath.replace(/^\/+|\/+$/g, '')
}

function sameWorkspaceFileEntry(left: WorkspaceFileEntry, right: WorkspaceFileEntry) {
  return left.name === right.name
    && left.path === right.path
    && left.type === right.type
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.version === right.version
    && left.symbolicLink === right.symbolicLink
    && left.external === right.external
    && left.readOnly === right.readOnly
    && left.linkTarget === right.linkTarget
    && left.linkError === right.linkError
}

function reconcileWorkspaceFileEntries(previous: WorkspaceFileEntry[], next: WorkspaceFileEntry[]) {
  const previousByPath = new Map(previous.map(entry => [entry.path, entry]))
  const reconciled = next.map(entry => {
    const current = previousByPath.get(entry.path)
    return current && sameWorkspaceFileEntry(current, entry) ? current : entry
  })
  return previous.length === reconciled.length
    && previous.every((entry, index) => entry === reconciled[index])
    ? previous
    : reconciled
}

export function useWorkspaceFiles(agentId: string | null, workspaceKey = agentId) {
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const directoriesRef = useRef<Record<string, DirectoryState>>({})
  const inFlightDirectoryLoadsRef = useRef(new Map<string, InFlightDirectoryLoad>())
  const inFlightDecorationLoadsRef = useRef(new Map<string, InFlightDecorationLoad>())
  const decorationStoreRef = useRef<WorkspaceFileDecorationStore | null>(null)
  if (!decorationStoreRef.current) decorationStoreRef.current = new WorkspaceFileDecorationStore()
  const decorations = decorationStoreRef.current
  const reconnectDirectoryLoadsRef = useRef(new Set<string>())
  const generationRef = useRef(0)

  const loadDirectoryDecorations = useCallback((
    normalizedPath: string,
    entryPaths: string[],
    replacedEntryPaths: string[],
    generation: number,
  ) => {
    if (!agentId) return
    inFlightDecorationLoadsRef.current.get(normalizedPath)?.controller.abort()
    if (entryPaths.length === 0) {
      decorations.replace(replacedEntryPaths, [])
      inFlightDecorationLoadsRef.current.delete(normalizedPath)
      return
    }
    const controller = new AbortController()
    inFlightDecorationLoadsRef.current.set(normalizedPath, { controller })
    void fetchWorkspaceTreeDecorations(agentId, normalizedPath, entryPaths, { signal: controller.signal })
      .then(result => {
        if (generationRef.current !== generation || controller.signal.aborted) return
        decorations.replace(replacedEntryPaths, result.items)
      })
      .catch(() => {
        // Decorations are independent background state. Directory structure
        // remains usable and reconnect or explicit refresh retries the read.
      })
      .finally(() => {
        if (inFlightDecorationLoadsRef.current.get(normalizedPath)?.controller === controller) {
          inFlightDecorationLoadsRef.current.delete(normalizedPath)
        }
      })
  }, [agentId, decorations])

  const loadDirectory = useCallback((directoryPath = ''): Promise<WorkspaceDirectoryTree | null> => {
    if (!agentId) return Promise.resolve(null)
    const normalizedPath = normalizeDirectoryPath(directoryPath)
    const inFlightLoad = inFlightDirectoryLoadsRef.current.get(normalizedPath)
    if (inFlightLoad) return inFlightLoad.promise
    const generation = generationRef.current
    const abortController = new AbortController()
    inFlightDecorationLoadsRef.current.get(normalizedPath)?.controller.abort()

    setDirectories(previous => {
      const next = {
        ...previous,
        [normalizedPath]: {
          items: previous[normalizedPath]?.items ?? [],
          loading: !previous[normalizedPath],
          error: null,
          tooLarge: false,
        },
      }
      directoriesRef.current = next
      return next
    })

    let request: Promise<WorkspaceDirectoryTree | null> | null = null
    request = (async () => {
      let timedOut = false
      const timeoutId = window.setTimeout(() => {
        timedOut = true
        abortController.abort()
      }, WORKSPACE_FILE_REQUEST_TIMEOUT_MS)
      try {
        const tree = await fetchWorkspaceTree(agentId, normalizedPath, { signal: abortController.signal })
        if (generationRef.current !== generation || abortController.signal.aborted) return null
        const previousItems = directoriesRef.current[normalizedPath]?.items ?? []
        const items = reconcileWorkspaceFileEntries(previousItems, tree.items)
        const directoryPaths = new Set(items.filter(item => item.type === 'directory').map(item => item.path))
        const removedPaths = previousItems.filter(item => item.type === 'directory' && !directoryPaths.has(item.path)).map(item => item.path)
        const removed = (candidate: string) => removedPaths.some(path => isDescendantPath(path, candidate))
        // A removed branch must not survive in the cache or be resurrected by
        // a read that started before its parent was refreshed.
        for (const [path, load] of inFlightDirectoryLoadsRef.current) {
          if (removed(path)) {
            load.controller.abort()
            inFlightDirectoryLoadsRef.current.delete(path)
          }
        }
        for (const [path, load] of inFlightDecorationLoadsRef.current) {
          if (removed(path)) {
            load.controller.abort()
            inFlightDecorationLoadsRef.current.delete(path)
          }
        }
        setDirectories(previous => {
          const current = previous[normalizedPath]
          const nextDirectory = { items, loading: false, error: null, tooLarge: false }
          if (
            current?.items === items
            && current.loading === nextDirectory.loading
            && current.error === nextDirectory.error
            && current.tooLarge === nextDirectory.tooLarge
          ) return previous
          const next = { ...previous, [normalizedPath]: nextDirectory }
          Object.keys(next).forEach(path => { if (removed(path)) delete next[path] })
          directoriesRef.current = next
          return next
        })
        const entryPaths = items.map(item => item.path)
        loadDirectoryDecorations(
          normalizedPath,
          entryPaths,
          Array.from(new Set([...previousItems.map(item => item.path), ...entryPaths])),
          generation,
        )
        return { path: tree.path, items }
      } catch (error) {
        if (generationRef.current !== generation) return null
        if (abortController.signal.aborted && !timedOut) return null
        if (normalizedPath && error instanceof WorkspaceFileApiError && error.status === 404) {
          // Reconcile against the parent listing; a failed read alone must not
          // remove entries (for example, a broken symbolic link still exists).
          await loadDirectory(parentDirectory(normalizedPath))
          if (generationRef.current !== generation || abortController.signal.aborted) return null
        }
        const recovering = !getBackendConnectionSnapshot().connected
        if (recovering) reconnectDirectoryLoadsRef.current.add(normalizedPath)
        setDirectories(previous => {
          const next = {
            ...previous,
            [normalizedPath]: {
              items: previous[normalizedPath]?.items ?? [],
              loading: recovering,
              error: recovering
                ? null
                : timedOut
                  ? 'File refresh timed out'
                  : error instanceof Error ? error.message : 'Failed to load directory',
              tooLarge: !recovering && error instanceof WorkspaceFileApiError
                && error.status === 413 && Number((error.details as { limit?: unknown } | null)?.limit) === 4096,
            },
          }
          directoriesRef.current = next
          return next
        })
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
  }, [agentId, loadDirectoryDecorations])

  const ensureDirectoryLoaded = useCallback((directoryPath: string) => {
    const normalizedPath = normalizeDirectoryPath(directoryPath)
    const pending = inFlightDirectoryLoadsRef.current.get(normalizedPath)
    if (pending) return pending.promise
    const directory = directoriesRef.current[normalizedPath]
    if (!directory || directory.loading || directory.error) {
      return loadDirectory(normalizedPath)
    }
    return Promise.resolve({
      path: normalizedPath,
      items: directory.items,
    })
  }, [loadDirectory])

  useEffect(() => {
    directoriesRef.current = directories
  }, [directories])

  useEffect(() => {
    generationRef.current += 1
    inFlightDirectoryLoadsRef.current.forEach(load => load.controller.abort())
    inFlightDirectoryLoadsRef.current.clear()
    inFlightDecorationLoadsRef.current.forEach(load => load.controller.abort())
    inFlightDecorationLoadsRef.current.clear()
    decorations.clear()
    reconnectDirectoryLoadsRef.current.clear()
  }, [agentId, decorations, workspaceKey])

  useEffect(() => {
    setDirectories({})
    directoriesRef.current = {}
  }, [agentId, workspaceKey])

  useEffect(() => () => {
    generationRef.current += 1
    inFlightDirectoryLoadsRef.current.forEach(load => load.controller.abort())
    inFlightDirectoryLoadsRef.current.clear()
    inFlightDecorationLoadsRef.current.forEach(load => load.controller.abort())
    inFlightDecorationLoadsRef.current.clear()
    decorations.clear()
  }, [decorations])

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
    decorations,
    directories,
    loadDirectory,
    ensureDirectoryLoaded,
  }), [decorations, directories, ensureDirectoryLoaded, loadDirectory])
}
