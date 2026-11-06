import type { Agent } from '@/types/agent'
import type { ProjectGroup } from './types'
import type { ComposerAgentKind } from './agent-kind'
import { inferAgentTerminalState } from './agent-terminal-inference'

import { agentKindForProvider } from './agent-kind'

export { agentKindForCommand, providerIdForAgent, providerIdForCommand, type ComposerAgentKind } from './agent-kind'
export { inferAgentTerminalState, isAgentTurnActive, isCodexAgentWorking } from './agent-working-state'

export type SlashCommandSource = 'codex' | 'claude' | 'skill' | 'custom' | 'plugin' | 'farming'

export interface SlashCommandOption {
  skillPath?: string
  command: string
  label: string
  description: string
  source: SlashCommandSource
  scope?: string
}

export interface AgentComposerCapabilities {
  plusMenu: boolean
  goalMode: boolean
  permissionMode: boolean
  modelPicker: boolean
  reasoningEffort: boolean
  serviceTier: boolean
  speechInput: boolean
}

export interface AgentActionCapabilities {
  pin: boolean
  rename: boolean
  archive: boolean
  markUnread: boolean
  copyWorkingDirectory: boolean
  forkSameWorktree: boolean
  forkNewWorktree: boolean
}

export interface AgentCapabilities {
  kind: ComposerAgentKind
  composer: AgentComposerCapabilities
  actions: AgentActionCapabilities
}

export interface AgentMenuEnvironment {
  canCreateBrowser?: boolean
  canCreateDesktop?: boolean
}

export interface AgentMenuAvailability {
  handoff: boolean
  archive: boolean
  copyWorkingDirectory: boolean
  createBrowser: boolean
  createDesktop: boolean
  forkNewWorktree: boolean
  forkSameWorktree: boolean
  markUnread: boolean
  pin: boolean
  rename: boolean
  switchRuntime: boolean
}

const BASIC_COMPOSER_CAPABILITIES: AgentComposerCapabilities = {
  plusMenu: false,
  goalMode: false,
  permissionMode: false,
  modelPicker: false,
  reasoningEffort: false,
  serviceTier: false,
  speechInput: true,
}

const CODING_AGENT_COMPOSER_CAPABILITIES: AgentComposerCapabilities = {
  plusMenu: true,
  goalMode: true,
  permissionMode: true,
  modelPicker: true,
  reasoningEffort: true,
  serviceTier: false,
  speechInput: true,
}

interface ComposerCapabilityContext {
  goalMode: boolean
  terminalProfile: boolean
}

const COMPOSER_CAPABILITIES_BY_AGENT_KIND: Partial<Record<
  NonNullable<ComposerAgentKind>,
  (context: ComposerCapabilityContext) => AgentComposerCapabilities
>> = {
  codex: ({ goalMode, terminalProfile }) => ({
    ...CODING_AGENT_COMPOSER_CAPABILITIES,
    goalMode,
    modelPicker: terminalProfile,
    reasoningEffort: terminalProfile,
    serviceTier: terminalProfile,
  }),
  claude: ({ goalMode }) => ({
    ...CODING_AGENT_COMPOSER_CAPABILITIES,
    goalMode,
    // Claude Terminal currently has no verified live-profile adapter.
    // ACP renders provider-advertised config options in AcpComposer.
    modelPicker: false,
    reasoningEffort: false,
  }),
}

export function slashCommandsForAgentKind(_kind: ComposerAgentKind): SlashCommandOption[] {
  return []
}

export function mergeSlashCommands(commands: SlashCommandOption[]) {
  const seen = new Set<string>()
  return commands.filter(command => {
    const normalizedCommand = command.command.trim().toLowerCase()
    const commandId = command.source === 'skill'
      ? `skill:${command.scope || ''}:${command.skillPath || ''}:${normalizedCommand}`
      : normalizedCommand
    if (!commandId || seen.has(commandId)) return false
    seen.add(commandId)
    return true
  })
}

export function capabilitiesForAgent(agent: Agent | null | undefined): AgentCapabilities {
  const inferredKind = inferAgentTerminalState(agent).kind
  const runtimeKind = agent?.runtimeBinding.kind || 'terminal'
  const providerCapabilities = agent?.providerCapabilities
  // A generic process observation may occur while a provider redraws its
  // composer. In that one ambiguous state the authoritative provider identity
  // selects the UI adapter. Explicit shell/provider observations still win.
  const kind = runtimeKind === 'terminal' && inferredKind === 'agent'
    ? agentKindForProvider(agent?.providerSessionProvider) || inferredKind
    : inferredKind
  const goalMode = Boolean(providerCapabilities?.goalSubmission)
  const terminalProfile = runtimeKind === 'terminal'
    && providerCapabilities?.terminalProfile === true
  const providerManaged = Boolean(
    agent?.providerSessionProvider
    || providerCapabilities?.supportsChat === true
  )
  const runtimeForkCapability = runtimeKind === 'acp'
    ? providerCapabilities?.conversationFork?.acp
    : providerCapabilities?.conversationFork?.terminal
  const providerSupportsRuntimeFork = runtimeForkCapability
    ? runtimeForkCapability.supported === true
    : runtimeKind === 'acp'
      ? providerCapabilities?.sessionFork === true
      : providerCapabilities?.terminalSessionFork === true
  const canForkRuntime = Boolean(
    agent
    && (
      runtimeKind === 'acp'
        ? canForkAgentConversation(agent)
        : (!providerManaged || providerSupportsRuntimeFork)
    )
  )
  const canForkNewWorktree = !providerManaged
    || runtimeForkCapability?.worktreeModes.includes('new-worktree') === true
  const composer = (kind && COMPOSER_CAPABILITIES_BY_AGENT_KIND[kind])?.({ goalMode, terminalProfile })
    || { ...BASIC_COMPOSER_CAPABILITIES, goalMode }

  return {
    kind,
    composer,
    actions: {
      pin: Boolean(agent),
      rename: Boolean(agent),
      archive: Boolean(agent),
      markUnread: Boolean(agent && !agent.unread),
      copyWorkingDirectory: Boolean(agent),
      forkSameWorktree: canForkRuntime,
      forkNewWorktree: canForkRuntime
        && runtimeKind !== 'acp'
        && canForkNewWorktree
        && agent?.canForkNewWorktree === true,
    },
  }
}

export function supportsAgentRuntimeSwitch(agent: Agent | null | undefined) {
  return agent?.providerCapabilities?.runtimeSwitch === true
    && agent.providerCapabilities.supportsChat === true
}

export function canSwitchAgentRuntime(agent: Agent | null | undefined) {
  if (!agent?.providerCapabilities) return false
  const providerCapabilities = agent.providerCapabilities
  const freshSwitchableTerminal = providerCapabilities.runtimeSwitch
    && agent.runtimeBinding.kind === 'terminal'
    && agent.providerSessionTemporary === true
    && agent.terminalInputReceived !== true

  return Boolean(
    providerCapabilities.runtimeSwitch
    && providerCapabilities.supportsChat
    && (agent.providerSessionTemporary !== true || freshSwitchableTerminal)
    && agent.providerSessionId
  )
}

export function canForkAgentConversation(agent: Agent | null | undefined) {
  const declared = agent?.providerCapabilities.conversationFork?.acp
  const acpBinding = agent?.runtimeBinding.kind === 'acp' ? agent.runtimeBinding : null
  const runtimeStateReady = ['idle', 'error'].includes(acpBinding?.state || '')
    || (acpBinding?.state === 'working' && declared?.supportsActiveTurn === true)
  const runtimeCapabilityReady = declared
    ? declared.requiresRuntimeCapability !== true || acpBinding?.supportsFork === true
    : acpBinding?.supportsFork === true
  return Boolean(
    agent
    && agent.runtimeBinding.kind === 'acp'
    && runtimeStateReady
    && runtimeCapabilityReady
    && (declared ? declared.supported === true : agent.providerCapabilities.sessionFork)
    && agent.providerSessionId
    && agent.providerSessionTemporary !== true
  )
}

export function projectCanArchive(project: ProjectGroup | null | undefined) {
  return Boolean(
    project
    && (
      project.agents.some(agent => !agent.isMain && !agent.pinned)
      || project.agentSessions.some(session => !session.pinned)
    )
  )
}

export function projectCanDeleteWorktree(project: ProjectGroup | null | undefined) {
  if (!project || project.hasMain || !project.workspace) return false
  const basename = project.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return /-farming-fork-\d{8}-\d{6}(?:-\d+)?$/.test(basename)
}

export function agentMenuAvailability(
  agent: Agent | null | undefined,
  environment: AgentMenuEnvironment = {},
): AgentMenuAvailability {
  const capabilities = capabilitiesForAgent(agent)
  return {
    ...capabilities.actions,
    handoff: Boolean(agent?.providerSessionProvider),
    createBrowser: environment.canCreateBrowser === true,
    createDesktop: environment.canCreateDesktop === true,
    switchRuntime: supportsAgentRuntimeSwitch(agent),
  }
}

export function agentMenuShape(
  agent: Agent | undefined,
  environment: AgentMenuEnvironment = {},
) {
  const availability = agentMenuAvailability(agent, environment)
  const groups = [
    [availability.createDesktop],
    [availability.pin, availability.rename, availability.archive, availability.markUnread, Boolean(agent)],
    [availability.copyWorkingDirectory],
    [availability.forkSameWorktree, availability.forkNewWorktree, availability.handoff],
    [availability.switchRuntime, availability.createBrowser],
  ]
  const visibleGroupCounts = groups
    .map(group => group.filter(Boolean).length)
    .filter(count => count > 0)

  return {
    itemCount: visibleGroupCounts.reduce((total, count) => total + count, 0),
    separatorCount: Math.max(0, visibleGroupCounts.length - 1),
  }
}
