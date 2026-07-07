import type { WorkspaceFileOpenTarget } from './workspace-open-files'

export type WorkspaceShareTarget =
  | { kind: 'agent'; agentId: string }
  | {
    kind: 'file'
    agentId: string
    filePath: string
    view?: 'editor' | 'diff'
    lineNumber?: number
    column?: number
    endColumn?: number
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
  return [
    'file',
    target.agentId,
    target.filePath,
    target.view || 'editor',
    target.lineNumber || '',
    target.column || '',
    target.endColumn || '',
  ].join(':')
}

export function workspaceShareTargetSearchParams(target: WorkspaceShareTarget | null | undefined) {
  const params = new URLSearchParams()
  if (!target?.agentId) return params
  params.set('ftarget', target.kind)
  params.set('agent', target.agentId)

  if (target.kind === 'file') {
    if (!target.filePath) return new URLSearchParams()
    params.set('file', target.filePath)
    if (target.view === 'diff') params.set('view', 'diff')
    setPositiveInteger(params, 'line', target.lineNumber)
    setPositiveInteger(params, 'column', target.column)
    setPositiveInteger(params, 'endColumn', target.endColumn)
  }

  return params
}

export function workspaceShareTargetFromSearch(search: string) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const kind = params.get('ftarget')
  const agentId = params.get('agent') || ''
  if (!agentId) return null

  if (kind === 'agent') {
    return { kind, agentId } satisfies WorkspaceShareTarget
  }

  if (kind === 'file') {
    const filePath = params.get('file') || ''
    if (!filePath) return null
    return {
      kind,
      agentId,
      filePath,
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
