const BUSINESS_HEALTH_RECOVERY_TIMEOUT_MS = 5_000;

function waitForRecovery(agentManager, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    agentManager.whenRecovered().then(() => {
      clearTimeout(timer);
      resolve('ready');
    }, () => {
      clearTimeout(timer);
      resolve('failed');
    });
  });
}

async function probeAgentManagerBusinessHealth(
  agentManager,
  { timeoutMs = BUSINESS_HEALTH_RECOVERY_TIMEOUT_MS } = {},
) {
  if (agentManager.disposed || agentManager.disposing) {
    return { status: 'stopping', agentCount: 0, mainAgentId: null };
  }

  try {
    const recovery = await waitForRecovery(agentManager, timeoutMs);
    if (recovery === 'timeout') {
      return { status: 'recovering', agentCount: 0, mainAgentId: null };
    }
    if (recovery === 'failed') {
      return { status: 'failed', agentCount: 0, mainAgentId: null };
    }

    const state = agentManager.getState();
    if (!state || !Array.isArray(state.agents)) {
      return { status: 'failed', agentCount: 0, mainAgentId: null };
    }
    return {
      status: 'ready',
      agentCount: state.agents.length,
      mainAgentId: typeof state.mainAgentId === 'string' ? state.mainAgentId : null,
    };
  } catch {
    return { status: 'failed', agentCount: 0, mainAgentId: null };
  }
}

module.exports = {
  BUSINESS_HEALTH_RECOVERY_TIMEOUT_MS,
  probeAgentManagerBusinessHealth,
};
