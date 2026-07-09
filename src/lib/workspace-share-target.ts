import type { WorkspaceFileOpenTarget } from './workspace-open-files'
import type { WorkspaceFileEntry } from './workspace-files'

export type WorkspaceShareTarget =
  | { kind: 'agent'; agentId: string }
  | { kind: 'folder'; agentId?: string; folderPath: string; absolutePath?: string; projectLabel?: string }
  | {
    kind: 'file'
    agentId?: string
    filePath: string
    absolutePath?: string
    projectLabel?: string
    view?: 'editor' | 'diff'
    lineNumber?: number
    column?: number
    endColumn?: number
  }

export interface WorkspaceShareProjectCandidate {
  agentId: string
  workspace: string
}

export interface ResolvedWorkspaceSharePath {
  agentId: string
  filePath: string
  globalRoot: boolean
}

const MAX_ABSOLUTE_SHARE_QUERY_LENGTH = 1800
const SHARE_LOCATION_PARAM_NAMES = ['ftarget', 'agent', 'project', 'folder', 'file', 'path', 'view', 'line', 'column', 'endColumn']

function normalizePath(value: string) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  if (/^[a-zA-Z]:\//.test(normalized)) return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`.replace(/\/$/, '')
  return normalized === '/' ? '/' : normalized.replace(/\/$/, '')
}

function relativePathInsideWorkspace(absolutePath: string, workspace: string) {
  const target = normalizePath(absolutePath)
  const root = normalizePath(workspace)
  const caseInsensitive = /^[a-zA-Z]:\//.test(root)
  const comparableTarget = caseInsensitive ? target.toLowerCase() : target
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root
  if (comparableTarget === comparableRoot) return ''
  if (!comparableTarget.startsWith(`${comparableRoot}/`)) return null
  return target.slice(root.length + 1)
}

export function workspaceShareAbsolutePath(workspaceRoot: string, relativePath: string) {
  const root = normalizePath(workspaceRoot)
  const relative = normalizePath(relativePath).replace(/^\/+/, '')
  if (!root || !relative) return root || normalizePath(relativePath)
  return root === '/' ? `/${relative}` : `${root}/${relative}`
}

export function workspaceShareProjectLabel(workspaceRoot: string) {
  return normalizePath(workspaceRoot).split('/').filter(Boolean).pop() || '/'
}

export function resolveWorkspaceSharePath(
  target: Extract<WorkspaceShareTarget, { kind: 'file' | 'folder' }>,
  candidates: readonly WorkspaceShareProjectCandidate[],
  globalAgentId: string,
) {
  const relativePath = target.kind === 'file' ? target.filePath : target.folderPath
  const absolutePath = normalizePath(target.absolutePath || '')
  if (absolutePath) {
    const match = candidates
      .map(candidate => ({ ...candidate, relativePath: relativePathInsideWorkspace(absolutePath, candidate.workspace) }))
      .filter((candidate): candidate is WorkspaceShareProjectCandidate & { relativePath: string } => candidate.relativePath !== null)
      .sort((left, right) => normalizePath(right.workspace).length - normalizePath(left.workspace).length)[0]
    if (match) return { agentId: match.agentId, filePath: match.relativePath, globalRoot: false } satisfies ResolvedWorkspaceSharePath
    return {
      agentId: globalAgentId,
      filePath: absolutePath.replace(/^\/+/, ''),
      globalRoot: true,
    } satisfies ResolvedWorkspaceSharePath
  }

  const hinted = target.agentId ? candidates.find(candidate => candidate.agentId === target.agentId) : null
  const projectMatch = target.projectLabel
    ? candidates.find(candidate => workspaceShareProjectLabel(candidate.workspace) === target.projectLabel)
    : null
  const match = hinted || projectMatch
  if (!match) return null
  return { agentId: match.agentId, filePath: relativePath, globalRoot: false } satisfies ResolvedWorkspaceSharePath
}

export function clearWorkspaceShareTargetSearch(search: string) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  SHARE_LOCATION_PARAM_NAMES.forEach(name => params.delete(name))
  const next = params.toString()
  return next ? `?${next}` : ''
}

function positiveInteger(value: string | null) {
  if (!value) return undefined
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function setPositiveInteger(params: URLSearchParams, name: string, value: number | undefined) {
  if (Number.isInteger(value) && Number(value) > 0) {
    params.set(name, String(value))
  }
}

export function workspaceShareTargetKey(target: WorkspaceShareTarget | null | undefined) {
  if (!target) return ''
  if (target.kind === 'agent') return `agent:${target.agentId}`
  if (target.kind === 'folder') return `folder:${target.absolutePath || `${target.agentId || ''}:${target.folderPath}`}`
  return [
    'file',
    target.absolutePath || `${target.agentId || ''}:${target.filePath}`,
    target.view || 'editor',
    target.lineNumber || '',
    target.column || '',
    target.endColumn || '',
  ].join(':')
}

export function workspaceShareTargetSearchParams(target: WorkspaceShareTarget | null | undefined) {
  const params = new URLSearchParams()
  if (!target) return params
  params.set('ftarget', target.kind)

  if (target.kind === 'agent') {
    if (!target.agentId) return new URLSearchParams()
    params.set('agent', target.agentId)
    return params
  }

  const relativePath = target.kind === 'folder' ? target.folderPath : target.filePath
  if (!relativePath) return new URLSearchParams()
  if (target.absolutePath) params.set('path', target.absolutePath)
  if (target.agentId) params.set('agent', target.agentId)
  if (target.projectLabel) params.set('project', target.projectLabel)

  if (target.kind === 'folder') {
    params.set('folder', target.folderPath)
  } else if (target.kind === 'file') {
    params.set('file', target.filePath)
    if (target.view === 'diff') params.set('view', 'diff')
    setPositiveInteger(params, 'line', target.lineNumber)
    setPositiveInteger(params, 'column', target.column)
    setPositiveInteger(params, 'endColumn', target.endColumn)
  }

  if (target.absolutePath) {
    const absoluteParams = new URLSearchParams(params)
    absoluteParams.delete('agent')
    absoluteParams.delete(target.kind === 'folder' ? 'folder' : 'file')
    if (absoluteParams.toString().length <= MAX_ABSOLUTE_SHARE_QUERY_LENGTH) return absoluteParams
    params.delete('path')
  }

  return params
}

export function workspaceShareTargetFromSearch(search: string) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const kind = params.get('ftarget')
  const agentId = params.get('agent') || ''

  if (kind === 'agent') {
    if (!agentId) return null
    return { kind, agentId } satisfies WorkspaceShareTarget
  }

  if (kind === 'folder') {
    const folderPath = params.get('folder') || ''
    const absolutePath = params.get('path') || ''
    const projectLabel = params.get('project') || ''
    if (!absolutePath && (!folderPath || !agentId && !projectLabel)) return null
    return { kind, ...(agentId ? { agentId } : {}), folderPath, ...(absolutePath ? { absolutePath } : {}), ...(projectLabel ? { projectLabel } : {}) } satisfies WorkspaceShareTarget
  }

  if (kind === 'file') {
    const filePath = params.get('file') || ''
    const absolutePath = params.get('path') || ''
    const projectLabel = params.get('project') || ''
    if (!absolutePath && (!filePath || !agentId && !projectLabel)) return null
    return {
      kind,
      ...(agentId ? { agentId } : {}),
      filePath,
      ...(absolutePath ? { absolutePath } : {}),
      ...(projectLabel ? { projectLabel } : {}),
      view: params.get('view') === 'diff' ? 'diff' : 'editor',
      lineNumber: positiveInteger(params.get('line')),
      column: positiveInteger(params.get('column')),
      endColumn: positiveInteger(params.get('endColumn')),
    } satisfies WorkspaceShareTarget
  }

  return null
}

export function workspaceFileOpenTargetFromShareTarget(target: WorkspaceShareTarget): WorkspaceFileOpenTarget | undefined {
  if (target.kind !== 'file') return undefined
  return {
    view: target.view,
    lineNumber: target.lineNumber,
    column: target.column,
    endColumn: target.endColumn,
  }
}

export function workspaceFolderPreviewFilePath(items: readonly WorkspaceFileEntry[]) {
  const files = items.filter(item => item.type === 'file')
  return files.find(item => item.name.toLowerCase() === 'readme.md')?.path
    ?? files.find(item => item.name.toLowerCase().endsWith('.md'))?.path
    ?? files[0]?.path
    ?? ''
}
