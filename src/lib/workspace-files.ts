import { appPath } from './base-path'
import type { WorkspaceRequest } from '../../shared/browser-protocol'
import {
  requestWorkspace,
  WorkspaceTransportError,
  workspaceInlineMessageLimit,
} from './workspace-request-client'
import type { WorkspaceFileDecorationEntry } from './workspace-file-decorations'

export interface WorkspaceFileEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink' | 'other'
  size: number
  mtimeMs: number
  version?: string
  ignored?: boolean
  symbolicLink?: boolean
  external?: boolean
  readOnly?: boolean
  linkTarget?: string
  linkError?: 'broken' | 'outside-allowed-roots' | 'unavailable'
  gitStatus?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
  gitStatusLabel?: string
  descendantGitStatus?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
}

export interface WorkspaceFile {
  path: string
  content: string
  size: number
  mtimeMs: number
  sha1: string
  symbolicLink?: boolean
  external?: boolean
  readOnly?: boolean
  gitStatus?: WorkspaceFileEntry['gitStatus']
  gitStatusLabel?: string
  binary?: boolean
  preview?: (
    | { kind: 'image'; mediaType: string }
    | { kind: 'pdf'; mediaType: string }
    | { kind: 'binary'; mediaType: string }
    | { kind: 'large-text'; mediaType: string; truncated?: boolean }
  )
  transfer?: { kind: 'http' }
}

export interface WorkspaceFileMove {
  sourcePath: string
  targetPath: string
  sourceDirectory: string
  targetDirectory: string
  sourceVersion?: string
  targetVersion?: string
}

export interface WorkspaceFileCreateResult {
  entry: WorkspaceFileEntry
  file?: WorkspaceFile
}

export interface WorkspaceFileDeleteResult {
  path: string
  parentDirectory: string
  type: WorkspaceFileEntry['type']
  version?: string
}

export interface WorkspaceFileBlameLine {
  lineNumber: number
  originalLineNumber: number
  commit: string
  shortCommit: string
  author: string
  authorMail: string
  authorTime: number | null
  authorTimeIso: string
  summary: string
  content: string
  uncommitted: boolean
}

export interface WorkspaceIssueLinkRule {
  issueRegexp: string
  linkRegexp: string
}

export interface WorkspaceFileBlame {
  isGitRepo: boolean
  path: string
  commitUrlTemplate?: string
  authorUrlTemplate?: string
  issueLinkRules?: WorkspaceIssueLinkRule[]
  lines: WorkspaceFileBlameLine[]
}

export interface WorkspaceFileBlameCapability {
  isGitRepo: boolean
  path: string
  available: boolean
  reason?: string
}

export interface WorkspaceFileDiff {
  isGitRepo: boolean
  path: string
  patch: string
  truncated?: boolean
  originalContent?: string
  modifiedContent?: string
  binary?: boolean
  untracked?: boolean
  deleted?: boolean
}

export interface WorkspaceFileChange {
  path: string
  name: string
  type: WorkspaceFileEntry['type']
  gitStatus: NonNullable<WorkspaceFileEntry['gitStatus']>
  gitStatusLabel: string
  previousPath?: string
}

export interface WorkspaceFileChanges {
  items: WorkspaceFileChange[]
  truncated: boolean
}

export interface WorkspaceGitWorktree {
  workspace: string
  head: string
  branch: string
  bare: boolean
  detached: boolean
  locked: boolean
  lockReason: string
  prunable: boolean
  pruneReason: string
  current: boolean
  main: boolean
}

export interface WorkspaceGitWorktrees {
  isGitRepo: boolean
  commonDir: string
  currentWorkspace: string
  mainWorkspace: string
  items: WorkspaceGitWorktree[]
}

export type WorkspaceGitBranchBlockedReason =
  | ''
  | 'not-git-repository'
  | 'not-main-worktree'
  | 'dirty-worktree'
  | 'no-switchable-branch'
  | 'active-agents'
  | 'pending-agent-starts'

export interface WorkspaceGitBranch {
  name: string
  head: string
  current: boolean
  checkedOutWorkspace: string
}

export interface WorkspaceGitBranches {
  isGitRepo: boolean
  workspace: string
  mainWorkspace: string
  currentBranch: string
  head: string
  dirtyCount: number
  canSwitch: boolean
  blockedReasonCode: WorkspaceGitBranchBlockedReason
  blockedReason: string
  blockingAgentIds: string[]
  items: WorkspaceGitBranch[]
  truncated: boolean
}

export interface WorkspaceGitBranchSwitchResult extends WorkspaceGitBranches {
  switched: boolean
  uncertain: boolean
  requestId: string
  previousBranch?: string
  previousHead?: string
  error?: string
}

export interface WorkspaceGitHistoryReference {
  id: string
  name: string
  category: 'head' | 'local-branch' | 'remote-branch' | 'tag' | 'reference'
}

export interface WorkspaceGitHistoryItem {
  id: string
  displayId: string
  parentIds: string[]
  subject: string
  message: string
  author: string
  authorEmail: string
  timestamp?: number
  references: WorkspaceGitHistoryReference[]
}

export interface WorkspaceGitHistory {
  isGitRepo: boolean
  branch: string
  head: string
  scope: 'current' | 'all'
  items: WorkspaceGitHistoryItem[]
  hasMore: boolean
  nextSkip: number | null
}

export interface WorkspaceGitHistoryChange {
  path: string
  previousPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'type-changed'
  statusLabel: string
}

export interface WorkspaceGitHistoryChanges {
  commit: string
  comparisonBase: string
  parent: string | null
  parentIds: string[]
  items: WorkspaceGitHistoryChange[]
  truncated: boolean
}

export interface WorkspaceFileLineChangesHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  heading: string
  patch: string
}

export interface WorkspaceFileLineChanges {
  isGitRepo: boolean
  path: string
  mode: 'working' | 'previous'
  lineNumber: number
  lookupLineNumber: number
  targetSide: 'working' | 'revision'
  available: boolean
  reason?: string
  patch: string
  hunk: WorkspaceFileLineChangesHunk | null
  truncated?: boolean
  commit?: {
    hash: string
    shortHash: string
    author: string
    authorTimeIso: string
    summary: string
  }
}

export interface WorkspaceFileSearchMatch {
  kind?: 'content' | 'path'
  entryType?: WorkspaceFileEntry['type']
  path: string
  lineNumber: number
  lines: string
  ranges: Array<{ start: number; end: number }>
}

export interface WorkspaceFileSearchResult {
  query: string
  path: string
  matches: WorkspaceFileSearchMatch[]
  truncated: boolean
  timeoutMs?: number
}

const WORKSPACE_FILE_SEARCH_REQUEST_TIMEOUT_MS = 185_000

export class WorkspaceFileApiError extends Error {
  status: number
  details: unknown

  constructor(message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'WorkspaceFileApiError'
    this.status = status
    this.details = details
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string; details?: unknown }
  if (!response.ok) {
    throw new WorkspaceFileApiError(body.error || `Workspace file request failed (${response.status})`, response.status, body.details)
  }
  return body as T
}

async function runWorkspaceRequest<T>(
  request: WorkspaceRequest,
  options: { mutation?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  try {
    return await requestWorkspace<T>(request, options)
  } catch (error) {
    if (error instanceof WorkspaceTransportError) {
      const structuredDetails = error.details && typeof error.details === 'object'
        ? error.details as Record<string, unknown>
        : null
      throw new WorkspaceFileApiError(error.message, error.status, {
        ...(structuredDetails ?? (error.details === undefined ? {} : { details: error.details })),
        code: error.code,
        uncertain: error.uncertain,
      })
    }
    throw error
  }
}

export async function fetchWorkspaceTree(rootId: string, directoryPath = '', options: { signal?: AbortSignal } = {}) {
  return runWorkspaceRequest<{ path: string; items: WorkspaceFileEntry[] }>({
    operation: 'tree',
    rootId,
    ...(directoryPath ? { path: directoryPath } : {}),
  }, { signal: options.signal })
}

const MAX_WORKSPACE_TREE_DECORATION_ENTRIES = 4096
const WORKSPACE_REQUEST_ENVELOPE_RESERVE_BYTES = 4096

export function workspaceTreeDecorationBatches(
  rootId: string,
  directoryPath: string,
  entryPaths: string[],
  maxRequestBytes = workspaceInlineMessageLimit() - WORKSPACE_REQUEST_ENVELOPE_RESERVE_BYTES,
) {
  const emptyRequest: WorkspaceRequest = {
    operation: 'tree-decorations',
    rootId,
    ...(directoryPath ? { path: directoryPath } : {}),
    entryPaths: [],
  }
  const encoder = new TextEncoder()
  const baseBytes = encoder.encode(JSON.stringify(emptyRequest)).byteLength - 2
  const batches: string[][] = []
  let batch: string[] = []
  let batchBytes = baseBytes + 2

  for (const entryPath of entryPaths) {
    const entryBytes = encoder.encode(JSON.stringify(entryPath)).byteLength + (batch.length > 0 ? 1 : 0)
    if (batch.length > 0 && (
      batch.length >= MAX_WORKSPACE_TREE_DECORATION_ENTRIES
      || batchBytes + entryBytes > maxRequestBytes
    )) {
      batches.push(batch)
      batch = []
      batchBytes = baseBytes + 2
    }
    const firstEntryBytes = encoder.encode(JSON.stringify(entryPath)).byteLength
    if (batchBytes + firstEntryBytes > maxRequestBytes) {
      throw new Error('Workspace tree decoration path exceeds the inline request limit')
    }
    batch.push(entryPath)
    batchBytes += firstEntryBytes + (batch.length > 1 ? 1 : 0)
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

export async function fetchWorkspaceTreeDecorations(
  rootId: string,
  directoryPath: string,
  entryPaths: string[],
  options: { signal?: AbortSignal } = {},
) {
  const items: WorkspaceFileDecorationEntry[] = []
  for (const batch of workspaceTreeDecorationBatches(rootId, directoryPath, entryPaths)) {
    const result = await runWorkspaceRequest<{ path: string; items: WorkspaceFileDecorationEntry[] }>({
      operation: 'tree-decorations',
      rootId,
      ...(directoryPath ? { path: directoryPath } : {}),
      entryPaths: batch,
    }, { signal: options.signal })
    items.push(...result.items)
  }
  return { path: directoryPath, items }
}

export async function fetchWorkspaceFile(rootId: string, filePath: string, options: { signal?: AbortSignal; exactExternal?: boolean } = {}) {
  const file = await runWorkspaceRequest<WorkspaceFile>({
    operation: 'read-file',
    rootId,
    path: filePath,
    ...(options.exactExternal ? { exactExternal: true } : {}),
  }, { signal: options.signal })
  if (file.transfer?.kind !== 'http') return file
  const response = await fetch(rawWorkspaceFileUrl(rootId, filePath, file.sha1, {
    exactExternal: options.exactExternal,
    transfer: true,
  }), {
    cache: 'no-store',
    signal: options.signal,
  })
  if (!response.ok) {
    throw new WorkspaceFileApiError(`Workspace file transfer failed (${response.status})`, response.status)
  }
  return { ...file, content: await response.text(), transfer: undefined }
}

export function rawWorkspaceFileUrl(rootId: string, filePath: string, sha1?: string, options: { exactExternal?: boolean; transfer?: boolean } = {}) {
  const params = new URLSearchParams({ rootId, path: filePath })
  if (sha1) params.set('sha1', sha1)
  if (options.exactExternal) params.set('exact', '1')
  if (options.transfer) params.set('transfer', '1')
  return appPath(`/api/files/raw?${params.toString()}`)
}

export interface WorkspaceHtmlPreviewSession {
  id: string
  kind: 'static'
  expiresAt: number
}

export async function createWorkspaceHtmlPreview(
  rootId: string,
  filePath: string,
  options: { signal?: AbortSignal; exactExternal?: boolean } = {},
) {
  return runWorkspaceRequest<WorkspaceHtmlPreviewSession>({
    operation: 'create-preview',
    rootId,
    path: filePath,
    ...(options.exactExternal ? { exactExternal: true } : {}),
  }, { signal: options.signal })
}

export function workspaceHtmlPreviewUrl(previewId: string, scope: 'base' | 'root', resourcePath = '') {
  const pathPrefix = appPath(`/api/files/previews/${encodeURIComponent(previewId)}/${scope}/`)
  return resourcePath ? `${pathPrefix}${resourcePath.replace(/^\/+/, '')}` : pathPrefix
}

export async function deleteWorkspaceHtmlPreview(previewId: string) {
  await runWorkspaceRequest<{ deleted: boolean }>({ operation: 'delete-preview', previewId })
}

export async function saveWorkspaceFile(rootId: string, filePath: string, content: string, baseSha1: string, overwrite = false) {
  const request: WorkspaceRequest = {
    operation: 'save-file',
    rootId,
    path: filePath,
    content,
    baseSha1,
    overwrite,
  }
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength < workspaceInlineMessageLimit() - 4096) {
    return runWorkspaceRequest<WorkspaceFile>(request, { mutation: true })
  }
  const response = await fetch(appPath('/api/files/file'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rootId,
      path: filePath,
      content,
      baseSha1,
      overwrite,
    }),
  })
  const body = await readJson<{ file: WorkspaceFile }>(response)
  return body.file
}

export async function moveWorkspaceEntry(rootId: string, sourcePath: string, targetDirectory: string, expectedVersion?: string) {
  return runWorkspaceRequest<WorkspaceFileMove>({
    operation: 'move-entry',
    rootId,
    sourcePath,
    targetDirectory,
    ...(expectedVersion ? { expectedVersion } : {}),
  }, { mutation: true })
}

export async function createWorkspaceEntry(
  rootId: string,
  parentPath: string,
  name: string,
  entryType: 'file' | 'directory',
  options: { signal?: AbortSignal } = {},
) {
  return runWorkspaceRequest<WorkspaceFileCreateResult>({
    operation: 'create-entry',
    rootId,
    parentPath,
    name,
    entryType,
  }, { mutation: true, signal: options.signal })
}

export async function renameWorkspaceEntry(
  rootId: string,
  filePath: string,
  name: string,
  expectedVersion?: string,
  options: { signal?: AbortSignal } = {},
) {
  return runWorkspaceRequest<WorkspaceFileMove>({
    operation: 'rename-entry',
    rootId,
    path: filePath,
    name,
    ...(expectedVersion ? { expectedVersion } : {}),
  }, { mutation: true, signal: options.signal })
}

export async function deleteWorkspaceEntry(
  rootId: string,
  filePath: string,
  expectedVersion?: string,
  options: { signal?: AbortSignal } = {},
) {
  return runWorkspaceRequest<WorkspaceFileDeleteResult>({
    operation: 'delete-entry',
    rootId,
    path: filePath,
    ...(expectedVersion ? { expectedVersion } : {}),
  }, { mutation: true, signal: options.signal })
}

export async function fetchWorkspaceBlame(rootId: string, filePath: string) {
  return runWorkspaceRequest<WorkspaceFileBlame>({ operation: 'blame', rootId, path: filePath })
}

export async function fetchWorkspaceBlameCapability(rootId: string, filePath: string) {
  return runWorkspaceRequest<WorkspaceFileBlameCapability>({ operation: 'blame-capability', rootId, path: filePath })
}

export async function fetchWorkspaceDiff(rootId: string, filePath: string) {
  return runWorkspaceRequest<WorkspaceFileDiff>({ operation: 'diff', rootId, path: filePath })
}

export async function fetchWorkspaceChanges(rootId: string, options: { limit?: number; signal?: AbortSignal } = {}) {
  return runWorkspaceRequest<WorkspaceFileChanges>({
    operation: 'changes',
    rootId,
    ...(options.limit ? { limit: options.limit } : {}),
  }, { signal: options.signal })
}

export async function fetchWorkspaceGitWorktrees(rootId: string, options: { signal?: AbortSignal } = {}) {
  return runWorkspaceRequest<WorkspaceGitWorktrees>({ operation: 'worktrees', rootId }, { signal: options.signal })
}

export async function fetchWorkspaceGitBranches(rootId: string, options: { signal?: AbortSignal } = {}) {
  return runWorkspaceRequest<WorkspaceGitBranches>({ operation: 'branches', rootId }, { signal: options.signal })
}

export async function switchWorkspaceGitBranch(
  rootId: string,
  branch: string,
  expectedBranch: string,
  expectedHead: string,
  requestId: string,
  options: { signal?: AbortSignal } = {},
) {
  return runWorkspaceRequest<WorkspaceGitBranchSwitchResult>({
    operation: 'switch-branch',
    rootId,
    branch,
    expectedBranch,
    expectedHead,
    operationId: requestId,
  }, { mutation: true, signal: options.signal })
}

export async function fetchWorkspaceGitHistory(rootId: string, options: { limit?: number; skip?: number; scope?: WorkspaceGitHistory['scope']; signal?: AbortSignal } = {}) {
  return runWorkspaceRequest<WorkspaceGitHistory>({
    operation: 'history',
    rootId,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.skip ? { skip: options.skip } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  }, { signal: options.signal })
}

export async function fetchWorkspaceGitHistoryChanges(
  rootId: string,
  commit: string,
  options: { parent?: string; limit?: number; signal?: AbortSignal } = {},
) {
  return runWorkspaceRequest<WorkspaceGitHistoryChanges>({
    operation: 'history-changes',
    rootId,
    commit,
    ...(options.parent ? { parent: options.parent } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  }, { signal: options.signal })
}

export async function fetchWorkspaceLineChanges(rootId: string, filePath: string, lineNumber: number, mode: WorkspaceFileLineChanges['mode']) {
  return runWorkspaceRequest<WorkspaceFileLineChanges>({
    operation: 'line-changes', rootId, path: filePath, lineNumber, mode,
  })
}

export async function searchWorkspaceFiles(rootId: string, query: string, options: { includeIgnored?: boolean; path?: string; limit?: number; scope?: 'all' | 'file-path'; signal?: AbortSignal } = {}) {
  return runWorkspaceRequest<WorkspaceFileSearchResult>({
    operation: 'search',
    rootId,
    query,
    ...(options.includeIgnored ? { includeIgnored: true } : {}),
    ...(options.path ? { path: options.path } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  }, { signal: options.signal, timeoutMs: WORKSPACE_FILE_SEARCH_REQUEST_TIMEOUT_MS })
}
