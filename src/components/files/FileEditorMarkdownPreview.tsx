import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { rawWorkspaceFileUrl } from '@/lib/workspace-files'
import { workspaceEditorBasename } from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import type { CodeCopy } from '../code/copy'

interface FileEditorMarkdownPreviewProps {
  activeTabDomId: string
  openFile: OpenWorkspaceFile
  copy: CodeCopy
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

function markdownLinkUrl(openFile: OpenWorkspaceFile, href: string) {
  if (!href || href.startsWith('#') || isExternalResource(href)) return href
  const workspacePath = normalizeWorkspaceResourcePath(openFile.file.path, href)
  return workspacePath ? rawWorkspaceFileUrl(openFile.agentId, workspacePath) : href
}

export function FileEditorMarkdownPreview({
  activeTabDomId,
  openFile,
  copy,
}: FileEditorMarkdownPreviewProps) {
  const source = openFile.draft ?? openFile.file.content ?? ''
  const components: Components = {
    a({ href, children, ...props }) {
      const nextHref = href ? markdownLinkUrl(openFile, href) : undefined
      const external = nextHref ? isExternalResource(nextHref) : false
      return (
        <a
          {...props}
          href={nextHref}
          target={external ? '_blank' : undefined}
          rel={external ? 'noreferrer' : undefined}
        >
          {children}
        </a>
      )
    },
    img({ src, alt, ...props }) {
      const nextSrc = src ? markdownImageUrl(openFile, src) : undefined
      return (
        <img
          {...props}
          src={nextSrc}
          alt={alt || workspaceEditorBasename(openFile.file.path)}
          draggable={false}
        />
      )
    },
  }

  return (
    <section
      className="code-file-preview-panel markdown"
      data-testid="code-file-markdown-preview"
      role="tabpanel"
      aria-labelledby={activeTabDomId}
      aria-label={copy.markdownPreviewFor(openFile.file.path)}
      tabIndex={-1}
    >
      <article className="code-markdown-preview">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
          {source}
        </ReactMarkdown>
      </article>
    </section>
  )
}
