export type TerminalSessionRegistryEntry<Value> = Value | Promise<Value>

/**
 * Owns the identity fence around terminal-session bootstrap.
 *
 * A pending bootstrap is an entry in its own right.  Settlement may replace or
 * remove that entry only while it is still the exact entry for its key; a
 * destroy/recreate cycle must never be overwritten by an older promise.
 */
export class TerminalSessionRegistry<Key, Value> {
  private readonly entries = new Map<Key, TerminalSessionRegistryEntry<Value>>()

  get(key: Key) {
    return this.entries.get(key)
  }

  getOrCreate(
    key: Key,
    factory: () => Value | Promise<Value>,
    onCreateError?: (error: Error) => void,
  ) {
    if (this.entries.has(key)) {
      const current = this.entries.get(key) as TerminalSessionRegistryEntry<Value>
      return current instanceof Promise ? current : Promise.resolve(current)
    }

    let resolvePending!: (value: Value | PromiseLike<Value>) => void
    let rejectPending!: (reason?: unknown) => void
    const pending = new Promise<Value>((resolve, reject) => {
      resolvePending = resolve
      rejectPending = reject
    })
    this.entries.set(key, pending)

    pending.then(
      value => {
        if (this.isCurrent(key, pending)) this.entries.set(key, value)
      },
      reason => {
        if (this.isCurrent(key, pending)) this.entries.delete(key)
        try {
          onCreateError?.(reason instanceof Error ? reason : new Error(String(reason)))
        } catch {
          // Error reporting must not create a second unhandled rejection for
          // every caller sharing this pending bootstrap.
        }
      },
    )

    try {
      resolvePending(factory())
    } catch (error) {
      rejectPending(error)
    }
    return pending
  }

  /** Atomically removes and returns the current value or bootstrap promise. */
  take(key: Key) {
    if (!this.entries.has(key)) return undefined
    const current = this.entries.get(key) as TerminalSessionRegistryEntry<Value>
    this.entries.delete(key)
    return current
  }

  isCurrent(key: Key, value: TerminalSessionRegistryEntry<Value>) {
    return this.entries.get(key) === value
  }

  keys() {
    return this.entries.keys()
  }

  values() {
    return this.entries.values()
  }

  forEach(callback: (value: TerminalSessionRegistryEntry<Value>, key: Key) => void) {
    this.entries.forEach((value, key) => callback(value, key))
  }
}
