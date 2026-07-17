import { useCallback, useEffect, useRef, useState } from 'react'
import {
  shouldRefreshWorkspaceChangesAfterDirtyStateChange,
  workspaceOpenFileDirtyState,
  type WorkspaceOpenFileDirtySnapshot,
} from '@/lib/workspace-open-files'
import {
  fetchWorkspaceChanges,
  type WorkspaceFileChange,
} from '@/lib/workspace-files'

const WORKSPACE_CHANGES_LIMIT = 200
const WORKSPACE_CHANGES_TIMEOUT_MS = 15_000

interface WorkspaceFileChangesState {
  error: string | null
  items: WorkspaceFileChange[]
  loaded: boolean
  loading: boolean
  truncated: boolean
}

const EMPTY_CHANGES_STATE: WorkspaceFileChangesState = {
  error: null,
  items: [],
  loaded: false,
  loading: false,
  truncated: false,
}

export interface WorkspaceFileChangesController extends WorkspaceFileChangesState {
  refreshChanges: () => Promise<boolean>
}

export function useWorkspaceFileChanges(
  agentId: string | null,
  openFiles: readonly WorkspaceOpenFileDirtySnapshot[]
): WorkspaceFileChangesController {
  const [state, setState] = useState<WorkspaceFileChangesState>(EMPTY_CHANGES_STATE)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const dirtyStateRef = useRef<ReadonlyMap<string, boolean>>(new Map())
  const openFilesRef = useRef(openFiles)

  const refreshChanges = useCallback(() => {
    if (!agentId) {
      abortRef.current?.abort()
      requestIdRef.current += 1
      setState(EMPTY_CHANGES_STATE)
      return Promise.resolve(true)
    }

    abortRef.current?.abort()
    const abortController = new AbortController()
    let timedOut = false
    const timeoutId = window.setTimeout(() => {
      timedOut = true
      abortController.abort()
    }, WORKSPACE_CHANGES_TIMEOUT_MS)
    abortRef.current = abortController
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setState(current => ({
      ...current,
      error: null,
      loading: true,
    }))

    return fetchWorkspaceChanges(agentId, {
      limit: WORKSPACE_CHANGES_LIMIT,
      signal: abortController.signal,
    }).then(changes => {
      if (requestIdRef.current !== requestId) return false
      setState({
        error: null,
        items: changes.items,
        loaded: true,
        loading: false,
        truncated: changes.truncated,
      })
      return true
    }).catch(error => {
      if ((!timedOut && abortController.signal.aborted) || requestIdRef.current !== requestId) return false
      setState(current => ({
        ...current,
        error: timedOut
          ? 'File refresh timed out'
          : error instanceof Error ? error.message : 'Failed to refresh changes',
        loaded: true,
        loading: false,
      }))
      return false
    }).finally(() => window.clearTimeout(timeoutId))
  }, [agentId])

  useEffect(() => {
    openFilesRef.current = openFiles
  }, [openFiles])

  useEffect(() => {
    dirtyStateRef.current = workspaceOpenFileDirtyState(openFilesRef.current)
    void refreshChanges()
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

  return {
    ...state,
    refreshChanges,
  }
}
