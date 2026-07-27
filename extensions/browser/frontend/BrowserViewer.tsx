import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeftGlyph, ArrowRightGlyph, BackToAgentGlyph, CopyGlyph, SquareGlyph } from '@/components/IconGlyphs'
import { appPath } from '@/lib/base-path'
import type { UiPreferences } from '@/lib/ui-preferences'
import type { BrowserResource } from './types'
import type { BrowserResourcesController } from './useBrowserResources'

function viewerWebSocketUrl(resource: BrowserResource) {
  const url = new URL(appPath(`/api/browsers/${encodeURIComponent(resource.id)}/viewer`), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function viewerCopy(language: UiPreferences['language']) {
  const zh = language === 'zh'
  return {
    back: zh ? '后退' : 'Back',
    backToAgent: zh ? '返回 Agent' : 'Back to Agent',
    forward: zh ? '前进' : 'Forward',
    reload: zh ? '重新加载' : 'Reload',
    address: zh ? '浏览器地址' : 'Browser address',
    connected: zh ? 'Viewer 已连接' : 'Viewer connected',
    disconnected: zh ? 'Viewer 未连接' : 'Viewer disconnected',
    copyLink: zh ? '复制链接' : 'Copy link',
    more: zh ? '更多' : 'More',
    start: zh ? '启动' : 'Start',
    stop: zh ? '停止' : 'Stop',
    startBrowser: zh ? '启动浏览器' : 'Start Browser',
    stoppedTitle: zh ? '浏览器已停止' : 'Browser stopped',
    failedTitle: zh ? '浏览器失败' : 'Browser failed',
    stoppedHint: zh ? '启动后，用户和 Agent 将操作同一个页面。' : 'Start it to share one page between the user and Agent.',
    pageLabel: (name: string) => zh ? `${name} 浏览器页面` : `${name} browser page`,
    textInput: zh ? '浏览器文本输入' : 'Browser text input',
    viewerFailed: zh ? 'Browser Viewer 失败' : 'Browser Viewer failed',
    connectionFailed: zh ? 'Browser Viewer 连接失败' : 'Browser Viewer connection failed',
    navigationFailed: zh ? '导航失败' : 'Navigation failed',
    transitionFailed: zh ? '浏览器状态切换失败' : 'Browser transition failed',
  }
}

function ReloadGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M12.8 3.8V1.5a.5.5 0 0 1 1 0v3.6a.5.5 0 0 1-.5.5H9.7a.5.5 0 0 1 0-1h2.36A5.5 5.5 0 1 0 13.5 8a.5.5 0 0 1 1 0 6.5 6.5 0 1 1-1.7-4.2Z" />
    </svg>
  )
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 2.6a.75.75 0 0 1 1.15-.63l7 4.9a.75.75 0 0 1 0 1.23l-7 4.9A.75.75 0 0 1 4.5 12.4V2.6Z" />
    </svg>
  )
}

function MoreGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="13" cy="8" r="1.1" />
    </svg>
  )
}

export function BrowserViewer({
  resource,
  controller,
  language,
  onResource,
  onBackToAgent,
}: {
  resource: BrowserResource
  controller: BrowserResourcesController
  language: UiPreferences['language']
  onResource: (resource: BrowserResource) => void
  onBackToAgent: () => void
}) {
  const copy = viewerCopy(language)
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const addressInputRef = useRef<HTMLInputElement>(null)
  const addressEditingRef = useRef(false)
  const textInputRef = useRef<HTMLTextAreaElement>(null)
  const composingTextRef = useRef(false)
  const socketRef = useRef<WebSocket | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const imageSequenceRef = useRef(0)
  const paintFrameRef = useRef<number | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const frameViewportRef = useRef<{ width: number; height: number } | null>(null)
  const [address, setAddress] = useState(resource.url)
  const [connected, setConnected] = useState(false)
  const [viewerError, setViewerError] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)

  useEffect(() => {
    if (!addressEditingRef.current) setAddress(resource.url)
  }, [resource.url])

  useEffect(() => {
    if (!moreOpen) return undefined
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && (moreMenuRef.current?.contains(event.target) || moreButtonRef.current?.contains(event.target))
      ) return
      setMoreOpen(false)
    }
    const closeOnKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMoreOpen(false)
      moreButtonRef.current?.focus()
    }
    window.addEventListener('pointerdown', closeOnPointerDown, true)
    window.addEventListener('keydown', closeOnKeydown, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown, true)
      window.removeEventListener('keydown', closeOnKeydown, true)
    }
  }, [moreOpen])

  const sendViewerSize = useCallback((socket = socketRef.current, claim = false) => {
    const viewport = viewportRef.current
    if (!viewport || !socket || socket.readyState !== WebSocket.OPEN) return
    const width = Math.round(viewport.clientWidth)
    const height = Math.round(viewport.clientHeight)
    if (width <= 0 || height <= 0) return
    socket.send(JSON.stringify({
      type: 'resize',
      generation: resource.generation,
      width,
      height,
      deviceScaleFactor: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
      claim,
    }))
  }, [resource.generation])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined
    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null
        sendViewerSize()
      })
    })
    observer.observe(viewport)
    return () => {
      observer.disconnect()
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
    }
  }, [sendViewerSize])

  useEffect(() => {
    const claimViewport = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        sendViewerSize(undefined, true)
      }
    }
    window.addEventListener('focus', claimViewport)
    document.addEventListener('visibilitychange', claimViewport)
    return () => {
      window.removeEventListener('focus', claimViewport)
      document.removeEventListener('visibilitychange', claimViewport)
    }
  }, [sendViewerSize])

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
        sendViewerSize(socket, document.visibilityState === 'visible' && document.hasFocus())
      }
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data)) as {
          type: string
          data?: string
          format?: 'jpeg' | 'png'
          viewport?: { width: number; height: number }
          resource?: BrowserResource
          message?: string
        }
        if (message.type === 'browser-state' && message.resource) {
          onResource(message.resource)
          return
        }
        if (message.type === 'browser-error') {
          setViewerError(message.message || copy.viewerFailed)
          return
        }
        if (message.type !== 'browser-frame' || !message.data) return
        const sequence = ++imageSequenceRef.current
        const image = new Image()
        image.onload = () => {
          if (sequence !== imageSequenceRef.current) return
          if (paintFrameRef.current !== null) window.cancelAnimationFrame(paintFrameRef.current)
          paintFrameRef.current = window.requestAnimationFrame(() => {
            paintFrameRef.current = null
            if (sequence !== imageSequenceRef.current) return
            const canvas = canvasRef.current
            const context = canvas?.getContext('2d')
            if (!canvas || !context) return
            const frameViewport = message.viewport
              && Number.isFinite(message.viewport.width)
              && Number.isFinite(message.viewport.height)
              ? message.viewport
              : { width: image.naturalWidth, height: image.naturalHeight }
            frameViewportRef.current = frameViewport
            canvas.width = image.naturalWidth
            canvas.height = image.naturalHeight
            canvas.style.width = `${frameViewport.width}px`
            canvas.style.height = `${frameViewport.height}px`
            context.drawImage(image, 0, 0)
          })
        }
        image.src = `data:image/${message.format === 'png' ? 'png' : 'jpeg'};base64,${message.data}`
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        setConnected(false)
        if (!cancelled) reconnectTimer = window.setTimeout(connect, 1_000)
      }
      socket.onerror = () => setViewerError(copy.connectionFailed)
    }
    connect()
    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      if (paintFrameRef.current !== null) window.cancelAnimationFrame(paintFrameRef.current)
      paintFrameRef.current = null
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [copy.connectionFailed, copy.viewerFailed, onResource, resource.id, resource.status, sendViewerSize])

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ ...message, generation: resource.generation }))
  }, [resource.generation])

  const point = (event: {
    currentTarget: HTMLCanvasElement
    clientX: number
    clientY: number
  }) => {
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    const frameViewport = frameViewportRef.current
    return {
      x: (event.clientX - bounds.left) * (frameViewport?.width || canvas.width) / Math.max(1, bounds.width),
      y: (event.clientY - bounds.top) * (frameViewport?.height || canvas.height) / Math.max(1, bounds.height),
    }
  }
  const navigate = async () => {
    const submittedAddress = (addressInputRef.current?.value ?? address).trim()
    try {
      const normalized = /^https?:\/\//i.test(submittedAddress) || submittedAddress === 'about:blank'
        ? submittedAddress
        : `http://${submittedAddress}`
      const response = await fetch(appPath(`/api/browsers/${encodeURIComponent(resource.id)}/navigate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url: normalized }),
      })
      const next = await response.json() as BrowserResource & { error?: string }
      if (!response.ok) throw new Error(next.error || copy.navigationFailed)
      addressEditingRef.current = false
      setAddress(next.url)
      onResource(next)
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : copy.navigationFailed)
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
        <button
          type="button"
          className="farming-browser-toolbar-icon farming-browser-agent-return"
          aria-label={copy.backToAgent}
          title={copy.backToAgent}
          onClick={onBackToAgent}
        >
          <BackToAgentGlyph />
        </button>
        <span className="farming-browser-toolbar-separator" aria-hidden="true" />
        <button type="button" className="farming-browser-toolbar-icon" aria-label={copy.back} title={copy.back} disabled={resource.status !== 'running'} onClick={() => void browserAction('back')}><ArrowLeftGlyph /></button>
        <button type="button" className="farming-browser-toolbar-icon" aria-label={copy.forward} title={copy.forward} disabled={resource.status !== 'running'} onClick={() => void browserAction('forward')}><ArrowRightGlyph /></button>
        <button type="button" className="farming-browser-toolbar-icon" aria-label={copy.reload} title={copy.reload} disabled={resource.status !== 'running'} onClick={() => void browserAction('reload')}><ReloadGlyph /></button>
        <form onSubmit={event => {
          event.preventDefault()
          void navigate()
        }}>
          <input
            ref={addressInputRef}
            value={address}
            aria-label={copy.address}
            disabled={resource.status !== 'running'}
            onChange={event => {
              addressEditingRef.current = true
              setAddress(event.currentTarget.value)
            }}
            onBlur={() => {
              addressEditingRef.current = false
              setAddress(resource.url)
            }}
          />
          <span className={`farming-browser-connection ${connected ? 'connected' : ''}`} title={connected ? copy.connected : copy.disconnected} />
        </form>
        <div className="farming-browser-more-wrap">
          <button
            ref={moreButtonRef}
            type="button"
            className="farming-browser-toolbar-icon"
            aria-label={copy.more}
            title={copy.more}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(current => !current)}
          >
            <MoreGlyph />
          </button>
          {moreOpen ? (
            <div ref={moreMenuRef} className="farming-browser-more-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false)
                  const stableUrl = new URL(window.location.href)
                  stableUrl.searchParams.set('browser', resource.id)
                  void navigator.clipboard.writeText(stableUrl.href)
                }}
              >
                <CopyGlyph />
                <span>{copy.copyLink}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={resource.status === 'starting' || resource.status === 'stopping'}
                onClick={() => {
                  setMoreOpen(false)
                  const transition = resource.status === 'running'
                    ? controller.stop(resource.id)
                    : controller.start(resource.id)
                  void transition.catch(error => setViewerError(error instanceof Error ? error.message : copy.transitionFailed))
                }}
              >
                {resource.status === 'running' ? <SquareGlyph /> : <PlayGlyph />}
                <span>{resource.status === 'running' ? copy.stop : copy.start}</span>
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <div ref={viewportRef} className="farming-browser-viewport">
        {resource.status === 'running' ? (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            aria-label={copy.pageLabel(resource.name)}
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
            <strong>{resource.status === 'failed' ? copy.failedTitle : copy.stoppedTitle}</strong>
            <p>{resource.error || copy.stoppedHint}</p>
            <button type="button" onClick={() => void controller.start(resource.id).catch(error => setViewerError(error.message))}>
              <PlayGlyph />
              <span>{copy.startBrowser}</span>
            </button>
          </div>
        )}
        <textarea
          ref={textInputRef}
          className="farming-browser-text-input-proxy"
          aria-label={copy.textInput}
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
