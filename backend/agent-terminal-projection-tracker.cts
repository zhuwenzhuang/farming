'use strict';

class AgentTerminalProjectionTracker<Agent extends object, Status> {
  private readonly statuses = new WeakMap<Agent, Status>();
  private readonly providerProfiles = new WeakMap<Agent, object | null>();

  previousStatus(agent: Agent, fallback: () => Status): Status {
    return this.statuses.get(agent) || fallback();
  }

  previousProviderProfile(agent: Agent, fallback: () => object | null): object | null {
    return this.providerProfiles.has(agent)
      ? this.providerProfiles.get(agent) ?? null
      : fallback();
  }

  update(agent: Agent, status: Status, providerProfile: object | null): void {
    this.statuses.set(agent, status);
    this.providerProfiles.set(agent, providerProfile);
  }

  updateStatus(agent: Agent, status: Status): void {
    this.statuses.set(agent, status);
  }
}

export { AgentTerminalProjectionTracker };
