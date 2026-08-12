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
  endLineNumber?: number
  endColumn?: number
  view?: 'editor' | 'diff'
  diffOnly?: boolean
  globalRoot?: boolean
  exactExternal?: boolean
  revealInTree?: boolean
  sourceAgentId?: string
  transient?: boolean
  focusEditor?: boolean
  suppressSearchOnMiss?: boolean
  gitStatus?: WorkspaceFile['gitStatus']
  gitStatusLabel?: string
}

export interface WorkspaceFileCursor {
  lineNumber: number
  column?: number
  endLineNumber?: number
  endColumn?: number
  requestId: number
}

export interface WorkspaceOpenFileRequest {
  cursor?: WorkspaceFileCursor
  diffRequestId?: number
  diffOnly?: boolean
  revealInTree?: boolean
  workspaceRoot?: string
  sourceAgentId?: string
  transient?: boolean
  focusEditorRequestId?: number
  exactExternal?: boolean
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
  revision: number
  externalChanged: boolean
  saving: boolean
  saveRequestId?: number
  saveRevision?: number
  error: string | null
  cursor?: WorkspaceFileCursor
  diffRequestId?: number
  diffOnly?: boolean
  revealInTree?: boolean
  transient?: boolean
  focusEditorRequestId?: number
  exactExternal?: boolean
}

export interface WorkspaceOpenFileTarget {
  agentId: string
  filePath: string
  workspaceRoot?: string
  saveRequestId?: number
}

export type WorkspaceOpenFileUpdater = (currentFile: OpenWorkspaceFile) => OpenWorkspaceFile

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

export type WorkspaceOpenFileDropPosition = 'before' | 'after'

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
  cache.set(fileHandle, {
    ...file,
    saving: false,
    saveRequestId: undefined,
    saveRevision: undefined,
  })

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
    ...(target.endLineNumber !== undefined ? { endLineNumber: target.endLineNumber } : {}),
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
  requestIds: { cursorRequestId: number; diffRequestId: number; focusEditorRequestId: number }
): WorkspaceOpenFileRequest {
  return {
    cursor: workspaceFileCursorForTarget(target, requestIds.cursorRequestId),
    diffRequestId: workspaceFileDiffRequestForTarget(target, requestIds.diffRequestId),
    diffOnly: workspaceFileDiffOnlyForTarget(target),
    revealInTree: target?.revealInTree,
    transient: target?.transient,
    focusEditorRequestId: target?.focusEditor ? requestIds.focusEditorRequestId : undefined,
    exactExternal: target?.exactExternal,
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
  return target?.revealInTree !== false
    && target?.focusEditor !== true
    && target?.gitStatus !== 'deleted'
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

export function workspaceOpenFileDirtyState(
  openFiles: readonly WorkspaceOpenFileDirtySnapshot[]
) {
  const state = new Map<string, boolean>()
  openFiles.forEach(file => {
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

export function findOpenWorkspaceFileForUpdate(
  files: readonly OpenWorkspaceFile[],
  target: WorkspaceOpenFileTarget
) {
  if (target.saveRequestId !== undefined) {
    return files.find(file => (
      file.agentId === target.agentId &&
      file.workspaceRoot === target.workspaceRoot &&
      file.saveRequestId === target.saveRequestId
    )) ?? null
  }
  return findOpenWorkspaceFile(
    files,
    target.agentId,
    target.filePath,
    target.workspaceRoot
  )
}

export function replaceOpenWorkspaceFile(files: readonly OpenWorkspaceFile[], nextFile: OpenWorkspaceFile) {
  const index = files.findIndex(file => workspaceOpenFileKey(file) === workspaceOpenFileKey(nextFile))
  if (index === -1) return [...files, nextFile]
  const nextFiles = [...files]
  nextFiles[index] = nextFile
  return nextFiles
}

export function reorderWorkspaceOpenFiles(
  state: WorkspaceOpenFilesState,
  sourceKey: string,
  targetKey: string,
  position: WorkspaceOpenFileDropPosition
): WorkspaceOpenFilesState {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return state
  const sourceIndex = state.files.findIndex(file => workspaceOpenFileKey(file) === sourceKey)
  const targetIndex = state.files.findIndex(file => workspaceOpenFileKey(file) === targetKey)
  if (sourceIndex < 0 || targetIndex < 0) return state

  const sourceFile = state.files[sourceIndex]
  if (!sourceFile) return state
  const files = state.files.filter((_, index) => index !== sourceIndex)
  const remainingTargetIndex = files.findIndex(file => workspaceOpenFileKey(file) === targetKey)
  if (remainingTargetIndex < 0) return state
  const insertIndex = position === 'before' ? remainingTargetIndex : remainingTargetIndex + 1
  files.splice(insertIndex, 0, sourceFile)
  if (files.every((file, index) => file === state.files[index])) return state

  return {
    activeFile: state.activeFile,
    files,
    closedFileCache: state.closedFileCache,
  }
}

export function refreshOpenWorkspaceFileFromRead(openFile: OpenWorkspaceFile, file: OpenWorkspaceFile['file']) {
  if (openFile.saving) {
    const nextDirty = openFile.draft !== file.content
    return {
      ...openFile,
      file,
      draft: openFile.draft,
      dirty: nextDirty,
      externalChanged: nextDirty && (openFile.externalChanged || openFile.file.sha1 !== file.sha1),
      error: null,
    }
  }

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

export function refreshWorkspaceOpenFilesFromReads(
  state: WorkspaceOpenFilesState,
  workspaceRoot: string,
  files: readonly WorkspaceFile[]
): WorkspaceOpenFilesState {
  if (files.length === 0) return state
  const fileByPath = new Map(files.map(file => [file.path, file]))
  const refreshedByOpenFile = new Map<OpenWorkspaceFile, OpenWorkspaceFile>()
  const refreshedFiles = state.files.map(openFile => {
    if (openFile.workspaceRoot !== workspaceRoot) return openFile
    const file = fileByPath.get(openFile.file.path)
    if (!file) return openFile
    const refreshedFile = refreshOpenWorkspaceFileFromRead(openFile, file)
    refreshedByOpenFile.set(openFile, refreshedFile)
    return refreshedFile
  })
  const activeFile = state.activeFile
    ? refreshedByOpenFile.get(state.activeFile) ?? state.activeFile
    : null
  return {
    activeFile,
    files: refreshedFiles,
    closedFileCache: state.closedFileCache,
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
    revision: 0,
    externalChanged: false,
    saving: false,
    error: null,
    cursor: request.cursor,
    diffRequestId: request.diffRequestId,
    diffOnly: request.diffOnly,
    revealInTree: request.revealInTree,
    transient: request.transient,
    focusEditorRequestId: request.focusEditorRequestId,
    exactExternal: request.exactExternal,
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
  const idleCachedFile = cachedFile
    ? {
        ...cachedFile,
        saving: false,
        saveRequestId: undefined,
        saveRevision: undefined,
      }
    : null
  const restoredFile = !existingFile && idleCachedFile && idleCachedFile.draft !== file.content
    ? refreshOpenWorkspaceFileFromRead(idleCachedFile, file)
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
    revealInTree: request.revealInTree,
    transient: nextTransient,
    focusEditorRequestId: request.focusEditorRequestId,
    exactExternal: request.exactExternal ?? baseFile.exactExternal,
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
  const hasViewRequest = Boolean(
    request.cursor
    || request.diffRequestId
    || request.diffOnly !== undefined
    || request.revealInTree !== undefined
    || request.focusEditorRequestId !== undefined
    || nextFile.diffRequestId
    || nextFile.revealInTree !== undefined
  )
  const identityChanged = nextFile.agentId !== agentId
    || Boolean(request.workspaceRoot && request.workspaceRoot !== nextFile.workspaceRoot)
    || Boolean(request.sourceAgentId && request.sourceAgentId !== nextFile.sourceAgentId)
  const transientChanged = request.transient !== undefined && request.transient !== nextFile.transient
  const selectedFile = hasViewRequest || identityChanged || transientChanged
    ? {
        ...nextFile,
        agentId,
        sourceAgentId: request.sourceAgentId ?? nextFile.sourceAgentId,
        workspaceRoot: request.workspaceRoot ?? nextFile.workspaceRoot,
        cursor: request.cursor ?? nextFile.cursor,
        diffRequestId: request.diffRequestId,
        diffOnly: request.diffOnly ?? nextFile.diffOnly,
        revealInTree: request.revealInTree,
        transient: request.transient ?? nextFile.transient,
        focusEditorRequestId: request.focusEditorRequestId,
      }
    : nextFile
  return {
    activeFile: selectedFile,
    files: hasViewRequest || identityChanged || transientChanged
      ? replaceOpenWorkspaceFile(state.files, selectedFile)
      : state.files,
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

    const nextFile = {
      ...cachedFile,
      saving: false,
      saveRequestId: undefined,
      saveRevision: undefined,
    }
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
    activeFile: state.activeFile && workspaceOpenFileKey(state.activeFile) === workspaceOpenFileKey(nextFile)
      ? nextFile
      : state.activeFile,
    files: replaceOpenWorkspaceFile(state.files, nextFile),
    closedFileCache,
  }
}

export function updateWorkspaceOpenFileDraft(file: OpenWorkspaceFile, nextDraft: string): OpenWorkspaceFile {
  return {
    ...file,
    draft: nextDraft,
    dirty: nextDraft !== file.file.content,
    revision: (file.revision ?? 0) + 1,
    error: null,
    transient: false,
  }
}

export function beginWorkspaceOpenFileSave(
  file: OpenWorkspaceFile,
  saveRequestId: number
): OpenWorkspaceFile {
  if (file.saving) return file
  return {
    ...file,
    saving: true,
    saveRequestId,
    saveRevision: file.revision ?? 0,
    error: null,
  }
}

export function completeWorkspaceOpenFileSave(
  file: OpenWorkspaceFile,
  saveRequestId: number,
  savedFile: WorkspaceFile
): OpenWorkspaceFile {
  if (!file.saving || file.saveRequestId !== saveRequestId) return file
  const committedFile = savedFile.path === file.file.path
    ? savedFile
    : { ...savedFile, path: file.file.path }
  const changedWhileSaving = (file.revision ?? 0) !== (file.saveRevision ?? 0)
  const draft = changedWhileSaving ? file.draft : committedFile.content
  return {
    ...file,
    file: committedFile,
    draft,
    dirty: draft !== committedFile.content,
    externalChanged: false,
    saving: false,
    saveRequestId: undefined,
    saveRevision: undefined,
    error: null,
  }
}

export function completeWorkspaceOpenFileReload(
  file: OpenWorkspaceFile,
  reloadRequestId: number,
  requestedDraft: string,
  loadedFile: WorkspaceFile
): OpenWorkspaceFile {
  if (!file.saving || file.saveRequestId !== reloadRequestId) return file
  const committedFile = loadedFile.path === file.file.path
    ? loadedFile
    : { ...loadedFile, path: file.file.path }
  const changedWhileReloading = file.draft !== requestedDraft
  const draft = changedWhileReloading ? file.draft : committedFile.content
  return {
    ...file,
    file: committedFile,
    draft,
    dirty: draft !== committedFile.content,
    externalChanged: false,
    saving: false,
    saveRequestId: undefined,
    saveRevision: undefined,
    error: null,
  }
}

export function failWorkspaceOpenFileSave(
  file: OpenWorkspaceFile,
  saveRequestId: number,
  message: string,
  conflict: boolean
): OpenWorkspaceFile {
  if (!file.saving || file.saveRequestId !== saveRequestId) return file
  return {
    ...file,
    dirty: file.draft !== file.file.content,
    externalChanged: file.externalChanged || conflict,
    saving: false,
    saveRequestId: undefined,
    saveRevision: undefined,
    error: message,
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
