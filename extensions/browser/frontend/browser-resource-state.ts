import type { BrowserResource } from './types'

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
