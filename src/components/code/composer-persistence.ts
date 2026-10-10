import { isAcpComposerStateKey } from './acp/acp-composer-state'
import type { ComposerHistorySnapshot } from './composer-history'
import {
  createDefaultAgentComposerState,
  MAX_COMPOSER_SUBMISSIONS,
  type AgentComposerPendingFollowUpMessage,
  type AgentComposerState,
  type AgentComposerSubmission,
} from './composer-state'
import type { ComposerAttachment, ComposerContextReference, ComposerPromptAttachment } from './composer-message'
import { MAX_PASTED_TEXT_CHARS } from './composer-paste'
import type { ComposerMode } from './types'

export const AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY = 'farming.code.agentComposerCheckpoint.v1'

const CHECKPOINT_VERSION = 1
const MAX_CHECKPOINT_CHARS = 2_000_000
const MAX_CHECKPOINT_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_COMPOSER_STATES = 32
const MAX_COMPOSER_TOMBSTONES = 64
const MAX_DRAFT_CHARS = 250_000
const MAX_HISTORY_ENTRIES = 100
const MAX_HISTORY_ENTRY_CHARS = 50_000
const MAX_HISTORY_TOTAL_CHARS = 250_000
const MAX_PENDING_MESSAGES = 32
const MAX_SUBMISSIONS = MAX_COMPOSER_SUBMISSIONS
const MAX_MESSAGE_CHARS = 250_000
const MAX_ATTACHMENTS = 64
const MAX_ATTACHMENT_PATH_CHARS = 4096
const MAX_ATTACHMENT_NAME_CHARS = 1000
const MAX_ATTACHMENT_TYPE_CHARS = 200

interface ComposerCheckpointStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface PersistedComposerAttachment {
  id?: string
  kind: 'image' | 'audio'
  name: string
  type: string
  size: number
  path: string
  status?: 'ready' | 'error'
  error?: string
}

interface PersistedPendingMessage {
  contextReferences?: ComposerContextReference[];
  id: string
  text: string
  createdAt: number
  attachments?: ComposerPromptAttachment[]
  editableText?: string
  composerMode?: ComposerMode
}

interface PersistedSubmission extends PersistedPendingMessage {
  status: AgentComposerSubmission['status']
  historyRecorded?: boolean
  delivery?: 'prompt' | 'steer'
}

interface PersistedComposerState {
  contextReferences?: ComposerContextReference[];
  updatedAt: number
  draft?: string
  attachments?: PersistedComposerAttachment[]
  mode?: ComposerMode
  historyEntries?: string[]
  historySnapshots?: Array<ComposerHistorySnapshot | null>
  pendingMessages?: PersistedPendingMessage[]
  submissions?: PersistedSubmission[]
}

interface PersistedComposerCheckpoint {
  version: typeof CHECKPOINT_VERSION
  savedAt: number
  states: Record<string, PersistedComposerState>
  tombstones?: Record<string, number>
}

export interface LoadedAgentComposerCheckpoint {
  states: Record<string, AgentComposerState>
  updatedAtByKey: Map<string, number>
}

export function nextAgentComposerCheckpointTimestamp(
  key: string,
  updatedAtByKey: ReadonlyMap<string, number>,
  deletedAtByKey: ReadonlyMap<string, number>,
  now = Date.now(),
) {
  return Math.max(
    now,
    (updatedAtByKey.get(key) || 0) + 1,
    (deletedAtByKey.get(key) || 0) + 1,
  )
}

function emptyCheckpoint(): LoadedAgentComposerCheckpoint {
  return { states: {}, updatedAtByKey: new Map() }
}

function browserStorage(): ComposerCheckpointStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finiteTimestamp(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function composerMode(value: unknown): ComposerMode {
  return value === 'goal' || value === 'plan' ? value : 'default'
}

function boundedString(value: unknown, maxChars: number) {
  return typeof value === 'string' && value.length <= maxChars ? value : null
}

function validMessageId(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : ''
}

function normalizeAttachment(value: unknown, includeId: boolean): PersistedComposerAttachment | null {
  if (!isRecord(value) || (value.kind !== 'image' && value.kind !== 'audio')) return null
  const path = boundedString(value.path, MAX_ATTACHMENT_PATH_CHARS)
  const name = boundedString(value.name, MAX_ATTACHMENT_NAME_CHARS)
  const type = boundedString(value.type, MAX_ATTACHMENT_TYPE_CHARS)
  const size = typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
    ? value.size
    : null
  if (!path || name === null || type === null || size === null) return null
  const id = includeId && typeof value.id === 'string' && value.id.length <= 500 ? value.id : undefined
  return { ...(id ? { id } : {}), kind: value.kind, path, name, type, size }
}

function persistedDraftAttachments(attachments: ComposerAttachment[]): PersistedComposerAttachment[] {
  return attachments.slice(0, MAX_ATTACHMENTS).flatMap(attachment => {
    const normalized = normalizeAttachment({ ...attachment, path: attachment.path || 'pending' }, true)
    if (!normalized) return []
    return [{ ...normalized, path: attachment.path || '', status: attachment.status === 'ready' && attachment.path ? 'ready' as const : 'error' as const,
      ...(attachment.status !== 'ready' ? { error: attachment.error || 'Attachment interrupted. Remove it and attach it again.' } : {}) }]
  })
}

function restoredDraftAttachments(value: unknown): ComposerAttachment[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_ATTACHMENTS).flatMap((raw, index) => {
    if (!isRecord(raw)) return []
    const attachment = normalizeAttachment({ ...raw, path: raw.path || 'pending' }, true)
    if (!attachment) return []
    const ready = Boolean(raw.path) && raw.status !== 'error' && raw.status !== 'uploading'
    return [{ ...attachment, id: attachment.id || `restored-checkpoint-${index}-${attachment.name}`, path: typeof raw.path === 'string' ? raw.path : undefined,
      status: ready ? 'ready' as const : 'error' as const,
      ...(!ready ? { error: boundedString(raw.error, 4096) || 'Attachment interrupted. Remove it and attach it again.' } : {}) }]
  })
}

function persistedPromptAttachments(attachments: ComposerPromptAttachment[] | undefined) {
  if (!attachments) return undefined
  const normalized = attachments
    .map(attachment => normalizeAttachment(attachment, false))
    .filter((attachment): attachment is PersistedComposerAttachment => Boolean(attachment))
    .slice(0, MAX_ATTACHMENTS)
    .map(({ kind, path, name, type, size }) => ({ kind, path, name, type, size }))
  return normalized.length > 0 ? normalized : undefined
}

// Checkpoints are untrusted browser data. Reject an invalid reference set as a
// unit, so recovery never silently sends a different subset of the draft.
function persistedContextReferences(value: unknown): ComposerContextReference[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) return null
  const result: ComposerContextReference[] = []
  for (const item of value) {
    if (!isRecord(item) || !['file', 'directory', 'selection', 'skill', 'quote', 'pasted-text', 'document'].includes(String(item.kind))) return null
    if (typeof item.id !== 'string' || !item.id || item.id.length > 32_000
      || typeof item.label !== 'string' || item.label.length > 4096) return null
    const reference: ComposerContextReference = { id: item.id, kind: item.kind as ComposerContextReference['kind'], label: item.label }
    for (const field of ['rootId', 'workspace', 'path', 'text', 'sourceRevision', 'command', 'source', 'type', 'error'] as const) {
      if (item[field] === undefined) continue
      const text = boundedString(item[field], field === 'text' ? ((item.kind === 'pasted-text' || item.kind === 'document') ? MAX_PASTED_TEXT_CHARS : 6000) : 4096)
      if (text === null) return null
      reference[field] = text
    }
    for (const field of ['startLine', 'endLine'] as const) {
      if (item[field] === undefined) continue
      if (typeof item[field] !== 'number' || !Number.isSafeInteger(item[field]) || item[field] < 1) return null
      reference[field] = item[field]
    }
    if (reference.kind === 'document') {
      reference.status = item.status === 'ready' && reference.text && reference.path ? 'ready' : 'error'
      reference.error = reference.status === 'error' ? reference.error || 'Attachment interrupted. Remove it and attach it again.' : undefined
      if (typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0) reference.size = item.size
    }
    result.push(reference)
  }
  return result
}

function persistedMessage(message: AgentComposerPendingFollowUpMessage): PersistedPendingMessage | null {
  const id = validMessageId(message.id)
  const text = boundedString(message.text, MAX_MESSAGE_CHARS)
  const editableText = message.editableText === undefined
    ? undefined
    : boundedString(message.editableText, MAX_MESSAGE_CHARS)
  if (!id || text === null || editableText === null) return null
  const contextReferences = persistedContextReferences(message.contextReferences)
  if (!contextReferences) return null
  const mode = composerMode(message.composerMode)
  const attachments = persistedPromptAttachments(message.attachments)
  if (!text.trim() && !attachments) return null
  return {
    id,
    text,
    createdAt: finiteTimestamp(message.createdAt),
    ...(attachments ? { attachments } : {}),
    ...(contextReferences.length ? { contextReferences } : {}),
    ...(editableText !== undefined ? { editableText } : {}),
    ...(mode !== 'default' ? { composerMode: mode } : {}),
  }
}

function restoredMessage(value: unknown): AgentComposerPendingFollowUpMessage | null {
  if (!isRecord(value)) return null
  const id = validMessageId(value.id)
  const text = boundedString(value.text, MAX_MESSAGE_CHARS)
  const editableText = value.editableText === undefined
    ? undefined
    : boundedString(value.editableText, MAX_MESSAGE_CHARS)
  if (!id || text === null || editableText === null) return null
  const attachments = persistedPromptAttachments(Array.isArray(value.attachments) ? value.attachments as ComposerPromptAttachment[] : undefined)
  if (!text.trim() && !attachments) return null
  const contextReferences = persistedContextReferences(value.contextReferences)
  if (!contextReferences) return null
  const mode = composerMode(value.composerMode)
  return {
    id,
    text,
    createdAt: finiteTimestamp(value.createdAt),
    ...(attachments ? { attachments } : {}),
    ...(contextReferences.length ? { contextReferences } : {}),
    ...(editableText !== undefined ? { editableText } : {}),
    ...(mode !== 'default' ? { composerMode: mode } : {}),
  }
}

function boundedHistory(entries: unknown, rawSnapshots?: unknown) {
  const values = Array.isArray(entries) ? entries : []
  const snapshots = Array.isArray(rawSnapshots) ? rawSnapshots : []
  const result: { entry: string; snapshot: ComposerHistorySnapshot | null }[] = []
  let total = 0
  for (let index = values.length - 1; index >= 0 && result.length < MAX_HISTORY_ENTRIES; index--) {
    const entry = boundedString(values[index], MAX_HISTORY_ENTRY_CHARS)
    if (entry === null) continue
    const raw = snapshots[index]
    let snapshot: ComposerHistorySnapshot | null = null
    if (isRecord(raw)) {
      const contextReferences = persistedContextReferences(raw.contextReferences)
      if (!contextReferences) continue
      snapshot = { attachments: restoredDraftAttachments(raw.attachments), contextReferences }
    }
    const length = entry.length + JSON.stringify(snapshot).length
    if (total + length > MAX_HISTORY_TOTAL_CHARS) continue
    result.push({ entry, snapshot }); total += length
  }
  result.reverse()
  return { entries: result.map(item => item.entry), ...(rawSnapshots ? { snapshots: result.map(item => item.snapshot) } : {}) }
}

function hasPersistableState(state: AgentComposerState) {
  return Boolean(
    state.draft
    || state.contextReferences?.length
    || state.attachments.length
    || state.mode !== 'default'
    || state.history.entries.length > 0
    || state.pendingFollowUp?.messages.length
    || state.submissions?.length
  )
}

function serializeState(state: AgentComposerState, updatedAt: number): PersistedComposerState | null {
  if (!hasPersistableState(state)) return null
  const contextReferences = persistedContextReferences(state.contextReferences)
  if (!contextReferences) return null
  const draft = boundedString(state.draft, MAX_DRAFT_CHARS)
  if (draft === null) return null
  if ((state.pendingFollowUp?.messages.length ?? 0) > MAX_PENDING_MESSAGES) return null
  if ((state.submissions?.length ?? 0) > MAX_SUBMISSIONS) return null
  const pendingMessages = (state.pendingFollowUp?.messages || []).map(persistedMessage)
  const submissions = (state.submissions || []).map(submission => {
    const message = persistedMessage(submission)
    if (!message) return null
    return {
      ...message,
      status: submission.status,
      ...(submission.historyRecorded === true ? { historyRecorded: true } : {}),
      ...(submission.delivery === 'prompt' || submission.delivery === 'steer'
        ? { delivery: submission.delivery }
        : {}),
    } satisfies PersistedSubmission
  })
  if (pendingMessages.some(message => message === null) || submissions.some(message => message === null)) return null
  const attachments = persistedDraftAttachments(state.attachments)
  const history = boundedHistory(state.history.entries, state.history.snapshots?.map(snapshot => snapshot ? { ...snapshot, attachments: persistedDraftAttachments(snapshot.attachments) } : null))
  return {
    updatedAt,
    ...(contextReferences.length ? { contextReferences } : {}),
    ...(draft ? { draft } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(state.mode !== 'default' ? { mode: state.mode } : {}),
    ...(history.entries.length > 0 ? { historyEntries: history.entries, historySnapshots: history.snapshots } : {}),
    ...(pendingMessages.length > 0 ? { pendingMessages: pendingMessages as PersistedPendingMessage[] } : {}),
    ...(submissions.length > 0 ? { submissions: submissions as PersistedSubmission[] } : {}),
  }
}

function restoreState(value: unknown): AgentComposerState | null {
  if (!isRecord(value)) return null
  const draft = value.draft === undefined ? '' : boundedString(value.draft, MAX_DRAFT_CHARS)
  if (draft === null) return null
  const pendingValues = Array.isArray(value.pendingMessages) ? value.pendingMessages : []
  const submissionValues = Array.isArray(value.submissions) ? value.submissions : []
  if (pendingValues.length > MAX_PENDING_MESSAGES || submissionValues.length > MAX_SUBMISSIONS) return null
  const pendingMessages = pendingValues.map(restoredMessage)
  if (pendingMessages.some(message => message === null)) return null
  const submissions = submissionValues.map(rawSubmission => {
    const message = restoredMessage(rawSubmission)
    if (!message || !isRecord(rawSubmission)) return null
    return {
      ...message,
      // A page loss makes every former in-flight request ambiguous. Keep it
      // visible for explicit same-id reconciliation, but never replay it.
      status: 'unknown' as const,
      ...(rawSubmission.historyRecorded === true ? { historyRecorded: true } : {}),
      ...(rawSubmission.delivery === 'prompt' || rawSubmission.delivery === 'steer'
        ? { delivery: rawSubmission.delivery }
        : {}),
    } satisfies AgentComposerSubmission
  })
  if (submissions.some(submission => submission === null)) return null
  const history = boundedHistory(value.historyEntries, value.historySnapshots)
  const contextReferences = persistedContextReferences(value.contextReferences)
  if (!contextReferences) return null
  const state = createDefaultAgentComposerState()
  state.contextReferences = contextReferences
  state.draft = draft
  state.attachments = restoredDraftAttachments(value.attachments)
  state.mode = composerMode(value.mode)
  state.history = { ...history, cursor: null }
  if (pendingMessages.length > 0) {
    const messages = pendingMessages as AgentComposerPendingFollowUpMessage[]
    state.pendingFollowUp = {
      messages,
      createdAt: Math.min(...messages.map(message => message.createdAt)),
    }
  }
  if (submissions.length > 0) state.submissions = submissions as AgentComposerSubmission[]
  return hasPersistableState(state) ? state : null
}

export function loadAgentComposerCheckpoint(
  storage: ComposerCheckpointStorage | null = browserStorage(),
  now = Date.now(),
): LoadedAgentComposerCheckpoint {
  if (!storage) return emptyCheckpoint()
  const checkpoint = normalizedStoredCheckpoint(storage, now)
  if (!checkpoint) return emptyCheckpoint()
  const states: Record<string, AgentComposerState> = {}
  const updatedAtByKey = new Map<string, number>()
  for (const [key, persisted] of Object.entries(checkpoint.states)) {
    if ((checkpoint.tombstones?.[key] || 0) >= persisted.updatedAt) continue
    const state = restoreState(persisted)
    if (!state) continue
    // A checkpoint may still describe a follow-up as queued after dispatch.
    // Chat recovery cannot infer zero effect from that stale presentation state.
    if (isAcpComposerStateKey(key) && state.pendingFollowUp?.messages.length) {
      state.submissions = [
        ...(state.submissions || []),
        ...state.pendingFollowUp.messages.map(message => ({
          ...message, status: 'unknown' as const, delivery: 'prompt' as const, historyRecorded: true,
        })),
      ]
      state.pendingFollowUp = undefined
    }
    states[key] = state
    updatedAtByKey.set(key, persisted.updatedAt)
  }
  return { states, updatedAtByKey }
}

function normalizedStoredCheckpoint(
  storage: ComposerCheckpointStorage,
  now: number,
): PersistedComposerCheckpoint | null {
  try {
    const raw = storage.getItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY)
    if (!raw || raw.length > MAX_CHECKPOINT_CHARS) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || parsed.version !== CHECKPOINT_VERSION || !isRecord(parsed.states)) return null
    const savedAt = finiteTimestamp(parsed.savedAt)
    if (!savedAt || now - savedAt > MAX_CHECKPOINT_AGE_MS) return null
    const states: Record<string, PersistedComposerState> = {}
    Object.entries(parsed.states).slice(0, MAX_COMPOSER_STATES).forEach(([key, rawState]) => {
      if (!key || key.length > 500 || !isRecord(rawState)) return
      const updatedAt = finiteTimestamp(rawState.updatedAt, savedAt)
      if (now - updatedAt > MAX_CHECKPOINT_AGE_MS) return
      const restored = restoreState(rawState)
      if (!restored) return
      const normalized = serializeState(restored, updatedAt)
      if (normalized) states[key] = normalized
    })
    const tombstones: Record<string, number> = {}
    if (isRecord(parsed.tombstones)) {
      Object.entries(parsed.tombstones).slice(0, MAX_COMPOSER_TOMBSTONES).forEach(([key, value]) => {
        const deletedAt = finiteTimestamp(value)
        if (!key || key.length > 500 || !deletedAt || now - deletedAt > MAX_CHECKPOINT_AGE_MS) return
        tombstones[key] = deletedAt
      })
    }
    return { version: CHECKPOINT_VERSION, savedAt, states, tombstones }
  } catch {
    return null
  }
}

function checkpointString(
  stateEntries: Array<[string, PersistedComposerState]>,
  tombstoneEntries: Array<[string, number]>,
  savedAt: number,
) {
  return JSON.stringify({
    version: CHECKPOINT_VERSION,
    savedAt,
    states: Object.fromEntries(stateEntries),
    ...(tombstoneEntries.length > 0 ? { tombstones: Object.fromEntries(tombstoneEntries) } : {}),
  } satisfies PersistedComposerCheckpoint)
}

export function saveAgentComposerCheckpoint(
  states: Record<string, AgentComposerState>,
  updatedAtByKey: ReadonlyMap<string, number>,
  deletedAtByKey: ReadonlyMap<string, number> = new Map(),
  storage: ComposerCheckpointStorage | null = browserStorage(),
  now = Date.now(),
) {
  if (!storage) return false
  try {
    const current = normalizedStoredCheckpoint(storage, now)
    const persistedStates = new Map<string, PersistedComposerState>(Object.entries(current?.states || {}))
    const tombstones = new Map<string, number>(Object.entries(current?.tombstones || {}))

    for (const [key, state] of Object.entries(states)) {
      if (!key || key.length > 500) continue
      const updatedAt = updatedAtByKey.get(key) ?? now
      const existingUpdatedAt = persistedStates.get(key)?.updatedAt || 0
      const deletedAt = tombstones.get(key) || 0
      if (updatedAt < existingUpdatedAt || updatedAt <= deletedAt) continue
      const persisted = serializeState(state, updatedAt)
      if (!persisted) {
        if (hasPersistableState(state)) continue
        persistedStates.delete(key)
        tombstones.set(key, updatedAt)
        continue
      }
      persistedStates.set(key, persisted)
      tombstones.delete(key)
    }

    for (const [key, deletedAt] of deletedAtByKey) {
      if (!key || key.length > 500 || !Number.isFinite(deletedAt) || deletedAt < 0) continue
      const existingUpdatedAt = persistedStates.get(key)?.updatedAt || 0
      const existingDeletedAt = tombstones.get(key) || 0
      if (deletedAt < existingUpdatedAt || deletedAt < existingDeletedAt) continue
      persistedStates.delete(key)
      tombstones.set(key, deletedAt)
    }

    const stateEntries = Array.from(persistedStates.entries())
      .filter(([, state]) => JSON.stringify(state).length < MAX_CHECKPOINT_CHARS)
      .sort(([leftKey, left], [rightKey, right]) => (
        right.updatedAt - left.updatedAt || leftKey.localeCompare(rightKey)
      ))
      .slice(0, MAX_COMPOSER_STATES)
    const tombstoneEntries = Array.from(tombstones.entries())
      .sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey))
      .slice(0, MAX_COMPOSER_TOMBSTONES)
    let serialized = checkpointString(stateEntries, tombstoneEntries, now)
    while (serialized.length > MAX_CHECKPOINT_CHARS && (stateEntries.length > 0 || tombstoneEntries.length > 0)) {
      const oldestStateAt = stateEntries[stateEntries.length - 1]?.[1].updatedAt ?? Number.POSITIVE_INFINITY
      const oldestTombstoneAt = tombstoneEntries[tombstoneEntries.length - 1]?.[1] ?? Number.POSITIVE_INFINITY
      if (oldestStateAt <= oldestTombstoneAt) stateEntries.pop()
      else tombstoneEntries.pop()
      serialized = checkpointString(stateEntries, tombstoneEntries, now)
    }
    if (serialized.length > MAX_CHECKPOINT_CHARS) return false
    storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, serialized)
    return true
  } catch {
    return false
  }
}
