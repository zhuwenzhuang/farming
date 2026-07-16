import { createTwoFilesPatch, diffLines } from 'diff'

const MAX_RENDERED_DIFF_CHARS = 64 * 1024
const MAX_INLINE_TOOL_DETAIL_CHARS = 4 * 1024

type AcpRecord = Record<string, unknown>

export interface CodexTranscriptAudio {
  id: string
  url: string
  mimeType?: string
  name?: string
}

export interface CodexTranscriptTerminal {
  terminalId: string
  terminal?: {
    command?: string
    args?: string[]
    cwd?: string
    output?: string
    truncated?: boolean
    exitStatus?: { exitCode?: number | null; signal?: string | null } | null
    released?: boolean
    startedAt?: number
    endedAt?: number | null
    durationMs?: number
    interactive?: boolean
  }
}

export interface CodexTranscriptPatchChange {
  path: string
  kind: string
  added: number
  removed: number
  diff?: string
  decision?: string
}

export interface CodexTranscriptUserImage {
  id: string
  url: string
  alt?: string
}

export interface CodexTranscriptUserFile {
  id: string
  name: string
  content?: string
  error?: string
  truncated?: boolean
  uri?: string
  mimeType?: string
  resourceKind?: string
}

export interface CodexTranscriptProcessItem {
  id: string
  type: string
  title: string
  detail?: string
  images?: CodexTranscriptUserImage[]
  audios?: CodexTranscriptAudio[]
  files?: CodexTranscriptUserFile[]
  status?: string
  kind?: string
  completedSteps?: number
  totalSteps?: number
  currentStep?: string
  detailTruncated?: boolean
  changes?: CodexTranscriptPatchChange[]
  terminalIds?: string[]
  terminals?: CodexTranscriptTerminal[]
  subagentSessionId?: string
  subagentTranscript?: CodexTranscript
}

export interface CodexTranscriptTurn {
  id: string
  userMessage: string
  userImages?: CodexTranscriptUserImage[]
  userFiles?: CodexTranscriptUserFile[]
  userAudios?: CodexTranscriptAudio[]
  resultImages?: CodexTranscriptUserImage[]
  resultFiles?: CodexTranscriptUserFile[]
  resultAudios?: CodexTranscriptAudio[]
  finalMessage: string
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  status: 'inProgress' | 'completed' | 'interrupted' | string
  processItems: CodexTranscriptProcessItem[]
}

export interface CodexTranscript {
  version?: number
  available: boolean
  reason?: string
  sessionId: string
  title?: string
  updatedAt?: string
  source?: string
  state?: string
  error?: string
  errorKind?: string
  hasMoreBefore?: boolean
  turnLimit?: number
  revision?: number
  delta?: boolean
  replaceFromTurnId?: string
  stopReason?: string
  truncated?: boolean
  turns: CodexTranscriptTurn[]
}

interface MutableTurn extends CodexTranscriptTurn {
  internal: boolean
  assistantMessages: Array<{ text: string; processItemId: string; phase: string }>
  userImages: CodexTranscriptUserImage[]
  userFiles: CodexTranscriptUserFile[]
  userAudios: CodexTranscriptAudio[]
  resultImages: CodexTranscriptUserImage[]
  resultFiles: CodexTranscriptUserFile[]
  resultAudios: CodexTranscriptAudio[]
}

function record(value: unknown): AcpRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AcpRecord
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function contentText(content: unknown) {
  return list(content)
    .map(record)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
    .trim()
}

function visibleAssistantText(text: string) {
  return text
    .replace(/\s*\*?Context compacted(?: to fit the model's context window)?\.\*?\s*/gi, '')
    .trim()
}

function codexMessagePhase(entry: AcpRecord) {
  return stringValue(record(record(entry._meta).codex).phase).trim().toLowerCase()
}

function diffBlocks(content: unknown) {
  return list(content)
    .map(record)
    .filter(block => block.type === 'diff' && typeof block.path === 'string' && block.path.trim())
}

function diffAction(block: AcpRecord) {
  const kind = stringValue(record(block._meta).kind).trim().toLowerCase()
  if (['add', 'added', 'create', 'created'].includes(kind)) return 'Added'
  if (['delete', 'deleted', 'remove', 'removed'].includes(kind)) return 'Deleted'
  if (['move', 'moved'].includes(kind)) return 'Moved'
  if (['rename', 'renamed'].includes(kind)) return 'Renamed'
  return 'Updated'
}

function boundedDiffText(value: unknown) {
  const text = stringValue(value)
  if (text.length <= MAX_RENDERED_DIFF_CHARS) return text
  return `${text.slice(0, MAX_RENDERED_DIFF_CHARS)}\n\n[Diff detail truncated]`
}

function renderedDiffText(block: AcpRecord) {
  const path = stringValue(block.path).trim()
  const oldText = stringValue(block.oldText)
  const newText = stringValue(block.newText)
  const patch = createTwoFilesPatch(path, path, oldText, newText, 'before', 'after', { context: 3 })
  return `File: ${path}\n${boundedDiffText(patch)}`.trim()
}

function patchSummaryText(content: unknown) {
  return diffBlocks(content)
    .map(block => `${diffAction(block)} ${stringValue(block.path).trim()}`)
    .join('\n')
}

function patchLineStats(oldText: string, newText: string) {
  return diffLines(oldText, newText).reduce((stats, part) => {
    const count = Number(part.count || 0)
    if (part.added) stats.added += count
    if (part.removed) stats.removed += count
    return stats
  }, { added: 0, removed: 0 })
}

function patchChanges(content: unknown, decisions: AcpRecord = {}): CodexTranscriptPatchChange[] {
  return diffBlocks(content).map(block => {
    const path = stringValue(block.path).trim()
    const stats = patchLineStats(stringValue(block.oldText), stringValue(block.newText))
    return {
      path,
      kind: diffAction(block).toLowerCase(),
      added: stats.added,
      removed: stats.removed,
      ...(stringValue(decisions[path]) ? { decision: stringValue(decisions[path]) } : {}),
    }
  })
}

function jsonText(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toolContentText(content: unknown) {
  return list(content).map(value => {
    const block = record(value)
    if (block.type === 'content') {
      const inner = record(block.content)
      if (inner.type === 'text') return stringValue(inner.text)
      if (inner.type === 'resource_link') return [inner.name, inner.uri].filter(Boolean).join(' — ')
      if (inner.type === 'resource') return jsonText(inner.resource)
      if (inner.type === 'image') return `[Image: ${stringValue(inner.mimeType) || 'image'}]`
      if (inner.type === 'audio') return `[Audio: ${stringValue(inner.mimeType) || 'audio'}]`
      return jsonText(inner)
    }
    if (block.type === 'diff') return renderedDiffText(block)
    if (block.type === 'text') return stringValue(block.text)
    if (block.type === 'image' || block.type === 'audio') return ''
    if (block.type === 'resource_link') return [block.name, block.uri].map(stringValue).filter(Boolean).join(' — ')
    if (block.type === 'resource') return jsonText(block.resource)
    return jsonText(block)
  }).filter(Boolean).join('\n\n').trim()
}

function rawToolResultContent(entry: AcpRecord) {
  const output = record(entry.rawOutput)
  const result = record(output.result)
  if (Array.isArray(result.content)) return result.content
  if (Array.isArray(output.content)) return output.content
  return []
}

function sanitizeToolResultText(text: string) {
  return text
    .replace(/<app_specific_instructions>[\s\S]*?<\/app_specific_instructions>\s*/gi, '')
    .trim()
}

function uniqueByUrl<T extends { url: string }>(items: T[]) {
  const seen = new Set<string>()
  return items.filter(item => {
    if (!item.url || seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
}

function contentImages(content: unknown, prefix: string): CodexTranscriptUserImage[] {
  return list(content).map(record)
    .filter(block => block.type === 'image' && typeof block.data === 'string' && block.data)
    .map((block, index) => ({
      id: `${prefix}-image-${index + 1}`,
      url: `data:${stringValue(block.mimeType) || 'image/png'};base64,${block.data as string}`,
      alt: 'Image',
    }))
}

function contentAudios(content: unknown, prefix: string): CodexTranscriptAudio[] {
  return list(content).map(record)
    .filter(block => block.type === 'audio' && typeof block.data === 'string' && block.data)
    .map((block, index) => ({
      id: `${prefix}-audio-${index + 1}`,
      url: `data:${stringValue(block.mimeType) || 'audio/mpeg'};base64,${block.data as string}`,
      mimeType: stringValue(block.mimeType) || 'audio/mpeg',
      name: stringValue(block.name) || `Audio ${index + 1}`,
    }))
}

function contentFiles(content: unknown, prefix: string): CodexTranscriptUserFile[] {
  return list(content).flatMap((value, index) => {
    const block = record(value)
    if (block.type === 'resource_link') {
      return [{
        id: `${prefix}-resource-link-${index + 1}`,
        name: stringValue(block.name || block.uri) || 'Resource',
        content: stringValue(block.uri),
        uri: stringValue(block.uri),
        mimeType: stringValue(block.mimeType),
        resourceKind: 'link',
      }]
    }
    if (block.type !== 'resource' || !block.resource) return []
    const resource = record(block.resource)
    return [{
      id: `${prefix}-resource-${index + 1}`,
      name: stringValue(resource.name || resource.uri) || 'Resource',
      content: stringValue(resource.text || resource.uri),
      uri: stringValue(resource.uri),
      mimeType: stringValue(resource.mimeType),
      resourceKind: resource.blob ? 'blob' : 'embedded',
      ...(resource.blob ? { error: `[Binary resource: ${stringValue(resource.mimeType) || 'application/octet-stream'}]` } : {}),
    }]
  })
}

function equivalentJsonText(text: string, value: unknown) {
  const candidate = text.trim()
  if (!candidate || value === undefined || value === null) return false
  if (candidate === jsonText(value).trim()) return true
  try {
    return JSON.stringify(JSON.parse(candidate)) === JSON.stringify(value)
  } catch {
    return false
  }
}

function toolOutputText(entry: AcpRecord) {
  const output = entry.rawOutput
  if (stringValue(entry.kind).toLowerCase() === 'execute' && output && typeof output === 'object' && !Array.isArray(output)) {
    const outputRecord = record(output)
    const stdout = typeof outputRecord.stdout === 'string' ? outputRecord.stdout.trimEnd() : ''
    const stderr = typeof outputRecord.stderr === 'string' ? outputRecord.stderr.trimEnd() : ''
    const sections: string[] = []
    if (stdout) sections.push(stdout)
    if (stderr) sections.push(`stderr\n${stderr}`)
    if (outputRecord.interrupted === true) sections.push('Interrupted')
    if (sections.length > 0) return sections.join('\n\n')
  }
  const rawContent = rawToolResultContent(entry)
  if (rawContent.length > 0) {
    const content = sanitizeToolResultText(toolContentText(rawContent))
    const error = record(output).error
    return [content, error ? `Error\n${jsonText(error)}` : ''].filter(Boolean).join('\n\n')
  }
  return jsonText(output).trim()
}

function detailForTool(entry: AcpRecord) {
  const sections: string[] = []
  const rawInput = jsonText(entry.rawInput).trim()
  let structuredContent = toolContentText(list(entry.content).filter(value => record(value).type !== 'terminal'))
  const rawOutput = toolOutputText(entry)
  if (equivalentJsonText(structuredContent, entry.rawOutput)) structuredContent = ''
  const locations = list(entry.locations).map(value => {
    const location = record(value)
    const path = stringValue(location.path || location.uri)
    const line = location.line == null ? '' : `:${stringValue(location.line)}`
    return `${path}${line}`
  }).filter(Boolean).join('\n')
  if (rawInput) sections.push(`Input\n${rawInput}`)
  if (structuredContent) sections.push(structuredContent)
  if (rawOutput) sections.push(`Output\n${rawOutput}`)
  if (locations) sections.push(`Locations\n${locations}`)
  return sections.join('\n\n')
}

function boundedInlineDetail(detail: string) {
  if (detail.length <= MAX_INLINE_TOOL_DETAIL_CHARS) return { detail, detailTruncated: false }
  return {
    detail: `${detail.slice(0, MAX_INLINE_TOOL_DETAIL_CHARS)}\n\n[Open to load full detail]`,
    detailTruncated: true,
  }
}

function planDetail(planValue: unknown) {
  const plan = record(planValue)
  const entries = list(plan.entries).map(record)
  if (entries.length > 0) {
    return entries.map(entry => `${stringValue(entry.status) || 'pending'}: ${stringValue(entry.content || entry.title)}`).join('\n')
  }
  if (plan.type === 'markdown') return stringValue(plan.content)
  if (plan.type === 'file') return stringValue(plan.uri)
  return ''
}

function errorTitle(kind: string) {
  if (kind === 'authentication') return 'Authentication required'
  if (kind === 'payment') return 'Billing problem'
  if (kind === 'context') return 'Context limit reached'
  if (kind === 'model') return 'Model unavailable'
  if (kind === 'rate-limit') return 'Rate limit reached'
  if (kind === 'network') return 'Connection problem'
  if (kind === 'protocol') return 'ACP protocol error'
  return 'Agent error'
}

function processEntry(entry: AcpRecord): CodexTranscriptProcessItem | null {
  if (entry.type === 'error') {
    const kind = stringValue(entry.kind) || 'unknown'
    return { id: stringValue(entry.id), type: 'error', kind, title: errorTitle(kind), detail: stringValue(entry.message), status: 'failed' }
  }
  if (entry.type === 'thought') {
    const detail = contentText(entry.content)
    return detail ? { id: stringValue(entry.id), type: 'thought', title: 'Reasoning', detail, status: 'completed' } : null
  }
  if (entry.type === 'tool') {
    const subagent = record(record(entry._meta).subagent_session_info)
    const terminalIds = list(entry.content).map(record)
      .filter(block => block.type === 'terminal' && block.terminalId)
      .map(block => stringValue(block.terminalId))
    const richContent = list(entry.content).map(record)
      .filter(block => block.type === 'content' && block.content)
      .map(block => block.content)
    const rawContent = rawToolResultContent(entry)
    const mediaContent = [...richContent, ...rawContent]
    const prefix = stringValue(entry.id) || 'tool'
    const images = uniqueByUrl(contentImages(mediaContent, prefix))
    const audios = uniqueByUrl(contentAudios(mediaContent, prefix))
    const files = contentFiles(mediaContent, prefix)
    const patchSummary = patchSummaryText(entry.content)
    const changes = patchChanges(entry.content, record(record(entry._meta).farming_patch_decisions))
    const inline = boundedInlineDetail([patchSummary, detailForTool(entry)].filter(Boolean).join('\n\n'))
    const subagentSessionId = stringValue(subagent.session_id)
    return {
      id: stringValue(entry.id),
      type: subagentSessionId ? 'subagent' : patchSummary ? 'patch' : 'tool',
      kind: stringValue(entry.kind) || 'other',
      title: stringValue(entry.title) || 'Tool',
      detail: [subagentSessionId ? `Session ${subagentSessionId}` : '', inline.detail].filter(Boolean).join('\n\n'),
      detailTruncated: inline.detailTruncated,
      status: stringValue(entry.status),
      ...(terminalIds.length > 0 ? { terminalIds } : {}),
      ...(subagentSessionId ? { subagentSessionId } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(audios.length > 0 ? { audios } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(changes.length > 0 ? { changes } : {}),
    }
  }
  if (entry.type === 'plan') {
    const detail = planDetail(entry.plan)
    if (!detail) return null
    const items = list(record(entry.plan).entries).map(record)
    const completedSteps = items.filter(item => item.status === 'completed').length
    const currentStep = items.find(item => ['in_progress', 'running'].includes(stringValue(item.status)))
    return {
      id: stringValue(entry.id), type: 'plan', title: 'Plan', detail,
      status: items.length > 0 && items.every(item => item.status === 'completed') ? 'completed' : 'running',
      completedSteps, totalSteps: items.length, currentStep: stringValue(currentStep?.content || currentStep?.title),
    }
  }
  if (entry.type === 'compaction') {
    return {
      id: stringValue(entry.id), type: 'compaction',
      title: entry.status === 'completed' ? 'Context compacted' : 'Compacting context',
      detail: stringValue(entry.summary), status: stringValue(entry.status) || 'completed',
    }
  }
  return null
}

function isGeneratedMediaTool(entry: AcpRecord) {
  if (entry.type !== 'tool') return false
  const title = stringValue(entry.title).trim().toLowerCase()
  const id = stringValue(entry.id).trim().toLowerCase()
  const output = record(entry.rawOutput)
  return id.startsWith('ig_')
    || title === 'image generation'
    || title === 'audio generation'
    || Boolean(stringValue(output.savedPath).includes('/generated_images/'))
}

function emptyTurn(id: string, internal: boolean): MutableTurn {
  return {
    id, internal, userMessage: '', userImages: [], userFiles: [], userAudios: [],
    resultImages: [], resultFiles: [], resultAudios: [], finalMessage: '',
    startedAt: null, completedAt: null, durationMs: null, status: 'completed', processItems: [], assistantMessages: [],
  }
}

function finishTurn(turn: MutableTurn | null, keepTailAsProgress: boolean): CodexTranscriptTurn | null {
  if (!turn) return null
  const lastAssistant = turn.assistantMessages[turn.assistantMessages.length - 1]
  const lastProcess = turn.processItems[turn.processItems.length - 1]
  if (turn.internal && lastAssistant?.text) {
    turn.finalMessage = lastAssistant.text
  } else if (!turn.finalMessage && !keepTailAsProgress && lastAssistant?.text && lastAssistant.processItemId
    && lastAssistant.phase !== 'commentary'
    && lastProcess?.id === lastAssistant.processItemId
    && (lastProcess.images || []).length === 0 && (lastProcess.audios || []).length === 0 && (lastProcess.files || []).length === 0) {
    turn.finalMessage = lastAssistant.text
    turn.processItems.pop()
  }
  const { internal, assistantMessages, ...finished } = turn
  if (internal) finished.processItems = []
  return finished.userMessage || finished.finalMessage || finished.userImages.length > 0
    || finished.userAudios.length > 0 || finished.userFiles.length > 0
    || finished.resultImages.length > 0 || finished.resultAudios.length > 0 || finished.resultFiles.length > 0
    || finished.processItems.length > 0
    ? finished
    : null
}

export function projectAcpTranscript(sessionValue: unknown, options: { maxTurns?: number } = {}): CodexTranscript {
  const session = record(sessionValue)
  const turns: CodexTranscriptTurn[] = []
  let current: MutableTurn | null = null
  let sequence = 0
  const activeSession = ['working', 'waiting-for-permission', 'waiting-for-input', 'interrupting'].includes(stringValue(session.state))
  const flush = (keepTailAsProgress = false) => {
    const finished = finishTurn(current, keepTailAsProgress)
    if (finished) turns.push(finished)
    current = null
  }
  for (const value of list(session.entries)) {
    const entry = record(value)
    if (entry.type === 'message' && entry.role === 'user') {
      flush()
      const entryId = stringValue(entry.id) || String(++sequence)
      current = emptyTurn(`acp-turn-${entryId}`, entry.internal === true)
      current.startedAt = entry.turnStartedAt == null ? null : Number(entry.turnStartedAt)
      current.completedAt = entry.turnCompletedAt == null ? null : Number(entry.turnCompletedAt)
      current.durationMs = Number.isFinite(Number(entry.turnDurationMs)) ? Number(entry.turnDurationMs) : null
      if (!entry.internal) {
        current.userMessage = contentText(entry.content)
        current.userImages = contentImages(entry.content, entryId)
        current.userAudios = contentAudios(entry.content, entryId)
        current.userFiles = contentFiles(entry.content, entryId)
      }
      continue
    }
    if (!current) current = emptyTurn(`acp-segment-${++sequence}`, entry.internal === true)
    if (entry.internal === true && !current.internal) {
      flush()
      current = emptyTurn(`acp-segment-${++sequence}`, true)
    }
    if (entry.type === 'message' && entry.role === 'assistant') {
      const text = visibleAssistantText(contentText(entry.content))
      const phase = codexMessagePhase(entry)
      const prefix = stringValue(entry.id) || 'assistant'
      const images = contentImages(entry.content, prefix)
      const audios = contentAudios(entry.content, prefix)
      const files = contentFiles(entry.content, prefix)
      if (phase === 'final_answer' && text) {
        current.finalMessage = text
        continue
      }
      const processItemId = text ? `acp-progress-${stringValue(entry.id) || String(++sequence)}` : ''
      current.assistantMessages.push({ text, processItemId, phase })
      if (!current.internal && (text || images.length > 0 || audios.length > 0 || files.length > 0)) {
        current.processItems.push({
          id: processItemId, type: 'progress', title: 'Progress update', detail: text, status: 'completed',
          ...(images.length > 0 ? { images } : {}), ...(audios.length > 0 ? { audios } : {}), ...(files.length > 0 ? { files } : {}),
        })
      }
      continue
    }
    if (current.internal || entry.internal === true) continue
    const process = processEntry(entry)
    if (process && isGeneratedMediaTool(entry)) {
      current.resultImages = uniqueByUrl([...current.resultImages, ...(process.images || [])])
      current.resultAudios = uniqueByUrl([...current.resultAudios, ...(process.audios || [])])
      current.resultFiles.push(...(process.files || []))
      current.processItems.push({ ...process, images: undefined, audios: undefined, files: undefined })
    } else if (process) {
      current.processItems.push(process)
    }
  }
  flush(activeSession)

  const lastTurn: CodexTranscriptTurn | undefined = turns[turns.length - 1]
  if (lastTurn && activeSession) {
    lastTurn.status = 'inProgress'
  } else if (lastTurn && ['cancelled', 'canceled', 'max_tokens', 'max_turn_requests', 'refusal', 'error', 'cancel_error']
    .includes(stringValue(session.stopReason).toLowerCase())) {
    lastTurn.status = 'interrupted'
  }
  const maxTurns = Number.isFinite(Number(options.maxTurns)) ? Math.max(1, Math.floor(Number(options.maxTurns))) : 80
  const visibleTurns = turns.slice(-maxTurns)
  return {
    version: 2,
    available: visibleTurns.length > 0,
    reason: visibleTurns.length > 0 ? undefined : 'empty-acp-session',
    sessionId: stringValue(session.sessionId), title: stringValue(session.title), updatedAt: stringValue(session.updatedAt),
    source: 'acp', state: stringValue(session.state), error: stringValue(session.error), errorKind: stringValue(session.errorKind),
    revision: Number(session.revision || 0), delta: session.delta === true,
    replaceFromTurnId: session.delta === true ? stringValue(visibleTurns[0]?.id) : '',
    stopReason: stringValue(session.stopReason),
    hasMoreBefore: session.hasMoreBefore === true || turns.length > visibleTurns.length,
    turnLimit: maxTurns, truncated: session.truncated === true, turns: visibleTurns,
  }
}
