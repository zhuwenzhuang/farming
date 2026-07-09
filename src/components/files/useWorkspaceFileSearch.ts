import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  parseWorkspaceFileJumpQuery,
  type WorkspaceFileJumpQuery,
} from '@/lib/workspace-file-search'
import {
  searchWorkspaceFiles,
  type WorkspaceFileSearchMatch,
} from '@/lib/workspace-files'

export const WORKSPACE_FILE_SEARCH_LIMIT = 60
const DEFAULT_SEARCH_TIMEOUT_MS = 3000

export function useWorkspaceFileSearch(agentId: string | null) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<WorkspaceFileSearchMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectionIndex, setSelectionIndex] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_SEARCH_TIMEOUT_MS)
  const [includeIgnored, setIncludeIgnored] = useState(false)
  const requestRef = useRef(0)

  const active = query.trim().length > 0
  const jumpTarget = useMemo<WorkspaceFileJumpQuery | null>(() => (
    active ? parseWorkspaceFileJumpQuery(query) : null
  ), [active, query])
  const activeMatchIndex = matches.length > 0
    ? Math.min(selectionIndex, matches.length - 1)
    : -1
  const selectedMatch = activeMatchIndex >= 0 ? matches[activeMatchIndex] ?? null : null

  const clear = useCallback(() => {
    requestRef.current += 1
    setQuery('')
    setMatches([])
    setError(null)
    setSelectionIndex(0)
    setTruncated(false)
    setTimeoutMs(DEFAULT_SEARCH_TIMEOUT_MS)
    setIncludeIgnored(false)
    setLoading(false)
  }, [])

  const setSearchQuery = useCallback((nextQuery: string) => {
    setIncludeIgnored(false)
    setQuery(nextQuery)
  }, [])

  const searchIgnored = useCallback(() => {
    setIncludeIgnored(true)
  }, [])

  const selectNext = useCallback(() => {
    if (matches.length === 0) return
    setSelectionIndex(index => Math.min(index + 1, matches.length - 1))
  }, [matches.length])

  const selectPrevious = useCallback(() => {
    if (matches.length === 0) return
    setSelectionIndex(index => Math.max(index - 1, 0))
  }, [matches.length])

  const selectMatchIndex = useCallback((index: number) => {
    setSelectionIndex(Math.max(0, Math.min(index, Math.max(matches.length - 1, 0))))
  }, [matches.length])

  useEffect(() => {
    const trimmedQuery = query.trim()
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setSelectionIndex(0)

    if (!agentId || !trimmedQuery || parseWorkspaceFileJumpQuery(trimmedQuery)) {
      setMatches([])
      setLoading(false)
      setError(null)
      setTruncated(false)
      return undefined
    }

    setLoading(true)
    setError(null)
    const abortController = new AbortController()
    const timeoutId = window.setTimeout(() => {
      searchWorkspaceFiles(agentId, trimmedQuery, {
        includeIgnored,
        limit: WORKSPACE_FILE_SEARCH_LIMIT,
        signal: abortController.signal,
      })
        .then(results => {
          if (requestRef.current !== requestId) return
          setMatches(results.matches)
          setTruncated(results.truncated)
          setTimeoutMs(results.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS)
          setLoading(false)
        })
        .catch(searchError => {
          if (requestRef.current !== requestId) return
          if (searchError instanceof DOMException && searchError.name === 'AbortError') return
          setMatches([])
          setTruncated(false)
          setError(searchError instanceof Error ? searchError.message : 'Search failed')
          setLoading(false)
        })
    }, 180)

    return () => {
      window.clearTimeout(timeoutId)
      abortController.abort()
    }
  }, [agentId, includeIgnored, query])

  useEffect(() => {
    setSelectionIndex(index => Math.min(index, Math.max(matches.length - 1, 0)))
  }, [matches.length])

  return useMemo(() => ({
    query,
    setQuery: setSearchQuery,
    matches,
    loading,
    error,
    selectMatchIndex,
    truncated,
    timeoutMs,
    includeIgnored,
    active,
    jumpTarget,
    activeMatchIndex,
    selectedMatch,
    clear,
    searchIgnored,
    selectNext,
    selectPrevious,
  }), [
    active,
    activeMatchIndex,
    clear,
    error,
    jumpTarget,
    loading,
    matches,
    includeIgnored,
    searchIgnored,
    query,
    selectMatchIndex,
    selectNext,
    selectPrevious,
    selectedMatch,
    truncated,
    timeoutMs,
  ])
}

export type WorkspaceFileSearchState = ReturnType<typeof useWorkspaceFileSearch>
