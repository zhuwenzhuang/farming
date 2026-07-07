import { appPath } from './base-path'

export interface WorkspaceFileEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink' | 'other'
  size: number
  mtimeMs: number
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
  gitStatus?: WorkspaceFileEntry['gitStatus']
  gitStatusLabel?: string
  binary?: boolean
  preview?: (
    | { kind: 'image'; mediaType: string }
    | { kind: 'binary'; mediaType: string }
    | { kind: 'large-text'; mediaType: string; truncated?: boolean }
  )
}

export interface WorkspaceFileMove {
  sourcePath: string
  targetPath: string
  sourceDirectory: string
  targetDirectory: string
}

export interface WorkspaceFileCreateResult {
  entry: WorkspaceFileEntry
  file?: WorkspaceFile
}

export interface WorkspaceFileDeleteResult {
  path: string
  parentDirectory: string
  type: WorkspaceFileEntry['type']
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

export interface WorkspaceFileBlame {
  isGitRepo: boolean
  path: string
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
}

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

export async function fetchWorkspaceTree(agentId: string, directoryPath = '') {
  const params = new URLSearchParams({ agentId })
  if (directoryPath) params.set('path', directoryPath)
  const response = await fetch(appPath(`/api/files/tree?${params.toString()}`))
  const body = await readJson<{ tree: { path: string; items: WorkspaceFileEntry[]; gitStatusPending?: boolean } }>(response)
  return body.tree
}

export async function fetchWorkspaceFile(agentId: string, filePath: string) {
  const params = new URLSearchParams({ agentId, path: filePath })
  const response = await fetch(appPath(`/api/files/file?${params.toString()}`))
  const body = await readJson<{ file: WorkspaceFile }>(response)
  return body.file
}

export function rawWorkspaceFileUrl(agentId: string, filePath: string, sha1?: string) {
  const params = new URLSearchParams({ agentId, path: filePath })
  if (sha1) params.set('sha1', sha1)
  return appPath(`/api/files/raw?${params.toString()}`)
}

export async function saveWorkspaceFile(agentId: string, filePath: string, content: string, baseSha1: string, overwrite = false) {
  const response = await fetch(appPath('/api/files/file'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      path: filePath,
      content,
      baseSha1,
      overwrite,
    }),
  })
  const body = await readJson<{ file: WorkspaceFile }>(response)
  return body.file
}

export async function moveWorkspaceEntry(agentId: string, sourcePath: string, targetDirectory: string) {
  const response = await fetch(appPath('/api/files/move'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      sourcePath,
      targetDirectory,
    }),
  })
  const body = await readJson<{ move: WorkspaceFileMove }>(response)
  return body.move
}

export async function createWorkspaceEntry(
  agentId: string,
  parentPath: string,
  name: string,
  entryType: 'file' | 'directory'
) {
  const response = await fetch(appPath('/api/files/entry'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      parentPath,
      name,
      entryType,
    }),
  })
  return readJson<WorkspaceFileCreateResult>(response)
}

export async function renameWorkspaceEntry(agentId: string, filePath: string, name: string) {
  const response = await fetch(appPath('/api/files/entry'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      path: filePath,
      name,
    }),
  })
  const body = await readJson<{ move: WorkspaceFileMove }>(response)
  return body.move
}

export async function deleteWorkspaceEntry(agentId: string, filePath: string) {
  const params = new URLSearchParams({ agentId, path: filePath })
  const response = await fetch(appPath(`/api/files/entry?${params.toString()}`), {
    method: 'DELETE',
  })
  const body = await readJson<{ deleted: WorkspaceFileDeleteResult }>(response)
  return body.deleted
}

export async function fetchWorkspaceBlame(agentId: string, filePath: string) {
  const params = new URLSearchParams({ agentId, path: filePath })
  const response = await fetch(appPath(`/api/files/blame?${params.toString()}`))
  const body = await readJson<{ blame: WorkspaceFileBlame }>(response)
  return body.blame
}

export async function fetchWorkspaceBlameCapability(agentId: string, filePath: string) {
  const params = new URLSearchParams({ agentId, path: filePath })
  const response = await fetch(appPath(`/api/files/blame-capability?${params.toString()}`))
  const body = await readJson<{ capability: WorkspaceFileBlameCapability }>(response)
  return body.capability
}

export async function fetchWorkspaceDiff(agentId: string, filePath: string) {
  const params = new URLSearchParams({ agentId, path: filePath })
  const response = await fetch(appPath(`/api/files/diff?${params.toString()}`))
  const body = await readJson<{ diff: WorkspaceFileDiff }>(response)
  return body.diff
}

export async function fetchWorkspaceChanges(agentId: string, options: { limit?: number; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ agentId })
  if (options.limit) params.set('limit', String(options.limit))
  const response = await fetch(appPath(`/api/files/changes?${params.toString()}`), { signal: options.signal })
  const body = await readJson<{ changes: WorkspaceFileChanges }>(response)
  return body.changes
}

export async function fetchWorkspaceLineChanges(agentId: string, filePath: string, lineNumber: number, mode: WorkspaceFileLineChanges['mode']) {
  const params = new URLSearchParams({ agentId, path: filePath, lineNumber: String(lineNumber), mode })
  const response = await fetch(appPath(`/api/files/line-changes?${params.toString()}`))
  const body = await readJson<{ changes: WorkspaceFileLineChanges }>(response)
  return body.changes
}

export async function searchWorkspaceFiles(agentId: string, query: string, options: { path?: string; limit?: number; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ agentId, q: query })
  if (options.path) params.set('path', options.path)
  if (options.limit) params.set('limit', String(options.limit))
  const response = await fetch(appPath(`/api/files/search?${params.toString()}`), { signal: options.signal })
  const body = await readJson<{ results: WorkspaceFileSearchResult }>(response)
  return body.results
}
