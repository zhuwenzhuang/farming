type DesktopStartupResourceCleanup = () => void | Promise<void>

interface DesktopStartupResource {
  cleanup: DesktopStartupResourceCleanup
  cleaned: boolean
  name: string
}

type DesktopStartupOwnerPhase = 'active' | 'stopping' | 'stopped'

export class DesktopStartupCancelledError extends Error {
  readonly code = 'FARMING_DESKTOP_STARTUP_CANCELLED'

  constructor(message = 'Farming Desktop startup was cancelled.') {
    super(message)
    this.name = 'DesktopStartupCancelledError'
  }
}

/**
 * Owns every resource created by the asynchronous desktop startup pipeline.
 * Ownership is registered synchronously before the next await, so stop() also
 * covers resources that are still completing an asynchronous start/listen.
 */
export class DesktopStartupResourceOwner {
  private readonly abortController = new AbortController()
  private readonly resources: DesktopStartupResource[] = []
  private phase: DesktopStartupOwnerPhase = 'active'
  private stopPromise: Promise<void> | null = null

  get signal() {
    return this.abortController.signal
  }

  guard() {
    if (this.phase !== 'active' || this.signal.aborted) {
      throw new DesktopStartupCancelledError()
    }
  }

  own(name: string, cleanup: DesktopStartupResourceCleanup) {
    this.guard()
    this.resources.push({ cleanup, cleaned: false, name })
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    if (this.phase === 'stopped') return Promise.resolve()
    this.phase = 'stopping'
    this.abortController.abort()
    this.stopPromise = (async () => {
      const cleanupErrors: Error[] = []
      for (const resource of [...this.resources].reverse()) {
        if (resource.cleaned) continue
        resource.cleaned = true
        try {
          await resource.cleanup()
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          cleanupErrors.push(new Error(`${resource.name}: ${detail}`))
        }
      }
      this.phase = 'stopped'
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Farming Desktop startup cleanup failed.')
      }
    })()
    return this.stopPromise
  }
}
