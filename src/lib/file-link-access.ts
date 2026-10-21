/** One mounted transcript owns bounded, deduplicated background file checks. */
export type FileLinkAccessRequest = (rootId: string, paths: string[], signal: AbortSignal) => Promise<{ items: Array<{ path: string; accessible: boolean }> }>
interface Entry {
  rootId: string
  path: string
  value: boolean
  expires: number
  pending: boolean
  listeners: Set<(value: boolean) => void>
}
export class FileLinkAccess {
  private entries = new Map<string, Entry>()
  private timer?: ReturnType<typeof setTimeout>
  private controller?: AbortController
  private generation = 0
  constructor(private request: FileLinkAccessRequest) {}

  subscribe(rootId: string, path: string, listener: (value: boolean) => void) {
    const key = JSON.stringify([rootId, path])
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= 1024) {
        for (const [key, candidate] of this.entries) {
          if (!candidate.listeners.size && !candidate.pending) this.entries.delete(key)
        }
      }
      if (this.entries.size >= 1024 || path.length > 2048) {
        listener(false)
        return () => {}
      }
      entry = { rootId, path, value: false, expires: 0, pending: false, listeners: new Set() }
      this.entries.set(key, entry)
    }
    entry.listeners.add(listener)
    listener(entry.expires > Date.now() && entry.value)
    this.schedule()
    return () => {
      entry.listeners.delete(listener)
      if (![...this.entries.values()].some(candidate => candidate.listeners.size)) this.clear()
    }
  }

  private schedule() {
    if (this.timer || this.controller) return
    const active = [...this.entries.values()].filter(entry => entry.listeners.size)
    if (!active.length) return
    const delay = Math.max(16, Math.min(...active.map(entry => entry.expires - Date.now())))
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, delay)
  }

  private async flush() {
    const batch = [...this.entries.values()].filter(entry => entry.listeners.size && entry.expires <= Date.now())
    const rootId = batch[0]?.rootId
    if (!rootId) { this.schedule(); return }
    const selected = batch.filter(entry => entry.rootId === rootId).slice(0, 64)
    const controller = this.controller = new AbortController()
    const generation = this.generation
    for (const entry of selected) {
      entry.pending = true
      entry.value = false
      entry.listeners.forEach(listener => listener(false))
    }
    const timeout = setTimeout(() => controller.abort(), 2500)
    try {
      const result = await this.request(rootId, selected.map(entry => entry.path), controller.signal)
      if (generation !== this.generation || controller.signal.aborted) return
      const accessible = new Set(result.items.filter(item => item.accessible).map(item => item.path))
      selected.forEach(entry => { entry.value = accessible.has(entry.path) })
    } catch {
      // Failed validation never blocks output or promotes a speculative link.
    } finally {
      clearTimeout(timeout)
      if (generation === this.generation) {
        selected.forEach(entry => {
          entry.pending = false
          entry.expires = Date.now() + 10_000
          entry.listeners.forEach(listener => listener(entry.value))
        })
        this.controller = undefined
        this.schedule()
      }
    }
  }

  clear() {
    this.generation++
    clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.controller = undefined
    this.entries.clear()
  }
}
