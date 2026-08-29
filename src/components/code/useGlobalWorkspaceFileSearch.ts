import { useEffect, useMemo, useRef, useState } from 'react'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import { parseWorkspaceFileJumpQuery } from '@/lib/workspace-file-search'
import { searchWorkspaceFiles } from '@/lib/workspace-files'

const GLOBAL_FILE_SEARCH_DEBOUNCE_MS = 180
const GLOBAL_FILE_SEARCH_CONCURRENCY = 4
const GLOBAL_FILE_SEARCH_PROJECT_RESULT_LIMIT = 16
const GLOBAL_FILE_SEARCH_LIMIT = 80
const GLOBAL_FILE_SEARCH_PROJECT_DEADLINE_MS = 2_500
const GLOBAL_FILE_SEARCH_DEADLINE_MS = 8_000
export const GLOBAL_FILE_SEARCH_QUERY_MAX_LENGTH = 4_096

export interface GlobalWorkspaceFileSearchProject {
  id: string
  name: string
  workspace: string
}

export interface GlobalWorkspaceFileSearchMatch {
  key: string
  path: string
  projectId: string
  projectName: string
  rootId: string
  workspace: string
  lineNumber?: number
  column?: number
}

function abortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  worker: (value: T) => Promise<R>,
  onSettled?: (index: number, result: R) => void,
) {
  const results = new Array<R | undefined>(values.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), values.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!signal.aborted) {
      const index = nextIndex
      nextIndex += 1
      const value = values[index]
      if (value === undefined) return
      try {
        const result = await worker(value)
        results[index] = result
        onSettled?.(index, result)
      } catch (error) {
        if (signal.aborted) return
        throw error
      }
    }
  }))
  return results
}

function searchableProjects(projects: readonly GlobalWorkspaceFileSearchProject[]) {
  const seenRoots = new Set<string>()
  return projects.flatMap(project => {
    const workspace = project.workspace.trim()
    if (!workspace || workspace === '/') return []
    const rootId = projectFilesWorkspaceId(workspace)
    if (seenRoots.has(rootId)) return []
    seenRoots.add(rootId)
    return [{ ...project, rootId, workspace }]
  })
}

function sameSearchableProjects(
  left: readonly (GlobalWorkspaceFileSearchProject & { rootId: string })[],
  right: readonly (GlobalWorkspaceFileSearchProject & { rootId: string })[],
) {
  return left.length === right.length && left.every((project, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && candidate.id === project.id
      && candidate.name === project.name
      && candidate.rootId === project.rootId
      && candidate.workspace === project.workspace
  })
}

function isAbsoluteWorkspaceFileQuery(query: string) {
  return query.startsWith('/') || /^[A-Za-z]:\//.test(query)
}

export function pathQueryForWorkspace(query: string, workspace: string) {
  const normalizedQuery = query.trim().replace(/\\/g, '/')
  if (!isAbsoluteWorkspaceFileQuery(normalizedQuery)) return normalizedQuery.replace(/^\.\/+/, '')
  const normalizedWorkspace = workspace.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  if (normalizedWorkspace === '/' || !isAbsoluteWorkspaceFileQuery(normalizedWorkspace)) return null
  const windowsPath = /^[A-Za-z]:\//.test(normalizedQuery) || /^[A-Za-z]:\//.test(normalizedWorkspace)
  const comparableQuery = windowsPath ? normalizedQuery.toLowerCase() : normalizedQuery
  const comparableWorkspace = windowsPath ? normalizedWorkspace.toLowerCase() : normalizedWorkspace
  if (comparableQuery === comparableWorkspace) return ''
  return comparableQuery.startsWith(`${comparableWorkspace}/`)
    ? normalizedQuery.slice(normalizedWorkspace.length + 1)
    : null
}

export function useGlobalWorkspaceFileSearch({
  active,
  projects,
  query,
}: {
  active: boolean
  projects: readonly GlobalWorkspaceFileSearchProject[]
  query: string
}) {
  const [matches, setMatches] = useState<GlobalWorkspaceFileSearchMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [failedProjectCount, setFailedProjectCount] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const requestIdRef = useRef(0)
  const queryTooLong = query.trim().length > GLOBAL_FILE_SEARCH_QUERY_MAX_LENGTH
  const nextTargets = searchableProjects(projects)
  const allTargetsRef = useRef(nextTargets)
  if (!sameSearchableProjects(allTargetsRef.current, nextTargets)) allTargetsRef.current = nextTargets
  const allTargets = allTargetsRef.current

  useEffect(() => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const trimmedQuery = query.trim()
    const jumpTarget = parseWorkspaceFileJumpQuery(trimmedQuery)
    const pathQuery = jumpTarget?.path ?? trimmedQuery
    const normalizedPathQuery = pathQuery.replace(/\\/g, '/')
    const targets = isAbsoluteWorkspaceFileQuery(normalizedPathQuery)
      ? allTargets.filter(target => pathQueryForWorkspace(pathQuery, target.workspace) !== null)
      : allTargets
    if (!active || !trimmedQuery || queryTooLong || targets.length === 0) {
      setMatches([])
      setLoading(false)
      setFailedProjectCount(0)
      setTruncated(false)
      return undefined
    }

    setMatches([])
    setLoading(true)
    setFailedProjectCount(0)
    setTruncated(false)
    const abortController = new AbortController()
    let cancelled = false
    let deadlineReached = false
    let published = false
    let deadlineId: number | undefined
    const timeoutId = window.setTimeout(() => {
      type SearchTarget = (typeof targets)[number]
      type SearchOutcome =
        | { target: SearchTarget; result: Pick<Awaited<ReturnType<typeof searchWorkspaceFiles>>, 'matches' | 'truncated'> }
        | { target: SearchTarget; error: unknown }
      const completedResults = new Array<SearchOutcome | undefined>(targets.length)
      const publish = (results: Array<SearchOutcome | undefined>, incompleteByDeadline: boolean) => {
        if (published || cancelled || requestIdRef.current !== requestId) return
        published = true
        if (deadlineId !== undefined) window.clearTimeout(deadlineId)
        let failedCount = 0
        let incomplete = incompleteByDeadline
        const nextMatches: GlobalWorkspaceFileSearchMatch[] = []
        for (const outcome of results) {
          if (!outcome) continue
          if ('error' in outcome) {
            failedCount += 1
            continue
          }
          incomplete ||= outcome.result.truncated
          for (const match of outcome.result.matches) {
            if (match.kind !== 'path' || match.entryType !== 'file') continue
            if (nextMatches.length >= GLOBAL_FILE_SEARCH_LIMIT) {
              incomplete = true
              continue
            }
            nextMatches.push({
              key: `${outcome.target.rootId}:${match.path}`,
              path: match.path,
              projectId: outcome.target.id,
              projectName: outcome.target.name,
              rootId: outcome.target.rootId,
              workspace: outcome.target.workspace,
              ...(jumpTarget ? {
                lineNumber: jumpTarget.lineNumber,
                ...(jumpTarget.column ? { column: jumpTarget.column } : {}),
              } : {}),
            })
          }
        }
        setMatches(nextMatches)
        setFailedProjectCount(failedCount)
        setTruncated(incomplete)
        setLoading(false)
      }
      deadlineId = window.setTimeout(() => {
        deadlineReached = true
        abortController.abort()
        publish(completedResults, true)
      }, GLOBAL_FILE_SEARCH_DEADLINE_MS)
      void mapWithConcurrency(
        targets,
        GLOBAL_FILE_SEARCH_CONCURRENCY,
        abortController.signal,
        async target => {
          const targetQuery = pathQueryForWorkspace(pathQuery, target.workspace)
          if (!targetQuery) return { target, result: { matches: [], truncated: false } }
          const projectAbortController = new AbortController()
          const abortProject = () => projectAbortController.abort()
          abortController.signal.addEventListener('abort', abortProject, { once: true })
          const projectDeadlineId = window.setTimeout(abortProject, GLOBAL_FILE_SEARCH_PROJECT_DEADLINE_MS)
          try {
            const result = await searchWorkspaceFiles(target.rootId, targetQuery, {
              limit: GLOBAL_FILE_SEARCH_PROJECT_RESULT_LIMIT,
              scope: 'file-path',
              signal: projectAbortController.signal,
            })
            return { target, result }
          } catch (error) {
            return { target, error }
          } finally {
            window.clearTimeout(projectDeadlineId)
            abortController.signal.removeEventListener('abort', abortProject)
          }
        },
        (index, result) => { completedResults[index] = result },
      ).then(results => {
        publish(results, deadlineReached)
      }).catch(error => {
        if (abortError(error) || abortController.signal.aborted) publish(completedResults, true)
        else publish(targets.map(target => ({ target, error })), deadlineReached)
      })
    }, GLOBAL_FILE_SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
      if (deadlineId !== undefined) window.clearTimeout(deadlineId)
      abortController.abort()
    }
  }, [active, allTargets, query, queryTooLong, retryNonce])

  return useMemo(() => ({
    failedProjectCount,
    loading,
    matches,
    queryTooLong,
    retry: () => setRetryNonce(value => value + 1),
    truncated,
  }), [failedProjectCount, loading, matches, queryTooLong, truncated])
}

export type GlobalWorkspaceFileSearchState = ReturnType<typeof useGlobalWorkspaceFileSearch>
