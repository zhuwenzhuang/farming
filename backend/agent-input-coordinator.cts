type InputOperation<Result> = () => Result | Promise<Result>;
type ReleasedInputOperation<Result> = (releaseInput: () => void) => Result | Promise<Result>;

interface AgentInputCoordinatorOptions {
  isShuttingDown: () => boolean;
}

interface InputQueueOptions {
  admitted?: boolean;
}

/** Owns per-Agent input ordering and the accepted-operation drain set. */
class AgentInputCoordinator {
  readonly #active = new Set<Promise<unknown>>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #isShuttingDown: () => boolean;

  constructor({ isShuttingDown }: AgentInputCoordinatorOptions) {
    this.#isShuttingDown = isShuttingDown;
  }

  async enqueue<Result>(
    agentId: string,
    operation: InputOperation<Result>,
    options: InputQueueOptions = {},
  ): Promise<Result> {
    this.#assertAccepted(options.admitted === true);
    const previous = this.#queues.get(agentId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.#queues.set(agentId, next);
    this.#track(next);
    try {
      return await next;
    } finally {
      if (this.#queues.get(agentId) === next) this.#queues.delete(agentId);
    }
  }

  async enqueueUntilReleased<Result>(
    agentId: string,
    operation: ReleasedInputOperation<Result>,
  ): Promise<Result> {
    this.#assertAccepted(false);
    const previous = this.#queues.get(agentId) || Promise.resolve();
    let released = false;
    let resolveReleased!: () => void;
    const releasedPromise = new Promise<void>(resolve => {
      resolveReleased = resolve;
    });
    const release = () => {
      if (released) return;
      released = true;
      resolveReleased();
    };

    const ready = previous.catch(() => {});
    const completion = ready.then(() => operation(release));
    this.#track(completion);
    completion.catch(() => release());
    const boundary = ready.then(() => releasedPromise);
    this.#queues.set(agentId, boundary);
    boundary.then(() => {
      if (this.#queues.get(agentId) === boundary) this.#queues.delete(agentId);
    });
    return completion;
  }

  pendingOperations(): ReadonlySet<Promise<unknown>> {
    return new Set(this.#active);
  }

  dispose(): void {
    this.#active.clear();
    this.#queues.clear();
  }

  #assertAccepted(admitted: boolean): void {
    if (this.#isShuttingDown() && !admitted) {
      throw new Error('Farming is shutting down; Agent input is not accepted');
    }
  }

  #track<Result>(operation: Promise<Result>): void {
    this.#active.add(operation);
    void operation.finally(() => {
      this.#active.delete(operation);
    }).catch(() => {});
  }
}

export {
  AgentInputCoordinator,
  type AgentInputCoordinatorOptions,
  type InputOperation,
  type InputQueueOptions,
  type ReleasedInputOperation,
};
