export type DesktopAppPhase = 'starting' | 'running' | 'stopping' | 'stopped'
export type DesktopWindowPhase = 'absent' | 'loading' | 'ready' | 'failed'

export interface DesktopNavigationToken {
  routeRevision: number
  windowGeneration: number
}

export type DesktopNavigationDecision =
  | { kind: 'fail' }
  | { kind: 'ignore' }
  | { kind: 'ready' }
  | { kind: 'reload'; token: DesktopNavigationToken }

export interface DesktopLifecycleSnapshot {
  appPhase: DesktopAppPhase
  loadedRouteRevision: number
  routeRevision: number
  windowGeneration: number
  windowPhase: DesktopWindowPhase
}

export class DesktopLifecycle {
  private appPhase: DesktopAppPhase = 'starting'
  private loadedRouteRevision = -1
  private routeRevision = 0
  private windowGeneration = 0
  private windowPhase: DesktopWindowPhase = 'absent'

  start() {
    if (this.appPhase !== 'starting') throw new Error(`Cannot start Desktop from ${this.appPhase}.`)
    this.appPhase = 'running'
  }

  openWindow(): DesktopNavigationToken {
    if (this.appPhase !== 'running') throw new Error(`Cannot open a window while Desktop is ${this.appPhase}.`)
    if (this.windowPhase !== 'absent') throw new Error(`Cannot open a window while it is ${this.windowPhase}.`)
    this.windowGeneration += 1
    this.windowPhase = 'loading'
    return this.currentToken()
  }

  invalidateRendererRoute() {
    if (this.appPhase !== 'running') return false
    this.routeRevision += 1
    return true
  }

  beginPendingNavigation(): DesktopNavigationToken | null {
    if (
      this.appPhase !== 'running'
      || this.windowPhase !== 'ready'
      || this.loadedRouteRevision >= this.routeRevision
    ) return null
    this.windowPhase = 'loading'
    return this.currentToken()
  }

  navigationReady(token: DesktopNavigationToken): DesktopNavigationDecision {
    if (!this.isCurrentLoading(token)) return { kind: 'ignore' }
    if (token.routeRevision < this.routeRevision) {
      return { kind: 'reload', token: this.currentToken() }
    }
    if (token.routeRevision > this.routeRevision) return { kind: 'ignore' }
    this.loadedRouteRevision = token.routeRevision
    this.windowPhase = 'ready'
    return { kind: 'ready' }
  }

  navigationFailed(token: DesktopNavigationToken): DesktopNavigationDecision {
    if (!this.isCurrentLoading(token)) return { kind: 'ignore' }
    if (token.routeRevision < this.routeRevision) {
      return { kind: 'reload', token: this.currentToken() }
    }
    this.windowPhase = 'failed'
    return { kind: 'fail' }
  }

  closeWindow(windowGeneration: number) {
    if (windowGeneration !== this.windowGeneration) return
    this.loadedRouteRevision = -1
    this.windowPhase = 'absent'
  }

  beginStop() {
    if (this.appPhase === 'stopping' || this.appPhase === 'stopped') return false
    this.appPhase = 'stopping'
    this.windowGeneration += 1
    this.loadedRouteRevision = -1
    this.windowPhase = 'absent'
    return true
  }

  finishStop() {
    if (this.appPhase !== 'stopping') throw new Error(`Cannot finish stopping Desktop from ${this.appPhase}.`)
    this.appPhase = 'stopped'
  }

  isRunning() {
    return this.appPhase === 'running'
  }

  snapshot(): DesktopLifecycleSnapshot {
    return {
      appPhase: this.appPhase,
      loadedRouteRevision: this.loadedRouteRevision,
      routeRevision: this.routeRevision,
      windowGeneration: this.windowGeneration,
      windowPhase: this.windowPhase,
    }
  }

  private currentToken(): DesktopNavigationToken {
    return {
      routeRevision: this.routeRevision,
      windowGeneration: this.windowGeneration,
    }
  }

  private isCurrentLoading(token: DesktopNavigationToken) {
    return this.appPhase === 'running'
      && this.windowPhase === 'loading'
      && token.windowGeneration === this.windowGeneration
  }
}
