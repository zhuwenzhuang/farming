import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import {
  AgentBotGlyph,
  AgentChipGlyph,
  AgentDroneGlyph,
  AgentGroupGlyph,
  AgentManufacturingGlyph,
  AgentSmartToyGlyph,
  AgentSpeechBotGlyph,
  ArrowDownGlyph,
  BookGlyph,
  CheckGlyph,
  ChecklistGlyph,
  ChevronRightGlyph,
  CloseGlyph,
  CloudDownloadGlyph,
  CopyGlyph,
  DifferenceGlyph,
  ForkGlyph,
  LoadingGlyph,
  PencilGlyph,
  SearchGlyph,
  TerminalSquareGlyph,
  ThinkingGlyph,
  ToolsGlyph,
} from '@/components/IconGlyphs'
import { LocalErrorBoundary, LocalRenderFault } from '@/components/LocalErrorBoundary'
import { MermaidBlock } from '@/components/files/FileEditorMarkdownPreview'
import { buildWorkspaceInlineVisualizationDocument } from '@/lib/workspace-html-preview'
import {
  createWorkspaceHtmlPreview,
  deleteWorkspaceHtmlPreview,
  fetchWorkspaceFile,
  workspaceHtmlPreviewUrl,
} from '@/lib/workspace-files'
import { appPath } from '@/lib/base-path'
import { showUrlOpenMenu } from '@/lib/url-open-menu'
import { writeClipboardText } from '@/lib/clipboard'
import { iconForFilePath } from '@/lib/file-icons'
import { GLOBAL_WORKSPACE_FILES_AGENT_ID, normalizeGlobalWorkspaceFilePath } from '@/lib/global-workspace-files'
import { markdownTextContent, mermaidCodeBlockSource } from '@/lib/react-markdown-content'
import {
  clearReadingAnchor,
  readingAnchorAgentKey,
  readReadingAnchor,
  saveReadingAnchor,
} from '@/lib/reading-anchor'
import { collectTerminalPathLinkMatches } from '@/lib/terminal-links'
import { isCompactViewport } from '@/lib/responsive-mode'
import { useSharedNow } from '@/lib/shared-now'
import { isPageActive } from '@/hooks/usePageVisibility'
import { loadAcpReviewPreview, loadReviewComparisonSources } from '@/lib/review/api'
import type { WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import type { CodeCopy } from './copy'
import { acpActivityKind, acpCompactPlanLabel, acpLiveToolActivity, acpPlanProgress, acpThoughtActivityLabel, type AcpActivityKind } from './acp/acp-activity-label'
import {
  acpCollaborationAgentsForTurn,
  type AcpCollaborationAction,
  type AcpCollaborationAgent,
  type AcpCollaborationStatus,
} from './acp/acp-collaboration'
import { AcpEmbeddedTerminal } from './acp/AcpEmbeddedTerminal'
import {
  projectAcpTranscript,
  type AgentTranscript,
  type AgentTranscriptAudio,
  type AgentTranscriptLocation,
  type AgentTranscriptPatchChange,
  type AgentTranscriptProcessItem,
  type AgentTranscriptSubagentState,
  type AgentTranscriptTerminal,
  type AgentTranscriptTurn,
  type AgentTranscriptUserFile,
  type AgentTranscriptUserImage,
} from './acp/acp-entry-projection'
import {
  acpActionGroupLabel,
  acpProgressFlowEntries,
  isAcpProgressUpdate,
} from './acp/acp-progress-timeline'
import { terminalTargetFilePath } from './workspace-file-view'
import {
  transcriptGitDiffSearchParams,
  transcriptGitDiffTargetForRepository,
  unavailableTranscriptGitDiffTarget,
  workingCopyTranscriptGitDiffTarget,
  type TranscriptGitDiffTarget,
} from './transcript-git-diff'
import 'katex/dist/katex.min.css'

interface AgentTranscriptProcessPresentation {
  detail: string
  terminals?: AgentTranscriptTerminal[]
  subagentTranscript?: AgentTranscript
}

interface TranscriptFileOpenContextValue {
  agentId?: string
  workspaceRoot?: string
  onOpenFile?: (filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
}

const TranscriptFileOpenContext = createContext<TranscriptFileOpenContextValue>({})

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
  if (
    current
    && next
    && current.sessionId === next.sessionId
    && typeof current.revision === 'number'
    && typeof next.revision === 'number'
    && next.revision < current.revision
  ) return current
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
  source: 'acp' | 'json-cli'
  refreshSignal?: number
  runtimeState?: string
  expectHistory?: boolean
  forkedFromAgent?: boolean
  onOpenWorkspaceFilePath?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onOpenUrlInFarming?: (url: string) => void
  onAvailabilityChange?: (state: { loading: boolean; hasContent: boolean; available: boolean }) => void
  onReadLatest?: () => void
  onForkLatest?: () => Promise<void> | void
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
const ACP_TRANSCRIPT_FETCH_RETRY_DELAYS_MS = [250, 1000] as const

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

function elapsedDurationLabel(startedAt: number | null | undefined, now = Date.now()) {
  const numeric = Number(startedAt)
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  const timestamp = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
  return durationLabel(Math.max(0, now - timestamp))
}

function transcriptMessageTime(timestampValue: number | null | undefined) {
  const numeric = Number(timestampValue)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  const timestamp = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return null
  return {
    dateTime: date.toISOString(),
    label: date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    title: date.toLocaleString(),
  }
}

function AgentTranscriptMessageTime({
  timestamp,
  kind,
}: {
  timestamp: number | null | undefined
  kind: 'user' | 'steer' | 'answer'
}) {
  const value = transcriptMessageTime(timestamp)
  if (!value) return null
  return (
    <time
      className={`code-agent-transcript-message-time code-agent-transcript-message-time-${kind}`}
      data-testid={`code-agent-transcript-${kind}-time`}
      dateTime={value.dateTime}
      title={value.title}
    >
      {value.label}
    </time>
  )
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

function acpLiveTool(turn: AgentTranscriptTurn, copy: CodeCopy) {
  return acpLiveToolActivity(turn.processItems, acpActivityLabels(copy))
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
  return Boolean(exactTranscriptPathTarget(href)?.lineNumber)
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
  return exactTranscriptPathTarget(text)?.path ?? text.replace(/:(\d+)(?::(\d+)(?:-(\d+))?)?$/, '')
}

function transcriptFileBasenameLooksValid(pathText: string) {
  const basename = pathText.split(/[\\/]/).filter(Boolean).pop() || pathText
  if (TRANSCRIPT_SPECIAL_FILENAMES.has(basename)) return true
  const extensionMatch = basename.match(/\.([A-Za-z0-9+_-]+)$/)
  if (!extensionMatch) return false
  return TRANSCRIPT_FILE_EXTENSIONS.has((extensionMatch[1] || '').toLowerCase())
}

function safeDecodeTranscriptHref(text: string) {
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

function exactTranscriptPathTarget(text: string) {
  const decoded = safeDecodeTranscriptHref(text.trim())
  const matches = collectTerminalPathLinkMatches(decoded)
  const exact = matches.find(match => (
    match.startIndex === 0 &&
    match.length === decoded.length &&
    match.pathTarget &&
    transcriptFileBasenameLooksValid(match.pathTarget.path)
  ))
  return exact?.pathTarget ?? null
}

function transcriptFileTargetFromText(text: string, workspaceRoot?: string) {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('#') || isBareDomainTranscriptHref(trimmed)) return null
  const pathTarget = exactTranscriptPathTarget(trimmed)
  if (!pathTarget) return null
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
  const pathTarget = exactTranscriptPathTarget(trimmed)
  if (!pathTarget) return false
  const withoutLocation = pathTarget.path
  return (
    withoutLocation.startsWith('/') ||
    withoutLocation.startsWith('~/') ||
    withoutLocation.startsWith('./') ||
    withoutLocation.startsWith('../') ||
    withoutLocation.includes('/') ||
    Boolean(pathTarget.lineNumber)
  )
}

function fileReferenceDisplayText(filePath: string, lineNumber?: number) {
  const basename = stripCandidateLocationSuffix(filePath.trim()).split(/[\\/]/).filter(Boolean).pop() || filePath.trim()
  return lineNumber && lineNumber > 1 ? `${basename}:${lineNumber}` : basename
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

function TranscriptLocalErrorFallback({
  copy,
  message = copy.agentTranscriptUnavailable,
  onRetry,
  testId,
}: {
  copy: CodeCopy
  message?: string
  onRetry: () => void
  testId: string
}) {
  return (
    <div
      className="code-agent-transcript-terminal-sync-error"
      data-testid={testId}
      role="alert"
    >
      <span>{message}</span>
      <button type="button" onClick={onRetry}>{copy.retry}</button>
    </div>
  )
}

function AgentTranscriptImages({
  images,
  className,
  testId,
  fallbackAlt,
}: {
  images: AgentTranscriptUserImage[]
  className: string
  testId: string
  fallbackAlt: string
}) {
  const [preview, setPreview] = useState<AgentTranscriptUserImage | null>(null)
  useEffect(() => {
    if (!preview) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [preview])
  if (images.length <= 0) return null
  return (
    <>
      <div className={className} data-testid={testId}>
        {images.map(image => (
          <button
            key={image.id}
            type="button"
            className="code-agent-transcript-image-trigger"
            aria-label={`Open ${image.alt || fallbackAlt}`}
            onClick={() => setPreview(image)}
          >
            <img
              src={image.url}
              alt={image.alt || fallbackAlt}
              loading="lazy"
              decoding="async"
            />
          </button>
        ))}
      </div>
      {preview ? createPortal(
        <div
          className="code-agent-transcript-image-overlay"
          data-testid="code-agent-transcript-image-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={preview.alt || fallbackAlt}
          onClick={() => setPreview(null)}
        >
          <button
            type="button"
            className="code-agent-transcript-image-close"
            aria-label="Close image preview"
            onClick={event => {
              event.stopPropagation()
              setPreview(null)
            }}
          >
            <CloseGlyph />
          </button>
          <img
            src={preview.url}
            alt={preview.alt || fallbackAlt}
            onClick={event => event.stopPropagation()}
          />
        </div>,
        document.body,
      ) : null}
    </>
  )
}

function AgentTranscriptUserImages({ images }: { images: AgentTranscriptUserImage[] }) {
  return <AgentTranscriptImages images={images} className="code-agent-transcript-user-images" testId="code-agent-transcript-user-images" fallbackAlt="Attached image" />
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
  const { agentId, workspaceRoot, onOpenFile } = useContext(TranscriptFileOpenContext)
  if (files.length <= 0) return null
  return (
    <div className="code-agent-transcript-user-files" data-testid="code-agent-transcript-user-files">
      {files.map(file => {
        const content = file.content || ''
        const hasContent = Boolean(content)
        const resourceHref = file.resourceKind === 'link' ? safeResourceHref(file.uri) : ''
        const workspaceResource = file.resourceKind === 'link' && file.uri
          ? transcriptLocationOpenTarget({ path: file.uri }, workspaceRoot)
          : null
        if (
          file.resourceKind === 'link'
          && file.mimeType === 'text/html'
          && file.presentation === 'inline-visualization'
          && file.presentationSource === 'codex-host-directive'
          && workspaceResource
          && agentId
          && !file.error
        ) {
          const exactExternal = workspaceResource.target.globalRoot === true
          return (
            <AgentTranscriptInlineVisualization
              key={file.id}
              rootId={exactExternal ? GLOBAL_WORKSPACE_FILES_AGENT_ID : agentId}
              exactExternal={exactExternal}
              file={file}
              filePath={workspaceResource.filePath}
            />
          )
        }
        if (file.resourceKind === 'link') {
          return (
            <div key={file.id} className="code-agent-transcript-user-file code-agent-transcript-resource-link">
              <TranscriptFileIcon filePath={file.name} />
              {resourceHref ? (
                <a href={resourceHref} target="_blank" rel="noreferrer" title={file.uri}>{file.name}</a>
              ) : workspaceResource && onOpenFile ? (
                <button
                  type="button"
                  className="code-agent-transcript-markdown-file-link"
                  title={file.uri}
                  onClick={() => onOpenFile(workspaceResource.filePath, workspaceResource.target)}
                >
                  {file.name}
                </button>
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

function AgentTranscriptInlineVisualization({
  rootId,
  exactExternal,
  file,
  filePath,
}: {
  rootId: string
  exactExternal: boolean
  file: AgentTranscriptUserFile
  filePath: string
}) {
  const [document, setDocument] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let previewId = ''
    void fetchWorkspaceFile(rootId, filePath, { signal: controller.signal, exactExternal })
      .then(async workspaceFile => {
        const preview = await createWorkspaceHtmlPreview(rootId, filePath, { signal: controller.signal, exactExternal })
        previewId = preview.id
        const baseUrl = new URL(workspaceHtmlPreviewUrl(preview.id, 'base'), window.location.href).toString()
        const rootUrl = new URL(workspaceHtmlPreviewUrl(preview.id, 'root'), window.location.href).toString()
        setDocument(buildWorkspaceInlineVisualizationDocument(workspaceFile.content || '', baseUrl, rootUrl))
      })
      .catch(reason => {
        if (controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : String(reason || 'Visualization unavailable'))
      })
    return () => {
      controller.abort()
      if (previewId) void deleteWorkspaceHtmlPreview(previewId)
    }
  }, [exactExternal, filePath, rootId])

  if (error) {
    return <div className="code-agent-transcript-inline-visualization error" role="status">{error}</div>
  }
  return (
    <div className="code-agent-transcript-inline-visualization" data-testid="code-agent-transcript-inline-visualization">
      {document ? (
        <iframe
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={document}
          title={file.name}
        />
      ) : <div className="code-agent-transcript-inline-visualization-loading">Loading visualization…</div>}
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
  return <AgentTranscriptImages images={images} className="code-agent-transcript-process-images" testId="code-agent-transcript-process-images" fallbackAlt="Generated image" />
}

function transcriptLocationPath(pathText: string) {
  if (!pathText.startsWith('file://')) return pathText
  try {
    const uri = new URL(pathText)
    let filePath = decodeURIComponent(uri.pathname)
    if (uri.hostname) filePath = `//${uri.hostname}${filePath}`
    if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
    return filePath
  } catch {
    return pathText
  }
}

function transcriptLocationOpenTarget(
  location: AgentTranscriptLocation,
  workspaceRoot?: string,
) {
  const path = transcriptLocationPath(location.path)
  const filePath = terminalTargetFilePath(path, workspaceRoot || '')
  const globalFilePath = !filePath && path.startsWith('/')
    ? normalizeGlobalWorkspaceFilePath(path)
    : ''
  if (!filePath && !globalFilePath) return null
  return {
    filePath: filePath || globalFilePath,
    target: {
      ...(location.lineNumber !== undefined ? { lineNumber: location.lineNumber } : {}),
      ...(location.column !== undefined ? { column: location.column } : {}),
      ...(location.endLineNumber !== undefined ? { endLineNumber: location.endLineNumber } : {}),
      ...(location.endColumn !== undefined ? { endColumn: location.endColumn } : {}),
      ...(!filePath && globalFilePath ? { globalRoot: true } : {}),
    },
  }
}

function transcriptLocationLabel(location: AgentTranscriptLocation) {
  if (!location.lineNumber) return location.path
  const column = location.column ? `:${location.column}` : ''
  const end = location.endLineNumber
    ? `-${location.endLineNumber}${location.endColumn ? `:${location.endColumn}` : ''}`
    : location.endColumn
      ? `-${location.endColumn}`
      : ''
  return `${location.path}:${location.lineNumber}${column}${end}`
}

function transcriptLocationsCopyText(locations?: AgentTranscriptLocation[]) {
  if (!locations?.length) return ''
  return `Locations\n${locations.map(transcriptLocationLabel).join('\n')}`
}

function AgentTranscriptLocations({ locations }: { locations: AgentTranscriptLocation[] }) {
  const { workspaceRoot, onOpenFile } = useContext(TranscriptFileOpenContext)
  if (locations.length <= 0) return null
  return (
    <div className="code-agent-transcript-locations" data-testid="code-agent-transcript-locations">
      {locations.map((location, index) => {
        const openTarget = transcriptLocationOpenTarget(location, workspaceRoot)
        const label = transcriptLocationLabel(location)
        if (!onOpenFile || !openTarget) {
          return <span key={`${location.path}-${index}`} className="code-agent-transcript-file-link" title={label}>{label}</span>
        }
        return (
          <button
            key={`${location.path}-${index}`}
            type="button"
            className="code-agent-transcript-file-link"
            title={label}
            onClick={() => onOpenFile(openTarget.filePath, openTarget.target)}
          >
            <TranscriptFileIcon filePath={openTarget.filePath} />
            <span className="code-agent-transcript-file-label">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

function AgentTranscriptResultImages({ images }: { images: AgentTranscriptUserImage[] }) {
  return <AgentTranscriptImages images={images} className="code-agent-transcript-result-images" testId="code-agent-transcript-result-images" fallbackAlt="Generated image" />
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

function processEntriesForTurn(items: AgentTranscriptProcessItem[], source: string) {
  if (source === 'acp') return acpProgressFlowEntries(items)
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

function compactProcessEntries(
  entries: ProcessEntry[],
  turnStatus: AgentTranscriptTurn['status'],
  source: string,
) {
  if (source === 'acp' && turnStatus === 'inProgress') {
    return {
      entries,
      items: entries.flatMap(entry => entry.kind === 'group' ? entry.items : [entry.item]),
    }
  }
  const showLiveAcpProgress = source === 'acp' && turnStatus === 'inProgress'
  const eligible = entries.flatMap(entry => {
    if (entry.kind === 'item') {
      return isUserSteerProcessItem(entry.item) || (showLiveAcpProgress && isAcpProgressUpdate(entry.item))
        ? [entry.item]
        : []
    }
    return turnStatus === 'inProgress'
      ? entry.items.filter(item => !isProcessItemFailed(item) && !item.collaboration)
      : []
  })
  const selectedIndexes = new Set<number>()
  eligible.forEach((item, index) => {
    if (isUserSteerProcessItem(item) || (showLiveAcpProgress && isAcpProgressUpdate(item))) {
      selectedIndexes.add(index)
    }
  })
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    if (!isProcessItemRunning(eligible[index]!)) continue
    selectedIndexes.add(index)
    break
  }
  const items = eligible.filter((_item, index) => selectedIndexes.has(index))
  return {
    entries: items.map(item => ({ kind: 'item' as const, item })),
    items,
  }
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
    || (item.locations || []).length > 0
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

function AgentTranscriptSteerItem({ item, copy }: { item: AgentTranscriptProcessItem; copy: CodeCopy }) {
  const text = (item.detail || item.title || '').trim()
  const images = item.images || []
  const audios = item.audios || []
  const files = item.files || []
  const terminals = item.terminals || []
  if (!text && images.length <= 0 && audios.length <= 0 && files.length <= 0 && terminals.length <= 0) return null
  return (
    <div className="code-agent-transcript-steer" data-testid="code-agent-transcript-steer">
      <div className="code-agent-transcript-user code-agent-transcript-steer-bubble">
        {text ? <div className="code-agent-transcript-steer-content">{plainTextBlock(text)}</div> : null}
        <AgentTranscriptUserImages images={images} />
        <AgentTranscriptAudios audios={audios} />
        <AgentTranscriptUserFiles files={files} />
        <AgentTranscriptTerminals terminals={terminals} />
        <div className="code-agent-transcript-steer-meta" data-testid="code-agent-transcript-steer-meta">
          <span className="code-agent-transcript-steer-label" data-testid="code-agent-transcript-steer-label">
            {copy.steerQueuedMessage}
          </span>
          <AgentTranscriptMessageTime timestamp={item.createdAt} kind="steer" />
        </div>
      </div>
    </div>
  )
}

function collaborationActionLabel(
  action: AcpCollaborationAction,
  copy: CodeCopy,
) {
  if (action === 'started') return copy.agentTranscriptCollaborationStarted
  if (action === 'updated') return copy.agentTranscriptCollaborationUpdated
  if (action === 'finished') return copy.agentTranscriptCollaborationActionCompleted
  if (action === 'interrupted') return copy.agentTranscriptCollaborationPauseRequested
  if (action === 'failed') return copy.agentTranscriptCollaborationFailed
  return copy.agentTranscriptCollaborationRecorded
}

function collaborationStatusLabel(status: AcpCollaborationStatus, copy: CodeCopy) {
  if (status === 'pending') return copy.agentTranscriptCollaborationPending
  if (status === 'running') return copy.agentTranscriptCollaborationInProgress
  if (status === 'completed') return copy.agentTranscriptCollaborationCompleted
  if (status === 'paused') return copy.agentTranscriptCollaborationInterrupted
  if (status === 'failed') return copy.agentTranscriptCollaborationFailed
  if (status === 'closed') return copy.agentTranscriptCollaborationClosed
  return ''
}

function CollaborationAgentGlyph({ icon }: { icon: number }) {
  const Glyph = [
    AgentBotGlyph,
    AgentSpeechBotGlyph,
    AgentChipGlyph,
    AgentSmartToyGlyph,
    AgentDroneGlyph,
    AgentManufacturingGlyph,
  ][icon] || AgentBotGlyph
  return <Glyph />
}

function AgentTranscriptCollaborationTimeline({
  agents,
  renderProcessItem,
  copy,
  disclosureScope,
  openAgentIds,
  setOpenAgentIds,
  openActivityIds,
  setOpenActivityIds,
}: {
  agents: AcpCollaborationAgent[]
  renderProcessItem: (processItemId: string) => ReactNode
  copy: CodeCopy
  disclosureScope: string
  openAgentIds: Set<string>
  setOpenAgentIds: Dispatch<SetStateAction<Set<string>>>
  openActivityIds: Set<string>
  setOpenActivityIds: Dispatch<SetStateAction<Set<string>>>
}) {
  const [visibleActivityCounts, setVisibleActivityCounts] = useState<Record<string, number>>({})
  const [visibleEvidenceCounts, setVisibleEvidenceCounts] = useState<Record<string, number>>({})
  if (agents.length === 0) return null
  const agentById = new Map(agents.map(agent => [agent.id, agent]))
  const childrenByParent = new Map<string, AcpCollaborationAgent[]>()
  const topLevelAgents: AcpCollaborationAgent[] = []
  const hasParentCycle = (agent: AcpCollaborationAgent) => {
    const visited = new Set([agent.id])
    let parentId = agent.parentThreadId
    while (parentId && agentById.has(parentId)) {
      if (visited.has(parentId)) return true
      visited.add(parentId)
      parentId = agentById.get(parentId)?.parentThreadId
    }
    return false
  }
  for (const agent of agents) {
    if (agent.parentThreadId && agentById.has(agent.parentThreadId) && !hasParentCycle(agent)) {
      const children = childrenByParent.get(agent.parentThreadId) || []
      children.push(agent)
      childrenByParent.set(agent.parentThreadId, children)
    } else {
      topLevelAgents.push(agent)
    }
  }
  const renderAgent = (agent: AcpCollaborationAgent, depth: number): ReactNode => {
    const agentDisclosureId = `${disclosureScope}:${agent.id}`
    const agentOpen = openAgentIds.has(agentDisclosureId)
    const statusLabel = collaborationStatusLabel(agent.status, copy)
    const childAgents = childrenByParent.get(agent.id) || []
    const expandable = agent.activities.length > 0 || childAgents.length > 0
    const visibleActivityCount = Math.max(8, visibleActivityCounts[agent.id] || 8)
    const visibleActivities = agent.activities.slice(-visibleActivityCount)
    const hiddenActivityCount = agent.activities.length - visibleActivities.length
    const closeAgent = () => {
      setOpenActivityIds(current => {
        const next = new Set(current)
        agent.activities.forEach(activity => next.delete(`${disclosureScope}:${activity.id}`))
        return next
      })
    }
    return (
      <section
        className={`code-agent-transcript-collaboration-group ${agentOpen ? 'expanded' : ''}`}
        data-testid="code-agent-transcript-collaboration-group"
        data-agent-thread-id={agent.threadId}
        data-agent-icon={agent.icon}
        data-agent-depth={depth}
        key={agent.id}
      >
        <button
          type="button"
          className={`code-agent-transcript-collaboration-summary ${expandable ? '' : 'static'}`}
          data-testid="code-agent-transcript-collaboration-summary"
          aria-expanded={expandable ? agentOpen : undefined}
          disabled={!expandable}
          title={[
            agent.task || agent.name,
            agent.task && agent.task !== agent.name ? agent.name : '',
            statusLabel,
            copy.agentTranscriptProcessCount(agent.events.length),
          ].filter(Boolean).join(' · ')}
          onClick={clickEvent => {
            if (!expandable) return
            clickEvent.stopPropagation()
            toggleTranscriptDisclosureWithStableAnchor(clickEvent.currentTarget, () => {
              setOpenAgentIds(current => {
                const next = new Set(current)
                if (next.has(agentDisclosureId)) next.delete(agentDisclosureId)
                else next.add(agentDisclosureId)
                return next
              })
              if (agentOpen) closeAgent()
            })
          }}
        >
          <span className={`code-agent-transcript-collaboration-agent tone-${agent.tone}`}>
            <CollaborationAgentGlyph icon={agent.icon} />
            <span className="code-agent-transcript-collaboration-agent-labels">
              <span>{agent.task || agent.name}</span>
              {agent.task && agent.task !== agent.name ? <small>{agent.name}</small> : null}
            </span>
          </span>
          {statusLabel ? (
            <span className={`code-agent-transcript-collaboration-action ${agent.status}`}>{statusLabel}</span>
          ) : null}
          <span className="code-agent-transcript-collaboration-count">
            {copy.agentTranscriptProcessCount(agent.events.length)}
            {childAgents.length > 0 ? ` · ${copy.agentTranscriptCollaborationChildCount(childAgents.length)}` : ''}
          </span>
          {expandable ? <ChevronRightGlyph className="code-agent-transcript-chevron" /> : null}
        </button>
        {agentOpen ? (
          <div className="code-agent-transcript-collaboration-events">
            {hiddenActivityCount > 0 ? (
              <button
                type="button"
                className="code-agent-transcript-collaboration-activities-earlier"
                data-testid="code-agent-transcript-collaboration-activities-earlier"
                onClick={clickEvent => {
                  clickEvent.stopPropagation()
                  setVisibleActivityCounts(current => ({
                    ...current,
                    [agent.id]: Math.min(agent.activities.length, visibleActivityCount + 20),
                  }))
                }}
              >
                {copy.agentTranscriptCollaborationEarlierActivities(Math.min(20, hiddenActivityCount))}
              </button>
            ) : null}
            {visibleActivities.map(activity => {
              const activityDisclosureId = `${disclosureScope}:${activity.id}`
              const activityOpen = openActivityIds.has(activityDisclosureId)
              const visibleCount = Math.max(8, visibleEvidenceCounts[activity.id] || 8)
              const visibleProcessItemIds = activity.processItemIds.slice(-visibleCount)
              const hiddenEvidenceCount = activity.processItemIds.length - visibleProcessItemIds.length
              return (
                <div
                  className={`code-agent-transcript-collaboration-activity ${activityOpen ? 'expanded' : ''}`}
                  data-testid="code-agent-transcript-collaboration-activity"
                  key={activity.id}
                >
                  <button
                    type="button"
                    className="code-agent-transcript-collaboration-event"
                    data-testid="code-agent-transcript-collaboration-event"
                    data-process-item-id={activity.processItemId}
                    aria-expanded={activityOpen}
                    title={activity.title || activity.message || agent.name}
                    onClick={clickEvent => {
                      clickEvent.stopPropagation()
                      toggleTranscriptDisclosureWithStableAnchor(clickEvent.currentTarget, () => {
                        setOpenActivityIds(current => {
                          const next = new Set(current)
                          if (next.has(activityDisclosureId)) next.delete(activityDisclosureId)
                          else next.add(activityDisclosureId)
                          return next
                        })
                      })
                    }}
                  >
                    <span className={`code-agent-transcript-collaboration-action ${activity.action}`}>
                      {collaborationActionLabel(activity.action, copy)}
                    </span>
                    <span className="code-agent-transcript-collaboration-event-detail">
                      {activity.message || (
                        activity.action === 'started'
                          || activity.action === 'updated'
                          || activity.action === 'recorded'
                          ? agent.task || agent.name
                          : activity.title || agent.name
                      )}
                    </span>
                    {activity.count > 1 ? (
                      <span className="code-agent-transcript-collaboration-event-count">
                        {copy.agentTranscriptProcessCount(activity.count)}
                      </span>
                    ) : null}
                    <ChevronRightGlyph className="code-agent-transcript-chevron" />
                  </button>
                  {activityOpen ? (
                    <div
                      className="code-agent-transcript-collaboration-evidence"
                      data-testid="code-agent-transcript-collaboration-evidence"
                    >
                      {hiddenEvidenceCount > 0 ? (
                        <button
                          type="button"
                          className="code-agent-transcript-collaboration-earlier"
                          data-testid="code-agent-transcript-collaboration-earlier"
                          onClick={clickEvent => {
                            clickEvent.stopPropagation()
                            setVisibleEvidenceCounts(current => ({
                              ...current,
                              [activity.id]: Math.min(activity.processItemIds.length, visibleCount + 20),
                            }))
                          }}
                        >
                          {copy.agentTranscriptCollaborationEarlierEvidence(Math.min(20, hiddenEvidenceCount))}
                        </button>
                      ) : null}
                      {visibleProcessItemIds.map(processItemId => renderProcessItem(processItemId))}
                    </div>
                  ) : null}
                </div>
              )
            })}
            {childAgents.length > 0 ? (
              <div className="code-agent-transcript-collaboration-children">
                {childAgents.map(child => renderAgent(child, depth + 1))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    )
  }
  return (
    <div className="code-agent-transcript-collaboration" data-testid="code-agent-transcript-collaboration">
      <div className="code-agent-transcript-collaboration-heading">
        <AgentGroupGlyph />
        <span>{copy.agentTranscriptCollaborationHeading}</span>
      </div>
      {topLevelAgents.map(agent => renderAgent(agent, 0))}
    </div>
  )
}

function AgentTranscriptLiveActivityIcon({ kind }: { kind: AcpActivityKind }) {
  let glyph = <LoadingGlyph />
  if (kind === 'thinking') glyph = <ThinkingGlyph />
  else if (kind === 'running') glyph = <TerminalSquareGlyph />
  else if (kind === 'reading') glyph = <BookGlyph />
  else if (kind === 'searching') glyph = <SearchGlyph />
  else if (kind === 'editing') glyph = <PencilGlyph />
  else if (kind === 'plan') glyph = <ChecklistGlyph />
  else if (kind === 'fetching') glyph = <CloudDownloadGlyph />
  else if (kind === 'tool') glyph = <ToolsGlyph />
  return (
    <span
      className={`code-agent-transcript-live-activity-icon kind-${kind}`}
      data-testid="code-agent-transcript-live-activity-icon"
      data-kind={kind}
      aria-hidden="true"
    >
      {glyph}
    </span>
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
    return <AgentTranscriptSteerItem item={item} copy={copy} />
  }

  const images = item.images || []
  const audios = item.audios || []
  const files = item.files || []
  const locations = item.locations || []
  const terminals = item.terminals || []
  const copyableDetail = item.detail && (
    item.type === 'thought' || item.detail.trim() !== item.title.trim()
  ) ? item.detail : ''
  const detail = copyableDetail && detailDuplicatesTerminalOutcome(copyableDetail, terminals)
    ? ''
    : copyableDetail
  const visibleDetail = terminalOutcomeSyncFailed && item.terminalIds?.length
    ? ''
    : detail
  const hasCopyableDetail = !!copyableDetail || locations.length > 0
  const hasDetail = !!visibleDetail
  const planItems = item.type === 'plan' && visibleDetail ? planDetailItems(visibleDetail) : null
  const expandable = hasExpandableProcessItemContent(item, visibleDetail, planItems)
  const displayTitle = title || item.title
  const details = (
    <>
      {planItems ? (
        <ol className="code-agent-transcript-plan-list">
          {planItems.map((entry, index) => (
            <li
              key={`${index}-${entry.text}`}
              className={entry.status}
              aria-current={entry.status === 'running' ? 'step' : undefined}
            >
              <span>{entry.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <AgentTranscriptProcessImages images={images} />
      <AgentTranscriptAudios audios={audios} />
      <AgentTranscriptUserFiles files={files} />
      <AgentTranscriptLocations locations={locations} />
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
        <div className="code-agent-transcript-process-detail">{plainTextBlock(visibleDetail)}</div>
      ) : !planItems && hasDetail ? <pre>{visibleDetail}</pre> : null}
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

function SafeAgentTranscriptProcessItemView(
  props: Parameters<typeof AgentTranscriptProcessItemView>[0],
) {
  const resetKey = [
    props.item.id,
    props.item.status || '',
    String(props.item.detail?.length || 0),
    props.item.detailTruncated ? 'truncated' : 'complete',
    String(props.item.terminals?.length || 0),
    String(props.item.subagentTranscript?.turns.length || 0),
  ].join('\u0000')
  return (
    <LocalErrorBoundary
      label="transcript tool"
      resetKey={resetKey}
      fallback={(_error, retry) => (
        <TranscriptLocalErrorFallback
          copy={props.copy}
          message={`${props.item.title}: ${props.copy.agentTranscriptUnavailable}`}
          onRetry={retry}
          testId="code-agent-transcript-tool-render-error"
        />
      )}
    >
      <LocalRenderFault surface="transcript-tool" identity={props.item.id}>
        <AgentTranscriptProcessItemView {...props} />
      </LocalRenderFault>
    </LocalErrorBoundary>
  )
}

function AgentTranscriptCollaborationSpace({
  agents,
  processItems,
  copy,
  disclosureScope,
  openAgentIds,
  setOpenAgentIds,
  openActivityIds,
  setOpenActivityIds,
  onLoadProcessItemDetail,
  onStopTerminal,
  onInputTerminal,
  onResizeTerminal,
  onStopSubagent,
}: {
  agents: AcpCollaborationAgent[]
  processItems: AgentTranscriptProcessItem[]
  copy: CodeCopy
  disclosureScope: string
  openAgentIds: Set<string>
  setOpenAgentIds: Dispatch<SetStateAction<Set<string>>>
  openActivityIds: Set<string>
  setOpenActivityIds: Dispatch<SetStateAction<Set<string>>>
  onLoadProcessItemDetail?: (itemId: string) => Promise<AgentTranscriptProcessPresentation>
  onStopTerminal?: (terminalId: string) => Promise<void>
  onInputTerminal?: (terminalId: string, input: string) => Promise<void>
  onResizeTerminal?: (terminalId: string, cols: number, rows: number) => Promise<void>
  onStopSubagent?: (sessionId: string) => Promise<void>
}) {
  const [loadedDetails, setLoadedDetails] = useState<Record<string, AgentTranscriptProcessPresentation>>({})
  const [openItemIds, setOpenItemIds] = useState<Set<string>>(() => new Set())
  const [copiedItemId, setCopiedItemId] = useState('')
  const resolvedItems = useMemo(() => processItems.map(item => (
    Object.prototype.hasOwnProperty.call(loadedDetails, item.id)
      ? {
          ...item,
          detail: loadedDetails[item.id]?.detail || '',
          terminals: loadedDetails[item.id]?.terminals,
          subagentTranscript: loadedDetails[item.id]?.subagentTranscript,
          detailTruncated: false,
        }
      : item
  )), [loadedDetails, processItems])
  const itemById = useMemo(
    () => new Map(resolvedItems.map(item => [item.id, item])),
    [resolvedItems],
  )
  const loadItem = useCallback(async (itemId: string) => {
    if (!onLoadProcessItemDetail) return
    const detail = await onLoadProcessItemDetail(itemId)
    setLoadedDetails(current => ({ ...current, [itemId]: detail }))
  }, [onLoadProcessItemDetail])
  const toggleItem = useCallback((itemId: string) => {
    const opening = !openItemIds.has(itemId)
    const item = itemById.get(itemId)
    if (opening && item && (item.detailTruncated || item.terminalIds?.length || item.subagentSessionId)) {
      void loadItem(itemId).catch(() => {})
    }
    setOpenItemIds(current => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }, [itemById, loadItem, openItemIds])
  const copyItem = useCallback((item: AgentTranscriptProcessItem) => {
    const load = item.detailTruncated && onLoadProcessItemDetail
      ? onLoadProcessItemDetail(item.id)
      : Promise.resolve({ detail: item.detail || '' })
    void load.then(presentation => writeClipboardText(
      [item.title, presentation.detail, transcriptLocationsCopyText(item.locations)]
        .filter(Boolean)
        .join('\n\n'),
    )).then(copied => {
      if (!copied) return
      setCopiedItemId(item.id)
      window.setTimeout(() => setCopiedItemId(current => (current === item.id ? '' : current)), 1200)
    }).catch(() => {})
  }, [onLoadProcessItemDetail])
  const stopTerminal = useCallback(async (itemId: string, terminalId: string) => {
    if (!onStopTerminal) return
    await onStopTerminal(terminalId)
    await loadItem(itemId)
  }, [loadItem, onStopTerminal])
  const inputTerminal = useCallback(async (itemId: string, terminalId: string, input: string) => {
    if (!onInputTerminal) return
    await onInputTerminal(terminalId, input)
    await loadItem(itemId)
  }, [loadItem, onInputTerminal])
  const resizeTerminal = useCallback(async (_itemId: string, terminalId: string, cols: number, rows: number) => {
    await onResizeTerminal?.(terminalId, cols, rows)
  }, [onResizeTerminal])
  return (
    <AgentTranscriptCollaborationTimeline
      agents={agents}
      disclosureScope={disclosureScope}
      openAgentIds={openAgentIds}
      setOpenAgentIds={setOpenAgentIds}
      openActivityIds={openActivityIds}
      setOpenActivityIds={setOpenActivityIds}
      renderProcessItem={processItemId => {
        const item = itemById.get(processItemId)
        if (!item) return null
        return (
          <SafeAgentTranscriptProcessItemView
            key={item.id}
            item={item}
            copy={copy}
            copied={copiedItemId === item.id}
            detailOpen={openItemIds.has(item.id)}
            onToggle={toggleItem}
            onCopy={copyItem}
            onStopTerminal={stopTerminal}
            onInputTerminal={inputTerminal}
            onResizeTerminal={resizeTerminal}
            onStopSubagent={onStopSubagent}
          />
        )
      }}
      copy={copy}
    />
  )
}

function AgentTranscriptProgressUpdate({
  item,
  markdownComponents,
  copy,
}: {
  item: AgentTranscriptProcessItem
  markdownComponents: Components
  copy: CodeCopy
}) {
  const progressText = String(item.detail || '').trim()
  if (!progressText) return null
  return (
    <div
      className="code-acp-progress-update code-markdown-preview"
      data-testid="code-acp-progress-update"
    >
      <LocalErrorBoundary
        label="transcript progress Markdown"
        resetKey={progressText}
        fallback={(_error, retry) => (
          <>
            <TranscriptLocalErrorFallback
              copy={copy}
              onRetry={retry}
              testId="code-agent-transcript-markdown-render-error"
            />
            <pre>{progressText}</pre>
          </>
        )}
      >
        <LocalRenderFault surface="transcript-markdown" identity={item.id}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex, rehypeHighlight]}
            components={markdownComponents}
            skipHtml
            urlTransform={agentTranscriptUrlTransform}
          >
            {progressText}
          </ReactMarkdown>
        </LocalRenderFault>
      </LocalErrorBoundary>
    </div>
  )
}

function AgentTranscriptPlanDriver({ plan }: { plan: AgentTranscriptProcessItem }) {
  const [open, setOpen] = useState(true)
  const items = planDetailItems(String(plan.detail || ''))
  const progress = plan.totalSteps
    ? `${plan.completedSteps || 0}/${plan.totalSteps}`
    : ''
  return (
    <aside
      className={`code-agent-transcript-plan-driver ${open ? 'expanded' : ''}`}
      data-testid="code-agent-transcript-plan-driver"
      aria-label="Current plan"
    >
      <button
        type="button"
        className="code-agent-transcript-plan-driver-summary"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <span>Plan</span>
        {progress ? <small>{progress}</small> : null}
        <ChevronRightGlyph className="code-agent-transcript-plan-driver-chevron" />
      </button>
      {open ? (
        items ? (
          <ol className="code-agent-transcript-plan-list">
            {items.map((item, index) => (
              <li
                key={`${index}:${item.text}`}
                className={item.status}
                aria-current={item.status === 'running' ? 'step' : undefined}
              >
                <span>{item.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="code-agent-transcript-plan-driver-detail">{plan.detail}</div>
        )
      ) : null}
    </aside>
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
        <span className="code-agent-transcript-process-title-text">{summaryLabel || processGroupLabel(items)}</span>
        <ChevronRightGlyph className="code-agent-transcript-process-item-chevron" />
      </button>
      {detailOpen ? (
        <div className="code-agent-transcript-process-group-list">
          {items.map(item => (
            <SafeAgentTranscriptProcessItemView
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
  source,
  workspaceRoot,
  gitDiffTarget,
}: {
  items: AgentTranscriptProcessItem[]
  copy: CodeCopy
  onLoadPatchChanges?: (itemIds: string[]) => Promise<AgentTranscriptPatchChange[]>
  source: AgentTranscriptPaneProps['source']
  workspaceRoot?: string
  gitDiffTarget: TranscriptGitDiffTarget
}) {
  const [reviewOpen, setReviewOpen] = useState(false)
  const [detailedChanges, setDetailedChanges] = useState<AgentTranscriptPatchChange[] | null>(null)
  const [detailError, setDetailError] = useState('')
  const embeddedDecisions = useMemo(() => Object.fromEntries(items.flatMap(item => (
    (item.changes || []).flatMap(change => {
      if (!change.decision) return []
      const displayPath = workspaceRelativeTranscriptPath(change.path, workspaceRoot) || change.path
      return [[displayPath, change.decision] as const]
    })
  ))), [items, workspaceRoot])
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
  const hasCompleteEmbeddedDiff = embeddedRows.length > 0 && embeddedRows.every(row => (
    embeddedChanges.some(change => (
      (workspaceRelativeTranscriptPath(change.path, workspaceRoot) || change.path) === row.path
      && typeof change.diff === 'string'
    ))
  ))
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
  const handleReview = useCallback(() => {
    if (source === 'acp') {
      setReviewOpen(true)
      if (detailedChanges || hasCompleteEmbeddedDiff || !onLoadPatchChanges) return
      setDetailError('')
      void onLoadPatchChanges(items.map(item => item.id))
        .then(setDetailedChanges)
        .catch(error => setDetailError(error instanceof Error ? error.message : copy.agentTranscriptUnavailable))
      return
    }
    if (!workspaceRoot) return
    const params = new URLSearchParams({ root: workspaceRoot })
    window.open(appPath(`/review?${params.toString()}`), '_blank', 'noopener,noreferrer')
  }, [copy.agentTranscriptUnavailable, detailedChanges, hasCompleteEmbeddedDiff, items, onLoadPatchChanges, source, workspaceRoot])
  const handleGitDiff = useCallback(() => {
    if (!workspaceRoot || gitDiffTarget.kind === 'unavailable') return
    window.open(appPath(`/review?${transcriptGitDiffSearchParams(workspaceRoot, gitDiffTarget).toString()}`), '_blank', 'noopener,noreferrer')
  }, [gitDiffTarget, workspaceRoot])
  const summaryContent = (
    <>
      <DifferenceGlyph
        className="code-agent-transcript-result-icon"
        data-testid="code-agent-transcript-result-icon"
      />
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
      <div className="code-agent-transcript-result-header">
        <div className="code-agent-transcript-result-summary" data-testid="code-agent-transcript-result-summary" aria-label={summary}>
          {summaryContent}
        </div>
        {workspaceRoot && rows.length > 0 ? (
          <div className="code-agent-transcript-result-actions">
            <button
              type="button"
              className="code-agent-transcript-result-review"
              aria-label={`${copy.agentTranscriptReviewChanges}: ${reviewPaths.length} workspace ${reviewPaths.length === 1 ? 'file' : 'files'}`}
              onClick={handleReview}
            >
              {copy.agentTranscriptReviewChanges}
            </button>
            {gitDiffTarget.kind !== 'unavailable' ? (
              <button type="button" className="code-agent-transcript-result-review git-diff" onClick={handleGitDiff}>
                {gitDiffTarget.kind === 'last-commit'
                  ? copy.agentTranscriptGitDiffLastCommit
                  : copy.agentTranscriptGitDiff}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {source === 'acp' && reviewOpen ? createPortal(
        <div className="code-agent-transcript-change-review-overlay" role="dialog" aria-modal="true" aria-label={copy.agentTranscriptReviewChanges} onMouseDown={() => setReviewOpen(false)}>
          <div className="code-agent-transcript-change-review-dialog" onMouseDown={event => event.stopPropagation()}>
            <header>
              <span>{summary}</span>
              {totalAdded ? <span className="added">+{totalAdded}</span> : null}
              {totalRemoved ? <span className="removed">-{totalRemoved}</span> : null}
              <button type="button" aria-label={copy.close} title={copy.close} onClick={() => setReviewOpen(false)}><CloseGlyph /></button>
            </header>
            <div className="code-agent-transcript-change-review-body" data-testid="code-agent-transcript-result-details">
              {!hasCompleteEmbeddedDiff && !detailedChanges && !detailError ? (
                <div className="code-agent-transcript-result-loading">{copy.agentTranscriptLoadingChanges}</div>
              ) : null}
              {detailError ? (
                <div className="code-agent-transcript-result-error" role="alert">
                  <span>{copy.agentTranscriptChangesUnavailable}</span>
                  <details>
                    <summary>{copy.agentTranscriptTechnicalDetails}</summary>
                    <code>{detailError}</code>
                  </details>
                </div>
              ) : null}
              {detailedChanges || hasCompleteEmbeddedDiff ? rows.map(row => {
              const path = patchRowDisplayPath(row, workspaceRoot)
              const changes = availableChanges.filter(change => (
                (workspaceRelativeTranscriptPath(change.path, workspaceRoot) || change.path) === path
              ))
              const decision = embeddedDecisions[path]
              return (
                <section className="code-agent-transcript-change-review-file" key={`${items[0]?.id || 'patch'}:${path}`}>
                  <header title={path}>
                    <span className="code-agent-transcript-result-file-path">{path}</span>
                    <span className="code-agent-transcript-result-file-stats">
                      {row.added ? <span className="added">{row.added}</span> : null}
                      {row.removed ? <span className="removed">{row.removed}</span> : null}
                    </span>
                  </header>
                  {changes.map((change, changeIndex) => change.diff ? (
                    <pre className="code-agent-transcript-result-diff" key={`${path}:${changeIndex}`}>
                      {change.diff.split('\n').map((line, lineIndex) => (
                        <span className={patchDiffLineClass(line)} key={`${lineIndex}:${line}`}>{line}{'\n'}</span>
                      ))}
                    </pre>
                  ) : null)}
                  {decision ? (
                    <div className="code-agent-transcript-result-decision" data-testid="code-acp-patch-decision">
                      <span>{decision === 'reverted' ? copy.agentTranscriptChangeReverted : copy.agentTranscriptChangeKept}</span>
                    </div>
                  ) : null}
                </section>
              )
              }) : null}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  )
}

function AgentTranscriptTurnView({
  turn,
  copy,
  onOpenFile,
  onOpenUrlInFarming,
  workspaceRoot,
  clockActive,
  processOpen,
  groupProcessActions,
  source,
  onToggleProcess,
  onLoadProcessItemDetail,
  onLoadPatchChanges,
  gitDiffTarget,
  onStopTerminal,
  onInputTerminal,
  onResizeTerminal,
  onStopSubagent,
  subagentStates,
  openCollaborationAgentIds,
  setOpenCollaborationAgentIds,
  openCollaborationActivityIds,
  setOpenCollaborationActivityIds,
  onFork,
  showLiveActivity,
}: {
  turn: AgentTranscriptTurn
  copy: CodeCopy
  onOpenFile?: (filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onOpenUrlInFarming?: (url: string) => void
  workspaceRoot?: string
  clockActive: boolean
  processOpen: boolean
  groupProcessActions: boolean
  source: AgentTranscriptPaneProps['source']
  onToggleProcess: (turnId: string) => void
  onLoadProcessItemDetail?: (itemId: string) => Promise<AgentTranscriptProcessPresentation>
  onLoadPatchChanges?: (itemIds: string[]) => Promise<AgentTranscriptPatchChange[]>
  gitDiffTarget: TranscriptGitDiffTarget
  onStopTerminal?: (terminalId: string) => Promise<void>
  onInputTerminal?: (terminalId: string, input: string) => Promise<void>
  onResizeTerminal?: (terminalId: string, cols: number, rows: number) => Promise<void>
  onStopSubagent?: (sessionId: string) => Promise<void>
  subagentStates: AgentTranscriptSubagentState[]
  openCollaborationAgentIds: Set<string>
  setOpenCollaborationAgentIds: Dispatch<SetStateAction<Set<string>>>
  openCollaborationActivityIds: Set<string>
  setOpenCollaborationActivityIds: Dispatch<SetStateAction<Set<string>>>
  onFork?: () => Promise<void> | void
  showLiveActivity: boolean
}) {
  const turnRef = useRef<HTMLElement | null>(null)
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
  const userSteerItems = useMemo(
    () => resolvedProcessItems.filter(isUserSteerProcessItem),
    [resolvedProcessItems],
  )
  const hasAnyProcess = resolvedProcessItems.length > 0
  const patchResults = resolvedProcessItems.filter(isPatchResultItem)
  const userImages = turn.userImages || []
  const userAudios = turn.userAudios || []
  const userFiles = turn.userFiles || []
  const resultImages = turn.resultImages || []
  const resultAudios = turn.resultAudios || []
  const resultFiles = turn.resultFiles || []
  const [copiedItemId, setCopiedItemId] = useState('')
  const [answerCopied, setAnswerCopied] = useState(false)
  const [forking, setForking] = useState(false)
  const forkingRef = useRef(false)
  const [openProcessItemIds, setOpenProcessItemIds] = useState<Set<string>>(() => new Set())
  const [terminalOutcomeSyncFailedItemIds, setTerminalOutcomeSyncFailedItemIds] = useState<Set<string>>(() => new Set())
  const observedRunningTerminalItemIdsRef = useRef(new Set<string>())
  const refreshedTerminalOutcomeItemIdsRef = useRef(new Set<string>())
  const syncingTerminalOutcomeItemIdsRef = useRef(new Set<string>())
  const progressClock = useSharedNow(clockActive && turn.status === 'inProgress' && Boolean(turn.startedAt))
  const collaborationAgents = useMemo(
    () => acpCollaborationAgentsForTurn(resolvedProcessItems, subagentStates),
    [resolvedProcessItems, subagentStates],
  )
  const collaborationProcessItemIds = useMemo(() => new Set(
    collaborationAgents.flatMap(agent => agent.events.map(event => event.processItemId)),
  ), [collaborationAgents])
  const mainProcessItems = useMemo(
    () => resolvedProcessItems.filter(item => (
      !collaborationProcessItemIds.has(item.id)
    )),
    [collaborationProcessItemIds, resolvedProcessItems],
  )
  const mainProcessTurn = useMemo(
    () => ({ ...turn, processItems: mainProcessItems }),
    [mainProcessItems, turn],
  )
  const hasProcess = mainProcessItems.length > 0
  const processEntries = useMemo(() => (
    groupProcessActions
      ? processEntriesForTurn(mainProcessItems, source)
      : mainProcessItems.map(item => ({ kind: 'item' as const, item }))
  ), [groupProcessActions, mainProcessItems, source])
  const compactProcess = useMemo(
    () => compactProcessEntries(processEntries, turn.status, source),
    [processEntries, source, turn.status],
  )
  const runningCompaction = turn.status === 'inProgress'
    ? [...mainProcessItems]
      .reverse()
      .find(item => item.type === 'compaction' && isProcessItemRunning(item))
    : undefined
  const compactViewport = isCompactViewport()
  const answerMessage = useMemo(() => stripRawMemoryCitation(turn.finalMessage), [turn.finalMessage])
  const shouldShowWaiting = turn.status === 'inProgress'
    && !answerMessage
    && compactProcess.items.length === 0
    && collaborationAgents.length === 0
    && (
    Boolean(turn.userMessage) || userImages.length > 0 || userAudios.length > 0 || userFiles.length > 0
      || userSteerItems.length > 0 || hasAnyProcess
    )
  const progressDuration = turn.status === 'inProgress'
    ? elapsedDurationLabel(turn.startedAt, progressClock)
    : ''
  const activityTurn = resolvedProcessItems === turn.processItems
    ? turn
    : { ...turn, processItems: resolvedProcessItems }
  const workingLabel = source === 'acp' ? acpActivityLabel(activityTurn, copy) : copy.agentTranscriptWorking
  const processSummaryWorkingLabel = compactProcess.items.length > 0
    ? copy.agentTranscriptProcess
    : workingLabel
  const liveToolActivity = source === 'acp' ? acpLiveTool(activityTurn, copy) : null
  const planLabel = source === 'acp' ? acpPlanLabel(activityTurn, copy) : ''
  const thoughtLabel = source === 'acp' ? acpThoughtActivityLabel(activityTurn.processItems) : ''
  const processSummaryLabel = runningCompaction
    ? copy.agentTranscriptCompactingContext
    : turn.status === 'inProgress' && progressDuration
      ? copy.agentTranscriptWorkingFor(progressDuration)
      : turnProcessLabel(mainProcessTurn, copy, processSummaryWorkingLabel, planLabel)
  const liveActivityLabel = liveToolActivity?.label || planLabel || thoughtLabel || workingLabel
  const liveActivityKind = liveToolActivity?.kind
    || (planLabel ? 'plan' : thoughtLabel ? 'thinking' : acpActivityKind(activityTurn.processItems))
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
      const text = [
        item.title,
        presentation.detail,
        transcriptLocationsCopyText(item.locations),
      ].filter(Boolean).join('\n\n')
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
  const handleFork = useCallback(async () => {
    if (!onFork || forkingRef.current) return
    forkingRef.current = true
    setForking(true)
    try {
      await onFork()
    } finally {
      forkingRef.current = false
      setForking(false)
    }
  }, [onFork])
  const toggleProcessOpen = useCallback(() => {
    onToggleProcess(turn.id)
  }, [onToggleProcess, turn.id])
  const handleToggleProcessItem = useCallback((itemId: string) => {
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
  }, [loadFullProcessDetail, openProcessItemIds, resolvedProcessItems])
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
  const onOpenUrlInFarmingRef = useRef(onOpenUrlInFarming)
  onOpenUrlInFarmingRef.current = onOpenUrlInFarming
  // Keep the process compact while the agent works. The short activity label
  // carries the live state; full reasoning and tool details remain opt-in.
  const effectiveProcessOpen = processOpen
  const markdownComponents = useMemo<Components>(() => ({
    a: ({ href, children, onClick, ...props }) => {
      const target = href ? transcriptFileTargetFromText(href, workspaceRoot) : null
      const external = href ? isExternalTranscriptHref(href) : false
      const normalizedHref = href ? normalizeTranscriptHref(href) : href
      const browserUrl = external && normalizedHref && /^https?:/i.test(normalizedHref)
        ? normalizedHref
        : ''
      const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (target && onOpenFile) {
          event.preventDefault()
          onOpenFile(target.filePath, target.target)
          return
        }
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
          onContextMenu={event => {
            if (!browserUrl) return
            showUrlOpenMenu({
              event: event.nativeEvent,
              url: browserUrl,
              onOpenInFarming: onOpenUrlInFarmingRef.current
                ? () => onOpenUrlInFarmingRef.current?.(browserUrl)
                : undefined,
            })
          }}
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
      const source = markdownTextContent(children)
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
      const mermaidSource = mermaidCodeBlockSource(children)
      if (mermaidSource !== null) {
        return (
          <LocalErrorBoundary
            label="transcript Mermaid"
            resetKey={mermaidSource}
            fallback={(_error, retry) => (
              <figure className="code-markdown-mermaid error" aria-label={copy.mermaidDiagram}>
                <figcaption className="code-markdown-mermaid-error-title">{copy.mermaidRenderFailed}</figcaption>
                <TranscriptLocalErrorFallback
                  copy={copy}
                  message={copy.mermaidRenderFailed}
                  onRetry={retry}
                  testId="code-agent-transcript-mermaid-render-error"
                />
                <pre className="code-markdown-mermaid-fallback">
                  <code className="language-mermaid">{mermaidSource}</code>
                </pre>
              </figure>
            )}
          >
            <LocalRenderFault surface="transcript-mermaid" identity={turn.id}>
              <MermaidBlock source={mermaidSource} copy={copy} />
            </LocalRenderFault>
          </LocalErrorBoundary>
        )
      }
      return <pre {...props}>{children}</pre>
    },
  }), [copy, onOpenFile, turn.id, workspaceRoot])

  return (
    <article ref={turnRef} className={`code-agent-transcript-turn ${turn.status === 'inProgress' ? 'running' : ''}`} data-turn-id={turn.id}>
      {turn.userMessage || userImages.length > 0 || userAudios.length > 0 || userFiles.length > 0 ? (
        <div className="code-agent-transcript-user">
          {turn.userMessage ? <div>{plainTextBlock(turn.userMessage)}</div> : null}
          <AgentTranscriptUserImages images={userImages} />
          <AgentTranscriptAudios audios={userAudios} />
          <AgentTranscriptUserFiles files={userFiles} />
          <AgentTranscriptMessageTime timestamp={turn.startedAt} kind="user" />
        </div>
      ) : null}

      {hasAnyProcess ? (
        <div className={`code-agent-transcript-process ${effectiveProcessOpen ? 'expanded' : ''}`}>
          {hasProcess || collaborationAgents.length > 0 ? (
            <>
              <button
            type="button"
            className="code-agent-transcript-process-summary"
            data-testid="code-agent-transcript-process-summary"
            aria-expanded={effectiveProcessOpen}
            title={liveToolActivity?.label || turnProcessTitle(mainProcessTurn, copy)}
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
                  {processSummaryLabel}
                </span>
                <ChevronRightGlyph className="code-agent-transcript-chevron" />
              </button>
          {!effectiveProcessOpen && compactProcess.entries.length > 0 ? (
            <div
              className="code-agent-transcript-process-list code-agent-transcript-process-compact-list"
              data-testid="code-agent-transcript-process-compact-list"
            >
              {compactProcess.entries.map(entry => {
                if (entry.kind === 'group') {
                  const groupOpen = openProcessItemIds.has(entry.id)
                    || entry.items.some(item => openProcessItemIds.has(item.id))
                  return (
                    <AgentTranscriptProcessGroupView
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
                      onStopTerminal={handleStopTerminal}
                      onInputTerminal={handleInputTerminal}
                      onResizeTerminal={handleResizeTerminal}
                      terminalOutcomeSyncFailedItemIds={terminalOutcomeSyncFailedItemIds}
                      onRetryTerminalOutcome={handleRetryTerminalOutcome}
                      onStopSubagent={onStopSubagent}
                    />
                  )
                }
                const item = entry.item
                return source === 'acp' && isAcpProgressUpdate(item) ? (
                  <AgentTranscriptProgressUpdate
                    key={item.id}
                    item={item}
                    markdownComponents={markdownComponents}
                    copy={copy}
                  />
                ) : (
                  <SafeAgentTranscriptProcessItemView
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
                )
              })}
            </div>
          ) : null}
              {effectiveProcessOpen && hasProcess ? (
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
                      openProcessItemIds={openProcessItemIds}
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
                      copy={copy}
                    />
                  )
                }
                return (
                  <SafeAgentTranscriptProcessItemView
                    key={entry.item.id}
                    item={entry.item}
                    copy={copy}
                    copied={copiedItemId === entry.item.id}
                    detailOpen={openProcessItemIds.has(entry.item.id)}
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
            {source === 'acp' && collaborationAgents.length > 0 ? (
              <AgentTranscriptCollaborationSpace
                agents={collaborationAgents}
                processItems={resolvedProcessItems}
                copy={copy}
                disclosureScope={turn.id}
                openAgentIds={openCollaborationAgentIds}
                setOpenAgentIds={setOpenCollaborationAgentIds}
                openActivityIds={openCollaborationActivityIds}
                setOpenActivityIds={setOpenCollaborationActivityIds}
                onLoadProcessItemDetail={onLoadProcessItemDetail}
                onStopTerminal={onStopTerminal}
                onInputTerminal={onInputTerminal}
                onResizeTerminal={onResizeTerminal}
                onStopSubagent={onStopSubagent}
              />
            ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {answerMessage || resultImages.length > 0 || resultAudios.length > 0 || resultFiles.length > 0 ? (
        <div className="code-agent-transcript-answer">
          {answerMessage ? (
            <div className="code-agent-transcript-assistant code-markdown-preview">
              <LocalErrorBoundary
                label="transcript answer Markdown"
                resetKey={answerMessage}
                fallback={(_error, retry) => (
                  <>
                    <TranscriptLocalErrorFallback
                      copy={copy}
                      onRetry={retry}
                      testId="code-agent-transcript-markdown-render-error"
                    />
                    <pre>{answerMessage}</pre>
                  </>
                )}
              >
                <LocalRenderFault surface="transcript-markdown" identity={turn.id}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex, rehypeHighlight]}
                    components={markdownComponents}
                    skipHtml
                    urlTransform={agentTranscriptUrlTransform}
                  >
                    {answerMessage}
                  </ReactMarkdown>
                </LocalRenderFault>
              </LocalErrorBoundary>
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
            {onFork ? (
              <button
                type="button"
                className="code-agent-transcript-answer-action code-agent-transcript-fork-action"
                data-testid="code-agent-transcript-fork"
                aria-label={copy.agentTranscriptFork}
                title={copy.agentTranscriptFork}
                data-tooltip={copy.agentTranscriptFork}
                disabled={forking}
                onClick={handleFork}
              >
                <ForkGlyph />
              </button>
            ) : null}
            <AgentTranscriptMessageTime timestamp={turn.completedAt} kind="answer" />
          </div> : null}
        </div>
      ) : shouldShowWaiting && !showLiveActivity ? (
        <div className="code-agent-transcript-placeholder">{copy.agentTranscriptWaiting}</div>
      ) : null}

      {patchResults.length > 0 ? (
        <div className="code-agent-transcript-results code-agent-transcript-status-row">
          <AgentTranscriptPatchResultCard
            items={patchResults}
            copy={copy}
            onLoadPatchChanges={onLoadPatchChanges}
            source={source}
            workspaceRoot={workspaceRoot}
            gitDiffTarget={gitDiffTarget}
          />
        </div>
      ) : null}

      {showLiveActivity ? (
        <div
          className="code-agent-transcript-live-activity"
          data-testid="code-agent-transcript-live-activity"
          role="status"
          aria-live="polite"
        >
          <AgentTranscriptLiveActivityIcon kind={liveActivityKind} />
          <span>{liveActivityLabel}</span>
        </div>
      ) : null}
    </article>
  )
}

const StableAgentTranscriptTurnView = memo(AgentTranscriptTurnView)

function transcriptTurnResetKey(turn: AgentTranscriptTurn) {
  return [
    turn.id,
    turn.status,
    String(turn.userMessage.length),
    String(turn.finalMessage.length),
    String(turn.completedAt || ''),
    turn.processItems.map(item => `${item.id}:${item.status || ''}:${item.detail?.length || 0}`).join('\u0001'),
  ].join('\u0000')
}

export function AgentTranscriptPane({
  agentId,
  workspaceRoot,
  active,
  viewportLayoutKey = '',
  source,
  refreshSignal = 0,
  runtimeState = '',
  expectHistory = false,
  forkedFromAgent = false,
  onOpenWorkspaceFilePath,
  onOpenUrlInFarming,
  onAvailabilityChange,
  onReadLatest,
  onForkLatest,
  groupProcessActions = true,
  copy,
}: AgentTranscriptPaneProps) {
  const [transcript, setTranscript] = useState<AgentTranscript | null>(null)
  const transcriptRef = useRef<AgentTranscript | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openProcessTurnIds, setOpenProcessTurnIds] = useState<Set<string>>(() => new Set())
  const [openLiveProcessTurnIds, setOpenLiveProcessTurnIds] = useState<Set<string>>(() => new Set())
  const [openCollaborationAgentIds, setOpenCollaborationAgentIds] = useState<Set<string>>(() => new Set())
  const [openCollaborationActivityIds, setOpenCollaborationActivityIds] = useState<Set<string>>(() => new Set())
  const [turnLimit, setTurnLimit] = useState(() => initialTranscriptTurnLimit(source))
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const [gitDiffState, setGitDiffState] = useState<{
    owner: string
    target: TranscriptGitDiffTarget
  }>({ owner: '', target: unavailableTranscriptGitDiffTarget })
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
      const element = scrollRef.current
      if (
        !element
        || !followBottomRef.current
        || textSelectionGestureRef.current
        || hasTextSelectionWithin(element)
      ) return
      element.scrollTop = element.scrollHeight
      clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
      setShowJumpToBottom(false)
    }, 420)
  }, [agentId])

  useLayoutEffect(() => {
    openWorkspaceFilePathRef.current = onOpenWorkspaceFilePath
  }, [onOpenWorkspaceFilePath])

  useLayoutEffect(() => {
    const layoutChanged = previousViewportLayoutKeyRef.current !== viewportLayoutKey
    previousViewportLayoutKeyRef.current = viewportLayoutKey
    if (!layoutChanged || !active || !isPageActive() || !followBottomRef.current) return
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
    setOpenCollaborationAgentIds(new Set())
    setOpenCollaborationActivityIds(new Set())
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
      if (userScrollGestureRef.current) finishUserScrollGesture()
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
  }, [active, finishUserScrollGesture])

  useEffect(() => {
    if (!active) return undefined

    let stopped = false
    let pollTimer: number | null = null
    let retryTimer: number | null = null
    let retryAttempt = 0
    let controller: AbortController | null = null
    let needsReconnectReload = false
    let requestGeneration = 0

    const load = () => {
      const generation = ++requestGeneration
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
        retryTimer = null
      }
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
      if (source === 'acp') {
        params.set('media', 'external-v1')
      }
      const endpoint = 'acp-transcript'
      let responseReceived = false
      fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/${endpoint}?${params.toString()}`), {
        signal: controller.signal,
      })
        .then(response => {
          responseReceived = true
          if (!response.ok) throw new Error(copy.agentTranscriptUnavailable)
          return response.json()
        })
        .then(payload => {
          if (stopped || generation !== requestGeneration) return
          retryAttempt = 0
          needsReconnectReload = false
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
          if (stopped || generation !== requestGeneration || reason?.name === 'AbortError') return
          const retryDelay = source === 'acp' && !responseReceived && reason instanceof TypeError
            ? ACP_TRANSCRIPT_FETCH_RETRY_DELAYS_MS[retryAttempt]
            : undefined
          if (retryDelay !== undefined) {
            retryAttempt += 1
            retryTimer = window.setTimeout(load, retryDelay)
            return
          }
          retryAttempt = 0
          needsReconnectReload = source === 'acp' && !responseReceived && reason instanceof TypeError
          setError(transcriptRef.current?.available ? '' : copy.agentTranscriptUnavailable)
          setLoading(false)
          setLoadingOlder(false)
        })
    }

    const handleBackendDisconnected = () => {
      needsReconnectReload = true
    }
    const handleBackendConnected = () => {
      if (!needsReconnectReload) return
      needsReconnectReload = false
      load()
    }

    load()
    // A bounded transport retry can legitimately finish before a deploy or
    // backend restart has completed. The shared socket reconnect is the
    // authoritative signal that reads are available again, so retry this
    // read-only projection once on that transition instead of polling or
    // leaving a stale transport error on screen.
    window.addEventListener('farming:backend-disconnected', handleBackendDisconnected)
    window.addEventListener('farming:backend-connected', handleBackendConnected)
    // ACP entry updates already advance refreshSignal through the shared state
    // websocket. Re-fetching a complete, idle history every three seconds is
    // especially expensive for long sessions with many tool details.
    if (source !== 'acp') pollTimer = window.setInterval(load, 3000)

    return () => {
      stopped = true
      window.removeEventListener('farming:backend-disconnected', handleBackendDisconnected)
      window.removeEventListener('farming:backend-connected', handleBackendConnected)
      controller?.abort()
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      if (pollTimer !== null) window.clearInterval(pollTimer)
    }
  }, [active, agentId, copy.agentTranscriptUnavailable, refreshSignal, source, turnLimit])

  const turns = useMemo(() => transcript?.turns || [], [transcript])
  const latestTurn = turns[turns.length - 1]
  const latestProcessItem = latestTurn?.processItems[latestTurn.processItems.length - 1]
  const gitDiffRefreshKey = [
    latestTurn?.id || '',
    latestTurn?.status || '',
    latestTurn?.completedAt || '',
    latestProcessItem?.id || '',
    latestProcessItem?.status || '',
  ].join('\0')
  const gitDiffOwner = `${agentId}\0${workspaceRoot || ''}`
  const gitDiffTarget = gitDiffState.owner === gitDiffOwner
    ? gitDiffState.target
    : unavailableTranscriptGitDiffTarget
  const awaitingAcpHistory = source === 'acp'
    && !error
    && turns.length === 0
    && (runtimeState === 'connecting' || expectHistory)
  useEffect(() => {
    if (!active || !isPageActive() || !transcript?.available || turns.length === 0) return
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
      element.scrollTop = element.scrollHeight
      clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
      setShowJumpToBottom(false)
      window.requestAnimationFrame(() => {
        if (
          !followBottomRef.current
          || userScrollGestureRef.current
          || textSelectionGestureRef.current
          || hasTextSelectionWithin(element)
        ) return
        element.scrollTop = element.scrollHeight
        clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
        setShowJumpToBottom(false)
        if (active && isPageActive()) onReadLatest?.()
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
      if (active && isPageActive()) onReadLatest?.()
    })
  }, [active, agentId, loading, onReadLatest, transcript?.available, transcript?.updatedAt, turns.length])

  useLayoutEffect(() => {
    if (!active || !transcript?.available || turns.length === 0 || typeof ResizeObserver === 'undefined') {
      return undefined
    }
    const element = scrollRef.current
    if (!element) return undefined
    const observer = new ResizeObserver(() => {
      if (
        !followBottomRef.current
        || userScrollGestureRef.current
        || textSelectionGestureRef.current
        || hasTextSelectionWithin(element)
      ) return
      element.scrollTop = element.scrollHeight
      clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
      setShowJumpToBottom(false)
    })
    element.querySelectorAll<HTMLElement>('.code-agent-transcript-turn').forEach(turn => observer.observe(turn))
    return () => observer.disconnect()
  }, [active, agentId, transcript?.available, turns])

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
  const transcriptFileOpenContext = useMemo(() => ({
    agentId,
    workspaceRoot,
    onOpenFile: onOpenWorkspaceFilePath ? handleOpenFile : undefined,
  }), [agentId, handleOpenFile, onOpenWorkspaceFilePath, workspaceRoot])
  useEffect(() => {
    if (!active || !workspaceRoot) return undefined
    let cancelled = false
    void fetch(appPath(`/api/files/worktrees?agentId=${encodeURIComponent(agentId)}`))
      .then(response => response.ok ? response.json() : null)
      .then(async value => {
        if (cancelled) return
        if (value?.worktrees?.isGitRepo !== true) {
          setGitDiffState({ owner: gitDiffOwner, target: unavailableTranscriptGitDiffTarget })
          return
        }
        let target = workingCopyTranscriptGitDiffTarget
        try {
          target = transcriptGitDiffTargetForRepository(
            await loadReviewComparisonSources({ root: workspaceRoot }),
          )
        } catch {
          // A repository without HEAD, or a transient comparison-source failure,
          // still supports the existing working-copy review path.
        }
        if (!cancelled) setGitDiffState({ owner: gitDiffOwner, target })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [active, agentId, gitDiffOwner, gitDiffRefreshKey, workspaceRoot])
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
    if (nearBottom) followBottomRef.current = true
    else if (userScrollGestureRef.current) followBottomRef.current = false
    if (followBottomRef.current) clearReadingAnchor(readingAnchorAgentKey(agentId, 'chat'))
    else saveTranscriptReadingAnchor(agentId, element)
    setShowJumpToBottom(
      !followBottomRef.current
      && element.scrollHeight > element.clientHeight + TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD,
    )
    if (active && nearBottom && isPageActive()) onReadLatest?.()
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
    markUserScrollGesture()
    // Pointer down starts before Selection becomes non-collapsed. Lock now so
    // an ACP refresh cannot jump to the bottom during that first drag frame.
    textSelectionGestureRef.current = true
  }, [markUserScrollGesture])
  const sessionPlan = source === 'acp' ? transcript?.plan : undefined
  const activePlan = turns[turns.length - 1]?.status === 'inProgress'
    && sessionPlan?.status !== 'completed'
    ? sessionPlan
    : undefined
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
    <TranscriptFileOpenContext.Provider value={transcriptFileOpenContext}>
      <div
        className={`code-agent-transcript ${activePlan ? 'has-plan-driver' : ''}`}
        data-testid="code-agent-transcript"
      >
      {forkedFromAgent ? (
        <div className="code-agent-transcript-fork-origin" data-testid="code-agent-transcript-fork-origin" role="note">
          <span aria-hidden="true" />
          <span className="code-agent-transcript-fork-origin-label">
            <ForkGlyph />
            {copy.agentTranscriptForkedFromAgent}
          </span>
          <span aria-hidden="true" />
        </div>
      ) : null}
      {activePlan ? (
        <AgentTranscriptPlanDriver plan={activePlan} />
      ) : null}
      {loading || awaitingAcpHistory ? (
        <div className="code-agent-transcript-state subtle">
          {runtimeState === 'connecting' && !expectHistory
            ? copy.agentChatStarting
            : copy.agentTranscriptSyncing}
        </div>
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
          {turns.map((turn, index) => {
            const processOpen = source === 'acp'
              ? turn.status === 'inProgress'
                ? openLiveProcessTurnIds.has(turn.id)
                : openProcessTurnIds.has(turn.id)
              : openProcessTurnIds.has(turn.id)
            return (
              <LocalErrorBoundary
                key={turn.id}
                label="transcript turn"
                resetKey={transcriptTurnResetKey(turn)}
                fallback={(_error, retry) => (
                  <article className="code-agent-transcript-turn" data-turn-id={turn.id}>
                    <TranscriptLocalErrorFallback
                      copy={copy}
                      onRetry={retry}
                      testId="code-agent-transcript-turn-render-error"
                    />
                  </article>
                )}
              >
                <LocalRenderFault surface="transcript-turn" identity={turn.id}>
                  <StableAgentTranscriptTurnView
                    turn={turn}
                    copy={copy}
                    onOpenFile={onOpenWorkspaceFilePath ? handleOpenFile : undefined}
                    onOpenUrlInFarming={onOpenUrlInFarming}
                    workspaceRoot={workspaceRoot}
                    clockActive={active}
                    processOpen={processOpen}
                    groupProcessActions={groupProcessActions}
                    source={source}
                    onToggleProcess={handleToggleProcess}
                    onLoadProcessItemDetail={source === 'acp' ? handleLoadProcessItemDetail : undefined}
                    onLoadPatchChanges={source === 'acp' ? handleLoadPatchChanges : undefined}
                    gitDiffTarget={gitDiffTarget}
                    onStopTerminal={source === 'acp' ? handleStopTerminal : undefined}
                    onInputTerminal={source === 'acp' ? handleInputTerminal : undefined}
                    onResizeTerminal={source === 'acp' ? handleResizeTerminal : undefined}
                    onStopSubagent={source === 'acp' ? handleStopSubagent : undefined}
                    subagentStates={transcript?.codexSubagents?.agents || []}
                    openCollaborationAgentIds={openCollaborationAgentIds}
                    setOpenCollaborationAgentIds={setOpenCollaborationAgentIds}
                    openCollaborationActivityIds={openCollaborationActivityIds}
                    setOpenCollaborationActivityIds={setOpenCollaborationActivityIds}
                    showLiveActivity={
                      source === 'acp'
                      && index === turns.length - 1
                      && turn.status === 'inProgress'
                      && transcript?.state === 'working'
                    }
                    onFork={index === turns.length - 1 && turn.status !== 'inProgress' ? onForkLatest : undefined}
                  />
                </LocalRenderFault>
              </LocalErrorBoundary>
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
    </TranscriptFileOpenContext.Provider>
  )
}
