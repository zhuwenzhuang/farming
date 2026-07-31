import type {
  BrowserResource,
  BrowserResourceCollection,
  BrowserResourceDeletion,
} from './types'

export interface BrowserResourceState extends BrowserResourceCollection {
  snapshotRevision: number
  deletedRevisions: ReadonlyMap<string, number>
}

export function emptyBrowserResourceState(): BrowserResourceState {
  return {
    collectionRevision: 0,
    snapshotRevision: 0,
    deletedRevisions: new Map(),
    resources: [],
  }
}

function recordDeletion(
  current: ReadonlyMap<string, number>,
  id: string,
  collectionRevision: number,
) {
  if ((current.get(id) ?? -1) >= collectionRevision) return current
  const next = new Map(current)
  next.set(id, collectionRevision)
  return next
}

export function mergeBrowserResource(
  current: BrowserResource[],
  resource: BrowserResource,
): BrowserResource[] {
  const index = current.findIndex(item => item.id === resource.id)
  if (index < 0) {
    return [...current, resource].sort((left, right) => left.createdAt - right.createdAt)
  }
  const existing = current[index]
  if (
    !existing
    || resource.revision < existing.revision
    || resource.revision === existing.revision
      && resource.collectionRevision <= existing.collectionRevision
  ) return current
  const next = [...current]
  next[index] = resource
  return next
}

export function applyBrowserResource(
  current: BrowserResourceState,
  resource: BrowserResource,
): BrowserResourceState {
  if (resource.collectionRevision <= current.snapshotRevision) return current
  if ((current.deletedRevisions.get(resource.id) ?? -1) >= resource.collectionRevision) return current
  const resources = mergeBrowserResource(current.resources, resource)
  if (resources === current.resources) return current
  const collectionRevision = Math.max(current.collectionRevision, resource.collectionRevision)
  return { ...current, collectionRevision, resources }
}

export function applyBrowserResourceSnapshot(
  current: BrowserResourceState,
  snapshot: BrowserResourceCollection,
): BrowserResourceState {
  if (snapshot.collectionRevision < current.collectionRevision) return current
  return {
    collectionRevision: snapshot.collectionRevision,
    snapshotRevision: snapshot.collectionRevision,
    deletedRevisions: new Map(),
    resources: [...snapshot.resources].sort((left, right) => left.createdAt - right.createdAt),
  }
}

export function applyBrowserResourceDeletion(
  current: BrowserResourceState,
  deletion: BrowserResourceDeletion,
): BrowserResourceState {
  if (deletion.collectionRevision <= current.snapshotRevision) return current
  const resource = current.resources.find(item => item.id === deletion.id)
  const resources = resource && resource.collectionRevision > deletion.collectionRevision
    ? current.resources
    : current.resources.filter(item => item.id !== deletion.id)
  const collectionRevision = Math.max(current.collectionRevision, deletion.collectionRevision)
  const deletedRevisions = recordDeletion(
    current.deletedRevisions,
    deletion.id,
    deletion.collectionRevision,
  )
  if (
    resources === current.resources
    && collectionRevision === current.collectionRevision
    && deletedRevisions === current.deletedRevisions
  ) return current
  return { ...current, collectionRevision, deletedRevisions, resources }
}
