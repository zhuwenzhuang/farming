import type { AgentSessionHistoryItem } from './types'
import { agentSessionId } from './model'

export interface AgentSessionPage {
  sessions: AgentSessionHistoryItem[]
  nextCursor: string
  hasMore: boolean
  total: number
}

export interface AgentSessionInventoryState {
  pageSize: number
  sessions: AgentSessionHistoryItem[]
  nextCursor: string
  hasMore: boolean
  total: number | null
  loadedCount: number
}

export type AgentSessionInventoryAction =
  | { type: 'first-page-replaced'; page: AgentSessionPage }
  | { type: 'page-appended'; page: AgentSessionPage }
  | { type: 'visible-page-replaced'; page: AgentSessionPage }
  | {
    type: 'session-resumed'
    provider: string
    sessionId: string
    providerHomeId: string
  }

export function createAgentSessionInventoryState(pageSize: number): AgentSessionInventoryState {
  return {
    pageSize,
    sessions: [],
    nextCursor: '',
    hasMore: false,
    total: null,
    loadedCount: pageSize,
  }
}

function replaceFirstPage(
  state: AgentSessionInventoryState,
  page: AgentSessionPage,
): AgentSessionInventoryState {
  return {
    ...state,
    sessions: page.sessions,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    total: page.total,
    loadedCount: Math.max(state.pageSize, page.sessions.length),
  }
}

function appendPage(
  state: AgentSessionInventoryState,
  page: AgentSessionPage,
): AgentSessionInventoryState {
  const seen = new Set(state.sessions.map(agentSessionId))
  const sessions = [...state.sessions]
  page.sessions.forEach(session => {
    const sessionId = agentSessionId(session)
    if (seen.has(sessionId)) return
    seen.add(sessionId)
    sessions.push(session)
  })
  return {
    ...state,
    sessions,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    total: page.total,
    loadedCount: Math.max(state.pageSize, sessions.length),
  }
}

export function reduceAgentSessionInventory(
  state: AgentSessionInventoryState,
  action: AgentSessionInventoryAction,
): AgentSessionInventoryState {
  switch (action.type) {
    case 'first-page-replaced':
      return replaceFirstPage(state, action.page)
    case 'page-appended':
      return appendPage(state, action.page)
    case 'visible-page-replaced':
      return {
        ...state,
        sessions: action.page.sessions,
        nextCursor: action.page.nextCursor,
        hasMore: action.page.hasMore,
      }
    case 'session-resumed': {
      const providerHomeId = action.providerHomeId || 'default'
      return {
        ...state,
        sessions: state.sessions.map(session => (
          session.provider === action.provider
          && session.id === action.sessionId
          && (session.providerHomeId || 'default') === providerHomeId
            ? { ...session, archived: false }
            : session
        )),
      }
    }
  }
}
