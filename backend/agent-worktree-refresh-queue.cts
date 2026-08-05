interface AgentWorktreeRefreshTask {
  rejecters: Array<(error: unknown) => void>;
  resolvers: Array<(changed: boolean) => void>;
  run: () => Promise<boolean>;
}

class AgentWorktreeRefreshQueue {
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly order: string[] = [];
  private orderOffset = 0;
  private readonly pending = new Map<string, AgentWorktreeRefreshTask>();

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new TypeError('Agent Worktree refresh concurrency must be a positive integer');
    }
    this.maxConcurrent = maxConcurrent;
  }

  enqueue(agentId: string, run: () => Promise<boolean>): Promise<boolean> {
    if (!agentId || typeof run !== 'function') {
      return Promise.reject(new TypeError('Agent Worktree refresh requires an Agent id and task'));
    }
    return new Promise<boolean>((resolve, reject) => {
      const existing = this.pending.get(agentId);
      if (existing) {
        existing.run = run;
        existing.resolvers.push(resolve);
        existing.rejecters.push(reject);
      } else {
        this.pending.set(agentId, {
          run,
          resolvers: [resolve],
          rejecters: [reject],
        });
        this.order.push(agentId);
      }
      this.drain();
    });
  }

  cancelPending(agentId: string): boolean {
    const task = this.pending.get(agentId);
    if (!task) return false;
    this.pending.delete(agentId);
    task.resolvers.forEach(resolve => resolve(false));
    return true;
  }

  cancelAllPending(): void {
    this.pending.forEach(task => {
      task.resolvers.forEach(resolve => resolve(false));
    });
    this.pending.clear();
    this.order.length = 0;
    this.orderOffset = 0;
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.orderOffset < this.order.length) {
      const agentId = this.order[this.orderOffset];
      this.order[this.orderOffset] = '';
      this.orderOffset += 1;
      if (!agentId) continue;
      const task = this.pending.get(agentId);
      if (!task) continue;
      this.pending.delete(agentId);
      this.active += 1;
      void Promise.resolve()
        .then(task.run)
        .then(
          changed => task.resolvers.forEach(resolve => resolve(changed)),
          error => task.rejecters.forEach(reject => reject(error)),
        )
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
    if (this.orderOffset === this.order.length) {
      this.order.length = 0;
      this.orderOffset = 0;
    } else if (this.orderOffset >= 1024 && this.orderOffset * 2 >= this.order.length) {
      this.order.splice(0, this.orderOffset);
      this.orderOffset = 0;
    }
  }
}

export {
  AgentWorktreeRefreshQueue,
};
