import type { Agent } from '@/types/agent'
import { formatWorkspaceForDisplay } from '@/lib/workspace-options'
import type {
  AgentSessionHistoryItem,
  CodexModelOption,
  LegacyCodexModelOption,
  ProjectGroup,
  SearchTarget,
} from './types'

export const MAIN_AGENT_PROJECT_ID = '__farming_main_agent__'
export const CHATS_PROJECT_ID = '__agent_chats__'

export function workspaceTargetId(target: SearchTarget) {
  if (target.kind === 'agent-session') return `${target.kind}:${target.provider}:${target.id}`
  return `${target.kind}:${target.id}`
}

export function basename(path: string) {
  const normalized = path.replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || normalized || 'Farming'
}

export function projectWorkspaceForAgent(agent: Agent) {
  if (agent.projectWorkspace) return agent.projectWorkspace

  const workspace = agent.cwd || 'Farming'
  return workspace
}

export function projectNameForWorkspace(workspace: string) {
  if (!workspace) return 'Farming'
  return basename(workspace)
}

export function compactPath(path: string) {
  if (!path) return 'No workspace'
  const home = typeof window !== 'undefined' ? '' : ''
  return home ? path.replace(home, '~') : path
}

export function effortLabel(effort: string) {
  if (effort === 'xhigh') return 'Extra High'
  if (!effort) return 'Config'
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`
}

export function splitModelPreset(preset: string | undefined) {
  if (!preset || preset === 'config') return { model: 'gpt-5.5', effort: 'xhigh' }
  const [model = 'gpt-5.5', effort = 'xhigh'] = preset.split(':')
  return { model, effort }
}

export function codexModelDisplayName(option: CodexModelOption | undefined, value: string) {
  if (/^gpt-/i.test(value)) {
    return (option?.displayName || option?.label || value)
      .replace(/^gpt-/i, '')
      .replace(/^GPT-/i, '')
  }
  if (option?.displayName) return option.displayName
  return option?.label || value || 'Model'
}

function legacyModelOptionsToCatalog(options: LegacyCodexModelOption[]) {
  const byModel = new Map<string, CodexModelOption>()

  options.forEach(option => {
    const model = option.model || option.value.split(':')[0]
    if (!model) return
    const current = byModel.get(model) ?? {
      value: model,
      label: model.replace(/^gpt-/i, ''),
      defaultEffort: option.effort || 'medium',
      reasoningLevels: [],
      serviceTiers: [{ value: 'default', label: 'Standard', description: 'Default speed' }],
      source: option.source,
    }
    if (option.effort && !current.reasoningLevels?.some(level => level.value === option.effort)) {
      current.reasoningLevels = [
        ...(current.reasoningLevels ?? []),
        { value: option.effort, effort: option.effort, label: effortLabel(option.effort), description: option.description },
      ]
    }
    byModel.set(model, current)
  })

  return Array.from(byModel.values())
}

export function normalizeModelCatalog(data: { catalog?: CodexModelOption[]; models?: LegacyCodexModelOption[] }) {
  const catalog = Array.isArray(data.catalog)
    ? data.catalog.filter(option => option && typeof option.value === 'string' && typeof option.label === 'string')
    : []
  if (catalog.length > 0) return catalog

  const legacyOptions = Array.isArray(data.models)
    ? data.models.filter(option => option && typeof option.value === 'string' && typeof option.label === 'string')
    : []
  return legacyModelOptionsToCatalog(legacyOptions)
}

export function agentSessionId(session: Pick<AgentSessionHistoryItem, 'provider' | 'id' | 'providerHomeId'>) {
  const sessionId = session.providerHomeId && session.providerHomeId !== 'default'
    ? `home:${session.providerHomeId}:${session.id}`
    : session.id
  return workspaceTargetId({ kind: 'agent-session', provider: session.provider, id: sessionId })
}

export function formatAgentSessionWorkspace(session: AgentSessionHistoryItem) {
  const workspace = session.workspace || session.cwd
  if (workspace) return formatWorkspaceForDisplay(workspace)
  return session.projectless ? 'Chats' : session.providerName || 'Agent'
}

export function agentSessionWorkspace(session: AgentSessionHistoryItem) {
  return session.projectless ? '' : session.workspace || session.cwd || ''
}

export function agentSessionWorkingDirectory(session: AgentSessionHistoryItem) {
  return session.cwd || session.workspace || ''
}

export function agentSessionProjectId(session: AgentSessionHistoryItem) {
  return session.projectless ? CHATS_PROJECT_ID : agentSessionWorkspace(session) || '__agent_sessions__'
}

export function agentSessionProjectName(session: AgentSessionHistoryItem) {
  if (session.projectless) return 'Chats'
  const workspace = agentSessionWorkspace(session)
  return workspace ? projectNameForWorkspace(workspace) : 'Agent Sessions'
}

export function agentSessionUpdatedAt(session: AgentSessionHistoryItem) {
  const timestamp = Date.parse(session.updatedAt || session.createdAt || '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function compareAgentSessions(a: AgentSessionHistoryItem, b: AgentSessionHistoryItem) {
  return agentSessionUpdatedAt(b) - agentSessionUpdatedAt(a)
}

export function groupAgentsByProject(agents: Agent[], agentSessions: AgentSessionHistoryItem[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()

  agents.forEach(agent => {
    const workspace = projectWorkspaceForAgent(agent)
    const id = agent.isMain ? MAIN_AGENT_PROJECT_ID : workspace
    const group = groups.get(id) ?? {
      id,
      name: agent.isMain ? 'Main Agent' : projectNameForWorkspace(workspace),
      workspace,
      agents: [],
      agentSessions: [],
      hasMain: false,
      hasProjectAgent: false,
      hasAgentSession: false,
    }
    group.agents.push(agent)
    group.hasMain ||= agent.isMain
    group.hasProjectAgent ||= !agent.isMain
    group.name = group.hasMain ? 'Main Agent' : projectNameForWorkspace(group.workspace)
    groups.set(id, group)
  })

  agentSessions.forEach(session => {
    const id = agentSessionProjectId(session)
    const workspace = agentSessionWorkspace(session)
    const group = groups.get(id) ?? {
      id,
      name: agentSessionProjectName(session),
      workspace,
      agents: [],
      agentSessions: [],
      hasMain: false,
      hasProjectAgent: false,
      hasAgentSession: false,
    }
    group.agentSessions.push(session)
    group.hasAgentSession = true
    groups.set(id, group)
  })

  return Array.from(groups.values()).map(group => ({
    ...group,
    agents: group.agents.sort((a, b) => {
      if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
      const orderDifference = (b.projectOrder ?? 0) - (a.projectOrder ?? 0)
      if (orderDifference !== 0) return orderDifference
      return (b.startedAt ?? 0) - (a.startedAt ?? 0)
    }),
    agentSessions: group.agentSessions.sort(compareAgentSessions),
  })).sort((a, b) => {
    const aHasMain = a.agents.some(agent => agent.isMain)
    const bHasMain = b.agents.some(agent => agent.isMain)
    if (aHasMain !== bHasMain) return aHasMain ? -1 : 1
    const aIsChats = a.id === CHATS_PROJECT_ID
    const bIsChats = b.id === CHATS_PROJECT_ID
    if (aIsChats !== bIsChats) return aIsChats ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}
