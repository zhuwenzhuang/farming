import type { Agent } from '@/types/agent'
import type { ProjectGroup } from './types'
import type { ComposerAgentKind } from './agent-kind'
import { inferAgentTerminalState } from './agent-terminal-inference'

export { agentKindForCommand, type ComposerAgentKind } from './agent-kind'
export { inferAgentTerminalState, isAgentTurnActive, isCodexAgentWorking } from './agent-working-state'

export type SlashCommandSource = 'codex' | 'claude' | 'skill' | 'custom'

export interface SlashCommandOption {
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

const CODEX_SLASH_COMMANDS: SlashCommandOption[] = [
  {
    command: '/goal',
    label: 'Goal',
    description: 'Set or update what this Codex session should keep working toward',
    source: 'codex',
  },
  {
    command: '/plan',
    label: 'Plan mode',
    description: 'Ask Codex to plan first before editing',
    source: 'codex',
  },
  {
    command: '/skills',
    label: 'Skills',
    description: 'Browse and use available Codex skills',
    source: 'codex',
  },
  {
    command: '/permissions',
    label: 'Permissions',
    description: 'Change what Codex can do without asking first',
    source: 'codex',
  },
  {
    command: '/model',
    label: 'Model',
    description: 'Change or inspect the active Codex model',
    source: 'codex',
  },
  {
    command: '/reasoning',
    label: 'Reasoning',
    description: 'Change the reasoning effort for this session',
    source: 'codex',
  },
  {
    command: '/mcp',
    label: 'MCP',
    description: 'Show MCP server status',
    source: 'codex',
  },
  {
    command: '/fast',
    label: 'Fast',
    description: 'Toggle Codex fast mode when available',
    source: 'codex',
  },
  {
    command: '/status',
    label: 'Status',
    description: 'Inspect the session, model, permissions, and token usage',
    source: 'codex',
  },
  {
    command: '/usage',
    label: 'Usage',
    description: 'View account token usage from Codex',
    source: 'codex',
  },
  {
    command: '/compact',
    label: 'Compact',
    description: 'Summarize long context to free tokens',
    source: 'codex',
  },
  {
    command: '/review',
    label: 'Review',
    description: 'Ask Codex to review the current working tree',
    source: 'codex',
  },
  {
    command: '/personality',
    label: 'Personality',
    description: 'Choose how Codex communicates in this session',
    source: 'codex',
  },
  {
    command: '/help',
    label: 'Help',
    description: 'Show available Codex slash commands',
    source: 'codex',
  },
]

const CLAUDE_SLASH_COMMANDS: SlashCommandOption[] = [
  {
    command: '/help',
    label: 'Help',
    description: 'Show available Claude Code slash commands',
    source: 'claude',
  },
  {
    command: '/model',
    label: 'Model',
    description: 'Change or inspect the active Claude model',
    source: 'claude',
  },
  {
    command: '/permissions',
    label: 'Permissions',
    description: 'Review or change Claude Code permission behavior',
    source: 'claude',
  },
  {
    command: '/cost',
    label: 'Cost',
    description: 'Show Claude Code usage for the current conversation',
    source: 'claude',
  },
  {
    command: '/compact',
    label: 'Compact',
    description: 'Compact the current Claude Code conversation',
    source: 'claude',
  },
  {
    command: '/clear',
    label: 'Clear',
    description: 'Clear the current Claude Code conversation',
    source: 'claude',
  },
  {
    command: '/config',
    label: 'Config',
    description: 'Open Claude Code configuration',
    source: 'claude',
  },
  {
    command: '/doctor',
    label: 'Doctor',
    description: 'Check Claude Code installation and account health',
    source: 'claude',
  },
  {
    command: '/memory',
    label: 'Memory',
    description: 'Edit or inspect Claude Code memory',
    source: 'claude',
  },
]

export function slashCommandsForAgentKind(kind: ComposerAgentKind): SlashCommandOption[] {
  if (kind === 'codex') return CODEX_SLASH_COMMANDS
  if (kind === 'claude') return CLAUDE_SLASH_COMMANDS
  return []
}

export function mergeSlashCommands(commands: SlashCommandOption[]) {
  const seen = new Set<string>()
  return commands.filter(command => {
    const commandId = command.command.trim().toLowerCase()
    if (!commandId || seen.has(commandId)) return false
    seen.add(commandId)
    return true
  })
}

export function capabilitiesForAgent(agent: Agent | null | undefined): AgentCapabilities {
  const inferredKind = inferAgentTerminalState(agent).kind
  const runtimeKind = agent?.runtimeBinding.kind || 'terminal'
  const providerCapabilities = agent?.providerCapabilities
  // Terminal text is a heuristic observation of the current screen. It may
  // briefly fall back to the generic `process` kind while Codex redraws its
  // composer, but that must not hide a capability the backend's exact provider
  // adapter has already advertised.
  const kind = runtimeKind === 'terminal'
    && providerCapabilities?.terminalProfile === true
    ? 'codex'
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
  const composer = kind === 'codex'
    ? {
        ...CODING_AGENT_COMPOSER_CAPABILITIES,
        goalMode,
        modelPicker: terminalProfile,
        reasoningEffort: terminalProfile,
        serviceTier: terminalProfile,
      }
    : kind === 'claude'
      ? {
          ...CODING_AGENT_COMPOSER_CAPABILITIES,
          goalMode,
          // Claude Terminal currently has no verified live-profile adapter.
          // ACP renders provider-advertised config options in AcpComposer.
          modelPicker: false,
          reasoningEffort: false,
        }
      : {
          ...BASIC_COMPOSER_CAPABILITIES,
          goalMode,
        }

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
      project.agents.some(agent => !agent.isMain)
      || project.agentSessions.length > 0
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
    createBrowser: environment.canCreateBrowser === true,
    createDesktop: environment.canCreateDesktop === true,
    switchRuntime: canSwitchAgentRuntime(agent),
  }
}

export function agentMenuShape(
  agent: Agent | undefined,
  environment: AgentMenuEnvironment = {},
) {
  const availability = agentMenuAvailability(agent, environment)
  const groups = [
    [availability.createDesktop],
    [availability.pin, availability.rename, availability.archive, availability.markUnread],
    [availability.copyWorkingDirectory],
    [availability.forkSameWorktree, availability.forkNewWorktree],
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
