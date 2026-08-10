'use strict';

import type {
  AgentRecord,
  PersistedAgentPrivateMetadata,
} from './agent-manager-record-types.js';
import type { AcpConfigChange } from './agent-manager-provider-types.js';
import { agentAttentionUnread } from './agent-attention.cjs';
import { finiteOrder } from './agent-order.cjs';
import type { AcpSessionOptionsStore } from './acp-session-options-store.cjs';

type AgentSessionPersistenceConfig = {
  ensureAgentSessionRecord?(
    agent: AgentRecord,
    patch: Partial<PersistedAgentPrivateMetadata>,
  ): string;
  getAgentSessionRecordForProviderSessionKey?(
    sessionKey: string,
  ): PersistedAgentPrivateMetadata | null;
};

type AgentSessionPersistenceOptions = {
  config: AgentSessionPersistenceConfig | null | undefined;
  getAgent: (agentId: string) => AgentRecord | undefined;
  isRecoveryComplete: () => boolean;
  isVerifiedStopped: (agentId: string) => boolean;
  observeOrder: (agent: AgentRecord, live: boolean) => void;
  sessionOptions: AcpSessionOptionsStore;
};

function finiteNumberOrNull(value: unknown): number | null {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function finiteNonNegativeInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function cloneConfigOverrides(value: AcpConfigChange[]): AcpConfigChange[] {
  return value.map(change => ({
    configId: change.configId,
    value: Array.isArray(change.value) ? [...change.value] : change.value,
  }));
}

function setAgentRecordId(agent: AgentRecord, recordId: unknown): void {
  const normalized = typeof recordId === 'string' ? recordId.trim() : '';
  if (!normalized) return;
  agent.agentRecordId = normalized;
  agent.persistentSessionId = normalized;
}

class AgentSessionPersistenceService {
  private readonly options: AgentSessionPersistenceOptions;

  constructor(options: AgentSessionPersistenceOptions) {
    this.options = options;
  }

  isRequired(): boolean {
    return typeof this.options.config?.ensureAgentSessionRecord === 'function';
  }

  persist(
    agent: AgentRecord,
    patch: Partial<PersistedAgentPrivateMetadata> = {},
  ): string {
    const config = this.options.config;
    if (!agent || !config || typeof config.ensureAgentSessionRecord !== 'function') return '';
    this.assertRuntimeOwner(agent);
    const previousAgentRecordId = agent.agentRecordId || agent.persistentSessionId || '';
    const sessionOptions = agent.providerSessionKey
      ? this.options.sessionOptions.get(agent.providerSessionKey)
      : null;
    const agentRecordId = config.ensureAgentSessionRecord(agent, {
      ...(sessionOptions ? {
        acpAdditionalDirectories: [...sessionOptions.additionalDirectories],
        acpConfigOverrides: cloneConfigOverrides(sessionOptions.configOverrides),
        acpMcpServers: JSON.parse(JSON.stringify(sessionOptions.mcpServers)),
      } : {}),
      ...patch,
    });
    if (agentRecordId) setAgentRecordId(agent, agentRecordId);
    if (
      agentRecordId
      && previousAgentRecordId
      && agentRecordId !== previousAgentRecordId
      && agent.providerSessionKey
      && typeof config.getAgentSessionRecordForProviderSessionKey === 'function'
    ) {
      const record = config.getAgentSessionRecordForProviderSessionKey(agent.providerSessionKey);
      if (record) this.applyCanonicalRecord(agent, record);
    }
    const liveAgent = this.options.getAgent(agent.id);
    if (liveAgent === agent) this.options.observeOrder(agent, true);
    else if (liveAgent) this.options.observeOrder(agent, false);
    return agentRecordId;
  }

  assertRuntimeOwner(agent: AgentRecord): void {
    const config = this.options.config;
    if (
      !agent?.providerSessionKey
      || typeof config?.getAgentSessionRecordForProviderSessionKey !== 'function'
    ) return;
    const canonical = config.getAgentSessionRecordForProviderSessionKey(agent.providerSessionKey);
    const currentOwner = String(canonical?.runtimeAgentId || '').trim();
    const requestedOwner = String(agent.id || '').trim();
    if (!currentOwner || currentOwner === requestedOwner) return;

    const ownerAgent = this.options.getAgent(currentOwner);
    if (!ownerAgent && !this.options.isRecoveryComplete()) {
      throw new Error(
        `Agent session ${agent.providerSessionKey} ownership cannot be changed before recovery completes`,
      );
    }
    const ownerIsStopped = !ownerAgent
      || this.options.isVerifiedStopped(currentOwner)
      || ['dead', 'stopped'].includes(String(ownerAgent.status || ''))
      || ownerAgent.engineStatus === 'exited';
    if (ownerIsStopped) return;
    throw new Error(
      `Agent session ${agent.providerSessionKey} is owned by Runtime ${currentOwner}, not ${requestedOwner}`,
    );
  }

  private applyCanonicalRecord(
    agent: AgentRecord,
    record: PersistedAgentPrivateMetadata,
  ): void {
    agent.projectWorkspace = record.projectWorkspace || agent.projectWorkspace || '';
    agent.task = typeof record.task === 'string' ? record.task : (agent.task || '');
    agent.workflowTemplate = typeof record.workflowTemplate === 'string'
      ? record.workflowTemplate
      : (agent.workflowTemplate || '');
    agent.customTitle = typeof record.customTitle === 'string' ? record.customTitle : '';
    agent.adaptiveTitle = typeof record.adaptiveTitle === 'string' ? record.adaptiveTitle : '';
    agent.pinned = record.pinned === true;
    agent.projectOrder = finiteOrder(record.projectOrder);
    agent.pinnedOrder = finiteOrder(record.pinnedOrder);
    agent.attentionSeq = finiteNonNegativeInteger(record.attentionSeq);
    agent.readAttentionSeq = finiteNonNegativeInteger(record.readAttentionSeq);
    agent.attentionUpdatedAt = finiteNumberOrNull(record.attentionUpdatedAt);
    agent.readAttentionAt = finiteNumberOrNull(record.readAttentionAt);
    agent.attentionReason = record.attentionReason || '';
    agent.attentionOutputEpoch = record.attentionOutputEpoch || '';
    agent.attentionOutputSeq = finiteNumberOrNull(record.attentionOutputSeq);
    agent.readOutputEpoch = record.readOutputEpoch || '';
    agent.readOutputSeq = finiteNumberOrNull(record.readOutputSeq);
    agent.unread = agentAttentionUnread(agent);
  }
}

export { AgentSessionPersistenceService };
