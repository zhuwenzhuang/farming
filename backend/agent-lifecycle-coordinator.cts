'use strict';

type AgentLifecycleEntry<Result = unknown> = {
  agentIds: Set<string>;
  key: string;
  kind: string;
  label: string;
  promise: Promise<Result>;
  token: symbol;
};

type AgentLifecycleOperation<Result> = (token: symbol) => Result;

class AgentLifecycleCoordinator {
  private readonly isShuttingDown: () => boolean;
  private readonly operations = new Map<string, AgentLifecycleEntry<unknown>>();

  constructor(options: { isShuttingDown: () => boolean }) {
    this.isShuttingDown = options.isShuttingDown;
  }

  get(agentId: string): AgentLifecycleEntry<unknown> | undefined {
    return this.operations.get(agentId);
  }

  has(agentId: string): boolean {
    return this.operations.has(agentId);
  }

  hasToken(token: symbol | undefined): boolean {
    return Boolean(token && this.uniqueEntries().some(entry => entry.token === token));
  }

  pendingOperations(): Promise<unknown>[] {
    return this.uniqueEntries().map(entry => entry.promise);
  }

  run<Result>(
    agentId: string,
    key: string,
    kind: string,
    label: string,
    operation: AgentLifecycleOperation<Result>,
    sameKindConflictError = '',
  ): Promise<Awaited<Result> | { error: string }> {
    const inFlight = this.operations.get(agentId) as AgentLifecycleEntry<Awaited<Result>> | undefined;
    if (inFlight) {
      if (inFlight.key === key) return inFlight.promise;
      if (sameKindConflictError && inFlight.kind === kind) {
        return Promise.resolve({ error: sameKindConflictError });
      }
      return inFlight.promise
        .catch(() => {})
        .then(() => this.run(
          agentId,
          key,
          kind,
          label,
          operation,
          sameKindConflictError,
        ));
    }
    if (this.isShuttingDown()) {
      return Promise.resolve({ error: 'Farming is shutting down; Agent lifecycle changes are not accepted' });
    }

    const token = Symbol(key);
    const promise = Promise.resolve().then(() => operation(token)) as Promise<Awaited<Result>>;
    const entry: AgentLifecycleEntry<Awaited<Result>> = {
      key,
      kind,
      label,
      token,
      promise,
      agentIds: new Set([agentId]),
    };
    this.operations.set(agentId, entry);
    void promise.finally(() => this.release(entry)).catch(() => {});
    return promise;
  }

  async whenIdle(agentId: string): Promise<void> {
    while (true) {
      const inFlight = this.operations.get(agentId);
      if (!inFlight) return;
      await inFlight.promise.catch(() => {});
    }
  }

  beginStart(agentId: string, allowDuringShutdown: boolean): (() => void) | null {
    if (this.operations.has(agentId)) return null;
    if (this.isShuttingDown() && !allowDuringShutdown) return null;
    let resolveCompletion!: (value: unknown) => void;
    const promise = new Promise<unknown>(resolve => {
      resolveCompletion = resolve;
    });
    const entry: AgentLifecycleEntry<unknown> = {
      key: 'start',
      kind: 'start',
      label: 'start',
      token: Symbol('start'),
      promise,
      agentIds: new Set([agentId]),
    };
    this.operations.set(agentId, entry);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.release(entry);
      resolveCompletion({ agentId, started: true });
    };
  }

  adopt(agentId: string, token: symbol | undefined): boolean {
    if (!token) return false;
    const entry = this.uniqueEntries().find(candidate => candidate.token === token);
    if (!entry) return false;
    const existing = this.operations.get(agentId);
    if (existing && existing !== entry) return false;
    entry.agentIds.add(agentId);
    this.operations.set(agentId, entry);
    return true;
  }

  clear(): void {
    this.operations.clear();
  }

  private uniqueEntries(): AgentLifecycleEntry<unknown>[] {
    return [...new Set(this.operations.values())];
  }

  private release(entry: AgentLifecycleEntry<unknown>): void {
    for (const agentId of entry.agentIds) {
      if (this.operations.get(agentId) === entry) this.operations.delete(agentId);
    }
  }
}

export {
  AgentLifecycleCoordinator,
  type AgentLifecycleEntry,
};
