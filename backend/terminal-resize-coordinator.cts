interface TerminalSize {
  cols: number;
  rows: number;
}

interface TerminalResizeCoordinatorOptions {
  isShuttingDown: () => boolean;
  resize: (agentId: string, size: TerminalSize) => Promise<unknown>;
}

/** Owns latest-value coalescing and one active resize drain per Agent. */
class TerminalResizeCoordinator {
  readonly #drains = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, TerminalSize>();
  readonly #isShuttingDown: () => boolean;
  readonly #resize: TerminalResizeCoordinatorOptions['resize'];

  constructor({ isShuttingDown, resize }: TerminalResizeCoordinatorOptions) {
    this.#isShuttingDown = isShuttingDown;
    this.#resize = resize;
  }

  request(agentId: string, cols: number, rows: number): boolean {
    if (this.#isShuttingDown()) return false;
    this.#pending.set(agentId, { cols, rows });
    if (this.#drains.has(agentId)) return true;

    const drain = (async () => {
      while (this.#pending.has(agentId)) {
        const next = this.#pending.get(agentId);
        this.#pending.delete(agentId);
        if (next) await this.#resize(agentId, next);
      }
    })().finally(() => {
      this.#drains.delete(agentId);
    });
    this.#drains.set(agentId, drain);
    return true;
  }

  pendingOperations(): ReadonlySet<Promise<void>> {
    return new Set(this.#drains.values());
  }

  dispose(): void {
    this.#pending.clear();
    this.#drains.clear();
  }
}

export {
  TerminalResizeCoordinator,
  type TerminalResizeCoordinatorOptions,
  type TerminalSize,
};
