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
import { ArrowDownGlyph, CheckGlyph, ChevronRightGlyph, CopyGlyph } from '@/components/IconGlyphs'
import { MermaidBlock } from '@/components/files/FileEditorMarkdownPreview'
import { appPath } from '@/lib/base-path'
import { iconForFilePath } from '@/lib/file-icons'
import { normalizeGlobalWorkspaceFilePath } from '@/lib/global-workspace-files'
import { collectTerminalPathLinkMatches } from '@/lib/terminal-links'
import { isMobileTouchViewport } from '@/lib/responsive-mode'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import type { CodeCopy } from './copy'
import { acpActivityKind, acpCompactPlanLabel, acpPlanProgress, type AcpActivityKind } from './acp/acp-activity-label'
import { acpActionGroupLabel, isAcpProgressUpdate } from './acp/acp-progress-timeline'
import { terminalTargetFilePath } from './workspace-file-view'
import 'katex/dist/katex.min.css'

interface CodexTranscriptProcessItem {
  id: string
  type: string
  title: string
  detail?: string
  images?: CodexTranscriptUserImage[]
  files?: CodexTranscriptUserFile[]
  status?: string
  kind?: string
  completedSteps?: number
  totalSteps?: number
  currentStep?: string
  detailTruncated?: boolean
}

interface CodexTranscriptUserImage {
  id: string
  url: string
  alt?: string
}

interface CodexTranscriptUserFile {
  id: string
  name: string
  content?: string
  error?: string
  truncated?: boolean
}

interface CodexTranscriptTurn {
  id: string
  userMessage: string
  userImages?: CodexTranscriptUserImage[]
  userFiles?: CodexTranscriptUserFile[]
  finalMessage: string
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  status: 'inProgress' | 'completed' | 'interrupted' | string
  processItems: CodexTranscriptProcessItem[]
}

interface CodexTranscript {
  available: boolean
  reason?: string
  sessionId: string
  updatedAt?: string
  source?: string
  hasMoreBefore?: boolean
  turnLimit?: number
  revision?: number
  delta?: boolean
  replaceFromTurnId?: string
  stopReason?: string
  turns: CodexTranscriptTurn[]
}

function completedTranscriptTurnUnchanged(
  current: CodexTranscriptTurn,
  next: CodexTranscriptTurn,
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
    && current.userFiles?.length === next.userFiles?.length
    && current.processItems.length === next.processItems.length
    && currentLastItem?.id === nextLastItem?.id
    && currentLastItem?.status === nextLastItem?.status
    && currentLastItem?.title === nextLastItem?.title
    && currentLastItem?.detail === nextLastItem?.detail
  }

function preserveCompletedTranscriptTurns(
  current: CodexTranscript | null,
  next: CodexTranscript | null,
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
  current: CodexTranscript | null,
  next: CodexTranscript | null,
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

export interface CodexTranscriptPaneProps {
  agentId: string
  workspaceRoot?: string
  active: boolean
  source?: 'acp' | 'app-server' | 'json-cli' | 'legacy-jsonl'
  refreshSignal?: number
  onOpenWorkspaceFilePath?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onAvailabilityChange?: (state: { loading: boolean; hasContent: boolean; available: boolean }) => void
  onReadLatest?: () => void
  groupProcessActions?: boolean
  copy: CodeCopy
}

const transcriptScrollPositions = new Map<string, number>()
const INITIAL_TRANSCRIPT_TURN_LIMIT = 80
const TRANSCRIPT_TURN_PAGE_SIZE = 80
const INITIAL_ACP_TRANSCRIPT_TURN_LIMIT = 20
const ACP_TRANSCRIPT_TURN_PAGE_SIZE = 20
const MAX_TRANSCRIPT_TURN_LIMIT = 1000

function initialTranscriptTurnLimit(source: CodexTranscriptPaneProps['source']) {
  return source === 'acp'
    ? INITIAL_ACP_TRANSCRIPT_TURN_LIMIT
    : INITIAL_TRANSCRIPT_TURN_LIMIT
}
const TRANSCRIPT_LOAD_MORE_THRESHOLD = 72
const TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD = 96

function durationLabel(durationMs: number | null | undefined) {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return ''
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

function acpActivityLabel(turn: CodexTranscriptTurn, copy: CodeCopy) {
  const labels: Record<AcpActivityKind, string> = {
    thinking: copy.codexTranscriptThinking,
    running: copy.codexTranscriptRunning,
    reading: copy.codexTranscriptReading,
    searching: copy.codexTranscriptSearching,
    editing: copy.codexTranscriptEditing,
    plan: copy.codexTranscriptPlanActive,
    fetching: copy.codexTranscriptFetching,
    tool: copy.codexTranscriptUsingTool,
    processing: copy.codexTranscriptWorking,
  }
  return labels[acpActivityKind(turn.processItems)]
}

function acpPlanLabel(turn: CodexTranscriptTurn, copy: CodeCopy) {
  const progress = acpPlanProgress(turn.processItems)
  if (!progress) return ''
  const currentStepLabel = acpCompactPlanLabel(turn.processItems)
  if (currentStepLabel) return currentStepLabel
  return progress.total <= 99
    ? copy.codexTranscriptPlanProgress(progress.completed, progress.total)
    : copy.codexTranscriptPlanActive
}

function turnProcessLabel(
  turn: CodexTranscriptTurn,
  copy: CodeCopy,
  workingLabel = copy.codexTranscriptWorking,
  planLabel = '',
) {
  const duration = durationLabel(turn.durationMs)
  return duration
    ? copy.codexTranscriptWorkedFor(duration)
    : turn.status === 'inProgress'
      ? planLabel || workingLabel
      : copy.codexTranscriptProcess
}

function turnProcessTitle(turn: CodexTranscriptTurn, copy: CodeCopy) {
  if (turn.processItems.length <= 0) return undefined
  return copy.codexTranscriptProcessCount(turn.processItems.length)
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

function codexTranscriptUrlTransform(value: string, key: string) {
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

function CodexTranscriptUserImages({ images }: { images: CodexTranscriptUserImage[] }) {
  if (images.length <= 0) return null
  return (
    <div className="code-codex-transcript-user-images" data-testid="code-codex-transcript-user-images">
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

function userFileMeta(file: CodexTranscriptUserFile) {
  if (file.error) return file.error
  const content = file.content || ''
  const lineCount = content ? content.split('\n').length : 0
  const charCount = content.length
  const lineLabel = lineCount === 1 ? '1 line' : `${lineCount} lines`
  const charLabel = charCount === 1 ? '1 char' : `${charCount} chars`
  return `${lineLabel} · ${charLabel}${file.truncated ? ' · truncated' : ''}`
}

function CodexTranscriptUserFiles({ files }: { files: CodexTranscriptUserFile[] }) {
  if (files.length <= 0) return null
  return (
    <div className="code-codex-transcript-user-files" data-testid="code-codex-transcript-user-files">
      {files.map(file => {
        const content = file.content || ''
        const hasContent = Boolean(content)
        return (
          <details key={file.id} className={`code-codex-transcript-user-file ${file.error ? 'error' : ''}`}>
            <summary>
              <TranscriptFileIcon filePath={file.name} />
              <span className="code-codex-transcript-user-file-name" title={file.name}>{file.name}</span>
              <span className="code-codex-transcript-user-file-meta">{userFileMeta(file)}</span>
            </summary>
            {file.error ? (
              <div className="code-codex-transcript-user-file-error">{file.error}</div>
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
      className="code-codex-transcript-file-icon"
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
      <span className="code-codex-transcript-file-label">{label}</span>
    </span>
  )
}

function CodexTranscriptProcessImages({ images }: { images: CodexTranscriptUserImage[] }) {
  if (images.length <= 0) return null
  return (
    <div className="code-codex-transcript-process-images" data-testid="code-codex-transcript-process-images">
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

function processItemClassName(item: CodexTranscriptProcessItem) {
  const type = item.type.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'event'
  const status = (item.status || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase()
  return ['code-codex-transcript-process-item', type, status ? `status-${status}` : '']
    .filter(Boolean)
    .join(' ')
}

function shouldShowStatus(status?: string) {
  const normalized = String(status || '').trim().toLowerCase()
  return !!normalized && normalized !== 'completed' && normalized !== 'success'
}

function isProcessItemRunning(item: CodexTranscriptProcessItem) {
  const normalized = String(item.status || '').trim().replace(/[_-]/g, '').toLowerCase()
  return [
    'running',
    'inprogress',
    'pending',
    'started',
    'active',
  ].includes(normalized)
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

function shouldRenderDetailAsProse(item: CodexTranscriptProcessItem) {
  return [
    'message',
    'agent-message',
    'progress',
    'reasoning',
    'hook',
    'warning',
    'error',
    'review',
    'rollback',
    'compaction',
    'subagent',
  ].includes(item.type)
}

function isNarrativeProcessItem(item: CodexTranscriptProcessItem) {
  return shouldRenderDetailAsProse(item) || item.type === 'plan' || item.type === 'user-steer'
}

function isCommandLikeProcessItem(item: CodexTranscriptProcessItem) {
  return !isNarrativeProcessItem(item)
}

type ProcessEntry =
  | { kind: 'item'; item: CodexTranscriptProcessItem }
  | { kind: 'group'; id: string; items: CodexTranscriptProcessItem[] }

function processEntriesForTurn(items: CodexTranscriptProcessItem[]) {
  const entries: ProcessEntry[] = []
  let group: CodexTranscriptProcessItem[] = []
  const flushGroup = () => {
    if (group.length > 0) entries.push({ kind: 'group', id: group.map(item => item.id).join(':'), items: group })
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

function processGroupLabel(items: CodexTranscriptProcessItem[]) {
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

function hasExpandableProcessItemContent(item: CodexTranscriptProcessItem, detail: string, planItems: ReturnType<typeof planDetailItems>) {
  return Boolean(detail || planItems || (item.images || []).length > 0 || (item.files || []).length > 0)
}

function isPatchResultItem(item: CodexTranscriptProcessItem) {
  return item.type === 'patch'
}

function isUserSteerProcessItem(item: CodexTranscriptProcessItem) {
  return item.type === 'user-steer'
}

function patchResultLines(item: CodexTranscriptProcessItem) {
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
  if (normalizedPath === normalizedRoot) return ''
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath.slice(normalizedRoot.length + 1)
  return normalizedPath
}

function patchRowDisplayPath(row: PatchResultRow, workspaceRoot?: string) {
  return workspaceRelativeTranscriptPath(row.path, workspaceRoot) || row.path
}

function hasPatchStats(row: PatchResultRow) {
  return !!(row.added || row.removed)
}

function patchStatNumber(value: string) {
  const parsed = Number(String(value || '').replace(/[+-]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function patchStatTotal(row: PatchResultRow) {
  return patchStatNumber(row.added) + patchStatNumber(row.removed)
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
    if (
      (!hasPatchStats(existing) && hasPatchStats(row))
      || patchStatTotal(row) > patchStatTotal(existing)
    ) {
      deduped[existingIndex] = { ...row, path: displayPath || row.path }
    }
  }
  return deduped
}

function patchRowsForItems(items: CodexTranscriptProcessItem[], workspaceRoot?: string) {
  return mergePatchRows(
    items.flatMap(item => patchResultLines(item).map(parsePatchResultLine)),
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
  const scroller = anchor.closest('.code-codex-transcript-scroll') as HTMLElement | null
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

function CodexTranscriptSteerItem({ item }: { item: CodexTranscriptProcessItem }) {
  const text = (item.detail || item.title || '').trim()
  const images = item.images || []
  const files = item.files || []
  if (!text && images.length <= 0 && files.length <= 0) return null
  return (
    <div className="code-codex-transcript-steer" data-testid="code-codex-transcript-steer">
      <div className="code-codex-transcript-user code-codex-transcript-steer-bubble">
        {text ? <div>{plainTextBlock(text)}</div> : null}
        <CodexTranscriptUserImages images={images} />
        <CodexTranscriptUserFiles files={files} />
      </div>
    </div>
  )
}

function CodexTranscriptProcessItemView({
  item,
  copy,
  copied,
  detailOpen,
  onToggle,
  onCopy,
}: {
  item: CodexTranscriptProcessItem
  copy: CodeCopy
  copied: boolean
  detailOpen: boolean
  onToggle: (itemId: string) => void
  onCopy: (item: CodexTranscriptProcessItem) => void
}) {
  if (isUserSteerProcessItem(item)) {
    return <CodexTranscriptSteerItem item={item} />
  }

  const detail = item.detail && item.detail.trim() !== item.title.trim() ? item.detail : ''
  const hasDetail = !!detail
  const images = item.images || []
  const planItems = item.type === 'plan' && detail ? planDetailItems(detail) : null
  const expandable = hasExpandableProcessItemContent(item, detail, planItems)
  const details = (
    <>
      {planItems ? (
        <ul className="code-codex-transcript-plan-list">
          {planItems.map((entry, index) => (
            <li key={`${index}-${entry.text}`} className={entry.status}>
              <span className="code-codex-transcript-plan-marker" aria-hidden="true" />
              <span>{entry.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <CodexTranscriptProcessImages images={images} />
      {!planItems && hasDetail && shouldRenderDetailAsProse(item) ? (
        <div className="code-codex-transcript-process-detail">{plainTextBlock(detail)}</div>
      ) : !planItems && hasDetail ? <pre>{detail}</pre> : null}
    </>
  )
  return (
    <section
      className={processItemClassName(item)}
      data-testid="code-codex-transcript-process-item"
      data-type={item.type}
      data-status={item.status || ''}
    >
      <div className="code-codex-transcript-process-title">
        <span className="code-codex-transcript-process-dot" aria-hidden="true" />
        {expandable ? (
          <button
            type="button"
            className="code-codex-transcript-process-title-toggle"
            data-testid="code-codex-transcript-process-item-toggle"
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
            <span className="code-codex-transcript-process-title-text">{item.title}</span>
            {shouldShowStatus(item.status) ? (
              <span className="code-codex-transcript-process-status">{item.status}</span>
            ) : null}
            <ChevronRightGlyph className="code-codex-transcript-process-item-chevron" />
          </button>
        ) : (
          <span className="code-codex-transcript-process-title-static">
            <span className="code-codex-transcript-process-title-text">{item.title}</span>
            {shouldShowStatus(item.status) ? (
              <span className="code-codex-transcript-process-status">{item.status}</span>
            ) : null}
          </span>
        )}
        {hasDetail ? (
          <button
            type="button"
            className={`code-codex-transcript-copy ${copied ? 'copied' : ''}`}
            aria-label={copied ? copy.codexTranscriptCopiedDetails : copy.codexTranscriptCopyDetails}
            title={copied ? copy.codexTranscriptCopiedDetails : copy.codexTranscriptCopyDetails}
            data-tooltip={copied ? copy.codexTranscriptCopiedDetails : copy.codexTranscriptCopyDetails}
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

function CodexTranscriptProcessGroupView({
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
}: {
  groupId: string
  items: CodexTranscriptProcessItem[]
  summaryLabel?: string
  copy: CodeCopy
  copiedItemId: string
  detailOpen: boolean
  openProcessItemIds: Set<string>
  onToggleGroup: (groupId: string) => void
  onToggleItem: (itemId: string) => void
  onCopy: (item: CodexTranscriptProcessItem) => void
}) {
  const running = items.some(isProcessItemRunning)
  return (
    <section
      className={`code-codex-transcript-process-group ${running ? 'running' : ''}`}
      data-testid="code-codex-transcript-process-group"
      data-count={items.length}
    >
      <button
        type="button"
        className="code-codex-transcript-process-group-summary"
        data-testid="code-codex-transcript-process-group-toggle"
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
        <span className="code-codex-transcript-process-dot" aria-hidden="true" />
        <span className="code-codex-transcript-process-title-text">{summaryLabel || processGroupLabel(items)}</span>
        <ChevronRightGlyph className="code-codex-transcript-process-item-chevron" />
      </button>
      {detailOpen ? (
        <div className="code-codex-transcript-process-group-list">
          {items.map(item => (
            <CodexTranscriptProcessItemView
              key={item.id}
              item={item}
              copy={copy}
              copied={copiedItemId === item.id}
              detailOpen={openProcessItemIds.has(item.id)}
              onToggle={onToggleItem}
              onCopy={onCopy}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function CodexTranscriptPatchResultCard({
  items,
  copy,
  workspaceRoot,
}: {
  items: CodexTranscriptProcessItem[]
  copy: CodeCopy
  workspaceRoot?: string
}) {
  const rows = patchRowsForItems(items, workspaceRoot)
  const failed = items.some(item => item.status === 'failed')
  const totalAdded = rows.reduce((sum, row) => sum + Number(row.added.replace('+', '') || 0), 0)
  const totalRemoved = rows.reduce((sum, row) => sum + Number(row.removed.replace('-', '') || 0), 0)
  const summary = patchResultSummary(rows.length, failed)
  const handleReview = useCallback(() => {
    if (!workspaceRoot) return
    const params = new URLSearchParams({ root: workspaceRoot })
    window.open(appPath(`/review?${params.toString()}`), '_blank', 'noopener,noreferrer')
  }, [workspaceRoot])
  const summaryContent = (
    <>
      <span>{summary}</span>
      {totalAdded ? <span className="added">+{totalAdded}</span> : null}
      {totalRemoved ? <span className="removed">-{totalRemoved}</span> : null}
    </>
  )
  return (
    <section
      className={`code-codex-transcript-result-card ${failed ? 'failed' : ''}`}
      data-testid="code-codex-transcript-result-card"
    >
      {workspaceRoot && rows.length > 0 ? (
        <button
          type="button"
          className="code-codex-transcript-result-summary"
          data-testid="code-codex-transcript-result-summary"
          aria-label={`${summary}. ${copy.codexTranscriptReviewChanges}`}
          onClick={handleReview}
        >
          {summaryContent}
        </button>
      ) : (
        <div className="code-codex-transcript-result-summary" aria-label={summary}>
          {summaryContent}
        </div>
      )}
    </section>
  )
}

function CodexTranscriptTurnView({
  turn,
  copy,
  onOpenFile,
  workspaceRoot,
  processOpen,
  groupProcessActions,
  source,
  onToggleProcess,
  onLoadProcessItemDetail,
}: {
  turn: CodexTranscriptTurn
  copy: CodeCopy
  onOpenFile?: (filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  workspaceRoot?: string
  processOpen: boolean
  groupProcessActions: boolean
  source: CodexTranscriptPaneProps['source']
  onToggleProcess: (turnId: string) => void
  onLoadProcessItemDetail?: (itemId: string) => Promise<string>
}) {
  const [loadedProcessDetails, setLoadedProcessDetails] = useState<Record<string, string>>({})
  const loadingProcessDetailsRef = useRef<Set<string>>(new Set())
  const resolvedProcessItems = useMemo(() => turn.processItems.map(item => (
    Object.prototype.hasOwnProperty.call(loadedProcessDetails, item.id)
      ? { ...item, detail: loadedProcessDetails[item.id], detailTruncated: false }
      : item
  )), [loadedProcessDetails, turn.processItems])
  const hasProcess = resolvedProcessItems.length > 0
  const patchResults = resolvedProcessItems.filter(isPatchResultItem)
  const userImages = turn.userImages || []
  const userFiles = turn.userFiles || []
  const [copiedItemId, setCopiedItemId] = useState('')
  const [answerCopied, setAnswerCopied] = useState(false)
  const [openProcessItemIds, setOpenProcessItemIds] = useState<Set<string>>(() => new Set())
  const [, setProgressClock] = useState(0)
  const processEntries = useMemo(() => (
    groupProcessActions
      ? processEntriesForTurn(resolvedProcessItems)
      : resolvedProcessItems.map(item => ({ kind: 'item' as const, item }))
  ), [groupProcessActions, resolvedProcessItems])
  const mobileTouch = isMobileTouchViewport()
  const answerMessage = useMemo(() => stripRawMemoryCitation(turn.finalMessage), [turn.finalMessage])
  const shouldShowWaiting = turn.status === 'inProgress' && !answerMessage && (
    Boolean(turn.userMessage) || userImages.length > 0 || userFiles.length > 0 || hasProcess
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
  const workingLabel = source === 'acp' ? acpActivityLabel(activityTurn, copy) : copy.codexTranscriptWorking
  const planLabel = source === 'acp' ? acpPlanLabel(activityTurn, copy) : ''
  const loadFullProcessDetail = useCallback(async (item: CodexTranscriptProcessItem) => {
    if (!item.detailTruncated || !onLoadProcessItemDetail) return item.detail || ''
    if (Object.prototype.hasOwnProperty.call(loadedProcessDetails, item.id)) {
      return loadedProcessDetails[item.id]
    }
    if (loadingProcessDetailsRef.current.has(item.id)) return item.detail || ''
    loadingProcessDetailsRef.current.add(item.id)
    try {
      const detail = await onLoadProcessItemDetail(item.id)
      setLoadedProcessDetails(current => ({ ...current, [item.id]: detail }))
      return detail
    } finally {
      loadingProcessDetailsRef.current.delete(item.id)
    }
  }, [loadedProcessDetails, onLoadProcessItemDetail])
  const handleCopyItem = useCallback((item: CodexTranscriptProcessItem) => {
    void loadFullProcessDetail(item).then(detail => {
      const text = [item.title, detail].filter(Boolean).join('\n\n')
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
    const opening = !openProcessItemIds.has(itemId)
    if (opening) {
      const item = resolvedProcessItems.find(candidate => candidate.id === itemId)
      if (item?.detailTruncated) void loadFullProcessDetail(item).catch(() => {})
    }
    setOpenProcessItemIds(current => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }, [loadFullProcessDetail, openProcessItemIds, resolvedProcessItems])
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
          className={[props.className, target ? 'code-codex-transcript-markdown-file-link' : ''].filter(Boolean).join(' ') || undefined}
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
          className="code-codex-transcript-markdown-file-link"
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
    <article className={`code-codex-transcript-turn ${turn.status === 'inProgress' ? 'running' : ''}`}>
      {turn.userMessage || userImages.length > 0 || userFiles.length > 0 ? (
        <div className="code-codex-transcript-user">
          {turn.userMessage ? <div>{plainTextBlock(turn.userMessage)}</div> : null}
          <CodexTranscriptUserImages images={userImages} />
          <CodexTranscriptUserFiles files={userFiles} />
        </div>
      ) : null}

      {hasProcess ? (
        <div className={`code-codex-transcript-process ${effectiveProcessOpen ? 'expanded' : ''}`}>
          <button
            type="button"
            className="code-codex-transcript-process-summary"
            data-testid="code-codex-transcript-process-summary"
            aria-expanded={effectiveProcessOpen}
            title={turnProcessTitle(turn, copy)}
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
            <span>{turnProcessLabel(turn, copy, workingLabel, planLabel)}</span>
            <ChevronRightGlyph className="code-codex-transcript-chevron" />
          </button>
          {effectiveProcessOpen ? (
            <div className="code-codex-transcript-process-list">
              {processEntries.map(entry => {
                if (entry.kind === 'group') {
                  const groupOpen = openProcessItemIds.has(entry.id) || (
                    source !== 'acp'
                    && !mobileTouch
                    && entry.items.some(isProcessItemRunning)
                  )
                  return (
                    <CodexTranscriptProcessGroupView
                      key={entry.id}
                      groupId={entry.id}
                      items={entry.items}
                      summaryLabel={source === 'acp' ? acpActionGroupLabel(entry.items) : undefined}
                      copy={copy}
                      copiedItemId={copiedItemId}
                      detailOpen={groupOpen}
                      openProcessItemIds={openProcessItemIds}
                      onToggleGroup={handleToggleProcessItem}
                      onToggleItem={handleToggleProcessItem}
                      onCopy={handleCopyItem}
                    />
                  )
                }
                if (source === 'acp' && isAcpProgressUpdate(entry.item)) {
                  const progressText = String(entry.item.detail || '').trim()
                  if (!progressText) return null
                  return (
                    <div
                      key={entry.item.id}
                      className="code-acp-progress-update code-markdown-preview"
                      data-testid="code-acp-progress-update"
                    >
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex, rehypeHighlight]}
                        components={markdownComponents}
                        skipHtml
                        urlTransform={codexTranscriptUrlTransform}
                      >
                        {progressText}
                      </ReactMarkdown>
                    </div>
                  )
                }
                return (
                  <CodexTranscriptProcessItemView
                    key={entry.item.id}
                    item={entry.item}
                    copy={copy}
                    copied={copiedItemId === entry.item.id}
                    detailOpen={openProcessItemIds.has(entry.item.id)}
                    onToggle={handleToggleProcessItem}
                    onCopy={handleCopyItem}
                  />
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {answerMessage ? (
        <div className="code-codex-transcript-answer">
          <div className="code-codex-transcript-assistant code-markdown-preview">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex, rehypeHighlight]}
              components={markdownComponents}
              skipHtml
              urlTransform={codexTranscriptUrlTransform}
            >
              {answerMessage}
            </ReactMarkdown>
          </div>
          <div className="code-codex-transcript-answer-actions">
            <button
              type="button"
              className={`code-codex-transcript-answer-action ${answerCopied ? 'copied' : ''}`}
              data-testid="code-codex-transcript-copy-answer"
              aria-label={answerCopied ? copy.codexTranscriptCopiedAnswer : copy.codexTranscriptCopyAnswer}
              title={answerCopied ? copy.codexTranscriptCopiedAnswer : copy.codexTranscriptCopyAnswer}
              data-tooltip={answerCopied ? copy.codexTranscriptCopiedAnswer : copy.codexTranscriptCopyAnswer}
              onClick={handleCopyAnswer}
            >
              {answerCopied ? <CheckGlyph /> : <CopyGlyph />}
            </button>
          </div>
        </div>
      ) : shouldShowWaiting ? (
        <div className="code-codex-transcript-placeholder">{copy.codexTranscriptWaiting}</div>
      ) : null}

      {patchResults.length > 0 || turn.status === 'inProgress' ? (
        <div className="code-codex-transcript-results code-codex-transcript-status-row">
          {patchResults.length > 0 ? (
            <CodexTranscriptPatchResultCard
              items={patchResults}
              copy={copy}
              workspaceRoot={workspaceRoot}
            />
          ) : null}
          {turn.status === 'inProgress' ? (
            <span className="code-codex-transcript-progress">
              {[workingLabel, progressDuration].filter(Boolean).join(' ')}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

const StableCodexTranscriptTurnView = memo(CodexTranscriptTurnView)

export function CodexTranscriptPane({
  agentId,
  workspaceRoot,
  active,
  source = 'legacy-jsonl',
  refreshSignal = 0,
  onOpenWorkspaceFilePath,
  onAvailabilityChange,
  onReadLatest,
  groupProcessActions = true,
  copy,
}: CodexTranscriptPaneProps) {
  const [transcript, setTranscript] = useState<CodexTranscript | null>(null)
  const transcriptRef = useRef<CodexTranscript | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openProcessTurnIds, setOpenProcessTurnIds] = useState<Set<string>>(() => new Set())
  const [closedLiveProcessTurnIds, setClosedLiveProcessTurnIds] = useState<Set<string>>(() => new Set())
  const [turnLimit, setTurnLimit] = useState(() => initialTranscriptTurnLimit(source))
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pendingPrependAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const followBottomRef = useRef(true)
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

  useEffect(() => {
    setTranscript(null)
    transcriptRef.current = null
    setError('')
    setLoading(true)
    setLoadingOlder(false)
    setTurnLimit(initialTranscriptTurnLimit(source))
    setOpenProcessTurnIds(new Set())
    setClosedLiveProcessTurnIds(new Set())
    setShowJumpToBottom(false)
    followBottomRef.current = true
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
        : source === 'app-server'
          ? 'codex-app-server-transcript'
          : source === 'json-cli'
            ? 'json-cli-transcript'
            : 'codex-transcript'
      fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/${endpoint}?${params.toString()}`), {
        signal: controller.signal,
      })
        .then(response => {
          if (!response.ok) throw new Error(copy.codexTranscriptUnavailable)
          return response.json()
        })
        .then(payload => {
          if (stopped) return
          const nextTranscript = payload.transcript || null
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
          setError(reason?.message || copy.codexTranscriptUnavailable)
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
  }, [active, agentId, copy.codexTranscriptUnavailable, refreshSignal, source, turnLimit])

  const turns = useMemo(() => transcript?.turns || [], [transcript])

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
        transcriptScrollPositions.set(agentId, element.scrollTop)
      })
      return
    }
    if (followBottomRef.current) {
      window.requestAnimationFrame(() => {
        if (textSelectionGestureRef.current || hasTextSelectionWithin(element)) return
        element.scrollTop = element.scrollHeight
        transcriptScrollPositions.set(agentId, element.scrollTop)
        setShowJumpToBottom(false)
        if (active) onReadLatest?.()
      })
      return
    }
    const saved = transcriptScrollPositions.get(agentId)
    if (!saved || saved <= 0) return
    window.requestAnimationFrame(() => {
      if (textSelectionGestureRef.current || hasTextSelectionWithin(element)) return
      element.scrollTop = Math.min(saved, Math.max(0, element.scrollHeight - element.clientHeight))
    })
  }, [active, agentId, loading, onReadLatest, transcript?.available, transcript?.updatedAt, turns.length])

  useEffect(() => () => {
    const element = scrollRef.current
    if (!element) return
    transcriptScrollPositions.set(agentId, element.scrollTop)
  }, [agentId])

  useEffect(() => {
    onAvailabilityChange?.({
      loading,
      hasContent: Boolean(transcript?.available && turns.length > 0),
      available: Boolean(transcript?.available),
    })
  }, [loading, onAvailabilityChange, transcript?.available, turns.length])

  const handleOpenFile = useCallback((filePath: string, target?: WorkspaceFileOpenTarget) => (
    onOpenWorkspaceFilePath?.(agentId, filePath, {
      ...target,
      suppressSearchOnMiss: true,
    })
  ), [agentId, onOpenWorkspaceFilePath])
  const handleLoadProcessItemDetail = useCallback(async (itemId: string) => {
    const response = await fetch(appPath(
      `/api/agents/${encodeURIComponent(agentId)}/acp-tool-details/${encodeURIComponent(itemId)}`,
    ))
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || copy.codexTranscriptUnavailable)
    return String(payload.detail || '')
  }, [agentId, copy.codexTranscriptUnavailable])
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
    transcriptScrollPositions.set(agentId, element.scrollTop)
    if (textSelectionGestureRef.current || hasTextSelectionWithin(element)) {
      followBottomRef.current = false
      textSelectionHadRangeRef.current = true
      return
    }
    const nearBottom = isTranscriptNearBottom(element)
    followBottomRef.current = nearBottom
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
      setClosedLiveProcessTurnIds(current => {
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
    transcriptScrollPositions.set(agentId, element.scrollHeight)
    setShowJumpToBottom(false)
    onReadLatest?.()
  }, [agentId, onReadLatest])

  return (
    <div className="code-codex-transcript" data-testid="code-codex-transcript">
      {loading ? (
        <div className="code-codex-transcript-state subtle">{copy.codexTranscriptSyncing}</div>
      ) : error ? (
        <div className="code-codex-transcript-state" role="status">{error}</div>
      ) : !transcript?.available ? (
        <div className="code-codex-transcript-blank" />
      ) : turns.length === 0 ? (
        <div className="code-codex-transcript-blank" />
      ) : (
        <div
          className="code-codex-transcript-scroll"
          data-testid="code-codex-transcript-scroll"
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
            const liveAcpProcessOpen = source === 'acp'
              && turn.status === 'inProgress'
              && !closedLiveProcessTurnIds.has(turn.id)
            return (
              <StableCodexTranscriptTurnView
                key={turn.id}
                turn={turn}
                copy={copy}
                onOpenFile={onOpenWorkspaceFilePath ? handleOpenFile : undefined}
                workspaceRoot={workspaceRoot}
                processOpen={openProcessTurnIds.has(turn.id) || liveAcpProcessOpen}
                groupProcessActions={groupProcessActions}
                source={source}
                onToggleProcess={handleToggleProcess}
                onLoadProcessItemDetail={source === 'acp' ? handleLoadProcessItemDetail : undefined}
              />
            )
          })}
        </div>
      )}
      {showJumpToBottom ? (
        <button
          type="button"
          className="code-codex-transcript-jump-bottom"
          data-testid="code-codex-transcript-jump-bottom"
          aria-label="Jump to latest chat"
          onClick={handleJumpToBottom}
        >
          <ArrowDownGlyph />
        </button>
      ) : null}
    </div>
  )
}
