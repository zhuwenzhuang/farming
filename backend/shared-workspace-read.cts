// Consumers share execution, not cancellation ownership. Even a cancelled
// consumer waits for physical completion before returning its admission slot.
export class SharedWorkspaceRead<T> {
  readonly controller = new AbortController();
  readonly promise: Promise<T>;
  private consumers = 0;
  constructor(load: (signal: AbortSignal) => Promise<T>) {
    this.promise = Promise.resolve().then(() => load(this.controller.signal));
  }
  join(signal?: AbortSignal): Promise<T> {
    this.consumers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--this.consumers === 0) this.controller.abort();
    };
    signal?.addEventListener('abort', release, { once: true });
    if (signal?.aborted) release();
    return this.promise.then(value => { signal?.throwIfAborted(); return value; }).finally(() => {
      signal?.removeEventListener('abort', release);
      release();
    });
  }
}
