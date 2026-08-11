import type { Agent } from '@/types/agent'
import type { AgentSessionHistoryItem, ProjectGroup } from './types'
import { agentSessionId } from './model'
import {
  canonicalProviderSessionKey,
  decodeProviderSessionKey,
  decodeResumedProviderSessionSource,
  encodeResumedProviderSessionSource,
  isProviderSessionKeyV2,
  providerSessionKeyFromIdentity,
} from '../../../shared/provider-session-identity.js'

export const DEFAULT_PROJECT_SESSION_LIMIT = 5
export const FIRST_PROJECT_SESSION_REVEAL_COUNT = 5
export const NEXT_PROJECT_SESSION_REVEAL_COUNT = 10
export const SESSION_DISPLAY_STATE_STORAGE_KEY = 'farming.codex.sessionDisplayState.v1'
const MAX_MAIN_PAGE_SESSION_KEYS = 50
const TEMPORARY_PROVIDER_SESSION_ID_PREFIX = 'tmp_uuid'

export interface SessionDisplayState {
  promotedKeys: string[]
  pinnedOverrides: Record<string, boolean>
  archivedOverrides: Record<string, boolean>
}

export function defaultSessionDisplayState(): SessionDisplayState {
  return { promotedKeys: [], pinnedOverrides: {}, archivedOverrides: {} }
}

function canonicalDisplayStateKey(key: string): string {
  return canonicalProviderSessionKey(key) || key
}

function canonicalDisplayStateKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return []
  const seen = new Set<string>()
  const result: string[] = []
  keys.forEach(key => {
    if (typeof key !== 'string' || !key) return
    const canonicalKey = canonicalDisplayStateKey(key)
    if (seen.has(canonicalKey)) return
    seen.add(canonicalKey)
    result.push(canonicalKey)
  })
  return result
}

interface DisplayStateOverride {
  value: boolean
  authoritative: boolean
  conflicted: boolean
}

/**
 * A persisted object may hold a pre-v2 alias and its v2 key for the same tuple,
 * and JSON property order is not evidence. Grouping by canonical key makes the
 * outcome order-independent: a v2 spelling outranks a pre-v2 alias because only a
 * v2 build writes it, and two equally authoritative spellings that disagree drop
 * the override instead of letting last-win decide, so the user sees the session's
 * authoritative pin/archive state rather than a coin flip.
 */
function canonicalDisplayStateOverrides(overrides: unknown): Record<string, boolean> {
  if (!overrides || typeof overrides !== 'object') return {}
  const grouped = new Map<string, DisplayStateOverride>()
  Object.entries(overrides as Record<string, unknown>).forEach(([storedKey, value]) => {
    if (typeof value !== 'boolean') return
    const canonicalKey = canonicalProviderSessionKey(storedKey)
    const authoritative = Boolean(canonicalKey) && isProviderSessionKeyV2(storedKey)
    const key = canonicalKey || storedKey
    const current = grouped.get(key)
    if (!current) {
      grouped.set(key, { value, authoritative, conflicted: false })
      return
    }
    if (current.authoritative !== authoritative) {
      if (authoritative) grouped.set(key, { value, authoritative, conflicted: false })
      return
    }
    if (current.value !== value) current.conflicted = true
  })

  const result: Record<string, boolean> = {}
  grouped.forEach((override, key) => {
    if (!override.conflicted) result[key] = override.value
  })
  return result
}

export function loadSessionDisplayState(): SessionDisplayState {
  if (typeof window === 'undefined') return defaultSessionDisplayState()

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_DISPLAY_STATE_STORAGE_KEY) || '{}')
    return {
      promotedKeys: canonicalDisplayStateKeys(parsed.promotedKeys),
      pinnedOverrides: canonicalDisplayStateOverrides(parsed.pinnedOverrides),
      archivedOverrides: canonicalDisplayStateOverrides(parsed.archivedOverrides),
    }
  } catch {
    return defaultSessionDisplayState()
  }
}

export function saveSessionDisplayState(state: SessionDisplayState) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SESSION_DISPLAY_STATE_STORAGE_KEY, JSON.stringify(state))
}

export function normalizeMainPageSessionKeys(keys: string[] = []) {
  const result: string[] = []
  const seen = new Set<string>()

  keys.forEach(key => {
    const identity = decodeProviderSessionKey(typeof key === 'string' ? key.trim() : '')
    if (!identity) return
    if (identity.sessionId.startsWith('-')) return
    if (identity.sessionId.startsWith(TEMPORARY_PROVIDER_SESSION_ID_PREFIX)) return
    const canonicalKey = providerSessionKeyFromIdentity(identity)
    if (seen.has(canonicalKey)) return
    seen.add(canonicalKey)
    result.push(canonicalKey)
  })

  return result.slice(0, MAX_MAIN_PAGE_SESSION_KEYS)
}

export function applySessionDisplayOverrides(
  sessions: AgentSessionHistoryItem[],
  pinnedOverrides: Record<string, boolean>,
  archivedOverrides: Record<string, boolean>
) {
  return sessions.map(session => {
    const sessionId = agentSessionId(session)
    const hasPinnedOverride = sessionId in pinnedOverrides
    const hasArchivedOverride = sessionId in archivedOverrides
    if (!hasPinnedOverride && !hasArchivedOverride) return session
    const archived = hasArchivedOverride ? archivedOverrides[sessionId] : session.archived
    return {
      ...session,
      pinned: archived ? false : hasPinnedOverride ? pinnedOverrides[sessionId] : session.pinned,
      archived,
    }
  })
}

export function resumedAgentSource(provider: string, sessionId: string, providerHomeId = '') {
  return encodeResumedProviderSessionSource(provider, sessionId, providerHomeId)
}

export interface ResumedAgentSessionSource {
  provider: string
  providerHomeId: string
  sessionId: string
  forked: boolean
}

/**
 * Explicit non-claim parser. It exposes the origin tuple a forked resume started
 * from, which only display may use. Anything that binds state to a session — a
 * claim, a main-page handle, a composer alias — must use the claim helpers.
 */
export function resumedAgentSessionSourceIdentity(source?: string): ResumedAgentSessionSource | null {
  const decoded = decodeResumedProviderSessionSource(source)
  if (!decoded) return null
  return {
    provider: decoded.provider,
    providerHomeId: decoded.providerHomeId,
    sessionId: decoded.sessionId,
    forked: decoded.forked,
  }
}

/** A fork starts a new Provider Session, so a fork source claims nothing. */
export function claimedAgentSessionFromSource(source?: string) {
  const decoded = resumedAgentSessionSourceIdentity(source)
  if (!decoded || decoded.forked) return null
  return {
    provider: decoded.provider,
    providerHomeId: decoded.providerHomeId,
    sessionId: decoded.sessionId,
  }
}

export function claimedAgentSessionIdFromSource(source?: string) {
  const session = claimedAgentSessionFromSource(source)
  return session ? agentSessionId({
    provider: session.provider,
    id: session.sessionId,
    providerHomeId: session.providerHomeId,
  }) : ''
}

export function claimedAgentSessionHandle(agent: Pick<Agent, 'providerSessionKey' | 'source'>) {
  return canonicalProviderSessionKey(agent.providerSessionKey)
    || claimedAgentSessionIdFromSource(agent.source)
}

export function limitProjectAgentSessions(
  projects: ProjectGroup[],
  projectSessionLimits: ReadonlyMap<string, number>,
  showAll: boolean,
  claimedSessionKeys: ReadonlySet<string> = new Set()
) {
  return projects.map(project => {
    const isUnclaimed = (session: AgentSessionHistoryItem) => (
      !claimedSessionKeys.has(agentSessionId(session))
    )
    const visibleLimit = Math.max(
      DEFAULT_PROJECT_SESSION_LIMIT,
      projectSessionLimits.get(project.id) ?? DEFAULT_PROJECT_SESSION_LIMIT,
    )
    if (showAll || project.agentSessions.length <= visibleLimit) {
      return {
        ...project,
        agentSessions: project.agentSessions.filter(isUnclaimed),
        hiddenAgentSessionCount: 0,
        agentSessionsExpanded: visibleLimit > DEFAULT_PROJECT_SESSION_LIMIT,
        agentSessionRevealCount: 0,
      }
    }

    const prioritySessions = project.agentSessions.filter(session => session.pinned || session.unread)
    const priorityKeys = new Set(prioritySessions.map(agentSessionId))
    const ordinarySessions = project.agentSessions.filter(session => !priorityKeys.has(agentSessionId(session)))
    const ordinaryLimit = Math.max(0, visibleLimit - prioritySessions.length)
    const visibleOrdinarySessions = ordinarySessions.slice(0, ordinaryLimit)
    const selectedSessions = [
      ...prioritySessions,
      ...visibleOrdinarySessions,
    ]
    const visibleSessions = selectedSessions.filter(isUnclaimed)
    const hiddenAgentSessionCount = project.agentSessions.filter(isUnclaimed).length - visibleSessions.length

    return {
      ...project,
      agentSessions: visibleSessions,
      hiddenAgentSessionCount,
      agentSessionsExpanded: visibleLimit > DEFAULT_PROJECT_SESSION_LIMIT,
      agentSessionRevealCount: Math.min(
        hiddenAgentSessionCount,
        visibleLimit === DEFAULT_PROJECT_SESSION_LIMIT
          ? FIRST_PROJECT_SESSION_REVEAL_COUNT
          : NEXT_PROJECT_SESSION_REVEAL_COUNT,
      ),
    }
  })
}
