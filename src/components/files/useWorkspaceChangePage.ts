import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchWorkspaceChangePage, isWorkspaceSnapshotStale, type WorkspaceChangePage } from '@/lib/workspace-files'

const empty = { items: [], total: 0, revision: '', nextCursor: null } satisfies WorkspaceChangePage

/** A page belongs to one repository, category and inventory revision. Never
 * append a response after its owner has refreshed, changed or unmounted. */
export function useWorkspaceChangePage(rootId: string | null | undefined, repositoryPath: string,
  scope: 'tracked' | 'untracked', revision: string | undefined, enabled: boolean, refreshRevision = 0, refreshChanges?: (automatic?: string) => Promise<boolean>, completePageRecovery?: (key: string) => void) {
  const recoveryKey = JSON.stringify([rootId, repositoryPath, scope])
  const owner = JSON.stringify([rootId, repositoryPath, scope, revision, refreshRevision])
  const [state, setState] = useState<{ owner: string; page: WorkspaceChangePage; loading: boolean; error: string; loaded: boolean }>({
    owner: '', page: empty, loading: false, error: '', loaded: false,
  })
  const abort = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const current = state.owner === owner ? state : { owner, page: empty, loading: false, error: '', loaded: false }
  const load = useCallback((cursor?: string) => {
    if (!rootId || !revision || abort.current) return
    const controller = new AbortController()
    abort.current = controller
    const requestGeneration = generation.current
    const timer = window.setTimeout(() => controller.abort(), 15_000)
    setState(previous => ({ owner, page: previous.owner === owner ? previous.page : empty, loading: true, error: '', loaded: previous.owner === owner && previous.loaded }))
    void fetchWorkspaceChangePage(rootId, repositoryPath, scope, cursor || `${revision}:0`, controller.signal)
      .then(page => {
        if (generation.current !== requestGeneration || controller.signal.aborted) return
        completePageRecovery?.(recoveryKey)
        setState(previous => ({ owner, page: { ...page, items: cursor ? [...previous.page.items, ...page.items] : page.items }, loading: false, error: '', loaded: true }))
      }).catch(async error => {
        if (generation.current !== requestGeneration) return
        if (!controller.signal.aborted && isWorkspaceSnapshotStale(error) && await refreshChanges?.(recoveryKey)) return
        if (generation.current !== requestGeneration) return
        setState(previous => ({ ...previous, owner, loading: false, error: controller.signal.aborted
          ? 'Change list timed out. Refresh to try again.' : error instanceof Error ? error.message : 'Change list unavailable' }))
      }).finally(() => { window.clearTimeout(timer); if (abort.current === controller) abort.current = null })
  }, [rootId, repositoryPath, scope, revision, owner, refreshChanges, completePageRecovery, recoveryKey])
  useEffect(() => {
    generation.current++
    abort.current?.abort()
    abort.current = null
    const fence = generation
    return () => { fence.current++; abort.current?.abort(); abort.current = null }
  }, [owner])
  useEffect(() => { if (enabled && !current.loaded && !current.loading && !current.error) load() }, [enabled, current.loaded, current.loading, current.error, load])
  return { ...current, loadMore: () => { if (current.page.nextCursor) load(current.page.nextCursor) } }
}
