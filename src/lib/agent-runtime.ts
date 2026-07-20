import type {
  AcpRuntimeBinding,
  Agent,
  AgentRuntimeBinding,
  JsonRuntimeBinding,
} from '@/types/agent'

export function isAcpRuntime(agent: Agent | null | undefined): agent is Agent & { runtimeBinding: AcpRuntimeBinding } {
  return agent?.runtimeBinding.kind === 'acp'
}

export function isJsonRuntime(agent: Agent | null | undefined): agent is Agent & { runtimeBinding: JsonRuntimeBinding } {
  return agent?.runtimeBinding.kind === 'json'
}

export function isStructuredRuntime(agent: Agent | null | undefined) {
  return Boolean(agent && agent.runtimeBinding.kind !== 'terminal')
}

export function runtimeState(agent: Agent | null | undefined) {
  return agent?.runtimeBinding.kind === 'terminal' ? '' : agent?.runtimeBinding.state || ''
}

export function runtimeBindingForMode(
  mode: 'terminal' | 'chat' | 'acp' | 'json' | undefined,
  fallback: AgentRuntimeBinding,
): AgentRuntimeBinding {
  if (mode === 'terminal') return { kind: 'terminal' }
  if (mode === 'json') return { kind: 'json', state: 'starting', error: '', transcriptUpdatedAt: '' }
  if (mode === 'acp') {
    return {
      kind: 'acp',
      state: 'starting',
      error: '',
      stopReason: '',
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
