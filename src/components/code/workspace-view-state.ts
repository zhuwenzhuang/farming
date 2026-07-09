import type { WorkspaceView } from './types'

const STORAGE_KEY = 'farming.code.workspaceViewState.v1'
const MAX_RESTORE_AGE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_PROJECT_FILE_STATES = 40
const MAX_OPEN_DIRECTORY_PATHS = 120

export type CodeWorkspaceSurface =
  | {
      kind: 'agent'
      agentId?: string
      providerSessionKey?: string
      workspace?: string
    }
  | {
      kind: 'file'
      workspace: string
      filePath: string
      view?: 'editor' | 'diff'
      lineNumber?: number
      column?: number
      endColumn?: number
      sourceAgentId?: string
    }

export interface CodeProjectFilesViewState {
  filesCollapsed?: boolean
  openDirectoryPaths?: string[]
}

export interface CodeWorkspaceViewState {
  activeTerminalId?: string | null
  activeView?: WorkspaceView
  openTerminalIds?: string[]
  projectListScrollTop?: number
  surface?: CodeWorkspaceSurface
  projectFiles?: Record<string, CodeProjectFilesViewState>
  updatedAt?: number
}

function isWorkspaceView(value: unknown): value is WorkspaceView {
  return value === 'projects' || value === 'search' || value === 'history'
}

function normalizeStringId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeOpenTerminalIds(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const id = normalizeStringId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= 30) break
  }
  return ids
}

function normalizeScrollTop(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.round(value))
}

function normalizePositiveInteger(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.round(value))
}

function normalizeWorkspaceSurface(value: unknown): CodeWorkspaceSurface | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'agent') {
    const agentId = normalizeStringId(record.agentId) || undefined
    const providerSessionKey = normalizeStringId(record.providerSessionKey) || undefined
    const workspace = normalizeStringId(record.workspace) || undefined
    if (!agentId && !providerSessionKey && !workspace) return undefined
    return { kind: 'agent', agentId, providerSessionKey, workspace }
  }
  if (record.kind !== 'file') return undefined
  const workspace = normalizeStringId(record.workspace)
  const filePath = normalizeStringId(record.filePath)
  if (!workspace || !filePath) return undefined
  return {
    kind: 'file',
    workspace,
    filePath,
    view: record.view === 'diff' ? 'diff' : 'editor',
    lineNumber: normalizePositiveInteger(record.lineNumber),
    column: normalizePositiveInteger(record.column),
    endColumn: normalizePositiveInteger(record.endColumn),
    sourceAgentId: normalizeStringId(record.sourceAgentId) || undefined,
  }
}

function normalizeProjectFiles(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const result: Record<string, CodeProjectFilesViewState> = {}
  Object.entries(value as Record<string, unknown>).slice(-MAX_PROJECT_FILE_STATES).forEach(([workspace, rawState]) => {
    if (!workspace.trim() || !rawState || typeof rawState !== 'object') return
    const state = rawState as Record<string, unknown>
    const openDirectoryPaths = Array.isArray(state.openDirectoryPaths)
      ? Array.from(new Set(state.openDirectoryPaths
        .filter((path): path is string => typeof path === 'string' && Boolean(path.trim()))
        .map(path => path.trim())))
        .slice(0, MAX_OPEN_DIRECTORY_PATHS)
      : undefined
    result[workspace] = {
      filesCollapsed: typeof state.filesCollapsed === 'boolean' ? state.filesCollapsed : undefined,
      openDirectoryPaths,
    }
  })
  return Object.keys(result).length > 0 ? result : undefined
}

export function normalizeCodeWorkspaceViewState(value: unknown): CodeWorkspaceViewState {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
    ? record.updatedAt
    : undefined

  if (updatedAt && Date.now() - updatedAt > MAX_RESTORE_AGE_MS) return {}

  return {
    activeTerminalId: normalizeStringId(record.activeTerminalId),
    activeView: isWorkspaceView(record.activeView) ? record.activeView : undefined,
    openTerminalIds: normalizeOpenTerminalIds(record.openTerminalIds),
    projectListScrollTop: normalizeScrollTop(record.projectListScrollTop),
    surface: normalizeWorkspaceSurface(record.surface),
    projectFiles: normalizeProjectFiles(record.projectFiles),
    updatedAt,
  }
}

export function loadCodeWorkspaceViewState(): CodeWorkspaceViewState {
  if (typeof window === 'undefined') return {}
  try {
    return normalizeCodeWorkspaceViewState(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}'))
  } catch {
    return {}
  }
}

export function saveCodeWorkspaceViewState(patch: CodeWorkspaceViewState) {
  if (typeof window === 'undefined') return
  try {
    const current = loadCodeWorkspaceViewState()
    const next = normalizeCodeWorkspaceViewState({
      ...current,
      ...patch,
      updatedAt: Date.now(),
    })
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Ignore browser storage failures; view restore is a best-effort convenience.
  }
}

export function loadCodeProjectFilesViewState(workspace: string): CodeProjectFilesViewState {
  return loadCodeWorkspaceViewState().projectFiles?.[workspace] ?? {}
}

export function saveCodeProjectFilesViewState(workspace: string, patch: CodeProjectFilesViewState) {
  if (!workspace.trim()) return
  const current = loadCodeWorkspaceViewState()
  const projectFiles = { ...(current.projectFiles ?? {}) }
  delete projectFiles[workspace]
  projectFiles[workspace] = {
    ...current.projectFiles?.[workspace],
    ...patch,
  }
  saveCodeWorkspaceViewState({ projectFiles })
}
