import { useCallback } from 'react'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import { fetchWorkspaceFile, saveWorkspaceFile, WorkspaceFileApiError } from '@/lib/workspace-files'
import { isWorkspaceWorkingCopyPreview } from '@/lib/workspace-working-copy'

interface UseFileEditorWorkingCopyControllerOptions {
  openFile: OpenWorkspaceFile
  readOnly: boolean
  onUpdateOpenFile: (nextFile: OpenWorkspaceFile) => void
}

export function useFileEditorWorkingCopyController({
  openFile,
  readOnly,
  onUpdateOpenFile,
}: UseFileEditorWorkingCopyControllerOptions) {
  const saveOpenWorkspaceFile = useCallback(async (fileToSave: OpenWorkspaceFile, overwrite = false) => {
    if (isWorkspaceWorkingCopyPreview(fileToSave)) return true
    if (fileToSave.saving) return false
    if (!overwrite && !fileToSave.dirty) return true

    onUpdateOpenFile({
      ...fileToSave,
      saving: true,
      error: null,
    })

    try {
      const file = await saveWorkspaceFile(fileToSave.agentId, fileToSave.file.path, fileToSave.draft, fileToSave.file.sha1, overwrite)
      onUpdateOpenFile({
        agentId: fileToSave.agentId,
        file,
        draft: file.content,
        dirty: false,
        externalChanged: false,
        saving: false,
        error: null,
      })
      return true
    } catch (error) {
      const conflict = error instanceof WorkspaceFileApiError && error.status === 409
      onUpdateOpenFile({
        ...fileToSave,
        saving: false,
        externalChanged: fileToSave.externalChanged || conflict,
        error: error instanceof Error ? error.message : 'Failed to save file',
      })
      return false
    }
  }, [onUpdateOpenFile])

  const saveFile = useCallback(async (overwrite = false) => {
    if (readOnly) return
    await saveOpenWorkspaceFile(openFile, overwrite)
  }, [openFile, readOnly, saveOpenWorkspaceFile])

  const reloadFile = useCallback(async () => {
    onUpdateOpenFile({
      ...openFile,
      saving: true,
      error: null,
    })

    try {
      const file = await fetchWorkspaceFile(openFile.agentId, openFile.file.path)
      onUpdateOpenFile({
        agentId: openFile.agentId,
        file,
        draft: file.content,
        dirty: false,
        externalChanged: false,
        saving: false,
        error: null,
      })
    } catch (error) {
      onUpdateOpenFile({
        ...openFile,
        saving: false,
        error: error instanceof Error ? error.message : 'Failed to reload file',
      })
    }
  }, [onUpdateOpenFile, openFile])

  return {
    saveOpenWorkspaceFile,
    saveFile,
    reloadFile,
  }
}
