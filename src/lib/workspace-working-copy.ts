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

export function normalizeWorkspaceResourcePath(value: string) {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  const driveMatch = /^([a-zA-Z]:)(?:\/|$)/.exec(normalized)
  const drivePrefix = driveMatch?.[1]
  const rooted = normalized.startsWith('/')
  const body = drivePrefix
    ? normalized.slice(drivePrefix.length).replace(/^\/+/, '')
    : normalized.replace(/^\/+/, '')
  const segments: string[] = []
  body.split('/').forEach(segment => {
    if (!segment || segment === '.') return
    if (segment === '..') {
      if (segments.length && segments[segments.length - 1] !== '..') {
        segments.pop()
      } else if (!drivePrefix && !rooted) {
        segments.push(segment)
      }
      return
    }
    segments.push(segment)
  })
  const path = segments.join('/')
  if (drivePrefix) return path ? `${drivePrefix}/${path}` : drivePrefix
  if (rooted) return path ? `/${path}` : '/'
  return path
}

export function workspaceFileResourceKey(filePath: string, workspaceRoot?: string) {
  const normalizedPath = normalizeWorkspaceResourcePath(filePath)
  if (!workspaceRoot || normalizedPath.startsWith('/') || /^[a-zA-Z]:(?:\/|$)/.test(normalizedPath)) {
    return normalizedPath
  }
  const normalizedRoot = normalizeWorkspaceResourcePath(workspaceRoot).replace(/\/+$/, '')
  return normalizeWorkspaceResourcePath(`${normalizedRoot}/${normalizedPath}`)
}

export function workspaceFileCacheKey(_agentId: string, filePath: string, workspaceRoot?: string) {
  return workspaceFileResourceKey(filePath, workspaceRoot)
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
