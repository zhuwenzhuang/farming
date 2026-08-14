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
  refreshOpenWorkspaceFileFromRead,
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
import {
  fetchWorkspaceFile,
  type WorkspaceFile,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileMove,
} from '@/lib/workspace-files'

const OPEN_FILE_REFRESH_CONCURRENCY = 4
const OPEN_FILE_REFRESH_TIMEOUT_MS = 15_000
const OPEN_FILE_AUTO_REFRESH_DELAY_MS = 75
const OPEN_FILE_AUTO_REFRESH_CONCURRENCY = 4

function openFileAutoRefreshKey(rootId: string, filePath: string) {
  return JSON.stringify([rootId, filePath])
}

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

export interface WorkspaceOpenFileRestoreRead {
  agentId: string
  file: WorkspaceFile
  request: WorkspaceOpenFileRequest
}

async function refreshOpenWorkspaceFileReads(rootId: string, filePaths: readonly string[]) {
  const files: WorkspaceFile[] = []
  let successful = true
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(OPEN_FILE_REFRESH_CONCURRENCY, filePaths.length) }, async () => {
    while (nextIndex < filePaths.length) {
      const filePath = filePaths[nextIndex]!
      nextIndex += 1
      const abortController = new AbortController()
      const timeoutId = window.setTimeout(() => abortController.abort(), OPEN_FILE_REFRESH_TIMEOUT_MS)
      try {
        files.push(await fetchWorkspaceFile(rootId, filePath, { signal: abortController.signal }))
      } catch {
        successful = false
      } finally {
        window.clearTimeout(timeoutId)
      }
    }
  })
  await Promise.all(workers)
  return { files, successful }
}

export function useWorkspaceOpenFiles() {
  const [state, setState] = useState<WorkspaceOpenFilesState>(() => initialWorkspaceOpenFilesState())
  const stateRef = useRef(state)
  const draftBackupsRef = useRef<Map<string, WorkspaceDraftBackup> | null>(null)
  const draftBackupWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoRefreshTimersRef = useRef(new Map<string, number>())
  const autoRefreshControllersRef = useRef(new Map<string, AbortController>())
  const autoRefreshQueueRef = useRef(new Map<string, { filePath: string; rootId: string }>())
  const autoRefreshActiveKeysRef = useRef(new Set<string>())
  const autoRefreshActiveRef = useRef(0)
  const autoRefreshDisposedRef = useRef(false)
  const pumpAutoRefreshRef = useRef<() => void>(() => {})
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

  const stateFromRead = useCallback((
    currentState: WorkspaceOpenFilesState,
    agentId: string,
    file: WorkspaceFile,
    options?: WorkspaceOpenFileRequest,
  ) => {
    let nextState = openWorkspaceFileFromRead(currentState, agentId, file, options)
    const openedFile = nextState.activeFile
    const backup = openedFile ? draftBackupsRef.current?.get(workspaceOpenFileKey(openedFile)) : null
    if (openedFile && backup) {
      nextState = updateWorkspaceOpenFile(
        nextState,
        restoreWorkspaceOpenFileDraft(openedFile, backup)
      )
    }
    return nextState
  }, [])

  const openFromRead = useCallback((agentId: string, file: WorkspaceFile, options?: WorkspaceOpenFileRequest) => {
    const nextState = stateFromRead(stateRef.current, agentId, file, options)
    return commitState(nextState)
  }, [commitState, stateFromRead])

  const restoreFromReads = useCallback((reads: readonly WorkspaceOpenFileRestoreRead[]) => {
    if (reads.length === 0) return stateRef.current
    const previousActiveKey = stateRef.current.activeFile
      ? workspaceOpenFileKey(stateRef.current.activeFile)
      : null
    let nextState = stateRef.current
    const restoredKeys: string[] = []
    reads.forEach(read => {
      nextState = stateFromRead(nextState, read.agentId, read.file, read.request)
      if (nextState.activeFile) restoredKeys.push(workspaceOpenFileKey(nextState.activeFile))
    })
    const byKey = new Map(nextState.files.map(file => [workspaceOpenFileKey(file), file]))
    const orderedFiles = restoredKeys.flatMap(key => {
      const file = byKey.get(key)
      if (!file) return []
      byKey.delete(key)
      return [file]
    })
    orderedFiles.push(...byKey.values())
    const activeFile = previousActiveKey
      ? orderedFiles.find(file => workspaceOpenFileKey(file) === previousActiveKey) ?? nextState.activeFile
      : nextState.activeFile
    return commitState({ ...nextState, activeFile, files: orderedFiles })
  }, [commitState, stateFromRead])

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

  const refreshProject = useCallback(async (rootId: string, workspaceRoot: string) => {
    const filePaths = Array.from(new Set(stateRef.current.files
      .filter(file => file.workspaceRoot === workspaceRoot)
      .map(file => file.file.path)))
    if (filePaths.length === 0) return true
    const result = await refreshOpenWorkspaceFileReads(rootId, filePaths)
    refreshFromReads(workspaceRoot, result.files)
    return result.successful
  }, [refreshFromReads])

  const refreshOpenFileFromDisk = useCallback(async (rootId: string, filePath: string) => {
    const requestKey = openFileAutoRefreshKey(rootId, filePath)
    const requestedFile = stateRef.current.files.find(openFile => (
      openFile.agentId === rootId && openFile.file.path === filePath
    ))
    if (!requestedFile) return

    autoRefreshControllersRef.current.get(requestKey)?.abort()
    const controller = new AbortController()
    autoRefreshControllersRef.current.set(requestKey, controller)
    const requestedBaseSha1 = requestedFile.file.sha1
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, OPEN_FILE_REFRESH_TIMEOUT_MS)

    try {
      const file = await fetchWorkspaceFile(rootId, filePath, {
        signal: controller.signal,
        exactExternal: requestedFile.exactExternal,
      })
      if (autoRefreshControllersRef.current.get(requestKey) !== controller) return
      const currentFile = stateRef.current.files.find(openFile => (
        openFile.agentId === rootId && openFile.file.path === filePath
      ))
      if (!currentFile) return
      if (currentFile.file.sha1 !== requestedBaseSha1 && currentFile.file.sha1 !== file.sha1) return
      commitState(updateWorkspaceOpenFile(
        stateRef.current,
        refreshOpenWorkspaceFileFromRead(currentFile, file),
      ))
    } catch (error) {
      if (autoRefreshControllersRef.current.get(requestKey) !== controller) return
      const currentFile = stateRef.current.files.find(openFile => (
        openFile.agentId === rootId && openFile.file.path === filePath
      ))
      if (!currentFile) return
      if (controller.signal.aborted && !timedOut) return
      commitState(updateWorkspaceOpenFile(stateRef.current, {
        ...currentFile,
        error: timedOut
          ? 'Timed out while refreshing changed file'
          : error instanceof Error ? error.message : 'Failed to refresh changed file',
      }))
    } finally {
      window.clearTimeout(timeout)
      if (autoRefreshControllersRef.current.get(requestKey) === controller) {
        autoRefreshControllersRef.current.delete(requestKey)
      }
    }
  }, [commitState])

  pumpAutoRefreshRef.current = () => {
    if (autoRefreshDisposedRef.current) return
    while (
      autoRefreshActiveRef.current < OPEN_FILE_AUTO_REFRESH_CONCURRENCY
      && autoRefreshQueueRef.current.size > 0
    ) {
      const next = Array.from(autoRefreshQueueRef.current.entries()).find(([requestKey]) => (
        !autoRefreshActiveKeysRef.current.has(requestKey)
      )) as [
        string,
        { filePath: string; rootId: string },
      ] | undefined
      if (!next) return
      const [requestKey, target] = next
      autoRefreshQueueRef.current.delete(requestKey)
      autoRefreshActiveKeysRef.current.add(requestKey)
      autoRefreshActiveRef.current += 1
      void refreshOpenFileFromDisk(target.rootId, target.filePath).finally(() => {
        autoRefreshActiveKeysRef.current.delete(requestKey)
        autoRefreshActiveRef.current -= 1
        pumpAutoRefreshRef.current()
      })
    }
  }

  const scheduleOpenFileRefresh = useCallback((rootId: string, filePath: string) => {
    if (!stateRef.current.files.some(openFile => (
      openFile.agentId === rootId && openFile.file.path === filePath
    ))) return
    const requestKey = openFileAutoRefreshKey(rootId, filePath)
    const pendingTimer = autoRefreshTimersRef.current.get(requestKey)
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer)
    autoRefreshTimersRef.current.set(requestKey, window.setTimeout(() => {
      autoRefreshTimersRef.current.delete(requestKey)
      autoRefreshQueueRef.current.set(requestKey, { filePath, rootId })
      pumpAutoRefreshRef.current()
    }, OPEN_FILE_AUTO_REFRESH_DELAY_MS))
  }, [])

  const setWatchError = useCallback((rootId: string, message: string) => {
    let changed = false
    const files = stateRef.current.files.map(openFile => {
      if (openFile.agentId !== rootId || openFile.error === message) return openFile
      changed = true
      return { ...openFile, error: message }
    })
    if (!changed) return
    commitState({
      ...stateRef.current,
      files,
      activeFile: stateRef.current.activeFile?.agentId === rootId
        ? files.find(file => workspaceOpenFileKey(file) === workspaceOpenFileKey(stateRef.current.activeFile!)) ?? stateRef.current.activeFile
        : stateRef.current.activeFile,
    })
  }, [commitState])

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

  useEffect(() => {
    autoRefreshDisposedRef.current = false
    const timers = autoRefreshTimersRef.current
    const queue = autoRefreshQueueRef.current
    const controllers = autoRefreshControllersRef.current
    const activeKeys = autoRefreshActiveKeysRef.current
    return () => {
      autoRefreshDisposedRef.current = true
      timers.forEach(timer => window.clearTimeout(timer))
      timers.clear()
      queue.clear()
      activeKeys.clear()
      controllers.forEach(controller => controller.abort())
      controllers.clear()
    }
  }, [])

  return useMemo(() => ({
    activeFile: state.activeFile,
    files: state.files,
    closedFiles,
    openFromRead,
    restoreFromReads,
    select,
    close,
    reopenLastClosed,
    update,
    refreshFromReads,
    refreshProject,
    scheduleOpenFileRefresh,
    setWatchError,
    updateDraft,
    reorder,
    move,
    deleteEntries,
  }), [closedFiles, close, deleteEntries, move, openFromRead, refreshFromReads, refreshProject, reorder, reopenLastClosed, restoreFromReads, scheduleOpenFileRefresh, select, setWatchError, state.activeFile, state.files, update, updateDraft])
}
