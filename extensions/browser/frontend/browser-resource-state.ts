import type { BrowserResource } from './types'

export interface BrowserResourceCollection {
  collectionRevision: number
  resources: BrowserResource[]
}

export interface BrowserResourceDeletion {
  id: string
  collectionRevision: number
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
  if (!existing || resource.revision < existing.revision) return current
  const next = [...current]
  next[index] = resource
  return next
}

export function applyBrowserResource(
  current: BrowserResourceCollection,
  resource: BrowserResource,
): BrowserResourceCollection {
  const resources = mergeBrowserResource(current.resources, resource)
  const collectionRevision = Math.max(current.collectionRevision, resource.collectionRevision)
  if (resources === current.resources && collectionRevision === current.collectionRevision) return current
  return { collectionRevision, resources }
}

export function applyBrowserResourceSnapshot(
  current: BrowserResourceCollection,
  snapshot: BrowserResourceCollection,
): BrowserResourceCollection {
  if (snapshot.collectionRevision < current.collectionRevision) return current
  return {
    collectionRevision: snapshot.collectionRevision,
    resources: [...snapshot.resources].sort((left, right) => left.createdAt - right.createdAt),
  }
}

export function applyBrowserResourceDeletion(
  current: BrowserResourceCollection,
  deletion: BrowserResourceDeletion,
): BrowserResourceCollection {
  const resource = current.resources.find(item => item.id === deletion.id)
  const resources = resource && resource.collectionRevision > deletion.collectionRevision
    ? current.resources
    : current.resources.filter(item => item.id !== deletion.id)
  const collectionRevision = Math.max(current.collectionRevision, deletion.collectionRevision)
  if (resources === current.resources && collectionRevision === current.collectionRevision) return current
  return { collectionRevision, resources }
}
