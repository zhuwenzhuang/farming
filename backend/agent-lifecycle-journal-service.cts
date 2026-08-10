'use strict';

import type {
  AgentRecord,
  PersistedAgentPrivateMetadata,
} from './agent-manager-record-types.js';
import type {
  LifecycleJournal,
  LifecycleOperation,
  LifecycleOperationRequest,
  LifecycleOperationResult,
  LifecycleOperationState,
  LifecycleOperationType,
} from './agent-manager-lifecycle-types.js';
import {
  activeLifecycleOperation,
  beginLifecycleOperation,
  latestLifecycleOperation,
  lifecycleJournal,
  setLifecycleOperationResult,
  transitionLifecycleOperation,
} from './agent-lifecycle-journal.cjs';

type AgentLifecyclePersistencePort = {
  isRequired(): boolean;
  persist(
    agent: AgentRecord,
    patch?: Partial<PersistedAgentPrivateMetadata>,
  ): string;
};

type AgentLifecycleJournalServiceOptions = {
  getAgent: (agentId: string) => AgentRecord | undefined;
  persistence: AgentLifecyclePersistencePort;
};

type PersistentAgentUpdateAdmission =
  | {
      conflict?: LifecycleOperation;
      error: string;
      operation?: never;
      deduplicated?: never;
      joined?: never;
    }
  | {
      error?: undefined;
      operation: LifecycleOperation;
      deduplicated?: boolean;
      joined?: boolean;
    };

function clonedJournal(agent: AgentRecord): LifecycleJournal | null {
  return agent.lifecycleJournal
    ? JSON.parse(JSON.stringify(agent.lifecycleJournal)) as LifecycleJournal
    : null;
}

function restoreJournal(agent: AgentRecord, journal: LifecycleJournal | null): void {
  if (journal) agent.lifecycleJournal = journal;
  else delete agent.lifecycleJournal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AgentLifecycleJournalService {
  private readonly options: AgentLifecycleJournalServiceOptions;

  constructor(options: AgentLifecycleJournalServiceOptions) {
    this.options = options;
  }

  begin(
    agent: AgentRecord,
    type: LifecycleOperationType,
    requestKey: string,
    request: LifecycleOperationRequest = {},
  ): PersistentAgentUpdateAdmission {
    const previousJournal = clonedJournal(agent);
    const result = beginLifecycleOperation(agent, type, requestKey, request);
    if (result.conflict) {
      return {
        error: `Agent operation ${result.conflict.id} (${result.conflict.type}) has not reached a terminal state`,
        conflict: result.conflict,
      };
    }
    if (result.joined && result.operation.state === 'blocked') {
      transitionLifecycleOperation(agent, result.operation.id, 'pending');
    }
    try {
      this.persist(agent);
    } catch (error) {
      restoreJournal(agent, previousJournal);
      return { error: `Failed to persist Agent ${type} intent: ${errorMessage(error)}` };
    }
    return {
      operation: activeLifecycleOperation(agent) ?? result.operation,
      joined: result.joined,
    };
  }

  transition(
    agent: AgentRecord,
    operationId: string,
    state: LifecycleOperationState,
    error = '',
    patch: Partial<PersistedAgentPrivateMetadata> = {},
    requestPatch: LifecycleOperationRequest = {},
  ): LifecycleOperation {
    const previousJournal = clonedJournal(agent);
    const operation = transitionLifecycleOperation(agent, operationId, state, error);
    if (!operation) throw new Error(`Agent operation ${operationId} was not found`);
    operation.request = { ...(operation.request || {}), ...requestPatch };
    try {
      this.persist(agent, patch);
    } catch (persistError) {
      restoreJournal(agent, previousJournal);
      throw persistError;
    }
    return operation;
  }

  checkpointRequest(
    agent: AgentRecord,
    operationId: string,
    requestPatch: LifecycleOperationRequest,
  ): LifecycleOperation {
    const previousJournal = clonedJournal(agent);
    const journal = lifecycleJournal(agent);
    const operation = journal.entries.find(candidate => candidate.id === operationId);
    if (!operation) throw new Error(`Agent operation ${operationId} was not found`);
    operation.request = { ...(operation.request || {}), ...requestPatch };
    operation.updatedAt = Date.now();
    agent.lifecycleJournal = journal;
    try {
      this.persist(agent);
    } catch (error) {
      restoreJournal(agent, previousJournal);
      throw error;
    }
    return operation;
  }

  complete(
    agent: AgentRecord,
    operationId: string,
    result: LifecycleOperationResult,
    patch: Partial<PersistedAgentPrivateMetadata> = {},
  ): LifecycleOperation {
    const staged: AgentRecord = {
      ...agent,
      lifecycleJournal: lifecycleJournal(agent),
    };
    const operation = setLifecycleOperationResult(staged, operationId, result);
    if (!operation) throw new Error(`Agent operation ${operationId} was not found`);
    transitionLifecycleOperation(staged, operationId, 'succeeded');
    this.persist(staged, patch);
    agent.lifecycleJournal = staged.lifecycleJournal;
    this.copyRecordId(staged, agent);
    return operation;
  }

  beginUpdate(
    agent: AgentRecord,
    requestKey: string,
    request: LifecycleOperationRequest,
  ): PersistentAgentUpdateAdmission {
    const latest = latestLifecycleOperation(agent);
    if (
      latest?.type === 'update'
      && latest.state === 'succeeded'
      && latest.requestKey === requestKey
    ) {
      return { operation: latest, deduplicated: true };
    }
    return this.begin(agent, 'update', requestKey, request);
  }

  recordCreateRequestResult(
    agentId: string,
    createRequestId: unknown,
    result: LifecycleOperationResult,
  ): { agentId?: string; error?: string; operationId?: string; result?: LifecycleOperationResult } {
    const agent = this.options.getAgent(agentId);
    if (!agent) return { error: 'Agent not found' };
    const requestKey = `create-request:${String(createRequestId || '').trim().slice(0, 160)}`;
    const operation = lifecycleJournal(agent).entries.find(candidate => (
      candidate.type === 'create'
      && candidate.requestKey === requestKey
      && candidate.state === 'succeeded'
    ));
    if (!operation) return { error: 'Create operation was not found' };
    const staged: AgentRecord = {
      ...agent,
      lifecycleJournal: lifecycleJournal(agent),
    };
    setLifecycleOperationResult(staged, operation.id, result);
    try {
      this.options.persistence.persist(staged);
    } catch (error) {
      return { error: `Failed to persist Create result: ${errorMessage(error)}` };
    }
    agent.lifecycleJournal = staged.lifecycleJournal;
    this.copyRecordId(staged, agent);
    return { agentId, operationId: operation.id, result };
  }

  private copyRecordId(source: AgentRecord, target: AgentRecord): void {
    const recordId = String(source.agentRecordId || source.persistentSessionId || '').trim();
    if (!recordId) return;
    target.agentRecordId = recordId;
    target.persistentSessionId = recordId;
  }

  private persist(
    agent: AgentRecord,
    patch: Partial<PersistedAgentPrivateMetadata> = {},
  ): string {
    const persistentSessionId = this.options.persistence.persist(agent, patch);
    if (this.options.persistence.isRequired() && !persistentSessionId) {
      throw new Error('Agent session store did not return a persistent id');
    }
    return persistentSessionId;
  }
}

export {
  AgentLifecycleJournalService,
  type PersistentAgentUpdateAdmission,
};
