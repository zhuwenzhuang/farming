import { useCallback, useEffect, useMemo, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import {
  applyBrowserResource,
  applyBrowserResourceDeletion,
  applyBrowserResourceSnapshot,
  type BrowserResourceCollection,
  type BrowserResourceDeletion,
} from './browser-resource-state'
import type { BrowserCapability, BrowserResource } from './types'

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

export function useBrowserResources() {
  const [collection, setCollection] = useState<BrowserResourceCollection>({
    collectionRevision: 0,
    resources: [],
  })
  const [capability, setCapability] = useState<BrowserCapability | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshVersion, setRefreshVersion] = useState(0)

  const mergeResource = useCallback((resource: BrowserResource) => {
    setCollection(current => applyBrowserResource(current, resource))
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    void browserRequest<BrowserCapability>('/api/browsers/capability').then(async nextCapability => {
      if (!active) return
      setCapability(nextCapability)
      if (!nextCapability.available) {
        setCollection({ collectionRevision: 0, resources: [] })
        setLoading(false)
        return
      }
      const list = await browserRequest<BrowserResourceCollection>('/api/browsers')
      if (!active) return
      setCollection(current => applyBrowserResourceSnapshot(current, list))
      setLoading(false)
    }).catch(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [refreshVersion])

  useEffect(() => {
    if (capability?.available !== true) return undefined
    let active = true
    const events = new EventSource(appPath('/api/browsers/events'))
    events.addEventListener('resources', event => {
      if (!active) return
      const payload = JSON.parse((event as MessageEvent<string>).data) as BrowserResourceCollection
      setCollection(current => applyBrowserResourceSnapshot(current, payload))
    })
    events.addEventListener('resource', event => {
      if (!active) return
      mergeResource(JSON.parse((event as MessageEvent<string>).data) as BrowserResource)
    })
    events.addEventListener('deleted', event => {
      if (!active) return
      const payload = JSON.parse((event as MessageEvent<string>).data) as BrowserResourceDeletion
      setCollection(current => applyBrowserResourceDeletion(current, payload))
    })
    return () => {
      active = false
      events.close()
    }
  }, [capability?.available, mergeResource])

  const create = useCallback(async (workspace: string, options: { name?: string; url?: string } = {}) => {
    const resource = await browserRequest<BrowserResource>('/api/browsers', {
      method: 'POST',
      body: JSON.stringify({
        rootId: projectFilesWorkspaceId(workspace),
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

  const remove = useCallback(async (id: string) => {
    const deletion = await browserRequest<BrowserResourceDeletion>(
      `/api/browsers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    setCollection(current => applyBrowserResourceDeletion(current, deletion))
  }, [])

  const byWorkspace = useMemo(() => {
    const result = new Map<string, BrowserResource[]>()
    for (const resource of collection.resources) {
      const current = result.get(resource.workspace) ?? []
      current.push(resource)
      result.set(resource.workspace, current)
    }
    return result
  }, [collection.resources])

  return {
    resources: collection.resources,
    byWorkspace,
    capability,
    loading,
    create,
    rename,
    start: (id: string) => transition(id, 'start'),
    stop: (id: string) => transition(id, 'stop'),
    remove,
    mergeResource,
    refreshCapability: () => setRefreshVersion(version => version + 1),
  }
}

export type BrowserResourcesController = ReturnType<typeof useBrowserResources>
