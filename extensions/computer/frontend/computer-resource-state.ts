import type {
  ComputerResource,
  ComputerResourceCollection,
  ComputerResourceDeletion,
} from './types'

export interface ComputerResourceState extends ComputerResourceCollection {
  snapshotRevision: number
  deletedRevisions: ReadonlyMap<string, number>
}

export function emptyComputerResourceState(): ComputerResourceState {
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

export function applyComputerResource(
  current: ComputerResourceState,
  resource: ComputerResource,
): ComputerResourceState {
  if (resource.collectionRevision <= current.snapshotRevision) return current
  if ((current.deletedRevisions.get(resource.id) ?? -1) >= resource.collectionRevision) return current
  const existing = current.resources.find(item => item.id === resource.id)
  if (
    existing
    && (
      resource.revision < existing.revision
      || resource.revision === existing.revision
        && resource.collectionRevision <= existing.collectionRevision
    )
  ) return current
  const resources = existing
    ? current.resources.map(item => item.id === resource.id ? resource : item)
    : [...current.resources, resource].sort((left, right) => left.createdAt - right.createdAt)
  return {
    ...current,
    collectionRevision: Math.max(current.collectionRevision, resource.collectionRevision),
    resources,
  }
}

export function applyComputerResourceSnapshot(
  current: ComputerResourceState,
  snapshot: ComputerResourceCollection,
): ComputerResourceState {
  if (snapshot.collectionRevision < current.collectionRevision) return current
  return {
    collectionRevision: snapshot.collectionRevision,
    snapshotRevision: snapshot.collectionRevision,
    deletedRevisions: new Map(),
    resources: [...snapshot.resources].sort((left, right) => left.createdAt - right.createdAt),
  }
}

export function applyComputerResourceDeletion(
  current: ComputerResourceState,
  deletion: ComputerResourceDeletion,
): ComputerResourceState {
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
