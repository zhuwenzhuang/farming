export type MainPageSessionKeyOperation = 'add' | 'remove'

export type MainPageSessionKeyMutation = {
  version: number
  operation: MainPageSessionKeyOperation
  sessionKeys: string[]
}

export type MainPageSessionKeysInitialGuard = {
  authoritativeRevision: number
  mutationVersion: number
}

export type MainPageSessionMembershipState = {
  authoritativeKeys: string[]
  authoritativeRevision: number
  latestMutationVersion: number
  observedSessionKeys: string[]
  pendingMutations: MainPageSessionKeyMutation[]
  projectedKeys: string[]
}

export type MainPageSessionMembershipEvent =
  | { type: 'remote-baseline-received'; authoritativeKeys: string[] }
  | { type: 'initial-settings-received'; authoritativeKeys: string[]; guard: MainPageSessionKeysInitialGuard }
  | { type: 'session-keys-observed'; sessionKeys: string[] }
  | { type: 'mutation-enqueued'; mutation: MainPageSessionKeyMutation }
  | {
    type: 'mutation-settled'
    version: number
    authoritativeKeys: string[] | null
    authoritativeRevisionAtStart: number
  }

const MAX_PROJECTED_MAIN_PAGE_SESSION_KEYS = 50

function applyMainPageSessionKeyMutation(
  projected: Set<string>,
  mutation: Pick<MainPageSessionKeyMutation, 'operation' | 'sessionKeys'>,
) {
  mutation.sessionKeys.forEach(sessionKey => {
    if (mutation.operation === 'add') projected.add(sessionKey)
    else projected.delete(sessionKey)
  })
}

export function applyPendingMainPageSessionKeyMutations(
  baseline: Iterable<string>,
  mutations: readonly MainPageSessionKeyMutation[],
) {
  const projected = new Set(baseline)
  mutations.forEach(mutation => applyMainPageSessionKeyMutation(projected, mutation))
  return Array.from(projected)
}

function membershipState(
  state: Omit<MainPageSessionMembershipState, 'projectedKeys'>,
): MainPageSessionMembershipState {
  let projectedKeys = Array.from(new Set(state.authoritativeKeys))
    .slice(0, MAX_PROJECTED_MAIN_PAGE_SESSION_KEYS)
  const optimisticMutations: Array<Pick<MainPageSessionKeyMutation, 'operation' | 'sessionKeys'>> = [
    { operation: 'add', sessionKeys: state.observedSessionKeys },
    ...state.pendingMutations,
  ]
  optimisticMutations.forEach(mutation => {
    const projected = new Set(projectedKeys)
    applyMainPageSessionKeyMutation(projected, mutation)
    projectedKeys = Array.from(projected).slice(0, MAX_PROJECTED_MAIN_PAGE_SESSION_KEYS)
  })
  return {
    ...state,
    projectedKeys,
  }
}

export function createMainPageSessionMembershipState(
  authoritativeKeys: Iterable<string>,
): MainPageSessionMembershipState {
  return membershipState({
    authoritativeKeys: Array.from(authoritativeKeys),
    authoritativeRevision: 0,
    latestMutationVersion: 0,
    observedSessionKeys: [],
    pendingMutations: [],
  })
}

export function reduceMainPageSessionMembership(
  state: MainPageSessionMembershipState,
  event: MainPageSessionMembershipEvent,
): MainPageSessionMembershipState {
  if (event.type === 'remote-baseline-received') {
    return membershipState({
      ...state,
      authoritativeKeys: [...event.authoritativeKeys],
      authoritativeRevision: state.authoritativeRevision + 1,
      observedSessionKeys: [],
    })
  }

  if (event.type === 'initial-settings-received') {
    if (
      event.guard.authoritativeRevision !== state.authoritativeRevision
      || event.guard.mutationVersion !== state.latestMutationVersion
    ) {
      return state
    }
    return membershipState({
      ...state,
      authoritativeKeys: [...event.authoritativeKeys],
      observedSessionKeys: [],
    })
  }

  if (event.type === 'session-keys-observed') {
    const observedSessionKeys = [...state.observedSessionKeys]
    const projected = new Set(state.projectedKeys)
    event.sessionKeys.forEach(sessionKey => {
      if (projected.has(sessionKey)) return
      projected.add(sessionKey)
      observedSessionKeys.push(sessionKey)
    })
    if (observedSessionKeys.length === state.observedSessionKeys.length) return state
    return membershipState({
      ...state,
      observedSessionKeys,
    })
  }

  if (event.type === 'mutation-enqueued') {
    return membershipState({
      ...state,
      latestMutationVersion: Math.max(state.latestMutationVersion, event.mutation.version),
      pendingMutations: [...state.pendingMutations, event.mutation],
    })
  }

  if (!state.pendingMutations.some(mutation => mutation.version === event.version)) return state

  const pendingMutations = state.pendingMutations
    .filter(mutation => mutation.version !== event.version)
  const responseIsStillAuthoritative = event.authoritativeKeys !== null
    && state.authoritativeRevision === event.authoritativeRevisionAtStart
  return membershipState({
    ...state,
    authoritativeKeys: responseIsStillAuthoritative && event.authoritativeKeys
      ? [...event.authoritativeKeys]
      : state.authoritativeKeys,
    observedSessionKeys: [],
    pendingMutations,
  })
}

export function enqueueMainPageSessionKeyMutation(
  state: MainPageSessionMembershipState,
  operation: MainPageSessionKeyOperation,
  sessionKeys: string[],
) {
  const mutation: MainPageSessionKeyMutation = {
    version: state.latestMutationVersion + 1,
    operation,
    sessionKeys: [...sessionKeys],
  }
  return {
    mutation,
    state: reduceMainPageSessionMembership(state, { type: 'mutation-enqueued', mutation }),
  }
}

export function receiveMainPageSessionKeysBaseline(
  state: MainPageSessionMembershipState,
  authoritativeKeys: string[],
) {
  return reduceMainPageSessionMembership(state, {
    type: 'remote-baseline-received',
    authoritativeKeys,
  })
}

export function observeMainPageSessionKeys(
  state: MainPageSessionMembershipState,
  sessionKeys: string[],
) {
  return reduceMainPageSessionMembership(state, {
    type: 'session-keys-observed',
    sessionKeys,
  })
}

export function captureMainPageSessionKeysInitialGuard(
  state: MainPageSessionMembershipState,
): MainPageSessionKeysInitialGuard {
  return {
    authoritativeRevision: state.authoritativeRevision,
    mutationVersion: state.latestMutationVersion,
  }
}

export function receiveInitialMainPageSessionKeys(
  state: MainPageSessionMembershipState,
  authoritativeKeys: string[],
  guard: MainPageSessionKeysInitialGuard,
) {
  return reduceMainPageSessionMembership(state, {
    type: 'initial-settings-received',
    authoritativeKeys,
    guard,
  })
}

export function settleMainPageSessionKeyMutation(
  state: MainPageSessionMembershipState,
  settlement: Omit<Extract<MainPageSessionMembershipEvent, { type: 'mutation-settled' }>, 'type'>,
) {
  return reduceMainPageSessionMembership(state, {
    type: 'mutation-settled',
    ...settlement,
  })
}

export type MainPageSessionMembershipPorts = {
  mutateMainPageSessionKeys: (
    operation: MainPageSessionKeyOperation,
    sessionKeys: string[],
  ) => Promise<string[]>
  loadMainPageSessionKeys: () => Promise<string[]>
}

/**
 * Owns the main-page membership baseline, WebSocket revision, ordered pending
 * mutations, and their visible projection. Effects may only publish state
 * through the pure transitions above.
 */
export class MainPageSessionMembershipController {
  private state: MainPageSessionMembershipState
  private readonly listeners = new Set<() => void>()
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    initialAuthoritativeKeys: string[],
    private readonly ports: MainPageSessionMembershipPorts,
  ) {
    this.state = createMainPageSessionMembershipState(initialAuthoritativeKeys)
  }

  getSnapshot = () => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  captureInitialSettingsGuard = () => captureMainPageSessionKeysInitialGuard(this.state)

  receiveInitialSettings = (
    authoritativeKeys: string[],
    guard: MainPageSessionKeysInitialGuard,
  ) => {
    this.publish(receiveInitialMainPageSessionKeys(this.state, authoritativeKeys, guard))
  }

  receiveRemoteBaseline = (authoritativeKeys: string[]) => {
    this.publish(receiveMainPageSessionKeysBaseline(this.state, authoritativeKeys))
  }

  observeSessionKeys = (sessionKeys: string[]) => {
    this.publish(observeMainPageSessionKeys(this.state, sessionKeys))
  }

  mutate(operation: MainPageSessionKeyOperation, sessionKeys: string[]) {
    if (sessionKeys.length === 0) return Promise.resolve()

    const queued = enqueueMainPageSessionKeyMutation(this.state, operation, sessionKeys)
    this.publish(queued.state)
    const task = this.mutationTail
      .catch(() => undefined)
      .then(() => this.runMutation(queued.mutation))
    this.mutationTail = task
    return task
  }

  private async runMutation(mutation: MainPageSessionKeyMutation) {
    const authoritativeRevisionAtStart = this.state.authoritativeRevision
    let authoritativeKeys: string[] | null = null
    try {
      authoritativeKeys = await this.ports.mutateMainPageSessionKeys(
        mutation.operation,
        mutation.sessionKeys,
      )
    } catch {
      try {
        authoritativeKeys = await this.ports.loadMainPageSessionKeys()
      } catch {
        // Settle against the latest WebSocket baseline below.
      }
    }

    this.publish(settleMainPageSessionKeyMutation(this.state, {
      version: mutation.version,
      authoritativeKeys,
      authoritativeRevisionAtStart,
    }))
  }

  private publish(nextState: MainPageSessionMembershipState) {
    if (nextState === this.state) return
    this.state = nextState
    this.listeners.forEach(listener => listener())
  }
}
