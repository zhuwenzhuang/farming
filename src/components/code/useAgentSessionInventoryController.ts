import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import type { AgentSessionHistoryItem } from './types'
import {
  createAgentSessionInventoryState,
  reduceAgentSessionInventory,
  type AgentSessionPage,
} from './agent-session-inventory'

const AGENT_SESSION_PAGE_SIZE = 60
const AGENT_SESSION_SEARCH_LIMIT = 1000
const AGENT_SESSION_SEARCH_DEBOUNCE_MS = 150
const AGENT_SESSION_BACKGROUND_QUIET_MS = 5_000
const AGENT_SESSION_LIFECYCLE_SETTLE_MS = 30_000

type SessionPageOptions = {
  cursor?: string
  limit?: number
  fresh?: boolean
  signal?: AbortSignal
}

export interface AgentSessionInventoryControllerOptions {
  searchActive: boolean
  searchQuery: string
  freshErrorMessage: string
}

export interface AgentSessionInventoryRequestLifecyclePorts {
  fetchPage: (options?: SessionPageOptions) => Promise<AgentSessionPage>
  replaceFirstPage: (page: AgentSessionPage) => void
  replaceVisiblePage: (page: AgentSessionPage) => void
  appendPage: (page: AgentSessionPage) => void
  getPaging: () => Pick<ReturnType<typeof createAgentSessionInventoryState>, 'hasMore' | 'nextCursor'>
  setFreshLoading: (loading: boolean) => void
  setFreshError: (error: string) => void
  freshErrorMessage: () => string
  setTimer: (callback: () => void, delay: number) => number
  clearTimer: (timer: number) => void
  createAbortController: () => AbortController
}

/** Owns all mutable request lifecycle state for the session inventory. */
export class AgentSessionInventoryRequestLifecycle {
  private loadingMore = false
  private generation = 0
  private loadAbort: AbortController | null = null
  private backgroundTimer: number | null = null
  private backgroundFresh = false
  private backgroundCancel: (() => void) | null = null
  private firstPageRequest: { limit: number; fresh: boolean; promise: Promise<AgentSessionPage> } | null = null
  private visibleRefreshVersion = 0

  constructor(private readonly ports: AgentSessionInventoryRequestLifecyclePorts) {}

  fetchFirstPage(options: SessionPageOptions = {}) {
    if (options.cursor) return this.ports.fetchPage(options)
    const limit = options.limit || AGENT_SESSION_PAGE_SIZE
    const fresh = options.fresh === true
    const current = this.firstPageRequest
    if (current?.limit === limit && current.fresh === fresh) return current.promise
    const request = this.ports.fetchPage({ ...options, limit }).finally(() => {
      if (this.firstPageRequest?.promise === request) this.firstPageRequest = null
    })
    this.firstPageRequest = { limit, fresh, promise: request }
    return request
  }

  load(fresh = false) {
    let cancelled = false
    if (fresh && this.backgroundTimer !== null) {
      this.ports.clearTimer(this.backgroundTimer)
      this.backgroundTimer = null
      this.backgroundFresh = false
    }
    this.loadAbort?.abort()
    this.firstPageRequest = null
    const controller = this.ports.createAbortController()
    this.loadAbort = controller
    const generation = ++this.generation
    if (fresh) {
      this.ports.setFreshLoading(true)
      this.ports.setFreshError('')
    }
    this.fetchFirstPage(fresh ? { fresh: true, signal: controller.signal } : { signal: controller.signal })
      .then(page => {
        if (!cancelled && generation === this.generation) this.ports.replaceFirstPage(page)
      })
      .catch(() => {
        if (!controller.signal.aborted && !cancelled && generation === this.generation && fresh) {
          this.ports.setFreshError(this.ports.freshErrorMessage())
        }
      })
      .finally(() => {
        if (this.loadAbort === controller) this.loadAbort = null
        if (!cancelled && fresh && generation === this.generation) this.ports.setFreshLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
      if (this.loadAbort === controller) this.loadAbort = null
      if (fresh && generation === this.generation) this.ports.setFreshLoading(false)
    }
  }

  scheduleBackgroundLoad(fresh = false) {
    this.backgroundFresh = this.backgroundFresh || fresh
    const quietMs = this.backgroundFresh
      ? AGENT_SESSION_LIFECYCLE_SETTLE_MS
      : AGENT_SESSION_BACKGROUND_QUIET_MS
    if (this.backgroundTimer !== null) this.ports.clearTimer(this.backgroundTimer)
    this.backgroundTimer = this.ports.setTimer(() => {
      this.backgroundTimer = null
      const requestedFresh = this.backgroundFresh
      this.backgroundFresh = false
      this.backgroundCancel?.()
      this.backgroundCancel = this.load(requestedFresh)
    }, quietMs)
  }

  invalidateForHistory() {
    this.generation += 1
    this.ports.setFreshLoading(true)
    this.ports.setFreshError('')
  }

  async loadMore() {
    const { hasMore, nextCursor } = this.ports.getPaging()
    if (!hasMore || !nextCursor || this.loadingMore) return false
    this.loadingMore = true
    const generation = this.generation
    try {
      const page = await this.ports.fetchPage({ cursor: nextCursor })
      if (generation !== this.generation) return false
      this.ports.appendPage(page)
      return page.sessions.length > 0
    } catch {
      return false
    } finally {
      this.loadingMore = false
    }
  }

  async refreshVisiblePage(limit: number) {
    const generation = this.generation
    const requestVersion = ++this.visibleRefreshVersion
    const page = await this.ports.fetchPage({ limit })
    if (generation !== this.generation || requestVersion !== this.visibleRefreshVersion) return false
    this.ports.replaceVisiblePage(page)
    return true
  }

  dispose() {
    if (this.backgroundTimer !== null) this.ports.clearTimer(this.backgroundTimer)
    this.backgroundTimer = null
    this.backgroundCancel?.()
    this.backgroundCancel = null
    this.generation += 1
    this.loadAbort?.abort()
    this.loadAbort = null
    this.firstPageRequest = null
  }
}

export function useAgentSessionInventoryController({
  searchActive,
  searchQuery,
  freshErrorMessage,
}: AgentSessionInventoryControllerOptions) {
  const [inventory, dispatch] = useReducer(
    reduceAgentSessionInventory,
    AGENT_SESSION_PAGE_SIZE,
    createAgentSessionInventoryState,
  )
  const [freshLoading, setFreshLoading] = useState(false)
  const [freshError, setFreshError] = useState('')
  const [searchedSessions, setSearchedSessions] = useState<AgentSessionHistoryItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const inventoryRef = useRef(inventory)
  inventoryRef.current = inventory
  const freshErrorMessageRef = useRef(freshErrorMessage)
  freshErrorMessageRef.current = freshErrorMessage

  const fetchSearchedAgentSessions = useCallback(async (query: string, signal: AbortSignal) => {
    const params = new URLSearchParams({ q: query, limit: String(AGENT_SESSION_SEARCH_LIMIT) })
    const response = await fetch(appPath(`/api/agent-sessions/search?${params.toString()}`), {
      signal,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Failed to search Agent sessions: ${response.status}`)
    const data = await response.json() as { sessions?: AgentSessionHistoryItem[] }
    return Array.isArray(data.sessions) ? data.sessions : []
  }, [])

  const fetchAgentSessions = useCallback(async (options: SessionPageOptions = {}) => {
    const params = new URLSearchParams({ limit: String(options.limit || AGENT_SESSION_PAGE_SIZE) })
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.fresh) params.set('fresh', '1')
    const response = await fetch(appPath(`/api/agent-sessions?${params.toString()}`), {
      cache: options.fresh ? 'no-store' : 'default',
      signal: options.signal,
    })
    if (!response.ok) throw new Error(`Failed to load Agent sessions: ${response.status}`)
    const data = await response.json() as {
      sessions?: AgentSessionHistoryItem[]
      nextCursor?: string
      hasMore?: boolean
      total?: number
    }
    const sessions = Array.isArray(data.sessions) ? data.sessions : []
    return {
      sessions,
      nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : '',
      hasMore: data.hasMore === true,
      total: Number.isFinite(data.total) ? Math.max(sessions.length, Math.floor(data.total as number)) : sessions.length,
    }
  }, [])

  const lifecycleRef = useRef<AgentSessionInventoryRequestLifecycle | null>(null)
  if (lifecycleRef.current === null) {
    lifecycleRef.current = new AgentSessionInventoryRequestLifecycle({
      fetchPage: fetchAgentSessions,
      replaceFirstPage: page => dispatch({ type: 'first-page-replaced', page }),
      replaceVisiblePage: page => dispatch({ type: 'visible-page-replaced', page }),
      appendPage: page => dispatch({ type: 'page-appended', page }),
      getPaging: () => inventoryRef.current,
      setFreshLoading,
      setFreshError,
      freshErrorMessage: () => freshErrorMessageRef.current,
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: timer => window.clearTimeout(timer),
      createAbortController: () => new AbortController(),
    })
  }
  const lifecycle = lifecycleRef.current
  const loadAgentSessions = useCallback((fresh = false) => lifecycle.load(fresh), [lifecycle])
  const scheduleBackgroundLoad = useCallback((fresh = false) => lifecycle.scheduleBackgroundLoad(fresh), [lifecycle])
  const invalidateForHistory = useCallback(() => lifecycle.invalidateForHistory(), [lifecycle])
  const loadMore = useCallback(() => lifecycle.loadMore(), [lifecycle])
  const refreshVisiblePage = useCallback(
    () => lifecycle.refreshVisiblePage(inventory.loadedCount),
    [inventory.loadedCount, lifecycle],
  )

  useEffect(() => {
    if (!searchActive) {
      setSearchedSessions([])
      setSearchLoading(false)
      return undefined
    }
    const controller = new AbortController()
    setSearchedSessions([])
    setSearchLoading(true)
    const timer = window.setTimeout(() => {
      fetchSearchedAgentSessions(searchQuery, controller.signal)
        .then(setSearchedSessions)
        .catch(error => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          setSearchedSessions([])
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchLoading(false)
        })
    }, AGENT_SESSION_SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [fetchSearchedAgentSessions, searchActive, searchQuery])

  useEffect(() => () => {
    lifecycle.dispose()
  }, [lifecycle])

  return {
    agentSessionInventory: inventory,
    dispatchAgentSessionInventory: dispatch,
    agentSessionsFreshLoading: freshLoading,
    agentSessionsFreshError: freshError,
    searchedAgentSessions: searchedSessions,
    agentSessionSearchLoading: searchLoading,
    fetchSearchedAgentSessions,
    loadAgentSessions,
    scheduleAgentSessionsBackgroundLoad: scheduleBackgroundLoad,
    invalidateAgentSessionsForHistory: invalidateForHistory,
    loadMoreAgentSessions: loadMore,
    refreshVisibleAgentSessionPage: refreshVisiblePage,
  }
}
