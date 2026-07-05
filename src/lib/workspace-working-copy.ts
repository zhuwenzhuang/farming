import type { WorkspaceFile } from './workspace-files'

export type WorkspaceWorkingCopyState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error' | 'preview'
export type WorkspaceWorkingCopyChangeIndicator = 'dirty' | 'external'

export interface WorkspaceFileReference {
  agentId: string
  workspaceRoot?: string
  file: Pick<WorkspaceFile, 'path' | 'preview'>
}

export interface WorkspaceWorkingCopyReference extends WorkspaceFileReference {
  dirty: boolean
  externalChanged: boolean
  saving: boolean
  error: string | null
}

export interface WorkspaceWorkingCopyChangeIndicatorReference {
  dirty?: boolean
  externalChanged?: boolean
}

export function workspaceFileCacheKey(agentId: string, filePath: string, workspaceRoot?: string) {
  return `${workspaceRoot || agentId}:${filePath}`
}

export function workspaceWorkingCopyKey(file: WorkspaceFileReference) {
  return workspaceFileCacheKey(file.agentId, file.file.path, file.workspaceRoot)
}

export function workspaceWorkingCopyState(file: WorkspaceWorkingCopyReference): WorkspaceWorkingCopyState {
  if (file.file.preview) return 'preview'
  if (file.saving) return 'saving'
  if (file.externalChanged) return 'conflict'
  if (file.error) return 'error'
  if (file.dirty) return 'dirty'
  return 'saved'
}

export function isWorkspaceWorkingCopyPreview(file: WorkspaceFileReference) {
  return Boolean(file.file.preview)
}

export function isWorkspaceWorkingCopyClean(file: WorkspaceWorkingCopyReference) {
  return !file.dirty && !file.externalChanged && !file.saving
}

export function hasCleanWorkspaceWorkingCopy(files: readonly WorkspaceWorkingCopyReference[]) {
  return files.some(isWorkspaceWorkingCopyClean)
}

export function workspaceWorkingCopyChangeIndicator(
  file: WorkspaceWorkingCopyChangeIndicatorReference
): WorkspaceWorkingCopyChangeIndicator | null {
  if (file.externalChanged) return 'external'
  if (file.dirty) return 'dirty'
  return null
}

export function shouldPromptBeforeClosingWorkspaceWorkingCopy(file: WorkspaceWorkingCopyReference) {
  return file.dirty
}

export function shouldShowWorkspaceWorkingCopyReloadAction(file: WorkspaceWorkingCopyReference) {
  return file.externalChanged || Boolean(file.error)
}

export function shouldShowWorkspaceWorkingCopySaveAction(file: WorkspaceWorkingCopyReference) {
  return file.dirty && !file.externalChanged && !isWorkspaceWorkingCopyPreview(file)
}

export function shouldShowWorkspaceWorkingCopyOverwriteAction(file: WorkspaceWorkingCopyReference) {
  return file.externalChanged && !isWorkspaceWorkingCopyPreview(file)
}

export function workspaceWorkingCopyTabClass(file: WorkspaceWorkingCopyReference) {
  return `${file.dirty ? 'dirty' : ''} ${file.externalChanged ? 'warning' : ''}`.trim()
}
