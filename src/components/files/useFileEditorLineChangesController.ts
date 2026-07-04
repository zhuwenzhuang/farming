import { useCallback, useEffect, useRef, useState } from 'react'
import {
  workspaceEditorLineChangesErrorState,
  workspaceEditorLineChangesLoadedState,
  workspaceEditorLineChangesLoadingState,
  workspaceEditorModelKey as openFileKey,
  type WorkspaceEditorLineChangesState,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import {
  fetchWorkspaceLineChanges,
  type WorkspaceFileLineChanges,
} from '@/lib/workspace-files'

export type FileEditorLineChangesState = WorkspaceEditorLineChangesState

interface UseFileEditorLineChangesControllerOptions {
  openFile: OpenWorkspaceFile
  disabled: boolean
  onClearBlameDetail: () => void
  onRevealLine: (lineNumber: number, options?: { focusEditor?: boolean }) => void
}

export function useFileEditorLineChangesController({
  openFile,
  disabled,
  onClearBlameDetail,
  onRevealLine,
}: UseFileEditorLineChangesControllerOptions) {
  const lineChangesRequestRef = useRef(0)
  const openFileKeyRef = useRef(openFileKey(openFile))
  const [lineChanges, setLineChanges] = useState<FileEditorLineChangesState | null>(null)
  openFileKeyRef.current = openFileKey(openFile)

  const closeLineChanges = useCallback(() => {
    setLineChanges(null)
  }, [])

  const openLineChanges = useCallback(async (mode: WorkspaceFileLineChanges['mode'], lineNumber: number) => {
    if (disabled) return
    const requestId = lineChangesRequestRef.current + 1
    const checkedFileKey = openFileKey(openFile)
    lineChangesRequestRef.current = requestId
    onClearBlameDetail()
    setLineChanges(workspaceEditorLineChangesLoadingState(mode, lineNumber))
    onRevealLine(lineNumber, { focusEditor: false })
    try {
      const changes = await fetchWorkspaceLineChanges(openFile.agentId, openFile.file.path, lineNumber, mode)
      if (lineChangesRequestRef.current !== requestId || openFileKeyRef.current !== checkedFileKey) return
      setLineChanges(workspaceEditorLineChangesLoadedState(mode, lineNumber, changes))
    } catch (error) {
      if (lineChangesRequestRef.current !== requestId || openFileKeyRef.current !== checkedFileKey) return
      setLineChanges(workspaceEditorLineChangesErrorState(mode, lineNumber, error))
    }
  }, [disabled, onClearBlameDetail, onRevealLine, openFile])

  useEffect(() => {
    lineChangesRequestRef.current += 1
    setLineChanges(null)
  }, [disabled, openFile.agentId, openFile.file])

  return {
    lineChanges,
    openLineChanges,
    closeLineChanges,
  }
}
