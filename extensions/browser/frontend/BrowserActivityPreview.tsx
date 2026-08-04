import { useEffect, useState, type CSSProperties } from 'react'
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
    waiting: zh ? '正在连接浏览器画面…' : 'Connecting to browser…',
  }
}

export function BrowserActivityPreview({
  resources,
  language,
  onOpen,
  onDismiss,
}: {
  resources: BrowserResource[]
  language: UiPreferences['language']
  onOpen: (resource: BrowserResource) => void
  onDismiss: (resource: BrowserResource) => void
}) {
  const copy = previewCopy(language)

  return (
    <section
      className="farming-browser-activity-preview-stack"
      data-testid="farming-browser-activity-preview"
      style={{ '--browser-preview-offset': `${Math.max(0, resources.length - 1) * 30}px` } as CSSProperties}
    >
      {resources.map((resource, index) => (
        <BrowserActivityPreviewCard
          key={`${resource.id}:${resource.generation}`}
          resource={resource}
          copy={copy}
          index={index}
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
  index,
  onOpen,
  onDismiss,
}: {
  resource: BrowserResource
  copy: ReturnType<typeof previewCopy>
  index: number
  onOpen: () => void
  onDismiss: () => void
}) {
  const [frame, setFrame] = useState('')
  const title = resource.title || resource.name

  useEffect(() => {
    if (resource.status !== 'running') {
      setFrame('')
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
  }, [resource.generation, resource.id, resource.status])

  return (
    <aside
      className="farming-browser-activity-preview"
      data-testid="farming-browser-activity-preview-card"
      data-browser-resource-id={resource.id}
      aria-label={title}
      style={{ '--browser-preview-index': index } as CSSProperties}
    >
      <header>
        <span className="farming-browser-activity-dot" aria-hidden="true" />
        <button
          type="button"
          className="farming-browser-activity-title"
          aria-label={`${copy.open}: ${title}`}
          title={`${copy.open}: ${title}`}
          onClick={onOpen}
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
      <button
        type="button"
        className="farming-browser-activity-frame"
        aria-label={copy.open}
        title={copy.open}
        onClick={onOpen}
      >
        {frame ? <img src={frame} alt="" draggable={false} /> : <span>{copy.waiting}</span>}
      </button>
    </aside>
  )
}
