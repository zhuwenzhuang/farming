import type { Agent } from '@/types/agent'
import { agentTitle } from '@/lib/format'
import { isOpenableAgent } from './agent-selection'
import { agentSessionId } from './model'
import type { AgentSessionHistoryItem, ProjectGroup } from './types'

export type UnreadAgentTarget = {
  key: string
  title: string
  project: string
} & ({ kind: 'agent'; agent: Agent } | { kind: 'session'; session: AgentSessionHistoryItem })

// Traverse the unfiltered Project list, continuing after the current Agent and
// wrapping once. Eligibility always comes from backend unread metadata.
export function unreadAgentTargets(projects: ProjectGroup[], activeAgentId: string): UnreadAgentTarget[] {
  const rows = projects.flatMap(project => [
    ...project.agents.filter(agent => !agent.isMain && isOpenableAgent(agent)).map(agent => ({
      key: `agent:${agent.id}`, title: agentTitle(agent), project: project.name,
      kind: 'agent' as const, agent,
    })),
    ...project.agentSessions.filter(session => !session.archived).map(session => ({
      key: agentSessionId(session), title: session.title || session.id, project: project.name,
      kind: 'session' as const, session,
    })),
  ])
  const current = rows.findIndex(row => row.key === `agent:${activeAgentId}`)
  const rotated = [...rows.slice(current + 1), ...rows.slice(0, current + 1)]
  const seen = new Set<string>()
  return rotated.filter(row => {
    if (row.key === `agent:${activeAgentId}` || seen.has(row.key)) return false
    seen.add(row.key)
    return row.kind === 'agent' ? row.agent.unread === true : row.session.unread === true
  })
}

export function unreadSwipeThreshold(width: number): number {
  return Math.min(120, Math.max(80, width / 4))
}

export function canStartUnreadSwipe(target: EventTarget | null, boundary: HTMLElement): boolean {
  if (!(target instanceof Element) || !target.closest('[data-testid="code-agent-chat-view"]')) return false
  if (String(window.getSelection()).length) return false
  if (target.closest('button, a, input, textarea, select, [contenteditable="true"], pre, code, table, iframe, canvas, [role="slider"], [role="dialog"], [role="menu"]')) return false
  for (let element: Element | null = target; element && element !== boundary; element = element.parentElement) {
    const style = getComputedStyle(element)
    if (element.scrollWidth > element.clientWidth + 1 && /auto|scroll/.test(style.overflowX)) return false
  }
  return true
}
