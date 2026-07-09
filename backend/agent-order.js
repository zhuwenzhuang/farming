const AGENT_ORDER_STEP = 1024;

function finiteOrder(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function agentWorkspace(agent) {
  return String(agent && (agent.projectWorkspace || agent.cwd) || '');
}

function projectOrder(agent) {
  return finiteOrder(agent && agent.projectOrder) ?? 0;
}

function pinnedOrder(agent) {
  return finiteOrder(agent && agent.pinnedOrder) ?? 0;
}

function compareProjectAgents(left, right) {
  return projectOrder(right) - projectOrder(left)
    || (Number(right && right.startedAt) || 0) - (Number(left && left.startedAt) || 0)
    || String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function comparePinnedAgents(left, right) {
  return pinnedOrder(left) - pinnedOrder(right)
    || (Number(left && left.startedAt) || 0) - (Number(right && right.startedAt) || 0)
    || String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function nextProjectOrder(agents, workspace) {
  return Math.max(0, ...agents
    .filter(agent => agentWorkspace(agent) === workspace)
    .map(projectOrder)) + AGENT_ORDER_STEP;
}

function nextPinnedOrder(agents) {
  return Math.max(0, ...agents.filter(agent => agent && agent.pinned === true).map(pinnedOrder)) + AGENT_ORDER_STEP;
}

function ensureAgentOrders(agent, agents) {
  if (finiteOrder(agent.projectOrder) === null) {
    agent.projectOrder = nextProjectOrder(agents, agentWorkspace(agent));
  }
  if (agent.pinned === true && finiteOrder(agent.pinnedOrder) === null) {
    agent.pinnedOrder = nextPinnedOrder(agents);
  }
  return agent;
}

function projectAgents(agents, workspace, excludedAgentId = '') {
  return agents
    .filter(agent => agent && agent.id !== excludedAgentId && agentWorkspace(agent) === workspace)
    .sort(compareProjectAgents);
}

function reorderedProjectAgentOrders(agents, agentId, beforeAgentId = '', afterAgentId = '') {
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

  const updates = new Map();
  const orderAt = index => finiteOrder(fullOrder[index] && fullOrder[index].projectOrder) ?? 0;
  let upper = fullInsertIndex > 0 ? orderAt(fullInsertIndex - 1) : null;
  let lower = fullInsertIndex < fullOrder.length ? orderAt(fullInsertIndex) : null;
  if (upper !== null && lower !== null && upper - lower <= 1) {
    fullOrder.forEach((agent, index) => {
      const order = (fullOrder.length - index) * AGENT_ORDER_STEP;
      if (projectOrder(agent) !== order) updates.set(agent.id, order);
      agent.projectOrder = order;
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

function reorderedPinnedAgentOrders(agents, agentId, beforeAgentId = '', afterAgentId = '') {
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

  const updates = new Map();
  const orderAt = index => finiteOrder(pinned[index] && pinned[index].pinnedOrder) ?? 0;
  let previous = insertIndex > 0 ? orderAt(insertIndex - 1) : null;
  let next = insertIndex < pinned.length ? orderAt(insertIndex) : null;
  if (previous !== null && next !== null && next - previous <= 1) {
    pinned.forEach((agent, index) => {
      const order = (index + 1) * AGENT_ORDER_STEP;
      if (pinnedOrder(agent) !== order) updates.set(agent.id, order);
      agent.pinnedOrder = order;
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

module.exports = {
  AGENT_ORDER_STEP,
  comparePinnedAgents,
  compareProjectAgents,
  ensureAgentOrders,
  finiteOrder,
  nextPinnedOrder,
  nextProjectOrder,
  reorderedPinnedAgentOrders,
  reorderedProjectAgentOrders,
};
