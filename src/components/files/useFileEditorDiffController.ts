import { useCallback, useEffect, useRef, useState } from 'react'
import {
  workspaceEditorModelKey as openFileKey,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import {
  fetchWorkspaceDiff,
  type WorkspaceFileDiff,
} from '@/lib/workspace-files'

export interface FileEditorDiffState {
  open: boolean
  loading: boolean
  error: string | null
  diff: WorkspaceFileDiff | null
}

interface UseFileEditorDiffControllerOptions {
  openFile: OpenWorkspaceFile
  diffDisabled: boolean
  onClearBlameDetail: () => void
}

export function useFileEditorDiffController({
  openFile,
  diffDisabled,
  onClearBlameDetail,
}: UseFileEditorDiffControllerOptions) {
  const diffRequestRef = useRef(0)
  const handledDiffRequestRef = useRef<number | undefined>(undefined)
  const openFileKeyRef = useRef(openFileKey(openFile))
  const [diffState, setDiffState] = useState<FileEditorDiffState>({
    open: false,
    loading: false,
    error: null,
    diff: null,
  })
  openFileKeyRef.current = openFileKey(openFile)

  const closeDiff = useCallback(() => {
    diffRequestRef.current += 1
    setDiffState({
      open: false,
      loading: false,
      error: null,
      diff: null,
    })
  }, [])

  const openDiff = useCallback(async () => {
    if (diffDisabled) return
    const requestId = diffRequestRef.current + 1
    const checkedFileKey = openFileKey(openFile)
    diffRequestRef.current = requestId
    onClearBlameDetail()
    setDiffState({
      open: true,
      loading: true,
      error: null,
      diff: null,
    })
    try {
      const diff = await fetchWorkspaceDiff(openFile.agentId, openFile.file.path)
      if (diffRequestRef.current !== requestId || openFileKeyRef.current !== checkedFileKey) return
      setDiffState({
        open: true,
        loading: false,
        error: null,
        diff,
      })
    } catch (error) {
      if (diffRequestRef.current !== requestId || openFileKeyRef.current !== checkedFileKey) return
      setDiffState({
        open: true,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load diff',
        diff: null,
      })
    }
  }, [diffDisabled, onClearBlameDetail, openFile])

  const toggleDiff = useCallback(() => {
    if (diffState.open) {
      closeDiff()
      return
    }
    void openDiff()
  }, [closeDiff, diffState.open, openDiff])

  useEffect(() => {
    diffRequestRef.current += 1
    setDiffState({
      open: false,
      loading: false,
      error: null,
      diff: null,
    })
  }, [diffDisabled, openFile.agentId, openFile.file])

  useEffect(() => {
    if (!openFile.diffRequestId || diffDisabled || handledDiffRequestRef.current === openFile.diffRequestId) return
    handledDiffRequestRef.current = openFile.diffRequestId
    void openDiff()
  }, [diffDisabled, openDiff, openFile.diffRequestId])

  return {
    diffState,
    closeDiff,
    toggleDiff,
  }
}
