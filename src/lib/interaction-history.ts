const GUARD_KEY = '__farmingInteractionGuard'

interface Guard {
  owner: string
  original: unknown
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function guard(state: unknown): Guard | null {
  if (!record(state)) return null
  const value = state[GUARD_KEY]
  return record(value) && typeof value.owner === 'string' && 'original' in value
    ? { owner: value.owner, original: value.original } : null
}

function withoutGuard(state: unknown): unknown {
  const entry = guard(state)
  if (!entry || !record(state)) return state
  const rest = { ...state }
  delete rest[GUARD_KEY]
  // Object state remains writable by the URL/navigation owner while armed.
  return record(entry.original) || Object.keys(rest).length ? rest : entry.original
}

export interface InteractionHistoryPort {
  read: () => { state: unknown; url: string }
  push: (state: unknown, url: string) => void
  replace: (state: unknown, url: string) => void
  back: () => void
  defer: (action: () => void) => void
  timeout: (action: () => void) => () => void
  report: (error: unknown) => void
}

/**
 * One guard per visible interaction stack. Cleanup traversals and user Back
 * are different transitions: a delayed cleanup must never dismiss a new layer.
 * This bridge does not serialize UI state into browser history.
 */
export class InteractionHistory {
  private phase: 'idle' | 'armed' | 'removing' | 'failed' = 'idle'
  private snapshot: { state: unknown; url: string } | null = null
  private cancelTimeout: (() => void) | null = null

  constructor(
    private readonly port: InteractionHistoryPort,
    private readonly owner: string,
    private readonly hasLayer: () => boolean,
    private readonly dismissTop: () => void,
  ) {}

  replace(state: unknown, url: string) {
    // Navigation owns URL/state changes, including while a guard traversal is
    // pending. Observe the write at its boundary, not from a later render.
    const marker = guard(this.port.read().state)
    const next = withoutGuard(state)
    this.port.replace(marker ? {
      ...(record(next) ? next : {}),
      [GUARD_KEY]: { owner: marker.owner, original: next },
    } : next, url)
    if (this.snapshot) {
      const current = this.port.read()
      this.snapshot = { state: withoutGuard(current.state), url: current.url }
    }
  }

  sync() {
    if (this.phase === 'failed' || this.phase === 'removing') return
    try {
      const current = this.port.read()
      const marker = guard(current.state)
      if (this.phase === 'armed' && marker?.owner === this.owner) {
        this.snapshot = { state: withoutGuard(current.state), url: current.url }
        if (!this.hasLayer()) this.removeGuard()
        return
      }
      if (marker) {
        // Forward or reload reached an obsolete guard. It is not a UI command.
        this.snapshot = { state: withoutGuard(current.state), url: current.url }
        this.removeGuard()
        return
      }
      this.phase = 'idle'
      if (!this.hasLayer()) return
      this.snapshot = current
      this.port.push({
        ...(record(current.state) ? current.state : {}),
        [GUARD_KEY]: { owner: this.owner, original: current.state },
      }, current.url)
      this.phase = 'armed'
    } catch (error) {
      this.fail(error)
    }
  }

  pop() {
    // If arming failed, we never acquired a guard. Ordinary navigation must
    // not be rewritten as though it were an uncertain cleanup traversal.
    if (this.phase === 'failed' && !this.snapshot) return
    this.cancelTimeout?.()
    this.cancelTimeout = null
    try {
      const current = this.port.read()
      if (guard(current.state)) {
        // Never revive old layers on Forward, including after a page reload.
        this.phase = 'idle'
        this.sync()
        return
      }
      const phase = this.phase
      this.phase = 'idle'
      if (this.snapshot && (phase === 'armed' || phase === 'removing' || phase === 'failed')) {
        this.port.replace(this.snapshot.state, this.snapshot.url)
      }
      this.snapshot = null
      if (phase === 'armed') this.dismissTop()
      // React commits dismissal / nested-step changes before rearming.
      this.port.defer(() => this.sync())
    } catch (error) {
      this.fail(error)
    }
  }

  private removeGuard() {
    this.phase = 'removing'
    this.cancelTimeout = this.port.timeout(() => {
      this.cancelTimeout = null
      this.fail(new Error('Browser Back cleanup did not settle; no traversal was retried. Use the visible Close control.'))
    })
    this.port.back()
  }

  private fail(error: unknown) {
    this.cancelTimeout?.()
    this.cancelTimeout = null
    if (this.phase !== 'removing') this.snapshot = null
    this.phase = 'failed'
    this.port.report(error)
  }
}
