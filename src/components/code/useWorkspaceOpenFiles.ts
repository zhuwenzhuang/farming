import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createWorkspaceDraftBackup,
  loadWorkspaceDraftBackups,
  restoreWorkspaceOpenFileDraft,
  saveWorkspaceDraftBackups,
  type WorkspaceDraftBackup,
} from '@/lib/workspace-draft-backups'
import {
  closeWorkspaceOpenFiles,
  deleteWorkspaceOpenFiles,
  findOpenWorkspaceFileForUpdate,
  moveWorkspaceOpenFiles,
  openWorkspaceFileFromRead,
  replaceOpenWorkspaceFile,
  reopenLastClosedWorkspaceOpenFile,
  refreshWorkspaceOpenFilesFromReads,
  reorderWorkspaceOpenFiles,
  selectWorkspaceOpenFile,
  updateWorkspaceOpenFile,
  updateWorkspaceOpenFileDraft,
  workspaceOpenFileKey,
  type OpenWorkspaceFile,
  type WorkspaceOpenFileRequest,
  type WorkspaceOpenFileUpdater,
  type WorkspaceOpenFilesState,
  type WorkspaceOpenFileTarget,
} from '@/lib/workspace-open-files'
import type { WorkspaceFile, WorkspaceFileDeleteResult, WorkspaceFileMove } from '@/lib/workspace-files'

function initialWorkspaceOpenFilesState(): WorkspaceOpenFilesState {
  return {
    activeFile: null,
    files: [],
    closedFileCache: new Map(),
  }
}

function openFilesStateOnly(state: WorkspaceOpenFilesState): WorkspaceOpenFilesState {
  return {
    activeFile: state.activeFile,
    files: state.files,
    closedFileCache: state.closedFileCache,
  }
}

function browserDraftBackupStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function trackedOpenWorkspaceFiles(state: WorkspaceOpenFilesState) {
  return [...state.files, ...state.closedFileCache.values()]
}

export function useWorkspaceOpenFiles() {
  const [state, setState] = useState<WorkspaceOpenFilesState>(() => initialWorkspaceOpenFilesState())
  const stateRef = useRef(state)
  const draftBackupsRef = useRef<Map<string, WorkspaceDraftBackup> | null>(null)
  const draftBackupWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  if (draftBackupsRef.current === null) {
    const storage = browserDraftBackupStorage()
    draftBackupsRef.current = storage ? loadWorkspaceDraftBackups(storage) : new Map()
  }

  const flushDraftBackups = useCallback(() => {
    if (draftBackupWriteTimerRef.current !== null) {
      clearTimeout(draftBackupWriteTimerRef.current)
      draftBackupWriteTimerRef.current = null
    }
    const storage = browserDraftBackupStorage()
    if (storage) saveWorkspaceDraftBackups(storage, draftBackupsRef.current ?? new Map())
  }, [])

  const scheduleDraftBackupWrite = useCallback(() => {
    if (draftBackupWriteTimerRef.current !== null) {
      clearTimeout(draftBackupWriteTimerRef.current)
    }
    draftBackupWriteTimerRef.current = setTimeout(() => {
      draftBackupWriteTimerRef.current = null
      const storage = browserDraftBackupStorage()
      if (storage) saveWorkspaceDraftBackups(storage, draftBackupsRef.current ?? new Map())
    }, 250)
  }, [])

  const syncDraftBackups = useCallback((
    previousState: WorkspaceOpenFilesState,
    nextState: WorkspaceOpenFilesState
  ) => {
    const backups = draftBackupsRef.current
    if (!backups) return
    const nextFiles = trackedOpenWorkspaceFiles(nextState)
    const nextKeys = new Set(nextFiles.map(workspaceOpenFileKey))
    trackedOpenWorkspaceFiles(previousState).forEach(file => {
      const key = workspaceOpenFileKey(file)
      if (!nextKeys.has(key)) backups.delete(key)
    })
    nextFiles.forEach(file => {
      const key = workspaceOpenFileKey(file)
      if (file.dirty) {
        backups.set(key, createWorkspaceDraftBackup(file))
      } else {
        backups.delete(key)
      }
    })
    scheduleDraftBackupWrite()
  }, [scheduleDraftBackupWrite])

  const commitState = useCallback((nextState: WorkspaceOpenFilesState) => {
    const previousState = stateRef.current
    stateRef.current = openFilesStateOnly(nextState)
    syncDraftBackups(previousState, stateRef.current)
    setState(stateRef.current)
    return stateRef.current
  }, [syncDraftBackups])

  const openFromRead = useCallback((agentId: string, file: WorkspaceFile, options?: WorkspaceOpenFileRequest) => {
    let nextState = openWorkspaceFileFromRead(stateRef.current, agentId, file, options)
    const openedFile = nextState.activeFile
    const backup = openedFile ? draftBackupsRef.current?.get(workspaceOpenFileKey(openedFile)) : null
    if (openedFile && backup) {
      nextState = updateWorkspaceOpenFile(
        nextState,
        restoreWorkspaceOpenFileDraft(openedFile, backup)
      )
    }
    return commitState(nextState)
  }, [commitState])

  const select = useCallback((agentId: string, filePath: string, options?: WorkspaceOpenFileRequest) => {
    const nextState = selectWorkspaceOpenFile(stateRef.current, agentId, filePath, options)
    if (!nextState) return null
    return commitState(nextState)
  }, [commitState])

  const close = useCallback((targets: readonly WorkspaceOpenFileTarget[]) => {
    const result = closeWorkspaceOpenFiles(stateRef.current, targets)
    if (result.closedFiles.length > 0) commitState(result)
    return result
  }, [commitState])

  const reopenLastClosed = useCallback((canReopen?: (file: OpenWorkspaceFile) => boolean) => {
    const nextState = reopenLastClosedWorkspaceOpenFile(stateRef.current, { canReopen })
    if (!nextState) return null
    return commitState(nextState)
  }, [commitState])

  const update = useCallback((
    target: WorkspaceOpenFileTarget,
    updater: WorkspaceOpenFileUpdater
  ) => {
    const currentFile = findOpenWorkspaceFileForUpdate(stateRef.current.files, target)
    if (!currentFile) return null
    const nextFile = updater(currentFile)
    if (nextFile !== currentFile) {
      commitState(updateWorkspaceOpenFile(stateRef.current, nextFile))
    }
    return nextFile
  }, [commitState])

  const refreshFromReads = useCallback((workspaceRoot: string, files: readonly WorkspaceFile[]) => (
    commitState(refreshWorkspaceOpenFilesFromReads(stateRef.current, workspaceRoot, files))
  ), [commitState])

  const updateDraft = useCallback((nextDraft: string) => {
    const activeFile = stateRef.current.activeFile
    if (!activeFile) return null
    const nextFile = updateWorkspaceOpenFileDraft(activeFile, nextDraft)
    return commitState({
      ...stateRef.current,
      activeFile: nextFile,
      files: replaceOpenWorkspaceFile(stateRef.current.files, nextFile),
    })
  }, [commitState])

  const reorder = useCallback((sourceKey: string, targetKey: string, position: 'before' | 'after') => {
    const nextState = reorderWorkspaceOpenFiles(stateRef.current, sourceKey, targetKey, position)
    if (nextState !== stateRef.current) commitState(nextState)
    return nextState
  }, [commitState])

  const move = useCallback((agentId: string, moves: readonly WorkspaceFileMove[]) => {
    const nextState = moveWorkspaceOpenFiles(stateRef.current, agentId, moves)
    if (nextState !== stateRef.current) commitState(nextState)
    return nextState
  }, [commitState])

  const deleteEntries = useCallback((agentId: string, deletions: readonly WorkspaceFileDeleteResult[]) => {
    const result = deleteWorkspaceOpenFiles(stateRef.current, agentId, deletions)
    if (deletions.length > 0) commitState(result)
    return result
  }, [commitState])

  const closedFiles = useMemo(() => (
    Array.from(state.closedFileCache.values())
  ), [state.closedFileCache])

  useEffect(() => {
    const flushOnPageHide = () => flushDraftBackups()
    window.addEventListener('pagehide', flushOnPageHide)
    return () => {
      window.removeEventListener('pagehide', flushOnPageHide)
      flushDraftBackups()
    }
  }, [flushDraftBackups])

  return useMemo(() => ({
    activeFile: state.activeFile,
    files: state.files,
    closedFiles,
    openFromRead,
    select,
    close,
    reopenLastClosed,
    update,
    refreshFromReads,
    updateDraft,
    reorder,
    move,
    deleteEntries,
  }), [closedFiles, close, deleteEntries, move, openFromRead, refreshFromReads, reorder, reopenLastClosed, select, state.activeFile, state.files, update, updateDraft])
}
