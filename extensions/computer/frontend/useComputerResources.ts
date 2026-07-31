import { useCallback, useEffect, useMemo, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import type { ComputerResourceState } from './computer-resource-state'
import type {
  ComputerCapability,
  ComputerResource,
  ComputerResourceDeletion,
} from './types'

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

export function useComputerResources(options: {
  collection: ComputerResourceState | null
  onResource: (resource: ComputerResource) => void
  onDeletion: (deletion: ComputerResourceDeletion) => void
}) {
  const { collection, onDeletion, onResource } = options
  const [capability, setCapability] = useState<ComputerCapability | null>(null)
  const [capabilityError, setCapabilityError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshVersion, setRefreshVersion] = useState(0)

  const mergeResource = useCallback((resource: ComputerResource) => {
    onResource(resource)
  }, [onResource])

  useEffect(() => {
    let active = true
    setLoading(true)
    setCapabilityError('')
    computerRequest<ComputerCapability>('/api/computers/capability').then(nextCapability => {
      if (!active) return
      setCapability(nextCapability)
      setLoading(false)
    }).catch(() => {
      if (!active) return
      setCapabilityError('Failed to check Computer Use availability')
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [refreshVersion])

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
    const deletion = await computerRequest<ComputerResourceDeletion>(
      `/api/computers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    onDeletion(deletion)
  }, [onDeletion])

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
    setCapabilityError('')
    setLoading(true)
    setRefreshVersion(version => version + 1)
  }, [])

  const byAgentId = useMemo(() => new Map((collection?.resources ?? []).map(resource => [
    resource.ownerAgentId,
    resource,
  ])), [collection?.resources])

  return {
    resources: collection?.resources ?? [],
    byAgentId,
    capability,
    capabilityError,
    loading,
    collectionLoading: collection === null,
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
