import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { useMermaidRender } from '@/hooks/useMermaidRender'
import { createMermaidRenderer, type MermaidConfig } from '@/lib/mermaid-renderer'
import { remarkStreamingContent, richContentPhase, type PendingRichContent } from '@/lib/streaming-markdown'
import { rehypeGuardInvalidKatex } from '@/lib/markdown-preview-compatibility'
import type { PluggableList } from 'unified'
import { mermaidCodeBlockSource, mermaidCodeBlockPending } from '@/lib/react-markdown-content'

type CrtTranscriptTurn = {
  status?: string
  stopReason?: string
  id?: string | null
  userMessage?: string | null
  userImages?: CrtTranscriptImage[] | null
  finalMessage?: string | null
  resultImages?: CrtTranscriptImage[] | null
}

type CrtTranscriptImage = {
  data?: string | null
  mimeType?: string | null
  url?: string | null
}

type CrtMarkdownRenderer = {
  render: (container: HTMLElement, turns: CrtTranscriptTurn[]) => void
  unmount: (container: HTMLElement) => void
}

type CrtMermaidApi = Pick<typeof import('mermaid').default, 'initialize' | 'parse' | 'render'>

declare global {
  interface Window {
    FarmingCrtMarkdownRenderer?: CrtMarkdownRenderer
    FarmingCrtMermaid?: CrtMermaidApi
  }
}

const roots = new WeakMap<HTMLElement, Root>()
let mermaidRuntimePromise: Promise<CrtMermaidApi> | null = null

function markdownUrlTransform(value: string, key: string) {
  if (key === 'src' && /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(value)) {
    return value
  }
  return defaultUrlTransform(value)
}

function transcriptImageSource(image: CrtTranscriptImage) {
  const url = String(image.url || '')
  if (/^(?:https?:\/\/|\/)/i.test(url)) return url
  if (/^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(url)) return url
  const mimeType = String(image.mimeType || '').toLowerCase()
  const data = String(image.data || '')
  if (!/^image\/(?:png|gif|jpe?g|webp)$/.test(mimeType) || !/^[a-z0-9+/=]+$/i.test(data)) return ''
  return `data:${mimeType};base64,${data}`
}

function TranscriptImages({ images, label }: { images?: CrtTranscriptImage[] | null, label: string }) {
  const visibleImages = (Array.isArray(images) ? images : [])
    .map((image, index) => ({ key: `${index}:${String(image.url || '').slice(-80)}`, src: transcriptImageSource(image) }))
    .filter((image) => image.src)
  if (visibleImages.length === 0) return null
  return (
    <div className="crt-structured-images">
      {visibleImages.map((image, index) => (
        <img key={image.key} src={image.src} alt={`${label} ${index + 1}`} loading="lazy" />
      ))}
    </div>
  )
}

const markdownComponents: Components = {
  a({ href, children, ...props }) {
    const external = typeof href === 'string' && /^(?:https?:|mailto:)/i.test(href)
    return (
      <a
        {...props}
        href={href}
        rel={external ? 'noreferrer noopener' : undefined}
        target={external ? '_blank' : undefined}
      >
        {children}
      </a>
    )
  },
  pre({ children, ...props }) {
    const mermaidSource = mermaidCodeBlockSource(children)
    if (mermaidSource !== null) return <MermaidBlock source={mermaidSource} pending={mermaidCodeBlockPending(children)} />
    return <pre {...props}>{children}</pre>
  },
}

function hashMermaidSource(source: string) {
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function loadMermaidRuntime() {
  if (window.FarmingCrtMermaid) return Promise.resolve(window.FarmingCrtMermaid)
  if (mermaidRuntimePromise) return mermaidRuntimePromise
  mermaidRuntimePromise = new Promise<CrtMermaidApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = new URL('crt-mermaid-renderer.js', document.baseURI).href
    script.async = true
    const fail = (message: string) => {
      script.remove()
      mermaidRuntimePromise = null
      reject(new Error(message))
    }
    script.onload = () => {
      const mermaid = window.FarmingCrtMermaid
      if (!mermaid) {
        fail('Mermaid runtime loaded without exposing its renderer')
        return
      }
      resolve(mermaid)
    }
    script.onerror = () => fail('Failed to load Mermaid renderer')
    document.head.appendChild(script)
  })
  return mermaidRuntimePromise
}

const crtMermaidConfig: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  themeVariables: {
    background: '#001008',
    mainBkg: '#062417',
    primaryColor: '#062417',
    primaryTextColor: '#b9e6cb',
    primaryBorderColor: '#20c977',
    secondaryColor: '#102d27',
    tertiaryColor: '#071c13',
    lineColor: '#55f59b',
    textColor: '#b9e6cb',
    fontFamily: "'Courier New', monospace",
  },
}
const renderCrtMermaid = createMermaidRenderer(loadMermaidRuntime)

function MermaidBlock({ source, pending }: { source: string; pending?: PendingRichContent }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [retry, setRetry] = useState(0)
  const renderId = `farming-crt-mermaid-${reactId}-${hashMermaidSource(source)}-${retry}`
  const figureRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const followOutputRef = useRef(false)
  const state = useMermaidRender({ source, id: renderId, pending, config: crtMermaidConfig, renderer: renderCrtMermaid })
  useLayoutEffect(() => {
    const container = figureRef.current?.closest<HTMLElement>('#terminal-output')
    if (followOutputRef.current && container) container.scrollTop = container.scrollHeight
    return () => {
      followOutputRef.current = Boolean(container && container.scrollHeight - container.scrollTop - container.clientHeight < 80)
    }
  }, [state])
  useEffect(() => {
    if (canvasRef.current) state.diagram?.bindFunctions?.(canvasRef.current)
  }, [state.diagram])
  return <figure ref={figureRef} className={`crt-markdown-mermaid ${state.status}`} data-render-state={state.status} aria-label="Mermaid diagram">
    {state.status === 'error' ? <>
      <figcaption>DIAGRAM ERROR</figcaption>
      <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button>
      <details><summary>Details and source</summary>
        <pre className="crt-markdown-mermaid-error">{state.message}</pre>
        <pre className="crt-markdown-mermaid-fallback"><code className="language-mermaid">{source}</code></pre>
      </details>
    </> : <>
      {state.status !== 'ready' && <div className="crt-markdown-mermaid-loading" role="status">
        {state.status === 'streaming' ? 'GENERATING DIAGRAM…' : state.status === 'interrupted' ? 'DIAGRAM INCOMPLETE' : 'RENDERING DIAGRAM…'}
      </div>}
      {state.diagram && <div ref={canvasRef} className="crt-markdown-mermaid-canvas" dangerouslySetInnerHTML={{ __html: state.diagram.svg }} />}
    </>}
  </figure>
}

function readingAnchorId(turn: CrtTranscriptTurn) {
  return String(turn.id || `${turn.userMessage || ''}\n${turn.finalMessage || ''}`.slice(0, 160))
}

const CrtTranscriptTurnView = memo(function CrtTranscriptTurnView({ turn }: { turn: CrtTranscriptTurn }) {
  const phase = richContentPhase(turn.status, turn.stopReason)
  const remarkPlugins = useMemo<PluggableList>(() => [remarkGfm, remarkMath, [remarkStreamingContent, { phase }]], [phase])
  const rehypePlugins = useMemo<PluggableList>(() => [[rehypeGuardInvalidKatex, { pending: phase !== 'settled' }], rehypeKatex, rehypeHighlight], [phase])
  return (
    <section className="crt-structured-turn" data-reading-anchor-id={readingAnchorId(turn)}>
      {turn.userMessage || (turn.userImages?.length ?? 0) > 0 ? (
        <div className="crt-structured-message user">
          {turn.userMessage ? <p>{turn.userMessage}</p> : null}
          <TranscriptImages images={turn.userImages} label="User image" />
        </div>
      ) : null}
      {turn.finalMessage ? (
        <div className="crt-structured-message assistant crt-markdown">
          <ReactMarkdown
            components={markdownComponents}
            rehypePlugins={rehypePlugins}
            remarkPlugins={remarkPlugins}
            skipHtml
            urlTransform={markdownUrlTransform}
          >
            {turn.finalMessage}
          </ReactMarkdown>
          <TranscriptImages images={turn.resultImages} label="Agent image" />
        </div>
      ) : (turn.resultImages?.length ?? 0) > 0 ? (
        <div className="crt-structured-message assistant">
          <TranscriptImages images={turn.resultImages} label="Agent image" />
        </div>
      ) : null}
    </section>
  )
})

function CrtTranscript({ turns }: { turns: CrtTranscriptTurn[] }) {
  return (
    <div className="crt-structured-transcript">
      {turns.length === 0 ? <div className="crt-structured-empty">No conversation yet.</div> : null}
      {turns.map((turn, index) => (
        <CrtTranscriptTurnView key={`${readingAnchorId(turn)}:${index}`} turn={turn} />
      ))}
    </div>
  )
}

function getRoot(container: HTMLElement) {
  const existing = roots.get(container)
  if (existing) return existing
  const root = createRoot(container)
  roots.set(container, root)
  return root
}

const renderer: CrtMarkdownRenderer = {
  render(container, turns) {
    flushSync(() => {
      getRoot(container).render(<CrtTranscript turns={Array.isArray(turns) ? turns : []} />)
    })
  },
  unmount(container) {
    const root = roots.get(container)
    if (!root) return
    flushSync(() => root.unmount())
    roots.delete(container)
  },
}

window.FarmingCrtMarkdownRenderer = renderer
