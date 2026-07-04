import { useCallback, useRef, useState } from 'react'
import {
  deletedWorkspaceDiffPlaceholderFile,
  shouldOpenMissingWorkspaceFileAsDiff,
  shouldRevealSelectedWorkspaceOpenFile,
  type WorkspaceFileOpenTarget,
} from '@/lib/workspace-open-files'
import {
  fetchWorkspaceFile,
  WorkspaceFileApiError,
  type WorkspaceFile,
} from '@/lib/workspace-files'

interface UseWorkspaceFileOpenControllerOptions {
  agentId: string | null
  onClearSearch: () => void
  onOpenFile: (agentId: string, file: WorkspaceFile, target?: WorkspaceFileOpenTarget) => void
  onRevealFilePath: (filePath: string) => Promise<void>
  onSelectOpenFile?: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
}

export function useWorkspaceFileOpenController({
  agentId,
  onClearSearch,
  onOpenFile,
  onRevealFilePath,
  onSelectOpenFile,
}: UseWorkspaceFileOpenControllerOptions) {
  const fileOpenRequestRef = useRef(0)
  const [openFileError, setOpenFileError] = useState<string | null>(null)

  const openFilePath = useCallback(async (filePath: string, target?: WorkspaceFileOpenTarget) => {
    if (!agentId) return
    const requestId = fileOpenRequestRef.current + 1
    fileOpenRequestRef.current = requestId
    setOpenFileError(null)
    if (onSelectOpenFile?.(agentId, filePath, target)) {
      onClearSearch()
      if (shouldRevealSelectedWorkspaceOpenFile(target)) void onRevealFilePath(filePath)
      return
    }
    try {
      const file = await fetchWorkspaceFile(agentId, filePath)
      if (fileOpenRequestRef.current !== requestId) return
      onOpenFile(agentId, file, target)
      onClearSearch()
      void onRevealFilePath(filePath)
    } catch (error) {
      if (fileOpenRequestRef.current !== requestId) return
      if (target && error instanceof WorkspaceFileApiError && error.status === 404 && shouldOpenMissingWorkspaceFileAsDiff(target)) {
        onOpenFile(agentId, deletedWorkspaceDiffPlaceholderFile(filePath, target), target)
        onClearSearch()
        return
      }
      setOpenFileError(error instanceof Error ? error.message : 'Failed to open file')
    }
  }, [agentId, onClearSearch, onOpenFile, onRevealFilePath, onSelectOpenFile])

  return {
    openFileError,
    openFilePath,
    setOpenFileError,
  }
}
