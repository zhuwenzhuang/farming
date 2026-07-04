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
  kill: boolean
}

export interface AgentCapabilities {
  kind: ComposerAgentKind
  composer: AgentComposerCapabilities
  actions: AgentActionCapabilities
}

const BASIC_COMPOSER_CAPABILITIES: AgentComposerCapabilities = {
  plusMenu: false,
  permissionMode: false,
  modelPicker: false,
  reasoningEffort: false,
  serviceTier: false,
  speechInput: false,
}

const CODING_AGENT_COMPOSER_CAPABILITIES: AgentComposerCapabilities = {
  plusMenu: true,
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
  const kind = inferAgentTerminalState(agent).kind
  const composer = kind === 'codex'
    ? { ...CODING_AGENT_COMPOSER_CAPABILITIES, serviceTier: true }
    : kind === 'claude'
      ? { ...CODING_AGENT_COMPOSER_CAPABILITIES }
      : { ...BASIC_COMPOSER_CAPABILITIES }

  return {
    kind,
    composer,
    actions: {
      pin: Boolean(agent),
      rename: Boolean(agent),
      archive: Boolean(agent && !agent.isMain),
      markUnread: Boolean(agent),
      copyWorkingDirectory: Boolean(agent),
      forkSameWorktree: Boolean(agent),
      forkNewWorktree: agent?.canForkNewWorktree === true,
      kill: Boolean(agent && agent.isMain),
    },
  }
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

export function agentMenuShape(agent: Agent | undefined) {
  const capabilities = capabilitiesForAgent(agent)
  const itemCount = [
    capabilities.actions.pin,
    capabilities.actions.rename,
    capabilities.actions.archive,
    capabilities.actions.markUnread,
    capabilities.actions.copyWorkingDirectory,
    capabilities.actions.forkSameWorktree,
    capabilities.actions.forkNewWorktree,
    capabilities.actions.kill,
  ].filter(Boolean).length

  return {
    itemCount,
    separatorCount: itemCount > 0 ? 2 : 0,
  }
}
