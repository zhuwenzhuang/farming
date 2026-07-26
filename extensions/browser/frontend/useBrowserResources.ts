import { useCallback, useEffect, useMemo, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
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
  const [resources, setResources] = useState<BrowserResource[]>([])
  const [capability, setCapability] = useState<BrowserCapability | null>(null)
  const [loading, setLoading] = useState(true)

  const mergeResource = useCallback((resource: BrowserResource) => {
    setResources(current => {
      const index = current.findIndex(item => item.id === resource.id)
      if (index < 0) return [...current, resource].sort((left, right) => left.createdAt - right.createdAt)
      const next = [...current]
      next[index] = resource
      return next
    })
  }, [])

  useEffect(() => {
    let active = true
    void Promise.all([
      browserRequest<{ resources: BrowserResource[] }>('/api/browsers'),
      browserRequest<BrowserCapability>('/api/browsers/capability'),
    ]).then(([list, nextCapability]) => {
      if (!active) return
      setResources(list.resources)
      setCapability(nextCapability)
      setLoading(false)
    }).catch(() => {
      if (active) setLoading(false)
    })

    const events = new EventSource(appPath('/api/browsers/events'))
    events.addEventListener('resources', event => {
      if (!active) return
      const payload = JSON.parse((event as MessageEvent<string>).data) as { resources: BrowserResource[] }
      setResources(payload.resources)
    })
    events.addEventListener('resource', event => {
      if (!active) return
      mergeResource(JSON.parse((event as MessageEvent<string>).data) as BrowserResource)
    })
    events.addEventListener('deleted', event => {
      if (!active) return
      const payload = JSON.parse((event as MessageEvent<string>).data) as { id: string }
      setResources(current => current.filter(resource => resource.id !== payload.id))
    })
    return () => {
      active = false
      events.close()
    }
  }, [mergeResource])

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
    await browserRequest<{ id: string }>(`/api/browsers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setResources(current => current.filter(resource => resource.id !== id))
  }, [])

  const byWorkspace = useMemo(() => {
    const result = new Map<string, BrowserResource[]>()
    for (const resource of resources) {
      const current = result.get(resource.workspace) ?? []
      current.push(resource)
      result.set(resource.workspace, current)
    }
    return result
  }, [resources])

  return {
    resources,
    byWorkspace,
    capability,
    loading,
    create,
    rename,
    start: (id: string) => transition(id, 'start'),
    stop: (id: string) => transition(id, 'stop'),
    remove,
    mergeResource,
  }
}

export type BrowserResourcesController = ReturnType<typeof useBrowserResources>
