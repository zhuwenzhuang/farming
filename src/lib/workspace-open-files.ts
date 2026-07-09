import type { WorkspaceFile, WorkspaceFileChange, WorkspaceFileDeleteResult, WorkspaceFileMove } from './workspace-files'
import {
  applyWorkspaceFileMovesToOpenFile,
  applyWorkspaceFileMovesToOpenFileCache,
  applyWorkspaceFileMovesToOpenFiles,
  removeWorkspaceFileDeletionsFromOpenFileCache,
  removeWorkspaceFileDeletionsFromOpenFiles,
  workspaceFileDeletionMatchesOpenFile,
} from './workspace-file-operations'
import { isWorkspaceWorkingCopyClean, workspaceFileCacheKey } from './workspace-working-copy'

export interface WorkspaceFileOpenTarget {
  lineNumber?: number
  column?: number
  endColumn?: number
  view?: 'editor' | 'diff'
  diffOnly?: boolean
  globalRoot?: boolean
  revealInTree?: boolean
  sourceAgentId?: string
  transient?: boolean
  suppressSearchOnMiss?: boolean
  gitStatus?: WorkspaceFile['gitStatus']
  gitStatusLabel?: string
}

export interface WorkspaceFileCursor {
  lineNumber: number
  column?: number
  endColumn?: number
  requestId: number
}

export interface WorkspaceOpenFileRequest {
  cursor?: WorkspaceFileCursor
  diffRequestId?: number
  diffOnly?: boolean
  workspaceRoot?: string
  sourceAgentId?: string
  transient?: boolean
}

type WorkspaceOpenFileRequestInput = WorkspaceOpenFileRequest | WorkspaceFileCursor

function normalizeWorkspaceOpenFileRequest(options: WorkspaceOpenFileRequestInput): WorkspaceOpenFileRequest {
  if ('lineNumber' in options && 'requestId' in options) {
    return { cursor: options }
  }
  return options
}

export interface OpenWorkspaceFile {
  agentId: string
  sourceAgentId?: string
  workspaceRoot?: string
  file: WorkspaceFile
  draft: string
  dirty: boolean
  externalChanged: boolean
  saving: boolean
  error: string | null
  cursor?: WorkspaceFileCursor
  diffRequestId?: number
  diffOnly?: boolean
  transient?: boolean
}

export interface WorkspaceOpenFileTarget {
  agentId: string
  filePath: string
  workspaceRoot?: string
}

export interface WorkspaceOpenFilesState {
  activeFile: OpenWorkspaceFile | null
  files: OpenWorkspaceFile[]
  closedFileCache: Map<string, OpenWorkspaceFile>
}

export interface WorkspaceOpenFilesCloseResult extends WorkspaceOpenFilesState {
  closedFiles: OpenWorkspaceFile[]
  activeFileClosed: boolean
}

export interface WorkspaceOpenFilesDeleteResult extends WorkspaceOpenFilesState {
  activeFileDeleted: boolean
}

export interface WorkspaceOpenFilesReopenOptions {
  canReopen?: (file: OpenWorkspaceFile) => boolean
}

export interface WorkspaceOpenFileDirtySnapshot {
  agentId: string
  path: string
  dirty?: boolean
  externalChanged?: boolean
}

const MAX_CLOSED_WORKSPACE_FILE_CACHE = 32

function rememberClosedWorkspaceOpenFile(cache: Map<string, OpenWorkspaceFile>, file: OpenWorkspaceFile) {
  const fileHandle = workspaceOpenFileKey(file)
  cache.delete(fileHandle)
  cache.set(fileHandle, { ...file, saving: false })

  while (cache.size > MAX_CLOSED_WORKSPACE_FILE_CACHE) {
    const oldestKey = cache.keys().next().value
    if (typeof oldestKey !== 'string') break
    cache.delete(oldestKey)
  }
}

export function workspaceFileCursorForTarget(target: WorkspaceFileOpenTarget | undefined, requestId: number): WorkspaceFileCursor | undefined {
  if (!target?.lineNumber) return undefined
  return {
    lineNumber: target.lineNumber,
    column: target.column,
    endColumn: target.endColumn,
    requestId,
  }
}

export function workspaceFileDiffRequestForTarget(target: WorkspaceFileOpenTarget | undefined, requestId: number): number | undefined {
  return target?.view === 'diff' ? requestId : undefined
}

export function workspaceFileDiffOnlyForTarget(target: WorkspaceFileOpenTarget | undefined): boolean | undefined {
  return target?.diffOnly === true ? true : undefined
}

export function workspaceOpenFileRequestForTarget(
  target: WorkspaceFileOpenTarget | undefined,
  requestIds: { cursorRequestId: number; diffRequestId: number }
): WorkspaceOpenFileRequest {
  return {
    cursor: workspaceFileCursorForTarget(target, requestIds.cursorRequestId),
    diffRequestId: workspaceFileDiffRequestForTarget(target, requestIds.diffRequestId),
    diffOnly: workspaceFileDiffOnlyForTarget(target),
    transient: target?.transient,
  }
}

export function deletedWorkspaceDiffPlaceholderFile(filePath: string, target: WorkspaceFileOpenTarget): WorkspaceFile {
  return {
    path: filePath,
    content: '',
    size: 0,
    mtimeMs: 0,
    sha1: `deleted:${filePath}`,
    gitStatus: 'deleted',
    gitStatusLabel: target.gitStatusLabel || 'D',
  }
}

export function shouldOpenMissingWorkspaceFileAsDiff(target?: WorkspaceFileOpenTarget) {
  return target?.view === 'diff' && target.diffOnly === true && target.gitStatus === 'deleted'
}

export function shouldRevealSelectedWorkspaceOpenFile(target?: WorkspaceFileOpenTarget) {
  return target?.revealInTree !== false && target?.gitStatus !== 'deleted'
}

export function workspaceFileOpenTargetForChange(change: WorkspaceFileChange): WorkspaceFileOpenTarget {
  return {
    view: change.gitStatus === 'untracked' ? 'editor' : 'diff',
    diffOnly: change.gitStatus === 'deleted',
    revealInTree: false,
    gitStatus: change.gitStatus,
    gitStatusLabel: change.gitStatusLabel,
  }
}

export function workspaceFileChangePathLabel(change: WorkspaceFileChange) {
  return change.previousPath ? `${change.previousPath} -> ${change.path}` : change.path
}

export function workspaceFileChangeRowKey(change: WorkspaceFileChange) {
  return `${change.gitStatus}:${change.previousPath || ''}:${change.path}`
}

export function workspaceFileChangeTitle(change: WorkspaceFileChange, gitStatusLabel: string) {
  return `${workspaceFileChangePathLabel(change)} · ${gitStatusLabel}`
}

export function workspaceOpenFileDirtyStateForAgent(
  openFiles: readonly WorkspaceOpenFileDirtySnapshot[],
  agentId: string | null
) {
  const state = new Map<string, boolean>()
  if (!agentId) return state
  openFiles.forEach(file => {
    if (file.agentId !== agentId) return
    state.set(file.path, Boolean(file.dirty || file.externalChanged))
  })
  return state
}

export function shouldRefreshWorkspaceChangesAfterDirtyStateChange(
  previous: ReadonlyMap<string, boolean>,
  next: ReadonlyMap<string, boolean>
) {
  for (const [path, wasDirty] of previous) {
    if (wasDirty === true && next.get(path) === false) return true
  }
  return false
}

export function workspaceOpenFileKey(file: Pick<OpenWorkspaceFile, 'agentId' | 'file' | 'workspaceRoot'>) {
  return workspaceFileCacheKey(file.agentId, file.file.path, file.workspaceRoot)
}

export function workspaceOpenFileTargetKey(target: WorkspaceOpenFileTarget) {
  return workspaceFileCacheKey(target.agentId, target.filePath, target.workspaceRoot)
}

export function isSameOpenWorkspaceFile(file: OpenWorkspaceFile, agentId: string, filePath: string, workspaceRoot?: string) {
  return workspaceOpenFileKey(file) === workspaceFileCacheKey(agentId, filePath, workspaceRoot)
}

export function findOpenWorkspaceFile(files: readonly OpenWorkspaceFile[], agentId: string, filePath: string, workspaceRoot?: string) {
  return files.find(file => isSameOpenWorkspaceFile(file, agentId, filePath, workspaceRoot)) ?? null
}

export function replaceOpenWorkspaceFile(files: readonly OpenWorkspaceFile[], nextFile: OpenWorkspaceFile) {
  const index = files.findIndex(file => workspaceOpenFileKey(file) === workspaceOpenFileKey(nextFile))
  if (index === -1) return [...files, nextFile]
  const nextFiles = [...files]
  nextFiles[index] = nextFile
  return nextFiles
}

export function refreshOpenWorkspaceFileFromRead(openFile: OpenWorkspaceFile, file: OpenWorkspaceFile['file']) {
  if (!openFile.dirty) {
    return {
      ...openFile,
      file,
      draft: file.content,
      dirty: false,
      externalChanged: false,
      saving: false,
      error: null,
    }
  }

  const nextDirty = openFile.draft !== file.content
  return {
    ...openFile,
    file,
    draft: openFile.draft,
    dirty: nextDirty,
    externalChanged: nextDirty && (openFile.externalChanged || openFile.file.sha1 !== file.sha1),
    saving: false,
    error: null,
  }
}

export function createWorkspaceOpenFile(
  agentId: string,
  file: WorkspaceFile,
  options: WorkspaceOpenFileRequestInput = {}
): OpenWorkspaceFile {
  const request = normalizeWorkspaceOpenFileRequest(options)
  return {
    agentId,
    sourceAgentId: request.sourceAgentId,
    workspaceRoot: request.workspaceRoot,
    file,
    draft: file.content,
    dirty: false,
    externalChanged: false,
    saving: false,
    error: null,
    cursor: request.cursor,
    diffRequestId: request.diffRequestId,
    diffOnly: request.diffOnly,
    transient: request.transient,
  }
}

export function openWorkspaceFileFromRead(
  state: WorkspaceOpenFilesState,
  agentId: string,
  file: WorkspaceFile,
  options: WorkspaceOpenFileRequestInput = {}
): WorkspaceOpenFilesState {
  const request = normalizeWorkspaceOpenFileRequest(options)
  const closedFileCache = new Map(state.closedFileCache)
  const cacheKey = workspaceFileCacheKey(agentId, file.path, request.workspaceRoot)
  const cachedFile = closedFileCache.get(cacheKey)
  const existingFile = findOpenWorkspaceFile(state.files, agentId, file.path, request.workspaceRoot)
  const restoredFile = !existingFile && cachedFile && cachedFile.draft !== file.content
    ? refreshOpenWorkspaceFileFromRead(cachedFile, file)
    : null
  if (cachedFile && !restoredFile) {
    closedFileCache.delete(cacheKey)
  }

  const baseFile = existingFile
    ? refreshOpenWorkspaceFileFromRead(existingFile, file)
    : restoredFile ?? createWorkspaceOpenFile(agentId, file)
  const nextTransient = Boolean(request.transient ?? baseFile.transient) && isWorkspaceWorkingCopyClean(baseFile)
  const nextFile = {
    ...baseFile,
    agentId,
    sourceAgentId: request.sourceAgentId ?? baseFile.sourceAgentId,
    workspaceRoot: request.workspaceRoot ?? baseFile.workspaceRoot,
    file: baseFile.file,
    cursor: request.cursor,
    diffRequestId: request.diffRequestId,
    diffOnly: request.diffOnly === true,
    transient: nextTransient,
  }

  const files = nextFile.transient
    ? state.files.filter(candidate => (
        workspaceOpenFileKey(candidate) === workspaceOpenFileKey(nextFile) ||
        !candidate.transient ||
        !isWorkspaceWorkingCopyClean(candidate)
      ))
    : state.files

  return {
    activeFile: nextFile,
    files: replaceOpenWorkspaceFile(files, nextFile),
    closedFileCache,
  }
}

export function selectWorkspaceOpenFile(
  state: WorkspaceOpenFilesState,
  agentId: string,
  filePath: string,
  options: WorkspaceOpenFileRequestInput = {}
): WorkspaceOpenFilesState | null {
  const request = normalizeWorkspaceOpenFileRequest(options)
  const nextFile = findOpenWorkspaceFile(state.files, agentId, filePath, request.workspaceRoot)
  if (!nextFile) return null
  const hasViewRequest = Boolean(request.cursor || request.diffRequestId || request.diffOnly !== undefined || nextFile.diffRequestId)
  const selectedFile = hasViewRequest
    ? {
        ...nextFile,
        sourceAgentId: request.sourceAgentId ?? nextFile.sourceAgentId,
        cursor: request.cursor ?? nextFile.cursor,
        diffRequestId: request.diffRequestId,
        diffOnly: request.diffOnly ?? nextFile.diffOnly,
        transient: request.transient ?? nextFile.transient,
      }
    : nextFile
  return {
    activeFile: selectedFile,
    files: hasViewRequest ? replaceOpenWorkspaceFile(state.files, selectedFile) : state.files,
    closedFileCache: state.closedFileCache,
  }
}

export function closeWorkspaceOpenFiles(
  state: WorkspaceOpenFilesState,
  targets: readonly WorkspaceOpenFileTarget[]
): WorkspaceOpenFilesCloseResult {
  const targetKeys = new Set(targets.map(workspaceOpenFileTargetKey))
  if (targetKeys.size === 0) {
    return { ...state, closedFiles: [], activeFileClosed: false }
  }

  const closedFiles = state.files.filter(file => targetKeys.has(workspaceOpenFileKey(file)))
  if (closedFiles.length === 0) {
    return { ...state, closedFiles: [], activeFileClosed: false }
  }

  const closedFileCache = new Map(state.closedFileCache)
  closedFiles.forEach(file => {
    rememberClosedWorkspaceOpenFile(closedFileCache, file)
  })

  const files = state.files.filter(file => !targetKeys.has(workspaceOpenFileKey(file)))
  const activeFileClosed = Boolean(
    state.activeFile &&
    targetKeys.has(workspaceOpenFileKey(state.activeFile))
  )
  if (!activeFileClosed || !state.activeFile) {
    return {
      activeFile: state.activeFile,
      files,
      closedFileCache,
      closedFiles,
      activeFileClosed: false,
    }
  }

  const closedIndex = state.files.findIndex(file => state.activeFile && workspaceOpenFileKey(file) === workspaceOpenFileKey(state.activeFile))
  const replacement = [...state.files.slice(0, closedIndex)]
    .reverse()
    .find(file => !targetKeys.has(workspaceOpenFileKey(file)))
    ?? state.files.slice(closedIndex + 1).find(file => !targetKeys.has(workspaceOpenFileKey(file)))
    ?? null

  return {
    activeFile: replacement,
    files,
    closedFileCache,
    closedFiles,
    activeFileClosed: true,
  }
}

export function reopenLastClosedWorkspaceOpenFile(
  state: WorkspaceOpenFilesState,
  options: WorkspaceOpenFilesReopenOptions = {}
): WorkspaceOpenFilesState | null {
  if (state.closedFileCache.size === 0) return null

  const closedFileCache = new Map(state.closedFileCache)
  const closedFiles = Array.from(closedFileCache.entries()).reverse()

  for (const [fileHandle, cachedFile] of closedFiles) {
    closedFileCache.delete(fileHandle)
    if (options.canReopen && !options.canReopen(cachedFile)) continue
    if (findOpenWorkspaceFile(state.files, cachedFile.agentId, cachedFile.file.path, cachedFile.workspaceRoot)) continue

    const nextFile = { ...cachedFile, saving: false }
    return {
      activeFile: nextFile,
      files: replaceOpenWorkspaceFile(state.files, nextFile),
      closedFileCache,
    }
  }

  return null
}

export function updateWorkspaceOpenFile(
  state: WorkspaceOpenFilesState,
  nextFile: OpenWorkspaceFile
): WorkspaceOpenFilesState {
  const closedFileCache = new Map(state.closedFileCache)
  if (isWorkspaceWorkingCopyClean(nextFile)) {
    closedFileCache.delete(workspaceOpenFileKey(nextFile))
  }

  return {
    activeFile: nextFile,
    files: replaceOpenWorkspaceFile(state.files, nextFile),
    closedFileCache,
  }
}

export function updateWorkspaceOpenFileDraft(file: OpenWorkspaceFile, nextDraft: string): OpenWorkspaceFile {
  return {
    ...file,
    draft: nextDraft,
    dirty: nextDraft !== file.file.content,
    error: null,
    transient: false,
  }
}

export function moveWorkspaceOpenFiles(
  state: WorkspaceOpenFilesState,
  agentId: string,
  moves: readonly WorkspaceFileMove[]
): WorkspaceOpenFilesState {
  if (moves.length === 0) return state
  return {
    activeFile: state.activeFile ? applyWorkspaceFileMovesToOpenFile(state.activeFile, agentId, moves) : state.activeFile,
    files: applyWorkspaceFileMovesToOpenFiles(state.files, agentId, moves),
    closedFileCache: applyWorkspaceFileMovesToOpenFileCache(state.closedFileCache.values(), agentId, moves),
  }
}

export function deleteWorkspaceOpenFiles(
  state: WorkspaceOpenFilesState,
  agentId: string,
  deletions: readonly WorkspaceFileDeleteResult[]
): WorkspaceOpenFilesDeleteResult {
  if (deletions.length === 0) return { ...state, activeFileDeleted: false }

  const files = removeWorkspaceFileDeletionsFromOpenFiles(state.files, agentId, deletions)
  const activeFileDeleted = Boolean(
    state.activeFile && workspaceFileDeletionMatchesOpenFile(state.activeFile, agentId, deletions)
  )

  return {
    activeFile: activeFileDeleted ? files[0] ?? null : state.activeFile,
    files,
    closedFileCache: removeWorkspaceFileDeletionsFromOpenFileCache(state.closedFileCache.values(), agentId, deletions),
    activeFileDeleted,
  }
}
