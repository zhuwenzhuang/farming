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

function isAbsoluteWorkspaceQuery(value: string) {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value)
}

export function normalizeProjectFileSearchQuery(query: string, projectWorkspace?: string) {
  const trimmed = query.trim()
  if (!trimmed || !projectWorkspace) return trimmed
  const normalizedQuery = trimmed.replace(/\\/g, '/')
  if (!isAbsoluteWorkspaceQuery(normalizedQuery)) return trimmed
  const normalizedWorkspace = projectWorkspace.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  if (normalizedWorkspace === '/' || !isAbsoluteWorkspaceQuery(normalizedWorkspace)) return trimmed
  const windowsPath = /^[A-Za-z]:\//.test(normalizedQuery) || /^[A-Za-z]:\//.test(normalizedWorkspace)
  const comparableQuery = windowsPath ? normalizedQuery.toLowerCase() : normalizedQuery
  const comparableWorkspace = windowsPath ? normalizedWorkspace.toLowerCase() : normalizedWorkspace
  if (comparableQuery.startsWith(`${comparableWorkspace}/`)) {
    return normalizedQuery.slice(normalizedWorkspace.length + 1)
  }
  return trimmed
}

function searchMatchIdentity(match: WorkspaceFileSearchMatch) {
  return `${match.kind}:${match.entryType}:${match.path}:${match.lineNumber}`
}

export function useWorkspaceFileSearch(agentId: string | null, projectWorkspace?: string) {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const open = useCallback(() => {
    setIsOpen(true)
    setSuggestionsDismissed(false)
  }, [])
  const dismissSuggestions = useCallback(() => setSuggestionsDismissed(true), [])
  const [scopePath, setScopePath] = useState('')
  const [matches, setMatches] = useState<WorkspaceFileSearchMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [contentLoading, setContentLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectionIndex, setSelectionIndex] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_SEARCH_TIMEOUT_MS)
  const [includeIgnored, setIncludeIgnored] = useState(false)
  const requestRef = useRef(0)
  const matchesRef = useRef<WorkspaceFileSearchMatch[]>([])
  const selectionIndexRef = useRef(0)
  matchesRef.current = matches
  selectionIndexRef.current = selectionIndex

  const normalizedQuery = useMemo(
    () => normalizeProjectFileSearchQuery(query, projectWorkspace),
    [projectWorkspace, query],
  )
  const active = normalizedQuery.length > 0 && !suggestionsDismissed
  const jumpTarget = useMemo<WorkspaceFileJumpQuery | null>(() => (
    active ? parseWorkspaceFileJumpQuery(normalizedQuery) : null
  ), [active, normalizedQuery])
  const activeMatchIndex = matches.length > 0
    ? Math.min(selectionIndex, matches.length - 1)
    : -1
  const selectedMatch = activeMatchIndex >= 0 ? matches[activeMatchIndex] ?? null : null

  const clear = useCallback(() => {
    requestRef.current += 1
    setIsOpen(false)
    setSuggestionsDismissed(false)
    setQuery('')
    setScopePath('')
    setMatches([])
    setError(null)
    setSelectionIndex(0)
    setTruncated(false)
    setTimeoutMs(DEFAULT_SEARCH_TIMEOUT_MS)
    setIncludeIgnored(false)
    setLoading(false)
    setContentLoading(false)
  }, [])

  const setSearchQuery = useCallback((nextQuery: string) => {
    setIsOpen(true)
    setSuggestionsDismissed(false)
    setIncludeIgnored(false)
    if (!nextQuery) setScopePath('')
    setQuery(nextQuery)
  }, [])

  const searchInDirectory = useCallback((path: string) => {
    setIsOpen(true)
    setSuggestionsDismissed(false)
    setQuery('')
    setScopePath(path)
    setMatches([])
    setError(null)
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
    const trimmedQuery = normalizedQuery
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setSelectionIndex(0)

    if (!agentId || !trimmedQuery || parseWorkspaceFileJumpQuery(trimmedQuery)) {
      setMatches([])
      setLoading(false)
      setContentLoading(false)
      setError(null)
      setTruncated(false)
      return undefined
    }

    setLoading(true)
    setContentLoading(false)
    setError(null)
    const abortController = new AbortController()
    const timeoutId = window.setTimeout(() => {
      const commonOptions = {
        ...(scopePath ? { path: scopePath } : {}),
        limit: WORKSPACE_FILE_SEARCH_LIMIT,
        signal: abortController.signal,
      }

      if (includeIgnored) {
        searchWorkspaceFiles(agentId, trimmedQuery, {
          ...commonOptions,
          includeIgnored: true,
        })
          .then(results => {
            if (requestRef.current !== requestId) return
            setMatches(results.matches)
            setTruncated(results.truncated)
            setTimeoutMs(results.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS)
            setLoading(false)
            setContentLoading(false)
          })
          .catch(searchError => {
            if (requestRef.current !== requestId) return
            if (searchError instanceof DOMException && searchError.name === 'AbortError') return
            setMatches([])
            setTruncated(false)
            setError(searchError instanceof Error ? searchError.message : 'Search failed')
            setLoading(false)
            setContentLoading(false)
          })
        return
      }

      let fullSettled = false
      let entriesPublished = false

      // Run interactive filename/directory search alongside the full content
      // search so path hits appear immediately without waiting behind
      // background Git work or a full-repo ripgrep content scan.
      searchWorkspaceFiles(agentId, trimmedQuery, {
        ...commonOptions,
        scope: 'entries',
      })
        .then(entryResults => {
          if (requestRef.current !== requestId || fullSettled) return
          if (entryResults.matches.length === 0) return
          entriesPublished = true
          setMatches(entryResults.matches.slice(0, WORKSPACE_FILE_SEARCH_LIMIT))
          setTruncated(entryResults.truncated || entryResults.matches.length > WORKSPACE_FILE_SEARCH_LIMIT)
          setTimeoutMs(entryResults.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS)
          setLoading(false)
          setContentLoading(true)
        })
        .catch(() => {
          // The authoritative full search owns errors and empty states.
        })

      searchWorkspaceFiles(agentId, trimmedQuery, commonOptions)
        .then(results => {
          if (requestRef.current !== requestId) return
          fullSettled = true
          const previousMatches = matchesRef.current
          const previousSelected = entriesPublished && previousMatches.length > 0
            ? previousMatches[Math.min(selectionIndexRef.current, previousMatches.length - 1)] ?? null
            : null
          const nextSelectionIndex = previousSelected
            ? results.matches.findIndex(match => searchMatchIdentity(match) === searchMatchIdentity(previousSelected))
            : 0
          setMatches(results.matches)
          setSelectionIndex(nextSelectionIndex >= 0 ? nextSelectionIndex : 0)
          setTruncated(results.truncated)
          setTimeoutMs(results.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS)
          setLoading(false)
          setContentLoading(false)
          setError(null)
        })
        .catch(searchError => {
          if (requestRef.current !== requestId) return
          if (searchError instanceof DOMException && searchError.name === 'AbortError') return
          fullSettled = true
          if (entriesPublished) {
            setTruncated(true)
            setLoading(false)
            setContentLoading(false)
            return
          }
          setMatches([])
          setTruncated(false)
          setError(searchError instanceof Error ? searchError.message : 'Search failed')
          setLoading(false)
          setContentLoading(false)
        })
    }, 180)

    return () => {
      window.clearTimeout(timeoutId)
      abortController.abort()
    }
  }, [agentId, includeIgnored, normalizedQuery, scopePath])

  useEffect(() => {
    setSelectionIndex(index => Math.min(index, Math.max(matches.length - 1, 0)))
  }, [matches.length])

  return useMemo(() => ({
    isOpen,
    open,
    dismissSuggestions,
    query,
    normalizedQuery,
    scopePath,
    setQuery: setSearchQuery,
    searchInDirectory,
    matches,
    loading,
    contentLoading,
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
    isOpen,
    open,
    dismissSuggestions,
    active,
    activeMatchIndex,
    clear,
    contentLoading,
    error,
    jumpTarget,
    loading,
    matches,
    normalizedQuery,
    includeIgnored,
    searchIgnored,
    query,
    scopePath,
    searchInDirectory,
    selectMatchIndex,
    selectNext,
    selectPrevious,
    selectedMatch,
    setSearchQuery,
    truncated,
    timeoutMs,
  ])
}

export type WorkspaceFileSearchState = ReturnType<typeof useWorkspaceFileSearch>
