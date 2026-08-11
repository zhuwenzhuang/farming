export interface RequestOwnershipLease {
  readonly generation: number
  isCurrent(): boolean
}

/**
 * Admits asynchronous UI results only while their original resource scope is
 * still mounted, active, and current.  A newer request, a scope change, or an
 * unmount revokes all outstanding leases.
 */
export class RequestOwnershipFence<Scope> {
  private generation = 0
  private mounted = true
  private active = true

  constructor(private scope: Scope) {}

  get available(): boolean {
    return this.mounted && this.active
  }

  setScope(scope: Scope): void {
    if (Object.is(this.scope, scope)) return
    this.scope = scope
    this.invalidate()
  }

  setMounted(mounted: boolean): void {
    if (this.mounted === mounted) return
    this.mounted = mounted
    this.invalidate()
  }

  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.invalidate()
  }

  begin(): RequestOwnershipLease {
    const generation = ++this.generation
    const scope = this.scope
    return {
      generation,
      isCurrent: () => (
        this.generation === generation
        && this.available
        && Object.is(this.scope, scope)
      ),
    }
  }

  invalidate(): void {
    this.generation += 1
  }
}
