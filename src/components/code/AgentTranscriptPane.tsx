import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { ArrowDownGlyph, CheckGlyph, ChevronRightGlyph, CloseGlyph, CopyGlyph } from '@/components/IconGlyphs'
import { MermaidBlock } from '@/components/files/FileEditorMarkdownPreview'
import { appPath } from '@/lib/base-path'
import { iconForFilePath } from '@/lib/file-icons'
import { normalizeGlobalWorkspaceFilePath } from '@/lib/global-workspace-files'
import {
  clearReadingAnchor,
  readingAnchorAgentKey,
  readReadingAnchor,
  saveReadingAnchor,
} from '@/lib/reading-anchor'
import { collectTerminalPathLinkMatches } from '@/lib/terminal-links'
import { isCompactViewport } from '@/lib/responsive-mode'
import { loadAcpReviewPreview } from '@/lib/review/api'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import type { CodeCopy } from './copy'
import { acpActivityKind, acpCompactPlanLabel, acpLiveToolActivityLabel, acpPlanProgress, type AcpActivityKind } from './acp/acp-activity-label'
import { AcpEmbeddedTerminal } from './acp/AcpEmbeddedTerminal'
import {
  projectAcpTranscript,
  type AgentTranscript,
  type AgentTranscriptAudio,
  type AgentTranscriptPatchChange,
  type AgentTranscriptProcessItem,
  type AgentTranscriptTerminal,
  type AgentTranscriptTurn,
  type AgentTranscriptUserFile,
  type AgentTranscriptUserImage,
} from './acp/acp-entry-projection'
import { acpActionGroupLabel, isAcpProgressUpdate } from './acp/acp-progress-timeline'
import { terminalTargetFilePath } from './workspace-file-view'
import 'katex/dist/katex.min.css'

interface AgentTranscriptProcessPresentation {
  detail: string
  terminals?: AgentTranscriptTerminal[]
  subagentTranscript?: AgentTranscript
}

function completedTranscriptTurnUnchanged(
  current: AgentTranscriptTurn,
  next: AgentTranscriptTurn,
) {
  const currentLastItem = current.processItems[current.processItems.length - 1]
  const nextLastItem = next.processItems[next.processItems.length - 1]
  return current.status !== 'inProgress'
    && next.status !== 'inProgress'
    && current.userMessage === next.userMessage
    && current.finalMessage === next.finalMessage
    && current.startedAt === next.startedAt
    && current.completedAt === next.completedAt
    && current.durationMs === next.durationMs
    && current.userImages?.length === next.userImages?.length
    && current.userAudios?.length === next.userAudios?.length
    && current.userFiles?.length === next.userFiles?.length
    && current.resultImages?.length === next.resultImages?.length
    && current.resultAudios?.length === next.resultAudios?.length
    && current.resultFiles?.length === next.resultFiles?.length
    && current.processItems.length === next.processItems.length
    && currentLastItem?.id === nextLastItem?.id
    && currentLastItem?.status === nextLastItem?.status
    && currentLastItem?.title === nextLastItem?.title
    && currentLastItem?.detail === nextLastItem?.detail
  }

function preserveCompletedTranscriptTurns(
  current: AgentTranscript | null,
  next: AgentTranscript | null,
) {
  if (!current || !next || current.sessionId !== next.sessionId) return next
  const completedTurns = new Map(
    current.turns
      .filter(turn => turn.status !== 'inProgress')
      .map(turn => [turn.id, turn]),
  )
  return {
    ...next,
    turns: next.turns.map(turn => {
      const completedTurn = completedTurns.get(turn.id)
      return completedTurn && completedTranscriptTurnUnchanged(completedTurn, turn)
        ? completedTurn
        : turn
    }),
  }
}

function mergeAcpTranscript(
  current: AgentTranscript | null,
  next: AgentTranscript | null,
) {
  if (!next?.delta) return preserveCompletedTranscriptTurns(current, next)
  if (!current || current.sessionId !== next.sessionId) return next
  if (!next.replaceFromTurnId || next.turns.length === 0) {
    return {
      ...current,
      ...next,
      available: current.available,
      hasMoreBefore: current.hasMoreBefore,
      turns: current.turns,
    }
  }
  const replaceIndex = current.turns.findIndex(turn => turn.id === next.replaceFromTurnId)
  if (replaceIndex < 0) {
    const currentIds = new Set(current.turns.map(turn => turn.id))
    const appended = next.turns.filter(turn => !currentIds.has(turn.id))
    const mergedTurns = [...current.turns, ...appended]
    const boundedTurns = current.turnLimit && mergedTurns.length > current.turnLimit
      ? mergedTurns.slice(-current.turnLimit)
      : mergedTurns
    return preserveCompletedTranscriptTurns(current, {
      ...current,
      ...next,
      available: current.available || next.available,
      hasMoreBefore: current.hasMoreBefore || next.hasMoreBefore || boundedTurns.length < mergedTurns.length,
      turns: boundedTurns,
    })
  }
  return preserveCompletedTranscriptTurns(current, {
    ...next,
    available: current.available || next.available,
    hasMoreBefore: current.hasMoreBefore || next.hasMoreBefore,
    turns: [...current.turns.slice(0, replaceIndex), ...next.turns],
  })
}

export interface AgentTranscriptPaneProps {
  agentId: string
  workspaceRoot?: string
  active: boolean
  viewportLayoutKey?: string
  source?: 'acp' | 'json-cli' | 'legacy-jsonl'
  refreshSignal?: number
  runtimeState?: string
  expectHistory?: boolean
  onOpenWorkspaceFilePath?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onAvailabilityChange?: (state: { loading: boolean; hasContent: boolean; available: boolean }) => void
  onReadLatest?: () => void
  groupProcessActions?: boolean
  copy: CodeCopy
}

type TranscriptAnchorRestoreResult = 'none' | 'restored' | 'expired'

function saveTranscriptReadingAnchor(agentId: string, element: HTMLDivElement) {
  if (isTranscriptNearBottom(element)) {
    clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
    return
  }
  const scrollerRect = element.getBoundingClientRect()
  const turns = Array.from(element.querySelectorAll<HTMLElement>('[data-turn-id]'))
  const turn = turns.find(candidate => candidate.getBoundingClientRect().bottom > scrollerRect.top)
  if (!turn) return
  const processItem = Array.from(turn.querySelectorAll<HTMLElement>('[data-process-item-id]'))
    .find(candidate => candidate.getBoundingClientRect().bottom > scrollerRect.top)
  const target = processItem || turn
  const targetRect = target.getBoundingClientRect()
  const fraction = targetRect.height > 0
    ? Math.max(0, Math.min(1, (scrollerRect.top - targetRect.top) / targetRect.height))
    : 0
  const turnId = turn.dataset.turnId
  if (!turnId) return
  saveReadingAnchor({
    version: 1,
    surface: 'chat',
    resource: { kind: 'agent', id: agentId },
    locator: {
      kind: 'message',
      id: turnId,
      ...(processItem?.dataset.processItemId ? { childId: processItem.dataset.processItemId } : {}),
    },
    position: { unit: 'fraction', value: fraction },
  })
}

function restoreTranscriptReadingAnchor(agentId: string, element: HTMLDivElement): TranscriptAnchorRestoreResult {
  const key = readingAnchorAgentKey(agentId, 'chat')
  const anchor = readReadingAnchor(key)
  if (!anchor) return 'none'
  if (anchor.surface !== 'chat' || anchor.resource.kind !== 'agent') {
    clearReadingAnchor(key)
    return 'expired'
  }
  const turn = element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.locator.id)}"]`)
  if (!turn) {
    clearReadingAnchor(key)
    return 'expired'
  }
  const processItem = anchor.locator.childId
    ? turn.querySelector<HTMLElement>(`[data-process-item-id="${CSS.escape(anchor.locator.childId)}"]`)
    : null
  const target = processItem || turn
  const targetRect = target.getBoundingClientRect()
  const scrollerRect = element.getBoundingClientRect()
  const targetOffset = targetRect.height * anchor.position.value
  element.scrollTop += targetRect.top + targetOffset - scrollerRect.top
  return 'restored'
}
const INITIAL_TRANSCRIPT_TURN_LIMIT = 80
const TRANSCRIPT_TURN_PAGE_SIZE = 80
const INITIAL_ACP_TRANSCRIPT_TURN_LIMIT = 20
const ACP_TRANSCRIPT_TURN_PAGE_SIZE = 20
const MAX_TRANSCRIPT_TURN_LIMIT = 1000

function initialTranscriptTurnLimit(source: AgentTranscriptPaneProps['source']) {
  return source === 'acp'
    ? INITIAL_ACP_TRANSCRIPT_TURN_LIMIT
    : INITIAL_TRANSCRIPT_TURN_LIMIT
}
const TRANSCRIPT_LOAD_MORE_THRESHOLD = 72
const TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD = 96

function durationLabel(durationMs: number | null | undefined) {
  // ACP does not carry historical turn timestamps. Farming only measures a
  // turn while it is connected, so sub-second work should stay visually quiet
  // instead of being rounded into the misleading "Worked for 0s" label.
  if (!durationMs || !Number.isFinite(durationMs) || durationMs < 1_000) return ''
  const seconds = Math.round(durationMs / 1000)
  if (seconds <= 0) return ''
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

function elapsedDurationLabel(startedAt: number | null | undefined) {
  const numeric = Number(startedAt)
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  const timestamp = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
  return durationLabel(Math.max(0, Date.now() - timestamp))
}

function acpActivityLabels(copy: CodeCopy): Record<AcpActivityKind, string> {
  return {
    thinking: copy.agentTranscriptThinking,
    running: copy.agentTranscriptRunning,
    reading: copy.agentTranscriptReading,
    searching: copy.agentTranscriptSearching,
    editing: copy.agentTranscriptEditing,
    plan: copy.agentTranscriptPlanActive,
    fetching: copy.agentTranscriptFetching,
    tool: copy.agentTranscriptUsingTool,
    processing: copy.agentTranscriptWorking,
  }
}

function acpActivityLabel(turn: AgentTranscriptTurn, copy: CodeCopy) {
  return acpActivityLabels(copy)[acpActivityKind(turn.processItems)]
}

function acpLiveToolLabel(turn: AgentTranscriptTurn, copy: CodeCopy) {
  return acpLiveToolActivityLabel(turn.processItems, acpActivityLabels(copy))
}

function acpPlanLabel(turn: AgentTranscriptTurn, copy: CodeCopy) {
  const progress = acpPlanProgress(turn.processItems)
  if (!progress) return ''
  const currentStepLabel = acpCompactPlanLabel(turn.processItems)
  if (currentStepLabel) return currentStepLabel
  return progress.total <= 99
    ? copy.agentTranscriptPlanProgress(progress.completed, progress.total)
    : copy.agentTranscriptPlanActive
}

function turnProcessLabel(
  turn: AgentTranscriptTurn,
  copy: CodeCopy,
  workingLabel = copy.agentTranscriptWorking,
  planLabel = '',
) {
  const duration = durationLabel(turn.durationMs)
  const errorItem = turn.status === 'interrupted'
    ? turn.processItems.find(item => item.type === 'error')
    : undefined
  if (errorItem?.title) return errorItem.title
  return duration
    ? copy.agentTranscriptWorkedFor(duration)
    : turn.status === 'inProgress'
      ? planLabel || workingLabel
      : copy.agentTranscriptProcess
}

function turnProcessTitle(turn: AgentTranscriptTurn, copy: CodeCopy) {
  if (turn.processItems.length <= 0) return undefined
  return copy.agentTranscriptProcessCount(turn.processItems.length)
}

function plainTextBlock(text: string) {
  const lines = text.split('\n')
  return lines.map((line, index) => (
    <span key={index}>
      {line}
      {index < lines.length - 1 ? <br /> : null}
    </span>
  ))
}

function stripRawMemoryCitation(text: string) {
  return text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '').trim()
}

function isExternalTranscriptHref(href: string) {
  const trimmed = href.trim()
  if (isTranscriptFileLineHref(trimmed)) return false
  return /^[a-z][a-z\d+.-]*:/i.test(trimmed) || isBareDomainTranscriptHref(trimmed)
}

function isTranscriptFileLineHref(href: string) {
  return /^[^/\s]+\.[A-Za-z0-9+_-]+:\d+(?::\d+(?:-\d+)?)?$/.test(href.trim())
}

function isBareDomainTranscriptHref(href: string) {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#].*$/i.test(href.trim())
}

function normalizeTranscriptHref(href: string) {
  const trimmed = href.trim()
  return isBareDomainTranscriptHref(trimmed) ? `https://${trimmed}` : href
}

const TRANSCRIPT_FILE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'hxx',
  'go',
  'java',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'json',
  'jsonl',
  'py',
  'rb',
  'rs',
  'sh',
  'bash',
  'zsh',
  'sql',
  'md',
  'mdx',
  'pdf',
  'txt',
  'xml',
  'html',
  'css',
  'scss',
  'less',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'gradle',
  'kt',
  'kts',
  'scala',
  'proto',
  'swift',
  'vue',
  'svelte',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
])

const TRANSCRIPT_SPECIAL_FILENAMES = new Set([
  'BUILD',
  'BUCK',
  'Dockerfile',
  'Makefile',
  'WORKSPACE',
])

function stripCandidateLocationSuffix(text: string) {
  return text.replace(/:(\d+)(?::(\d+)(?:-(\d+))?)?$/, '')
}

function transcriptFileBasenameLooksValid(pathText: string) {
  const basename = pathText.split(/[\\/]/).filter(Boolean).pop() || pathText
  if (TRANSCRIPT_SPECIAL_FILENAMES.has(basename)) return true
  const extensionMatch = basename.match(/\.([A-Za-z0-9+_-]+)$/)
  if (!extensionMatch) return false
  return TRANSCRIPT_FILE_EXTENSIONS.has((extensionMatch[1] || '').toLowerCase())
}

function isLikelyTranscriptFileReference(text: string) {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed) || trimmed.startsWith('#') || isExternalTranscriptHref(trimmed)) return false
  if (/^[A-Z_][A-Z0-9_]*(?:\s+[A-Z_][A-Z0-9_]*)*$/.test(trimmed)) return false
  const pathText = stripCandidateLocationSuffix(trimmed)
  return transcriptFileBasenameLooksValid(pathText)
}

function safeDecodeTranscriptHref(text: string) {
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

function transcriptLocationSuffix(text: string) {
  const match = text.match(/:(\d+)(?::(\d+)(?:-(\d+))?)?$/)
  if (!match) return null
  const lineNumber = Number(match[1])
  const column = match[2] ? Number(match[2]) : undefined
  const endColumn = match[3] ? Number(match[3]) : undefined
  if (!Number.isFinite(lineNumber) || lineNumber <= 0) return null
  if (column !== undefined && (!Number.isFinite(column) || column <= 0)) return null
  if (endColumn !== undefined && (!Number.isFinite(endColumn) || endColumn <= 0)) return null
  return {
    lineNumber,
    ...(column !== undefined ? { column } : {}),
    ...(endColumn !== undefined ? { endColumn } : {}),
  }
}

function transcriptAbsoluteFileTargetFromText(text: string, workspaceRoot?: string) {
  const decoded = safeDecodeTranscriptHref(text.trim())
  const pathText = stripCandidateLocationSuffix(decoded)
  if (!pathText.startsWith('/') || pathText.startsWith('//') || !transcriptFileBasenameLooksValid(pathText)) return null
  const filePath = terminalTargetFilePath(pathText, workspaceRoot || '')
  const globalFilePath = filePath ? '' : normalizeGlobalWorkspaceFilePath(pathText)
  if (!filePath && !globalFilePath) return null
  const location = transcriptLocationSuffix(decoded)
  return {
    filePath: filePath || globalFilePath,
    target: {
      ...(location || {}),
      ...(!filePath && globalFilePath ? { globalRoot: true } : {}),
    },
  }
}

function transcriptFileTargetFromText(text: string, workspaceRoot?: string) {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('#') || isExternalTranscriptHref(trimmed)) return null
  const absoluteTarget = transcriptAbsoluteFileTargetFromText(trimmed, workspaceRoot)
  if (absoluteTarget) return absoluteTarget
  if (!isLikelyTranscriptFileReference(trimmed)) return null
  const matches = collectTerminalPathLinkMatches(trimmed)
  const exact = matches.find(match => match.startIndex === 0 && match.length === trimmed.length && match.pathTarget)
  if (!exact?.pathTarget) return null
  const pathTarget = exact.pathTarget
  const filePath = terminalTargetFilePath(pathTarget.path, workspaceRoot || '')
  if (!filePath && !pathTarget.path.startsWith('/')) return null
  const globalFilePath = !filePath && pathTarget.path.startsWith('/')
    ? normalizeGlobalWorkspaceFilePath(pathTarget.path)
    : ''
  if (!filePath && !globalFilePath) return null
  return {
    filePath: filePath || globalFilePath,
    target: {
      ...(pathTarget.lineNumber
        ? {
            lineNumber: pathTarget.lineNumber,
            column: pathTarget.column,
            endColumn: pathTarget.endColumn,
          }
        : {}),
      ...(!filePath && globalFilePath ? { globalRoot: true } : {}),
    },
  }
}

function hasQualifiedTranscriptFileReference(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return false
  const withoutLocation = stripCandidateLocationSuffix(trimmed)
  return (
    withoutLocation.startsWith('/') ||
    withoutLocation.startsWith('~/') ||
    withoutLocation.startsWith('./') ||
    withoutLocation.startsWith('../') ||
    withoutLocation.includes('/') ||
    /:(\d+)(?::(\d+)(?:-(\d+))?)?$/.test(trimmed)
  )
}

function fileReferenceDisplayText(filePath: string, lineNumber?: number) {
  const basename = stripCandidateLocationSuffix(filePath.trim()).split(/[\\/]/).filter(Boolean).pop() || filePath.trim()
  return lineNumber && lineNumber > 1 ? `${basename}:${lineNumber}` : basename
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

function agentTranscriptUrlTransform(value: string, key: string) {
  if (key === 'src' && /^data:image\/(?:png|gif|jpe?g|webp|svg\+xml);base64,/i.test(value)) {
    return value
  }
  if (key === 'href' && isTranscriptFileLineHref(value)) {
    return value
  }
  if (key === 'href' && isBareDomainTranscriptHref(value)) {
    return normalizeTranscriptHref(value)
  }
  return defaultUrlTransform(value)
}

function AgentTranscriptUserImages({ images }: { images: AgentTranscriptUserImage[] }) {
  if (images.length <= 0) return null
  return (
    <div className="code-agent-transcript-user-images" data-testid="code-agent-transcript-user-images">
      {images.map(image => (
        <img
          key={image.id}
          src={image.url}
          alt={image.alt || 'Attached image'}
          loading="lazy"
          decoding="async"
        />
      ))}
    </div>
  )
}

function userFileMeta(file: AgentTranscriptUserFile) {
  if (file.error) return file.error
  if (file.resourceKind === 'link') return file.mimeType || 'Resource link'
  const content = file.content || ''
  const lineCount = content ? content.split('\n').length : 0
  const charCount = content.length
  const lineLabel = lineCount === 1 ? '1 line' : `${lineCount} lines`
  const charLabel = charCount === 1 ? '1 char' : `${charCount} chars`
  return `${lineLabel} · ${charLabel}${file.truncated ? ' · truncated' : ''}`
}

function safeResourceHref(uri?: string) {
  if (!uri) return ''
  try {
    const parsed = new URL(uri)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function AgentTranscriptUserFiles({ files }: { files: AgentTranscriptUserFile[] }) {
  if (files.length <= 0) return null
  return (
    <div className="code-agent-transcript-user-files" data-testid="code-agent-transcript-user-files">
      {files.map(file => {
        const content = file.content || ''
        const hasContent = Boolean(content)
        const resourceHref = file.resourceKind === 'link' ? safeResourceHref(file.uri) : ''
        if (file.resourceKind === 'link') {
          return (
            <div key={file.id} className="code-agent-transcript-user-file code-agent-transcript-resource-link">
              <TranscriptFileIcon filePath={file.name} />
              {resourceHref ? (
                <a href={resourceHref} target="_blank" rel="noreferrer" title={file.uri}>{file.name}</a>
              ) : <span title={file.uri}>{file.name}</span>}
              <span className="code-agent-transcript-user-file-meta">{userFileMeta(file)}</span>
            </div>
          )
        }
        return (
          <details key={file.id} className={`code-agent-transcript-user-file ${file.error ? 'error' : ''}`}>
            <summary>
              <TranscriptFileIcon filePath={file.name} />
              <span className="code-agent-transcript-user-file-name" title={file.name}>{file.name}</span>
              <span className="code-agent-transcript-user-file-meta">{userFileMeta(file)}</span>
            </summary>
            {file.error ? (
              <div className="code-agent-transcript-user-file-error">{file.error}</div>
            ) : hasContent ? (
              <pre>{content}</pre>
            ) : null}
          </details>
        )
      })}
    </div>
  )
}

function TranscriptFileIcon({ filePath }: { filePath: string }) {
  const iconUrl = iconForFilePath(filePath)
  return (
    <span
      className="code-agent-transcript-file-icon"
      style={{
        WebkitMaskImage: `url("${iconUrl}")`,
        maskImage: `url("${iconUrl}")`,
      }}
      aria-hidden="true"
    />
  )
}

function TranscriptFileLinkLabel({
  children: _children,
  filePath,
  lineNumber,
}: {
  children?: ReactNode
  filePath: string
  lineNumber?: number
}) {
  const label = fileReferenceDisplayText(filePath, lineNumber)
  const location = lineNumber && lineNumber > 1 ? `${filePath}:${lineNumber}` : filePath
  return (
    <span title={location}>
      <TranscriptFileIcon filePath={filePath} />
      <span className="code-agent-transcript-file-label">{label}</span>
    </span>
  )
}

function AgentTranscriptProcessImages({ images }: { images: AgentTranscriptUserImage[] }) {
  if (images.length <= 0) return null
  return (
    <div className="code-agent-transcript-process-images" data-testid="code-agent-transcript-process-images">
      {images.map(image => (
        <img
          key={image.id}
          src={image.url}
          alt={image.alt || 'Generated image'}
          loading="lazy"
          decoding="async"
        />
      ))}
    </div>
  )
}

function AgentTranscriptResultImages({ images }: { images: AgentTranscriptUserImage[] }) {
  if (images.length <= 0) return null
  return (
    <div className="code-agent-transcript-result-images" data-testid="code-agent-transcript-result-images">
      {images.map(image => (
        <img
          key={image.id}
          src={image.url}
          alt={image.alt || 'Generated image'}
          loading="lazy"
          decoding="async"
        />
      ))}
    </div>
  )
}

function AgentTranscriptAudios({ audios }: { audios: AgentTranscriptAudio[] }) {
  if (audios.length <= 0) return null
  return (
    <div className="code-agent-transcript-audios" data-testid="code-agent-transcript-audios">
      {audios.map(audio => (
        <figure key={audio.id}>
          {audio.name ? <figcaption>{audio.name}</figcaption> : null}
          <audio controls preload="metadata" src={audio.url}>
            {audio.mimeType ? <source src={audio.url} type={audio.mimeType} /> : null}
          </audio>
        </figure>
      ))}
    </div>
  )
}

function terminalCommandLabel(terminal: AgentTranscriptTerminal) {
  const command = String(terminal.terminal?.command || '').trim()
  const args = Array.isArray(terminal.terminal?.args) ? terminal.terminal.args : []
  return [command, ...args].filter(Boolean).join(' ') || terminal.terminalId
}

function terminalDurationLabel(durationMs?: number) {
  if (!Number.isFinite(durationMs) || Number(durationMs) < 0) return ''
  if (Number(durationMs) < 1_000) return `${Math.round(Number(durationMs))}ms`
  return `${(Number(durationMs) / 1_000).toFixed(Number(durationMs) < 10_000 ? 1 : 0)}s`
}

function terminalExitLabel(terminal: AgentTranscriptTerminal) {
  const exit = terminal.terminal?.exitStatus
  if (exit?.signal) return exit.signal
  if (Number.isInteger(exit?.exitCode)) return `Exit ${exit?.exitCode}`
  return terminal.terminal?.released ? 'Released' : ''
}

function detailDuplicatesTerminalOutcome(detail: string, terminals: AgentTranscriptTerminal[]) {
  if (!detail.startsWith('Output\n') || detail.includes('\n\n')) return false
  let output: unknown
  try {
    output = JSON.parse(detail.slice('Output\n'.length))
  } catch {
    return false
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false
  const record = output as { exitCode?: unknown, signal?: unknown }
  const keys = Object.keys(record)
  if (keys.length <= 0 || keys.some(key => !['exitCode', 'signal'].includes(key))) return false
  return terminals.some(terminal => {
    const exit = terminal.terminal?.exitStatus
    if (!exit) return false
    return (!Object.prototype.hasOwnProperty.call(record, 'exitCode') || record.exitCode === exit.exitCode)
      && (!Object.prototype.hasOwnProperty.call(record, 'signal') || record.signal === exit.signal)
  })
}

function AgentTranscriptTerminals({
  terminals,
  terminalStateFinal = false,
  onStop,
  onInput,
  onResize,
}: {
  terminals: AgentTranscriptTerminal[]
  terminalStateFinal?: boolean
  onStop?: (terminalId: string) => Promise<void>
  onInput?: (terminalId: string, input: string) => Promise<void>
  onResize?: (terminalId: string, cols: number, rows: number) => Promise<void>
}) {
  const [copiedTerminalId, setCopiedTerminalId] = useState('')
  const [stoppingTerminalId, setStoppingTerminalId] = useState('')
  const [stopError, setStopError] = useState('')
  if (terminals.length <= 0) return null
  return (
    <div className="code-agent-transcript-terminals" data-testid="code-agent-transcript-terminals">
      {terminals.map(terminal => {
        const command = terminalCommandLabel(terminal)
        const duration = terminalDurationLabel(terminal.terminal?.durationMs)
        const exit = terminalExitLabel(terminal)
        const output = terminal.terminal?.output || ''
        return (
          <section key={terminal.terminalId} className="code-agent-transcript-terminal">
            <header>
              <code title={command}>{command}</code>
              <div className="code-agent-transcript-terminal-actions">
                {!terminalStateFinal && !terminal.terminal?.exitStatus && !terminal.terminal?.released && onStop ? (
                  <button
                    type="button"
                    className="code-agent-transcript-terminal-stop"
                    data-testid="code-acp-terminal-stop"
                    aria-label="Stop command"
                    title="Stop command"
                    disabled={Boolean(stoppingTerminalId)}
                    onClick={() => {
                      setStoppingTerminalId(terminal.terminalId)
                      setStopError('')
                      void onStop(terminal.terminalId)
                        .catch(error => setStopError(error instanceof Error ? error.message : 'Failed to stop command'))
                        .finally(() => setStoppingTerminalId(''))
                    }}
                  >
                    {stoppingTerminalId === terminal.terminalId ? <span className="code-permission-switching-spinner" /> : <CloseGlyph />}
                  </button>
                ) : null}
                {output ? (
                  <button
                    type="button"
                    className="code-agent-transcript-terminal-copy"
                    aria-label={copiedTerminalId === terminal.terminalId ? 'Copied terminal output' : 'Copy terminal output'}
                    title={copiedTerminalId === terminal.terminalId ? 'Copied' : 'Copy output'}
                    onClick={() => {
                      void writeClipboardText(output).then(copied => {
                        if (!copied) return
                        setCopiedTerminalId(terminal.terminalId)
                        window.setTimeout(() => setCopiedTerminalId(current => current === terminal.terminalId ? '' : current), 1200)
                      })
                    }}
                  >
                    {copiedTerminalId === terminal.terminalId ? <CheckGlyph /> : <CopyGlyph />}
                  </button>
                ) : null}
              </div>
            </header>
            {(terminal.terminal?.cwd || duration || exit || terminal.terminal?.truncated) ? (
              <div className="code-agent-transcript-terminal-meta">
                {terminal.terminal?.cwd ? <span title={terminal.terminal.cwd}>{terminal.terminal.cwd}</span> : null}
                {duration ? <span>{duration}</span> : null}
                {exit ? <span>{exit}</span> : null}
                {terminal.terminal?.truncated ? <span>Earlier output hidden</span> : null}
              </div>
            ) : null}
            <AcpEmbeddedTerminal
              terminalId={terminal.terminalId}
              output={output}
              interactive={Boolean(
                !terminalStateFinal
                && terminal.terminal?.interactive
                && !terminal.terminal.exitStatus
                && !terminal.terminal.released
                && onInput,
              )}
              onInput={onInput ? input => onInput(terminal.terminalId, input) : undefined}
              onResize={onResize ? (cols, rows) => onResize(terminal.terminalId, cols, rows) : undefined}
            />
            {stopError ? <div className="code-agent-transcript-terminal-error" role="alert">{stopError}</div> : null}
          </section>
        )
      })}
    </div>
  )
}

function AgentTranscriptSubagentAction({ item }: { item: AgentTranscriptProcessItem }) {
  const detail = String(item.detail || '').trim()
  const changes = item.changes || []
  const expandable = Boolean(detail || changes.length > 0)
  const label = (
    <>
      <span>{item.title || 'Action'}</span>
      {shouldShowStatus(item.status) ? <small>{item.status}</small> : null}
    </>
  )
  if (!expandable) return <div className="code-agent-transcript-subagent-action static">{label}</div>
  return (
    <details className="code-agent-transcript-subagent-action" data-testid="code-agent-transcript-subagent-action">
      <summary>{label}<ChevronRightGlyph /></summary>
      {detail ? <div className="detail">{plainTextBlock(detail)}</div> : null}
      {changes.length > 0 ? (
        <div className="changes">
          {changes.map((change, index) => (
            <div key={`${change.path}-${index}`}>
              <span title={change.path}>{change.path}</span>
              <small>{change.added > 0 ? `+${change.added}` : ''}{change.removed > 0 ? ` -${change.removed}` : ''}</small>
            </div>
          ))}
        </div>
      ) : null}
    </details>
  )
}

function AgentTranscriptSubagentPreview({
  transcript,
  onStop,
}: {
  transcript: AgentTranscript
  onStop?: () => Promise<void>
}) {
  const active = ['working', 'waiting-for-permission', 'waiting-for-input', 'interrupting'].includes(transcript.state || '')
  const status = transcript.error ? 'Failed' : active ? 'Working' : 'Completed'
  const actionCount = transcript.turns.reduce((count, turn) => count + turn.processItems.length, 0)
  const [fullscreen, setFullscreen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  useEffect(() => {
    if (!fullscreen) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [fullscreen])
  const entries = (
    <div className="code-agent-transcript-subagent-entries">
      {transcript.turns.map(turn => (
        <div className="code-agent-transcript-subagent-turn" key={turn.id}>
          {turn.userMessage ? <div className="user">{plainTextBlock(turn.userMessage)}</div> : null}
          {turn.processItems.length > 0 ? (
            <div className="actions">{turn.processItems.map(item => <AgentTranscriptSubagentAction item={item} key={item.id} />)}</div>
          ) : null}
          <AgentTranscriptResultImages images={turn.resultImages || []} />
          {turn.finalMessage ? <div className="assistant">{plainTextBlock(turn.finalMessage)}</div> : null}
        </div>
      ))}
      {transcript.turns.length === 0 ? <div className="empty">No subagent output received yet</div> : null}
    </div>
  )
  const header = (
    <header>
      <span>{transcript.title || 'Subagent'}</span>
      <span className="code-agent-transcript-subagent-meta" title={transcript.sessionId}>
        {transcript.turns.length} {transcript.turns.length === 1 ? 'turn' : 'turns'}
        {actionCount > 0 ? ` · ${actionCount} ${actionCount === 1 ? 'action' : 'actions'}` : ''}
      </span>
      <span className={`code-agent-transcript-subagent-status ${transcript.error ? 'error' : active ? 'active' : ''}`}>{status}</span>
      {active && onStop ? (
        <button
          type="button"
          className="code-agent-transcript-subagent-control stop"
          data-testid="code-acp-subagent-stop"
          aria-label="Stop subagent"
          title="Stop subagent"
          disabled={stopping}
          onClick={() => {
            setStopping(true)
            setStopError('')
            void onStop()
              .catch(error => setStopError(error instanceof Error ? error.message : 'Failed to stop subagent'))
              .finally(() => setStopping(false))
          }}
        >
          {stopping ? <span className="code-permission-switching-spinner" /> : <CloseGlyph />}
        </button>
      ) : null}
      <button
        type="button"
        className="code-agent-transcript-subagent-control"
        data-testid="code-acp-subagent-fullscreen"
        aria-label={fullscreen ? 'Close subagent details' : 'Open subagent details'}
        title={fullscreen ? 'Close details' : 'Open details'}
        onClick={() => setFullscreen(current => !current)}
      >
        {fullscreen ? <CloseGlyph /> : <span aria-hidden="true">↗</span>}
      </button>
    </header>
  )
  const preview = (
    <section className="code-agent-transcript-subagent" data-testid="code-agent-transcript-subagent">
      {header}
      {transcript.error ? <div className="code-agent-transcript-subagent-error" role="status">{transcript.error}</div> : null}
      {stopError ? <div className="code-agent-transcript-subagent-error" role="alert">{stopError}</div> : null}
      {entries}
    </section>
  )
  return (
    <>
      {preview}
      {fullscreen ? (
        <div className="code-agent-transcript-subagent-overlay" role="dialog" aria-modal="true" aria-label="Subagent details">
          <div className="code-agent-transcript-subagent-dialog">
            {header}
            {transcript.error ? <div className="code-agent-transcript-subagent-error" role="status">{transcript.error}</div> : null}
            {stopError ? <div className="code-agent-transcript-subagent-error" role="alert">{stopError}</div> : null}
            {entries}
          </div>
        </div>
      ) : null}
    </>
  )
}


function processItemClassName(item: AgentTranscriptProcessItem) {
  const type = item.type.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'event'
  const status = isProcessItemRunning(item)
    ? 'running'
    : (item.status || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase()
  return ['code-agent-transcript-process-item', type, status ? `status-${status}` : '']
    .filter(Boolean)
    .join(' ')
}

function shouldShowStatus(status?: string) {
  const normalized = String(status || '').trim().toLowerCase()
  return !!normalized && normalized !== 'completed' && normalized !== 'success'
}

function isProcessItemRunning(item: AgentTranscriptProcessItem) {
  const normalized = String(item.status || '').trim().replace(/[_-]/g, '').toLowerCase()
  return [
    'running',
    'inprogress',
    'pending',
    'started',
    'active',
  ].includes(normalized)
}

function isProcessItemFailed(item: AgentTranscriptProcessItem) {
  return ['failed', 'rejected', 'cancelled', 'canceled'].includes(
    String(item.status || '').trim().toLowerCase(),
  ) || item.type === 'error'
}

function transcriptBottomDistance(element: HTMLElement) {
  return element.scrollHeight - element.clientHeight - element.scrollTop
}

function isTranscriptNearBottom(element: HTMLElement) {
  return transcriptBottomDistance(element) <= TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD
}

function hasTextSelectionWithin(element: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
  return Boolean(
    (selection.anchorNode && element.contains(selection.anchorNode))
    || (selection.focusNode && element.contains(selection.focusNode)),
  )
}

function planDetailItems(detail: string) {
  const lines = detail.split('\n').map(line => line.trim()).filter(Boolean)
  const parsed = lines.map(line => {
    const match = line.match(/^\[(x|>| )\]\s+(.+)$/i)
    if (!match) return null
    const marker = (match[1] || '').toLowerCase()
    return {
      status: marker === 'x' ? 'completed' : marker === '>' ? 'running' : 'pending',
      text: match[2] || '',
    }
  })
  if (parsed.some(item => item === null)) return null
  return parsed as Array<{ status: 'completed' | 'running' | 'pending'; text: string }>
}

function shouldRenderDetailAsProse(item: AgentTranscriptProcessItem) {
  return [
    'message',
    'agent-message',
    'progress',
    'reasoning',
    'thought',
    'hook',
    'warning',
    'error',
    'review',
    'rollback',
    'compaction',
    'subagent',
  ].includes(item.type)
}

function isNarrativeProcessItem(item: AgentTranscriptProcessItem) {
  return shouldRenderDetailAsProse(item) || item.type === 'plan' || item.type === 'user-steer'
}

function isCommandLikeProcessItem(item: AgentTranscriptProcessItem) {
  return !isNarrativeProcessItem(item)
}

type ProcessEntry =
  | { kind: 'item'; item: AgentTranscriptProcessItem }
  | { kind: 'group'; id: string; items: AgentTranscriptProcessItem[] }

function processEntriesForTurn(items: AgentTranscriptProcessItem[]) {
  const entries: ProcessEntry[] = []
  let group: AgentTranscriptProcessItem[] = []
  const flushGroup = () => {
    if (group.length > 0) entries.push({ kind: 'group', id: `group:${group[0]?.id || ''}`, items: group })
    group = []
  }
  for (const item of items) {
    if (isCommandLikeProcessItem(item)) {
      group.push(item)
      continue
    }
    flushGroup()
    entries.push({ kind: 'item', item })
  }
  flushGroup()
  return entries
}

const COMPACT_PROCESS_ACTION_LIMIT = 4

function compactProcessEntries(entries: ProcessEntry[], turnStatus: AgentTranscriptTurn['status']) {
  const eligible = turnStatus === 'inProgress'
    ? entries.flatMap(entry => (
        entry.kind === 'group'
          ? entry.items.filter(item => !isProcessItemFailed(item))
          : []
      ))
    : []
  const selectedIndexes = new Set<number>()
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    if (!isProcessItemRunning(eligible[index]!)) continue
    selectedIndexes.add(index)
    break
  }
  for (let index = eligible.length - 1; index >= 0 && selectedIndexes.size < COMPACT_PROCESS_ACTION_LIMIT; index -= 1) {
    selectedIndexes.add(index)
  }
  const items = eligible.filter((_item, index) => selectedIndexes.has(index))
  return { items, hiddenActionCount: eligible.length - items.length }
}

function compactAcpActionLabel(item: AgentTranscriptProcessItem, copy: CodeCopy) {
  if (isProcessItemFailed(item)) return copy.agentTranscriptActionFailed(item.title)
  return item.title
}

function processGroupLabel(items: AgentTranscriptProcessItem[]) {
  const failedCount = items.filter(item => ['failed', 'rejected', 'cancelled', 'canceled'].includes(String(item.status || '').toLowerCase())).length
  if (failedCount > 0) return failedCount === 1 ? 'Action failed' : `${failedCount} actions failed`
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    const type = item.type
    acc[type] = (acc[type] || 0) + 1
    return acc
  }, {})
  const commandCount = counts.command || 0
  const readLikeCount = (counts['file-read'] || 0) + (counts.read || 0)
  const searchCount = (counts['web-search'] || 0) + (counts.search || 0)
  const patchCount = counts.patch || 0
  if (items.length === readLikeCount + searchCount && (readLikeCount > 0 || searchCount > 0)) {
    const parts: string[] = []
    if (readLikeCount > 0) parts.push(readLikeCount === 1 ? 'read a file' : `read ${readLikeCount} files`)
    if (searchCount > 0) parts.push('searched code')
    const label = parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Completed actions'
  }
  if (items.length === commandCount) return commandCount === 1 ? 'Ran command' : `Ran ${commandCount} commands`
  if (items.length === readLikeCount) return readLikeCount === 1 ? 'Read a file' : `Read ${readLikeCount} files`
  if (items.length === searchCount) return searchCount === 1 ? 'Searched code' : `Searched ${searchCount} times`
  if (patchCount > 0 && patchCount === items.length) return patchCount === 1 ? 'Edited files' : `Edited files ${patchCount} times`
  if (commandCount > 0) return `Ran ${items.length} actions`
  return `Completed ${items.length} actions`
}

function hasExpandableProcessItemContent(item: AgentTranscriptProcessItem, detail: string, planItems: ReturnType<typeof planDetailItems>) {
  return Boolean(
    detail
    || planItems
    || (item.images || []).length > 0
    || (item.audios || []).length > 0
    || (item.files || []).length > 0
    || (item.terminals || []).length > 0
    || (item.terminalIds || []).length > 0
    || item.detailTruncated === true
    || Boolean(item.subagentSessionId)
    || item.subagentTranscript,
  )
}

function isPatchResultItem(item: AgentTranscriptProcessItem) {
  return item.type === 'patch'
}

function isUserSteerProcessItem(item: AgentTranscriptProcessItem) {
  return item.type === 'user-steer'
}

function patchResultLines(item: AgentTranscriptProcessItem) {
  return String(item.detail || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('Success.'))
    .filter(isPatchResultLine)
    .slice(0, 16)
}

function isPatchResultLine(line: string) {
  const trimmed = line.trim()
  return /^(add|added|delete|deleted|update|updated|move|moved|rename|renamed)\s+.+/i.test(trimmed) ||
    /^[AMDRC]\s+.+/.test(trimmed)
}

function parsePatchResultLine(line: string) {
  const trimmed = line.trim()
  const gitStatusMatch = trimmed.match(/^([AMDRC])\s+(.+)$/)
  if (gitStatusMatch) {
    return {
      kind: gitStatusMatch[1] || '',
      path: gitStatusMatch[2] || trimmed,
      added: '',
      removed: '',
    }
  }
  const statsMatch = trimmed.match(/\s(\+\d+)(?:\s(-\d+))?$/)
  const added = statsMatch?.[1] || ''
  const removed = statsMatch?.[2] || ''
  const withoutStats = statsMatch ? trimmed.slice(0, statsMatch.index).trim() : trimmed
  const kindMatch = withoutStats.match(/^(add|added|delete|deleted|update|updated|move|moved|rename|renamed)\s+(.+)$/i)
  return {
    kind: kindMatch?.[1] || '',
    path: kindMatch?.[2] || withoutStats,
    added,
    removed,
  }
}

type PatchResultRow = ReturnType<typeof parsePatchResultLine>

function normalizeTranscriptPath(value: string) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').trim()
}

function workspaceRelativeTranscriptPath(filePath: string, workspaceRoot?: string) {
  const normalizedPath = normalizeTranscriptPath(filePath)
  const normalizedRoot = normalizeTranscriptPath(workspaceRoot || '').replace(/\/+$/, '')
  if (!normalizedPath || !normalizedRoot) return normalizedPath
  const rootAliases = [normalizedRoot]
  if (normalizedRoot.startsWith('/private/')) rootAliases.push(normalizedRoot.slice('/private'.length))
  if (normalizedRoot.startsWith('/var/') || normalizedRoot.startsWith('/tmp/')) rootAliases.push(`/private${normalizedRoot}`)
  for (const root of rootAliases) {
    if (normalizedPath === root) return ''
    if (normalizedPath.startsWith(`${root}/`)) return normalizedPath.slice(root.length + 1)
  }
  return normalizedPath
}

function patchRowDisplayPath(row: PatchResultRow, workspaceRoot?: string) {
  return workspaceRelativeTranscriptPath(row.path, workspaceRoot) || row.path
}

function hasPatchStats(row: PatchResultRow) {
  return !!(row.added || row.removed)
}

function mergePatchRows(rows: PatchResultRow[], workspaceRoot?: string) {
  const deduped: PatchResultRow[] = []
  const seen = new Map<string, number>()
  for (const row of rows) {
    const displayPath = patchRowDisplayPath(row, workspaceRoot)
    const key = displayPath || row.path
    const existingIndex = seen.get(key)
    if (existingIndex === undefined) {
      seen.set(key, deduped.length)
      deduped.push({ ...row, path: displayPath || row.path })
      continue
    }
    const existing = deduped[existingIndex]
    if (!existing) continue
    if (hasPatchStats(row) || !hasPatchStats(existing)) {
      deduped[existingIndex] = { ...row, path: displayPath || row.path }
    }
  }
  return deduped
}

function patchRowsForChanges(changes: AgentTranscriptPatchChange[], workspaceRoot?: string) {
  return mergePatchRows(changes.map(change => ({
    kind: change.kind,
    path: change.path,
    added: change.added > 0 ? `+${change.added}` : '',
    removed: change.removed > 0 ? `-${change.removed}` : '',
  })), workspaceRoot)
}

function patchRowsForItems(items: AgentTranscriptProcessItem[], workspaceRoot?: string) {
  return mergePatchRows(
    items.flatMap(item => item.changes?.length
      ? patchRowsForChanges(item.changes)
      : patchResultLines(item).map(parsePatchResultLine)),
    workspaceRoot,
  )
}

function patchResultTitle(fileCount: number, failed: boolean) {
  if (failed) return fileCount === 1 ? 'Failed editing 1 file' : `Failed editing ${fileCount} files`
  return fileCount === 1 ? 'Edited 1 file' : `Edited ${fileCount} files`
}

function patchResultSummary(fileCount: number, failed: boolean) {
  if (failed) return patchResultTitle(fileCount, failed)
  return fileCount === 1 ? '1 file changed' : `${fileCount} files changed`
}

function patchDiffLineClass(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'added'
  if (line.startsWith('-') && !line.startsWith('---')) return 'removed'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('Index:') || line.startsWith('===')) return 'meta'
  return ''
}

function fallbackCopyText(text: string) {
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
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  textarea.remove()
  return copied
}

function toggleTranscriptDisclosureWithStableAnchor(anchor: HTMLElement, toggle: () => void) {
  const scroller = anchor.closest('.code-agent-transcript-scroll') as HTMLElement | null
  const beforeTop = anchor.getBoundingClientRect().top
  toggle()
  window.requestAnimationFrame(() => {
    if (!scroller?.isConnected || !anchor.isConnected) return
    const afterTop = anchor.getBoundingClientRect().top
    const delta = afterTop - beforeTop
    if (Math.abs(delta) < 0.5) return
    scroller.scrollTop += delta
  })
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return true
  }
  return fallbackCopyText(text)
}

function AgentTranscriptSteerItem({ item }: { item: AgentTranscriptProcessItem }) {
  const text = (item.detail || item.title || '').trim()
  const images = item.images || []
  const audios = item.audios || []
  const files = item.files || []
  const terminals = item.terminals || []
  if (!text && images.length <= 0 && audios.length <= 0 && files.length <= 0 && terminals.length <= 0) return null
  return (
    <div className="code-agent-transcript-steer" data-testid="code-agent-transcript-steer">
      <div className="code-agent-transcript-user code-agent-transcript-steer-bubble">
        {text ? <div>{plainTextBlock(text)}</div> : null}
        <AgentTranscriptUserImages images={images} />
        <AgentTranscriptAudios audios={audios} />
        <AgentTranscriptUserFiles files={files} />
        <AgentTranscriptTerminals terminals={terminals} />
      </div>
    </div>
  )
}

function AgentTranscriptProcessItemView({
  item,
  title,
  showStatus = true,
  copy,
  copied,
  detailOpen,
  onToggle,
  onCopy,
  onStopTerminal,
  onInputTerminal,
  onResizeTerminal,
  terminalOutcomeSyncFailed = false,
  onRetryTerminalOutcome,
  onStopSubagent,
}: {
  item: AgentTranscriptProcessItem
  title?: string
  showStatus?: boolean
  copy: CodeCopy
  copied: boolean
  detailOpen: boolean
  onToggle: (itemId: string) => void
  onCopy: (item: AgentTranscriptProcessItem) => void
  onStopTerminal?: (itemId: string, terminalId: string) => Promise<void>
  onInputTerminal?: (itemId: string, terminalId: string, input: string) => Promise<void>
  onResizeTerminal?: (itemId: string, terminalId: string, cols: number, rows: number) => Promise<void>
  terminalOutcomeSyncFailed?: boolean
  onRetryTerminalOutcome?: (itemId: string) => void
  onStopSubagent?: (sessionId: string) => Promise<void>
}) {
  if (isUserSteerProcessItem(item)) {
    return <AgentTranscriptSteerItem item={item} />
  }

  const images = item.images || []
  const audios = item.audios || []
  const files = item.files || []
  const terminals = item.terminals || []
  const copyableDetail = item.detail && item.detail.trim() !== item.title.trim() ? item.detail : ''
  const detail = copyableDetail && detailDuplicatesTerminalOutcome(copyableDetail, terminals)
    ? ''
    : copyableDetail
  const hasCopyableDetail = !!copyableDetail
  const hasDetail = !!detail
  const planItems = item.type === 'plan' && detail ? planDetailItems(detail) : null
  const expandable = hasExpandableProcessItemContent(item, detail, planItems)
  const displayTitle = title || item.title
  const details = (
    <>
      {planItems ? (
        <ul className="code-agent-transcript-plan-list">
          {planItems.map((entry, index) => (
            <li key={`${index}-${entry.text}`} className={entry.status}>
              <span className="code-agent-transcript-plan-marker" aria-hidden="true" />
              <span>{entry.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <AgentTranscriptProcessImages images={images} />
      <AgentTranscriptAudios audios={audios} />
      <AgentTranscriptUserFiles files={files} />
      {terminalOutcomeSyncFailed ? (
        <div
          className="code-agent-transcript-terminal-sync-error"
          data-testid="code-acp-terminal-sync-error"
          role="alert"
        >
          <span>{copy.agentTranscriptTerminalStatusUnavailable}</span>
          {onRetryTerminalOutcome ? (
            <button type="button" onClick={() => onRetryTerminalOutcome(item.id)}>
              {copy.agentTranscriptRetryTerminalStatus}
            </button>
          ) : null}
        </div>
      ) : (
        <AgentTranscriptTerminals
          terminals={terminals}
          terminalStateFinal={!isProcessItemRunning(item)}
          onStop={onStopTerminal ? terminalId => onStopTerminal(item.id, terminalId) : undefined}
          onInput={onInputTerminal ? (terminalId, input) => onInputTerminal(item.id, terminalId, input) : undefined}
          onResize={onResizeTerminal ? (terminalId, cols, rows) => onResizeTerminal(item.id, terminalId, cols, rows) : undefined}
        />
      )}
      {item.subagentTranscript ? (
        <AgentTranscriptSubagentPreview
          transcript={item.subagentTranscript}
          onStop={item.subagentSessionId && onStopSubagent ? () => onStopSubagent(item.subagentSessionId || '') : undefined}
        />
      ) : null}
      {!planItems && hasDetail && shouldRenderDetailAsProse(item) ? (
        <div className="code-agent-transcript-process-detail">{plainTextBlock(detail)}</div>
      ) : !planItems && hasDetail ? <pre>{detail}</pre> : null}
    </>
  )
  return (
    <section
      className={processItemClassName(item)}
      data-testid="code-agent-transcript-process-item"
      data-process-item-id={item.id}
      data-type={item.type}
      data-status={item.status || ''}
    >
      <div className="code-agent-transcript-process-title">
        <span className="code-agent-transcript-process-dot" aria-hidden="true" />
        {expandable ? (
          <button
            type="button"
            className="code-agent-transcript-process-title-toggle"
            data-testid="code-agent-transcript-process-item-toggle"
            aria-expanded={detailOpen}
            onPointerDown={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation()
              toggleTranscriptDisclosureWithStableAnchor(event.currentTarget, () => onToggle(item.id))
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              toggleTranscriptDisclosureWithStableAnchor(event.currentTarget, () => onToggle(item.id))
            }}
          >
            <span className="code-agent-transcript-process-title-text">{displayTitle}</span>
            {showStatus && shouldShowStatus(item.status) ? (
              <span className="code-agent-transcript-process-status">{item.status}</span>
            ) : null}
            <ChevronRightGlyph className="code-agent-transcript-process-item-chevron" />
          </button>
        ) : (
          <span className="code-agent-transcript-process-title-static">
            <span className="code-agent-transcript-process-title-text">{displayTitle}</span>
            {showStatus && shouldShowStatus(item.status) ? (
              <span className="code-agent-transcript-process-status">{item.status}</span>
            ) : null}
          </span>
        )}
        {hasCopyableDetail ? (
          <button
            type="button"
            className={`code-agent-transcript-copy ${copied ? 'copied' : ''}`}
            aria-label={copied ? copy.agentTranscriptCopiedDetails : copy.agentTranscriptCopyDetails}
            title={copied ? copy.agentTranscriptCopiedDetails : copy.agentTranscriptCopyDetails}
            data-tooltip={copied ? copy.agentTranscriptCopiedDetails : copy.agentTranscriptCopyDetails}
            onPointerDown={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            onClick={() => onCopy(item)}
          >
            {copied ? <CheckGlyph /> : <CopyGlyph />}
          </button>
        ) : null}
      </div>
      {expandable && detailOpen ? details : null}
    </section>
  )
}

function AgentTranscriptProgressUpdate({
  item,
  markdownComponents,
  compact = false,
}: {
  item: AgentTranscriptProcessItem
  markdownComponents: Components
  compact?: boolean
}) {
  const progressText = String(item.detail || '').trim()
  if (!progressText) return null
  const compactText = progressText.replace(/\s+/g, ' ').trim()
  const compactPreview = compactText.length > 240 ? `${compactText.slice(0, 239).trimEnd()}…` : compactText
  return (
    <div
      className={`code-acp-progress-update code-markdown-preview ${compact ? 'compact' : ''}`}
      data-testid="code-acp-progress-update"
    >
      {compact ? compactPreview : (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex, rehypeHighlight]}
          components={markdownComponents}
          skipHtml
          urlTransform={agentTranscriptUrlTransform}
        >
          {progressText}
        </ReactMarkdown>
      )}
    </div>
  )
}

function AgentTranscriptProcessGroupView({
  groupId,
  items,
  summaryLabel,
  copy,
  copiedItemId,
  detailOpen,
  openProcessItemIds,
  onToggleGroup,
  onToggleItem,
  onCopy,
  onStopTerminal,
  onInputTerminal,
  onResizeTerminal,
  terminalOutcomeSyncFailedItemIds,
  onRetryTerminalOutcome,
  onStopSubagent,
}: {
  groupId: string
  items: AgentTranscriptProcessItem[]
  summaryLabel?: string
  copy: CodeCopy
  copiedItemId: string
  detailOpen: boolean
  openProcessItemIds: Set<string>
  onToggleGroup: (groupId: string) => void
  onToggleItem: (itemId: string) => void
  onCopy: (item: AgentTranscriptProcessItem) => void
  onStopTerminal?: (itemId: string, terminalId: string) => Promise<void>
  onInputTerminal?: (itemId: string, terminalId: string, input: string) => Promise<void>
  onResizeTerminal?: (itemId: string, terminalId: string, cols: number, rows: number) => Promise<void>
  terminalOutcomeSyncFailedItemIds: Set<string>
  onRetryTerminalOutcome?: (itemId: string) => void
  onStopSubagent?: (sessionId: string) => Promise<void>
}) {
  const running = items.some(isProcessItemRunning)
  return (
    <section
      className={`code-agent-transcript-process-group ${running ? 'running' : ''}`}
      data-testid="code-agent-transcript-process-group"
      data-count={items.length}
    >
      <button
        type="button"
        className="code-agent-transcript-process-group-summary"
        data-testid="code-agent-transcript-process-group-toggle"
        aria-expanded={detailOpen}
        onPointerDown={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation()
          toggleTranscriptDisclosureWithStableAnchor(event.currentTarget, () => onToggleGroup(groupId))
        }}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          toggleTranscriptDisclosureWithStableAnchor(event.currentTarget, () => onToggleGroup(groupId))
        }}
      >
        <span className="code-agent-transcript-process-dot" aria-hidden="true" />
        <span className="code-agent-transcript-process-title-text">{summaryLabel || processGroupLabel(items)}</span>
        <ChevronRightGlyph className="code-agent-transcript-process-item-chevron" />
      </button>
      {detailOpen ? (
        <div className="code-agent-transcript-process-group-list">
          {items.map(item => (
            <AgentTranscriptProcessItemView
              key={item.id}
              item={item}
              copy={copy}
              copied={copiedItemId === item.id}
              detailOpen={openProcessItemIds.has(item.id)}
              onToggle={onToggleItem}
              onCopy={onCopy}
              onStopTerminal={onStopTerminal}
              onInputTerminal={onInputTerminal}
              onResizeTerminal={onResizeTerminal}
              terminalOutcomeSyncFailed={terminalOutcomeSyncFailedItemIds.has(item.id)}
              onRetryTerminalOutcome={onRetryTerminalOutcome}
              onStopSubagent={onStopSubagent}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function AgentTranscriptPatchResultCard({
  items,
  copy,
  onLoadPatchChanges,
  onCreateReview,
  onDecidePatch,
  source,
  workspaceRoot,
}: {
  items: AgentTranscriptProcessItem[]
  copy: CodeCopy
  onLoadPatchChanges?: (itemIds: string[]) => Promise<AgentTranscriptPatchChange[]>
  onCreateReview?: (itemIds: string[]) => string
  onDecidePatch?: (itemId: string, path: string, decision: 'keep' | 'revert') => Promise<{ action: string }>
  source: AgentTranscriptPaneProps['source']
  workspaceRoot?: string
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailedChanges, setDetailedChanges] = useState<AgentTranscriptPatchChange[] | null>(null)
  const [detailError, setDetailError] = useState('')
  const embeddedDecisions = useMemo(() => Object.fromEntries(items.flatMap(item => (
    (item.changes || []).flatMap(change => {
      if (!change.decision) return []
      const displayPath = workspaceRelativeTranscriptPath(change.path, workspaceRoot) || change.path
      return [[displayPath, change.decision] as const]
    })
  ))), [items, workspaceRoot])
  const [patchDecisions, setPatchDecisions] = useState<Record<string, string>>(embeddedDecisions)
  const [decidingPath, setDecidingPath] = useState('')
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    setPatchDecisions(current => ({ ...embeddedDecisions, ...current }))
  }, [embeddedDecisions])
  const embeddedRows = patchRowsForItems(items, workspaceRoot)
  const detailedRows = detailedChanges ? patchRowsForChanges(detailedChanges, workspaceRoot) : []
  const detailedRowsByPath = new Map(detailedRows.map(row => [row.path, row]))
  const rows = detailedChanges
    ? [
        ...embeddedRows.map(row => detailedRowsByPath.get(row.path) || row),
        ...detailedRows.filter(row => !embeddedRows.some(embedded => embedded.path === row.path)),
      ]
    : embeddedRows
  const failed = items.some(item => item.status === 'failed')
  const totalAdded = rows.reduce((sum, row) => sum + Number(row.added.replace('+', '') || 0), 0)
  const totalRemoved = rows.reduce((sum, row) => sum + Number(row.removed.replace('-', '') || 0), 0)
  const summary = patchResultSummary(rows.length, failed)
  const embeddedChanges = items.flatMap(item => item.changes || [])
  const detailedChangePaths = new Set((detailedChanges || []).map(change => change.path))
  const availableChanges = detailedChanges
    ? [
        ...detailedChanges,
        ...embeddedChanges.filter(change => !detailedChangePaths.has(
          workspaceRelativeTranscriptPath(change.path, workspaceRoot) || change.path,
        )),
      ]
    : embeddedChanges
  const reviewPaths = source === 'acp'
    ? rows.map(row => workspaceRelativeTranscriptPath(row.path, workspaceRoot))
      .filter(path => path && !path.startsWith('/') && !path.split('/').includes('..'))
    : []
  const patchTargetForPath = useCallback((displayPath: string) => {
    const matches = items.flatMap(item => (item.changes || [])
      .filter(change => (workspaceRelativeTranscriptPath(change.path, workspaceRoot) || change.path) === displayPath)
      .map(change => ({ itemId: item.id, path: change.path })))
    return matches.length === 1 ? matches[0] : null
  }, [items, workspaceRoot])
  const decidePatch = useCallback((displayPath: string, decision: 'keep' | 'revert') => {
    const target = patchTargetForPath(displayPath)
    if (!target || !onDecidePatch || decidingPath) return
    setDecidingPath(displayPath)
    setDecisionErrors(current => ({ ...current, [displayPath]: '' }))
    void onDecidePatch(target.itemId, target.path, decision)
      .then(result => setPatchDecisions(current => ({ ...current, [displayPath]: result.action })))
      .catch(error => setDecisionErrors(current => ({
        ...current,
        [displayPath]: error instanceof Error ? error.message : copy.agentTranscriptUnavailable,
      })))
      .finally(() => setDecidingPath(''))
  }, [copy.agentTranscriptUnavailable, decidingPath, onDecidePatch, patchTargetForPath])
  const handleReview = useCallback(() => {
    if (!workspaceRoot) return
    if (source === 'acp' && reviewPaths.length === 0) return
    if (source === 'acp' && onCreateReview) {
      window.open(onCreateReview(items.map(item => item.id)), '_blank', 'noopener,noreferrer')
      return
    }
    const params = new URLSearchParams({ root: workspaceRoot })
    if (source === 'acp') {
      reviewPaths.forEach(path => params.append('path', path))
    }
    window.open(appPath(`/review?${params.toString()}`), '_blank', 'noopener,noreferrer')
  }, [items, onCreateReview, reviewPaths, source, workspaceRoot])
  const handleSummary = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (source !== 'acp') {
      handleReview()
      return
    }
    toggleTranscriptDisclosureWithStableAnchor(event.currentTarget, () => {
      setDetailOpen(current => !current)
    })
    if (detailOpen || detailedChanges || !onLoadPatchChanges) return
    setDetailError('')
    void onLoadPatchChanges(items.map(item => item.id))
      .then(setDetailedChanges)
      .catch(error => setDetailError(error instanceof Error ? error.message : copy.agentTranscriptUnavailable))
  }, [copy.agentTranscriptUnavailable, detailOpen, detailedChanges, handleReview, items, onLoadPatchChanges, source])
  const summaryContent = (
    <>
      <span>{summary}</span>
      {totalAdded ? <span className="added">+{totalAdded}</span> : null}
      {totalRemoved ? <span className="removed">-{totalRemoved}</span> : null}
    </>
  )
  return (
    <section
      className={`code-agent-transcript-result-card ${failed ? 'failed' : ''}`}
      data-testid="code-agent-transcript-result-card"
    >
      {workspaceRoot && rows.length > 0 ? (
        <button
          type="button"
          className="code-agent-transcript-result-summary"
          data-testid="code-agent-transcript-result-summary"
          aria-label={`${summary}. ${source === 'acp' ? copy.agentTranscriptShowChanges : copy.agentTranscriptReviewChanges}`}
          aria-expanded={source === 'acp' ? detailOpen : undefined}
          onClick={handleSummary}
        >
          {summaryContent}
          {source === 'acp' ? <ChevronRightGlyph className="code-agent-transcript-result-chevron" /> : null}
        </button>
      ) : (
        <div className="code-agent-transcript-result-summary" aria-label={summary}>
          {summaryContent}
        </div>
      )}
      {source === 'acp' && detailOpen ? (
        <div className="code-agent-transcript-result-details" data-testid="code-agent-transcript-result-details">
          <div className="code-agent-transcript-result-files">
            {rows.map(row => {
              const path = patchRowDisplayPath(row, workspaceRoot)
              const changes = availableChanges.filter(change => (
                (workspaceRelativeTranscriptPath(change.path, workspaceRoot) || change.path) === path
              ))
              const patchTarget = patchTargetForPath(path)
              const decision = patchDecisions[path]
              return (
                <details className="code-agent-transcript-result-file" key={`${items[0]?.id || 'patch'}:${path}`}>
                  <summary>
                    <span className="code-agent-transcript-result-file-path">{path}</span>
                    <span className="code-agent-transcript-result-file-stats">
                      {row.added ? <span className="added">{row.added}</span> : null}
                      {row.removed ? <span className="removed">{row.removed}</span> : null}
                    </span>
                  </summary>
                  {changes.map((change, changeIndex) => change.diff ? (
                    <pre className="code-agent-transcript-result-diff" key={`${path}:${changeIndex}`}>
                      {change.diff.split('\n').map((line, lineIndex) => (
                        <span className={patchDiffLineClass(line)} key={`${lineIndex}:${line}`}>{line}{'\n'}</span>
                      ))}
                    </pre>
                  ) : null)}
                  {patchTarget && onDecidePatch ? (
                    <div className="code-agent-transcript-result-decision" data-testid="code-acp-patch-decision">
                      {decision ? (
                        <span>{decision === 'reverted' ? copy.agentTranscriptChangeReverted : copy.agentTranscriptChangeKept}</span>
                      ) : (
                        <>
                          <button type="button" disabled={Boolean(decidingPath)} onClick={() => decidePatch(path, 'keep')}>
                            {copy.agentTranscriptKeepChange}
                          </button>
                          <button type="button" className="revert" disabled={Boolean(decidingPath)} onClick={() => decidePatch(path, 'revert')}>
                            {copy.agentTranscriptRevertChange}
                          </button>
                        </>
                      )}
                      {decisionErrors[path] ? <small role="alert">{decisionErrors[path]}</small> : null}
                    </div>
                  ) : null}
                </details>
              )
            })}
          </div>
          {!detailedChanges && !detailError ? (
            <div className="code-agent-transcript-result-loading">{copy.agentTranscriptLoadingChanges}</div>
          ) : null}
          {detailError ? <div className="code-agent-transcript-result-error">{detailError}</div> : null}
          {source !== 'acp' || reviewPaths.length > 0 ? (
            <button
              type="button"
              className="code-agent-transcript-result-review"
              aria-label={`${copy.agentTranscriptReviewChanges}: ${reviewPaths.length} workspace ${reviewPaths.length === 1 ? 'file' : 'files'}`}
              onClick={handleReview}
            >
              {copy.agentTranscriptReviewChanges}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function AgentTranscriptTurnView({
  turn,
  copy,
  onOpenFile,
  workspaceRoot,
  processOpen,
  groupProcessActions,
  source,
  onToggleProcess,
  onLoadProcessItemDetail,
  onLoadPatchChanges,
  onCreatePatchReview,
  onDecidePatch,
  onStopTerminal,
  onInputTerminal,
  onResizeTerminal,
  onStopSubagent,
}: {
  turn: AgentTranscriptTurn
  copy: CodeCopy
  onOpenFile?: (filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  workspaceRoot?: string
  processOpen: boolean
  groupProcessActions: boolean
  source: AgentTranscriptPaneProps['source']
  onToggleProcess: (turnId: string) => void
  onLoadProcessItemDetail?: (itemId: string) => Promise<AgentTranscriptProcessPresentation>
  onLoadPatchChanges?: (itemIds: string[]) => Promise<AgentTranscriptPatchChange[]>
  onCreatePatchReview?: (itemIds: string[]) => string
  onDecidePatch?: (itemId: string, path: string, decision: 'keep' | 'revert') => Promise<{ action: string }>
  onStopTerminal?: (terminalId: string) => Promise<void>
  onInputTerminal?: (terminalId: string, input: string) => Promise<void>
  onResizeTerminal?: (terminalId: string, cols: number, rows: number) => Promise<void>
  onStopSubagent?: (sessionId: string) => Promise<void>
}) {
  const [loadedProcessDetails, setLoadedProcessDetails] = useState<Record<string, AgentTranscriptProcessPresentation>>({})
  const loadingProcessDetailsRef = useRef<Set<string>>(new Set())
  const resolvedProcessItems = useMemo(() => turn.processItems.map(item => (
    Object.prototype.hasOwnProperty.call(loadedProcessDetails, item.id)
      ? {
          ...item,
          detail: loadedProcessDetails[item.id]?.detail || '',
          terminals: loadedProcessDetails[item.id]?.terminals,
          subagentTranscript: loadedProcessDetails[item.id]?.subagentTranscript,
          detailTruncated: false,
        }
      : item
  )), [loadedProcessDetails, turn.processItems])
  const hasProcess = resolvedProcessItems.length > 0
  const patchResults = resolvedProcessItems.filter(isPatchResultItem)
  const userImages = turn.userImages || []
  const userAudios = turn.userAudios || []
  const userFiles = turn.userFiles || []
  const resultImages = turn.resultImages || []
  const resultAudios = turn.resultAudios || []
  const resultFiles = turn.resultFiles || []
  const [copiedItemId, setCopiedItemId] = useState('')
  const [answerCopied, setAnswerCopied] = useState(false)
  const [openProcessItemIds, setOpenProcessItemIds] = useState<Set<string>>(() => new Set())
  const [closedLiveProcessItemIds, setClosedLiveProcessItemIds] = useState<Set<string>>(() => new Set())
  const [terminalOutcomeSyncFailedItemIds, setTerminalOutcomeSyncFailedItemIds] = useState<Set<string>>(() => new Set())
  const manuallyToggledProcessItemIdsRef = useRef(new Set<string>())
  const autoExpandedTerminalItemIdsRef = useRef(new Set<string>())
  const autoHandledTerminalItemIdsRef = useRef(new Set<string>())
  const observedRunningTerminalItemIdsRef = useRef(new Set<string>())
  const refreshedTerminalOutcomeItemIdsRef = useRef(new Set<string>())
  const syncingTerminalOutcomeItemIdsRef = useRef(new Set<string>())
  const [, setProgressClock] = useState(0)
  const processEntries = useMemo(() => (
    groupProcessActions
      ? processEntriesForTurn(resolvedProcessItems)
      : resolvedProcessItems.map(item => ({ kind: 'item' as const, item }))
  ), [groupProcessActions, resolvedProcessItems])
  const compactProcess = useMemo(
    () => compactProcessEntries(processEntries, turn.status),
    [processEntries, turn.status],
  )
  const latestLiveThoughtId = useMemo(() => {
    if (turn.status !== 'inProgress') return ''
    return [...resolvedProcessItems]
      .reverse()
      .find(item => ['reasoning', 'thought'].includes(item.type) && Boolean(String(item.detail || '').trim()))
      ?.id || ''
  }, [resolvedProcessItems, turn.status])
  const latestLiveProgressItem = useMemo(() => {
    if (source !== 'acp' || turn.status !== 'inProgress') return null
    return [...resolvedProcessItems]
      .reverse()
      .find(item => isAcpProgressUpdate(item) && Boolean(String(item.detail || '').trim()))
      || null
  }, [resolvedProcessItems, source, turn.status])
  const compactViewport = isCompactViewport()
  const answerMessage = useMemo(() => stripRawMemoryCitation(turn.finalMessage), [turn.finalMessage])
  const shouldShowWaiting = turn.status === 'inProgress'
    && !answerMessage
    && compactProcess.items.length === 0
    && (
    Boolean(turn.userMessage) || userImages.length > 0 || userAudios.length > 0 || userFiles.length > 0 || hasProcess
    )
  useEffect(() => {
    if (turn.status !== 'inProgress' || !turn.startedAt) return undefined
    const timer = window.setInterval(() => setProgressClock(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [turn.startedAt, turn.status])
  const progressDuration = turn.status === 'inProgress'
    ? elapsedDurationLabel(turn.startedAt)
    : ''
  const activityTurn = resolvedProcessItems === turn.processItems
    ? turn
    : { ...turn, processItems: resolvedProcessItems }
  const workingLabel = source === 'acp' ? acpActivityLabel(activityTurn, copy) : copy.agentTranscriptWorking
  const processSummaryWorkingLabel = compactProcess.items.length > 0
    ? copy.agentTranscriptProcess
    : workingLabel
  const liveToolLabel = source === 'acp' ? acpLiveToolLabel(activityTurn, copy) : ''
  const planLabel = source === 'acp' ? acpPlanLabel(activityTurn, copy) : ''
  const loadFullProcessDetail = useCallback(async (item: AgentTranscriptProcessItem, force = false) => {
    if ((!item.detailTruncated && !item.terminalIds?.length && !item.subagentSessionId) || !onLoadProcessItemDetail) {
      return { detail: item.detail || '', terminals: item.terminals, subagentTranscript: item.subagentTranscript }
    }
    if (!force && Object.prototype.hasOwnProperty.call(loadedProcessDetails, item.id)) {
      return loadedProcessDetails[item.id] || { detail: item.detail || '' }
    }
    if (loadingProcessDetailsRef.current.has(item.id)) return { detail: item.detail || '' }
    loadingProcessDetailsRef.current.add(item.id)
    try {
      const presentation = await onLoadProcessItemDetail(item.id)
      setLoadedProcessDetails(current => ({ ...current, [item.id]: presentation }))
      return presentation
    } finally {
      loadingProcessDetailsRef.current.delete(item.id)
    }
  }, [loadedProcessDetails, onLoadProcessItemDetail])
  const refreshTerminalOutcome = useCallback((item: AgentTranscriptProcessItem) => {
    if (syncingTerminalOutcomeItemIdsRef.current.has(item.id)) return
    syncingTerminalOutcomeItemIdsRef.current.add(item.id)
    refreshedTerminalOutcomeItemIdsRef.current.add(item.id)
    setTerminalOutcomeSyncFailedItemIds(current => {
      if (!current.has(item.id)) return current
      const next = new Set(current)
      next.delete(item.id)
      return next
    })
    const finishFailure = () => {
      syncingTerminalOutcomeItemIdsRef.current.delete(item.id)
      setTerminalOutcomeSyncFailedItemIds(current => new Set([...current, item.id]))
    }
    const refresh = (attempt: number) => {
      void loadFullProcessDetail(item, true).then(presentation => {
        const terminalOutcomeReady = presentation.terminals?.some(terminal => (
          Boolean(terminal.terminal?.exitStatus) || terminal.terminal?.released
        ))
        if (!terminalOutcomeReady) {
          if (attempt < 2) {
            window.setTimeout(() => refresh(attempt + 1), 500 * (attempt + 1))
            return
          }
          finishFailure()
          return
        }
        syncingTerminalOutcomeItemIdsRef.current.delete(item.id)
        observedRunningTerminalItemIdsRef.current.delete(item.id)
      }).catch(() => {
        if (attempt < 2) {
          window.setTimeout(() => refresh(attempt + 1), 500 * (attempt + 1))
          return
        }
        finishFailure()
      })
    }
    refresh(0)
  }, [loadFullProcessDetail])
  useEffect(() => {
    if (source !== 'acp' || turn.status !== 'inProgress' || processOpen) return undefined
    const candidates = compactProcess.items.filter(item => (
      item.terminalIds?.length
      && isProcessItemRunning(item)
      && !autoHandledTerminalItemIdsRef.current.has(item.id)
      && !manuallyToggledProcessItemIdsRef.current.has(item.id)
    ))
    if (candidates.length === 0) return undefined
    let stopped = false
    const checkForOutput = () => candidates.forEach(item => {
      void loadFullProcessDetail(item, true).then(presentation => {
        if (stopped || autoHandledTerminalItemIdsRef.current.has(item.id)) return
        const hasRealOutput = presentation.terminals?.some(terminal => Boolean(terminal.terminal?.output?.trim()))
        if (!hasRealOutput) return
        autoHandledTerminalItemIdsRef.current.add(item.id)
        autoExpandedTerminalItemIdsRef.current.add(item.id)
        setOpenProcessItemIds(current => new Set([...current, item.id]))
      }).catch(() => {})
    })
    const timer = window.setInterval(checkForOutput, 500)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [compactProcess.items, loadFullProcessDetail, processOpen, source, turn.status])
  useEffect(() => {
    const itemById = new Map(resolvedProcessItems.map(item => [item.id, item]))
    const completed = [...autoExpandedTerminalItemIdsRef.current]
      .filter(itemId => {
        const item = itemById.get(itemId)
        return !item || !isProcessItemRunning(item)
      })
    if (completed.length === 0) return
    setOpenProcessItemIds(current => {
      const next = new Set(current)
      for (const itemId of completed) {
        const item = itemById.get(itemId)
        if (!(item && isProcessItemFailed(item))
          && !manuallyToggledProcessItemIdsRef.current.has(itemId)) next.delete(itemId)
        autoExpandedTerminalItemIdsRef.current.delete(itemId)
      }
      return next
    })
  }, [resolvedProcessItems])
  useEffect(() => {
    resolvedProcessItems
      .filter(item => item.terminalIds?.length && isProcessItemRunning(item))
      .forEach(item => observedRunningTerminalItemIdsRef.current.add(item.id))
    const completedTerminalItems = resolvedProcessItems.filter(item => (
      item.terminalIds?.length
      && !isProcessItemRunning(item)
      && observedRunningTerminalItemIdsRef.current.has(item.id)
      && !refreshedTerminalOutcomeItemIdsRef.current.has(item.id)
    ))
    completedTerminalItems.forEach(refreshTerminalOutcome)
  }, [refreshTerminalOutcome, resolvedProcessItems])
  useEffect(() => {
    const liveTerminalItems = resolvedProcessItems.filter(item => (
      item.terminalIds?.length
      && isProcessItemRunning(item)
      && openProcessItemIds.has(item.id)
    ))
    if (liveTerminalItems.length === 0) return undefined
    const refresh = () => liveTerminalItems.forEach(item => {
      void loadFullProcessDetail(item, true).catch(() => {})
    })
    refresh()
    const timer = window.setInterval(refresh, 1_000)
    return () => window.clearInterval(timer)
  }, [loadFullProcessDetail, openProcessItemIds, resolvedProcessItems])
  const handleCopyItem = useCallback((item: AgentTranscriptProcessItem) => {
    void loadFullProcessDetail(item).then(presentation => {
      const text = [item.title, presentation.detail].filter(Boolean).join('\n\n')
      if (!text) return
      return writeClipboardText(text)
    }).then(copied => {
      if (!copied) return
      setCopiedItemId(item.id)
      window.setTimeout(() => setCopiedItemId(current => (current === item.id ? '' : current)), 1200)
    }).catch(() => {})
  }, [loadFullProcessDetail])
  const handleCopyAnswer = useCallback(() => {
    const text = answerMessage.trim()
    if (!text) return
    void writeClipboardText(text).then(copied => {
      if (!copied) return
      setAnswerCopied(true)
      window.setTimeout(() => setAnswerCopied(false), 1200)
    })
  }, [answerMessage])
  const toggleProcessOpen = useCallback(() => {
    onToggleProcess(turn.id)
  }, [onToggleProcess, turn.id])
  const handleToggleProcessItem = useCallback((itemId: string) => {
    manuallyToggledProcessItemIdsRef.current.add(itemId)
    if (itemId === latestLiveThoughtId && !openProcessItemIds.has(itemId)) {
      setClosedLiveProcessItemIds(current => {
        const next = new Set(current)
        if (next.has(itemId)) next.delete(itemId)
        else next.add(itemId)
        return next
      })
      return
    }
    const opening = !openProcessItemIds.has(itemId)
    if (opening) {
      const item = resolvedProcessItems.find(candidate => candidate.id === itemId)
      if (item?.detailTruncated || item?.terminalIds?.length || item?.subagentSessionId) {
        void loadFullProcessDetail(item).catch(() => {})
      }
    }
    setOpenProcessItemIds(current => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }, [latestLiveThoughtId, loadFullProcessDetail, openProcessItemIds, resolvedProcessItems])
  const handleStopTerminal = useCallback(async (itemId: string, terminalId: string) => {
    if (!onStopTerminal) return
    await onStopTerminal(terminalId)
    const item = resolvedProcessItems.find(candidate => candidate.id === itemId)
    if (item) await loadFullProcessDetail(item, true)
  }, [loadFullProcessDetail, onStopTerminal, resolvedProcessItems])
  const handleInputTerminal = useCallback(async (itemId: string, terminalId: string, input: string) => {
    if (!onInputTerminal) return
    await onInputTerminal(terminalId, input)
    const item = resolvedProcessItems.find(candidate => candidate.id === itemId)
    if (item) await loadFullProcessDetail(item, true)
  }, [loadFullProcessDetail, onInputTerminal, resolvedProcessItems])
  const handleResizeTerminal = useCallback(async (_itemId: string, terminalId: string, cols: number, rows: number) => {
    if (!onResizeTerminal) return
    await onResizeTerminal(terminalId, cols, rows)
  }, [onResizeTerminal])
  const handleRetryTerminalOutcome = useCallback((itemId: string) => {
    const item = resolvedProcessItems.find(candidate => candidate.id === itemId)
    if (item) refreshTerminalOutcome(item)
  }, [refreshTerminalOutcome, resolvedProcessItems])
  // Keep the process compact while the agent works. The short activity label
  // carries the live state; full reasoning and tool details remain opt-in.
  const effectiveProcessOpen = processOpen
  const markdownComponents = useMemo<Components>(() => ({
    a: ({ href, children, onClick, ...props }) => {
      const target = href ? transcriptFileTargetFromText(href, workspaceRoot) : null
      const external = href ? isExternalTranscriptHref(href) : false
      const normalizedHref = href ? normalizeTranscriptHref(href) : href
      const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
        onClick?.(event)
        if (event.defaultPrevented || !target || !onOpenFile) return
        event.preventDefault()
        onOpenFile(target.filePath, target.target)
      }
      return (
        <a
          {...props}
          className={[props.className, target ? 'code-agent-transcript-markdown-file-link' : ''].filter(Boolean).join(' ') || undefined}
          href={target ? '#' : normalizedHref}
          target={external ? '_blank' : undefined}
          rel={external ? 'noreferrer' : undefined}
          onPointerDown={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
          onClick={handleClick}
        >
          {target ? (
            <TranscriptFileLinkLabel filePath={target.filePath} lineNumber={target.target?.lineNumber}>
              {children}
            </TranscriptFileLinkLabel>
          ) : children}
        </a>
      )
    },
    code: ({ className, children, ...props }) => {
      const source = textContent(children)
      const looksLikeBlock = Boolean(className) || source.includes('\n')
      const target = !looksLikeBlock && hasQualifiedTranscriptFileReference(source)
        ? transcriptFileTargetFromText(source, workspaceRoot)
        : null
      if (!target || !onOpenFile) {
        return <code className={className} {...props}>{children}</code>
      }
      return (
        <a
          className="code-agent-transcript-markdown-file-link"
          href="#"
          onPointerDown={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
          onClick={event => {
            event.preventDefault()
            onOpenFile(target.filePath, target.target)
          }}
        >
          <TranscriptFileLinkLabel filePath={target.filePath} lineNumber={target.target?.lineNumber}>
            {children}
          </TranscriptFileLinkLabel>
        </a>
      )
    },
    pre: ({ children, ...props }) => {
      const mermaidSource = isMermaidCodeBlock(children)
      if (mermaidSource !== null) return <MermaidBlock source={mermaidSource} copy={copy} />
      return <pre {...props}>{children}</pre>
    },
  }), [copy, onOpenFile, workspaceRoot])

  return (
    <article className={`code-agent-transcript-turn ${turn.status === 'inProgress' ? 'running' : ''}`} data-turn-id={turn.id}>
      {turn.userMessage || userImages.length > 0 || userAudios.length > 0 || userFiles.length > 0 ? (
        <div className="code-agent-transcript-user">
          {turn.userMessage ? <div>{plainTextBlock(turn.userMessage)}</div> : null}
          <AgentTranscriptUserImages images={userImages} />
          <AgentTranscriptAudios audios={userAudios} />
          <AgentTranscriptUserFiles files={userFiles} />
        </div>
      ) : null}

      {hasProcess ? (
        <div className={`code-agent-transcript-process ${effectiveProcessOpen ? 'expanded' : ''}`}>
          <button
            type="button"
            className="code-agent-transcript-process-summary"
            data-testid="code-agent-transcript-process-summary"
            aria-expanded={effectiveProcessOpen}
            title={liveToolLabel || turnProcessTitle(turn, copy)}
            onPointerDown={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation()
              toggleTranscriptDisclosureWithStableAnchor(event.currentTarget, toggleProcessOpen)
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              toggleTranscriptDisclosureWithStableAnchor(event.currentTarget, toggleProcessOpen)
            }}
          >
            <span className="code-agent-transcript-process-summary-label">
              {turnProcessLabel(turn, copy, processSummaryWorkingLabel, planLabel)}
            </span>
            <ChevronRightGlyph className="code-agent-transcript-chevron" />
          </button>
          {!effectiveProcessOpen ? resolvedProcessItems
            .filter(isUserSteerProcessItem)
            .map(item => <AgentTranscriptSteerItem key={item.id} item={item} />) : null}
          {!effectiveProcessOpen && compactProcess.items.length > 0 ? (
            <div
              className="code-agent-transcript-process-list code-agent-transcript-process-compact-list"
              data-testid="code-agent-transcript-process-compact-list"
            >
              {compactProcess.hiddenActionCount > 0 ? (
                <button
                  type="button"
                  className="code-agent-transcript-process-earlier"
                  data-testid="code-agent-transcript-process-earlier"
                  onClick={event => {
                    event.stopPropagation()
                    toggleProcessOpen()
                  }}
                >
                  {copy.agentTranscriptEarlierActions(compactProcess.hiddenActionCount)}
                </button>
              ) : null}
              {compactProcess.items.map(item => (
                <AgentTranscriptProcessItemView
                  key={item.id}
                  item={item}
                  title={source === 'acp' ? compactAcpActionLabel(item, copy) : item.title}
                  showStatus={false}
                  copy={copy}
                  copied={copiedItemId === item.id}
                  detailOpen={openProcessItemIds.has(item.id)}
                  onToggle={handleToggleProcessItem}
                  onCopy={handleCopyItem}
                  onStopTerminal={handleStopTerminal}
                  onInputTerminal={handleInputTerminal}
                  onResizeTerminal={handleResizeTerminal}
                  terminalOutcomeSyncFailed={terminalOutcomeSyncFailedItemIds.has(item.id)}
                  onRetryTerminalOutcome={handleRetryTerminalOutcome}
                  onStopSubagent={onStopSubagent}
                />
              ))}
            </div>
          ) : null}
          {!effectiveProcessOpen && latestLiveProgressItem ? (
            <AgentTranscriptProgressUpdate
              item={latestLiveProgressItem}
              markdownComponents={markdownComponents}
              compact
            />
          ) : null}
          {effectiveProcessOpen ? (
            <div className="code-agent-transcript-process-list">
              {processEntries.map(entry => {
                if (entry.kind === 'group') {
                  const groupOpen = openProcessItemIds.has(entry.id)
                    || entry.items.some(item => openProcessItemIds.has(item.id))
                    || (
                    source !== 'acp'
                    && !compactViewport
                    && entry.items.some(isProcessItemRunning)
                  )
                  return (
                    <AgentTranscriptProcessGroupView
                      key={entry.id}
                      groupId={entry.id}
                      items={entry.items}
                      summaryLabel={source === 'acp' ? acpActionGroupLabel(entry.items) : undefined}
                      copy={copy}
                      copiedItemId={copiedItemId}
                      detailOpen={groupOpen}
                      openProcessItemIds={latestLiveThoughtId && !closedLiveProcessItemIds.has(latestLiveThoughtId)
                        ? new Set([...openProcessItemIds, latestLiveThoughtId])
                        : openProcessItemIds}
                      onToggleGroup={handleToggleProcessItem}
                      onToggleItem={handleToggleProcessItem}
                      onCopy={handleCopyItem}
                      onStopTerminal={handleStopTerminal}
                      onInputTerminal={handleInputTerminal}
                      onResizeTerminal={handleResizeTerminal}
                      terminalOutcomeSyncFailedItemIds={terminalOutcomeSyncFailedItemIds}
                      onRetryTerminalOutcome={handleRetryTerminalOutcome}
                      onStopSubagent={onStopSubagent}
                    />
                  )
                }
                if (source === 'acp' && isAcpProgressUpdate(entry.item)) {
                  return (
                    <AgentTranscriptProgressUpdate
                      key={entry.item.id}
                      item={entry.item}
                      markdownComponents={markdownComponents}
                    />
                  )
                }
                return (
                  <AgentTranscriptProcessItemView
                    key={entry.item.id}
                    item={entry.item}
                    copy={copy}
                    copied={copiedItemId === entry.item.id}
                    detailOpen={openProcessItemIds.has(entry.item.id) || (
                      entry.item.id === latestLiveThoughtId
                      && !closedLiveProcessItemIds.has(entry.item.id)
                    )}
                    onToggle={handleToggleProcessItem}
                    onCopy={handleCopyItem}
                    onStopTerminal={handleStopTerminal}
                    onInputTerminal={handleInputTerminal}
                    onResizeTerminal={handleResizeTerminal}
                    terminalOutcomeSyncFailed={terminalOutcomeSyncFailedItemIds.has(entry.item.id)}
                    onRetryTerminalOutcome={handleRetryTerminalOutcome}
                    onStopSubagent={onStopSubagent}
                  />
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {answerMessage || resultImages.length > 0 || resultAudios.length > 0 || resultFiles.length > 0 ? (
        <div className="code-agent-transcript-answer">
          {answerMessage ? (
            <div className="code-agent-transcript-assistant code-markdown-preview">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex, rehypeHighlight]}
                components={markdownComponents}
                skipHtml
                urlTransform={agentTranscriptUrlTransform}
              >
                {answerMessage}
              </ReactMarkdown>
            </div>
          ) : null}
          <AgentTranscriptResultImages images={resultImages} />
          <AgentTranscriptAudios audios={resultAudios} />
          <AgentTranscriptUserFiles files={resultFiles} />
          {answerMessage ? <div className="code-agent-transcript-answer-actions">
            <button
              type="button"
              className={`code-agent-transcript-answer-action ${answerCopied ? 'copied' : ''}`}
              data-testid="code-agent-transcript-copy-answer"
              aria-label={answerCopied ? copy.agentTranscriptCopiedAnswer : copy.agentTranscriptCopyAnswer}
              title={answerCopied ? copy.agentTranscriptCopiedAnswer : copy.agentTranscriptCopyAnswer}
              data-tooltip={answerCopied ? copy.agentTranscriptCopiedAnswer : copy.agentTranscriptCopyAnswer}
              onClick={handleCopyAnswer}
            >
              {answerCopied ? <CheckGlyph /> : <CopyGlyph />}
            </button>
          </div> : null}
        </div>
      ) : shouldShowWaiting ? (
        <div className="code-agent-transcript-placeholder">{copy.agentTranscriptWaiting}</div>
      ) : null}

      {patchResults.length > 0 || turn.status === 'inProgress' ? (
        <div className="code-agent-transcript-results code-agent-transcript-status-row">
          {patchResults.length > 0 ? (
            <AgentTranscriptPatchResultCard
              items={patchResults}
              copy={copy}
              onLoadPatchChanges={onLoadPatchChanges}
              onCreateReview={onCreatePatchReview}
              onDecidePatch={onDecidePatch}
              source={source}
              workspaceRoot={workspaceRoot}
            />
          ) : null}
          {turn.status === 'inProgress' ? (
            <span className="code-agent-transcript-progress">
              {[workingLabel, progressDuration].filter(Boolean).join(' ')}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

const StableAgentTranscriptTurnView = memo(AgentTranscriptTurnView)

export function AgentTranscriptPane({
  agentId,
  workspaceRoot,
  active,
  viewportLayoutKey = '',
  source = 'legacy-jsonl',
  refreshSignal = 0,
  runtimeState = '',
  expectHistory = false,
  onOpenWorkspaceFilePath,
  onAvailabilityChange,
  onReadLatest,
  groupProcessActions = true,
  copy,
}: AgentTranscriptPaneProps) {
  const [transcript, setTranscript] = useState<AgentTranscript | null>(null)
  const transcriptRef = useRef<AgentTranscript | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openProcessTurnIds, setOpenProcessTurnIds] = useState<Set<string>>(() => new Set())
  const [openLiveProcessTurnIds, setOpenLiveProcessTurnIds] = useState<Set<string>>(() => new Set())
  const [turnLimit, setTurnLimit] = useState(() => initialTranscriptTurnLimit(source))
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pendingPrependAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const followBottomRef = useRef(true)
  const previousViewportLayoutKeyRef = useRef(viewportLayoutKey)
  // A saved semantic anchor is for returning to an Agent, not for tracking
  // every live transcript mutation. Reapplying its fractional position while
  // a message grows would move a user who is reading away from the bottom.
  const pendingReadingAnchorRestoreRef = useRef(false)
  // A transcript refresh can arrive while a user is dragging the mobile
  // scroll surface. Never let the refresh/layout pass take the viewport away
  // from the finger (the old behavior made the list jump back to the same
  // saved/bottom position mid-drag).
  const userScrollGestureRef = useRef(false)
  const userScrollGestureTimerRef = useRef<number | null>(null)
  // Live ACP updates must not move the viewport while the user is selecting
  // text from an earlier message. Keep this separate from terminal selection:
  // it is scoped to this structured Chat scroll surface only.
  const textSelectionGestureRef = useRef(false)
  const textSelectionHadRangeRef = useRef(false)
  const openWorkspaceFilePathRef = useRef(onOpenWorkspaceFilePath)

  useLayoutEffect(() => {
    openWorkspaceFilePathRef.current = onOpenWorkspaceFilePath
  }, [onOpenWorkspaceFilePath])

  useLayoutEffect(() => {
    const layoutChanged = previousViewportLayoutKeyRef.current !== viewportLayoutKey
    previousViewportLayoutKeyRef.current = viewportLayoutKey
    if (!layoutChanged || !active || !followBottomRef.current) return
    const element = scrollRef.current
    if (!element || userScrollGestureRef.current) return
    if (textSelectionGestureRef.current || hasTextSelectionWithin(element)) return

    // Like VS Code's workbench layout, keep the logical scroll state stable in
    // the same layout commit that changes the input part. Letting the browser
    // resize first makes its synthetic scroll event look like a user scroll,
    // which drops follow-latest and causes long chats to jump on later updates.
    element.scrollTop = element.scrollHeight
    clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
    setShowJumpToBottom(false)
    onReadLatest?.()
  }, [active, agentId, onReadLatest, viewportLayoutKey])

  useEffect(() => {
    setTranscript(null)
    transcriptRef.current = null
    setError('')
    setLoading(true)
    setLoadingOlder(false)
    setTurnLimit(initialTranscriptTurnLimit(source))
    setOpenProcessTurnIds(new Set())
    setOpenLiveProcessTurnIds(new Set())
    setShowJumpToBottom(false)
    const hasReadingAnchor = Boolean(readReadingAnchor(readingAnchorAgentKey(agentId, 'chat')))
    followBottomRef.current = !hasReadingAnchor
    pendingReadingAnchorRestoreRef.current = hasReadingAnchor
    textSelectionGestureRef.current = false
    textSelectionHadRangeRef.current = false
    pendingPrependAnchorRef.current = null
  }, [agentId, source])

  useEffect(() => () => {
    if (userScrollGestureTimerRef.current !== null) {
      window.clearTimeout(userScrollGestureTimerRef.current)
      userScrollGestureTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!active) return undefined

    const updateSelectionState = () => {
      const element = scrollRef.current
      if (!element) return
      if (hasTextSelectionWithin(element)) {
        followBottomRef.current = false
        textSelectionHadRangeRef.current = true
        return
      }
      if (textSelectionGestureRef.current) return
      if (!textSelectionHadRangeRef.current) return
      textSelectionHadRangeRef.current = false
      setShowJumpToBottom(
        !isTranscriptNearBottom(element)
        && element.scrollHeight > element.clientHeight + TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD,
      )
    }
    const finishSelectionGesture = () => {
      window.requestAnimationFrame(() => {
        textSelectionGestureRef.current = false
        updateSelectionState()
      })
    }

    document.addEventListener('selectionchange', updateSelectionState)
    document.addEventListener('pointerup', finishSelectionGesture)
    document.addEventListener('pointercancel', finishSelectionGesture)
    return () => {
      document.removeEventListener('selectionchange', updateSelectionState)
      document.removeEventListener('pointerup', finishSelectionGesture)
      document.removeEventListener('pointercancel', finishSelectionGesture)
      textSelectionGestureRef.current = false
      textSelectionHadRangeRef.current = false
    }
  }, [active])

  useEffect(() => {
    if (!active) return undefined

    let stopped = false
    let timer: number | null = null
    let controller: AbortController | null = null

    const load = () => {
      controller?.abort()
      controller = new AbortController()
      const params = new URLSearchParams({ maxTurns: String(turnLimit) })
      const currentTranscript = transcriptRef.current
      if (
        source === 'acp'
        && currentTranscript?.sessionId
        && currentTranscript.turnLimit === turnLimit
        && Number.isFinite(currentTranscript.revision)
      ) {
        params.set('sinceRevision', String(currentTranscript.revision))
      }
      const endpoint = source === 'acp'
        ? 'acp-transcript'
        : source === 'json-cli'
            ? 'json-cli-transcript'
            : 'codex-transcript'
      fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/${endpoint}?${params.toString()}`), {
        signal: controller.signal,
      })
        .then(response => {
          if (!response.ok) throw new Error(copy.agentTranscriptUnavailable)
          return response.json()
        })
        .then(payload => {
          if (stopped) return
          const nextTranscript = source === 'acp' && payload.transcript
            ? projectAcpTranscript(payload.transcript, { maxTurns: turnLimit })
            : payload.transcript || null
          setTranscript(current => {
            const merged = source === 'acp'
              ? mergeAcpTranscript(current, nextTranscript)
              : preserveCompletedTranscriptTurns(current, nextTranscript)
            transcriptRef.current = merged
            return merged
          })
          setError('')
          setLoading(false)
          setLoadingOlder(false)
        })
        .catch(reason => {
          if (stopped || reason?.name === 'AbortError') return
          setError(reason?.message || copy.agentTranscriptUnavailable)
          setLoading(false)
          setLoadingOlder(false)
        })
    }

    load()
    // ACP entry updates already advance refreshSignal through the shared state
    // websocket. Re-fetching a complete, idle history every three seconds is
    // especially expensive for long sessions with many tool details.
    if (source !== 'acp') timer = window.setInterval(load, 3000)

    return () => {
      stopped = true
      controller?.abort()
      if (timer) window.clearInterval(timer)
    }
  }, [active, agentId, copy.agentTranscriptUnavailable, refreshSignal, source, turnLimit])

  const turns = useMemo(() => transcript?.turns || [], [transcript])
  const awaitingAcpHistory = source === 'acp'
    && !error
    && turns.length === 0
    && (runtimeState === 'connecting' || expectHistory)
  useEffect(() => {
    if (!active || !transcript?.available || turns.length === 0) return
    const element = scrollRef.current
    const nearBottom = element ? isTranscriptNearBottom(element) : followBottomRef.current
    if (element && (textSelectionGestureRef.current || hasTextSelectionWithin(element))) return
    if (nearBottom) onReadLatest?.()
  }, [active, onReadLatest, transcript?.available, transcript?.updatedAt, turns.length])

  useLayoutEffect(() => {
    if (loading || !transcript?.available || turns.length === 0) return
    const element = scrollRef.current
    if (!element) return
    if (userScrollGestureRef.current) return
    const hasTextSelection = hasTextSelectionWithin(element)
    if (textSelectionGestureRef.current || hasTextSelection) {
      if (hasTextSelection) {
        followBottomRef.current = false
        textSelectionHadRangeRef.current = true
      }
      return
    }
    const pendingAnchor = pendingPrependAnchorRef.current
    if (pendingAnchor) {
      pendingPrependAnchorRef.current = null
      window.requestAnimationFrame(() => {
        if (textSelectionGestureRef.current || hasTextSelectionWithin(element)) return
        const nextTop = element.scrollHeight - pendingAnchor.scrollHeight + pendingAnchor.scrollTop
        element.scrollTop = Math.max(0, nextTop)
        saveTranscriptReadingAnchor(agentId, element)
      })
      return
    }
    if (followBottomRef.current) {
      pendingReadingAnchorRestoreRef.current = false
      window.requestAnimationFrame(() => {
        if (textSelectionGestureRef.current || hasTextSelectionWithin(element)) return
        element.scrollTop = element.scrollHeight
        clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
        setShowJumpToBottom(false)
        if (active) onReadLatest?.()
      })
      return
    }
    if (!pendingReadingAnchorRestoreRef.current) return
    pendingReadingAnchorRestoreRef.current = false
    window.requestAnimationFrame(() => {
      if (textSelectionGestureRef.current || hasTextSelectionWithin(element)) return
      const restored = restoreTranscriptReadingAnchor(agentId, element)
      if (restored !== 'expired') return
      // The desired message is outside the bounded transcript window. Do not
      // fetch or guess at older history on a passive Agent switch: viewing a
      // stale anchor always converges to the current tail.
      followBottomRef.current = true
      element.scrollTop = element.scrollHeight
      setShowJumpToBottom(false)
      if (active) onReadLatest?.()
    })
  }, [active, agentId, loading, onReadLatest, transcript?.available, transcript?.updatedAt, turns.length])

  useEffect(() => () => {
    const element = scrollRef.current
    if (!element) return
    saveTranscriptReadingAnchor(agentId, element)
  }, [agentId])

  useEffect(() => {
    onAvailabilityChange?.({
      loading,
      hasContent: Boolean(transcript?.available && turns.length > 0),
      available: Boolean(transcript?.available),
    })
  }, [loading, onAvailabilityChange, transcript?.available, turns.length])

  const handleOpenFile = useCallback((filePath: string, target?: WorkspaceFileOpenTarget) => (
    openWorkspaceFilePathRef.current?.(agentId, filePath, {
      ...target,
      suppressSearchOnMiss: true,
    })
  ), [agentId])
  const handleLoadProcessItemDetail = useCallback(async (itemId: string) => {
    const response = await fetch(appPath(
      `/api/agents/${encodeURIComponent(agentId)}/acp-tool-details/${encodeURIComponent(itemId)}`,
    ))
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || copy.agentTranscriptUnavailable)
    return {
      detail: String(payload.detail || ''),
      terminals: Array.isArray(payload.terminals) ? payload.terminals as AgentTranscriptTerminal[] : undefined,
      subagentTranscript: payload.subagentSession && typeof payload.subagentSession === 'object'
        ? projectAcpTranscript(payload.subagentSession, { maxTurns: 12 })
        : undefined,
    }
  }, [agentId, copy.agentTranscriptUnavailable])
  const handleLoadPatchChanges = useCallback((itemIds: string[]) => (
    loadAcpReviewPreview(agentId, itemIds)
  ), [agentId])
  const handleCreatePatchReview = useCallback((itemIds: string[]) => {
    const params = new URLSearchParams({ agentId })
    itemIds.forEach(itemId => params.append('acpItem', itemId))
    return appPath(`/review?${params.toString()}`)
  }, [agentId])
  const handleDecidePatch = useCallback(async (itemId: string, path: string, decision: 'keep' | 'revert') => {
    const response = await fetch(appPath(
      `/api/agents/${encodeURIComponent(agentId)}/acp-patches/${encodeURIComponent(itemId)}/decision`,
    ), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, decision }),
    })
    const payload = await response.json().catch(() => ({})) as { action?: string; error?: string }
    if (!response.ok || !payload.action) throw new Error(payload.error || 'Failed to decide file change')
    return { action: payload.action }
  }, [agentId])
  const handleStopTerminal = useCallback(async (terminalId: string) => {
    const response = await fetch(appPath(
      `/api/agents/${encodeURIComponent(agentId)}/acp-terminals/${encodeURIComponent(terminalId)}/kill`,
    ), { method: 'POST' })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'Failed to stop command')
  }, [agentId])
  const handleInputTerminal = useCallback(async (terminalId: string, input: string) => {
    const response = await fetch(appPath(
      `/api/agents/${encodeURIComponent(agentId)}/acp-terminals/${encodeURIComponent(terminalId)}/input`,
    ), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'Failed to send terminal input')
  }, [agentId])
  const handleResizeTerminal = useCallback(async (terminalId: string, cols: number, rows: number) => {
    const response = await fetch(appPath(
      `/api/agents/${encodeURIComponent(agentId)}/acp-terminals/${encodeURIComponent(terminalId)}/resize`,
    ), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'Failed to resize terminal')
  }, [agentId])
  const handleStopSubagent = useCallback(async (sessionId: string) => {
    const response = await fetch(appPath(
      `/api/agents/${encodeURIComponent(agentId)}/acp-subagents/${encodeURIComponent(sessionId)}/cancel`,
    ), { method: 'POST' })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'Failed to stop subagent')
  }, [agentId])
  const requestOlderTurns = useCallback((element: HTMLDivElement) => {
    if (
      !transcript?.hasMoreBefore ||
      loadingOlder ||
      turnLimit >= MAX_TRANSCRIPT_TURN_LIMIT
    ) {
      return
    }
    pendingPrependAnchorRef.current = {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
    }
    setLoadingOlder(true)
    setTurnLimit(current => {
      const pageSize = source === 'acp'
        ? ACP_TRANSCRIPT_TURN_PAGE_SIZE
        : TRANSCRIPT_TURN_PAGE_SIZE
      const next = Math.min(MAX_TRANSCRIPT_TURN_LIMIT, current + pageSize)
      if (next === current) {
        setLoadingOlder(false)
      }
      return next
    })
  }, [loadingOlder, source, transcript?.hasMoreBefore, turnLimit])
  const markUserScrollGesture = useCallback(() => {
    userScrollGestureRef.current = true
    if (userScrollGestureTimerRef.current !== null) {
      window.clearTimeout(userScrollGestureTimerRef.current)
      userScrollGestureTimerRef.current = null
    }
  }, [])
  const finishUserScrollGesture = useCallback(() => {
    if (userScrollGestureTimerRef.current !== null) {
      window.clearTimeout(userScrollGestureTimerRef.current)
    }
    // Keep the lock through iOS momentum scrolling. A short grace period is
    // enough to absorb the trailing scroll events without disabling normal
    // follow-latest behavior after the gesture settles.
    userScrollGestureTimerRef.current = window.setTimeout(() => {
      userScrollGestureRef.current = false
      userScrollGestureTimerRef.current = null
    }, 420)
  }, [])
  const handleTouchStart = useCallback(() => {
    markUserScrollGesture()
  }, [markUserScrollGesture])
  const handleTouchMove = useCallback(() => {
    markUserScrollGesture()
  }, [markUserScrollGesture])
  const handleTouchEnd = useCallback(() => {
    finishUserScrollGesture()
  }, [finishUserScrollGesture])
  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    pendingReadingAnchorRestoreRef.current = false
    if (textSelectionGestureRef.current || hasTextSelectionWithin(element)) {
      followBottomRef.current = false
      textSelectionHadRangeRef.current = true
      saveTranscriptReadingAnchor(agentId, element)
      return
    }
    const nearBottom = isTranscriptNearBottom(element)
    followBottomRef.current = nearBottom
    saveTranscriptReadingAnchor(agentId, element)
    setShowJumpToBottom(!nearBottom && element.scrollHeight > element.clientHeight + TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD)
    if (active && nearBottom) onReadLatest?.()
    if (element.scrollTop <= TRANSCRIPT_LOAD_MORE_THRESHOLD) requestOlderTurns(element)
  }, [active, agentId, onReadLatest, requestOlderTurns])
  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    markUserScrollGesture()
    finishUserScrollGesture()
    if (event.deltaY >= 0) return
    const element = scrollRef.current
    if (!element || element.scrollTop > TRANSCRIPT_LOAD_MORE_THRESHOLD) return
    requestOlderTurns(element)
  }, [finishUserScrollGesture, markUserScrollGesture, requestOlderTurns])
  const handleTranscriptPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') return
    const target = event.target
    if (
      target instanceof Element
      && target.closest('button, a, input, textarea, select, summary, [role="button"]')
    ) {
      return
    }
    // Pointer down starts before Selection becomes non-collapsed. Lock now so
    // an ACP refresh cannot jump to the bottom during that first drag frame.
    textSelectionGestureRef.current = true
  }, [])
  const handleToggleProcess = useCallback((turnId: string) => {
    const turn = turns.find(candidate => candidate.id === turnId)
    if (source === 'acp' && turn?.status === 'inProgress') {
      setOpenLiveProcessTurnIds(current => {
        const next = new Set(current)
        if (next.has(turnId)) next.delete(turnId)
        else next.add(turnId)
        return next
      })
      return
    }
    setOpenProcessTurnIds(current => {
      const next = new Set(current)
      if (next.has(turnId)) next.delete(turnId)
      else next.add(turnId)
      return next
    })
  }, [source, turns])
  const handleJumpToBottom = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    followBottomRef.current = true
    textSelectionHadRangeRef.current = false
    // This control is an explicit catch-up action. A smooth animation can be
    // interrupted by a transcript refresh and leave the reader above the
    // newest turn, so move the viewport synchronously instead.
    element.scrollTop = element.scrollHeight
    clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
    setShowJumpToBottom(false)
    onReadLatest?.()
  }, [agentId, onReadLatest])

  return (
    <div className="code-agent-transcript" data-testid="code-agent-transcript">
      {loading || awaitingAcpHistory ? (
        <div className="code-agent-transcript-state subtle">{copy.agentTranscriptSyncing}</div>
      ) : error ? (
        <div className="code-agent-transcript-state" role="status">{error}</div>
      ) : !transcript?.available ? (
        <div className="code-agent-transcript-blank" role="status">{copy.agentTranscriptEmpty}</div>
      ) : turns.length === 0 ? (
        <div className="code-agent-transcript-blank" role="status">{copy.agentTranscriptEmpty}</div>
      ) : (
        <div
          className="code-agent-transcript-scroll"
          data-testid="code-agent-transcript-scroll"
          ref={scrollRef}
          onPointerDown={handleTranscriptPointerDown}
          onScroll={handleScroll}
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          {turns.map(turn => {
            const processOpen = source === 'acp' && turn.status === 'inProgress'
              ? openLiveProcessTurnIds.has(turn.id)
              : openProcessTurnIds.has(turn.id)
            return (
              <StableAgentTranscriptTurnView
                key={turn.id}
                turn={turn}
                copy={copy}
                onOpenFile={onOpenWorkspaceFilePath ? handleOpenFile : undefined}
                workspaceRoot={workspaceRoot}
                processOpen={processOpen}
                groupProcessActions={groupProcessActions}
                source={source}
                onToggleProcess={handleToggleProcess}
                onLoadProcessItemDetail={source === 'acp' ? handleLoadProcessItemDetail : undefined}
                onLoadPatchChanges={source === 'acp' ? handleLoadPatchChanges : undefined}
                onCreatePatchReview={source === 'acp' ? handleCreatePatchReview : undefined}
                onDecidePatch={source === 'acp' ? handleDecidePatch : undefined}
                onStopTerminal={source === 'acp' ? handleStopTerminal : undefined}
                onInputTerminal={source === 'acp' ? handleInputTerminal : undefined}
                onResizeTerminal={source === 'acp' ? handleResizeTerminal : undefined}
                onStopSubagent={source === 'acp' ? handleStopSubagent : undefined}
              />
            )
          })}
        </div>
      )}
      {showJumpToBottom ? (
        <button
          type="button"
          className="code-agent-transcript-jump-bottom"
          data-testid="code-agent-transcript-jump-bottom"
          aria-label="Jump to latest chat"
          onClick={handleJumpToBottom}
        >
          <ArrowDownGlyph />
        </button>
      ) : null}
    </div>
  )
}
