export interface ProjectListScrollLease {
  isCurrent: () => boolean
}

const activeScrollOwner = new WeakMap<object, symbol>()

export function claimProjectListScroll(owner: object): ProjectListScrollLease {
  const token = Symbol('project-list-scroll')
  activeScrollOwner.set(owner, token)
  return {
    isCurrent: () => activeScrollOwner.get(owner) === token,
  }
}

export function invalidateProjectListScroll(owner: object) {
  activeScrollOwner.set(owner, Symbol('project-list-scroll-invalidated'))
}
