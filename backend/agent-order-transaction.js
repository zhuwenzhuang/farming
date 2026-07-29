'use strict';

/**
 * Persist and publish one Agent ordering change as a bounded transaction.
 *
 * The persistent Agent records are authoritative. Runtime objects are updated
 * only after every staged record has been written successfully. If staging
 * fails, already-written records are restored before the error is returned.
 *
 * @param {import('./types/agent-domain').AgentOrderTransactionOwner} owner
 * @param {string} agentId
 * @param {Iterable<[string, number]>} orderUpdates
 * @param {import('./types/agent-domain').AgentOrderField} field
 * @returns {import('./types/agent-domain').AgentOrderTransactionResult}
 */
function commitAgentOrderTransaction(owner, agentId, orderUpdates, field) {
  const staged = [...orderUpdates]
    .map(([updatedAgentId, order]) => {
      const agent = owner.agents.get(updatedAgentId);
      return agent ? {
        agent,
        order,
        stagedAgent: { ...agent, [field]: order },
      } : null;
    })
    .filter(Boolean);

  const conflicting = staged.find(item => owner.lifecycleOperations.has(item.agent.id));
  if (conflicting) {
    const lifecycleOperation = owner.lifecycleOperations.get(conflicting.agent.id);
    return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
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
      error: `Failed to reorder Agents: ${error.message || error}${
        rollbackError ? `; storage rollback failed: ${rollbackError.message || rollbackError}` : ''
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

module.exports = {
  commitAgentOrderTransaction,
};
