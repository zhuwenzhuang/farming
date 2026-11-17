import { useCallback, useEffect, useState } from 'react'
import { setFileEditorDiffEnabled, useFileEditorDiffEnabled } from '@/lib/file-editor-diff-preference'
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
  const enabled = useFileEditorDiffEnabled()
  const open = enabled && !diffDisabled
  // Keep the open comparison stable during background file refreshes. An
  // explicit Diff request or switching files loads a new comparison snapshot.
  const currentOpenFileKey = `${openFileKey(openFile)}:${openFile.diffRequestId ?? ''}`
  const openFileAgentId = openFile.agentId
  const openFilePath = openFile.file.path
  const [loaded, setLoaded] = useState<{
    key: string
    error: string | null
    diff: WorkspaceFileDiff | null
  } | null>(null)

  const closeDiff = useCallback(() => {
    setFileEditorDiffEnabled(false)
    setLoaded(null)
  }, [])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    onClearBlameDetail()
    setLoaded(null)
    void fetchWorkspaceDiff(openFileAgentId, openFilePath, controller.signal)
      .then(diff => {
        if (!controller.signal.aborted) setLoaded({ key: currentOpenFileKey, error: null, diff })
      })
      .catch(error => {
        if (!controller.signal.aborted) setLoaded({
          key: currentOpenFileKey,
          error: error instanceof Error ? error.message : 'Failed to load diff',
          diff: null,
        })
      })
    return () => controller.abort()
  }, [currentOpenFileKey, open, onClearBlameDetail, openFileAgentId, openFilePath])

  const current = loaded?.key === currentOpenFileKey ? loaded : null
  const diffState: FileEditorDiffState = {
    open,
    loading: open && !current,
    error: open ? current?.error ?? null : null,
    diff: open ? current?.diff ?? null : null,
  }

  return {
    diffState,
    closeDiff,
  }
}
