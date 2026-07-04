import type { AgentSessionHistoryItem, ProjectGroup } from './types'
import { agentSessionId, workspaceTargetId } from './model'

export const DEFAULT_PROJECT_SESSION_LIMIT = 4
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

export function loadSessionDisplayState(): SessionDisplayState {
  if (typeof window === 'undefined') return defaultSessionDisplayState()

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_DISPLAY_STATE_STORAGE_KEY) || '{}')
    const promotedKeys = Array.isArray(parsed.promotedKeys)
      ? parsed.promotedKeys.filter((key: unknown): key is string => typeof key === 'string' && key.length > 0)
      : []
    const pinnedOverrides: Record<string, boolean> = {}
    if (parsed.pinnedOverrides && typeof parsed.pinnedOverrides === 'object') {
      Object.entries(parsed.pinnedOverrides).forEach(([storedId, value]) => {
        if (typeof value === 'boolean') pinnedOverrides[storedId] = value
      })
    }
    const archivedOverrides: Record<string, boolean> = {}
    if (parsed.archivedOverrides && typeof parsed.archivedOverrides === 'object') {
      Object.entries(parsed.archivedOverrides).forEach(([storedId, value]) => {
        if (typeof value === 'boolean') archivedOverrides[storedId] = value
      })
    }
    return { promotedKeys, pinnedOverrides, archivedOverrides }
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
    const value = typeof key === 'string' ? key.trim() : ''
    if (!/^agent-session:[a-z][a-z0-9_-]*:.+$/i.test(value)) return
    const sessionId = value.replace(/^agent-session:[^:]+:/i, '')
    if (sessionId.startsWith('-')) return
    if (sessionId.startsWith(TEMPORARY_PROVIDER_SESSION_ID_PREFIX)) return
    if (seen.has(value)) return
    seen.add(value)
    result.push(value)
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

export function resumedAgentSource(provider: string, sessionId: string) {
  return `${provider}-history:${sessionId}`
}

export function resumedAgentSessionIdFromSource(source?: string) {
  const match = /^([a-z]+)-history:(.+)$/.exec(source || '')
  if (!match) return ''
  const provider = match[1]
  const id = match[2]
  if (!provider || !id) return ''
  return workspaceTargetId({ kind: 'agent-session', provider, id })
}

export function limitProjectAgentSessions(
  projects: ProjectGroup[],
  expandedProjectIds: ReadonlySet<string>,
  showAll: boolean
) {
  return projects.map(project => {
    if (showAll || expandedProjectIds.has(project.id) || project.agentSessions.length <= DEFAULT_PROJECT_SESSION_LIMIT) {
      return {
        ...project,
        hiddenAgentSessionCount: 0,
        agentSessionsExpanded: expandedProjectIds.has(project.id),
      }
    }

    const prioritySessions = project.agentSessions.filter(session => session.pinned || session.unread)
    const priorityKeys = new Set(prioritySessions.map(agentSessionId))
    const ordinarySessions = project.agentSessions.filter(session => !priorityKeys.has(agentSessionId(session)))
    const ordinaryLimit = Math.max(0, DEFAULT_PROJECT_SESSION_LIMIT - prioritySessions.length)
    const visibleOrdinarySessions = ordinarySessions.slice(0, ordinaryLimit)
    const hiddenAgentSessionCount = ordinarySessions.length - visibleOrdinarySessions.length

    return {
      ...project,
      agentSessions: [
        ...prioritySessions,
        ...visibleOrdinarySessions,
      ],
      hiddenAgentSessionCount,
      agentSessionsExpanded: false,
    }
  })
}
