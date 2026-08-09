export type MainPageSessionKeyOperation = 'add' | 'remove'

export type MainPageSessionKeyMutation = {
  version: number
  operation: MainPageSessionKeyOperation
  sessionKeys: string[]
}

export type MainPageSessionKeysInitialGuard = {
  membershipRevision: number
  requestVersion: number
}

export type MainPageSessionMembershipState = {
  authoritativeKeys: string[]
  authoritativeRevision: number
  latestAcceptedSettingsRequestVersion: number
  latestMutationVersion: number
  latestSettingsRequestVersion: number
  membershipRevision: number
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

function projectMainPageSessionKeyMutation(
  projectedKeys: readonly string[],
  mutation: Pick<MainPageSessionKeyMutation, 'operation' | 'sessionKeys'>,
) {
  const mutationKeys = new Set(mutation.sessionKeys)
  if (mutation.operation === 'remove') {
    return projectedKeys
      .filter(sessionKey => !mutationKeys.has(sessionKey))
      .slice(0, MAX_PROJECTED_MAIN_PAGE_SESSION_KEYS)
  }

  const addedKeys = Array.from(new Set(mutation.sessionKeys))
  return [
    ...addedKeys,
    ...projectedKeys.filter(sessionKey => !mutationKeys.has(sessionKey)),
  ].slice(0, MAX_PROJECTED_MAIN_PAGE_SESSION_KEYS)
}

export function applyPendingMainPageSessionKeyMutations(
  baseline: Iterable<string>,
  mutations: readonly MainPageSessionKeyMutation[],
) {
  let projectedKeys = Array.from(new Set(baseline))
    .slice(0, MAX_PROJECTED_MAIN_PAGE_SESSION_KEYS)
  mutations.forEach(mutation => {
    projectedKeys = projectMainPageSessionKeyMutation(projectedKeys, mutation)
  })
  return projectedKeys
}

function membershipState(
  state: Omit<MainPageSessionMembershipState, 'projectedKeys'>,
): MainPageSessionMembershipState {
  let projectedKeys = Array.from(new Set(state.authoritativeKeys))
    .slice(0, MAX_PROJECTED_MAIN_PAGE_SESSION_KEYS)
  projectedKeys = projectMainPageSessionKeyMutation(projectedKeys, {
    operation: 'add',
    sessionKeys: state.observedSessionKeys,
  })
  state.pendingMutations.forEach(mutation => {
    projectedKeys = projectMainPageSessionKeyMutation(projectedKeys, mutation)
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
    latestAcceptedSettingsRequestVersion: 0,
    latestMutationVersion: 0,
    latestSettingsRequestVersion: 0,
    membershipRevision: 0,
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
      membershipRevision: state.membershipRevision + 1,
      observedSessionKeys: [],
    })
  }

  if (event.type === 'initial-settings-received') {
    if (
      event.guard.membershipRevision !== state.membershipRevision
      || event.guard.requestVersion <= state.latestAcceptedSettingsRequestVersion
      || event.guard.requestVersion > state.latestSettingsRequestVersion
    ) {
      return state
    }
    return membershipState({
      ...state,
      authoritativeKeys: [...event.authoritativeKeys],
      latestAcceptedSettingsRequestVersion: event.guard.requestVersion,
      observedSessionKeys: [],
    })
  }

  if (event.type === 'session-keys-observed') {
    const previousObserved = new Set(state.observedSessionKeys)
    const newlyObserved: string[] = []
    event.sessionKeys.forEach(sessionKey => {
      if (previousObserved.has(sessionKey)) return
      previousObserved.add(sessionKey)
      newlyObserved.push(sessionKey)
    })
    if (newlyObserved.length === 0) return state
    return membershipState({
      ...state,
      membershipRevision: state.membershipRevision + 1,
      observedSessionKeys: [
        ...newlyObserved,
        ...state.observedSessionKeys,
      ].slice(0, MAX_PROJECTED_MAIN_PAGE_SESSION_KEYS),
    })
  }

  if (event.type === 'mutation-enqueued') {
    return membershipState({
      ...state,
      latestMutationVersion: Math.max(state.latestMutationVersion, event.mutation.version),
      membershipRevision: state.membershipRevision + 1,
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
    membershipRevision: state.membershipRevision + 1,
    observedSessionKeys: responseIsStillAuthoritative ? [] : state.observedSessionKeys,
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

export function beginMainPageSessionKeysSettingsRequest(
  state: MainPageSessionMembershipState,
): { guard: MainPageSessionKeysInitialGuard; state: MainPageSessionMembershipState } {
  const requestVersion = state.latestSettingsRequestVersion + 1
  return {
    guard: {
      membershipRevision: state.membershipRevision,
      requestVersion,
    },
    state: {
      ...state,
      latestSettingsRequestVersion: requestVersion,
    },
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

  captureInitialSettingsGuard = () => {
    const request = beginMainPageSessionKeysSettingsRequest(this.state)
    this.publish(request.state)
    return request.guard
  }

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
