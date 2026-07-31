import type {
  AcpRuntimeBinding,
  Agent,
  AgentRuntimeBinding,
} from '@/types/agent'

export function isAcpRuntime(agent: Agent | null | undefined): agent is Agent & { runtimeBinding: AcpRuntimeBinding } {
  return agent?.runtimeBinding.kind === 'acp'
}

export function isStructuredRuntime(agent: Agent | null | undefined) {
  return Boolean(agent && agent.runtimeBinding.kind !== 'terminal')
}

export function runtimeState(agent: Agent | null | undefined) {
  return agent?.runtimeBinding.kind === 'terminal' ? '' : agent?.runtimeBinding.state || ''
}

export function runtimeBindingForMode(
  mode: 'terminal' | 'chat' | 'acp' | undefined,
  fallback: AgentRuntimeBinding,
): AgentRuntimeBinding {
  if (mode === 'terminal') return { kind: 'terminal' }
  if (mode === 'acp') {
    return {
      kind: 'acp',
      state: 'starting',
      error: '',
      stopReason: '',
      supportsSteer: false,
      pendingPermission: null,
      pendingPermissions: [],
      pendingElicitation: null,
      pendingElicitations: [],
      activeElicitations: [],
      sessionUpdatedAt: '',
      sessionRevision: 0,
    }
  }
  return fallback
}
