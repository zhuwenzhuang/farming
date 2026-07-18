import type { Agent, TaskHistoryEntry } from '@/types/agent'
import { agentRowTitle } from '@/lib/format'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import {
  agentSessionId,
  groupAgentsByProject,
  projectNameForWorkspace,
  projectWorkspaceForAgent,
} from './model'
import { limitProjectAgentSessions } from './session-display'
import type { AgentSessionHistoryItem, ProjectGroup, SearchTarget } from './types'

export interface EditorFileStateByAgent {
  dirty: Map<string, Set<string>>
  externalChanged: Map<string, Set<string>>
}

export function stableProjectSourceAgentId(
  currentAgentId: string | null | undefined,
  agents: ReadonlyArray<Pick<Agent, 'id' | 'isMain'>>
) {
  if (currentAgentId && agents.some(agent => !agent.isMain && agent.id === currentAgentId)) {
    return currentAgentId
  }
  return agents.find(agent => !agent.isMain)?.id ?? null
}

export function projectWorkspaceForHistoryRun(entry: Pick<TaskHistoryEntry, 'cwd' | 'projectWorkspace'> | null | undefined) {
  if (!entry) return ''
  return entry.projectWorkspace || entry.cwd || ''
}

export function projectListProjectsForAgents(
  agents: Agent[],
  sessions: AgentSessionHistoryItem[],
  projectNames: Record<string, string> = {},
  openFiles: readonly OpenWorkspaceFile[] = [],
  allAgents: readonly Agent[] = agents,
  projectWorkspaces: readonly string[] = [],
  pinnedProjectWorkspaces: readonly string[] = [],
) {
  const projects = groupAgentsByProject(agents, sessions)
  const projectsByWorkspace = new Map(projects.map(project => [project.workspace, project]))

  openFiles.forEach(file => {
    const fileSourceAgent = file.sourceAgentId
      ? allAgents.find(agent => agent.id === file.sourceAgentId)
      : allAgents.find(agent => agent.id === file.agentId)
    const workspace = file.workspaceRoot
      || (fileSourceAgent ? projectWorkspaceForAgent(fileSourceAgent) : '')
    if (!workspace || workspace === '/') return

    const existing = projectsByWorkspace.get(workspace)
    if (existing) {
      existing.hasOpenFile = true
      if (!existing.gitWorktree && fileSourceAgent?.gitWorktree?.workspace) existing.gitWorktree = fileSourceAgent.gitWorktree
      return
    }

    const project: ProjectGroup = {
      id: workspace,
      name: projectNameForWorkspace(workspace),
      workspace,
      agents: [],
      agentSessions: [],
      hasMain: false,
      hasProjectAgent: false,
      hasAgentSession: false,
      hasOpenFile: true,
      gitWorktree: fileSourceAgent?.gitWorktree ?? null,
    }
    projects.push(project)
    projectsByWorkspace.set(workspace, project)
  })

  projectWorkspaces.forEach(workspace => {
    if (!workspace || workspace === '/') return
    const existing = projectsByWorkspace.get(workspace)
    if (existing) return

    const project: ProjectGroup = {
      id: workspace,
      name: projectNameForWorkspace(workspace),
      workspace,
      agents: [],
      agentSessions: [],
      hasMain: false,
      hasProjectAgent: false,
      hasAgentSession: false,
      gitWorktree: null,
    }
    projects.push(project)
    projectsByWorkspace.set(workspace, project)
  })

  const pinnedOrder = new Map(pinnedProjectWorkspaces.map((workspace, index) => [workspace, index]))
  return projects.map((project, sourceIndex) => {
    const customName = project.workspace ? projectNames[project.workspace]?.trim() : ''
    const namedProject = customName && !project.hasMain
      ? { ...project, name: customName }
      : project
    const pinIndex = pinnedOrder.get(project.workspace)
    return {
      project: { ...namedProject, pinned: pinIndex !== undefined },
      pinIndex,
      sourceIndex,
    }
  }).sort((left, right) => {
    if (left.pinIndex !== undefined && right.pinIndex !== undefined) return left.pinIndex - right.pinIndex
    if (left.pinIndex !== undefined) return -1
    if (right.pinIndex !== undefined) return 1
    return left.sourceIndex - right.sourceIndex
  }).map(entry => entry.project)
}

export function displayedProjectsForSearch(
  sourceProjects: ProjectGroup[],
  normalizedSearch: string,
  expandedProjectIds: ReadonlySet<string>,
  matchedSessionIds: ReadonlySet<string> = new Set(),
  matchedAgentIds: ReadonlySet<string> = new Set()
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
        : project.agents.filter(agent => (
          matchedAgentIds.has(agent.id)
          || agentRowTitle(agent).toLowerCase().includes(normalizedSearch)
        ))
      const filteredAgentSessions = projectMatches
        ? project.agentSessions
        : project.agentSessions.filter(session => (
          matchedSessionIds.has(agentSessionId(session))
          || session.title.toLowerCase().includes(normalizedSearch)
        ))

      return filteredAgents.length > 0
        || filteredAgentSessions.length > 0
        || (Boolean(project.workspace) && projectMatches)
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
      ...project.agentSessions.map(session => ({
        kind: 'agent-session' as const,
        provider: session.provider,
        id: session.id,
        ...(session.providerHomeId ? { providerHomeId: session.providerHomeId } : {}),
      })),
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
