import { prioritizeWorkspaceRequest } from '@/lib/workspace-request-client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  shouldRefreshWorkspaceChangesAfterDirtyStateChange,
  workspaceOpenFileDirtyState,
  type WorkspaceOpenFileDirtySnapshot,
} from '@/lib/workspace-open-files'
import {
  fetchWorkspaceChanges,
  type WorkspaceFileChange,
  type WorkspaceFileChanges,
} from '@/lib/workspace-files'


interface WorkspaceFileChangesState {
  owner: string | null
  trackedTruncated?: boolean
  untrackedTruncated?: boolean
  repositories?: WorkspaceFileChanges['repositories']
  error: string | null
  items: WorkspaceFileChange[]
  loaded: boolean
  loading: boolean
  truncated: boolean
}

const EMPTY_CHANGES_STATE: WorkspaceFileChangesState = {
  owner: null,
  error: null,
  items: [],
  loaded: false,
  loading: false,
  truncated: false,
}

export interface WorkspaceFileChangesController extends WorkspaceFileChangesState {
  refreshRevision?: number
  rootId?: string | null
  repository?: NonNullable<WorkspaceFileChanges['repositories']>[number]
  refreshChanges: (automatic?: string) => Promise<boolean>
  completePageRecovery?: (key: string) => void
}

export function useWorkspaceFileChanges(
  agentId: string | null,
  openFiles: readonly WorkspaceOpenFileDirtySnapshot[]
): WorkspaceFileChangesController {
  const [state, setState] = useState<WorkspaceFileChangesState>(EMPTY_CHANGES_STATE)
  const inFlightRef = useRef<{ owner: string; promise: Promise<boolean> } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const dirtyStateRef = useRef<ReadonlyMap<string, boolean>>(new Map())
  const openFilesRef = useRef(openFiles)

  const automaticRefreshUsed = useRef(new Set<string>())
  const refreshChanges = useCallback((automatic?: string) => {
    if (automatic && automaticRefreshUsed.current.has(automatic)) return Promise.resolve(false)
    if (automatic) automaticRefreshUsed.current.add(automatic)
    else automaticRefreshUsed.current.clear()
    if (!agentId) {
      abortRef.current?.abort()
      requestIdRef.current += 1
      setState(EMPTY_CHANGES_STATE)
      return Promise.resolve(true)
    }

    if (inFlightRef.current?.owner === agentId) {
      if (!automatic) prioritizeWorkspaceRequest(agentId, 'changes')
      return inFlightRef.current.promise
    }
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setState(current => ({
      ...(current.owner === agentId ? current : EMPTY_CHANGES_STATE),
      owner: agentId,
      error: null,
      loading: true,
    }))

    const promise = fetchWorkspaceChanges(agentId, {
      inventory: true,
      priority: automatic ? 'background' : 'interactive',
      signal: abortController.signal,
    }).then(changes => {
      if (requestIdRef.current !== requestId) return false
      setState({
        owner: agentId,
        error: null,
        items: changes.items,
        repositories: changes.repositories,
        trackedTruncated: changes.trackedTruncated,
        untrackedTruncated: changes.untrackedTruncated,
        loaded: true,
        loading: false,
        truncated: changes.truncated,
      })
      return true
    }).catch(error => {
      if (abortController.signal.aborted || requestIdRef.current !== requestId) return false
      setState(current => ({
        ...current,
        error: error instanceof Error ? error.message : 'Failed to refresh changes',
        loaded: true,
        loading: false,
      }))
      return false
    }).finally(() => {
      if (inFlightRef.current?.promise === promise) inFlightRef.current = null
    })
    inFlightRef.current = { owner: agentId, promise }
    return promise
  }, [agentId])

  useEffect(() => {
    openFilesRef.current = openFiles
  }, [openFiles])

  useEffect(() => {
    automaticRefreshUsed.current.clear()
    dirtyStateRef.current = workspaceOpenFileDirtyState(openFilesRef.current)
    void refreshChanges('initial')
  }, [agentId, refreshChanges])

  useEffect(() => {
    const previous = dirtyStateRef.current
    const next = workspaceOpenFileDirtyState(openFiles)
    dirtyStateRef.current = next
    if (shouldRefreshWorkspaceChangesAfterDirtyStateChange(previous, next)) {
      void refreshChanges()
    }
  }, [agentId, openFiles, refreshChanges])

  useEffect(() => () => {
    abortRef.current?.abort()
  }, [])

  const completePageRecovery = useCallback((key: string) => { automaticRefreshUsed.current.delete(key) }, [])

  return {
    completePageRecovery,
    ...(state.owner === agentId ? state : EMPTY_CHANGES_STATE),
    refreshRevision: requestIdRef.current,
    rootId: agentId,
    refreshChanges,
  }
}
