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
  const handledDiffRequestRef = useRef<string | null>(null)
  const currentOpenFileKey = openFileKey(openFile)
  const requestedDiffKey = openFile.diffRequestId
    ? `${currentOpenFileKey}:${openFile.diffRequestId}`
    : null
  const openFileAgentId = openFile.agentId
  const openFilePath = openFile.file.path
  const openFileKeyRef = useRef(currentOpenFileKey)
  const [diffState, setDiffState] = useState<FileEditorDiffState>({
    open: false,
    loading: false,
    error: null,
    diff: null,
  })
  openFileKeyRef.current = currentOpenFileKey

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
    const checkedFileKey = currentOpenFileKey
    diffRequestRef.current = requestId
    onClearBlameDetail()
    setDiffState({
      open: true,
      loading: true,
      error: null,
      diff: null,
    })
    try {
      const diff = await fetchWorkspaceDiff(openFileAgentId, openFilePath)
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
  }, [currentOpenFileKey, diffDisabled, onClearBlameDetail, openFileAgentId, openFilePath])

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
  }, [currentOpenFileKey, diffDisabled])

  useEffect(() => {
    if (!requestedDiffKey || diffDisabled || handledDiffRequestRef.current === requestedDiffKey) return
    handledDiffRequestRef.current = requestedDiffKey
    void openDiff()
  }, [diffDisabled, openDiff, requestedDiffKey])

  return {
    diffState,
    closeDiff,
    toggleDiff,
  }
}
