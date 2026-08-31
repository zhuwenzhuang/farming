import { useCallback } from 'react'
import { beginInteraction, filePerformanceKey } from '@/lib/interaction-performance'
import {
  beginWorkspaceOpenFileSave,
  completeWorkspaceOpenFileReload,
  completeWorkspaceOpenFileSave,
  failWorkspaceOpenFileSave,
  type OpenWorkspaceFile,
  type WorkspaceOpenFileTarget,
  type WorkspaceOpenFileUpdater,
} from '@/lib/workspace-open-files'
import type { WorkspaceFileResolveOptions } from '@/lib/workspace-file-model-manager'
import { fetchWorkspaceFile, saveWorkspaceFile, WorkspaceFileApiError } from '@/lib/workspace-files'
import type { WorkspaceFile } from '@/lib/workspace-files'
import { isWorkspaceWorkingCopyPreview } from '@/lib/workspace-working-copy'

interface UseFileEditorWorkingCopyControllerOptions {
  openFile: OpenWorkspaceFile
  readOnly: boolean
  onUpdateOpenFile: (
    target: WorkspaceOpenFileTarget,
    updater: WorkspaceOpenFileUpdater
  ) => OpenWorkspaceFile | null
  resolveFile: (
    rootId: string,
    filePath: string,
    options?: WorkspaceFileResolveOptions,
  ) => Promise<WorkspaceFile>
}

let nextWorkspaceFileRequestId = 1

function allocateWorkspaceFileRequestId() {
  const requestId = nextWorkspaceFileRequestId
  nextWorkspaceFileRequestId += 1
  return requestId
}

export function useFileEditorWorkingCopyController({
  openFile,
  readOnly,
  onUpdateOpenFile,
  resolveFile,
}: UseFileEditorWorkingCopyControllerOptions) {
  const saveOpenWorkspaceFile = useCallback(async (fileToSave: OpenWorkspaceFile, overwrite = false) => {
    if (readOnly) return false
    if (isWorkspaceWorkingCopyPreview(fileToSave)) return true
    const target = {
      agentId: fileToSave.agentId,
      filePath: fileToSave.file.path,
      workspaceRoot: fileToSave.workspaceRoot,
    }
    const saveRequestId = allocateWorkspaceFileRequestId()
    const savingFile = onUpdateOpenFile(target, currentFile => {
      if (currentFile.saving || (!overwrite && !currentFile.dirty)) return currentFile
      return beginWorkspaceOpenFileSave(currentFile, saveRequestId)
    })
    if (!savingFile) return false
    if (savingFile.saveRequestId !== saveRequestId) {
      return !savingFile.dirty && !savingFile.saving
    }
    const requestTarget = { ...target, saveRequestId }
    const trace = beginInteraction('file.save', { target: filePerformanceKey(target.agentId, target.filePath) })
    trace.metric({ contentUnits: savingFile.draft.length })

    try {
      const file = await saveWorkspaceFile(
        savingFile.agentId,
        savingFile.file.path,
        savingFile.draft,
        savingFile.file.sha1,
        overwrite
      )
      const completedFile = onUpdateOpenFile(requestTarget, currentFile => (
        completeWorkspaceOpenFileSave(currentFile, saveRequestId, file)
      ))
      trace.mark('model')
      trace.end('completed') // This captured revision was saved even if a newer draft is dirty.
      return Boolean(completedFile && !completedFile.dirty)
    } catch (error) {
      const conflict = error instanceof WorkspaceFileApiError && error.status === 409
      const uncertainOutcome = !(error instanceof WorkspaceFileApiError) || error.status >= 500
      if (uncertainOutcome) {
        try {
          const currentFile = await fetchWorkspaceFile(savingFile.agentId, savingFile.file.path)
          if (currentFile.content === savingFile.draft) {
            const reconciledFile = onUpdateOpenFile(requestTarget, openFile => (
              completeWorkspaceOpenFileSave(openFile, saveRequestId, currentFile)
            ))
            trace.mark('model'); trace.end('completed')
            return Boolean(reconciledFile && !reconciledFile.dirty)
          }
        } catch {
          // Preserve the draft and report the original save failure when the disk outcome is unknown.
        }
      }
      trace.end(uncertainOutcome ? 'uncertain' : 'failed')
      onUpdateOpenFile(requestTarget, currentFile => (
        failWorkspaceOpenFileSave(
          currentFile,
          saveRequestId,
          error instanceof Error ? error.message : 'Failed to save file',
          conflict
        )
      ))
      return false
    }
  }, [onUpdateOpenFile, readOnly])

  const saveFile = useCallback(async (overwrite = false) => {
    if (readOnly) return
    await saveOpenWorkspaceFile(openFile, overwrite)
  }, [openFile, readOnly, saveOpenWorkspaceFile])

  const reloadFile = useCallback(async () => {
    const target = {
      agentId: openFile.agentId,
      filePath: openFile.file.path,
      workspaceRoot: openFile.workspaceRoot,
    }
    const reloadRequestId = allocateWorkspaceFileRequestId()
    const reloadingFile = onUpdateOpenFile(target, currentFile => {
      if (currentFile.saving) return currentFile
      return beginWorkspaceOpenFileSave(currentFile, reloadRequestId)
    })
    if (!reloadingFile || reloadingFile.saveRequestId !== reloadRequestId) return
    const requestTarget = { ...target, saveRequestId: reloadRequestId }
    const requestedDraft = reloadingFile.draft

    try {
      const file = await resolveFile(reloadingFile.agentId, reloadingFile.file.path, {
        exactExternal: reloadingFile.exactExternal,
        reload: true,
        workspaceRoot: reloadingFile.workspaceRoot,
      })
      onUpdateOpenFile(requestTarget, currentFile => (
        completeWorkspaceOpenFileReload(currentFile, reloadRequestId, requestedDraft, file)
      ))
    } catch (error) {
      onUpdateOpenFile(requestTarget, currentFile => (
        failWorkspaceOpenFileSave(
          currentFile,
          reloadRequestId,
          error instanceof Error ? error.message : 'Failed to reload file',
          false
        )
      ))
    }
  }, [onUpdateOpenFile, openFile, resolveFile])

  return {
    saveOpenWorkspaceFile,
    saveFile,
    reloadFile,
  }
}
