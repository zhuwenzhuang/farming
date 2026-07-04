import type { Agent, TaskHistoryEntry } from '@/types/agent'
import { agentTitle } from '@/lib/format'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import {
  groupAgentsByProject,
} from './model'
import { limitProjectAgentSessions } from './session-display'
import type { AgentSessionHistoryItem, ProjectGroup, SearchTarget } from './types'

export interface EditorFileStateByAgent {
  dirty: Map<string, Set<string>>
  externalChanged: Map<string, Set<string>>
}

export interface AgentUnreadTurnTransition {
  wasTurnActive: boolean
  isTurnActive: boolean
  isMain: boolean
  alreadyUnread: boolean
  terminalPaneViewed: boolean
  terminalFollowingLatest: boolean
}

export function shouldMarkAgentUnreadForTurnTransition(state: AgentUnreadTurnTransition) {
  if (state.isMain || state.alreadyUnread) return false
  if (!state.wasTurnActive || state.isTurnActive) return false
  return !(state.terminalPaneViewed && state.terminalFollowingLatest)
}

export function projectWorkspaceForHistoryRun(entry: Pick<TaskHistoryEntry, 'cwd' | 'projectWorkspace'> | null | undefined) {
  if (!entry) return ''
  return entry.projectWorkspace || entry.cwd || ''
}

export function projectListProjectsForAgents(
  agents: Agent[],
  sessions: AgentSessionHistoryItem[]
) {
  return groupAgentsByProject(agents, sessions)
}

export function displayedProjectsForSearch(
  sourceProjects: ProjectGroup[],
  normalizedSearch: string,
  expandedProjectIds: ReadonlySet<string>
) {
  if (!normalizedSearch) return sourceProjects

  const filteredProjects = sourceProjects
    .map(project => {
      const projectMatches = [
        project.name,
        project.workspace,
      ].some(value => value.toLowerCase().includes(normalizedSearch))
      const filteredAgents = projectMatches
        ? project.agents
        : project.agents.filter(agent => [
          agentTitle(agent),
          agent.command,
          agent.cwd,
          agent.task || '',
        ].some(value => value.toLowerCase().includes(normalizedSearch)))
      const filteredAgentSessions = projectMatches
        ? project.agentSessions
        : project.agentSessions.filter(session => [
          session.title,
          session.providerName || session.provider,
          session.cwd,
          session.workspace || '',
          session.model || '',
          session.effort || '',
        ].some(value => value.toLowerCase().includes(normalizedSearch)))

      return filteredAgents.length > 0 || filteredAgentSessions.length > 0
        ? { ...project, agents: filteredAgents, agentSessions: filteredAgentSessions }
        : null
    })
    .filter((project): project is ProjectGroup => Boolean(project))

  return limitProjectAgentSessions(filteredProjects, expandedProjectIds, true)
}

export function visibleSearchTargetsForProjects(
  projects: ProjectGroup[],
  collapsedProjectIds: ReadonlySet<string>,
  normalizedSearch: string
): SearchTarget[] {
  return projects.flatMap(project => {
    if (collapsedProjectIds.has(project.id) && !normalizedSearch) return []
    return [
      ...project.agents.map(agent => ({ kind: 'agent' as const, id: agent.id })),
      ...project.agentSessions.map(session => ({ kind: 'agent-session' as const, provider: session.provider, id: session.id })),
    ]
  })
}

export function editorFileStateByAgentForFiles(
  openFiles: OpenWorkspaceFile[],
  cachedFiles: Iterable<OpenWorkspaceFile>
): EditorFileStateByAgent {
  const dirty = new Map<string, Set<string>>()
  const externalChanged = new Map<string, Set<string>>()
  const addPath = (target: Map<string, Set<string>>, agentId: string, filePath: string) => {
    const paths = target.get(agentId) ?? new Set<string>()
    paths.add(filePath)
    target.set(agentId, paths)
  }

  ;[...openFiles, ...cachedFiles].forEach(file => {
    if (file.dirty) addPath(dirty, file.agentId, file.file.path)
    if (file.externalChanged) addPath(externalChanged, file.agentId, file.file.path)
  })

  return { dirty, externalChanged }
}
