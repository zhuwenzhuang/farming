'use strict';

type AgentHeartbeatTick = {
  sweepZombies: boolean;
};

type AgentHeartbeatSchedulerOptions = {
  intervalMs: number;
  onTick: (tick: AgentHeartbeatTick) => Promise<void> | void;
  zombieSweepIntervalMs: number;
};

class AgentHeartbeatScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastZombieSweepAt = 0;
  private readonly options: AgentHeartbeatSchedulerOptions;

  constructor(options: AgentHeartbeatSchedulerOptions) {
    this.options = options;
  }

  isRunning(): boolean {
    return this.interval !== null;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.runOnce(Date.now());
    }, this.options.intervalMs);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async runOnce(now = Date.now()): Promise<void> {
    const sweepZombies = now - this.lastZombieSweepAt >= this.options.zombieSweepIntervalMs;
    if (sweepZombies) this.lastZombieSweepAt = now;
    await this.options.onTick({ sweepZombies });
  }
}

export { AgentHeartbeatScheduler, type AgentHeartbeatTick };
