import { useEffect, useState } from 'react'
import { appPath } from '@/lib/base-path'
import type { UiPreferences } from '@/lib/ui-preferences'
import type { BrowserResource } from './types'

function viewerWebSocketUrl(resourceId: string) {
  const url = new URL(appPath(`/api/browsers/${encodeURIComponent(resourceId)}/viewer`), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function previewCopy(language: UiPreferences['language']) {
  const zh = language === 'zh'
  return {
    close: zh ? '隐藏浏览器预览' : 'Hide browser preview',
    open: zh ? '打开完整浏览器' : 'Open full browser',
    reconnecting: zh ? '正在重新连接浏览器…' : 'Reconnecting to browser…',
    waiting: zh ? '正在连接浏览器画面…' : 'Connecting to browser…',
  }
}

export function BrowserActivityPreview({
  resources,
  language,
  expandedResourceId,
  onToggle,
  onOpen,
  onDismiss,
}: {
  resources: BrowserResource[]
  language: UiPreferences['language']
  expandedResourceId: string | null
  onToggle: (resource: BrowserResource) => void
  onOpen: (resource: BrowserResource) => void
  onDismiss: (resource: BrowserResource) => void
}) {
  const copy = previewCopy(language)

  return (
    <section
      className="farming-browser-activity-preview-stack"
      data-testid="farming-browser-activity-preview"
    >
      {resources.map(resource => (
        <BrowserActivityPreviewCard
          key={`${resource.id}:${resource.generation}`}
          resource={resource}
          copy={copy}
          expanded={expandedResourceId === resource.id}
          streaming={expandedResourceId === resource.id}
          onToggle={() => onToggle(resource)}
          onOpen={() => onOpen(resource)}
          onDismiss={() => onDismiss(resource)}
        />
      ))}
    </section>
  )
}

function BrowserActivityPreviewCard({
  resource,
  copy,
  expanded,
  streaming,
  onToggle,
  onOpen,
  onDismiss,
}: {
  resource: BrowserResource
  copy: ReturnType<typeof previewCopy>
  expanded: boolean
  streaming: boolean
  onToggle: () => void
  onOpen: () => void
  onDismiss: () => void
}) {
  const [frame, setFrame] = useState('')
  const title = resource.title || resource.name

  useEffect(() => {
    if (!streaming || resource.status !== 'running') {
      if (resource.status !== 'running') setFrame('')
      return undefined
    }
    let cancelled = false
    let reconnectTimer = 0
    let socket: WebSocket | null = null
    const connect = () => {
      if (cancelled) return
      socket = new WebSocket(viewerWebSocketUrl(resource.id))
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data)) as {
          type?: string
          data?: string
          format?: 'jpeg' | 'png'
        }
        if (message.type !== 'browser-frame' || !message.data) return
        setFrame(`data:image/${message.format === 'png' ? 'png' : 'jpeg'};base64,${message.data}`)
      }
      socket.onclose = () => {
        if (!cancelled) reconnectTimer = window.setTimeout(connect, 1_000)
      }
    }
    connect()
    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [resource.generation, resource.id, resource.status, streaming])

  return (
    <aside
      className="farming-browser-activity-preview"
      data-testid="farming-browser-activity-preview-card"
      data-browser-resource-id={resource.id}
      aria-label={title}
    >
      <header>
        <span
          className={`farming-browser-activity-dot ${resource.status === 'reconnecting' ? 'reconnecting' : ''}`.trim()}
          aria-hidden="true"
        />
        <button
          type="button"
          className="farming-browser-activity-title"
          aria-expanded={expanded}
          title={title}
          onClick={onToggle}
        >
          {title}
        </button>
        <button
          type="button"
          className="farming-browser-activity-close"
          aria-label={copy.close}
          title={copy.close}
          onClick={onDismiss}
        >
          ×
        </button>
      </header>
      {expanded ? (
        <button
          type="button"
          className="farming-browser-activity-frame"
          aria-label={copy.open}
          title={copy.open}
          onClick={onOpen}
        >
          {frame ? <img src={frame} alt="" draggable={false} /> : (
            <span>{resource.status === 'reconnecting' ? copy.reconnecting : copy.waiting}</span>
          )}
        </button>
      ) : null}
    </aside>
  )
}
