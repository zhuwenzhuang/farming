'use strict';

type RecoveryState = 'complete' | 'pending' | 'failed';

class AgentRecoveryGate {
  private completion: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private state: RecoveryState = 'complete';

  isComplete(): boolean {
    return this.state === 'complete';
  }

  start(operation: () => Promise<void>, onFailure?: (error: unknown) => void): void {
    this.state = 'pending';
    this.failure = null;
    this.completion = Promise.resolve()
      .then(operation)
      .then(() => {
        this.state = 'complete';
      })
      .catch((error: unknown) => {
        this.failure = error;
        this.state = 'failed';
        onFailure?.(error);
      });
  }

  settled(): Promise<void> {
    return this.completion;
  }

  async wait(): Promise<void> {
    await this.completion;
    if (!this.failure) return;
    const message = this.failure instanceof Error
      ? this.failure.message
      : String(this.failure);
    throw new Error(
      `Agent lifecycle recovery failed: ${message}`,
      { cause: this.failure },
    );
  }
}

export { AgentRecoveryGate };
