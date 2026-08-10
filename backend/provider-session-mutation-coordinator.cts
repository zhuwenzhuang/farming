'use strict';

type ProviderSessionMutationEntry<Result> = {
  promise: Promise<Result>;
  type: string;
};

type ProviderSessionMutationRequest<Result> = {
  homeId?: string;
  joinSameType?: boolean;
  operation: () => Result | Promise<Result>;
  provider: string;
  sessionId: string;
  type: string;
};

class ProviderSessionMutationCoordinator {
  private readonly queues = new Map<string, ProviderSessionMutationEntry<unknown>>();

  run<Result>(request: ProviderSessionMutationRequest<Result>): Promise<Result> {
    const homeId = String(request.homeId || 'default').trim() || 'default';
    const key = JSON.stringify([request.provider, homeId, request.sessionId]);
    const current = this.queues.get(key) as ProviderSessionMutationEntry<Result> | undefined;
    if (request.joinSameType === true && current?.type === request.type) {
      return current.promise;
    }

    const previous = current?.promise || Promise.resolve();
    const next = previous.catch(() => {}).then(request.operation);
    const entry: ProviderSessionMutationEntry<Result> = {
      type: request.type,
      promise: next,
    };
    this.queues.set(key, entry);
    void next.finally(() => {
      if (this.queues.get(key) === entry) this.queues.delete(key);
    }).catch(() => {});
    return next;
  }

  pendingOperations(): Promise<unknown>[] {
    return [...this.queues.values()].map(entry => entry.promise);
  }

  clear(): void {
    this.queues.clear();
  }
}

export {
  ProviderSessionMutationCoordinator,
  type ProviderSessionMutationRequest,
};
