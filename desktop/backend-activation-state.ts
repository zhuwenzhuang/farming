export interface DesktopBackendActivationToken {
  backendId: string
  generation: number
}

export interface DesktopBackendMutationDecision {
  activationCancelled: boolean
  invalidateActiveRoute: boolean
}

export interface DesktopBackendMutationEffects {
  disconnect: () => void
  invalidateActiveRoute: () => void
}

export class DesktopBackendActivationState {
  private generation = 0
  private owner: DesktopBackendActivationToken | null = null

  begin(backendId: string): DesktopBackendActivationToken {
    const token = { backendId, generation: ++this.generation }
    this.owner = token
    return token
  }

  isCurrent(token: DesktopBackendActivationToken) {
    return this.owner?.backendId === token.backendId
      && this.owner.generation === token.generation
  }

  claim(token: DesktopBackendActivationToken) {
    if (!this.isCurrent(token)) return false
    this.owner = null
    return true
  }

  cancel(token: DesktopBackendActivationToken) {
    if (!this.isCurrent(token)) return false
    this.owner = null
    this.generation += 1
    return true
  }

  backendChanged(backendId: string, activeBackendId: string | null): DesktopBackendMutationDecision {
    const activationCancelled = this.owner?.backendId === backendId
    if (activationCancelled) {
      this.owner = null
      this.generation += 1
    }
    return {
      activationCancelled,
      invalidateActiveRoute: activeBackendId === backendId,
    }
  }

  cancelAll() {
    this.owner = null
    this.generation += 1
  }
}

export function applyDesktopBackendChange(
  activations: DesktopBackendActivationState,
  backendId: string,
  activeBackendId: string | null,
  effects: DesktopBackendMutationEffects,
) {
  const decision = activations.backendChanged(backendId, activeBackendId)
  effects.disconnect()
  if (decision.invalidateActiveRoute) effects.invalidateActiveRoute()
  return decision
}
