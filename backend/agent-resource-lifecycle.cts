interface AgentResourceLifecycleManager<AgentState> {
  reconcileAgentLifecycle(agentStates: AgentState[]): Promise<void>;
}

export async function reconcileAgentOwnedResources<AgentState>(
  readAgentStates: () => AgentState[],
  browser: AgentResourceLifecycleManager<AgentState>,
  computer: AgentResourceLifecycleManager<AgentState>,
): Promise<void> {
  const errors: string[] = [];
  // Browser cleanup releases Desktop leases before Computer cleanup. Each
  // manager needs the Agent state current when its own reconciliation starts.
  for (const [name, manager] of [['Browser', browser], ['Computer', computer]] as const) {
    try {
      await manager.reconcileAgentLifecycle(readAgentStates());
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
}
