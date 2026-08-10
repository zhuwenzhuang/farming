'use strict';

class AgentRuntimeStopTracker {
  private readonly verifiedStopped = new Set<string>();
  private readonly exitEventSuppressions = new Set<string>();

  isVerifiedStopped(agentId: string): boolean {
    return this.verifiedStopped.has(agentId);
  }

  markVerifiedStopped(agentId: string): void {
    this.verifiedStopped.add(agentId);
  }

  suppressExitEvents(agentId: string): () => void {
    this.exitEventSuppressions.add(agentId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.exitEventSuppressions.delete(agentId);
    };
  }

  exitEventsSuppressed(agentId: string): boolean {
    return this.exitEventSuppressions.has(agentId);
  }

  forget(agentId: string): void {
    this.verifiedStopped.delete(agentId);
    this.exitEventSuppressions.delete(agentId);
  }

  clear(): void {
    this.verifiedStopped.clear();
    this.exitEventSuppressions.clear();
  }
}

export { AgentRuntimeStopTracker };
