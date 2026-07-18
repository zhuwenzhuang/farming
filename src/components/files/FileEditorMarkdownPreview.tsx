import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { parse as parseYaml } from 'yaml'
import 'katex/dist/katex.min.css'
import { rawWorkspaceFileUrl } from '@/lib/workspace-files'
import { decodeMermaidCharacterReferences } from '@/lib/mermaid-source'
import { workspaceEditorBasename } from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile, WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import type { CodeCopy } from '../code/copy'

interface FileEditorMarkdownPreviewProps {
  activeTabDomId: string
  openFile: OpenWorkspaceFile
  onOpenFilePath: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  copy: CodeCopy
}

type MermaidAppearance = 'light' | 'dark'
type MermaidBindFunctions = (element: Element) => void
type MermaidRenderState =
  | { status: 'empty' | 'loading' }
  | { status: 'ready'; svg: string; bindFunctions?: MermaidBindFunctions }
  | { status: 'error'; message: string }
type MarkdownHeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
type MarkdownFrontMatterEntry = { key: string; value: string }
type MarkdownFrontMatter = {
  raw: string
  entries: MarkdownFrontMatterEntry[]
  error?: string
}
type MarkdownPreviewContextValue = {
  openFile: OpenWorkspaceFile
  onOpenFilePath: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  copy: CodeCopy
  nextHeadingId: (children: ReactNode) => string
}

const MERMAID_FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const MarkdownPreviewContext = createContext<MarkdownPreviewContextValue | null>(null)

function useMarkdownPreviewContext() {
  const value = useContext(MarkdownPreviewContext)
  if (!value) throw new Error('Markdown preview context is missing')
  return value
}

function dirname(filePath: string) {
  const parts = filePath.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

function isExternalResource(value: string) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^(?:mailto|tel):/i.test(value)
}

function normalizeWorkspaceResourcePath(basePath: string, value: string) {
  const [pathPart] = value.split(/[?#]/, 1)
  if (!pathPart || pathPart.startsWith('/') || pathPart.startsWith('#') || isExternalResource(pathPart)) return null
  const baseSegments = dirname(basePath).split('/').filter(Boolean)
  const resourceSegments = pathPart.split('/')
  const nextSegments = [...baseSegments]
  for (const segment of resourceSegments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (nextSegments.length === 0) return null
      nextSegments.pop()
      continue
    }
    nextSegments.push(segment)
  }
  return nextSegments.join('/')
}

function markdownImageUrl(openFile: OpenWorkspaceFile, src: string) {
  if (!src || src.startsWith('#') || isExternalResource(src) || src.startsWith('data:')) return src
  const workspacePath = normalizeWorkspaceResourcePath(openFile.file.path, src)
  return workspacePath ? rawWorkspaceFileUrl(openFile.agentId, workspacePath) : src
}

function markdownWorkspaceLinkPath(openFile: OpenWorkspaceFile, href: string) {
  if (!href || href.startsWith('#') || isExternalResource(href)) return null
  return normalizeWorkspaceResourcePath(openFile.file.path, href)
}

function hashMermaidSource(source: string) {
  let hash = 0
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

function textContent(children: ReactNode): string {
  if (children === null || children === undefined || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(textContent).join('')
  if (isValidElement(children)) {
    const props = children.props as { children?: ReactNode }
    return textContent(props.children)
  }
  return ''
}

function codeBlockSource(children: ReactNode) {
  return textContent(children).replace(/\n$/, '')
}

function isMermaidCodeBlock(children: ReactNode) {
  const child = Children.count(children) === 1 ? Children.only(children) : null
  if (!isValidElement(child)) return null
  const props = child.props as { className?: string; children?: ReactNode }
  if (!/\blanguage-mermaid\b/i.test(props.className || '')) return null
  return codeBlockSource(props.children)
}

function codeBlockLanguage(children: ReactNode) {
  const child = Children.count(children) === 1 ? Children.only(children) : null
  if (!isValidElement(child)) return null
  const props = child.props as { className?: string }
  return props.className?.match(/\blanguage-([a-z0-9_-]+)\b/i)?.[1] ?? null
}

function slugifyHeading(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
  return slug || 'heading'
}

function createHeadingIdFactory() {
  const counts = new Map<string, number>()
  return (children: ReactNode) => {
    const base = slugifyHeading(textContent(children))
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }
}

function formatFrontMatterValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseFrontMatter(raw: string): MarkdownFrontMatter {
  try {
    const parsed = parseYaml(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        raw,
        entries: Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
          key,
          value: formatFrontMatterValue(value),
        })),
      }
    }
    if (parsed === undefined || parsed === null) {
      return { raw, entries: [] }
    }
    return { raw, entries: [{ key: 'value', value: formatFrontMatterValue(parsed) }] }
  } catch (error) {
    return {
      raw,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function splitMarkdownFrontMatter(source: string): { body: string; frontMatter: MarkdownFrontMatter | null } {
  const normalized = source.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== '---') return { body: source, frontMatter: null }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== '---') continue
    const raw = lines.slice(1, index).join('\n')
    const body = lines.slice(index + 1).join('\n')
    return { body, frontMatter: parseFrontMatter(raw) }
  }

  return { body: source, frontMatter: null }
}

function MarkdownFrontMatterTable({ frontMatter, copy }: { frontMatter: MarkdownFrontMatter; copy: CodeCopy }) {
  if (frontMatter.error) {
    return (
      <div className="code-markdown-frontmatter error" role="note" aria-label={copy.markdownFrontMatter}>
        <strong>{copy.markdownFrontMatter}</strong>
        <pre>{frontMatter.error}</pre>
      </div>
    )
  }

  if (frontMatter.entries.length === 0) return null

  return (
    <table className="code-markdown-frontmatter" aria-label={copy.markdownFrontMatter}>
      <tbody>
        {frontMatter.entries.map(entry => (
          <tr key={entry.key}>
            <th scope="row">{entry.key}</th>
            <td>{entry.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function MarkdownHeading({
  tag,
  children,
  copy,
  nextHeadingId,
  ...props
}: HTMLAttributes<HTMLHeadingElement> & {
  tag: MarkdownHeadingTag
  children?: ReactNode
  copy: CodeCopy
  nextHeadingId: (children: ReactNode) => string
}) {
  const id = nextHeadingId(children)
  const HeadingTag = tag
  return (
    <HeadingTag {...props} id={id}>
      {children}
      <a className="code-markdown-heading-anchor" href={`#${id}`} aria-label={copy.markdownHeadingAnchor}>
        #
      </a>
    </HeadingTag>
  )
}

const MarkdownH1: Components['h1'] = ({ children, ...props }) => {
  const { copy, nextHeadingId } = useMarkdownPreviewContext()
  return (
    <MarkdownHeading {...props} tag="h1" copy={copy} nextHeadingId={nextHeadingId}>
      {children}
    </MarkdownHeading>
  )
}

const MarkdownH2: Components['h2'] = ({ children, ...props }) => {
  const { copy, nextHeadingId } = useMarkdownPreviewContext()
  return (
    <MarkdownHeading {...props} tag="h2" copy={copy} nextHeadingId={nextHeadingId}>
      {children}
    </MarkdownHeading>
  )
}

const MarkdownH3: Components['h3'] = ({ children, ...props }) => {
  const { copy, nextHeadingId } = useMarkdownPreviewContext()
  return (
    <MarkdownHeading {...props} tag="h3" copy={copy} nextHeadingId={nextHeadingId}>
      {children}
    </MarkdownHeading>
  )
}

const MarkdownH4: Components['h4'] = ({ children, ...props }) => {
  const { copy, nextHeadingId } = useMarkdownPreviewContext()
  return (
    <MarkdownHeading {...props} tag="h4" copy={copy} nextHeadingId={nextHeadingId}>
      {children}
    </MarkdownHeading>
  )
}

const MarkdownH5: Components['h5'] = ({ children, ...props }) => {
  const { copy, nextHeadingId } = useMarkdownPreviewContext()
  return (
    <MarkdownHeading {...props} tag="h5" copy={copy} nextHeadingId={nextHeadingId}>
      {children}
    </MarkdownHeading>
  )
}

const MarkdownH6: Components['h6'] = ({ children, ...props }) => {
  const { copy, nextHeadingId } = useMarkdownPreviewContext()
  return (
    <MarkdownHeading {...props} tag="h6" copy={copy} nextHeadingId={nextHeadingId}>
      {children}
    </MarkdownHeading>
  )
}

const MarkdownLink: Components['a'] = ({ href, children, onClick, ...props }) => {
  const { openFile, onOpenFilePath } = useMarkdownPreviewContext()
  const workspacePath = href ? markdownWorkspaceLinkPath(openFile, href) : null
  const external = href ? isExternalResource(href) : false
  const nextHref = workspacePath ? '#' : href
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || !workspacePath) return
    event.preventDefault()
    void onOpenFilePath(openFile.agentId, workspacePath, {
      sourceAgentId: openFile.sourceAgentId,
    })
  }
  return (
    <a
      {...props}
      href={nextHref}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
      onClick={handleClick}
    >
      {children}
    </a>
  )
}

const MarkdownImage: Components['img'] = ({ src, alt, ...props }) => {
  const { openFile } = useMarkdownPreviewContext()
  const nextSrc = src ? markdownImageUrl(openFile, src) : undefined
  return (
    <img
      {...props}
      src={nextSrc}
      alt={alt || workspaceEditorBasename(openFile.file.path)}
      draggable={false}
    />
  )
}

const MarkdownPre: Components['pre'] = ({ children, ...props }) => {
  const { copy } = useMarkdownPreviewContext()
  const mermaidSource = isMermaidCodeBlock(children)
  if (mermaidSource !== null) return <MermaidBlock source={mermaidSource} copy={copy} />
  const language = codeBlockLanguage(children)
  return <pre {...props} data-language={language || undefined}>{children}</pre>
}

const MARKDOWN_COMPONENTS: Components = {
  h1: MarkdownH1,
  h2: MarkdownH2,
  h3: MarkdownH3,
  h4: MarkdownH4,
  h5: MarkdownH5,
  h6: MarkdownH6,
  a: MarkdownLink,
  img: MarkdownImage,
  pre: MarkdownPre,
}

function currentMermaidAppearance(): MermaidAppearance {
  return typeof document !== 'undefined' && document.body?.dataset.appearance === 'dark' ? 'dark' : 'light'
}

function useMermaidAppearance() {
  const [appearance, setAppearance] = useState<MermaidAppearance>(() => currentMermaidAppearance())

  useEffect(() => {
    if (typeof document === 'undefined') return
    const updateAppearance = () => setAppearance(currentMermaidAppearance())
    updateAppearance()
    const observer = new MutationObserver(updateAppearance)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-appearance'] })
    return () => observer.disconnect()
  }, [])

  return appearance
}

function mermaidThemeVariables(appearance: MermaidAppearance) {
  if (appearance === 'dark') {
    return {
      background: '#0d1117',
      mainBkg: '#161b22',
      primaryColor: '#161b22',
      primaryTextColor: '#e6edf3',
      primaryBorderColor: '#30363d',
      secondaryColor: '#1f6feb',
      tertiaryColor: '#21262d',
      lineColor: '#8b949e',
      textColor: '#e6edf3',
      fontFamily: MERMAID_FONT,
    }
  }

  return {
    background: '#ffffff',
    mainBkg: '#f6f8fa',
    primaryColor: '#f6f8fa',
    primaryTextColor: '#24292f',
    primaryBorderColor: '#d0d7de',
    secondaryColor: '#ddf4ff',
    tertiaryColor: '#ffffff',
    lineColor: '#6e7781',
    textColor: '#24292f',
    fontFamily: MERMAID_FONT,
  }
}

function MermaidControlIcon({ kind }: { kind: 'zoomIn' | 'zoomOut' | 'reset' | 'copy' | 'pan' | 'fullscreen' | 'fullscreenExit' }) {
  if (kind === 'copy') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M5 2.5C5 1.672 5.672 1 6.5 1H12.5C13.328 1 14 1.672 14 2.5V8.5C14 9.328 13.328 10 12.5 10H11V11.5C11 12.328 10.328 13 9.5 13H3.5C2.672 13 2 12.328 2 11.5V5.5C2 4.672 2.672 4 3.5 4H5V2.5ZM6 4H9.5C10.328 4 11 4.672 11 5.5V9H12.5C12.776 9 13 8.776 13 8.5V2.5C13 2.224 12.776 2 12.5 2H6.5C6.224 2 6 2.224 6 2.5V4ZM3.5 5C3.224 5 3 5.224 3 5.5V11.5C3 11.776 3.224 12 3.5 12H9.5C9.776 12 10 11.776 10 11.5V5.5C10 5.224 9.776 5 9.5 5H3.5Z" />
      </svg>
    )
  }

  if (kind === 'reset') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M7.5 2C5.015 2 3 4.015 3 6.5H4.5L2.5 9L0.5 6.5H2C2 3.462 4.462 1 7.5 1C10.538 1 13 3.462 13 6.5C13 9.538 10.538 12 7.5 12C6.017 12 4.671 11.413 3.682 10.459L4.379 9.741C5.189 10.523 6.289 11 7.5 11C9.985 11 12 8.985 12 6.5C12 4.015 9.985 2 7.5 2Z" />
      </svg>
    )
  }

  if (kind === 'pan') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M7.5 1 5 3.5h1.75V6H4V4.25L1.5 6.75 4 9.25V7.5h2.75v2.75H5L7.5 12.75 10 10.25H8.25V7.5H11v1.75l2.5-2.5L11 4.25V6H8.25V3.5H10L7.5 1Z" />
      </svg>
    )
  }

  if (kind === 'fullscreen' || kind === 'fullscreenExit') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {kind === 'fullscreen' ? (
          <path d="M2 1h4v1H3v3H2V1Zm8 0h4v4h-1V2h-3V1ZM2 11h1v3h3v1H2v-4Zm11 0h1v4h-4v-1h3v-3Z" />
        ) : (
          <path d="M2 1h4v1H3v3H2V1Zm8 0h4v4h-1V2h-3V1ZM5 5h6v6H5V5Zm1 1v4h4V6H6Z" />
        )}
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M7 2C4.239 2 2 4.239 2 7C2 9.761 4.239 12 7 12C8.12 12 9.154 11.632 9.987 11.01L13.146 14.146L13.854 13.439L10.708 10.292C11.506 9.41 12 8.246 12 7C12 4.239 9.761 2 7 2ZM3 7C3 4.791 4.791 3 7 3C9.209 3 11 4.791 11 7C11 9.209 9.209 11 7 11C4.791 11 3 9.209 3 7ZM4.75 6.5H9.25V7.5H4.75V6.5Z" />
      {kind === 'zoomIn' && <path d="M6.5 4.75H7.5V9.25H6.5V4.75Z" />}
    </svg>
  )
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.setAttribute('autocomplete', 'off')
  textarea.setAttribute('autocorrect', 'off')
  textarea.setAttribute('autocapitalize', 'none')
  textarea.setAttribute('spellcheck', 'false')
  textarea.setAttribute('data-lpignore', 'true')
  textarea.setAttribute('data-1p-ignore', 'true')
  textarea.setAttribute('data-bwignore', 'true')
  textarea.setAttribute('data-form-type', 'other')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

export function MermaidBlock({ source, copy }: { source: string; copy: CodeCopy }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const appearance = useMermaidAppearance()
  const renderSource = useMemo(() => decodeMermaidCharacterReferences(source), [source])
  const renderId = useMemo(() => `farming-mermaid-${reactId}-${hashMermaidSource(renderSource)}-${appearance}`, [appearance, reactId, renderSource])
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const didPanRef = useRef(false)
  const [renderState, setRenderState] = useState<MermaidRenderState>({ status: renderSource.trim() ? 'loading' : 'empty' })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [panMode, setPanMode] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fullscreenCanvasSize, setFullscreenCanvasSize] = useState<{ width: number; height: number } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!renderSource.trim()) {
      setRenderState({ status: 'empty' })
      return
    }

    let disposed = false
    setRenderState({ status: 'loading' })
    import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: mermaidThemeVariables(appearance),
        })
        return mermaid.parse(renderSource).then(() => mermaid)
      })
      .then(mermaid => {
        return mermaid.render(renderId, renderSource)
      })
      .then(({ svg: nextSvg, bindFunctions }) => {
        if (!disposed) setRenderState({ status: 'ready', svg: nextSvg, bindFunctions })
      })
      .catch(error => {
        if (!disposed) {
          setRenderState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error || copy.mermaidRenderFailed),
          })
        }
      })

    return () => {
      disposed = true
    }
  }, [appearance, copy.mermaidRenderFailed, renderId, renderSource])

  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setPanMode(false)
    setIsFullscreen(false)
    setCopied(false)
  }, [appearance, renderSource])

  useEffect(() => {
    if (!isFullscreen) return
    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFullscreen(false)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isFullscreen])

  useEffect(() => {
    if (renderState.status !== 'ready' || !renderState.bindFunctions || !canvasRef.current) return
    renderState.bindFunctions(canvasRef.current)
  }, [renderState])

  const setNextZoom = useCallback((nextZoom: number) => {
    setZoom(Math.min(6, Math.max(0.5, Number(nextZoom.toFixed(2)))))
  }, [])

  const fitFullscreenDiagram = useCallback(() => {
    const viewport = viewportRef.current
    const svg = canvasRef.current?.querySelector('svg')
    const viewBox = svg?.viewBox.baseVal
    if (!viewport || !viewBox || viewBox.width <= 0 || viewBox.height <= 0) return

    const availableWidth = Math.max(1, viewport.clientWidth - 72)
    const availableHeight = Math.max(1, viewport.clientHeight - 108)
    const scale = Math.min(availableWidth / viewBox.width, availableHeight / viewBox.height)
    setFullscreenCanvasSize({
      width: Math.max(1, Math.floor(viewBox.width * scale)),
      height: Math.max(1, Math.floor(viewBox.height * scale)),
    })
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setPanMode(false)
  }, [])

  const resetView = useCallback(() => {
    if (isFullscreen) {
      fitFullscreenDiagram()
      return
    }
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setPanMode(false)
  }, [fitFullscreenDiagram, isFullscreen])

  const toggleFullscreen = useCallback(() => {
    if (isFullscreen) {
      setIsFullscreen(false)
      return
    }
    setFullscreenCanvasSize(null)
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setPanMode(false)
    setIsFullscreen(true)
  }, [isFullscreen])

  useEffect(() => {
    if (!isFullscreen || renderState.status !== 'ready') {
      if (!isFullscreen) setFullscreenCanvasSize(null)
      return undefined
    }

    let frameId = window.requestAnimationFrame(fitFullscreenDiagram)
    const scheduleFit = () => {
      window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(fitFullscreenDiagram)
    }
    window.addEventListener('resize', scheduleFit)
    return () => {
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', scheduleFit)
    }
  }, [fitFullscreenDiagram, isFullscreen, renderState.status])

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || renderState.status !== 'ready' || (!panMode && !event.altKey)) return
    didPanRef.current = false
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: offset.x,
      baseY: offset.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [offset.x, offset.y, panMode, renderState.status, zoom])

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    didPanRef.current = true
    setOffset({
      x: drag.baseX + event.clientX - drag.startX,
      y: drag.baseY + event.clientY - drag.startY,
    })
  }, [])

  const handlePointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
    }
  }, [])

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (renderState.status !== 'ready' || (!event.altKey && !event.ctrlKey)) return
    event.preventDefault()
    setNextZoom(zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2))
  }, [renderState.status, setNextZoom, zoom])

  const handleDiagramClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (didPanRef.current) {
      didPanRef.current = false
      return
    }
    if (renderState.status !== 'ready' || !event.altKey || dragRef.current) return
    setNextZoom(zoom * (event.shiftKey ? 1 / 1.2 : 1.2))
  }, [renderState.status, setNextZoom, zoom])

  const handleCopySource = useCallback(() => {
    copyTextToClipboard(renderSource)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {
        setCopied(false)
      })
  }, [renderSource])

  if (!renderSource.trim() || renderState.status === 'empty') {
    return (
      <pre className="code-markdown-mermaid-fallback">
        <code className="language-mermaid">{renderSource}</code>
      </pre>
    )
  }

  if (renderState.status === 'error') {
    return (
      <figure className="code-markdown-mermaid error" aria-label={copy.mermaidDiagram}>
        <figcaption className="code-markdown-mermaid-error-title">{copy.mermaidRenderFailed}</figcaption>
        <pre className="code-markdown-mermaid-error-message">{renderState.message}</pre>
        <pre className="code-markdown-mermaid-fallback">
          <code className="language-mermaid">{renderSource}</code>
        </pre>
      </figure>
    )
  }

  const readyState = renderState.status === 'ready' ? renderState : null

  return (
    <figure
      className={`code-markdown-mermaid ${renderState.status === 'loading' ? 'loading' : ''} ${isFullscreen ? 'fullscreen' : ''}`}
      aria-label={copy.mermaidDiagram}
      role={isFullscreen ? 'dialog' : undefined}
      aria-modal={isFullscreen || undefined}
    >
      <div className="code-markdown-mermaid-toolbar" aria-label={copy.mermaidDiagramControls}>
        <button
          type="button"
          onClick={toggleFullscreen}
          disabled={renderState.status !== 'ready'}
          aria-label={isFullscreen ? copy.mermaidExitFullscreen : copy.mermaidEnterFullscreen}
          title={isFullscreen ? copy.mermaidExitFullscreen : copy.mermaidEnterFullscreen}
        >
          <MermaidControlIcon kind={isFullscreen ? 'fullscreenExit' : 'fullscreen'} />
        </button>
        <button
          type="button"
          onClick={() => setNextZoom(zoom / 1.2)}
          disabled={renderState.status !== 'ready' || zoom <= 0.5}
          aria-label={copy.mermaidZoomOut}
          title={copy.mermaidZoomOut}
        >
          <MermaidControlIcon kind="zoomOut" />
        </button>
        <button
          type="button"
          onClick={() => setNextZoom(zoom * 1.2)}
          disabled={renderState.status !== 'ready' || zoom >= 6}
          aria-label={copy.mermaidZoomIn}
          title={copy.mermaidZoomIn}
        >
          <MermaidControlIcon kind="zoomIn" />
        </button>
        <button
          type="button"
          onClick={() => setPanMode(value => !value)}
          disabled={renderState.status !== 'ready' || zoom <= 1}
          aria-pressed={panMode}
          aria-label={copy.mermaidPanMode}
          title={copy.mermaidPanMode}
        >
          <MermaidControlIcon kind="pan" />
        </button>
        <button
          type="button"
          onClick={resetView}
          disabled={renderState.status !== 'ready'}
          aria-label={copy.mermaidResetView}
          title={copy.mermaidResetView}
        >
          <MermaidControlIcon kind="reset" />
        </button>
        <button
          type="button"
          onClick={handleCopySource}
          aria-label={copied ? copy.mermaidCopiedSource : copy.mermaidCopySource}
          title={copied ? copy.mermaidCopiedSource : copy.mermaidCopySource}
        >
          <MermaidControlIcon kind="copy" />
        </button>
      </div>
      {!readyState ? (
        <div className="code-markdown-mermaid-loading">{copy.mermaidRendering}</div>
      ) : (
        <div
          ref={viewportRef}
          className={`code-markdown-mermaid-viewport ${zoom > 1 ? 'pannable' : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onWheel={handleWheel}
          onClick={handleDiagramClick}
        >
          <div
            ref={canvasRef}
            className="code-markdown-mermaid-canvas"
            style={{
              ...(isFullscreen && fullscreenCanvasSize ? {
                width: `${fullscreenCanvasSize.width}px`,
                height: `${fullscreenCanvasSize.height}px`,
              } : {}),
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            }}
            dangerouslySetInnerHTML={{ __html: readyState.svg }}
          />
        </div>
      )}
    </figure>
  )
}

export const FileEditorMarkdownPreview = forwardRef<HTMLElement, FileEditorMarkdownPreviewProps>(function FileEditorMarkdownPreview({
  activeTabDomId,
  openFile,
  onOpenFilePath,
  copy,
}, ref) {
  const source = openFile.draft ?? openFile.file.content ?? ''
  const markdownDocument = splitMarkdownFrontMatter(source)
  const nextHeadingId = createHeadingIdFactory()
  const contextValue = { openFile, onOpenFilePath, copy, nextHeadingId }

  return (
    <section
      ref={ref}
      className="code-file-preview-panel markdown"
      data-testid="code-file-markdown-preview"
      role="tabpanel"
      aria-labelledby={activeTabDomId}
      aria-label={copy.markdownPreviewFor(openFile.file.path)}
      tabIndex={-1}
    >
      <MarkdownPreviewContext.Provider value={contextValue}>
        <article className="code-markdown-preview">
          {markdownDocument.frontMatter && (
            <MarkdownFrontMatterTable frontMatter={markdownDocument.frontMatter} copy={copy} />
          )}
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex, rehypeHighlight]}
            components={MARKDOWN_COMPONENTS}
            skipHtml
          >
            {markdownDocument.body}
          </ReactMarkdown>
        </article>
      </MarkdownPreviewContext.Provider>
    </section>
  )
})
