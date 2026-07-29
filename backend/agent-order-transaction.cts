'use strict';

type AgentOrderField = 'projectOrder' | 'pinnedOrder';

interface AgentOrderTransactionAgent {
  id: string;
  agentRecordId?: string;
  persistentSessionId?: string;
  projectOrder?: number;
  pinnedOrder?: number;
  [key: string]: unknown;
}

interface AgentOrderTransactionOwner {
  agents: Map<string, AgentOrderTransactionAgent>;
  lifecycleOperations: Map<string, { label?: string }>;
  persistAgent(agent: AgentOrderTransactionAgent): void;
  updateRuntimeMetadata(agent: AgentOrderTransactionAgent): void;
  emitUpdate(): void;
  setAgentRecordId(agent: AgentOrderTransactionAgent, recordId: string): void;
  finiteOrder(value: unknown): number | null;
}

interface StagedOrderUpdate {
  agent: AgentOrderTransactionAgent;
  order: number;
  stagedAgent: AgentOrderTransactionAgent;
}

interface AgentOrderTransactionSuccess {
  agentId: string;
  projectOrder?: number | null;
  pinnedOrder?: number | null;
  updates: Array<Record<string, number | string>>;
  error?: never;
}

interface AgentOrderTransactionFailure {
  error: string;
}

type AgentOrderTransactionResult =
  | AgentOrderTransactionSuccess
  | AgentOrderTransactionFailure;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Persist and publish one Agent ordering change as a bounded transaction.
 *
 * The persistent Agent records are authoritative. Runtime objects are updated
 * only after every staged record has been written successfully. If staging
 * fails, already-written records are restored before the error is returned.
 *
 */
function commitAgentOrderTransaction(
  owner: AgentOrderTransactionOwner,
  agentId: string,
  orderUpdates: Iterable<readonly [string, number]>,
  field: AgentOrderField,
): AgentOrderTransactionResult {
  const staged: StagedOrderUpdate[] = [...orderUpdates]
    .map(([updatedAgentId, order]) => {
      const agent = owner.agents.get(updatedAgentId);
      return agent ? {
        agent,
        order,
        stagedAgent: { ...agent, [field]: order },
      } : null;
    })
    .filter((item): item is StagedOrderUpdate => item !== null);

  const conflicting = staged.find(item => owner.lifecycleOperations.has(item.agent.id));
  if (conflicting) {
    const lifecycleOperation = owner.lifecycleOperations.get(conflicting.agent.id);
    return { error: `Agent lifecycle change already in progress: ${lifecycleOperation?.label}` };
  }

  const attempted = [];
  try {
    for (const item of staged) {
      attempted.push(item);
      owner.persistAgent(item.stagedAgent);
    }
  } catch (error) {
    let rollbackError = null;
    for (const item of attempted.reverse()) {
      try {
        const agentRecordId = item.stagedAgent.agentRecordId
          || item.stagedAgent.persistentSessionId
          || item.agent.agentRecordId
          || item.agent.persistentSessionId;
        owner.persistAgent({
          ...item.agent,
          agentRecordId,
          persistentSessionId: agentRecordId,
        });
      } catch (restoreError) {
        rollbackError = restoreError;
      }
    }
    return {
      error: `Failed to reorder Agents: ${errorMessage(error)}${
        rollbackError ? `; storage rollback failed: ${errorMessage(rollbackError)}` : ''
      }`,
    };
  }

  const updates = staged.map(item => {
    item.agent[field] = item.order;
    owner.setAgentRecordId(
      item.agent,
      item.stagedAgent.agentRecordId || item.stagedAgent.persistentSessionId || '',
    );
    owner.updateRuntimeMetadata(item.agent);
    return { agentId: item.agent.id, [field]: item.order };
  });
  owner.emitUpdate();
  return {
    agentId,
    [field]: owner.finiteOrder(owner.agents.get(agentId)?.[field]),
    updates,
  };
}

export {
  commitAgentOrderTransaction,
};
