import { workspaceEditorModelKey } from './workspace-editor-model'
import type { OpenWorkspaceFile } from './workspace-open-files'
import {
  isWorkspaceWorkingCopyClean,
  shouldPromptBeforeClosingWorkspaceWorkingCopy,
} from './workspace-working-copy'

export type WorkspaceEditorTabContextAction = 'close' | 'close-others' | 'close-right' | 'close-saved' | 'close-all'

export interface WorkspaceEditorPendingCloseState {
  files: OpenWorkspaceFile[]
  closeFiles: OpenWorkspaceFile[]
  nextFocusFile: OpenWorkspaceFile | null
}

export interface WorkspaceEditorCloseIntent {
  closeFiles: OpenWorkspaceFile[]
  dirtyFiles: OpenWorkspaceFile[]
  pendingClose: WorkspaceEditorPendingCloseState | null
  nextFocusFile: OpenWorkspaceFile | null
}

export function workspaceEditorTabKey(file: Pick<OpenWorkspaceFile, 'agentId' | 'file'>) {
  return workspaceEditorModelKey(file)
}

export function uniqueWorkspaceEditorCloseFiles(files: readonly OpenWorkspaceFile[]) {
  return files.filter((file, index, list) => (
    list.findIndex(candidate => workspaceEditorTabKey(candidate) === workspaceEditorTabKey(file)) === index
  ))
}

export function workspaceEditorNextFocusAfterClosingTab(
  openFiles: readonly OpenWorkspaceFile[],
  activeFile: OpenWorkspaceFile,
  index: number
) {
  const file = openFiles[index]
  if (!file) return activeFile
  if (workspaceEditorTabKey(file) !== workspaceEditorTabKey(activeFile)) return activeFile

  const remainingFiles = openFiles.filter(candidate => workspaceEditorTabKey(candidate) !== workspaceEditorTabKey(file))
  return remainingFiles[Math.max(0, index - 1)] ?? remainingFiles[index] ?? null
}

export function workspaceEditorNextFocusAfterClosingFiles(
  openFiles: readonly OpenWorkspaceFile[],
  activeFile: OpenWorkspaceFile,
  files: readonly OpenWorkspaceFile[]
) {
  const closeKeys = new Set(files.map(workspaceEditorTabKey))
  const remainingFiles = openFiles.filter(file => !closeKeys.has(workspaceEditorTabKey(file)))
  return remainingFiles.find(file => workspaceEditorTabKey(file) === workspaceEditorTabKey(activeFile)) ?? remainingFiles[0] ?? null
}

export function createWorkspaceEditorCloseIntent(
  files: readonly OpenWorkspaceFile[],
  nextFocusFile: OpenWorkspaceFile | null
): WorkspaceEditorCloseIntent {
  const closeFiles = uniqueWorkspaceEditorCloseFiles(files)
  const dirtyFiles = closeFiles.filter(shouldPromptBeforeClosingWorkspaceWorkingCopy)
  const pendingClose = dirtyFiles.length > 0
    ? { files: dirtyFiles, closeFiles, nextFocusFile }
    : null
  return {
    closeFiles,
    dirtyFiles,
    pendingClose,
    nextFocusFile,
  }
}

export function workspaceEditorPendingCloseNextFocus(pendingClose: WorkspaceEditorPendingCloseState) {
  return pendingClose.nextFocusFile && pendingClose.closeFiles.some(file => (
    workspaceEditorTabKey(file) === workspaceEditorTabKey(pendingClose.nextFocusFile!)
  ))
    ? null
    : pendingClose.nextFocusFile
}

export function workspaceEditorFilesForTabAction(
  action: WorkspaceEditorTabContextAction,
  openFiles: readonly OpenWorkspaceFile[],
  index: number
) {
  if (action === 'close') {
    const file = openFiles[index]
    return file ? [file] : []
  }
  if (action === 'close-others') {
    return openFiles.filter((_file, fileIndex) => fileIndex !== index)
  }
  if (action === 'close-right') {
    return openFiles.slice(index + 1)
  }
  if (action === 'close-saved') {
    return openFiles.filter(isWorkspaceWorkingCopyClean)
  }
  return [...openFiles]
}
