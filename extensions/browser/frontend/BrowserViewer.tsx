import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeftGlyph, ArrowRightGlyph, BackToAgentGlyph, ChatBubblesGlyph, CopyGlyph, MoreHorizontalGlyph, PlayGlyph, SquareGlyph } from '@/components/IconGlyphs'
import { appPath } from '@/lib/base-path'
import type { UiPreferences } from '@/lib/ui-preferences'
import {
  BrowserViewerInputScheduler,
  type BrowserViewerInputMessage,
} from './browser-viewer-input-scheduler'
import { applyBrowserViewerCanvasSize } from './browser-viewer-rendering'
import type { BrowserResource } from './types'
import type { BrowserResourcesController } from './useBrowserResources'

function viewerWebSocketUrl(resourceId: string) {
  const url = new URL(appPath(`/api/browsers/${encodeURIComponent(resourceId)}/viewer`), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function viewerCopy(language: UiPreferences['language']) {
  const zh = language === 'zh'
  return {
    back: zh ? '后退' : 'Back',
    backToAgent: zh ? '返回 Agent' : 'Back to Agent',
    showAgent: zh ? '在右侧显示 Agent' : 'Show Agent beside resource',
    hideAgent: zh ? '关闭右侧 Agent' : 'Hide Agent beside resource',
    forward: zh ? '前进' : 'Forward',
    reload: zh ? '重新加载' : 'Reload',
    stopLoading: zh ? '停止加载' : 'Stop loading',
    address: zh ? '浏览器地址' : 'Browser address',
    connected: zh ? 'Viewer 已连接' : 'Viewer connected',
    disconnected: zh ? 'Viewer 未连接' : 'Viewer disconnected',
    sharedControl: (name: string) => zh ? `共享控制 · ${name}` : `Shared control · ${name}`,
    sharedControlTitle: (name: string) => zh
      ? `你和 ${name} 都可以控制这个浏览器标签页。`
      : `You and ${name} can both control this browser tab.`,
    agentControl: (name: string) => zh
      ? `Agent 控制 · ${name}`
      : `Agent control · ${name}`,
    agentControlsHint: zh ? 'Agent 正在控制；接管后可输入和导航。' : 'The Agent controls this tab. Take control to navigate or type.',
    userControl: zh ? '你正在控制' : 'You have control',
    userControlsHint: zh ? '你正在控制此标签页。' : 'You control this tab.',
    takeControl: zh ? '接管' : 'Take control',
    returnControl: zh ? '归还给 Agent' : 'Return to Agent',
    newTab: zh ? '新建标签页' : 'New tab',
    closeTab: zh ? '关闭标签页' : 'Close tab',
    zoomIn: zh ? '放大' : 'Zoom in',
    zoomOut: zh ? '缩小' : 'Zoom out',
    resetZoom: zh ? '重置缩放' : 'Reset zoom',
    nativeUnavailable: zh
      ? '此 Browser 需要其已租用的 Farming Desktop 原生视图。'
      : 'This Browser requires its leased Farming Desktop native view.',
    nativeLeasedElsewhere: zh
      ? '此 Browser 已租给另一个 Farming Desktop 窗口。请在该窗口中查看或接管。'
      : 'This Browser is leased to another Farming Desktop window. View or take control there.',
    nativeReady: zh ? '原生视图已准备好' : 'Native view is ready',
    nativeLoading: zh ? '正在挂载原生视图…' : 'Mounting native view…',
    copyLink: zh ? '复制链接' : 'Copy link',
    more: zh ? '更多' : 'More',
    start: zh ? '启动' : 'Start',
    stop: zh ? '停止' : 'Stop',
    startBrowser: zh ? '启动标签页' : 'Start Tab',
    stoppedTitle: zh ? '标签页已停止' : 'Tab stopped',
    failedTitle: zh ? '标签页失败' : 'Tab failed',
    reconnectingTitle: zh ? '正在重新连接标签页' : 'Reconnecting tab',
    reconnectingHint: zh ? '重连窗口有限，超时后将明确结束预览。' : 'The reconnect window is bounded; the preview will stop if it expires.',
    stoppedHint: zh ? '启动后，用户和 Agent 将操作同一个标签页。' : 'Start it to share one tab between the user and Agent.',
    pageLabel: (name: string) => zh ? `${name} 浏览器页面` : `${name} browser page`,
    textInput: zh ? '浏览器文本输入' : 'Browser text input',
    viewerFailed: zh ? 'Browser Viewer 失败' : 'Browser Viewer failed',
    connectionFailed: zh ? 'Browser Viewer 连接失败' : 'Browser Viewer connection failed',
    navigationFailed: zh ? '导航失败' : 'Navigation failed',
    transitionFailed: zh ? '浏览器状态切换失败' : 'Browser transition failed',
  }
}

function emptyViewerMetrics() {
  return {
    canvasResizes: 0,
    framesDecoded: 0,
    framesPainted: 0,
    framesReceived: 0,
    framesReplaced: 0,
    lastDecodeMs: 0,
    maxDecodeMs: 0,
    maxSocketBufferedBytes: 0,
    movesReceived: 0,
    movesSent: 0,
    wheelsReceived: 0,
    wheelsSent: 0,
  }
}

function ReloadGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M12.8 3.8V1.5a.5.5 0 0 1 1 0v3.6a.5.5 0 0 1-.5.5H9.7a.5.5 0 0 1 0-1h2.36A5.5 5.5 0 1 0 13.5 8a.5.5 0 0 1 1 0 6.5 6.5 0 1 1-1.7-4.2Z" />
    </svg>
  )
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M7.5 2.5a.5.5 0 0 1 1 0v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5Z" />
    </svg>
  )
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.15 2.45a.5.5 0 0 1 .7 0L8 6.59l4.15-4.14a.5.5 0 1 1 .7.7L8.7 7.3l4.15 4.15a.5.5 0 0 1-.7.7L8 8.01l-4.15 4.14a.5.5 0 1 1-.7-.7L7.3 7.3 3.15 3.15a.5.5 0 0 1 0-.7Z" />
    </svg>
  )
}

export function BrowserViewer({
  resource,
  controller,
  language,
  ownerName,
  onResource,
  onOpenResource,
  onBackToAgent,
  agentSidePanelOpen,
  onToggleAgentSidePanel,
}: {
  resource: BrowserResource
  controller: BrowserResourcesController
  language: UiPreferences['language']
  ownerName: string
  onResource: (resource: BrowserResource) => void
  onOpenResource: (resource: BrowserResource) => void
  onBackToAgent: () => void
  agentSidePanelOpen: boolean
  onToggleAgentSidePanel?: () => void
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
  const paintFrameRef = useRef<number | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const nativeMountFrameRef = useRef<number | null>(null)
  const nativeSelectionRef = useRef<{
    key: string
    promise: Promise<BrowserResource> | null
    selected: boolean
  } | null>(null)
  const frameViewportRef = useRef<{ width: number; height: number } | null>(null)
  const viewerMetricsRef = useRef(emptyViewerMetrics())
  const resourceGenerationRef = useRef(resource.generation)
  resourceGenerationRef.current = resource.generation
  const nativeBrowser = window.farmingDesktop?.nativeBrowser
  const nativeDesktopResource = resource.browserSource === 'desktop'
  const nativeDesktopAvailable = nativeDesktopResource
    && Boolean(nativeBrowser)
    && resource.desktopAdapterId === nativeBrowser?.adapterId
  const nativeLeaseMessage = nativeDesktopResource
    && nativeBrowser
    && resource.desktopAdapterId
    && resource.desktopAdapterId !== nativeBrowser.adapterId
    ? copy.nativeLeasedElsewhere
    : copy.nativeUnavailable
  const nativeUserControl = resource.controlOwner === 'user'
  const selectNativeTab = controller.selectNativeTab
  const nativeSessionResources = resource.sessionId
    ? controller.resources.filter(candidate => (
        candidate.browserSource === 'desktop'
        && candidate.desktopAdapterId === resource.desktopAdapterId
        && candidate.sessionId === resource.sessionId
        && candidate.status === 'running'
      ))
    : []
  const inputSchedulerRef = useRef<BrowserViewerInputScheduler | null>(null)
  if (!inputSchedulerRef.current) {
    inputSchedulerRef.current = new BrowserViewerInputScheduler(
      message => {
        const socket = socketRef.current
        if (!socket || socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ ...message, generation: resourceGenerationRef.current }))
        const metrics = viewerMetricsRef.current
        if (message.type === 'pointer' && message.action === 'move') metrics.movesSent += 1
        if (message.type === 'wheel') metrics.wheelsSent += 1
        metrics.maxSocketBufferedBytes = Math.max(metrics.maxSocketBufferedBytes, socket.bufferedAmount)
      },
      callback => window.requestAnimationFrame(callback),
      frame => window.cancelAnimationFrame(frame),
    )
  }
  const [address, setAddress] = useState(resource.url)
  const [connected, setConnected] = useState(false)
  const [navigating, setNavigating] = useState(false)
  const [viewerError, setViewerError] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [nativeZoomFactor, setNativeZoomFactor] = useState(1)
  const activeRuntime = resource.status === 'running' || resource.status === 'reconnecting'

  useEffect(() => {
    if (!addressEditingRef.current) setAddress(resource.url)
  }, [resource.url])

  useEffect(() => {
    if (window.localStorage.getItem('farmingBrowserViewerMetrics') !== '1') return undefined
    const timer = window.setInterval(() => {
      console.info('[Farming Browser Viewer metrics]', {
        resourceId: resource.id,
        ...viewerMetricsRef.current,
      })
      viewerMetricsRef.current = emptyViewerMetrics()
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [resource.id])

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

  const nativeAction = useCallback(async (
    operation: 'back' | 'forward' | 'get-zoom' | 'navigate' | 'reload' | 'reset-zoom' | 'set-zoom' | 'stop-loading' | 'zoom-in' | 'zoom-out',
    input: Record<string, unknown> = {},
    target: BrowserResource = resource,
  ) => {
    if (
      !nativeBrowser
      || target.browserSource !== 'desktop'
      || target.desktopAdapterId !== nativeBrowser.adapterId
    ) {
      throw new Error(nativeLeaseMessage)
    }
    return controller.nativeUserAction(target.id, operation, input)
  }, [controller, nativeBrowser, nativeLeaseMessage, resource])

  useEffect(() => {
    if (
      !nativeDesktopAvailable
      || resource.status !== 'running'
      || !resource.sessionId
      || !nativeBrowser
    ) return undefined
    let disposed = false
    const selectionKey = `${resource.id}:${resource.generation}:${resource.sessionId}`
    let selection = nativeSelectionRef.current
    if (!selection || selection.key !== selectionKey) {
      selection = {
        key: selectionKey,
        promise: null,
        selected: false,
      }
      nativeSelectionRef.current = selection
    }
    const mount = () => {
      const viewport = viewportRef.current
      if (!viewport || disposed || !selection.selected) return
      const bounds = viewport.getBoundingClientRect()
      const width = Math.round(bounds.width)
      const height = Math.round(bounds.height)
      if (width <= 0 || height <= 0) return
      void nativeBrowser.mount({
        bounds: {
          height,
          width,
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
        },
        generation: resource.generation,
        resourceId: resource.id,
      }).catch(error => {
        if (!disposed) {
          setViewerError(error instanceof Error ? error.message : nativeLeaseMessage)
        }
      })
    }
    const scheduleMount = () => {
      if (!selection.selected) return
      if (nativeMountFrameRef.current !== null) {
        window.cancelAnimationFrame(nativeMountFrameRef.current)
      }
      nativeMountFrameRef.current = window.requestAnimationFrame(() => {
        nativeMountFrameRef.current = null
        mount()
      })
    }
    const viewport = viewportRef.current
    const observer = viewport ? new ResizeObserver(scheduleMount) : null
    if (viewport) observer?.observe(viewport)
    void (async () => {
      try {
        if (!selection.promise) {
          selection.promise = selectNativeTab(resource.id).then(selected => {
            if (nativeSelectionRef.current === selection) selection.selected = true
            return selected
          })
        }
        const selected = await selection.promise
        if (disposed || nativeSelectionRef.current !== selection) return
        onResource(selected)
        scheduleMount()
      } catch (error) {
        if (nativeSelectionRef.current === selection) selection.promise = null
        if (!disposed) {
          setViewerError(error instanceof Error ? error.message : nativeLeaseMessage)
        }
      }
    })()
    return () => {
      disposed = true
      observer?.disconnect()
      if (nativeMountFrameRef.current !== null) {
        window.cancelAnimationFrame(nativeMountFrameRef.current)
        nativeMountFrameRef.current = null
      }
      void nativeBrowser.unmount({
        generation: resource.generation,
        resourceId: resource.id,
      }).catch(() => {})
    }
  }, [
    nativeLeaseMessage,
    nativeBrowser,
    nativeDesktopAvailable,
    onResource,
    resource.generation,
    resource.id,
    resource.sessionId,
    resource.status,
    selectNativeTab,
  ])

  useEffect(() => {
    if (!nativeDesktopAvailable || !nativeUserControl || resource.status !== 'running') return
    void nativeAction('get-zoom').then(result => {
      const zoomFactor = Number(result.zoomFactor)
      if (Number.isFinite(zoomFactor)) setNativeZoomFactor(zoomFactor)
    }).catch(() => {})
  }, [nativeAction, nativeDesktopAvailable, nativeUserControl, resource.status])

  useEffect(() => {
    if (nativeDesktopResource) return undefined
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
  }, [nativeDesktopResource, sendViewerSize])

  useEffect(() => {
    if (nativeDesktopResource) return undefined
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
  }, [nativeDesktopResource, sendViewerSize])

  useEffect(() => {
    if (nativeDesktopResource) {
      setConnected(false)
      socketRef.current?.close()
      socketRef.current = null
      return undefined
    }
    if (resource.status !== 'running') {
      setConnected(false)
      socketRef.current?.close()
      socketRef.current = null
      return undefined
    }
    let cancelled = false
    let reconnectTimer = 0
    let decodingFrame = false
    let pendingFrame: {
      data: string
      format?: 'jpeg' | 'png'
      viewport?: { width: number; height: number }
    } | null = null
    const decodeNextFrame = () => {
      const message = pendingFrame
      if (!message) {
        decodingFrame = false
        return
      }
      pendingFrame = null
      decodingFrame = true
      const decodeStartedAt = window.performance.now()
      const image = new Image()
      image.onload = () => {
        if (cancelled) return
        const decodeMs = window.performance.now() - decodeStartedAt
        const metrics = viewerMetricsRef.current
        metrics.framesDecoded += 1
        metrics.lastDecodeMs = decodeMs
        metrics.maxDecodeMs = Math.max(metrics.maxDecodeMs, decodeMs)
        if (paintFrameRef.current !== null) window.cancelAnimationFrame(paintFrameRef.current)
        paintFrameRef.current = window.requestAnimationFrame(() => {
          paintFrameRef.current = null
          if (cancelled) return
          const canvas = canvasRef.current
          const context = canvas?.getContext('2d')
          if (!canvas || !context) return
          const frameViewport = message.viewport
            && Number.isFinite(message.viewport.width)
            && Number.isFinite(message.viewport.height)
            ? message.viewport
            : { width: image.naturalWidth, height: image.naturalHeight }
          frameViewportRef.current = frameViewport
          const paintMetrics = viewerMetricsRef.current
          if (applyBrowserViewerCanvasSize(
            canvas,
            image.naturalWidth,
            image.naturalHeight,
            frameViewport,
          )) paintMetrics.canvasResizes += 1
          context.drawImage(image, 0, 0)
          paintMetrics.framesPainted += 1
        })
        decodeNextFrame()
      }
      image.onerror = () => {
        if (!cancelled) decodeNextFrame()
      }
      image.src = `data:image/${message.format === 'png' ? 'png' : 'jpeg'};base64,${message.data}`
    }
    const connect = () => {
      if (cancelled) return
      const socket = new WebSocket(viewerWebSocketUrl(resource.id))
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
        if (message.type === 'browser-tab-opened' && message.resource) {
          onResource(message.resource)
          onOpenResource(message.resource)
          return
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
        const metrics = viewerMetricsRef.current
        metrics.framesReceived += 1
        if (pendingFrame) metrics.framesReplaced += 1
        pendingFrame = {
          data: message.data,
          format: message.format,
          viewport: message.viewport,
        }
        if (!decodingFrame) decodeNextFrame()
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
      pendingFrame = null
      inputSchedulerRef.current?.clear()
      window.clearTimeout(reconnectTimer)
      if (paintFrameRef.current !== null) window.cancelAnimationFrame(paintFrameRef.current)
      paintFrameRef.current = null
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [
    copy.connectionFailed,
    copy.viewerFailed,
    nativeDesktopResource,
    onOpenResource,
    onResource,
    resource.id,
    resource.status,
    sendViewerSize,
  ])

  const send = useCallback((message: BrowserViewerInputMessage) => {
    if (nativeDesktopResource) {
      inputSchedulerRef.current?.clear()
      setViewerError(nativeUserControl ? nativeLeaseMessage : copy.takeControl)
      return
    }
    const metrics = viewerMetricsRef.current
    if (message.type === 'pointer' && message.action === 'move') metrics.movesReceived += 1
    if (message.type === 'wheel') metrics.wheelsReceived += 1
    inputSchedulerRef.current?.enqueue(message)
  }, [copy.takeControl, nativeDesktopResource, nativeLeaseMessage, nativeUserControl])

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
    setNavigating(true)
    setViewerError('')
    try {
      if (nativeDesktopResource && !nativeUserControl) {
        throw new Error(copy.takeControl)
      }
      let target = resource
      if (resource.status === 'stopped' || resource.status === 'failed') {
        const started = await controller.start(resource.id)
        onResource(started)
        target = started
      }
      if (nativeDesktopResource) {
        const result = await nativeAction('navigate', { url: submittedAddress }, target)
        addressEditingRef.current = false
        setAddress(String(result.url || submittedAddress))
        onResource(result)
        return
      }
      const response = await fetch(appPath(`/api/browsers/${encodeURIComponent(resource.id)}/navigate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url: submittedAddress }),
      })
      const next = await response.json() as BrowserResource & { error?: string }
      if (!response.ok) throw new Error(next.error || copy.navigationFailed)
      addressEditingRef.current = false
      setAddress(next.url)
      setViewerError('')
      onResource(next)
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : copy.navigationFailed)
    } finally {
      setNavigating(false)
    }
  }
  const browserAction = async (kind: 'back' | 'forward' | 'reload' | 'stop-loading') => {
    setNavigating(true)
    setViewerError('')
    try {
      if (nativeDesktopResource && !nativeUserControl) {
        throw new Error(copy.takeControl)
      }
      if (nativeDesktopResource) {
        const result = await nativeAction(kind)
        if (typeof result.url === 'string') setAddress(result.url)
        onResource(result)
        return
      }
      const response = await fetch(appPath(`/api/browsers/${encodeURIComponent(resource.id)}/action`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ kind }),
      })
      const next = await response.json() as BrowserResource & { error?: string }
      if (!response.ok) throw new Error(next.error || `Browser ${kind} failed`)
      setViewerError('')
      onResource(next)
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : `Browser ${kind} failed`)
    } finally {
      setNavigating(false)
    }
  }
  const changeNativeControl = async (owner: 'agent' | 'user') => {
    setViewerError('')
    try {
      const next = await controller.takeControl(resource.id, owner)
      onResource(next)
      if (owner === 'user') {
        await window.farmingDesktop?.nativeBrowser?.focus({
          generation: next.generation,
          resourceId: next.id,
        })
      }
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : copy.transitionFailed)
    }
  }
  const createNativeTab = async () => {
    if (!nativeUserControl) {
      setViewerError(copy.takeControl)
      return
    }
    setViewerError('')
    try {
      const created = await controller.createNativeTab(resource.id)
      onResource(created)
      onOpenResource(created)
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : copy.transitionFailed)
    }
  }
  const switchNativeTab = async (target: BrowserResource) => {
    setViewerError('')
    try {
      const selected = await controller.selectNativeTab(target.id)
      onResource(selected)
      onOpenResource(selected)
      if (selected.controlOwner === 'user') {
        await window.farmingDesktop?.nativeBrowser?.focus({
          generation: selected.generation,
          resourceId: selected.id,
        })
      }
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : copy.transitionFailed)
    }
  }
  const closeNativeTab = async (target: BrowserResource) => {
    if (!nativeUserControl) {
      setViewerError(copy.takeControl)
      return
    }
    setViewerError('')
    try {
      const remaining = nativeSessionResources.filter(candidate => candidate.id !== target.id)
      const stopped = await controller.stop(target.id)
      onResource(stopped)
      if (target.id === resource.id) {
        const next = remaining.find(candidate => candidate.id !== target.id)
        if (next) onOpenResource(next)
        else onBackToAgent()
      }
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : copy.transitionFailed)
    }
  }
  const changeNativeZoom = async (operation: 'zoom-in' | 'zoom-out' | 'reset-zoom') => {
    if (!nativeUserControl) {
      setViewerError(copy.takeControl)
      return
    }
    setViewerError('')
    try {
      const result = await nativeAction(operation)
      const zoomFactor = Number(result.zoomFactor)
      if (Number.isFinite(zoomFactor)) setNativeZoomFactor(zoomFactor)
      onResource(result)
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : copy.transitionFailed)
    }
  }
  const toolbarConnected = nativeDesktopResource
    ? nativeDesktopAvailable && resource.status === 'running'
    : connected
  const primaryBrowserAction = resource.loading ? 'stop-loading' : 'reload'
  const primaryBrowserActionCopy = resource.loading ? copy.stopLoading : copy.reload
  const visibleError = viewerError || (nativeDesktopResource ? resource.error : '')

  return (
    <section className="farming-browser-viewer" data-testid="farming-browser-viewer">
      <header className={`farming-browser-toolbar ${nativeDesktopResource ? 'native' : ''}`.trim()}>
        {nativeDesktopResource ? (
          <div className="farming-browser-native-tabs" role="tablist" aria-label={copy.pageLabel(resource.name)}>
            {nativeSessionResources.map(tab => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className={`farming-browser-native-tab ${tab.id === resource.id ? 'selected' : ''}`.trim()}
                aria-selected={tab.id === resource.id}
                title={tab.title || tab.url || tab.name}
                onClick={() => void switchNativeTab(tab)}
              >
                <span>{tab.title || tab.name || tab.url}</span>
              </button>
            ))}
            <button
              type="button"
              className="farming-browser-toolbar-icon farming-browser-native-new-tab"
              aria-label={copy.newTab}
              title={copy.newTab}
              disabled={!nativeUserControl || resource.status !== 'running'}
              onClick={() => void createNativeTab()}
            >
              <PlusGlyph />
            </button>
          </div>
        ) : null}
        <div className="farming-browser-toolbar-actions">
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
          <button
            type="button"
            className="farming-browser-toolbar-icon"
            aria-label={copy.back}
            title={copy.back}
            disabled={resource.status !== 'running' || (nativeDesktopResource && !nativeUserControl)}
            onClick={() => void browserAction('back')}
          >
            <ArrowLeftGlyph />
          </button>
          <button
            type="button"
            className="farming-browser-toolbar-icon"
            aria-label={copy.forward}
            title={copy.forward}
            disabled={resource.status !== 'running' || (nativeDesktopResource && !nativeUserControl)}
            onClick={() => void browserAction('forward')}
          >
            <ArrowRightGlyph />
          </button>
          <button
            type="button"
            className="farming-browser-toolbar-icon"
            aria-label={primaryBrowserActionCopy}
            title={primaryBrowserActionCopy}
            disabled={resource.status !== 'running' || (nativeDesktopResource && !nativeUserControl)}
            onClick={() => void browserAction(primaryBrowserAction)}
          >
            {primaryBrowserAction === 'stop-loading' ? <SquareGlyph /> : <ReloadGlyph />}
          </button>
          <form aria-busy={navigating} onSubmit={event => {
            event.preventDefault()
            void navigate()
          }}>
            <input
              ref={addressInputRef}
              value={address}
              aria-label={copy.address}
              disabled={
                resource.status === 'starting'
                || resource.status === 'reconnecting'
                || resource.status === 'stopping'
                || (nativeDesktopResource && !nativeUserControl)
              }
              onChange={event => {
                addressEditingRef.current = true
                setAddress(event.currentTarget.value)
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                void navigate()
              }}
              onBlur={() => {
                addressEditingRef.current = false
                setAddress(resource.url)
              }}
            />
            <span
              className={`farming-browser-connection ${toolbarConnected ? 'connected' : ''} ${navigating ? 'navigating' : ''}`}
              title={toolbarConnected ? (nativeDesktopResource ? copy.nativeReady : copy.connected) : copy.disconnected}
            />
          </form>
          {nativeDesktopResource ? (
            <>
              <span
                className={`farming-browser-controller native ${nativeUserControl ? 'user' : 'agent'}`.trim()}
                data-testid="farming-browser-controller"
                title={nativeUserControl ? copy.userControlsHint : copy.agentControlsHint}
              >
                <span aria-hidden="true" />
                <strong>{nativeUserControl ? copy.userControl : copy.agentControl(ownerName)}</strong>
              </span>
              <button
                type="button"
                className="farming-browser-native-control"
                disabled={resource.status !== 'running' || !nativeDesktopAvailable}
                onClick={() => void changeNativeControl(nativeUserControl ? 'agent' : 'user')}
              >
                {nativeUserControl ? copy.returnControl : copy.takeControl}
              </button>
              <div className="farming-browser-native-zoom" aria-label={`${Math.round(nativeZoomFactor * 100)}%`}>
                <button
                  type="button"
                  className="farming-browser-toolbar-icon"
                  aria-label={copy.zoomOut}
                  title={copy.zoomOut}
                  disabled={!nativeUserControl || resource.status !== 'running'}
                  onClick={() => void changeNativeZoom('zoom-out')}
                >
                  −
                </button>
                <button
                  type="button"
                  className="farming-browser-native-zoom-value"
                  title={copy.resetZoom}
                  disabled={!nativeUserControl || resource.status !== 'running'}
                  onClick={() => void changeNativeZoom('reset-zoom')}
                >
                  {Math.round(nativeZoomFactor * 100)}%
                </button>
                <button
                  type="button"
                  className="farming-browser-toolbar-icon"
                  aria-label={copy.zoomIn}
                  title={copy.zoomIn}
                  disabled={!nativeUserControl || resource.status !== 'running'}
                  onClick={() => void changeNativeZoom('zoom-in')}
                >
                  +
                </button>
              </div>
              <button
                type="button"
                className="farming-browser-toolbar-icon"
                aria-label={copy.closeTab}
                title={copy.closeTab}
                disabled={!nativeUserControl || resource.status !== 'running'}
                onClick={() => void closeNativeTab(resource)}
              >
                <CloseGlyph />
              </button>
            </>
          ) : ownerName ? (
            <span
              className={`farming-browser-controller ${resource.status === 'reconnecting' ? 'reconnecting' : ''}`.trim()}
              data-testid="farming-browser-controller"
              title={copy.sharedControlTitle(ownerName)}
            >
              <span aria-hidden="true" />
              <strong>{copy.sharedControl(ownerName)}</strong>
            </span>
          ) : null}
          {onToggleAgentSidePanel ? (
            <button
              type="button"
              className={`farming-browser-toolbar-icon code-resource-agent-toggle ${agentSidePanelOpen ? 'active' : ''}`.trim()}
              data-testid="code-resource-agent-toggle"
              aria-label={agentSidePanelOpen ? copy.hideAgent : copy.showAgent}
              title={agentSidePanelOpen ? copy.hideAgent : copy.showAgent}
              aria-pressed={agentSidePanelOpen}
              onClick={onToggleAgentSidePanel}
            >
              <ChatBubblesGlyph />
            </button>
          ) : null}
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
              <MoreHorizontalGlyph />
            </button>
            {moreOpen ? (
              <div ref={moreMenuRef} className="farming-browser-more-menu code-menu-surface code-menu-list" role="menu">
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
                    const transition = activeRuntime
                      ? controller.stop(resource.id)
                      : controller.start(resource.id)
                    void transition.then(onResource).catch(error => {
                      setViewerError(error instanceof Error ? error.message : copy.transitionFailed)
                    })
                  }}
                >
                  {activeRuntime ? <SquareGlyph /> : <PlayGlyph />}
                  <span>{activeRuntime ? copy.stop : copy.start}</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div ref={viewportRef} className="farming-browser-viewport">
        {resource.status === 'running' && nativeDesktopResource ? (
          nativeDesktopAvailable ? (
            <div
              className="farming-browser-native-surface"
              aria-label={copy.pageLabel(resource.name)}
              data-testid="farming-browser-native-surface"
            >
              <span>{copy.nativeLoading}</span>
            </div>
          ) : (
            <div className="farming-browser-placeholder farming-browser-native-unavailable">
              <strong>{nativeLeaseMessage}</strong>
              <p>{resource.error || nativeLeaseMessage}</p>
            </div>
          )
        ) : resource.status === 'running' ? (
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
              window.requestAnimationFrame(() => textInputRef.current?.focus({ preventScroll: true }))
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
            <strong>{resource.status === 'reconnecting'
              ? copy.reconnectingTitle
              : resource.status === 'failed' ? copy.failedTitle : copy.stoppedTitle}</strong>
            <p>{resource.status === 'reconnecting'
              ? copy.reconnectingHint
              : resource.error || copy.stoppedHint}</p>
            {resource.status !== 'reconnecting' ? (
              <button type="button" onClick={() => void controller.start(resource.id).catch(error => setViewerError(error.message))}>
                <PlayGlyph />
                <span>{copy.startBrowser}</span>
              </button>
            ) : null}
          </div>
        )}
        {!nativeDesktopResource ? (
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
            onCompositionEnd={event => {
              composingTextRef.current = false
              const text = event.currentTarget.value
              if (text) send({ type: 'text', text })
              event.currentTarget.value = ''
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
        ) : null}
      </div>
      {visibleError && <div className="farming-browser-viewer-error" role="alert">{visibleError}</div>}
    </section>
  )
}
