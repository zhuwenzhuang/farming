import { useCallback, useEffect, useMemo, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import type { ComputerCapability, ComputerResource } from './types'

type ComputerCollection = {
  collectionRevision: number
  resources: ComputerResource[]
}

async function computerRequest<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(appPath(pathname), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const data = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(data.error || `Computer request failed (${response.status})`)
  return data as T
}

export function useComputerResources() {
  const [collection, setCollection] = useState<ComputerCollection>({
    collectionRevision: 0,
    resources: [],
  })
  const [capability, setCapability] = useState<ComputerCapability | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshVersion, setRefreshVersion] = useState(0)

  const mergeResource = useCallback((resource: ComputerResource) => {
    setCollection(current => {
      if (resource.collectionRevision < current.collectionRevision) return current
      const resources = current.resources.some(item => item.id === resource.id)
        ? current.resources.map(item => item.id === resource.id ? resource : item)
        : [...current.resources, resource]
      return {
        collectionRevision: resource.collectionRevision,
        resources,
      }
    })
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      computerRequest<ComputerCapability>('/api/computers/capability'),
      computerRequest<ComputerCollection>('/api/computers'),
    ]).then(([nextCapability, nextCollection]) => {
      if (!active) return
      setCapability(nextCapability)
      setCollection(nextCollection)
      setLoading(false)
    }).catch(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [refreshVersion])

  useEffect(() => {
    if (capability?.enabled !== true) return undefined
    const events = new EventSource(appPath('/api/computers/events'))
    events.addEventListener('resources', event => {
      const next = JSON.parse((event as MessageEvent<string>).data) as ComputerCollection
      setCollection(current => next.collectionRevision >= current.collectionRevision ? next : current)
    })
    events.addEventListener('resource', event => {
      mergeResource(JSON.parse((event as MessageEvent<string>).data) as ComputerResource)
    })
    events.addEventListener('deleted', event => {
      const deletion = JSON.parse((event as MessageEvent<string>).data) as {
        id: string
        collectionRevision: number
      }
      setCollection(current => deletion.collectionRevision < current.collectionRevision
        ? current
        : {
            collectionRevision: deletion.collectionRevision,
            resources: current.resources.filter(resource => resource.id !== deletion.id),
          })
    })
    return () => events.close()
  }, [capability?.enabled, mergeResource])

  const create = useCallback(async (workspace: string, agentId: string, name?: string) => {
    const resource = await computerRequest<ComputerResource>('/api/computers', {
      method: 'POST',
      body: JSON.stringify({
        rootId: projectFilesWorkspaceId(workspace),
        agentId,
        name,
      }),
    })
    mergeResource(resource)
    return resource
  }, [mergeResource])

  const transition = useCallback(async (id: string, operation: 'start' | 'stop') => {
    const resource = await computerRequest<ComputerResource>(
      `/api/computers/${encodeURIComponent(id)}/${operation}`,
      { method: 'POST' },
    )
    mergeResource(resource)
    return resource
  }, [mergeResource])

  const rename = useCallback(async (id: string, name: string) => {
    const resource = await computerRequest<ComputerResource>(`/api/computers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    mergeResource(resource)
    return resource
  }, [mergeResource])

  const remove = useCallback(async (id: string) => {
    const deletion = await computerRequest<{ id: string; collectionRevision: number }>(
      `/api/computers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    setCollection(current => ({
      collectionRevision: deletion.collectionRevision,
      resources: current.resources.filter(resource => resource.id !== deletion.id),
    }))
  }, [])

  const takeControl = useCallback(async (id: string, owner: 'agent' | 'human') => {
    const resource = await computerRequest<ComputerResource>(
      `/api/computers/${encodeURIComponent(id)}/control`,
      { method: 'POST', body: JSON.stringify({ owner }) },
    )
    mergeResource(resource)
    return resource
  }, [mergeResource])

  const prepare = useCallback(async () => {
    const next = await computerRequest<ComputerCapability>('/api/computers/prepare', { method: 'POST' })
    setCapability(next)
    return next
  }, [])

  const refreshCapability = useCallback(() => {
    setRefreshVersion(version => version + 1)
  }, [])

  const byAgentId = useMemo(() => new Map(collection.resources.map(resource => [
    resource.ownerAgentId,
    resource,
  ])), [collection.resources])

  return {
    resources: collection.resources,
    byAgentId,
    capability,
    loading,
    create,
    start: useCallback((id: string) => transition(id, 'start'), [transition]),
    stop: useCallback((id: string) => transition(id, 'stop'), [transition]),
    rename,
    remove,
    takeControl,
    prepare,
    mergeResource,
    refreshCapability,
  }
}

export type ComputerResourcesController = ReturnType<typeof useComputerResources>
