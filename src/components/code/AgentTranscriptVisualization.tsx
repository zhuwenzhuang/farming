import icons from 'lucide/dist/umd/lucide.min.js?raw'
import { useEffect, useRef, useState } from 'react'
import { BookGlyph, RefreshGlyph, CloseGlyph, ScreenFullGlyph } from '@/components/IconGlyphs'
import { createWorkspaceHtmlPreview, deleteWorkspaceHtmlPreview, renewWorkspaceHtmlPreview } from '@/lib/workspace-files'
import { workspaceHtmlPreviewRefreshDelay } from '@/lib/workspace-html-preview'
import { buildWorkspaceInlineVisualizationDocument } from '@/lib/workspace-inline-visualization'
import { visualizationTheme } from '@/lib/visualization-runtime'
import { appPath } from '@/lib/base-path'
import type { AgentTranscriptUserFile } from './acp/acp-entry-projection'

const INLINE_HEIGHT_LIMIT = 1600

export function AgentTranscriptVisualization({ rootId, exactExternal, file, filePath, onOpenSource }: {
  rootId: string
  exactExternal: boolean
  file: AgentTranscriptUserFile
  filePath: string
  onOpenSource?: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const channel = useRef('')
  const [source, setSource] = useState('')
  const [failure, setFailure] = useState('')
  const [warning, setWarning] = useState('')
  const [ready, setReady] = useState(false)
  const [height, setHeight] = useState(120)
  const [expanded, setExpanded] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [revision, setRevision] = useState(0)
  const stateKey = `farming:visualization:${rootId}:${filePath}`

  const sendTheme = () => {
    if (!root.current) return
    frame.current?.contentWindow?.postMessage({ channel: channel.current, type: 'theme', ...visualizationTheme(root.current) }, '*')
  }

  useEffect(() => {
    const controller = new AbortController()
    let ownedId = ''
    let timer = 0
    let readyTimer = 0
    const key = crypto.randomUUID()
    channel.current = key
    setSource(''); setFailure(''); setWarning(''); setReady(false); setHeight(120)
    const renew = (expiresAt: number) => {
      timer = window.setTimeout(() => {
        void renewWorkspaceHtmlPreview(ownedId).then(result => {
          if (!controller.signal.aborted) renew(result.expiresAt)
        }).catch(error => {
          if (!controller.signal.aborted) setWarning(error instanceof Error ? error.message : 'Preview expired; retry to load resources')
        })
      }, workspaceHtmlPreviewRefreshDelay(expiresAt))
    }
    // The deadline cancels this view; late session creation is still reconciled and released.
    const deadline = window.setTimeout(() => { controller.abort(); setFailure('Visualization loading timed out. Retry to load again.') }, 20_000)
    void createWorkspaceHtmlPreview(rootId, filePath, { exactExternal, visualization: true, resourceRoot: file.resourceRoot || undefined })
      .then(preview => {
        if (controller.signal.aborted) { void deleteWorkspaceHtmlPreview(preview.id).catch(() => {}); return }
        ownedId = preview.id
        clearTimeout(deadline)
        const rootUrl = new URL(appPath(`/api/visualization-resources/${encodeURIComponent(preview.id)}/`), window.location.href).href
        const baseUrl = rootUrl + (preview.basePath ? `${preview.basePath}/` : '')
        setSource(buildWorkspaceInlineVisualizationDocument(preview.source || '', baseUrl, rootUrl, key, root.current ? visualizationTheme(root.current) : undefined, icons))
        renew(preview.expiresAt)
        readyTimer = window.setTimeout(() => setWarning('Visualization initialization is taking too long. A script or resource may not have loaded.'), 15_000)
      }).catch(error => {
        if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error))
      }).finally(() => clearTimeout(deadline))
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== key) return
      if (event.data.type === 'ready') { clearTimeout(readyTimer); setReady(true); sendTheme(); try { frame.current?.contentWindow?.postMessage({ channel: key, type: 'state', state: JSON.parse(sessionStorage.getItem(stateKey) || 'null') }, '*') } catch { /* Browser storage may be unavailable. */ } }
      if (event.data.type === 'state') { try { const value = JSON.stringify(event.data.state); if (new TextEncoder().encode(value).length <= 16 * 1024) sessionStorage.setItem(stateKey, value) } catch { /* Optional view state. */ } }
      if (event.data.type === 'size' && Number.isFinite(event.data.height)) setHeight(Math.max(40, Math.min(100_000, event.data.height)))
      if (event.data.type === 'error' && typeof event.data.message === 'string') setWarning(event.data.message.slice(0, 500))
      if (event.data.type === 'escape' && document.fullscreenElement === root.current) void document.exitFullscreen()
    }
    window.addEventListener('message', receive)
    const observer = new MutationObserver(sendTheme)
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-appearance'] })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-appearance'] })
    return () => {
      controller.abort(); clearTimeout(deadline); clearTimeout(timer); clearTimeout(readyTimer)
      observer.disconnect(); window.removeEventListener('message', receive)
      if (ownedId) void deleteWorkspaceHtmlPreview(ownedId).catch(() => {})
    }
  }, [rootId, filePath, exactExternal, file.resourceRoot, revision, stateKey])

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === root.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])

  const enlarge = async () => {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen()
      else if (root.current?.requestFullscreen) await root.current.requestFullscreen()
      else setExpanded(true)
    } catch { setExpanded(true) }
  }
  const clipped = height > INLINE_HEIGHT_LIMIT && !expanded && !fullscreen
  return <div ref={root} className={`code-agent-transcript-inline-visualization ${file.visualizationMode === 'wide' ? 'wide' : ''}`} data-testid="code-agent-transcript-inline-visualization">
    <header className="code-content-viewer-header code-visualization-toolbar">
      <span className="code-content-viewer-title">{fullscreen ? file.name : ''}</span>
      <div className="code-content-viewer-actions">
        {(failure || warning) && <button type="button" aria-label="Retry visualization" title="Retry visualization" onClick={() => setRevision(value => value + 1)}><RefreshGlyph /></button>}
        {onOpenSource && <button type="button" aria-label="Open visualization source" title="Open visualization source" onClick={onOpenSource}><BookGlyph /></button>}
        <button type="button" onClick={() => void enlarge()} aria-label={fullscreen ? 'Close enlarged visualization' : 'Enlarge visualization'} title={fullscreen ? 'Close enlarged visualization' : 'Enlarge visualization'}>{fullscreen ? <CloseGlyph /> : <ScreenFullGlyph />}</button>
      </div>
    </header>
    {failure ? <div className="code-visualization-status" role="alert">{failure}</div> : <>
      {!ready && <div className="code-visualization-status" role="status">Loading visualization…</div>}
      {warning && <div className="code-visualization-status" role="status">{warning}</div>}
      <div className="code-visualization-content" style={{ maxHeight: clipped ? INLINE_HEIGHT_LIMIT : undefined }}>
        {source && <iframe ref={frame} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={source} title={file.name} scrolling="no" style={{ height }} />}
      </div>
      {clipped && <button type="button" className="code-rich-content-retry code-visualization-expand" onClick={() => setExpanded(true)}>Show full visualization</button>}
    </>}
  </div>
}
