/** One transcript owner retains bounded evidence for inferred file references.
 * Confirmation establishes a reference, not current access; opening rechecks access.
 */
export type FileLinkAccessRequest = (rootId: string, paths: string[], signal: AbortSignal) => Promise<{ items: Array<{ path: string; accessible: boolean }> }>
interface Entry {
  rootId: string
  path: string
  state: 'queued' | 'checking' | 'confirmed' | 'unconfirmed'
  listeners: Set<(value: boolean) => void>
}
export class FileLinkAccess {
  private entries = new Map<string, Entry>()
  private timer?: ReturnType<typeof setTimeout>
  private controller?: AbortController
  private generation = 0
  constructor(private request: FileLinkAccessRequest) {}

  isConfirmed(rootId: string, path: string) {
    return this.entries.get(JSON.stringify([rootId, path]))?.state === 'confirmed'
  }

  subscribe(rootId: string, path: string, listener: (value: boolean) => void) {
    const key = JSON.stringify([rootId, path])
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= 1024) {
        for (const [key, candidate] of this.entries) {
          if (!candidate.listeners.size && candidate.state !== 'checking') this.entries.delete(key)
        }
      }
      if (this.entries.size >= 1024 || path.length > 2048) {
        listener(false)
        return () => {}
      }
      entry = { rootId, path, state: 'queued', listeners: new Set() }
      this.entries.set(key, entry)
    }
    // Re-entering the view may retry an unconfirmed candidate, without polling.
    if (!entry.listeners.size && entry.state === 'unconfirmed') entry.state = 'queued'
    entry.listeners.add(listener)
    listener(entry.state === 'confirmed')
    this.schedule()
    return () => {
      entry.listeners.delete(listener)
      if (![...this.entries.values()].some(candidate => candidate.listeners.size)) this.cancel()
    }
  }

  private schedule() {
    if (this.timer || this.controller) return
    if (![...this.entries.values()].some(entry => entry.listeners.size && entry.state === 'queued')) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 16)
  }

  private async flush() {
    const batch = [...this.entries.values()].filter(entry => entry.listeners.size && entry.state === 'queued')
    const rootId = batch[0]?.rootId
    if (!rootId) { this.schedule(); return }
    const selected = batch.filter(entry => entry.rootId === rootId).slice(0, 64)
    const controller = this.controller = new AbortController()
    const generation = this.generation
    for (const entry of selected) entry.state = 'checking'
    let onAbort = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('File reference check cancelled'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timeout = setTimeout(() => controller.abort(), 2500)
    try {
      const result = await Promise.race([
        this.request(rootId, selected.map(entry => entry.path), controller.signal),
        aborted,
      ])
      if (generation !== this.generation || controller.signal.aborted) return
      const accessible = new Set(result.items.filter(item => item.accessible).map(item => item.path))
      selected.forEach(entry => { entry.state = accessible.has(entry.path) ? 'confirmed' : 'unconfirmed' })
    } catch {
      // A failed or incomplete check is no evidence, not proof of absence.
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      if (generation === this.generation) {
        selected.forEach(entry => {
          if (entry.state === 'checking') entry.state = 'unconfirmed'
          entry.listeners.forEach(listener => listener(entry.state === 'confirmed'))
        })
        this.controller = undefined
        this.schedule()
      }
    }
  }

  private cancel() {
    this.generation++
    clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.controller = undefined
    for (const entry of this.entries.values()) {
      if (entry.state === 'checking') entry.state = 'queued'
    }
  }

  clear() {
    this.cancel()
    this.entries.clear()
  }
}
