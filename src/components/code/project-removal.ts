import type { WorkspaceOpenFileTarget } from '@/lib/workspace-open-files'
import { agentSessionId, agentSessionWorkspace } from './model'
import type { AgentSessionHistoryItem, ProjectGroup } from './types'
import type { ProjectMutationOutcome } from './useProjectMutationController'

export interface ProjectArchiveTargets {
  agentIds: string[]
  sessionHandles: string[]
}

/** Selects only rows that remain in the Project section; pinned-section rows are protected. */
export function projectArchiveTargets(
  project: ProjectGroup,
  mainPageSessions: AgentSessionHistoryItem[],
  protectedAgentIds: ReadonlySet<string> = new Set(),
): ProjectArchiveTargets {
  return {
    agentIds: project.agents
      .filter(agent => !agent.isMain && !agent.pinned && !protectedAgentIds.has(agent.id))
      .map(agent => agent.id),
    sessionHandles: mainPageSessions
      .filter(session => agentSessionWorkspace(session) === project.workspace && !session.pinned)
      .map(agentSessionId),
  }
}

export interface ProjectRemovalAgent {
  id: string
  acknowledgeUnprovenAcpExit: boolean
}

export interface ProjectRemovalPlan {
  workspace: string
  agents: ProjectRemovalAgent[]
  sessionHandles: string[]
  files: WorkspaceOpenFileTarget[]
}

export type ProjectRemovalStage = 'archive-agents' | 'archive-sessions' | 'close-files' | 'remove-project'

export type ProjectRemovalOutcome =
  | { status: 'succeeded' }
  | { status: 'failed'; stage: ProjectRemovalStage; uncertain: boolean }

export interface ProjectRemovalPorts {
  archiveAgent: (agent: ProjectRemovalAgent) => boolean | Promise<boolean>
  archiveSessions: (sessionHandles: string[]) => boolean | Promise<boolean>
  closeFiles: (files: WorkspaceOpenFileTarget[]) => void
  removeProject: (workspace: string) => ProjectMutationOutcome | Promise<ProjectMutationOutcome>
}

/** Runs the confirmed cleanup in owner order and never advances past a failed stage. */
export async function executeProjectRemoval(
  plan: ProjectRemovalPlan,
  ports: ProjectRemovalPorts,
): Promise<ProjectRemovalOutcome> {
  try {
    const archivedAgents = await Promise.all(plan.agents.map(agent => ports.archiveAgent(agent)))
    if (archivedAgents.some(archived => archived !== true)) {
      return { status: 'failed', stage: 'archive-agents', uncertain: false }
    }
  } catch {
    return { status: 'failed', stage: 'archive-agents', uncertain: true }
  }

  if (plan.sessionHandles.length > 0) {
    try {
      if (await ports.archiveSessions(plan.sessionHandles) !== true) {
        return { status: 'failed', stage: 'archive-sessions', uncertain: false }
      }
    } catch {
      return { status: 'failed', stage: 'archive-sessions', uncertain: true }
    }
  }

  if (plan.files.length > 0) {
    try {
      ports.closeFiles(plan.files)
    } catch {
      return { status: 'failed', stage: 'close-files', uncertain: false }
    }
  }

  try {
    const outcome = await ports.removeProject(plan.workspace)
    if (outcome.status === 'succeeded') return outcome
    return {
      status: 'failed',
      stage: 'remove-project',
      uncertain: outcome.status === 'failed' && outcome.uncertain,
    }
  } catch {
    return { status: 'failed', stage: 'remove-project', uncertain: true }
  }
}
