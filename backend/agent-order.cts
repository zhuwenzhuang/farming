'use strict';

const AGENT_ORDER_STEP = 1024;

interface AgentOrderRecord {
  id: string;
  cwd?: string;
  projectWorkspace?: string;
  projectOrder?: number | null;
  pinned?: boolean;
  pinnedOrder?: number | null;
  startedAt?: number | string | null;
}

class AgentOrderAllocator {
  private readonly projectHighWater = new Map<string, number>();
  private readonly projectAgentCounts = new Map<string, number>();
  private readonly observations = new WeakMap<AgentOrderRecord, { pinned: boolean; workspace: string }>();
  private pinnedAgentCount = 0;
  private pinnedHighWater = 0;

  private releaseObservation(observation: { pinned: boolean; workspace: string }): void {
    const projectAgentCount = (this.projectAgentCounts.get(observation.workspace) || 0) - 1;
    if (projectAgentCount > 0) {
      this.projectAgentCounts.set(observation.workspace, projectAgentCount);
    } else {
      this.projectAgentCounts.delete(observation.workspace);
      this.projectHighWater.delete(observation.workspace);
    }
    if (observation.pinned) {
      this.pinnedAgentCount = Math.max(0, this.pinnedAgentCount - 1);
      if (this.pinnedAgentCount === 0) this.pinnedHighWater = 0;
    }
  }

  reserve(agent: AgentOrderRecord | null | undefined): void {
    if (!agent) return;
    const currentProjectOrder = finiteOrder(agent.projectOrder);
    const workspace = agentWorkspace(agent);
    if (currentProjectOrder !== null && (this.projectAgentCounts.get(workspace) || 0) > 0) {
      this.projectHighWater.set(
        workspace,
        Math.max(this.projectHighWater.get(workspace) || 0, currentProjectOrder),
      );
    }
    const currentPinnedOrder = agent.pinned === true
      ? finiteOrder(agent.pinnedOrder)
      : null;
    if (currentPinnedOrder !== null && this.pinnedAgentCount > 0) {
      this.pinnedHighWater = Math.max(this.pinnedHighWater, currentPinnedOrder);
    }
  }

  observe(agent: AgentOrderRecord | null | undefined): void {
    if (!agent) return;
    const nextObservation = {
      pinned: agent.pinned === true,
      workspace: agentWorkspace(agent),
    };
    const previousObservation = this.observations.get(agent);
    const changed = !previousObservation
      || previousObservation.pinned !== nextObservation.pinned
      || previousObservation.workspace !== nextObservation.workspace;
    if (previousObservation && changed) {
      this.releaseObservation(previousObservation);
    }
    if (changed) {
      this.projectAgentCounts.set(
        nextObservation.workspace,
        (this.projectAgentCounts.get(nextObservation.workspace) || 0) + 1,
      );
      if (nextObservation.pinned) this.pinnedAgentCount += 1;
      this.observations.set(agent, nextObservation);
    }
    this.reserve(agent);
  }

  ensure(agent: AgentOrderRecord): AgentOrderRecord {
    if (finiteOrder(agent.projectOrder) === null) {
      const workspace = agentWorkspace(agent);
      agent.projectOrder = (this.projectHighWater.get(workspace) || 0) + AGENT_ORDER_STEP;
    }
    if (agent.pinned === true && finiteOrder(agent.pinnedOrder) === null) {
      agent.pinnedOrder = this.nextPinnedOrder();
    }
    this.observe(agent);
    return agent;
  }

  remove(agent: AgentOrderRecord | null | undefined): void {
    if (!agent) return;
    const observation = this.observations.get(agent);
    if (!observation) return;
    this.releaseObservation(observation);
    this.observations.delete(agent);
  }

  nextPinnedOrder(): number {
    return this.pinnedHighWater + AGENT_ORDER_STEP;
  }
}

type AgentOrderResult =
  | { error: string; updates?: never }
  | { updates: Map<string, number>; error?: never };

function finiteOrder(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function agentWorkspace(agent: AgentOrderRecord | null | undefined): string {
  return String(agent && (agent.projectWorkspace || agent.cwd) || '');
}

function projectOrder(agent: AgentOrderRecord | null | undefined): number {
  return finiteOrder(agent && agent.projectOrder) ?? 0;
}

function pinnedOrder(agent: AgentOrderRecord | null | undefined): number {
  return finiteOrder(agent && agent.pinnedOrder) ?? 0;
}

function compareProjectAgents(left: AgentOrderRecord, right: AgentOrderRecord): number {
  return projectOrder(right) - projectOrder(left)
    || (Number(right && right.startedAt) || 0) - (Number(left && left.startedAt) || 0)
    || String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function comparePinnedAgents(left: AgentOrderRecord, right: AgentOrderRecord): number {
  return pinnedOrder(left) - pinnedOrder(right)
    || (Number(left && left.startedAt) || 0) - (Number(right && right.startedAt) || 0)
    || String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function projectAgents(
  agents: AgentOrderRecord[],
  workspace: string,
  excludedAgentId = '',
): AgentOrderRecord[] {
  return agents
    .filter(agent => agent && agent.id !== excludedAgentId && agentWorkspace(agent) === workspace)
    .sort(compareProjectAgents);
}

function reorderedProjectAgentOrders(
  agents: AgentOrderRecord[],
  agentId: string,
  beforeAgentId = '',
  afterAgentId = '',
): AgentOrderResult {
  const target = agents.find(agent => agent && agent.id === agentId);
  if (!target) return { error: 'Agent not found' };
  if (target.pinned === true) return { error: 'Pinned Agents cannot be reordered inside a Project' };

  const workspace = agentWorkspace(target);
  const visible = projectAgents(agents, workspace, agentId).filter(agent => agent.pinned !== true);
  const beforeIndex = beforeAgentId ? visible.findIndex(agent => agent.id === beforeAgentId) : -1;
  const afterIndex = afterAgentId ? visible.findIndex(agent => agent.id === afterAgentId) : -1;
  if (beforeAgentId && beforeIndex < 0 || afterAgentId && afterIndex < 0) {
    return { error: 'Reorder neighbors must belong to the same Project' };
  }

  const insertIndex = afterAgentId ? afterIndex : beforeAgentId ? beforeIndex + 1 : 0;
  const expectedBefore = insertIndex > 0 ? visible[insertIndex - 1]?.id || '' : '';
  const expectedAfter = insertIndex < visible.length ? visible[insertIndex]?.id || '' : '';
  if (expectedBefore !== beforeAgentId || expectedAfter !== afterAgentId) {
    return { error: 'Reorder neighbors are stale' };
  }

  const fullOrder = projectAgents(agents, workspace, agentId);
  let fullInsertIndex = 0;
  if (beforeAgentId) {
    fullInsertIndex = fullOrder.findIndex(agent => agent.id === beforeAgentId) + 1;
  } else if (afterAgentId) {
    fullInsertIndex = fullOrder.findIndex(agent => agent.id === afterAgentId);
  }

  const updates = new Map<string, number>();
  const orderAt = (index: number): number => {
    const agent = fullOrder[index];
    return agent ? (updates.get(agent.id) ?? finiteOrder(agent.projectOrder) ?? 0) : 0;
  };
  let upper = fullInsertIndex > 0 ? orderAt(fullInsertIndex - 1) : null;
  let lower = fullInsertIndex < fullOrder.length ? orderAt(fullInsertIndex) : null;
  if (upper !== null && lower !== null && upper - lower <= 1) {
    fullOrder.forEach((agent, index) => {
      const order = (fullOrder.length - index) * AGENT_ORDER_STEP;
      if (projectOrder(agent) !== order) updates.set(agent.id, order);
    });
    upper = fullInsertIndex > 0 ? orderAt(fullInsertIndex - 1) : null;
    lower = fullInsertIndex < fullOrder.length ? orderAt(fullInsertIndex) : null;
  }

  const order = upper === null
    ? (lower ?? 0) + AGENT_ORDER_STEP
    : lower === null
      ? upper - AGENT_ORDER_STEP
      : Math.floor((upper + lower) / 2);
  updates.set(target.id, order);
  return { updates };
}

function reorderedPinnedAgentOrders(
  agents: AgentOrderRecord[],
  agentId: string,
  beforeAgentId = '',
  afterAgentId = '',
): AgentOrderResult {
  const target = agents.find(agent => agent && agent.id === agentId);
  if (!target) return { error: 'Agent not found' };
  if (target.pinned !== true) return { error: 'Only pinned Agents can be reordered in Pinned' };

  const pinned = agents
    .filter(agent => agent && agent.id !== agentId && agent.pinned === true)
    .sort(comparePinnedAgents);
  const beforeIndex = beforeAgentId ? pinned.findIndex(agent => agent.id === beforeAgentId) : -1;
  const afterIndex = afterAgentId ? pinned.findIndex(agent => agent.id === afterAgentId) : -1;
  if (beforeAgentId && beforeIndex < 0 || afterAgentId && afterIndex < 0) {
    return { error: 'Reorder neighbors must belong to Pinned' };
  }

  const insertIndex = afterAgentId ? afterIndex : beforeAgentId ? beforeIndex + 1 : 0;
  const expectedBefore = insertIndex > 0 ? pinned[insertIndex - 1]?.id || '' : '';
  const expectedAfter = insertIndex < pinned.length ? pinned[insertIndex]?.id || '' : '';
  if (expectedBefore !== beforeAgentId || expectedAfter !== afterAgentId) {
    return { error: 'Reorder neighbors are stale' };
  }

  const updates = new Map<string, number>();
  const orderAt = (index: number): number => {
    const agent = pinned[index];
    return agent ? (updates.get(agent.id) ?? finiteOrder(agent.pinnedOrder) ?? 0) : 0;
  };
  let previous = insertIndex > 0 ? orderAt(insertIndex - 1) : null;
  let next = insertIndex < pinned.length ? orderAt(insertIndex) : null;
  if (previous !== null && next !== null && next - previous <= 1) {
    pinned.forEach((agent, index) => {
      const order = (index + 1) * AGENT_ORDER_STEP;
      if (pinnedOrder(agent) !== order) updates.set(agent.id, order);
    });
    previous = insertIndex > 0 ? orderAt(insertIndex - 1) : null;
    next = insertIndex < pinned.length ? orderAt(insertIndex) : null;
  }

  const order = previous === null
    ? (next ?? AGENT_ORDER_STEP) - AGENT_ORDER_STEP
    : next === null
      ? previous + AGENT_ORDER_STEP
      : Math.floor((previous + next) / 2);
  updates.set(target.id, order);
  return { updates };
}

export {
  AGENT_ORDER_STEP,
  AgentOrderAllocator,
  comparePinnedAgents,
  compareProjectAgents,
  finiteOrder,
  reorderedPinnedAgentOrders,
  reorderedProjectAgentOrders,
};
