'use strict';

class TerminalProviderControlCoordinator {
  private readonly identityAttempts = new Map<string, string>();
  private readonly identityPromises = new Map<string, Promise<boolean>>();
  private readonly profileMutations = new Map<string, Promise<unknown>>();

  resolveIdentityOnce(
    agentId: string,
    attemptKey: string,
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    if (this.identityAttempts.get(agentId) === attemptKey) {
      return this.identityPromises.get(agentId) || Promise.resolve(false);
    }
    this.identityAttempts.set(agentId, attemptKey);
    const promise = operation();
    this.identityPromises.set(agentId, promise);
    void promise.finally(() => {
      if (this.identityPromises.get(agentId) === promise) {
        this.identityPromises.delete(agentId);
      }
    }).catch(() => {});
    return promise;
  }

  resetIdentityAttempt(agentId: string, attemptKey: string): void {
    if (this.identityAttempts.get(agentId) === attemptKey) {
      this.identityAttempts.delete(agentId);
    }
  }

  runProfileMutation<Result>(agentId: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.profileMutations.get(agentId);
    const next = previous
      ? previous.catch(() => {}).then(operation)
      : operation();
    this.profileMutations.set(agentId, next);
    void next.finally(() => {
      if (this.profileMutations.get(agentId) === next) {
        this.profileMutations.delete(agentId);
      }
    }).catch(() => {});
    return next;
  }

  pendingOperations(): Promise<unknown>[] {
    return [...new Set([
      ...this.identityPromises.values(),
      ...this.profileMutations.values(),
    ])];
  }

  forget(agentId: string): void {
    this.identityAttempts.delete(agentId);
    this.identityPromises.delete(agentId);
  }

  clear(): void {
    this.identityAttempts.clear();
    this.identityPromises.clear();
    this.profileMutations.clear();
  }
}

export { TerminalProviderControlCoordinator };
