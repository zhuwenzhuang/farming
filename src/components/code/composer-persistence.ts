import {
  createDefaultAgentComposerState,
  type AgentComposerAdmission,
  type AgentComposerPendingFollowUpMessage,
  type AgentComposerState,
  type AgentComposerSubmission,
} from './composer-state'
import type { ComposerAttachment, ComposerPromptAttachment } from './composer-message'
import type { ComposerMode } from './types'

export const AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY = 'farming.code.agentComposerCheckpoint.v2'
export const LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY = 'farming.code.agentComposerCheckpoint.v1'

const CHECKPOINT_VERSION = 2
const LEGACY_CHECKPOINT_VERSION = 1
const MAX_CHECKPOINT_CHARS = 2_000_000
const MAX_CHECKPOINT_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_CHECKPOINT_FUTURE_SKEW_MS = 5 * 60 * 1000
const MAX_COMPOSER_STATES = 32
const MAX_COMPOSER_TOMBSTONES = 64
const MAX_DRAFT_CHARS = 250_000
const MAX_HISTORY_ENTRIES = 100
const MAX_HISTORY_ENTRY_CHARS = 50_000
const MAX_HISTORY_TOTAL_CHARS = 250_000
const MAX_PENDING_MESSAGES = 32
const MAX_SUBMISSIONS = 32
const MAX_ADMISSIONS = 64
const MAX_ADMISSION_TOMBSTONES = 128
const MAX_MESSAGE_CHARS = 250_000
const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_PATH_CHARS = 4096
const MAX_ATTACHMENT_NAME_CHARS = 1000
const MAX_ATTACHMENT_TYPE_CHARS = 200
const INVALID_STORED_CHECKPOINT = Symbol('invalid-stored-composer-checkpoint')
const STALE_STORED_CHECKPOINT = Symbol('stale-stored-composer-checkpoint')

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
}

interface PersistedPendingMessage {
  id: string
  text: string
  createdAt: number
  attachments?: ComposerPromptAttachment[]
  editableText?: string
  composerMode?: ComposerMode
}

interface PersistedSubmission extends PersistedPendingMessage {
  status: 'submitting' | 'failed'
  historyRecorded?: boolean
  delivery?: 'prompt' | 'steer'
  origin?: 'draft' | 'queued'
  draftAttachmentIds?: string[]
}

interface PersistedComposerAdmission extends PersistedSubmission {
  composerKey: string
  updatedAt: number
}

interface PersistedComposerState {
  updatedAt: number
  draft?: string
  attachments?: PersistedComposerAttachment[]
  mode?: ComposerMode
  historyEntries?: string[]
  pendingMessages?: PersistedPendingMessage[]
  submissions?: PersistedSubmission[]
}

interface PersistedComposerCheckpoint {
  version: typeof CHECKPOINT_VERSION
  savedAt: number
  states: Record<string, PersistedComposerState>
  tombstones?: Record<string, number>
  admissions?: Record<string, PersistedComposerAdmission>
  admissionTombstones?: Record<string, number>
}

export interface LoadedAgentComposerCheckpoint {
  states: Record<string, AgentComposerState>
  updatedAtByKey: Map<string, number>
  admissions: Map<string, AgentComposerAdmission>
  admissionUpdatedAtById: Map<string, number>
  admissionDeletedAtById: Map<string, number>
}

export interface AgentComposerAdmissionCheckpoint {
  admissions: ReadonlyMap<string, AgentComposerAdmission>
  updatedAtById: ReadonlyMap<string, number>
  deletedAtById: ReadonlyMap<string, number>
}

export function nextAgentComposerCheckpointTimestamp(
  key: string,
  updatedAtByKey: ReadonlyMap<string, number>,
  deletedAtByKey: ReadonlyMap<string, number>,
  now = Date.now(),
) {
  const latestUpdatedAt = composerTimestampWithinFutureBound(updatedAtByKey.get(key), now)
  const latestDeletedAt = composerTimestampWithinFutureBound(deletedAtByKey.get(key), now)
  return Math.max(
    now,
    latestUpdatedAt + 1,
    latestDeletedAt + 1,
  )
}

function emptyCheckpoint(): LoadedAgentComposerCheckpoint {
  return {
    states: {},
    updatedAtByKey: new Map(),
    admissions: new Map(),
    admissionUpdatedAtById: new Map(),
    admissionDeletedAtById: new Map(),
  }
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

function composerTimestampWithinFutureBound(value: unknown, now: number) {
  const timestamp = finiteTimestamp(value)
  return timestamp <= now + MAX_CHECKPOINT_FUTURE_SKEW_MS ? timestamp : 0
}

function timestampForCurrentWrite(value: unknown, now: number) {
  return composerTimestampWithinFutureBound(value, now) || now
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

function validAttachmentId(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500
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

function persistedDraftAttachments(attachments: ComposerAttachment[]) {
  return attachments
    .filter(attachment => attachment.status === 'ready' && Boolean(attachment.path))
    .map(attachment => normalizeAttachment(attachment, true))
    .filter((attachment): attachment is PersistedComposerAttachment => Boolean(attachment))
    .slice(0, MAX_ATTACHMENTS)
}

function restoredDraftAttachments(value: unknown): ComposerAttachment[] {
  if (!Array.isArray(value)) return []
  return value
    .map(attachment => normalizeAttachment(attachment, true))
    .filter((attachment): attachment is PersistedComposerAttachment => Boolean(attachment))
    .slice(0, MAX_ATTACHMENTS)
    .map((attachment, index) => ({
      id: attachment.id || `restored-checkpoint-${index}-${attachment.name}`,
      kind: attachment.kind,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      status: 'ready' as const,
      path: attachment.path,
    }))
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

function persistedMessage(message: AgentComposerPendingFollowUpMessage): PersistedPendingMessage | null {
  const id = validMessageId(message.id)
  const text = boundedString(message.text, MAX_MESSAGE_CHARS)
  const editableText = message.editableText === undefined
    ? undefined
    : boundedString(message.editableText, MAX_MESSAGE_CHARS)
  if (!id || text === null || editableText === null) return null
  const mode = composerMode(message.composerMode)
  const attachments = persistedPromptAttachments(message.attachments)
  if (!text.trim() && !attachments) return null
  return {
    id,
    text,
    createdAt: finiteTimestamp(message.createdAt),
    ...(attachments ? { attachments } : {}),
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
  const mode = composerMode(value.composerMode)
  return {
    id,
    text,
    createdAt: finiteTimestamp(value.createdAt),
    ...(attachments ? { attachments } : {}),
    ...(editableText !== undefined ? { editableText } : {}),
    ...(mode !== 'default' ? { composerMode: mode } : {}),
  }
}

function persistedSubmission(submission: AgentComposerSubmission): PersistedSubmission | null {
  const message = persistedMessage(submission)
  if (!message) return null
  if (
    submission.draftAttachmentIds !== undefined
    && (
      submission.draftAttachmentIds.length > MAX_ATTACHMENTS
      || !submission.draftAttachmentIds.every(validAttachmentId)
    )
  ) return null
  const draftAttachmentIds = submission.draftAttachmentIds
  return {
    ...message,
    status: submission.status,
    ...(submission.historyRecorded === true ? { historyRecorded: true } : {}),
    ...(submission.delivery === 'prompt' || submission.delivery === 'steer'
      ? { delivery: submission.delivery }
      : {}),
    ...(submission.origin === 'draft' || submission.origin === 'queued'
      ? { origin: submission.origin }
      : {}),
    ...(draftAttachmentIds?.length ? { draftAttachmentIds } : {}),
  }
}

function restoredSubmission(
  value: unknown,
  preserveStoredStatus = false,
): AgentComposerSubmission | null {
  const message = restoredMessage(value)
  if (!message || !isRecord(value)) return null
  if (value.status !== 'submitting' && value.status !== 'failed') return null
  if (
    value.draftAttachmentIds !== undefined
    && (
      !Array.isArray(value.draftAttachmentIds)
      || value.draftAttachmentIds.length > MAX_ATTACHMENTS
      || !value.draftAttachmentIds.every(validAttachmentId)
    )
  ) return null
  const draftAttachmentIds = value.draftAttachmentIds as string[] | undefined
  return {
    ...message,
    // A page loss makes every former in-flight request ambiguous. Storage
    // normalization preserves the writer's status, while loading into a new
    // page always presents it as an explicit same-id retry.
    status: preserveStoredStatus ? value.status : 'failed',
    ...(value.historyRecorded === true ? { historyRecorded: true } : {}),
    ...(value.delivery === 'prompt' || value.delivery === 'steer'
      ? { delivery: value.delivery }
      : {}),
    ...(value.origin === 'draft' || value.origin === 'queued'
      ? { origin: value.origin }
      : {}),
    ...(draftAttachmentIds?.length ? { draftAttachmentIds } : {}),
  }
}

function boundedHistory(entries: string[]) {
  const result: string[] = []
  let totalChars = 0
  for (let index = entries.length - 1; index >= 0 && result.length < MAX_HISTORY_ENTRIES; index -= 1) {
    const entry = boundedString(entries[index], MAX_HISTORY_ENTRY_CHARS)
    if (entry === null || totalChars + entry.length > MAX_HISTORY_TOTAL_CHARS) continue
    result.push(entry)
    totalChars += entry.length
  }
  return result.reverse()
}

function hasPersistableComposerState(state: AgentComposerState) {
  return Boolean(
    state.draft
    || state.attachments.some(attachment => attachment.status === 'ready' && attachment.path)
    || state.mode !== 'default'
    || state.history.entries.length > 0
    || state.pendingFollowUp?.messages.length
  )
}

function serializeState(state: AgentComposerState, updatedAt: number): PersistedComposerState | null {
  if (!hasPersistableComposerState(state)) return null
  const draft = boundedString(state.draft, MAX_DRAFT_CHARS)
  if (draft === null) return null
  if ((state.pendingFollowUp?.messages.length ?? 0) > MAX_PENDING_MESSAGES) return null
  const pendingMessages = (state.pendingFollowUp?.messages || []).map(persistedMessage)
  if (pendingMessages.some(message => message === null)) return null
  const attachments = persistedDraftAttachments(state.attachments)
  const historyEntries = boundedHistory(state.history.entries)
  return {
    updatedAt,
    ...(draft ? { draft } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(state.mode !== 'default' ? { mode: state.mode } : {}),
    ...(historyEntries.length > 0 ? { historyEntries } : {}),
    ...(pendingMessages.length > 0 ? { pendingMessages: pendingMessages as PersistedPendingMessage[] } : {}),
  }
}

function restoreState(value: unknown, preserveStoredSubmissionStatus = false): AgentComposerState | null {
  if (!isRecord(value)) return null
  const draft = value.draft === undefined ? '' : boundedString(value.draft, MAX_DRAFT_CHARS)
  if (draft === null) return null
  const pendingValues = Array.isArray(value.pendingMessages) ? value.pendingMessages : []
  const submissionValues = Array.isArray(value.submissions) ? value.submissions : []
  if (pendingValues.length > MAX_PENDING_MESSAGES || submissionValues.length > MAX_SUBMISSIONS) return null
  const pendingMessages = pendingValues.map(restoredMessage)
  if (pendingMessages.some(message => message === null)) return null
  const submissions = submissionValues.map(submission => (
    restoredSubmission(submission, preserveStoredSubmissionStatus)
  ))
  if (submissions.some(submission => submission === null)) return null
  const historyEntries = boundedHistory(Array.isArray(value.historyEntries)
    ? value.historyEntries.filter((entry): entry is string => typeof entry === 'string')
    : [])
  const state = createDefaultAgentComposerState()
  state.draft = draft
  state.attachments = restoredDraftAttachments(value.attachments)
  state.mode = composerMode(value.mode)
  state.history = { entries: historyEntries, cursor: null }
  if (pendingMessages.length > 0) {
    const messages = pendingMessages as AgentComposerPendingFollowUpMessage[]
    state.pendingFollowUp = {
      messages,
      createdAt: Math.min(...messages.map(message => message.createdAt)),
    }
  }
  if (submissions.length > 0) state.submissions = submissions as AgentComposerSubmission[]
  return hasPersistableComposerState(state) || state.submissions?.length ? state : null
}

export function loadAgentComposerCheckpoint(
  storage: ComposerCheckpointStorage | null = browserStorage(),
  now = Date.now(),
): LoadedAgentComposerCheckpoint {
  if (!storage) return emptyCheckpoint()
  let checkpoint = normalizedStoredCheckpoint(
    storage,
    AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY,
    CHECKPOINT_VERSION,
    now,
  )
  if (checkpoint === INVALID_STORED_CHECKPOINT || checkpoint === STALE_STORED_CHECKPOINT) {
    return emptyCheckpoint()
  }
  if (!checkpoint) {
    checkpoint = normalizedStoredCheckpoint(
      storage,
      LEGACY_AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY,
      LEGACY_CHECKPOINT_VERSION,
      now,
    )
  }
  if (checkpoint === INVALID_STORED_CHECKPOINT || checkpoint === STALE_STORED_CHECKPOINT) {
    return emptyCheckpoint()
  }
  if (!checkpoint) return emptyCheckpoint()
  const states: Record<string, AgentComposerState> = {}
  const updatedAtByKey = new Map<string, number>()
  for (const [key, persisted] of Object.entries(checkpoint.states)) {
    if ((checkpoint.tombstones?.[key] || 0) >= persisted.updatedAt) continue
    const state = restoreState(persisted)
    if (!state) continue
    // The top-level admission ledger is authoritative for unresolved writes.
    // A stale per-state copy must not resurrect an accepted or discarded request.
    state.submissions = undefined
    states[key] = state
    updatedAtByKey.set(key, persisted.updatedAt)
  }
  const admissions = new Map<string, AgentComposerAdmission>()
  const admissionUpdatedAtById = new Map<string, number>()
  const admissionDeletedAtById = new Map<string, number>()
  Object.entries(checkpoint.admissionTombstones || {}).forEach(([requestId, deletedAt]) => {
    admissionDeletedAtById.set(requestId, deletedAt)
  })
  Object.entries(checkpoint.admissions || {}).forEach(([requestId, persisted]) => {
    if ((checkpoint.admissionTombstones?.[requestId] || 0) >= persisted.updatedAt) return
    const submission = restoredSubmission(persisted)
    if (!submission) return
    admissions.set(requestId, { ...submission, composerKey: persisted.composerKey })
    admissionUpdatedAtById.set(requestId, persisted.updatedAt)
    const state = states[persisted.composerKey] ?? createDefaultAgentComposerState()
    const submissions = [
      ...(state.submissions || []).filter(candidate => candidate.id !== requestId),
      submission,
    ]
    states[persisted.composerKey] = { ...state, submissions }
    if (!updatedAtByKey.has(persisted.composerKey)) {
      updatedAtByKey.set(persisted.composerKey, persisted.updatedAt)
    }
  })
  return {
    states,
    updatedAtByKey,
    admissions,
    admissionUpdatedAtById,
    admissionDeletedAtById,
  }
}

function normalizedStoredCheckpoint(
  storage: ComposerCheckpointStorage,
  storageKey: string,
  expectedVersion: typeof CHECKPOINT_VERSION | typeof LEGACY_CHECKPOINT_VERSION,
  now: number,
): PersistedComposerCheckpoint
  | null
  | typeof INVALID_STORED_CHECKPOINT
  | typeof STALE_STORED_CHECKPOINT {
  try {
    const raw = storage.getItem(storageKey)
    if (raw === null) return null
    if (!raw || raw.length > MAX_CHECKPOINT_CHARS) return INVALID_STORED_CHECKPOINT
    const parsed = JSON.parse(raw) as unknown
    if (
      !isRecord(parsed)
      || parsed.version !== expectedVersion
      || !isRecord(parsed.states)
    ) return INVALID_STORED_CHECKPOINT
    const savedAt = finiteTimestamp(parsed.savedAt)
    if (!savedAt) return INVALID_STORED_CHECKPOINT
    if (
      now - savedAt > MAX_CHECKPOINT_AGE_MS
      || savedAt > now + MAX_CHECKPOINT_FUTURE_SKEW_MS
    ) return STALE_STORED_CHECKPOINT
    const states: Record<string, PersistedComposerState> = {}
    const admissions: Record<string, PersistedComposerAdmission> = {}
    Object.entries(parsed.states).slice(0, MAX_COMPOSER_STATES).forEach(([key, rawState]) => {
      if (!key || key.length > 500 || !isRecord(rawState)) return
      const updatedAt = finiteTimestamp(rawState.updatedAt, savedAt)
      if (
        now - updatedAt > MAX_CHECKPOINT_AGE_MS
        || updatedAt > now + MAX_CHECKPOINT_FUTURE_SKEW_MS
      ) return
      const restored = restoreState(rawState, true)
      if (!restored) return
      // Version 1 stored unresolved submissions inside each Composer state.
      // Promote them into the mergeable request ledger during normalization.
      if (expectedVersion === LEGACY_CHECKPOINT_VERSION) {
        for (const submission of restored.submissions || []) {
          const persisted = persistedSubmission(submission)
          if (!persisted) continue
          admissions[submission.id] = {
            ...persisted,
            composerKey: key,
            updatedAt,
          }
        }
      }
      const normalized = serializeState(restored, updatedAt)
      if (normalized) states[key] = normalized
    })
    const tombstones: Record<string, number> = {}
    if (isRecord(parsed.tombstones)) {
      Object.entries(parsed.tombstones).slice(0, MAX_COMPOSER_TOMBSTONES).forEach(([key, value]) => {
        const deletedAt = finiteTimestamp(value)
        if (
          !key
          || key.length > 500
          || !deletedAt
          || now - deletedAt > MAX_CHECKPOINT_AGE_MS
          || deletedAt > now + MAX_CHECKPOINT_FUTURE_SKEW_MS
        ) return
        tombstones[key] = deletedAt
      })
    }
    if (expectedVersion === CHECKPOINT_VERSION && isRecord(parsed.admissions)) {
      Object.entries(parsed.admissions).slice(0, MAX_ADMISSIONS + 1).forEach(([requestId, rawAdmission]) => {
        if (!validMessageId(requestId) || !isRecord(rawAdmission)) return
        const composerKey = boundedString(rawAdmission.composerKey, 500)
        const updatedAt = finiteTimestamp(rawAdmission.updatedAt, savedAt)
        const submission = restoredSubmission(rawAdmission, true)
        if (
          !composerKey
          || !updatedAt
          || !submission
          || submission.id !== requestId
          || now - updatedAt > MAX_CHECKPOINT_AGE_MS
          || updatedAt > now + MAX_CHECKPOINT_FUTURE_SKEW_MS
        ) return
        const persisted = persistedSubmission(submission)
        if (!persisted) return
        admissions[requestId] = { ...persisted, composerKey, updatedAt }
      })
      if (Object.keys(parsed.admissions).length > MAX_ADMISSIONS) return INVALID_STORED_CHECKPOINT
    }
    const admissionTombstones: Record<string, number> = {}
    if (expectedVersion === CHECKPOINT_VERSION && isRecord(parsed.admissionTombstones)) {
      Object.entries(parsed.admissionTombstones).slice(0, MAX_ADMISSION_TOMBSTONES).forEach(([requestId, value]) => {
        const deletedAt = finiteTimestamp(value)
        if (
          !validMessageId(requestId)
          || !deletedAt
          || now - deletedAt > MAX_CHECKPOINT_AGE_MS
          || deletedAt > now + MAX_CHECKPOINT_FUTURE_SKEW_MS
        ) return
        admissionTombstones[requestId] = deletedAt
      })
    }
    return {
      version: CHECKPOINT_VERSION,
      savedAt,
      states,
      tombstones,
      admissions,
      admissionTombstones,
    }
  } catch {
    return INVALID_STORED_CHECKPOINT
  }
}

function checkpointString(
  stateEntries: Array<[string, PersistedComposerState]>,
  tombstoneEntries: Array<[string, number]>,
  admissionEntries: Array<[string, PersistedComposerAdmission]>,
  admissionTombstoneEntries: Array<[string, number]>,
  savedAt: number,
) {
  return JSON.stringify({
    version: CHECKPOINT_VERSION,
    savedAt,
    states: Object.fromEntries(stateEntries),
    ...(tombstoneEntries.length > 0 ? { tombstones: Object.fromEntries(tombstoneEntries) } : {}),
    ...(admissionEntries.length > 0 ? { admissions: Object.fromEntries(admissionEntries) } : {}),
    ...(admissionTombstoneEntries.length > 0
      ? { admissionTombstones: Object.fromEntries(admissionTombstoneEntries) }
      : {}),
  } satisfies PersistedComposerCheckpoint)
}

function admissionsFromStates(
  states: Record<string, AgentComposerState>,
  updatedAtByKey: ReadonlyMap<string, number>,
  now: number,
): AgentComposerAdmissionCheckpoint {
  const admissions = new Map<string, AgentComposerAdmission>()
  const updatedAtById = new Map<string, number>()
  for (const [composerKey, state] of Object.entries(states)) {
    for (const submission of state.submissions || []) {
      admissions.set(submission.id, { ...submission, composerKey })
      updatedAtById.set(submission.id, updatedAtByKey.get(composerKey) || now)
    }
  }
  return { admissions, updatedAtById, deletedAtById: new Map() }
}

export function saveAgentComposerCheckpoint(
  states: Record<string, AgentComposerState>,
  updatedAtByKey: ReadonlyMap<string, number>,
  deletedAtByKey: ReadonlyMap<string, number> = new Map(),
  storage: ComposerCheckpointStorage | null = browserStorage(),
  now = Date.now(),
  admissionCheckpoint?: AgentComposerAdmissionCheckpoint,
) {
  if (!storage) return false
  try {
    const current = normalizedStoredCheckpoint(
      storage,
      AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY,
      CHECKPOINT_VERSION,
      now,
    )
    if (current === INVALID_STORED_CHECKPOINT) return false
    const mergeBase = current === STALE_STORED_CHECKPOINT ? null : current
    const persistedStates = new Map<string, PersistedComposerState>(Object.entries(mergeBase?.states || {}))
    const tombstones = new Map<string, number>(Object.entries(mergeBase?.tombstones || {}))
    const persistedAdmissions = new Map<string, PersistedComposerAdmission>(Object.entries(mergeBase?.admissions || {}))
    const admissionTombstones = new Map<string, number>(Object.entries(mergeBase?.admissionTombstones || {}))

    for (const [key, state] of Object.entries(states)) {
      if (!key || key.length > 500) continue
      const updatedAt = timestampForCurrentWrite(updatedAtByKey.get(key), now)
      const existingUpdatedAt = persistedStates.get(key)?.updatedAt || 0
      const deletedAt = tombstones.get(key) || 0
      if (updatedAt < existingUpdatedAt || updatedAt <= deletedAt) continue
      const persisted = serializeState(state, updatedAt)
      if (!persisted) {
        if (hasPersistableComposerState(state)) continue
        persistedStates.delete(key)
        tombstones.set(key, updatedAt)
        continue
      }
      persistedStates.set(key, persisted)
      tombstones.delete(key)
    }

    for (const [key, candidateDeletedAt] of deletedAtByKey) {
      if (!key || key.length > 500 || !Number.isFinite(candidateDeletedAt) || candidateDeletedAt < 0) continue
      const deletedAt = timestampForCurrentWrite(candidateDeletedAt, now)
      const existingUpdatedAt = persistedStates.get(key)?.updatedAt || 0
      const existingDeletedAt = tombstones.get(key) || 0
      if (deletedAt < existingUpdatedAt || deletedAt < existingDeletedAt) continue
      persistedStates.delete(key)
      tombstones.set(key, deletedAt)
    }

    const admissionState = admissionCheckpoint || admissionsFromStates(states, updatedAtByKey, now)
    for (const [requestId, admission] of admissionState.admissions) {
      if (!validMessageId(requestId) || requestId !== admission.id) continue
      if (!admission.composerKey || admission.composerKey.length > 500) continue
      const updatedAt = timestampForCurrentWrite(admissionState.updatedAtById.get(requestId), now)
      const existingUpdatedAt = persistedAdmissions.get(requestId)?.updatedAt || 0
      const deletedAt = admissionTombstones.get(requestId) || 0
      if (updatedAt < existingUpdatedAt || updatedAt <= deletedAt) continue
      const persisted = persistedSubmission(admission)
      if (!persisted) return false
      persistedAdmissions.set(requestId, {
        ...persisted,
        composerKey: admission.composerKey,
        updatedAt,
      })
      admissionTombstones.delete(requestId)
    }
    for (const [requestId, candidateDeletedAt] of admissionState.deletedAtById) {
      if (!validMessageId(requestId) || !Number.isFinite(candidateDeletedAt) || candidateDeletedAt < 0) continue
      const deletedAt = timestampForCurrentWrite(candidateDeletedAt, now)
      const existingUpdatedAt = persistedAdmissions.get(requestId)?.updatedAt || 0
      const existingDeletedAt = admissionTombstones.get(requestId) || 0
      if (deletedAt < existingUpdatedAt || deletedAt < existingDeletedAt) continue
      persistedAdmissions.delete(requestId)
      admissionTombstones.set(requestId, deletedAt)
    }
    if (persistedAdmissions.size > MAX_ADMISSIONS) return false

    const stateEntries = Array.from(persistedStates.entries())
      .filter(([, state]) => JSON.stringify(state).length < MAX_CHECKPOINT_CHARS)
      .sort(([leftKey, left], [rightKey, right]) => (
        right.updatedAt - left.updatedAt || leftKey.localeCompare(rightKey)
      ))
      .slice(0, MAX_COMPOSER_STATES)
    const tombstoneEntries = Array.from(tombstones.entries())
      .sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey))
      .slice(0, MAX_COMPOSER_TOMBSTONES)
    const admissionEntries = Array.from(persistedAdmissions.entries())
      .sort(([leftId, left], [rightId, right]) => (
        right.updatedAt - left.updatedAt || leftId.localeCompare(rightId)
      ))
    const admissionTombstoneEntries = Array.from(admissionTombstones.entries())
      .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))
      .slice(0, MAX_ADMISSION_TOMBSTONES)
    let serialized = checkpointString(
      stateEntries,
      tombstoneEntries,
      admissionEntries,
      admissionTombstoneEntries,
      now,
    )
    while (serialized.length > MAX_CHECKPOINT_CHARS && (stateEntries.length > 0 || tombstoneEntries.length > 0)) {
      const oldestStateAt = stateEntries[stateEntries.length - 1]?.[1].updatedAt ?? Number.POSITIVE_INFINITY
      const oldestTombstoneAt = tombstoneEntries[tombstoneEntries.length - 1]?.[1] ?? Number.POSITIVE_INFINITY
      if (oldestStateAt <= oldestTombstoneAt) stateEntries.pop()
      else tombstoneEntries.pop()
      serialized = checkpointString(
        stateEntries,
        tombstoneEntries,
        admissionEntries,
        admissionTombstoneEntries,
        now,
      )
    }
    if (serialized.length > MAX_CHECKPOINT_CHARS) return false
    storage.setItem(AGENT_COMPOSER_CHECKPOINT_STORAGE_KEY, serialized)
    return true
  } catch {
    return false
  }
}
