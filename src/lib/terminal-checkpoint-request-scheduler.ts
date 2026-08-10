export const TERMINAL_CHECKPOINT_MAX_CONCURRENT_REQUESTS = 3

interface TerminalCheckpointRequestWaiter {
  signal: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: DOMException) => void
  onAbort: () => void
}

/** Owns bounded browser-side admission for authoritative checkpoint reads. */
export class TerminalCheckpointRequestScheduler {
  #active = 0
  readonly #queue: TerminalCheckpointRequestWaiter[] = []

  constructor(
    readonly maxConcurrent = TERMINAL_CHECKPOINT_MAX_CONCURRENT_REQUESTS,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new Error('Terminal checkpoint concurrency must be a positive integer')
    }
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(this.#cancelled())

    return new Promise((resolve, reject) => {
      const waiter: TerminalCheckpointRequestWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#queue.indexOf(waiter)
          if (index < 0) return
          this.#queue.splice(index, 1)
          reject(this.#cancelled())
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.#queue.push(waiter)
      this.#drain()
    })
  }

  #drain() {
    while (this.#active < this.maxConcurrent && this.#queue.length > 0) {
      const waiter = this.#queue.shift()
      if (!waiter) return
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(this.#cancelled())
        continue
      }

      this.#active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.#active = Math.max(0, this.#active - 1)
        this.#drain()
      })
    }
  }

  #cancelled() {
    return new DOMException('Terminal checkpoint request was cancelled', 'AbortError')
  }
}
