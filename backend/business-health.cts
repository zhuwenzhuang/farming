'use strict';

const BUSINESS_HEALTH_RECOVERY_TIMEOUT_MS = 5_000;

type BusinessHealthStatus = 'ready' | 'recovering' | 'failed' | 'stopping';

interface AgentManagerHealthState {
  agents: unknown[];
  mainAgentId?: unknown;
}

interface AgentManagerHealthSource {
  disposed?: boolean;
  disposing?: boolean;
  getState(): AgentManagerHealthState | null;
  recoveryGate: {
    wait(): Promise<unknown>;
  };
}

interface BusinessHealthResult {
  status: BusinessHealthStatus;
  agentCount: number;
  mainAgentId: string | null;
}

function waitForRecovery(
  agentManager: AgentManagerHealthSource,
  timeoutMs: number,
): Promise<'ready' | 'failed' | 'timeout'> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    agentManager.recoveryGate.wait().then(() => {
      clearTimeout(timer);
      resolve('ready');
    }, () => {
      clearTimeout(timer);
      resolve('failed');
    });
  });
}

async function probeAgentManagerBusinessHealth(
  agentManager: AgentManagerHealthSource,
  { timeoutMs = BUSINESS_HEALTH_RECOVERY_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<BusinessHealthResult> {
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

export {
  BUSINESS_HEALTH_RECOVERY_TIMEOUT_MS,
  probeAgentManagerBusinessHealth,
};
