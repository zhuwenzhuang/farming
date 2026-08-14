export type AgentActivityLevel = 'hot' | 'warm' | 'cool' | 'cold'
export type AgentLifecycleStatus = 'pending' | 'running' | 'stopped' | 'dead'
export type ProviderRuntime = 'terminal' | 'acp'

export interface ProviderConversationForkCapability {
  supported: boolean
  strategy: 'source-session' | 'target-process' | null
  worktreeModes: Array<'same-worktree' | 'new-worktree'>
  requiresRuntimeCapability: boolean
}

export interface ProviderCapabilitiesWire {
  supportedRuntimes: ProviderRuntime[]
  runtimeSwitch: boolean
  contextWindow?: boolean
  terminalProfile: boolean
  terminalReadingAnchor?: boolean
  terminalComposerInput: 'plain-text' | 'bracketed-paste'
  slashCommandDiscovery: boolean
  goals: boolean
  goalSubmission: {
    terminal: { kind: 'prompt' } | { kind: 'command'; prefix: string }
    acp: { kind: 'prompt' }
  } | null
  conversationFork?: {
    terminal: ProviderConversationForkCapability
    acp: ProviderConversationForkCapability
  }
  terminalSessionFork: boolean
  sessionFork: boolean
  chatRuntime: 'acp' | ''
  supportsChat: boolean
  supportsSteer: boolean
}

export type AgentRuntimeBindingWire =
  | { kind: 'terminal' }
  | { kind: 'acp'; state: string }

export interface RuntimeObservationWire {
  kind: 'codex' | 'claude' | 'shell' | 'process' | 'unknown'
  phase: 'starting' | 'working' | 'waiting' | 'idle' | 'exited' | 'unknown'
  confidence: 'authoritative' | 'high' | 'heuristic'
  source: 'structured-runtime' | 'shell-marker' | 'terminal-observer'
  observerVersion: string
  observedAt: number
}

/** Stable browser-facing projection. Backend-private Agent fields do not belong here. */
export interface AgentStateWire {
  id: string
  command: string
  cwd: string
  output: string
  status: AgentLifecycleStatus
  isMain: boolean
  activityLevel: AgentActivityLevel
  lastActivity: number
  attentionScore: number
  isZombie: boolean
  providerCapabilities: ProviderCapabilitiesWire
  runtimeBinding: AgentRuntimeBindingWire
  runtimeObservation: RuntimeObservationWire
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function goalSubmissionWire(value: unknown): value is ProviderCapabilitiesWire['goalSubmission'] {
  if (value === null) return true
  const submission = record(value)
  const terminal = record(submission?.terminal)
  const acp = record(submission?.acp)
  return Boolean(
    submission
    && terminal
    && (
      terminal.kind === 'prompt'
      || (terminal.kind === 'command' && typeof terminal.prefix === 'string')
    )
    && acp?.kind === 'prompt'
  )
}

function providerConversationForkCapabilityWire(
  value: unknown,
): value is ProviderConversationForkCapability {
  const capability = record(value)
  return Boolean(
    capability
    && typeof capability.supported === 'boolean'
    && (
      capability.strategy === null
      || capability.strategy === 'source-session'
      || capability.strategy === 'target-process'
    )
    && Array.isArray(capability.worktreeModes)
    && capability.worktreeModes.every(mode => mode === 'same-worktree' || mode === 'new-worktree')
    && typeof capability.requiresRuntimeCapability === 'boolean'
  )
}

function providerConversationForkWire(
  value: unknown,
): value is NonNullable<ProviderCapabilitiesWire['conversationFork']> {
  const conversationFork = record(value)
  return Boolean(
    conversationFork
    && providerConversationForkCapabilityWire(conversationFork.terminal)
    && providerConversationForkCapabilityWire(conversationFork.acp)
  )
}

function providerCapabilitiesWire(value: unknown): value is ProviderCapabilitiesWire {
  const capabilities = record(value)
  return Boolean(
    capabilities
    && Array.isArray(capabilities.supportedRuntimes)
    && capabilities.supportedRuntimes.every(runtime => runtime === 'terminal' || runtime === 'acp')
    && typeof capabilities.runtimeSwitch === 'boolean'
    && (capabilities.contextWindow === undefined || typeof capabilities.contextWindow === 'boolean')
    && typeof capabilities.terminalProfile === 'boolean'
    && (capabilities.terminalReadingAnchor === undefined || typeof capabilities.terminalReadingAnchor === 'boolean')
    && (capabilities.terminalComposerInput === 'plain-text' || capabilities.terminalComposerInput === 'bracketed-paste')
    && typeof capabilities.slashCommandDiscovery === 'boolean'
    && typeof capabilities.goals === 'boolean'
    && goalSubmissionWire(capabilities.goalSubmission)
    && (
      capabilities.conversationFork === undefined
      || providerConversationForkWire(capabilities.conversationFork)
    )
    && typeof capabilities.terminalSessionFork === 'boolean'
    && typeof capabilities.sessionFork === 'boolean'
    && (capabilities.chatRuntime === '' || capabilities.chatRuntime === 'acp')
    && typeof capabilities.supportsChat === 'boolean'
    && typeof capabilities.supportsSteer === 'boolean'
  )
}

function runtimeBindingWire(value: unknown): value is AgentRuntimeBindingWire {
  const binding = record(value)
  return Boolean(
    binding
    && (
      binding.kind === 'terminal'
      || (binding.kind === 'acp' && typeof binding.state === 'string')
    )
  )
}

function runtimeObservationWire(value: unknown): value is RuntimeObservationWire {
  const observation = record(value)
  return Boolean(
    observation
    && ['codex', 'claude', 'shell', 'process', 'unknown'].includes(String(observation.kind || ''))
    && ['starting', 'working', 'waiting', 'idle', 'exited', 'unknown'].includes(String(observation.phase || ''))
    && ['authoritative', 'high', 'heuristic'].includes(String(observation.confidence || ''))
    && ['structured-runtime', 'shell-marker', 'terminal-observer'].includes(String(observation.source || ''))
    && typeof observation.observerVersion === 'string'
    && finiteNumber(observation.observedAt)
  )
}

export function isAgentStateWire(value: unknown): value is AgentStateWire {
  const agent = record(value)
  return Boolean(
    agent
    && typeof agent.id === 'string'
    && agent.id.length > 0
    && typeof agent.command === 'string'
    && typeof agent.cwd === 'string'
    && typeof agent.output === 'string'
    && ['pending', 'running', 'stopped', 'dead'].includes(String(agent.status || ''))
    && typeof agent.isMain === 'boolean'
    && ['hot', 'warm', 'cool', 'cold'].includes(String(agent.activityLevel || ''))
    && finiteNumber(agent.lastActivity)
    && finiteNumber(agent.attentionScore)
    && typeof agent.isZombie === 'boolean'
    && providerCapabilitiesWire(agent.providerCapabilities)
    && runtimeBindingWire(agent.runtimeBinding)
    && runtimeObservationWire(agent.runtimeObservation)
  )
}
