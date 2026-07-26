import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import type { BrowserResource } from './types'
import type { BrowserResourcesController } from './useBrowserResources'

function viewerWebSocketUrl(resource: BrowserResource) {
  const url = new URL(appPath(`/api/browsers/${encodeURIComponent(resource.id)}/viewer`), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

export function BrowserViewer({
  resource,
  controller,
  onResource,
}: {
  resource: BrowserResource
  controller: BrowserResourcesController
  onResource: (resource: BrowserResource) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const textInputRef = useRef<HTMLTextAreaElement>(null)
  const composingTextRef = useRef(false)
  const socketRef = useRef<WebSocket | null>(null)
  const imageSequenceRef = useRef(0)
  const [address, setAddress] = useState(resource.url)
  const [connected, setConnected] = useState(false)
  const [viewerError, setViewerError] = useState('')

  useEffect(() => setAddress(resource.url), [resource.url])

  useEffect(() => {
    if (resource.status !== 'running') {
      setConnected(false)
      socketRef.current?.close()
      socketRef.current = null
      return undefined
    }
    let cancelled = false
    let reconnectTimer = 0
    const connect = () => {
      if (cancelled) return
      const socket = new WebSocket(viewerWebSocketUrl(resource))
      socketRef.current = socket
      socket.onopen = () => {
        setConnected(true)
        setViewerError('')
      }
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data)) as {
          type: string
          data?: string
          resource?: BrowserResource
          message?: string
        }
        if (message.type === 'browser-state' && message.resource) {
          onResource(message.resource)
          return
        }
        if (message.type === 'browser-error') {
          setViewerError(message.message || 'Browser Viewer failed')
          return
        }
        if (message.type !== 'browser-frame' || !message.data) return
        const sequence = ++imageSequenceRef.current
        const image = new Image()
        image.onload = () => {
          if (sequence !== imageSequenceRef.current) return
          const canvas = canvasRef.current
          const context = canvas?.getContext('2d')
          if (!canvas || !context) return
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          context.drawImage(image, 0, 0)
        }
        image.src = `data:image/jpeg;base64,${message.data}`
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        setConnected(false)
        if (!cancelled) reconnectTimer = window.setTimeout(connect, 1_000)
      }
      socket.onerror = () => setViewerError('Browser Viewer connection failed')
    }
    connect()
    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [onResource, resource.id, resource.status])

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ ...message, generation: resource.generation }))
  }, [resource.generation])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || resource.status !== 'running') return undefined
    const resize = () => {
      const bounds = viewport.getBoundingClientRect()
      send({ type: 'resize', width: bounds.width, height: bounds.height })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    resize()
    return () => observer.disconnect()
  }, [resource.status, send])

  const point = (event: {
    currentTarget: HTMLCanvasElement
    clientX: number
    clientY: number
  }) => {
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) * canvas.width / Math.max(1, bounds.width),
      y: (event.clientY - bounds.top) * canvas.height / Math.max(1, bounds.height),
    }
  }
  const navigate = async () => {
    try {
      const normalized = /^https?:\/\//i.test(address) || address === 'about:blank' ? address : `http://${address}`
      const response = await fetch(appPath(`/api/browsers/${encodeURIComponent(resource.id)}/navigate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url: normalized }),
      })
      const next = await response.json() as BrowserResource & { error?: string }
      if (!response.ok) throw new Error(next.error || 'Navigation failed')
      onResource(next)
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : 'Navigation failed')
    }
  }
  const browserAction = async (kind: 'back' | 'forward' | 'reload') => {
    try {
      const response = await fetch(appPath(`/api/browsers/${encodeURIComponent(resource.id)}/action`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ kind }),
      })
      const next = await response.json() as BrowserResource & { error?: string }
      if (!response.ok) throw new Error(next.error || `Browser ${kind} failed`)
      onResource(next)
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : `Browser ${kind} failed`)
    }
  }

  return (
    <section className="farming-browser-viewer" data-testid="farming-browser-viewer">
      <header className="farming-browser-toolbar">
        <button type="button" aria-label="Back" title="Back" disabled={resource.status !== 'running'} onClick={() => void browserAction('back')}>‹</button>
        <button type="button" aria-label="Forward" title="Forward" disabled={resource.status !== 'running'} onClick={() => void browserAction('forward')}>›</button>
        <button type="button" aria-label="Reload" title="Reload" disabled={resource.status !== 'running'} onClick={() => void browserAction('reload')}>↻</button>
        <form onSubmit={event => {
          event.preventDefault()
          void navigate()
        }}>
          <input
            value={address}
            aria-label="Browser address"
            disabled={resource.status !== 'running'}
            onChange={event => setAddress(event.currentTarget.value)}
          />
        </form>
        <span className={`farming-browser-connection ${connected ? 'connected' : ''}`} title={connected ? 'Viewer connected' : 'Viewer disconnected'} />
        <button
          type="button"
          onClick={() => {
            const stableUrl = new URL(window.location.href)
            stableUrl.searchParams.set('browser', resource.id)
            void navigator.clipboard.writeText(stableUrl.href)
          }}
        >
          Copy link
        </button>
        <button
          type="button"
          disabled={resource.status === 'starting' || resource.status === 'stopping'}
          onClick={() => {
            const transition = resource.status === 'running'
              ? controller.stop(resource.id)
              : controller.start(resource.id)
            void transition.catch(error => setViewerError(error instanceof Error ? error.message : 'Browser transition failed'))
          }}
        >
          {resource.status === 'running' ? 'Stop' : 'Start'}
        </button>
      </header>
      <div ref={viewportRef} className="farming-browser-viewport">
        {resource.status === 'running' ? (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            aria-label={`${resource.name} browser page`}
            onPointerMove={event => {
              const position = point(event)
              send({ type: 'pointer', action: 'move', ...position })
            }}
            onPointerDown={event => {
              event.currentTarget.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              const position = point(event)
              send({ type: 'pointer', action: 'down', button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', ...position })
              if (event.pointerType !== 'mouse') {
                window.requestAnimationFrame(() => textInputRef.current?.focus({ preventScroll: true }))
              }
            }}
            onPointerUp={event => {
              const position = point(event)
              send({ type: 'pointer', action: 'up', button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', ...position })
            }}
            onContextMenu={event => event.preventDefault()}
            onWheel={event => {
              event.preventDefault()
              const position = point(event)
              send({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY, ...position })
            }}
            onKeyDown={event => {
              event.preventDefault()
              const modifiers = (event.altKey ? 1 : 0)
                | (event.ctrlKey ? 2 : 0)
                | (event.metaKey ? 4 : 0)
                | (event.shiftKey ? 8 : 0)
              if (event.key.length === 1 && (modifiers & ~8) === 0) {
                send({ type: 'text', text: event.key })
              } else {
                send({ type: 'key', key: event.key, code: event.code, modifiers })
              }
            }}
            onPaste={event => {
              const text = event.clipboardData.getData('text/plain')
              if (!text) return
              event.preventDefault()
              send({ type: 'text', text })
            }}
          />
        ) : (
          <div className="farming-browser-placeholder">
            <strong>{resource.status === 'failed' ? 'Browser failed' : 'Browser stopped'}</strong>
            <p>{resource.error || 'Start this Browser to open the shared page.'}</p>
            <button type="button" onClick={() => void controller.start(resource.id).catch(error => setViewerError(error.message))}>
              Start Browser
            </button>
          </div>
        )}
        <textarea
          ref={textInputRef}
          className="farming-browser-text-input-proxy"
          aria-label="Browser text input"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onCompositionStart={() => {
            composingTextRef.current = true
          }}
          onCompositionEnd={() => {
            composingTextRef.current = false
          }}
          onInput={event => {
            if (composingTextRef.current) return
            const text = event.currentTarget.value
            if (text) send({ type: 'text', text })
            event.currentTarget.value = ''
          }}
          onKeyDown={event => {
            if (composingTextRef.current) return
            if (!['Backspace', 'Delete', 'Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) return
            event.preventDefault()
            send({ type: 'key', key: event.key, code: event.code })
          }}
        />
      </div>
      {viewerError && <div className="farming-browser-viewer-error" role="alert">{viewerError}</div>}
    </section>
  )
}
