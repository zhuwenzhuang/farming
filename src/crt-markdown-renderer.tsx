import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

type CrtTranscriptTurn = {
  id?: string | null
  userMessage?: string | null
  finalMessage?: string | null
}

type CrtMarkdownRenderer = {
  render: (container: HTMLElement, turns: CrtTranscriptTurn[]) => void
  unmount: (container: HTMLElement) => void
}

type CrtMermaidApi = Pick<typeof import('mermaid').default, 'initialize' | 'parse' | 'render'>

type MermaidRenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string; bindFunctions?: (element: Element) => void }
  | { status: 'error'; message: string }

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
    if (mermaidSource !== null) return <MermaidBlock source={mermaidSource} />
    return <pre {...props}>{children}</pre>
  },
}

function textContent(children: unknown): string {
  if (children === null || children === undefined || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(textContent).join('')
  if (isValidElement(children)) {
    const props = children.props as { children?: unknown }
    return textContent(props.children)
  }
  return ''
}

function mermaidCodeBlockSource(children: ReactNode) {
  const child = Children.count(children) === 1 ? Children.only(children) : null
  if (!isValidElement(child)) return null
  const props = child.props as { className?: string; children?: ReactNode }
  if (!/\blanguage-mermaid\b/i.test(props.className || '')) return null
  return textContent(props.children).replace(/\n$/, '')
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
    script.onload = () => {
      const mermaid = window.FarmingCrtMermaid
      if (!mermaid) {
        reject(new Error('Mermaid runtime loaded without exposing its renderer'))
        return
      }
      mermaid.initialize({
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
      })
      resolve(mermaid)
    }
    script.onerror = () => reject(new Error('Failed to load Mermaid renderer'))
    document.head.appendChild(script)
  })
  return mermaidRuntimePromise
}

function MermaidBlock({ source }: { source: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const renderId = useMemo(() => `farming-crt-mermaid-${reactId}-${hashMermaidSource(source)}`, [reactId, source])
  const figureRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const followOutputRef = useRef(false)
  const [renderState, setRenderState] = useState<MermaidRenderState>({ status: 'loading' })

  useEffect(() => {
    if (!source.trim()) {
      setRenderState({ status: 'error', message: 'Empty Mermaid diagram' })
      return
    }
    let disposed = false
    setRenderState({ status: 'loading' })
    loadMermaidRuntime()
      .then(async mermaid => {
        await mermaid.parse(source)
        return mermaid.render(renderId, source)
      })
      .then(({ svg, bindFunctions }) => {
        if (disposed) return
        const container = figureRef.current?.closest<HTMLElement>('#terminal-output')
        followOutputRef.current = Boolean(
          container && container.scrollHeight - container.scrollTop - container.clientHeight < 80,
        )
        setRenderState({ status: 'ready', svg, bindFunctions })
      })
      .catch(error => {
        if (disposed) return
        const container = figureRef.current?.closest<HTMLElement>('#terminal-output')
        followOutputRef.current = Boolean(
          container && container.scrollHeight - container.scrollTop - container.clientHeight < 80,
        )
        setRenderState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error || 'Failed to render Mermaid diagram'),
        })
      })
    return () => {
      disposed = true
    }
  }, [renderId, source])

  useEffect(() => {
    if (renderState.status !== 'ready' || !renderState.bindFunctions || !canvasRef.current) return
    renderState.bindFunctions(canvasRef.current)
  }, [renderState])

  useLayoutEffect(() => {
    if (!followOutputRef.current) return
    followOutputRef.current = false
    const container = figureRef.current?.closest<HTMLElement>('#terminal-output')
    if (container) container.scrollTop = container.scrollHeight
  }, [renderState])

  if (!source.trim()) {
    return (
      <pre className="crt-markdown-mermaid-fallback">
        <code className="language-mermaid">{source}</code>
      </pre>
    )
  }

  if (renderState.status === 'error') {
    return (
      <figure ref={figureRef} className="crt-markdown-mermaid error" aria-label="Mermaid diagram">
        <figcaption>DIAGRAM ERROR</figcaption>
        <pre className="crt-markdown-mermaid-error">{renderState.message}</pre>
        <pre className="crt-markdown-mermaid-fallback"><code className="language-mermaid">{source}</code></pre>
      </figure>
    )
  }

  return (
    <figure ref={figureRef} className={`crt-markdown-mermaid ${renderState.status}`} aria-label="Mermaid diagram">
      {renderState.status === 'loading' ? (
        <div className="crt-markdown-mermaid-loading">RENDERING DIAGRAM...</div>
      ) : (
        <div
          ref={canvasRef}
          className="crt-markdown-mermaid-canvas"
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      )}
    </figure>
  )
}

function readingAnchorId(turn: CrtTranscriptTurn) {
  return String(turn.id || `${turn.userMessage || ''}\n${turn.finalMessage || ''}`.slice(0, 160))
}

const CrtTranscriptTurnView = memo(function CrtTranscriptTurnView({ turn }: { turn: CrtTranscriptTurn }) {
  return (
    <section className="crt-structured-turn" data-reading-anchor-id={readingAnchorId(turn)}>
      {turn.userMessage ? <p className="crt-structured-message user">{turn.userMessage}</p> : null}
      {turn.finalMessage ? (
        <div className="crt-structured-message assistant crt-markdown">
          <ReactMarkdown
            components={markdownComponents}
            rehypePlugins={[rehypeKatex, rehypeHighlight]}
            remarkPlugins={[remarkGfm, remarkMath]}
            skipHtml
            urlTransform={markdownUrlTransform}
          >
            {turn.finalMessage}
          </ReactMarkdown>
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
