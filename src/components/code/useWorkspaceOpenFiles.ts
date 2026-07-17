import { useCallback, useMemo, useRef, useState } from 'react'
import {
  closeWorkspaceOpenFiles,
  deleteWorkspaceOpenFiles,
  moveWorkspaceOpenFiles,
  openWorkspaceFileFromRead,
  replaceOpenWorkspaceFile,
  reopenLastClosedWorkspaceOpenFile,
  refreshWorkspaceOpenFilesFromReads,
  selectWorkspaceOpenFile,
  updateWorkspaceOpenFile,
  updateWorkspaceOpenFileDraft,
  type OpenWorkspaceFile,
  type WorkspaceOpenFileRequest,
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

export function useWorkspaceOpenFiles() {
  const [state, setState] = useState<WorkspaceOpenFilesState>(() => initialWorkspaceOpenFilesState())
  const stateRef = useRef(state)

  const commitState = useCallback((nextState: WorkspaceOpenFilesState) => {
    stateRef.current = openFilesStateOnly(nextState)
    setState(stateRef.current)
    return stateRef.current
  }, [])

  const openFromRead = useCallback((agentId: string, file: WorkspaceFile, options?: WorkspaceOpenFileRequest) => (
    commitState(openWorkspaceFileFromRead(stateRef.current, agentId, file, options))
  ), [commitState])

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

  const update = useCallback((nextFile: OpenWorkspaceFile) => (
    commitState(updateWorkspaceOpenFile(stateRef.current, nextFile))
  ), [commitState])

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
    move,
    deleteEntries,
  }), [closedFiles, close, deleteEntries, move, openFromRead, refreshFromReads, reopenLastClosed, select, state.activeFile, state.files, update, updateDraft])
}
