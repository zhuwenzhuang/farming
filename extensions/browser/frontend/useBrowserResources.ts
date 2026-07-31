import { useCallback, useEffect, useMemo, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import {
  type BrowserResourceState,
} from './browser-resource-state'
import type { BrowserCapability, BrowserResource, BrowserResourceDeletion } from './types'

async function browserRequest<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(appPath(pathname), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const data = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(data.error || `Browser request failed (${response.status})`)
  return data as T
}

export function useBrowserResources(options: {
  collection: BrowserResourceState | null
  onResource: (resource: BrowserResource) => void
  onDeletion: (deletion: BrowserResourceDeletion) => void
}) {
  const { collection, onDeletion, onResource } = options
  const [capability, setCapability] = useState<BrowserCapability | null>(null)
  const [capabilityError, setCapabilityError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshVersion, setRefreshVersion] = useState(0)

  const mergeResource = useCallback((resource: BrowserResource) => {
    onResource(resource)
  }, [onResource])

  useEffect(() => {
    let active = true
    setLoading(true)
    setCapabilityError('')
    void browserRequest<BrowserCapability>('/api/browsers/capability').then(nextCapability => {
      if (!active) return
      setCapability(nextCapability)
      setLoading(false)
    }).catch(() => {
      if (!active) return
      setCapability(null)
      setCapabilityError('Failed to check Browser availability')
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [refreshVersion])

  const create = useCallback(async (
    workspace: string,
    options: { agentId?: string; name?: string; url?: string } = {},
  ) => {
    const resource = await browserRequest<BrowserResource>('/api/browsers', {
      method: 'POST',
      body: JSON.stringify({
        rootId: projectFilesWorkspaceId(workspace),
        agentId: options.agentId,
        name: options.name,
        url: options.url,
      }),
    })
    mergeResource(resource)
    return resource
  }, [mergeResource])

  const rename = useCallback(async (id: string, name: string) => {
    const resource = await browserRequest<BrowserResource>(`/api/browsers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    mergeResource(resource)
    return resource
  }, [mergeResource])

  const transition = useCallback(async (id: string, operation: 'start' | 'stop') => {
    const resource = await browserRequest<BrowserResource>(
      `/api/browsers/${encodeURIComponent(id)}/${operation}`,
      { method: 'POST' },
    )
    mergeResource(resource)
    return resource
  }, [mergeResource])

  const start = useCallback((id: string) => transition(id, 'start'), [transition])
  const stop = useCallback((id: string) => transition(id, 'stop'), [transition])

  const remove = useCallback(async (id: string) => {
    const deletion = await browserRequest<BrowserResourceDeletion>(
      `/api/browsers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    onDeletion(deletion)
  }, [onDeletion])

  const refreshCapability = useCallback(() => {
    setCapability(null)
    setCapabilityError('')
    setLoading(true)
    setRefreshVersion(version => version + 1)
  }, [])

  const resources = capability?.available === false ? [] : collection?.resources ?? []

  const byWorkspace = useMemo(() => {
    const result = new Map<string, BrowserResource[]>()
    for (const resource of resources) {
      const current = result.get(resource.workspace) ?? []
      current.push(resource)
      result.set(resource.workspace, current)
    }
    return result
  }, [resources])

  const byAgentId = useMemo(() => {
    const result = new Map<string, BrowserResource[]>()
    for (const resource of resources) {
      if (resource.ownerType !== 'agent' || !resource.ownerAgentId) continue
      const current = result.get(resource.ownerAgentId) ?? []
      current.push(resource)
      result.set(resource.ownerAgentId, current)
    }
    return result
  }, [resources])

  return {
    resources,
    byWorkspace,
    byAgentId,
    capability,
    capabilityError,
    loading,
    collectionLoading: collection === null,
    create,
    rename,
    start,
    stop,
    remove,
    mergeResource,
    refreshCapability,
  }
}

export type BrowserResourcesController = ReturnType<typeof useBrowserResources>
