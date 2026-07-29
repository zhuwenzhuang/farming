export interface LatestRequestLease {
  readonly generation: number
  isCurrent(): boolean
}

/**
 * Owns admission for UI requests where only the newest result may commit.
 *
 * Starting a request revokes every older lease. Invalidation revokes the
 * current lease without starting replacement work, for example when the user
 * navigates away while a request is in flight.
 */
export class LatestRequestFence {
  private generation = 0

  begin(): LatestRequestLease {
    const generation = ++this.generation
    return {
      generation,
      isCurrent: () => this.generation === generation,
    }
  }

  invalidate(): void {
    this.generation += 1
  }
}
