export type MainPageSessionKeyMutation = {
  version: number
  operation: 'add' | 'remove'
  sessionKeys: string[]
}

export function applyPendingMainPageSessionKeyMutations(
  baseline: Iterable<string>,
  mutations: readonly MainPageSessionKeyMutation[],
) {
  const projected = new Set(baseline)
  mutations.forEach(mutation => {
    mutation.sessionKeys.forEach(sessionKey => {
      if (mutation.operation === 'add') projected.add(sessionKey)
      else projected.delete(sessionKey)
    })
  })
  return Array.from(projected)
}
