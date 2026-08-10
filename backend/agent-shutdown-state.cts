'use strict';

type ShutdownPhase = 'active' | 'disposing' | 'frozen' | 'disposed';

class AgentShutdownState {
  private activeDispose: Promise<void> | null = null;
  private phase: ShutdownPhase = 'active';

  isDisposed(): boolean {
    return this.phase === 'disposed';
  }

  isShuttingDown(): boolean {
    return this.phase !== 'active';
  }

  freeze(): void {
    if (this.phase !== 'disposed') this.phase = 'frozen';
  }

  complete(): void {
    this.phase = 'disposed';
  }

  run(operation: () => Promise<void>): Promise<void> {
    if (this.phase === 'disposed') return Promise.resolve();
    if (this.activeDispose) return this.activeDispose;

    if (this.phase === 'active') this.phase = 'disposing';
    const dispose = Promise.resolve().then(operation);
    this.activeDispose = dispose;
    void dispose.finally(() => {
      if (this.activeDispose === dispose) this.activeDispose = null;
      if (this.phase === 'disposing') this.phase = 'active';
    }).catch(() => {});
    return dispose;
  }
}

export { AgentShutdownState };
